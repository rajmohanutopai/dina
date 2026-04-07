"""Deployment regression tests — verify install.sh produces correct config.

These tests catch issues that only appear on fresh installs or deploys:
- Env var collisions between local PDS and community PDS
- Missing shared infrastructure URLs
- PDS account credentials written after containers start
- run.sh --build flag for code updates

No Docker needed — these verify file content and config structure.
"""

from __future__ import annotations

import os
import re
import tempfile
from pathlib import Path

import pytest


PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent


class TestEnvVarSeparation:
    """Verify local PDS and community PDS use separate env var namespaces."""

    # TRACE: {"suite": "INST", "case": "0080", "section": "03", "sectionName": "Functional", "subsection": "01", "scenario": "01", "title": "community_pds_uses_separate_vars"}
    def test_community_pds_uses_separate_vars(self) -> None:
        """docker-compose.yml Brain section uses DINA_COMMUNITY_PDS_* not DINA_PDS_*."""
        compose = (PROJECT_ROOT / "docker-compose.yml").read_text()
        # Find the brain service section
        brain_section = False
        brain_lines = []
        for line in compose.split("\n"):
            if "brain:" in line and not line.strip().startswith("#"):
                brain_section = True
            elif brain_section and re.match(r"  \w", line) and "brain" not in line:
                break
            if brain_section:
                brain_lines.append(line)

        brain_text = "\n".join(brain_lines)

        # Brain should use COMMUNITY_PDS vars, not bare PDS vars for handle/password
        assert "DINA_COMMUNITY_PDS_HANDLE" in brain_text or "COMMUNITY_PDS_HANDLE" in brain_text, \
            "Brain should use DINA_COMMUNITY_PDS_HANDLE, not DINA_PDS_HANDLE"
        assert "DINA_COMMUNITY_PDS_PASSWORD" in brain_text or "COMMUNITY_PDS_PASSWORD" in brain_text, \
            "Brain should use DINA_COMMUNITY_PDS_PASSWORD, not DINA_PDS_ADMIN_PASSWORD"

    # TRACE: {"suite": "INST", "case": "0081", "section": "03", "sectionName": "Functional", "subsection": "01", "scenario": "02", "title": "core_uses_community_pds_vars"}
    def test_core_uses_community_pds_vars(self) -> None:
        """Core service uses DINA_COMMUNITY_PDS_* (same as Brain — no sidecar PDS)."""
        compose = (PROJECT_ROOT / "docker-compose.yml").read_text()
        assert "DINA_COMMUNITY_PDS_PASSWORD" in compose
        assert "DINA_COMMUNITY_PDS_URL" in compose

    # TRACE: {"suite": "INST", "case": "0082", "section": "03", "sectionName": "Functional", "subsection": "01", "scenario": "03", "title": "install_writes_community_pds_vars"}
    def test_install_writes_community_pds_vars(self) -> None:
        """install.sh writes DINA_COMMUNITY_PDS_* to .env, not DINA_PDS_*."""
        install = (PROJECT_ROOT / "install.sh").read_text()
        assert "DINA_COMMUNITY_PDS_URL=" in install
        assert "DINA_COMMUNITY_PDS_HANDLE=" in install
        assert "DINA_COMMUNITY_PDS_PASSWORD=" in install


class TestSharedInfrastructureDefaults:
    """Verify install.sh writes shared infrastructure URLs to .env."""

    # TRACE: {"suite": "INST", "case": "0083", "section": "03", "sectionName": "Functional", "subsection": "02", "scenario": "01", "title": "install_writes_msgbox_url"}
    def test_install_writes_msgbox_url(self) -> None:
        """install.sh writes DINA_MSGBOX_URL to .env."""
        install = (PROJECT_ROOT / "install.sh").read_text()
        assert "DINA_MSGBOX_URL=" in install
        assert "mailbox.dinakernel.com" in install

    # TRACE: {"suite": "INST", "case": "0084", "section": "03", "sectionName": "Functional", "subsection": "02", "scenario": "02", "title": "install_writes_appview_url"}
    def test_install_writes_appview_url(self) -> None:
        """install.sh writes DINA_APPVIEW_URL to .env."""
        install = (PROJECT_ROOT / "install.sh").read_text()
        assert "DINA_APPVIEW_URL=" in install
        assert "appview.dinakernel.com" in install

    # TRACE: {"suite": "INST", "case": "0085", "section": "03", "sectionName": "Functional", "subsection": "02", "scenario": "03", "title": "install_writes_timezone"}
    def test_install_writes_timezone(self) -> None:
        """install.sh writes DINA_TIMEZONE to .env."""
        install = (PROJECT_ROOT / "install.sh").read_text()
        assert "DINA_TIMEZONE=" in install

    # TRACE: {"suite": "INST", "case": "0096", "section": "03", "sectionName": "Functional", "subsection": "02", "scenario": "04", "title": "install_has_test_mode"}
    def test_install_has_test_mode(self) -> None:
        """install.sh --test switches to test infrastructure URLs."""
        install = (PROJECT_ROOT / "install.sh").read_text()
        assert "--test) TEST_MODE=true" in install
        assert "test-pds.dinakernel.com" in install
        assert "test-mailbox.dinakernel.com" in install
        assert "test-appview.dinakernel.com" in install


