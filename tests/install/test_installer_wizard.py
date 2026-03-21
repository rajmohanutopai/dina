"""Tests for the installer wizard state machine.

These tests run the wizard in-process with simulated stdin/stdout,
no Docker, no pexpect. They verify:
- Prompt sequence and validation
- Recovery phrase event generation
- Passphrase validation (length, mismatch)
- Invalid input re-prompting
- Final config assembly
"""

from __future__ import annotations

import io
import json
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest


def _run_wizard_with_answers(dina_dir: Path, answers: list[dict]) -> list[dict]:
    """Run the wizard with pre-loaded answers, return all emitted messages."""
    # Build stdin: one JSON line per answer
    stdin_lines = "\n".join(json.dumps(a) for a in answers) + "\n"
    fake_stdin = io.StringIO(stdin_lines)

    # Capture stdout
    fake_stdout = io.StringIO()

    with patch("sys.stdin", fake_stdin), patch("sys.stdout", fake_stdout):
        from scripts.installer.wizard import run_wizard
        run_wizard(dina_dir)

    # Parse emitted messages
    output = fake_stdout.getvalue()
    messages = []
    for line in output.strip().split("\n"):
        if line.strip():
            messages.append(json.loads(line))
    return messages


class TestWizardNewIdentity:
    """New identity flow: identity → phrase → ack → passphrase → confirm → mode → name → telegram → LLM → done."""

    def test_new_identity_full_flow(self, tmp_path: Path) -> None:
        answers = [
            {"field": "identity_choice", "value": "1"},       # Create new
            # Recovery phrase event will be emitted — send ack
            {"field": "recovery_ack", "value": "ok"},
            {"field": "passphrase", "value": "testpass123"},
            {"field": "passphrase_confirm", "value": "testpass123"},
            {"field": "startup_mode", "value": "2"},           # Server mode
            {"field": "owner_name", "value": "Rajmohan"},
            {"field": "telegram_choice", "value": "2"},        # Skip
            {"field": "llm_selection", "value": "6"},          # Skip LLM
        ]
        messages = _run_wizard_with_answers(tmp_path, answers)

        # Should have a recovery phrase event
        phrase_events = [m for m in messages if m.get("name") == "show_recovery_phrase"]
        assert len(phrase_events) == 1
        assert len(phrase_events[0]["words"]) == 24

        # Should end with done
        done_msgs = [m for m in messages if m.get("type") == "done"]
        assert len(done_msgs) == 1
        result = done_msgs[0]["result"]
        assert result["seed_wrapped"] is True
        assert result["service_keys_provisioned"] is True
        assert result["startup_mode"] == "server"

        # Files should exist
        assert (tmp_path / "secrets" / "wrapped_seed.bin").is_file()
        assert (tmp_path / ".env").is_file()
        env_content = (tmp_path / ".env").read_text()
        assert "DINA_OWNER_NAME=Rajmohan" in env_content

    def test_maximum_security_mode(self, tmp_path: Path) -> None:
        answers = [
            {"field": "identity_choice", "value": "1"},
            {"field": "recovery_ack", "value": "ok"},
            {"field": "passphrase", "value": "testpass123"},
            {"field": "passphrase_confirm", "value": "testpass123"},
            {"field": "startup_mode", "value": "1"},           # Maximum
            {"field": "owner_name", "value": ""},
            {"field": "telegram_choice", "value": "2"},
            {"field": "llm_selection", "value": "6"},
        ]
        messages = _run_wizard_with_answers(tmp_path, answers)

        done = [m for m in messages if m.get("type") == "done"][0]
        assert done["result"]["startup_mode"] == "maximum"
        # Passphrase should still be on disk (cleared by install.sh after health)
        pw = (tmp_path / "secrets" / "seed_password").read_text()
        assert len(pw) > 0


class TestWizardRestore:
    """Restore from mnemonic — no recovery phrase event."""

    def test_restore_mnemonic(self, tmp_path: Path) -> None:
        # First, generate a phrase to restore from
        from scripts.installer import run_install, InstallerConfig
        r = run_install(InstallerConfig(
            dina_dir=tmp_path / "gen", passphrase="testpass123",
        ))
        phrase = " ".join(r.recovery_phrase)

        # Now restore via wizard
        restore_dir = tmp_path / "restore"
        answers = [
            {"field": "identity_choice", "value": "2"},        # Restore mnemonic
            {"field": "mnemonic", "value": phrase},
            {"field": "passphrase", "value": "newpass12345"},
            {"field": "passphrase_confirm", "value": "newpass12345"},
            {"field": "startup_mode", "value": "2"},
            {"field": "owner_name", "value": ""},
            {"field": "telegram_choice", "value": "2"},
            {"field": "llm_selection", "value": "6"},
        ]
        messages = _run_wizard_with_answers(restore_dir, answers)

        # No recovery phrase event for restores
        phrase_events = [m for m in messages if m.get("name") == "show_recovery_phrase"]
        assert len(phrase_events) == 0

        # Same keys as original
        pub_gen = (tmp_path / "gen/secrets/service_keys/public/core_ed25519_public.pem").read_text()
        pub_restore = (restore_dir / "secrets/service_keys/public/core_ed25519_public.pem").read_text()
        assert pub_gen == pub_restore


