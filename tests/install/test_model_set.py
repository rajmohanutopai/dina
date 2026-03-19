"""Tests for dina-admin model set — both direct and interactive modes.

These test the bash dina-admin script's model management.
Direct mode is tested via subprocess. Interactive mode via pexpect.
Only needs models.json on disk — no Docker, no running containers.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest


@pytest.fixture
def model_dir(tmp_path):
    """Create a minimal dina-admin + models.json setup for testing."""
    project_root = Path(__file__).resolve().parent.parent.parent

    # Copy dina-admin script
    shutil.copy2(project_root / "dina-admin", tmp_path / "dina-admin")

    # Copy models.json
    shutil.copy2(project_root / "models.json", tmp_path / "models.json")

    # Create minimal .env so dina-admin doesn't complain
    (tmp_path / ".env").write_text("DINA_SESSION=test\n")

    # Create docker-compose.yml stub (dina-admin checks for compose)
    (tmp_path / "docker-compose.yml").write_text("version: '3'\nservices: {}\n")

    return tmp_path


def _read_defaults(model_dir: Path) -> dict:
    """Read defaults from models.json."""
    return json.loads((model_dir / "models.json").read_text())["defaults"]


# ==========================================================================
# Direct mode: dina-admin model set <role> <model>
# ==========================================================================


class TestModelSetDirect:
    """Non-interactive model set via command line args."""

    def test_set_lite(self, model_dir: Path) -> None:
        """Set lite model directly."""
        result = subprocess.run(
            ["bash", str(model_dir / "dina-admin"), "model", "set",
             "lite", "gemini/gemini-2.5-flash"],
            cwd=str(model_dir),
            capture_output=True, text=True, timeout=10,
        )
        assert result.returncode == 0, f"Failed: {result.stderr}\n{result.stdout}"
        assert "gemini/gemini-2.5-flash" in result.stdout
        defaults = _read_defaults(model_dir)
        assert defaults["lite"] == "gemini/gemini-2.5-flash"

    def test_set_primary(self, model_dir: Path) -> None:
        """Set primary model directly."""
        result = subprocess.run(
            ["bash", str(model_dir / "dina-admin"), "model", "set",
             "primary", "claude/claude-sonnet-4-6"],
            cwd=str(model_dir),
            capture_output=True, text=True, timeout=10,
        )
        assert result.returncode == 0
        defaults = _read_defaults(model_dir)
        assert defaults["primary"] == "claude/claude-sonnet-4-6"

    def test_set_heavy(self, model_dir: Path) -> None:
        """Set heavy model directly."""
        result = subprocess.run(
            ["bash", str(model_dir / "dina-admin"), "model", "set",
             "heavy", "openai/gpt-5.4"],
            cwd=str(model_dir),
            capture_output=True, text=True, timeout=10,
        )
        assert result.returncode == 0
        defaults = _read_defaults(model_dir)
        assert defaults["heavy"] == "openai/gpt-5.4"

    def test_set_invalid_role(self, model_dir: Path) -> None:
        """Invalid role name is rejected."""
        result = subprocess.run(
            ["bash", str(model_dir / "dina-admin"), "model", "set",
             "turbo", "gemini/gemini-2.5-flash"],
            cwd=str(model_dir),
            capture_output=True, text=True, timeout=10,
        )
        assert result.returncode != 0
        assert "Unknown role" in result.stderr or "Unknown role" in result.stdout

    def test_set_preserves_other_roles(self, model_dir: Path) -> None:
        """Setting lite doesn't change primary or heavy."""
        before = _read_defaults(model_dir)
        subprocess.run(
            ["bash", str(model_dir / "dina-admin"), "model", "set",
             "lite", "openai/gpt-5-mini"],
            cwd=str(model_dir),
            capture_output=True, timeout=10,
        )
        after = _read_defaults(model_dir)
        assert after["lite"] == "openai/gpt-5-mini"
        assert after["primary"] == before["primary"]
        assert after["heavy"] == before["heavy"]

    def test_set_unknown_model_warns(self, model_dir: Path) -> None:
        """Setting a model not in models.json warns but proceeds."""
        result = subprocess.run(
            ["bash", str(model_dir / "dina-admin"), "model", "set",
             "lite", "custom/my-model-v1"],
            cwd=str(model_dir),
            capture_output=True, text=True, timeout=10,
        )
        assert result.returncode == 0
        assert "Warning" in result.stdout or "warning" in result.stdout
        defaults = _read_defaults(model_dir)
        assert defaults["lite"] == "custom/my-model-v1"


