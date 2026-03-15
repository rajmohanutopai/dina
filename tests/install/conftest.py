"""Fixtures for install.sh black-box tests.

Each test gets a fresh copy of the repo in a temp directory.
Tests use pexpect to drive the interactive installer as a real user would.

Requires: pexpect, Docker running.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent

# Files/dirs to copy into the temp install directory.
# We copy only what install.sh needs — not the full repo.
_INSTALL_FILES = [
    "install.sh",
    "run.sh",
    "dina-admin",
    "docker-compose.yml",
    "docker-compose.dev.yml",
    "models.json",
    "CLAUDE.md",
    ".gitignore",
    "pyproject.toml",
    "requirements.txt",
]

_INSTALL_DIRS = [
    "scripts",
    "core",
    "brain",
    "cli",
    "admin-cli",
    "appview",
    "plc",
    "deploy",
    "docs/images",
]


def _copy_repo_subset(dest: Path) -> None:
    """Copy the minimum set of files needed for install.sh to run."""
    for f in _INSTALL_FILES:
        src = PROJECT_ROOT / f
        if src.exists():
            dst = dest / f
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)

    for d in _INSTALL_DIRS:
        src = PROJECT_ROOT / d
        if src.is_dir():
            dst = dest / d
            shutil.copytree(src, dst, dirs_exist_ok=True)

    # Ensure dina.html exists (referenced by docker-compose.yml)
    dina_html = PROJECT_ROOT / "dina.html"
    if dina_html.exists():
        shutil.copy2(dina_html, dest / "dina.html")


@pytest.fixture(scope="session")
def docker_available():
    """Skip all install tests if Docker is not running."""
    try:
        result = subprocess.run(
            ["docker", "info"],
            capture_output=True,
            timeout=10,
        )
        if result.returncode != 0:
            pytest.skip("Docker daemon not running")
    except FileNotFoundError:
        pytest.skip("Docker not installed")


@pytest.fixture
def install_dir(tmp_path, docker_available):
    """Create a fresh temp directory with a copy of the repo for install testing.

    Returns the Path to the temp install directory.
    Cleanup: removes any Docker resources created during the test.
    """
    dest = tmp_path / "dina"
    dest.mkdir()
    _copy_repo_subset(dest)

    yield dest

    # Cleanup: stop any containers started by this test
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
                    capture_output=True,
                    timeout=60,
                    cwd=str(dest),
                )
        except Exception:
            pass


@pytest.fixture
def installed_dir(install_dir):
    """Run install.sh non-interactively and return the directory.

    This is a pre-installed state for tests that need a working install
    without driving the interactive flow.
    """
    import pexpect

    child = pexpect.spawn(
        "bash",
        [str(install_dir / "install.sh")],
        cwd=str(install_dir),
        timeout=300,
        encoding="utf-8",
        env={**os.environ, "DINA_DIR": str(install_dir)},
    )

    # Answer prompts for a basic install
    # 1. Identity: create new (option 1)
    child.expect("Enter choice \\[1-3\\]:", timeout=120)
    child.sendline("1")

    # 2. Passphrase
    child.expect("Passphrase:", timeout=30)
    child.sendline("testpass123")
    child.expect("Confirm:", timeout=10)
    child.sendline("testpass123")

    # 3. Startup mode: auto-start (option 2)
    child.expect("Enter choice \\[1-2\\]:", timeout=10)
    child.sendline("2")

    # 4. LLM provider: skip (option 6)
    child.expect("Enter one or more numbers", timeout=30)
    child.sendline("6")

    # 5. Telegram: skip (option 2)
    child.expect("Enter choice \\[1-2\\]:", timeout=30)
    child.sendline("2")

    # Wait for completion or timeout
    try:
        child.expect("Dina is ready!", timeout=300)
    except pexpect.TIMEOUT:
        print(f"TIMEOUT — last output:\n{child.before}")
        raise

    child.close()

    return install_dir
