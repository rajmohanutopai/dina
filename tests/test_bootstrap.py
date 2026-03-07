"""Tests for run.sh and bootstrap script behavior.

Covers:
  - run.sh refuses non-interactive install (Issue 1: no silent identity creation)
  - run.sh checks all mandatory install artifacts (Issue 2: comprehensive check)
  - run.sh backfills required .env keys (Issue 3: shared env_ensure)
  - check_install_complete detects missing files
  - ensure_required_env backfills missing keys
  - has_llm_provider / has_telegram detection

These tests run shell functions in subprocesses — no Docker needed.
"""

from __future__ import annotations

import os
import subprocess
import textwrap
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# Helper: run a bash snippet that sources the modules and executes a command.
# Returns (returncode, stdout, stderr).
def _run_bash(script: str, env: dict | None = None) -> tuple[int, str, str]:
    full_env = {**os.environ, **(env or {})}
    result = subprocess.run(
        ["bash", "-euo", "pipefail", "-c", script],
        capture_output=True,
        text=True,
        cwd=str(PROJECT_ROOT),
        env=full_env,
        timeout=10,
    )
    return result.returncode, result.stdout, result.stderr


# ---------------------------------------------------------------------------
# check_install_complete
# ---------------------------------------------------------------------------


class TestCheckInstallComplete:
    """check_install_complete must verify all mandatory artifacts."""

    @staticmethod
    def _make_full_install(tmp_path: Path) -> None:
        """Create all mandatory install artifacts including PEM files."""
        secrets = tmp_path / "secrets"
        secrets.mkdir(exist_ok=True)
        (secrets / "wrapped_seed.bin").write_bytes(b"x")
        (secrets / "master_seed.salt").write_bytes(b"x")
        (secrets / "seed_password").write_bytes(b"x")
        keys = secrets / "service_keys"
        (keys / "core").mkdir(parents=True, exist_ok=True)
        (keys / "brain").mkdir(parents=True, exist_ok=True)
        (keys / "public").mkdir(parents=True, exist_ok=True)
        (keys / "core" / "core_ed25519_private.pem").write_bytes(b"k")
        (keys / "brain" / "brain_ed25519_private.pem").write_bytes(b"k")
        (keys / "public" / "core_ed25519_public.pem").write_bytes(b"k")
        (keys / "public" / "brain_ed25519_public.pem").write_bytes(b"k")
        (tmp_path / ".env").write_text("DINA_SESSION=abc\n")

    def test_empty_dir_reports_all_missing(self, tmp_path: Path) -> None:
        rc, out, _ = _run_bash(f"""
            source scripts/setup/colors.sh
            source scripts/setup/env_ensure.sh
            if check_install_complete "{tmp_path}"; then
                echo "COMPLETE"
            else
                echo "MISSING:$INSTALL_MISSING"
            fi
        """)
        assert "secrets/" in out
        assert "wrapped_seed.bin" in out
        assert "master_seed.salt" in out
        assert "seed_password" in out
        assert "core_private.pem" in out
        assert "brain_private.pem" in out
        assert "core_public.pem" in out
        assert "brain_public.pem" in out
        assert ".env" in out
        assert "COMPLETE" not in out

    def test_complete_install_passes(self, tmp_path: Path) -> None:
        self._make_full_install(tmp_path)

        rc, out, _ = _run_bash(f"""
            source scripts/setup/colors.sh
            source scripts/setup/env_ensure.sh
            if check_install_complete "{tmp_path}"; then
                echo "COMPLETE"
            else
                echo "INCOMPLETE: $INSTALL_MISSING"
            fi
        """)
        assert "COMPLETE" in out

    def test_empty_key_dirs_detected(self, tmp_path: Path) -> None:
        """Empty service_keys directories must NOT pass (runtime needs PEM files)."""
        secrets = tmp_path / "secrets"
        secrets.mkdir()
        (secrets / "wrapped_seed.bin").write_bytes(b"x")
        (secrets / "master_seed.salt").write_bytes(b"x")
        (secrets / "seed_password").write_bytes(b"x")
        (secrets / "service_keys" / "core").mkdir(parents=True)
        (secrets / "service_keys" / "brain").mkdir(parents=True)
        (secrets / "service_keys" / "public").mkdir(parents=True)
        (tmp_path / ".env").write_text("DINA_SESSION=abc\n")

        rc, out, _ = _run_bash(f"""
            source scripts/setup/colors.sh
            source scripts/setup/env_ensure.sh
            if check_install_complete "{tmp_path}"; then
                echo "COMPLETE"
            else
                echo "MISSING:$INSTALL_MISSING"
            fi
        """)
        assert "COMPLETE" not in out
        assert "core_private.pem" in out
        assert "brain_private.pem" in out

    def test_missing_single_file_detected(self, tmp_path: Path) -> None:
        self._make_full_install(tmp_path)
        # Remove one file
        (tmp_path / "secrets" / "master_seed.salt").unlink()

        rc, out, _ = _run_bash(f"""
            source scripts/setup/colors.sh
            source scripts/setup/env_ensure.sh
            if check_install_complete "{tmp_path}"; then
                echo "COMPLETE"
            else
                echo "MISSING:$INSTALL_MISSING"
            fi
        """)
        assert "master_seed.salt" in out
        assert "COMPLETE" not in out


