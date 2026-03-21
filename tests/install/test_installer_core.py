"""Tests for the installer core — direct Python calls, no Docker, no pexpect.

These tests call run_install() directly with structured InstallerConfig.
Same code path as production — only the I/O adapter differs.

Runs in < 10 seconds. No Docker, no network, no interactive prompts.
"""

from __future__ import annotations

import os
import stat
from pathlib import Path

import pytest
from pydantic import ValidationError

from scripts.installer import (
    IdentityChoice,
    InstallerConfig,
    InstallerResult,
    StartupMode,
    run_install,
)
from scripts.installer.models import LLMProviderConfig, TelegramConfig


# ======================================================================
# New Identity
# ======================================================================


class TestNewIdentity:
    """Fresh install with new identity."""

    def test_creates_wrapped_seed(self, tmp_path: Path) -> None:
        result = run_install(InstallerConfig(
            dina_dir=tmp_path,
            identity_choice=IdentityChoice.NEW,
            passphrase="testpass123",
            startup_mode=StartupMode.SERVER,
        ))
        assert result.seed_wrapped
        assert (tmp_path / "secrets" / "wrapped_seed.bin").is_file()
        assert (tmp_path / "secrets" / "wrapped_seed.bin").stat().st_size == 60

    def test_creates_salt(self, tmp_path: Path) -> None:
        result = run_install(InstallerConfig(
            dina_dir=tmp_path, passphrase="testpass123",
        ))
        salt = tmp_path / "secrets" / "master_seed.salt"
        assert salt.is_file()
        assert salt.stat().st_size == 16

    def test_returns_24_word_recovery_phrase(self, tmp_path: Path) -> None:
        result = run_install(InstallerConfig(
            dina_dir=tmp_path, passphrase="testpass123",
        ))
        assert result.recovery_phrase is not None
        assert len(result.recovery_phrase) == 24
        # Each word should be a real BIP-39 word (all lowercase alpha)
        for word in result.recovery_phrase:
            assert word.isalpha() and word.islower()

    def test_provisions_service_keys(self, tmp_path: Path) -> None:
        result = run_install(InstallerConfig(
            dina_dir=tmp_path, passphrase="testpass123",
        ))
        assert result.service_keys_provisioned
        keys_dir = tmp_path / "secrets" / "service_keys"
        assert (keys_dir / "core" / "core_ed25519_private.pem").is_file()
        assert (keys_dir / "brain" / "brain_ed25519_private.pem").is_file()
        assert (keys_dir / "public" / "core_ed25519_public.pem").is_file()
        assert (keys_dir / "public" / "brain_ed25519_public.pem").is_file()

    def test_creates_env_file(self, tmp_path: Path) -> None:
        result = run_install(InstallerConfig(
            dina_dir=tmp_path, passphrase="testpass123",
        ))
        assert result.env_file.exists()
        content = result.env_file.read_text()
        assert "DINA_SESSION=" in content
        assert "DINA_CORE_PORT=" in content
        assert "DINA_PDS_PORT=" in content
        assert "DINA_PDS_JWT_SECRET=" in content

    def test_env_does_not_contain_seed(self, tmp_path: Path) -> None:
        result = run_install(InstallerConfig(
            dina_dir=tmp_path, passphrase="testpass123",
        ))
        content = result.env_file.read_text()
        assert "MASTER_SEED" not in content
        assert "SEED_HEX" not in content

    def test_creates_session_id(self, tmp_path: Path) -> None:
        result = run_install(InstallerConfig(
            dina_dir=tmp_path, passphrase="testpass123",
        ))
        assert len(result.session_id) == 3
        assert result.session_id.isalnum()
        assert result.session_id.islower()


# ======================================================================
# Restore Identity
# ======================================================================


class TestRestoreIdentity:
    """Restore from mnemonic or hex seed."""

    def test_restore_from_mnemonic_produces_same_keys(self, tmp_path: Path) -> None:
        """Round-trip: generate → get mnemonic → restore → same service keys."""
        r1 = run_install(InstallerConfig(
            dina_dir=tmp_path / "first",
            identity_choice=IdentityChoice.NEW,
            passphrase="testpass123",
        ))
        phrase = " ".join(r1.recovery_phrase)

        r2 = run_install(InstallerConfig(
            dina_dir=tmp_path / "second",
            identity_choice=IdentityChoice.RESTORE_MNEMONIC,
            mnemonic=phrase,
            passphrase="different_pass",
        ))

        # Same seed → identical deterministic service keys
        pub1 = (tmp_path / "first/secrets/service_keys/public/core_ed25519_public.pem").read_text()
        pub2 = (tmp_path / "second/secrets/service_keys/public/core_ed25519_public.pem").read_text()
        assert pub1 == pub2

    def test_restore_returns_no_recovery_phrase(self, tmp_path: Path) -> None:
        r1 = run_install(InstallerConfig(
            dina_dir=tmp_path / "first", passphrase="testpass123",
        ))
        r2 = run_install(InstallerConfig(
            dina_dir=tmp_path / "second",
            identity_choice=IdentityChoice.RESTORE_MNEMONIC,
            mnemonic=" ".join(r1.recovery_phrase),
            passphrase="testpass123",
        ))
        assert r2.recovery_phrase is None

    def test_restore_from_hex(self, tmp_path: Path) -> None:
        seed_hex = "a" * 64  # valid 32-byte hex
        result = run_install(InstallerConfig(
            dina_dir=tmp_path,
            identity_choice=IdentityChoice.RESTORE_HEX,
            hex_seed=seed_hex,
            passphrase="testpass123",
        ))
        assert result.seed_wrapped
        assert result.recovery_phrase is None