# ==========================================================================
# Interactive mode: dina-admin model set (no args)
# ==========================================================================


class TestModelSetInteractive:
    """Interactive model selection via pexpect."""

    def test_interactive_set_by_number(self, model_dir: Path) -> None:
        """Select a model by number in interactive mode."""
        import pexpect

        child = pexpect.spawn(
            "bash", [str(model_dir / "dina-admin"), "model", "set"],
            cwd=str(model_dir), timeout=15, encoding="utf-8",
        )

        # Lite prompt
        child.expect("lite:", timeout=10)
        child.sendline("1")  # first model in the list

        # Primary prompt — press Enter to keep
        child.expect("primary:", timeout=10)
        child.sendline("")

        # Heavy prompt — press Enter to keep
        child.expect("heavy:", timeout=10)
        child.sendline("")

        child.expect(pexpect.EOF, timeout=10)
        child.close()
        assert child.exitstatus == 0

        defaults = _read_defaults(model_dir)
        # Model #1 should be set for lite (first non-llama model)
        assert defaults["lite"] != "?"

    def test_interactive_set_by_paste(self, model_dir: Path) -> None:
        """Paste a model name in interactive mode."""
        import pexpect

        child = pexpect.spawn(
            "bash", [str(model_dir / "dina-admin"), "model", "set"],
            cwd=str(model_dir), timeout=15, encoding="utf-8",
        )

        child.expect("lite:", timeout=10)
        child.sendline("gemini/gemini-2.5-pro")

        child.expect("primary:", timeout=10)
        child.sendline("")

        child.expect("heavy:", timeout=10)
        child.sendline("")

        child.expect(pexpect.EOF, timeout=10)
        child.close()
        assert child.exitstatus == 0

        defaults = _read_defaults(model_dir)
        assert defaults["lite"] == "gemini/gemini-2.5-pro"

    def test_interactive_keep_all(self, model_dir: Path) -> None:
        """Press Enter for all three — no changes."""
        import pexpect

        before = _read_defaults(model_dir)

        child = pexpect.spawn(
            "bash", [str(model_dir / "dina-admin"), "model", "set"],
            cwd=str(model_dir), timeout=15, encoding="utf-8",
        )

        child.expect("lite:", timeout=10)
        child.sendline("")
        child.expect("primary:", timeout=10)
        child.sendline("")
        child.expect("heavy:", timeout=10)
        child.sendline("")

        child.expect(pexpect.EOF, timeout=10)
        child.close()
        assert child.exitstatus == 0

        after = _read_defaults(model_dir)
        assert before == after

    def test_interactive_change_all_three(self, model_dir: Path) -> None:
        """Change all three roles in one pass."""
        import pexpect

        child = pexpect.spawn(
            "bash", [str(model_dir / "dina-admin"), "model", "set"],
            cwd=str(model_dir), timeout=15, encoding="utf-8",
        )

        child.expect("lite:", timeout=10)
        child.sendline("gemini/gemini-2.5-flash")
        child.expect("primary:", timeout=10)
        child.sendline("claude/claude-sonnet-4-6")
        child.expect("heavy:", timeout=10)
        child.sendline("openai/gpt-5.4")

        child.expect(pexpect.EOF, timeout=10)
        child.close()
        assert child.exitstatus == 0

        defaults = _read_defaults(model_dir)
        assert defaults["lite"] == "gemini/gemini-2.5-flash"
        assert defaults["primary"] == "claude/claude-sonnet-4-6"
        assert defaults["heavy"] == "openai/gpt-5.4"