# ---------------------------------------------------------------------------
# ensure_required_env
# ---------------------------------------------------------------------------


class TestEnsureRequiredEnv:
    """ensure_required_env must backfill all required .env keys."""

    def test_backfills_missing_session(self, tmp_path: Path) -> None:
        env_file = tmp_path / ".env"
        env_file.write_text("# empty\n")
        session_file = tmp_path / "secrets" / "session_id"
        session_file.parent.mkdir(parents=True)
        session_file.write_text("z9k")

        _run_bash(f"""
            source scripts/setup/colors.sh
            source scripts/setup/env_ensure.sh
            ensure_required_env "{env_file}"
        """)

        content = env_file.read_text()
        assert "DINA_SESSION=z9k" in content
        assert "COMPOSE_PROJECT_NAME=dina-z9k" in content

    def test_backfills_missing_ports(self, tmp_path: Path) -> None:
        env_file = tmp_path / ".env"
        env_file.write_text("DINA_SESSION=abc\n")
        (tmp_path / "secrets").mkdir()

        _run_bash(f"""
            source scripts/setup/colors.sh
            source scripts/setup/env_ensure.sh
            ensure_required_env "{env_file}"
        """)

        content = env_file.read_text()
        assert "DINA_CORE_PORT=" in content
        assert "DINA_PDS_PORT=" in content

    def test_backfills_pds_secrets(self, tmp_path: Path) -> None:
        env_file = tmp_path / ".env"
        env_file.write_text("DINA_SESSION=abc\nDINA_CORE_PORT=8100\n")
        (tmp_path / "secrets").mkdir()

        _run_bash(f"""
            source scripts/setup/colors.sh
            source scripts/setup/env_ensure.sh
            ensure_required_env "{env_file}"
        """)

        content = env_file.read_text()
        assert "DINA_PDS_JWT_SECRET=" in content
        assert "DINA_PDS_ADMIN_PASSWORD=" in content
        assert "DINA_PDS_ROTATION_KEY_HEX=" in content
        # Secrets should be non-empty hex strings
        for line in content.splitlines():
            if line.startswith("DINA_PDS_JWT_SECRET="):
                val = line.split("=", 1)[1]
                assert len(val) == 64  # 32 bytes hex
                assert all(c in "0123456789abcdef" for c in val)

    def test_skips_existing_keys(self, tmp_path: Path) -> None:
        env_file = tmp_path / ".env"
        env_file.write_text(textwrap.dedent("""\
            DINA_SESSION=xyz
            COMPOSE_PROJECT_NAME=dina-xyz
            DINA_CORE_PORT=9999
            DINA_PDS_PORT=9998
            DINA_PDS_JWT_SECRET=aabbcc
            DINA_PDS_ADMIN_PASSWORD=ddeeff
            DINA_PDS_ROTATION_KEY_HEX=112233
        """))
        (tmp_path / "secrets").mkdir()

        _run_bash(f"""
            source scripts/setup/colors.sh
            source scripts/setup/env_ensure.sh
            ensure_required_env "{env_file}"
        """)

        content = env_file.read_text()
        # Should preserve original values, not overwrite
        assert "DINA_CORE_PORT=9999" in content
        assert "DINA_PDS_JWT_SECRET=aabbcc" in content
        # Should not have duplicates
        assert content.count("DINA_SESSION=") == 1

    def test_core_port_avoids_existing_pds_port(self, tmp_path: Path) -> None:
        """If DINA_PDS_PORT=8100 already exists, DINA_CORE_PORT must not also be 8100."""
        env_file = tmp_path / ".env"
        env_file.write_text("DINA_SESSION=abc\nDINA_PDS_PORT=8100\n")
        (tmp_path / "secrets").mkdir()

        _run_bash(f"""
            source scripts/setup/colors.sh
            source scripts/setup/env_ensure.sh
            ensure_required_env "{env_file}"
        """)

        content = env_file.read_text()
        core_port = None
        pds_port = None
        for line in content.splitlines():
            if line.startswith("DINA_CORE_PORT="):
                core_port = line.split("=", 1)[1]
            if line.startswith("DINA_PDS_PORT="):
                pds_port = line.split("=", 1)[1]
        assert core_port is not None, "DINA_CORE_PORT should have been added"
        assert pds_port == "8100", "existing DINA_PDS_PORT should be preserved"
        assert core_port != pds_port, f"ports must differ, both are {core_port}"

    def test_pds_port_avoids_existing_core_port(self, tmp_path: Path) -> None:
        """If DINA_CORE_PORT=2583 already exists, DINA_PDS_PORT must not also be 2583."""
        env_file = tmp_path / ".env"
        env_file.write_text("DINA_SESSION=abc\nDINA_CORE_PORT=2583\n")
        (tmp_path / "secrets").mkdir()

        _run_bash(f"""
            source scripts/setup/colors.sh
            source scripts/setup/env_ensure.sh
            ensure_required_env "{env_file}"
        """)

        content = env_file.read_text()
        core_port = None
        pds_port = None
        for line in content.splitlines():
            if line.startswith("DINA_CORE_PORT="):
                core_port = line.split("=", 1)[1]
            if line.startswith("DINA_PDS_PORT="):
                pds_port = line.split("=", 1)[1]
        assert pds_port is not None, "DINA_PDS_PORT should have been added"
        assert core_port == "2583", "existing DINA_CORE_PORT should be preserved"
        assert pds_port != core_port, f"ports must differ, both are {pds_port}"

    def test_compose_project_name_backfilled_independently(self, tmp_path: Path) -> None:
        """COMPOSE_PROJECT_NAME must be added even if DINA_SESSION already exists."""
        env_file = tmp_path / ".env"
        env_file.write_text("DINA_SESSION=abc\n")
        (tmp_path / "secrets").mkdir()

        _run_bash(f"""
            source scripts/setup/colors.sh
            source scripts/setup/env_ensure.sh
            ensure_required_env "{env_file}"
        """)

        content = env_file.read_text()
        assert "COMPOSE_PROJECT_NAME=dina-abc" in content
        assert content.count("DINA_SESSION=") == 1

    def test_backfills_missing_pds_port_independently(self, tmp_path: Path) -> None:
        """If DINA_CORE_PORT exists but DINA_PDS_PORT is missing, only PDS port is added."""
        env_file = tmp_path / ".env"
        env_file.write_text("DINA_SESSION=abc\nDINA_CORE_PORT=8100\n")
        (tmp_path / "secrets").mkdir()

        _run_bash(f"""
            source scripts/setup/colors.sh
            source scripts/setup/env_ensure.sh
            ensure_required_env "{env_file}"
        """)

        content = env_file.read_text()
        assert "DINA_CORE_PORT=8100" in content  # preserved
        assert "DINA_PDS_PORT=" in content  # added
        assert content.count("DINA_CORE_PORT=") == 1  # no duplicate

    def test_backfills_missing_pds_secrets_independently(self, tmp_path: Path) -> None:
        """If JWT secret exists but admin password is missing, only missing ones are added."""
        env_file = tmp_path / ".env"
        env_file.write_text(textwrap.dedent("""\
            DINA_SESSION=abc
            DINA_CORE_PORT=8100
            DINA_PDS_PORT=2583
            DINA_PDS_JWT_SECRET=existing_jwt
        """))
        (tmp_path / "secrets").mkdir()

        _run_bash(f"""
            source scripts/setup/colors.sh
            source scripts/setup/env_ensure.sh
            ensure_required_env "{env_file}"
        """)

        content = env_file.read_text()
        assert "DINA_PDS_JWT_SECRET=existing_jwt" in content  # preserved
        assert "DINA_PDS_ADMIN_PASSWORD=" in content  # added
        assert "DINA_PDS_ROTATION_KEY_HEX=" in content  # added
        assert content.count("DINA_PDS_JWT_SECRET=") == 1  # no duplicate


