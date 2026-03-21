"""Black-box install tests — verify Docker lifecycle and prompt flows.

These tests require Docker and drive install.sh/run.sh via pexpect.
Provisioning logic (secrets, keys, .env, permissions) is covered by
test_installer_core.py — these tests focus on what can't be tested
without real containers:
  - Container health after install
  - DID reachable
  - Stop/start lifecycle
  - Device pairing survives restart
  - Multi-provider skip prompt flow
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


class TestContainersHealthy:
    """Verify containers are healthy after install."""

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

        # 4. Start via run.sh --start
        child = pexpect.spawn(
            "bash",
            [str(installed_dir / "run.sh"), "--start"],
            cwd=str(installed_dir),
            timeout=180,
            encoding="utf-8",
            env={
                **os.environ,
                "DINA_DIR": str(installed_dir),
                "DINA_SKIP_LLM_CHECK": "1",
            },
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
    """Paired device authentication works after Core restart."""

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
        pub_bytes = priv_key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
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
        assert pre_resp.status_code == 200

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
            env={
                **os.environ,
                "DINA_DIR": str(installed_dir),
                "DINA_SKIP_LLM_CHECK": "1",
            },
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
            f"Signed request failed AFTER restart: {post_resp.status_code}"
        )


class TestInstallRerun:
    """Verify install.sh --skip-build is idempotent against a live install."""

    def test_rerun_preserves_did(self, installed_dir: Path) -> None:
        """Rerunning install.sh --skip-build preserves the DID."""
        port = _get_core_port(installed_dir)

        # Get DID before rerun
        resp = httpx.get(
            f"http://localhost:{port}/.well-known/atproto-did", timeout=10,
        )
        assert resp.status_code == 200
        did_before = resp.text.strip()

        # Rerun install with --skip-build
        result = subprocess.run(
            [str(installed_dir / "install.sh"), "--skip-build"],
            cwd=str(installed_dir),
            capture_output=True,
            text=True,
            timeout=120,
            env={**os.environ, "DINA_DIR": str(installed_dir)},
        )
        assert result.returncode == 0, f"Rerun failed: {result.stderr[:500]}"

        # DID must be unchanged
        resp = httpx.get(
            f"http://localhost:{port}/.well-known/atproto-did", timeout=10,
        )
        assert resp.status_code == 200
        did_after = resp.text.strip()
        assert did_before == did_after, (
            f"DID changed after rerun: {did_before} → {did_after}"
        )

    def test_rerun_preserves_secrets(self, installed_dir: Path) -> None:
        """Rerunning install.sh --skip-build does not rotate secrets."""
        secrets = installed_dir / "secrets"
        seed_before = (secrets / "wrapped_seed.bin").read_bytes()
        salt_before = (secrets / "master_seed.salt").read_bytes()
        session_before = (secrets / "session_id").read_text()
        key_before = (
            secrets / "service_keys/core/core_ed25519_private.pem"
        ).read_bytes()

        result = subprocess.run(
            [str(installed_dir / "install.sh"), "--skip-build"],
            cwd=str(installed_dir),
            capture_output=True,
            timeout=120,
            env={**os.environ, "DINA_DIR": str(installed_dir)},
        )
        assert result.returncode == 0

        assert (secrets / "wrapped_seed.bin").read_bytes() == seed_before
        assert (secrets / "master_seed.salt").read_bytes() == salt_before
        assert (secrets / "session_id").read_text() == session_before
        assert (
            secrets / "service_keys/core/core_ed25519_private.pem"
        ).read_bytes() == key_before


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
            env={**os.environ, "DINA_DIR": str(install_dir), "DINA_SKIP_MNEMONIC_VERIFY": "1"},
        )

        child.expect("Enter choice:", timeout=120)
        child.sendline("1")
        child.expect("Press Enter", timeout=30)
        child.sendline("")
        child.expect("passphrase", timeout=30)
        child.sendline("testpass123")
        child.expect("Confirm", timeout=10)
        child.sendline("testpass123")
        child.expect("Enter choice:", timeout=10)
        child.sendline("2")
        child.expect("call you", timeout=30)
        child.sendline("")
        child.expect("Enter choice", timeout=30)
        child.sendline("2")
        child.expect("Enter one or more numbers", timeout=30)
        child.sendline("6")

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