# ======================================================================
# Startup Modes
# ======================================================================


class TestStartupModes:
    """Server mode vs maximum security mode."""

    def test_server_mode_password_persists(self, tmp_path: Path) -> None:
        run_install(InstallerConfig(
            dina_dir=tmp_path, passphrase="testpass123",
            startup_mode=StartupMode.SERVER,
        ))
        pw = (tmp_path / "secrets" / "seed_password").read_text()
        assert len(pw) > 0

    def test_maximum_mode_password_written_for_first_boot(self, tmp_path: Path) -> None:
        """In maximum mode, passphrase is written for initial boot.
        install.sh clears it AFTER Docker health check (not here)."""
        run_install(InstallerConfig(
            dina_dir=tmp_path, passphrase="testpass123",
            startup_mode=StartupMode.MAXIMUM,
        ))
        # Passphrase must be present so Core can decrypt on first boot
        pw = (tmp_path / "secrets" / "seed_password").read_text()
        assert len(pw) > 0, "Passphrase must persist until Core reads it"

    def test_maximum_mode_password_clearable(self, tmp_path: Path) -> None:
        """After health check, the passphrase can be cleared."""
        from scripts.installer.crypto import write_seed_password

        run_install(InstallerConfig(
            dina_dir=tmp_path, passphrase="testpass123",
            startup_mode=StartupMode.MAXIMUM,
        ))
        # Simulate: install.sh clears after health check
        write_seed_password(tmp_path / "secrets", "", clear=True)
        pw = (tmp_path / "secrets" / "seed_password").read_text()
        assert pw == ""


# ======================================================================
# Idempotency
# ======================================================================


class TestIdempotency:
    """Re-running install preserves existing artifacts."""

    def _first_install(self, dina_dir: Path) -> InstallerResult:
        return run_install(InstallerConfig(
            dina_dir=dina_dir, passphrase="testpass123",
        ))

    def test_rerun_preserves_wrapped_seed(self, tmp_path: Path) -> None:
        self._first_install(tmp_path)
        seed_before = (tmp_path / "secrets" / "wrapped_seed.bin").read_bytes()

        run_install(InstallerConfig(
            dina_dir=tmp_path, passphrase="testpass123",
        ))
        seed_after = (tmp_path / "secrets" / "wrapped_seed.bin").read_bytes()
        assert seed_before == seed_after

    def test_rerun_preserves_session_id(self, tmp_path: Path) -> None:
        r1 = self._first_install(tmp_path)
        r2 = run_install(InstallerConfig(
            dina_dir=tmp_path, passphrase="testpass123",
        ))
        assert r1.session_id == r2.session_id

    def test_rerun_preserves_service_keys(self, tmp_path: Path) -> None:
        self._first_install(tmp_path)
        key_before = (
            tmp_path / "secrets/service_keys/core/core_ed25519_private.pem"
        ).read_bytes()

        run_install(InstallerConfig(
            dina_dir=tmp_path, passphrase="testpass123",
        ))
        key_after = (
            tmp_path / "secrets/service_keys/core/core_ed25519_private.pem"
        ).read_bytes()
        assert key_before == key_after

    def test_rerun_preserves_salt(self, tmp_path: Path) -> None:
        self._first_install(tmp_path)
        salt_before = (tmp_path / "secrets" / "master_seed.salt").read_bytes()

        run_install(InstallerConfig(
            dina_dir=tmp_path, passphrase="testpass123",
        ))
        salt_after = (tmp_path / "secrets" / "master_seed.salt").read_bytes()
        assert salt_before == salt_after

    def test_rerun_preserves_env(self, tmp_path: Path) -> None:
        r1 = self._first_install(tmp_path)
        content_before = r1.env_file.read_text()

        r2 = run_install(InstallerConfig(
            dina_dir=tmp_path, passphrase="testpass123",
        ))
        content_after = r2.env_file.read_text()
        # .env should not be overwritten, only backfilled
        assert "DINA_SESSION=" in content_after
        # Ports should be stable
        assert r1.core_port == r2.core_port
        assert r1.pds_port == r2.pds_port