class TestWizardValidation:
    """Wizard validates input and re-prompts."""

    def test_short_passphrase_reprompts(self, tmp_path: Path) -> None:
        answers = [
            {"field": "identity_choice", "value": "1"},
            {"field": "recovery_ack", "value": "ok"},
            {"field": "passphrase", "value": "short"},         # Too short
            {"field": "passphrase", "value": "testpass123"},   # Valid
            {"field": "passphrase_confirm", "value": "testpass123"},
            {"field": "startup_mode", "value": "2"},
            {"field": "owner_name", "value": ""},
            {"field": "telegram_choice", "value": "2"},
            {"field": "llm_selection", "value": "6"},
        ]
        messages = _run_wizard_with_answers(tmp_path, answers)

        # Should have an error for the short passphrase
        errors = [m for m in messages if m.get("type") == "error"]
        assert any("8 characters" in e.get("message", "") for e in errors)

        # Should still complete successfully
        done = [m for m in messages if m.get("type") == "done"]
        assert len(done) == 1

    def test_passphrase_mismatch_reprompts(self, tmp_path: Path) -> None:
        answers = [
            {"field": "identity_choice", "value": "1"},
            {"field": "recovery_ack", "value": "ok"},
            {"field": "passphrase", "value": "testpass123"},
            {"field": "passphrase_confirm", "value": "wrong"},  # Mismatch
            {"field": "passphrase", "value": "testpass123"},    # Retry
            {"field": "passphrase_confirm", "value": "testpass123"},
            {"field": "startup_mode", "value": "2"},
            {"field": "owner_name", "value": ""},
            {"field": "telegram_choice", "value": "2"},
            {"field": "llm_selection", "value": "6"},
        ]
        messages = _run_wizard_with_answers(tmp_path, answers)

        errors = [m for m in messages if m.get("type") == "error"]
        assert any("do not match" in e.get("message", "") for e in errors)

        done = [m for m in messages if m.get("type") == "done"]
        assert len(done) == 1


class TestWizardIdempotent:
    """Re-running wizard on already-installed dir skips identity setup."""

    def test_rerun_skips_identity(self, tmp_path: Path) -> None:
        # First install
        answers1 = [
            {"field": "identity_choice", "value": "1"},
            {"field": "recovery_ack", "value": "ok"},
            {"field": "passphrase", "value": "testpass123"},
            {"field": "passphrase_confirm", "value": "testpass123"},
            {"field": "startup_mode", "value": "2"},
            {"field": "owner_name", "value": ""},
            {"field": "telegram_choice", "value": "2"},
            {"field": "llm_selection", "value": "6"},
        ]
        _run_wizard_with_answers(tmp_path, answers1)
        seed_before = (tmp_path / "secrets" / "wrapped_seed.bin").read_bytes()

        # Second run — should skip identity, only ask config questions
        answers2 = [
            {"field": "owner_name", "value": "NewName"},
            {"field": "telegram_choice", "value": "2"},
            # No LLM prompt — .env already exists
        ]
        messages2 = _run_wizard_with_answers(tmp_path, answers2)

        # No identity prompts
        identity_prompts = [m for m in messages2
                           if m.get("type") == "prompt" and m.get("field") == "identity_choice"]
        assert len(identity_prompts) == 0

        # Seed unchanged
        seed_after = (tmp_path / "secrets" / "wrapped_seed.bin").read_bytes()
        assert seed_before == seed_after

        # Should complete
        done = [m for m in messages2 if m.get("type") == "done"]
        assert len(done) == 1


class TestWizardLLMProviders:
    """LLM provider selection."""

    def test_gemini_key_written_to_env(self, tmp_path: Path) -> None:
        answers = [
            {"field": "identity_choice", "value": "1"},
            {"field": "recovery_ack", "value": "ok"},
            {"field": "passphrase", "value": "testpass123"},
            {"field": "passphrase_confirm", "value": "testpass123"},
            {"field": "startup_mode", "value": "2"},
            {"field": "owner_name", "value": ""},
            {"field": "telegram_choice", "value": "2"},
            {"field": "llm_selection", "value": "1"},          # Gemini
            {"field": "api_key_GEMINI_API_KEY", "value": "AIzaSyTestKey123"},
        ]
        messages = _run_wizard_with_answers(tmp_path, answers)

        done = [m for m in messages if m.get("type") == "done"]
        assert len(done) == 1

        env = (tmp_path / ".env").read_text()
        assert "GEMINI_API_KEY=AIzaSyTestKey123" in env
