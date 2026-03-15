"""Startup mode tests — verify manual-start and auto-start behavior.

These tests verify:
- Manual-start: passphrase cleared after install, run.sh prompts for it
- Auto-start: passphrase persists, run.sh starts without prompting
- dina-admin security switching works
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pexpect
import pytest


class TestAutoStartMode:
    """Auto-start (server) mode — passphrase stored, unattended restart."""

    def test_auto_start_password_persists(self, installed_dir: Path) -> None:
        """In auto-start mode, seed_password remains non-empty after install."""
        seed_pw = installed_dir / "secrets" / "seed_password"
        assert seed_pw.stat().st_size > 0

    def test_auto_start_run_no_prompt(self, installed_dir: Path) -> None:
        """run.sh starts without prompting and reaches healthy state in auto-start mode."""
        # Stop containers first
        subprocess.run(
            ["bash", str(installed_dir / "run.sh"), "--stop"],
            cwd=str(installed_dir),
            capture_output=True,
            timeout=60,
        )

        child = pexpect.spawn(
            "bash",
            [str(installed_dir / "run.sh")],
            cwd=str(installed_dir),
            timeout=180,
            encoding="utf-8",
            env={**os.environ, "DINA_DIR": str(installed_dir)},
        )

        # Should NOT prompt for passphrase — goes straight to starting/running
        idx = child.expect(
            ["Enter passphrase", "Dina is running", "Containers already running",
             pexpect.TIMEOUT],
            timeout=120,
        )
        assert idx != 0, "run.sh should not prompt for passphrase in auto-start mode"
        assert idx in (1, 2), "run.sh should reach running state"
        child.close()


class TestManualStartMode:
    """Manual-start (maximum security) mode — passphrase required each time."""

    @pytest.fixture
    def manual_start_dir(self, install_dir: Path) -> Path:
        """Install with manual-start (maximum security) mode."""
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

        # Option 1 = maximum security (manual-start)
        child.expect("Enter choice \\[1-2\\]:", timeout=10)
        child.sendline("1")

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

        return install_dir

    def test_manual_start_password_cleared(self, manual_start_dir: Path) -> None:
        """After install, seed_password is empty in manual-start mode."""
        seed_pw = manual_start_dir / "secrets" / "seed_password"
        assert seed_pw.is_file()
        assert seed_pw.stat().st_size == 0

    def test_manual_start_run_prompts_and_clears(self, manual_start_dir: Path) -> None:
        """run.sh prompts for passphrase, starts, and clears it from disk."""
        # Stop containers first
        subprocess.run(
            ["bash", str(manual_start_dir / "run.sh"), "--stop"],
            cwd=str(manual_start_dir),
            capture_output=True,
            timeout=60,
        )

        child = pexpect.spawn(
            "bash",
            [str(manual_start_dir / "run.sh")],
            cwd=str(manual_start_dir),
            timeout=180,
            encoding="utf-8",
            env={**os.environ, "DINA_DIR": str(manual_start_dir)},
        )

        # Should prompt for passphrase
        idx = child.expect(
            ["Enter passphrase", "Dina is running", pexpect.TIMEOUT],
            timeout=60,
        )
        assert idx == 0, "run.sh should prompt for passphrase in manual-start mode"

        # Provide the passphrase
        child.sendline("testpass123")

        # Wait for containers to start and become healthy
        idx = child.expect(
            ["Dina is running", "Containers already running", pexpect.TIMEOUT],
            timeout=120,
        )
        assert idx in (0, 1), "run.sh should reach running state after passphrase"
        child.close()

        # Verify seed_password is cleared again after start
        seed_pw = manual_start_dir / "secrets" / "seed_password"
        assert seed_pw.stat().st_size == 0, (
            "seed_password should be cleared after manual-start run.sh"
        )