# ======================================================================
# Permissions
# ======================================================================


class TestPermissions:
    """File permissions are correctly locked."""

    def test_secrets_dir_0700(self, tmp_path: Path) -> None:
        run_install(InstallerConfig(
            dina_dir=tmp_path, passphrase="testpass123",
        ))
        mode = os.stat(tmp_path / "secrets").st_mode
        assert stat.S_IMODE(mode) == 0o700

    def test_wrapped_seed_0600(self, tmp_path: Path) -> None:
        run_install(InstallerConfig(
            dina_dir=tmp_path, passphrase="testpass123",
        ))
        mode = os.stat(tmp_path / "secrets" / "wrapped_seed.bin").st_mode
        assert stat.S_IMODE(mode) == 0o600

    def test_env_file_0600(self, tmp_path: Path) -> None:
        run_install(InstallerConfig(
            dina_dir=tmp_path, passphrase="testpass123",
        ))
        mode = os.stat(tmp_path / ".env").st_mode
        assert stat.S_IMODE(mode) == 0o600

    def test_gitignore_includes_secrets(self, tmp_path: Path) -> None:
        run_install(InstallerConfig(
            dina_dir=tmp_path, passphrase="testpass123",
        ))
        content = (tmp_path / ".gitignore").read_text()
        assert "secrets/" in content
        assert ".env" in content


# ======================================================================
# .env Content
# ======================================================================


class TestEnvContent:
    """The .env file contains correct configuration."""

    def test_llm_providers_written(self, tmp_path: Path) -> None:
        result = run_install(InstallerConfig(
            dina_dir=tmp_path, passphrase="testpass123",
            llm_providers=[
                LLMProviderConfig(env_key="GEMINI_API_KEY", env_value="AIzaSyTest"),
            ],
        ))
        content = result.env_file.read_text()
        assert "GEMINI_API_KEY=AIzaSyTest" in content

    def test_telegram_written(self, tmp_path: Path) -> None:
        result = run_install(InstallerConfig(
            dina_dir=tmp_path, passphrase="testpass123",
            telegram=TelegramConfig(token="123:ABC", user_id="456"),
        ))
        content = result.env_file.read_text()
        assert "DINA_TELEGRAM_TOKEN=123:ABC" in content
        assert "DINA_TELEGRAM_ALLOWED_USERS=456" in content

    def test_owner_name_written(self, tmp_path: Path) -> None:
        result = run_install(InstallerConfig(
            dina_dir=tmp_path, passphrase="testpass123",
            owner_name="Rajmohan",
        ))
        content = result.env_file.read_text()
        assert "DINA_OWNER_NAME=Rajmohan" in content


# ======================================================================
# Pydantic Validation
# ======================================================================


class TestValidation:
    """InstallerConfig rejects invalid input."""

    def test_short_passphrase_rejected(self) -> None:
        with pytest.raises(ValidationError, match="at least 8"):
            InstallerConfig(dina_dir=Path("/tmp"), passphrase="short")

    def test_invalid_hex_seed_rejected(self) -> None:
        with pytest.raises(ValidationError, match="hex"):
            InstallerConfig(
                dina_dir=Path("/tmp"), passphrase="testpass123",
                hex_seed="not-hex-at-all",
            )

    def test_wrong_length_hex_rejected(self) -> None:
        with pytest.raises(ValidationError, match="64"):
            InstallerConfig(
                dina_dir=Path("/tmp"), passphrase="testpass123",
                hex_seed="abcd",
            )

    def test_wrong_mnemonic_word_count_rejected(self) -> None:
        with pytest.raises(ValidationError, match="24"):
            InstallerConfig(
                dina_dir=Path("/tmp"), passphrase="testpass123",
                mnemonic="one two three",
            )


# ======================================================================
# Audit Trail
# ======================================================================


class TestAuditTrail:
    """InstallerResult tracks all steps."""

    def test_all_steps_recorded(self, tmp_path: Path) -> None:
        result = run_install(InstallerConfig(
            dina_dir=tmp_path, passphrase="testpass123",
        ))
        assert len(result.steps) >= 8
        names = [s.name for s in result.steps]
        assert "ensure_secrets_dir" in names
        assert "wrap_seed" in names
        assert "provision_service_keys" in names
        assert "write_env" in names

    def test_all_steps_succeeded(self, tmp_path: Path) -> None:
        result = run_install(InstallerConfig(
            dina_dir=tmp_path, passphrase="testpass123",
        ))
        for step in result.steps:
            assert step.success, f"step {step.name} failed: {step.message}"
