"""Idempotency tests — verify install.sh can be rerun safely.

A second run of install.sh should:
- Not rotate the identity (DID stays the same)
- Not regenerate the wrapped seed
- Not regenerate service keys
- Preserve session ID
- Complete cleanly
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path

import pexpect
import pytest


def _hash_file(path: Path) -> str:
    """SHA-256 hash of a file's contents."""
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _rerun_install(install_dir: Path) -> None:
    """Run install.sh a second time with --skip-build."""
    child = pexpect.spawn(
        "bash",
        [str(install_dir / "install.sh"), "--skip-build"],
        cwd=str(install_dir),
        timeout=300,
        encoding="utf-8",
        env={**os.environ, "DINA_DIR": str(install_dir)},
    )

    # On rerun, identity is already created — should skip to Telegram
    # then to LLM (or skip both if already configured)
    try:
        # May prompt for Telegram if not configured
        idx = child.expect(
            ["Enter choice \\[1-2\\]:", "Dina is ready!", pexpect.TIMEOUT],
            timeout=120,
        )
        if idx == 0:
            child.sendline("2")  # Skip Telegram
            child.expect("Dina is ready!", timeout=300)
        # idx == 1: already at "ready"
    except pexpect.TIMEOUT:
        print(f"TIMEOUT — last output:\n{child.before}")
        raise

    child.close()


class TestInstallRerun:
    """Verify install.sh is idempotent."""

    def test_rerun_preserves_wrapped_seed(self, installed_dir: Path) -> None:
        """Second install does not regenerate the wrapped seed."""
        seed_path = installed_dir / "secrets" / "wrapped_seed.bin"
        hash_before = _hash_file(seed_path)

        _rerun_install(installed_dir)

        hash_after = _hash_file(seed_path)
        assert hash_before == hash_after, "wrapped_seed.bin changed on rerun"

    def test_rerun_preserves_salt(self, installed_dir: Path) -> None:
        """Second install does not regenerate the salt."""
        salt_path = installed_dir / "secrets" / "master_seed.salt"
        hash_before = _hash_file(salt_path)

        _rerun_install(installed_dir)

        hash_after = _hash_file(salt_path)
        assert hash_before == hash_after, "master_seed.salt changed on rerun"

    def test_rerun_preserves_session_id(self, installed_dir: Path) -> None:
        """Second install does not change the session ID."""
        session_path = installed_dir / "secrets" / "session_id"
        session_before = session_path.read_text().strip()

        _rerun_install(installed_dir)

        session_after = session_path.read_text().strip()
        assert session_before == session_after, "Session ID changed on rerun"

    def test_rerun_preserves_service_keys(self, installed_dir: Path) -> None:
        """Second install does not regenerate service keys."""
        keys_dir = installed_dir / "secrets" / "service_keys"
        pem_files = [
            keys_dir / "core" / "core_ed25519_private.pem",
            keys_dir / "brain" / "brain_ed25519_private.pem",
            keys_dir / "public" / "core_ed25519_public.pem",
            keys_dir / "public" / "brain_ed25519_public.pem",
        ]
        hashes_before = {str(p): _hash_file(p) for p in pem_files}

        _rerun_install(installed_dir)

        for p in pem_files:
            assert _hash_file(p) == hashes_before[str(p)], (
                f"{p.name} changed on rerun"
            )

    def test_rerun_preserves_env(self, installed_dir: Path) -> None:
        """Second install does not overwrite .env."""
        env_path = installed_dir / ".env"
        content_before = env_path.read_text()

        _rerun_install(installed_dir)

        content_after = env_path.read_text()
        assert content_before == content_after, ".env changed on rerun"

    def test_rerun_preserves_did(self, installed_dir: Path) -> None:
        """Second install does not rotate the DID."""
        import httpx

        # Read Core port from .env
        core_port = "8100"
        for line in (installed_dir / ".env").read_text().splitlines():
            if line.startswith("DINA_CORE_PORT="):
                core_port = line.split("=", 1)[1]

        # Get DID before rerun (containers should be running from installed_dir fixture)
        resp = httpx.get(
            f"http://localhost:{core_port}/.well-known/atproto-did",
            timeout=10,
        )
        assert resp.status_code == 200, "Core not reachable before rerun"
        did_before = resp.text.strip()
        assert did_before.startswith("did:"), f"Invalid DID before rerun: {did_before}"

        _rerun_install(installed_dir)

        # Get DID after rerun
        resp = httpx.get(
            f"http://localhost:{core_port}/.well-known/atproto-did",
            timeout=10,
        )
        assert resp.status_code == 200, "Core not reachable after rerun"
        did_after = resp.text.strip()

        assert did_before == did_after, (
            f"DID changed on rerun: {did_before} -> {did_after}"
        )
