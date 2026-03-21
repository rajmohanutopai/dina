"""Install UX tests — verify prompts, input validation, and run.sh behavior.

These tests drive install.sh via pexpect and verify:
- Invalid input at every prompt is caught and re-prompted
- run.sh bare invocation shows usage (not start)
- run.sh --status shows correct fields
- Telegram skip doesn't break install
- .env is written correctly

These use the installed_dir fixture (session-scoped full install) or
install_dir fixture (function-scoped fresh copy, no install done).

Requires: Docker running, pexpect installed.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pexpect
import pytest


# ==========================================================================
# run.sh behavior (Issue #5)
# ==========================================================================


class TestRunShBehavior:
    """run.sh commands work correctly after install."""

    def test_bare_shows_usage(self, installed_dir: Path) -> None:
        """run.sh with no args shows usage, doesn't start."""
        result = subprocess.run(
            ["bash", str(installed_dir / "run.sh")],
            cwd=str(installed_dir),
            capture_output=True, text=True, timeout=10,
            env={**os.environ, "DINA_DIR": str(installed_dir)},
        )
        assert result.returncode == 0
        assert "--start" in result.stdout
        assert "--stop" in result.stdout
        assert "--status" in result.stdout
        assert "--logs" in result.stdout

    def test_unknown_flag_rejected(self, installed_dir: Path) -> None:
        result = subprocess.run(
            ["bash", str(installed_dir / "run.sh"), "--bogus"],
            cwd=str(installed_dir),
            capture_output=True, text=True, timeout=10,
            env={**os.environ, "DINA_DIR": str(installed_dir)},
        )
        assert result.returncode != 0

    def test_status_shows_healthy(self, installed_dir: Path) -> None:
        result = subprocess.run(
            ["bash", str(installed_dir / "run.sh"), "--status"],
            cwd=str(installed_dir),
            capture_output=True, text=True, timeout=30,
            env={**os.environ, "DINA_DIR": str(installed_dir)},
        )
        assert result.returncode == 0
        assert "healthy" in result.stdout.lower()

    def test_status_shows_did(self, installed_dir: Path) -> None:
        result = subprocess.run(
            ["bash", str(installed_dir / "run.sh"), "--status"],
            cwd=str(installed_dir),
            capture_output=True, text=True, timeout=30,
            env={**os.environ, "DINA_DIR": str(installed_dir)},
        )
        assert "did:" in result.stdout.lower()


# ==========================================================================
# dina-admin post-install (Issue #6, #7, #8)
# ==========================================================================


class TestDinaAdminPostInstall:
    """dina-admin commands return correct data."""

    def test_persona_list(self, installed_dir: Path) -> None:
        result = subprocess.run(
            ["bash", str(installed_dir / "dina-admin"), "--json", "persona", "list"],
            cwd=str(installed_dir),
            capture_output=True, text=True, timeout=30,
        )
        assert result.returncode == 0, f"Failed: {result.stderr}"
        import json
        data = json.loads(result.stdout)
        assert isinstance(data, list)
        assert len(data) >= 4

    def test_device_list(self, installed_dir: Path) -> None:
        result = subprocess.run(
            ["bash", str(installed_dir / "dina-admin"), "--json", "device", "list"],
            cwd=str(installed_dir),
            capture_output=True, text=True, timeout=30,
        )
        assert result.returncode == 0, f"Failed: {result.stderr}"

    def test_approvals_list(self, installed_dir: Path) -> None:
        result = subprocess.run(
            ["bash", str(installed_dir / "dina-admin"), "--json", "approvals", "list"],
            cwd=str(installed_dir),
            capture_output=True, text=True, timeout=30,
        )
        assert result.returncode == 0, f"Failed: {result.stderr}"

    def test_model_list(self, installed_dir: Path) -> None:
        result = subprocess.run(
            ["bash", str(installed_dir / "dina-admin"), "model", "list"],
            cwd=str(installed_dir),
            capture_output=True, text=True, timeout=30,
        )
        assert result.returncode == 0
        assert "gemini" in result.stdout.lower() or "Available" in result.stdout


# ==========================================================================
# Telegram and .env (bash wrapper — not covered by installer core)
# ==========================================================================


class TestTelegramOptional:
    """Telegram skip path in install.sh wrapper."""

    def test_no_telegram_in_env_when_skipped(self, installed_dir: Path) -> None:
        """installed_dir fixture skips Telegram — no token in .env."""
        content = (installed_dir / ".env").read_text()
        if "DINA_TELEGRAM_TOKEN=" in content:
            val = content.split("DINA_TELEGRAM_TOKEN=")[1].split("\n")[0].strip()
            assert val == "", f"Telegram token should be empty when skipped, got: {val}"