# ---------------------------------------------------------------------------
# has_llm_provider / has_telegram
# ---------------------------------------------------------------------------


class TestProviderDetection:
    """has_llm_provider and has_telegram must detect configured providers."""

    @pytest.mark.parametrize("key,value", [
        ("GEMINI_API_KEY", "AIza-fake"),
        ("OPENAI_API_KEY", "sk-fake"),
        ("ANTHROPIC_API_KEY", "sk-ant-fake"),
        ("OPENROUTER_API_KEY", "sk-or-fake"),
        ("OLLAMA_BASE_URL", "http://localhost:11434"),
    ])
    def test_has_llm_provider_detects_each(self, tmp_path: Path, key: str, value: str) -> None:
        env_file = tmp_path / ".env"
        env_file.write_text(f"{key}={value}\n")

        rc, out, _ = _run_bash(f"""
            source scripts/setup/colors.sh
            source scripts/setup/llm_provider.sh
            if has_llm_provider "{env_file}"; then echo "YES"; else echo "NO"; fi
        """)
        assert "YES" in out

    def test_has_llm_provider_returns_false_when_empty(self, tmp_path: Path) -> None:
        env_file = tmp_path / ".env"
        env_file.write_text("DINA_SESSION=abc\n")

        rc, out, _ = _run_bash(f"""
            source scripts/setup/colors.sh
            source scripts/setup/llm_provider.sh
            if has_llm_provider "{env_file}"; then echo "YES"; else echo "NO"; fi
        """)
        assert "NO" in out

    def test_has_telegram_detects_token(self, tmp_path: Path) -> None:
        env_file = tmp_path / ".env"
        env_file.write_text("DINA_TELEGRAM_TOKEN=123456:ABC\n")

        rc, out, _ = _run_bash(f"""
            source scripts/setup/colors.sh
            source scripts/setup/telegram.sh
            if has_telegram "{env_file}"; then echo "YES"; else echo "NO"; fi
        """)
        assert "YES" in out

    def test_has_telegram_returns_false_when_missing(self, tmp_path: Path) -> None:
        env_file = tmp_path / ".env"
        env_file.write_text("DINA_SESSION=abc\n")

        rc, out, _ = _run_bash(f"""
            source scripts/setup/colors.sh
            source scripts/setup/telegram.sh
            if has_telegram "{env_file}"; then echo "YES"; else echo "NO"; fi
        """)
        assert "NO" in out


