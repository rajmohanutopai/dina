"""Black-box install tests — drive install.sh via pexpect like a real user.

These tests verify the complete install lifecycle:
- Interactive prompts work correctly
- Secrets are created with correct permissions
- Service keys are provisioned
- .env is written with expected values
- Containers start and become healthy
- DID is reachable
- Full lifecycle: install → stop → start → verify
"""

from __future__ import annotations

import os
import stat
import subprocess
from pathlib import Path

import httpx
import pexpect
import pytest


def _get_core_port(install_dir: Path) -> str:
    """Read DINA_CORE_PORT from .env."""
    for line in (install_dir / ".env").read_text().splitlines():
        if line.startswith("DINA_CORE_PORT="):
            return line.split("=", 1)[1]
    return "8100"


class TestFreshInstall:
    """First-time install with default options."""

    def test_install_creates_secrets(self, installed_dir: Path) -> None:
        """Install creates all required secret files."""
        secrets = installed_dir / "secrets"
        assert secrets.is_dir(), "secrets/ not created"
        assert (secrets / "wrapped_seed.bin").is_file(), "wrapped_seed.bin missing"
        assert (secrets / "master_seed.salt").is_file(), "master_seed.salt missing"
        assert (secrets / "seed_password").is_file(), "seed_password missing"
        assert (secrets / "session_id").is_file(), "session_id missing"

    def test_install_creates_service_keys(self, installed_dir: Path) -> None:
        """Install provisions Ed25519 service key PEMs."""
        keys = installed_dir / "secrets" / "service_keys"
        assert (keys / "core" / "core_ed25519_private.pem").is_file()
        assert (keys / "brain" / "brain_ed25519_private.pem").is_file()
        assert (keys / "public" / "core_ed25519_public.pem").is_file()
        assert (keys / "public" / "brain_ed25519_public.pem").is_file()

    def test_install_creates_env(self, installed_dir: Path) -> None:
        """Install creates .env with required keys."""
        env_file = installed_dir / ".env"
        assert env_file.is_file(), ".env not created"
        content = env_file.read_text()
        assert "DINA_SESSION=" in content
        assert "DINA_CORE_PORT=" in content
        assert "DINA_PDS_PORT=" in content
        assert "DINA_PDS_JWT_SECRET=" in content

    def test_install_secrets_permissions(self, installed_dir: Path) -> None:
        """Secrets directory has restricted permissions."""
        secrets = installed_dir / "secrets"
        mode = stat.S_IMODE(secrets.stat().st_mode)
        assert mode == 0o700, f"secrets/ should be 0700, got {oct(mode)}"

    def test_install_seed_password_has_content(self, installed_dir: Path) -> None:
        """In auto-start mode, seed_password should be non-empty."""
        seed_pw = installed_dir / "secrets" / "seed_password"
        assert seed_pw.stat().st_size > 0, "seed_password empty in auto-start mode"

    def test_install_containers_healthy(self, installed_dir: Path) -> None:
        """All containers are healthy after install."""
        port = _get_core_port(installed_dir)
        try:
            resp = httpx.get(f"http://localhost:{port}/healthz", timeout=10)
            assert resp.status_code == 200, f"Core healthz returned {resp.status_code}"
            data = resp.json()
            assert data.get("status") in ("ok", "healthy"), f"Core status: {data}"
        except httpx.ConnectError:
            pytest.fail("Core not reachable after install")

    def test_install_did_reachable(self, installed_dir: Path) -> None:
        """DID endpoint returns a valid did:plc after install."""
        port = _get_core_port(installed_dir)
        try:
            resp = httpx.get(
                f"http://localhost:{port}/.well-known/atproto-did", timeout=10,
            )
            assert resp.status_code == 200
            did = resp.text.strip()
            assert did.startswith("did:"), f"Invalid DID: {did}"
        except httpx.ConnectError:
            pytest.fail("Core not reachable — cannot verify DID")


class TestFullLifecycle:
    """End-to-end lifecycle: install → stop → start → verify."""

    def test_full_lifecycle(self, installed_dir: Path) -> None:
        """Install, stop, start, verify containers healthy and DID stable."""
        port = _get_core_port(installed_dir)

        # 1. Get DID after install
        resp = httpx.get(
            f"http://localhost:{port}/.well-known/atproto-did", timeout=10,
        )
        assert resp.status_code == 200
        did_after_install = resp.text.strip()
        assert did_after_install.startswith("did:")

        # 2. Stop
        result = subprocess.run(
            ["bash", str(installed_dir / "run.sh"), "--stop"],
            cwd=str(installed_dir),
            capture_output=True,
            timeout=60,
            env={**os.environ, "DINA_DIR": str(installed_dir)},
        )
        assert result.returncode == 0, f"run.sh --stop failed: {result.stderr}"

        # 3. Verify Core is down
        with pytest.raises(httpx.ConnectError):
            httpx.get(f"http://localhost:{port}/healthz", timeout=3)

        # 4. Start via run.sh
        child = pexpect.spawn(
            "bash",
            [str(installed_dir / "run.sh")],
            cwd=str(installed_dir),
            timeout=180,
            encoding="utf-8",
            env={**os.environ, "DINA_DIR": str(installed_dir)},
        )
        idx = child.expect(
            ["Dina is running", pexpect.TIMEOUT],
            timeout=120,
        )
        assert idx == 0, f"run.sh did not reach running state: {child.before}"
        child.close()

        # 5. Verify healthy again
        resp = httpx.get(f"http://localhost:{port}/healthz", timeout=10)
        assert resp.status_code == 200

        # 6. Verify DID unchanged
        resp = httpx.get(
            f"http://localhost:{port}/.well-known/atproto-did", timeout=10,
        )
        did_after_restart = resp.text.strip()
        assert did_after_install == did_after_restart, (
            f"DID changed after restart: {did_after_install} -> {did_after_restart}"
        )


