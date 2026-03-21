"""Fixtures for install.sh black-box tests.

Each test gets either:
- install_dir: a fresh copy of the repo (no install done yet) — function-scoped
- installed_dir: a pre-installed directory (install.sh already run) — session-scoped

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


def _cleanup_containers(dest: Path) -> None:
    """Stop any Docker containers started from this install directory."""
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

    Function-scoped — each test gets a clean directory with no prior install.
    Cleanup: removes any Docker resources created during the test.
    """
    dest = tmp_path / "dina"
    dest.mkdir()
    _copy_repo_subset(dest)

    yield dest

    _cleanup_containers(dest)


@pytest.fixture(scope="session")
def installed_dir(docker_available, tmp_path_factory):
    """Run install.sh once and return the directory for all tests to share.

    Session-scoped — install runs once, all TestFreshInstall tests
    verify different aspects of the same install. This avoids running
    a 3-5 minute install for each individual assertion.
    """
    import pexpect

    dest = tmp_path_factory.mktemp("installed") / "dina"
    dest.mkdir()
    _copy_repo_subset(dest)

    child = pexpect.spawn(
        "bash",
        [str(dest / "install.sh")],
        cwd=str(dest),
        timeout=600,
        encoding="utf-8",
        env={
            **os.environ,
            "DINA_DIR": str(dest),
            "DINA_SKIP_MNEMONIC_VERIFY": "1",
        },
    )

    # Answer prompts rendered by the JSON-lines presenter.
    # The wizard emits structured prompts; install.sh renders them as:
    #   choice → "Enter choice:" or "Enter one or more numbers..."
    #   text   → "<message>:"

    # 1. Identity: create new (option 1)
    child.expect("Enter choice:", timeout=300)
    child.sendline("1")

    # 2. Recovery phrase ack (press Enter)
    child.expect("Press Enter", timeout=30)
    child.sendline("")

    # 3. Passphrase
    child.expect("passphrase", timeout=30)
    child.sendline("testpass123")
    child.expect("Confirm", timeout=10)
    child.sendline("testpass123")

    # 4. Startup mode: auto-start (option 2)
    child.expect("Enter choice:", timeout=10)
    child.sendline("2")

    # 5. Owner name (press Enter to skip)
    child.expect("call you", timeout=30)
    child.sendline("")

    # 6. Telegram: skip (option 2)
    child.expect("Enter choice", timeout=30)
    child.sendline("2")

    # 7. LLM provider: skip (option 6)
    child.expect("Enter one or more numbers", timeout=30)
    child.sendline("6")

    # Wait for completion or timeout
    try:
        child.expect("Dina is ready!", timeout=600)
    except pexpect.TIMEOUT:
        print(f"TIMEOUT — last output:\n{child.before}")
        raise

    child.close()

    yield dest

    _cleanup_containers(dest)