# ---------------------------------------------------------------------------
# run.sh non-interactive bootstrap refusal
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# install.sh can be invoked from any directory
# ---------------------------------------------------------------------------


class TestInstallShFromAnyDir:
    """install.sh must work when called from a different directory."""

    def test_install_sh_sources_modules_from_any_cwd(self, tmp_path: Path) -> None:
        """Running 'bash /path/to/install.sh' from /tmp should not fail on source."""
        # install.sh will fail at Docker check (expected), but source must succeed
        rc, out, err = _run_bash(
            f'cd "{tmp_path}" && bash "{PROJECT_ROOT}/install.sh" 2>&1 || true',
        )
        combined = out + err
        # Should get past sourcing and hit the Docker/prereq check, not "source: not found"
        assert "colors.sh" not in combined
        assert "No such file" not in combined


class TestRunShNonInteractive:
    """run.sh must refuse to install non-interactively."""

    def test_refuses_install_non_interactive(self, tmp_path: Path) -> None:
        """With no install artifacts and stdin piped, run.sh must exit with error."""
        rc, out, err = _run_bash(
            f'bash "{PROJECT_ROOT}/run.sh"',
            env={
                "HOME": str(tmp_path),
                "PATH": os.environ.get("PATH", ""),
                "DINA_DIR": str(tmp_path),
            },
        )
        combined = out + err
        assert rc != 0
        assert "Dina is not installed in this directory" in combined

    def test_refuses_partial_install_non_interactive(self, tmp_path: Path) -> None:
        """With partial artifacts (e.g., secrets/ but no wrapped_seed), still refuses."""
        secrets = tmp_path / "secrets"
        secrets.mkdir()
        (tmp_path / ".env").write_text("DINA_SESSION=abc\n")
        # Create some but not all mandatory files
        (secrets / "seed_password").write_bytes(b"x")

        rc, out, err = _run_bash(
            f'bash "{PROJECT_ROOT}/run.sh"',
            env={
                "HOME": str(tmp_path),
                "PATH": os.environ.get("PATH", ""),
                "DINA_DIR": str(tmp_path),
            },
        )
        combined = out + err
        assert rc != 0
        assert "Dina is not installed in this directory" in combined