class TestDevicePairingSurvivesRestart:
    """Paired device authentication works after Core restart.

    This is the regression test for the bug where device registrations
    were lost on restart because:
    1. PairingManager stored devices in-memory only (no persistence)
    2. Auth validator lost device keys on restart (no reload)
    """

    def test_paired_device_auth_survives_restart(self, installed_dir: Path) -> None:
        """Pair → restart → signed request still authenticates."""
        port = _get_core_port(installed_dir)
        token_file = installed_dir / "secrets" / "client_token"
        if not token_file.exists():
            pytest.skip("No client_token — cannot test pairing")
        token = token_file.read_text().strip()
        auth = {"Authorization": f"Bearer {token}"}

        # 1. Initiate pairing
        init_resp = httpx.post(
            f"http://localhost:{port}/v1/pair/initiate",
            headers=auth,
            timeout=10,
        )
        assert init_resp.status_code == 200
        code = init_resp.json().get("code", "")
        assert code

        # 2. Generate a test Ed25519 keypair
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
        import hashlib
        import time as _time

        priv_key = Ed25519PrivateKey.generate()
        pub_bytes = priv_key.public_bytes(Encoding.Raw, PublicFormat.Raw)
        # Multibase: z + base58btc(0xed01 + pubkey)
        import base58 as _b58
        multicodec = bytes([0xed, 0x01]) + pub_bytes
        multibase = "z" + _b58.b58encode(multicodec).decode()

        # 3. Complete pairing with the test key
        pair_resp = httpx.post(
            f"http://localhost:{port}/v1/pair/complete",
            json={"code": code, "device_name": "restart-test", "public_key_multibase": multibase},
            timeout=10,
        )
        assert pair_resp.status_code == 200, f"Pairing failed: {pair_resp.text}"
        device_id = pair_resp.json().get("device_id", "")
        assert device_id

        # 4. Verify signed request works before restart
        did = f"did:key:{multibase}"
        ts = str(int(_time.time()))
        nonce = os.urandom(16).hex()
        method = "GET"
        path = "/v1/did"
        body_hash = hashlib.sha256(b"").hexdigest()
        canonical = f"{method}\n{path}\n\n{ts}\n{nonce}\n{body_hash}"
        sig = priv_key.sign(canonical.encode()).hex()

        pre_resp = httpx.get(
            f"http://localhost:{port}{path}",
            headers={
                "X-DID": did,
                "X-Timestamp": ts,
                "X-Nonce": nonce,
                "X-Signature": sig,
            },
            timeout=10,
        )
        assert pre_resp.status_code == 200, (
            f"Signed request failed BEFORE restart: {pre_resp.status_code}"
        )

        # 5. Restart Core
        result = subprocess.run(
            ["bash", str(installed_dir / "run.sh"), "--stop"],
            cwd=str(installed_dir),
            capture_output=True,
            timeout=60,
            env={**os.environ, "DINA_DIR": str(installed_dir)},
        )
        assert result.returncode == 0

        child = pexpect.spawn(
            "bash",
            [str(installed_dir / "run.sh"), "--start"],
            cwd=str(installed_dir),
            timeout=180,
            encoding="utf-8",
            env={**os.environ, "DINA_DIR": str(installed_dir)},
        )
        idx = child.expect(
            ["Dina is running", "Containers already running", pexpect.TIMEOUT],
            timeout=120,
        )
        assert idx in (0, 1), f"run.sh --start failed: {child.before}"
        child.close()

        # 6. Verify signed request works AFTER restart
        ts2 = str(int(_time.time()))
        nonce2 = os.urandom(16).hex()
        canonical2 = f"{method}\n{path}\n\n{ts2}\n{nonce2}\n{body_hash}"
        sig2 = priv_key.sign(canonical2.encode()).hex()

        post_resp = httpx.get(
            f"http://localhost:{port}{path}",
            headers={
                "X-DID": did,
                "X-Timestamp": ts2,
                "X-Nonce": nonce2,
                "X-Signature": sig2,
            },
            timeout=10,
        )
        assert post_resp.status_code == 200, (
            f"Signed request failed AFTER restart: {post_resp.status_code} "
            f"(device key not reloaded into auth validator)"
        )


class TestInstallPrompts:
    """Verify specific interactive prompt flows."""

    def test_install_multi_provider_skip(self, install_dir: Path) -> None:
        """Selecting skip (6) results in no LLM keys in .env."""
        child = pexpect.spawn(
            "bash",
            [str(install_dir / "install.sh")],
            cwd=str(install_dir),
            timeout=300,
            encoding="utf-8",
            env={**os.environ, "DINA_DIR": str(install_dir)},
        )

        child.expect("Enter choice \\[1-3\\]:", timeout=120)
        child.sendline("1")
        child.expect("Passphrase:", timeout=30)
        child.sendline("testpass123")
        child.expect("Confirm:", timeout=10)
        child.sendline("testpass123")
        child.expect("Enter choice \\[1-2\\]:", timeout=10)
        child.sendline("2")
        child.expect("Enter one or more numbers", timeout=30)
        child.sendline("6")
        child.expect("Enter choice \\[1-2\\]:", timeout=30)
        child.sendline("2")

        try:
            child.expect("Dina is ready!", timeout=300)
        except pexpect.TIMEOUT:
            print(f"TIMEOUT — last output:\n{child.before}")
            raise
        child.close()

        env_content = (install_dir / ".env").read_text()
        assert "GEMINI_API_KEY=" not in env_content
        assert "OPENAI_API_KEY=" not in env_content
        assert "ANTHROPIC_API_KEY=" not in env_content
