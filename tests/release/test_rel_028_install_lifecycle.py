"""REL-028 Install Lifecycle Smoke Test.

Full black-box lifecycle: fresh directory → install.sh → run.sh --stop → run.sh → verify.
This is the closest thing to a real fresh-machine install without a disposable VM.

Execution class: Hybrid (pexpect-driven install + Docker).

Requires: Docker running, pexpect installed.
This test is slow (~5-10 minutes) — it builds containers, starts them, stops, restarts.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import httpx
import pexpect
import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent

_INSTALL_FILES = [
    "install.sh", "run.sh", "dina-admin", "docker-compose.yml",
    "docker-compose.dev.yml", "models.json", "CLAUDE.md",
    ".gitignore", "pyproject.toml", "requirements.txt",
]
_INSTALL_DIRS = [
    "scripts", "core", "brain", "cli", "admin-cli",
    "appview", "plc", "deploy", "docs/images",
]


def _copy_repo(dest: Path) -> None:
    """Copy minimum files needed for install.sh."""
    for f in _INSTALL_FILES:
        src = PROJECT_ROOT / f
        if src.exists():
            dst = dest / f
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
    for d in _INSTALL_DIRS:
        src = PROJECT_ROOT / d
        if src.is_dir():
            shutil.copytree(src, dest / d, dirs_exist_ok=True)
    dina_html = PROJECT_ROOT / "dina.html"
    if dina_html.exists():
        shutil.copy2(dina_html, dest / "dina.html")


@pytest.fixture(scope="module")
def lifecycle_dir():
    """Fresh temp directory for the full lifecycle test. Cleaned up after."""
    with tempfile.TemporaryDirectory(prefix="dina-rel028-") as tmp:
        dest = Path(tmp) / "dina"
        dest.mkdir()
        _copy_repo(dest)
        yield dest

        # Cleanup containers
        env_file = dest / ".env"
        if env_file.exists():
            try:
                session = ""
                for line in env_file.read_text().splitlines():
                    if line.startswith("DINA_SESSION="):
                        session = line.split("=", 1)[1]
                        break
                if session:
                    subprocess.run(
                        ["docker", "compose", "-p", f"dina-{session}", "down", "-v"],
                        capture_output=True, timeout=60, cwd=str(dest),
                    )
            except Exception:
                pass


class TestInstallLifecycle:
    """REL-028: Full install → stop → start → verify lifecycle."""

    # REL-028
    @pytest.mark.slow
    # TRACE: {"suite": "REL", "case": "0028", "section": "28", "sectionName": "Install Lifecycle", "subsection": "01", "scenario": "01", "title": "rel_028_full_lifecycle"}
    def test_rel_028_full_lifecycle(self, lifecycle_dir: Path) -> None:
        """Fresh install, stop, restart, verify health and DID stability.

        Steps:
        1. Run install.sh in a fresh directory (auto-start mode)
        2. Verify containers healthy + DID reachable
        3. Stop via run.sh --stop
        4. Verify containers are down
        5. Restart via run.sh
        6. Verify containers healthy + DID unchanged
        """
        env = {**os.environ, "DINA_DIR": str(lifecycle_dir)}

        # --- Step 1: Install ---
        child = pexpect.spawn(
            "bash", [str(lifecycle_dir / "install.sh")],
            cwd=str(lifecycle_dir), timeout=600, encoding="utf-8", env=env,
        )
        child.expect("Enter choice \\[1-3\\]:", timeout=300)
        child.sendline("1")  # Create new identity
        child.expect("Passphrase:", timeout=30)
        child.sendline("rel028pass")
        child.expect("Confirm:", timeout=10)
        child.sendline("rel028pass")
        child.expect("Enter choice \\[1-2\\]:", timeout=10)
        child.sendline("2")  # Auto-start
        child.expect("Enter one or more numbers", timeout=30)
        child.sendline("6")  # Skip LLM
        child.expect("Enter choice \\[1-2\\]:", timeout=30)
        child.sendline("2")  # Skip Telegram

        try:
            child.expect("Dina is ready!", timeout=600)
        except pexpect.TIMEOUT:
            pytest.fail(f"Install timed out. Last output:\n{child.before[-500:]}")
        child.close()

        # Read port
        core_port = "8100"
        for line in (lifecycle_dir / ".env").read_text().splitlines():
            if line.startswith("DINA_CORE_PORT="):
                core_port = line.split("=", 1)[1]

        # --- Step 2: Verify healthy + DID ---
        resp = httpx.get(f"http://localhost:{core_port}/healthz", timeout=10)
        assert resp.status_code == 200, f"Core unhealthy: {resp.text}"

        resp = httpx.get(
            f"http://localhost:{core_port}/.well-known/atproto-did", timeout=10,
        )
        assert resp.status_code == 200
        did_original = resp.text.strip()
        assert did_original.startswith("did:"), f"Bad DID: {did_original}"

        # --- Step 3: Stop ---
        result = subprocess.run(
            ["bash", str(lifecycle_dir / "run.sh"), "--stop"],
            cwd=str(lifecycle_dir), capture_output=True, timeout=60, env=env,
        )
        assert result.returncode == 0, f"Stop failed: {result.stderr}"

        # --- Step 4: Verify down ---
        with pytest.raises(httpx.ConnectError):
            httpx.get(f"http://localhost:{core_port}/healthz", timeout=3)

        # --- Step 5: Restart ---
        child = pexpect.spawn(
            "bash", [str(lifecycle_dir / "run.sh")],
            cwd=str(lifecycle_dir), timeout=180, encoding="utf-8", env=env,
        )
        idx = child.expect(
            ["Dina is running", pexpect.TIMEOUT], timeout=120,
        )
        assert idx == 0, f"Restart failed. Last output:\n{child.before[-500:]}"
        child.close()

        # --- Step 6: Verify healthy + DID stable ---
        resp = httpx.get(f"http://localhost:{core_port}/healthz", timeout=10)
        assert resp.status_code == 200

        resp = httpx.get(
            f"http://localhost:{core_port}/.well-known/atproto-did", timeout=10,
        )
        did_after = resp.text.strip()
        assert did_original == did_after, (
            f"DID changed after restart: {did_original} -> {did_after}"
        )

        # --- Bonus: verify secrets intact ---
        secrets = lifecycle_dir / "secrets"
        assert (secrets / "wrapped_seed.bin").is_file()
        assert (secrets / "master_seed.salt").is_file()
        assert (secrets / "seed_password").stat().st_size > 0  # auto-start
        assert (secrets / "service_keys" / "core" / "core_ed25519_private.pem").is_file()