# ---------------------------------------------------------------------------
# run.sh backfills required .env keys
# ---------------------------------------------------------------------------


class TestRunShEnvBackfill:
    """run.sh must backfill required .env keys before starting containers."""

    def _make_complete_install(self, tmp_path: Path) -> None:
        """Create all mandatory install artifacts so check_install_complete passes."""
        secrets = tmp_path / "secrets"
        secrets.mkdir(exist_ok=True)
        (secrets / "wrapped_seed.bin").write_bytes(b"x")
        (secrets / "master_seed.salt").write_bytes(b"x")
        (secrets / "seed_password").write_bytes(b"x")
        (secrets / "session_id").write_text("t3s")
        keys = secrets / "service_keys"
        (keys / "core").mkdir(parents=True, exist_ok=True)
        (keys / "brain").mkdir(parents=True, exist_ok=True)
        (keys / "public").mkdir(parents=True, exist_ok=True)
        (keys / "core" / "core_ed25519_private.pem").write_bytes(b"k")
        (keys / "brain" / "brain_ed25519_private.pem").write_bytes(b"k")
        (keys / "public" / "core_ed25519_public.pem").write_bytes(b"k")
        (keys / "public" / "brain_ed25519_public.pem").write_bytes(b"k")

    def test_ensure_required_env_called_on_startup(self, tmp_path: Path) -> None:
        """If .env is missing required keys, run.sh fills them before compose."""
        self._make_complete_install(tmp_path)
        # Create minimal .env (missing ports, service key mode, PDS secrets)
        env_file = tmp_path / ".env"
        env_file.write_text("DINA_SESSION=t3s\n")

        # run.sh will fail at Docker detection (no compose in this env)
        # but the env backfill happens before that. Check .env was updated.
        _run_bash(
            f'bash "{PROJECT_ROOT}/run.sh" 2>&1 || true',
            env={
                "HOME": str(tmp_path),
                "PATH": os.environ.get("PATH", ""),
                "DINA_DIR": str(tmp_path),
            },
        )

        content = env_file.read_text()
        assert "DINA_CORE_PORT=" in content
        assert "DINA_PDS_JWT_SECRET=" in content
