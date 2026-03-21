"""Startup mode tests — verify run.sh behavior in each mode.

Passphrase persistence logic is tested by test_installer_core.py.
These tests verify the Docker/pexpect-dependent run.sh behavior:
- Auto-start: run.sh starts without prompting for passphrase
- Manual-start: run.sh prompts for passphrase, then starts
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pexpect
import pytest


class TestAutoStartMode:
    """Auto-start (server) mode — run.sh starts without passphrase prompt."""

    def test_auto_start_run_no_prompt(self, installed_dir: Path) -> None:
        """run.sh starts without prompting and reaches healthy state."""
        subprocess.run(
            ["bash", str(installed_dir / "run.sh"), "--stop"],
            cwd=str(installed_dir),
            capture_output=True,
            timeout=60,
        )

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
            ["Enter passphrase", "Dina is running", "Containers already running",
             pexpect.TIMEOUT],
            timeout=120,
        )
        assert idx != 0, "run.sh --start should not prompt for passphrase in auto-start mode"
        assert idx in (1, 2), "run.sh --start should reach running state"
        child.close()


class TestManualStartMode:
    """Manual-start (maximum security) mode — run.sh prompts for passphrase."""

    @pytest.fixture
    def manual_start_dir(self, install_dir: Path) -> Path:
        """Install with manual-start (maximum security) mode."""
        child = pexpect.spawn(
            "bash",
            [str(install_dir / "install.sh")],
            cwd=str(install_dir),
            timeout=300,
            encoding="utf-8",
            env={**os.environ, "DINA_DIR": str(install_dir), "DINA_SKIP_MNEMONIC_VERIFY": "1"},
        )

        child.expect("Enter choice \\[1-3\\]:", timeout=120)
        child.sendline("1")
        child.expect("Passphrase:", timeout=30)
        child.sendline("testpass123")
        child.expect("Confirm:", timeout=10)
        child.sendline("testpass123")

        # Option 1 = maximum security (manual-start)
        child.expect("Enter choice \\[1-2", timeout=10)
        child.sendline("1")

        # Owner name — skip
        child.expect("call you", timeout=30)
        child.sendline("")
        # Telegram — skip
        child.expect("Enter choice \\[1-2", timeout=30)
        child.sendline("2")
        # LLM — skip
        child.expect("Enter one or more numbers", timeout=30)
        child.sendline("6")

        try:
            child.expect("Dina is ready!", timeout=300)
        except pexpect.TIMEOUT:
            print(f"TIMEOUT — last output:\n{child.before}")
            raise
        child.close()

        return install_dir

    def test_manual_start_run_prompts_and_clears(self, manual_start_dir: Path) -> None:
        """run.sh prompts for passphrase, starts, and clears it from disk."""
        subprocess.run(
            ["bash", str(manual_start_dir / "run.sh"), "--stop"],
            cwd=str(manual_start_dir),
            capture_output=True,
            timeout=60,
        )

        child = pexpect.spawn(
            "bash",
            [str(manual_start_dir / "run.sh"), "--start"],
            cwd=str(manual_start_dir),
            timeout=180,
            encoding="utf-8",
            env={
                **os.environ,
                "DINA_DIR": str(manual_start_dir),
                "DINA_SKIP_LLM_CHECK": "1",
            },
        )

        idx = child.expect(
            ["Enter passphrase", "Dina is running", pexpect.TIMEOUT],
            timeout=60,
        )
        assert idx == 0, "run.sh --start should prompt for passphrase in manual-start mode"

        child.sendline("testpass123")

        idx = child.expect(
            ["Dina is running", "Containers already running", pexpect.TIMEOUT],
            timeout=120,
        )
        assert idx in (0, 1), "run.sh --start should reach running state after passphrase"
        child.close()

        seed_pw = manual_start_dir / "secrets" / "seed_password"
        assert seed_pw.stat().st_size == 0, (
            "seed_password should be cleared after manual-start run.sh"
        )