class TestPDSAccountCreation:
    """Verify PDS account is created and verified before declaring success."""

    # TRACE: {"suite": "INST", "case": "0086", "section": "03", "sectionName": "Functional", "subsection": "03", "scenario": "01", "title": "install_verifies_pds_credentials"}
    def test_install_verifies_pds_credentials(self) -> None:
        """install.sh verifies PDS credentials after account creation."""
        install = (PROJECT_ROOT / "install.sh").read_text()
        # Should call createSession to verify credentials work
        assert "createSession" in install, \
            "install.sh should verify PDS credentials via createSession"

    # TRACE: {"suite": "INST", "case": "0087", "section": "03", "sectionName": "Functional", "subsection": "03", "scenario": "02", "title": "install_restarts_brain_after_pds"}
    def test_install_restarts_brain_after_pds(self) -> None:
        """install.sh restarts Brain after PDS account creation."""
        install = (PROJECT_ROOT / "install.sh").read_text()
        # Find PDS account creation section
        pds_idx = install.find("Community PDS")
        assert pds_idx > 0, "install.sh should have Community PDS section"
        # After PDS section, should restart brain
        after_pds = install[pds_idx:]
        assert "force-recreate brain" in after_pds or "restart brain" in after_pds, \
            "install.sh should restart Brain after PDS account creation"


class TestRunShRebuild:
    """Verify run.sh rebuilds Docker images on start."""

    # TRACE: {"suite": "INST", "case": "0088", "section": "03", "sectionName": "Functional", "subsection": "04", "scenario": "01", "title": "run_sh_uses_build_flag"}
    def test_run_sh_uses_build_flag(self) -> None:
        """run.sh --start includes --build to pick up code changes."""
        run_sh = (PROJECT_ROOT / "run.sh").read_text()
        assert "--build" in run_sh, \
            "run.sh should use --build flag in docker compose up"


class TestPLCRegistration:
    """Verify DID registration on PLC directory."""

    # TRACE: {"suite": "INST", "case": "0089", "section": "03", "sectionName": "Functional", "subsection": "05", "scenario": "01", "title": "core_has_eager_did_creation"}
    def test_core_has_eager_did_creation(self) -> None:
        """Core creates DID eagerly at startup (not lazily on first request)."""
        main_go = (PROJECT_ROOT / "core" / "cmd" / "dina-core" / "main.go").read_text()
        assert "DID created on first boot" in main_go, \
            "Core should eagerly create DID at startup"

    # TRACE: {"suite": "INST", "case": "0090", "section": "03", "sectionName": "Functional", "subsection": "05", "scenario": "02", "title": "eager_did_after_plc_client"}
    def test_eager_did_after_plc_client(self) -> None:
        """Eager DID creation happens AFTER PLC client is configured."""
        main_go = (PROJECT_ROOT / "core" / "cmd" / "dina-core" / "main.go").read_text()
        plc_idx = main_go.find("SetPLCClient")
        eager_idx = main_go.find("DID created on first boot")
        assert plc_idx > 0 and eager_idx > 0, "Both SetPLCClient and eager DID should exist"
        assert plc_idx < eager_idx, \
            "SetPLCClient must come before eager DID creation"

    # TRACE: {"suite": "INST", "case": "0091", "section": "03", "sectionName": "Functional", "subsection": "05", "scenario": "03", "title": "plc_update_publishes_messaging_service"}
    def test_plc_update_publishes_messaging_service(self) -> None:
        """Core publishes #dina_messaging to PLC directory."""
        main_go = (PROJECT_ROOT / "core" / "cmd" / "dina-core" / "main.go").read_text()
        assert "dina_messaging" in main_go
        assert "UpdatePLCDocument" in main_go or "UpdatePLCServices" in main_go

    # TRACE: {"suite": "INST", "case": "0092", "section": "03", "sectionName": "Functional", "subsection": "05", "scenario": "04", "title": "plc_update_publishes_signing_key"}
    def test_plc_update_publishes_signing_key(self) -> None:
        """Core publishes #dina_signing Ed25519 key to PLC directory."""
        main_go = (PROJECT_ROOT / "core" / "cmd" / "dina-core" / "main.go").read_text()
        assert "dina_signing" in main_go

    # TRACE: {"suite": "INST", "case": "0093", "section": "03", "sectionName": "Functional", "subsection": "05", "scenario": "05", "title": "did_resolver_has_plc_fetcher"}
    def test_did_resolver_has_plc_fetcher(self) -> None:
        """DID resolver has PLC directory as remote fetcher."""
        main_go = (PROJECT_ROOT / "core" / "cmd" / "dina-core" / "main.go").read_text()
        assert "SetFetcher" in main_go
        assert "plcResolver" in main_go or "PLCResolver" in main_go


class TestBrainStartupResilience:
    """Verify Brain handles Core being unavailable at startup."""

    # TRACE: {"suite": "INST", "case": "0094", "section": "03", "sectionName": "Functional", "subsection": "06", "scenario": "01", "title": "telegram_startup_has_retry"}
    def test_telegram_startup_has_retry(self) -> None:
        """Brain retries Telegram startup if Core is unavailable."""
        main_py = (PROJECT_ROOT / "brain" / "src" / "main.py").read_text()
        assert "_start_telegram_with_retry" in main_py
        assert "backoff" in main_py.lower() or "retry" in main_py.lower()

    # TRACE: {"suite": "INST", "case": "0095", "section": "03", "sectionName": "Functional", "subsection": "06", "scenario": "02", "title": "bluesky_startup_has_retry"}
    def test_bluesky_startup_has_retry(self) -> None:
        """Brain retries Bluesky startup if auth fails."""
        main_py = (PROJECT_ROOT / "brain" / "src" / "main.py").read_text()
        assert "_start_bluesky_with_retry" in main_py