class TestEnvFileWrapper:
    """Verify the bash wrapper wrote .env correctly (complements installer core tests)."""

    def test_required_fields_from_wrapper(self, installed_dir: Path) -> None:
        content = (installed_dir / ".env").read_text()
        assert "DINA_SESSION=" in content
        assert "DINA_CORE_PORT=" in content
        assert "DINA_PDS_PORT=" in content
        assert "COMPOSE_PROJECT_NAME=" in content

    def test_no_secrets_in_env_from_wrapper(self, installed_dir: Path) -> None:
        """Master seed must NOT appear in .env written by bash wrapper."""
        content = (installed_dir / ".env").read_text()
        assert "MASTER_SEED" not in content
        assert "DINA_MASTER_SEED" not in content


# ==========================================================================
# Input validation — invalid choices re-prompt (Issue #9)
# ==========================================================================


class TestInputValidation:
    """install.sh rejects invalid input and re-prompts."""

    def test_invalid_identity_choice(self, install_dir: Path) -> None:
        child = pexpect.spawn(
            "bash", [str(install_dir / "install.sh")],
            cwd=str(install_dir), timeout=180, encoding="utf-8",
            env={**os.environ, "DINA_DIR": str(install_dir), "DINA_SKIP_MNEMONIC_VERIFY": "1"},
        )
        child.expect("Enter choice \\[1-3\\]:", timeout=160)
        child.sendline("garbage")
        idx = child.expect(
            ["Please enter 1, 2, or 3", "Enter choice \\[1-3\\]:",
             pexpect.TIMEOUT],
            timeout=10,
        )
        child.close()
        assert idx in (0, 1), "Invalid identity choice should re-prompt"

    def test_api_key_at_llm_menu(self, install_dir: Path) -> None:
        child = pexpect.spawn(
            "bash", [str(install_dir / "install.sh")],
            cwd=str(install_dir), timeout=300, encoding="utf-8",
            env={**os.environ, "DINA_DIR": str(install_dir), "DINA_SKIP_MNEMONIC_VERIFY": "1"},
        )
        child.expect("Enter choice \\[1-3\\]:", timeout=160)
        child.sendline("1")
        child.expect("[Pp]assphrase", timeout=30)
        child.sendline("testpass123")
        child.expect("[Cc]onfirm", timeout=10)
        child.sendline("testpass123")
        child.expect("Enter choice \\[1-2", timeout=10)
        child.sendline("2")
        # Owner name — skip
        child.expect("call you", timeout=30)
        child.sendline("")
        # Telegram — skip
        child.expect("Enter choice \\[1-2", timeout=30)
        child.sendline("2")

        child.expect("Enter one or more numbers", timeout=30)
        child.sendline("NOT-A-VALID-CHOICE-just-testing-input-validation")
        idx = child.expect(
            ["Please enter numbers 1-6", "Enter one or more numbers",
             pexpect.TIMEOUT],
            timeout=10,
        )
        child.close()
        assert idx in (0, 1), "API key at LLM menu should re-prompt"

    def test_invalid_security_mode(self, install_dir: Path) -> None:
        child = pexpect.spawn(
            "bash", [str(install_dir / "install.sh")],
            cwd=str(install_dir), timeout=180, encoding="utf-8",
            env={**os.environ, "DINA_DIR": str(install_dir), "DINA_SKIP_MNEMONIC_VERIFY": "1"},
        )
        child.expect("Enter choice \\[1-3\\]:", timeout=160)
        child.sendline("1")
        child.expect("[Pp]assphrase", timeout=30)
        child.sendline("testpass123")
        child.expect("[Cc]onfirm", timeout=10)
        child.sendline("testpass123")

        child.expect("Enter choice \\[1-2", timeout=10)
        child.sendline("xyz")
        idx = child.expect(
            ["Please enter 1 or 2", "Enter choice \\[1-2",
             pexpect.TIMEOUT],
            timeout=10,
        )
        child.close()
        assert idx in (0, 1), "Invalid security mode should re-prompt"

    def test_invalid_telegram_choice(self, install_dir: Path) -> None:
        """Invalid Telegram choice re-prompts."""
        child = pexpect.spawn(
            "bash", [str(install_dir / "install.sh")],
            cwd=str(install_dir), timeout=300, encoding="utf-8",
            env={**os.environ, "DINA_DIR": str(install_dir), "DINA_SKIP_MNEMONIC_VERIFY": "1"},
        )
        child.expect("Enter choice \\[1-3\\]:", timeout=160)
        child.sendline("1")
        child.expect("[Pp]assphrase", timeout=30)
        child.sendline("testpass123")
        child.expect("[Cc]onfirm", timeout=10)
        child.sendline("testpass123")
        child.expect("Enter choice \\[1-2", timeout=10)
        child.sendline("2")
        # Owner name — skip
        child.expect("call you", timeout=30)
        child.sendline("")

        # At Telegram prompt, enter garbage
        child.expect("Enter choice \\[1-2", timeout=30)
        child.sendline("abc")
        idx = child.expect(
            ["Please enter 1 or 2", "Enter choice \\[1-2",
             pexpect.TIMEOUT],
            timeout=10,
        )
        child.close()
        assert idx in (0, 1), "Invalid Telegram choice should re-prompt"
