"""REL-001 Fresh Machine Install — harness portion.

Verify that the Docker stack builds, starts, and becomes healthy.
The manual portion (fresh VM, install.sh UX) remains in test_rel_manual.py.

Execution class: Harness.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import httpx
import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent


class TestFreshInstall:
    """Real Docker tests for REL-001: install and startup validation."""

    # REL-001
    def test_rel_001_install_script_exists_and_executable(self) -> None:
        """install.sh exists and is executable."""
        install = PROJECT_ROOT / "install.sh"
        assert install.exists(), "install.sh missing"
        assert install.stat().st_mode & 0o111, "install.sh not executable"

    # REL-001
    def test_rel_001_run_script_exists(self) -> None:
        """run.sh exists."""
        run_sh = PROJECT_ROOT / "run.sh"
        assert run_sh.exists(), "run.sh missing"

    # REL-001
    def test_rel_001_docker_compose_valid(self) -> None:
        """docker-compose.yml parses without errors."""
        result = subprocess.run(
            ["docker", "compose", "config", "--quiet"],
            capture_output=True, text=True, timeout=30,
            cwd=str(PROJECT_ROOT),
        )
        assert result.returncode == 0, (
            f"docker-compose.yml invalid: {result.stderr[:300]}"
        )

    # REL-001
    def test_rel_001_core_healthy_after_start(self, core_url) -> None:
        """Core healthz returns 200 with valid status field."""
        resp = httpx.get(f"{core_url}/healthz", timeout=5)
        assert resp.status_code == 200
        data = resp.json()
        assert data.get("status") in ("ok", "healthy"), (
            f"Core healthz missing valid status: {data}"
        )

    # REL-001
    def test_rel_001_brain_healthy_after_start(self, brain_url) -> None:
        """Brain healthz returns 200 with valid status field."""
        resp = httpx.get(f"{brain_url}/healthz", timeout=5)
        assert resp.status_code == 200
        data = resp.json()
        assert data.get("status") in ("ok", "healthy", "degraded"), (
            f"Brain healthz missing valid status: {data}"
        )

    # REL-001
    def test_rel_001_did_generated_on_first_boot(
        self, core_url, auth_headers,
    ) -> None:
        """Core generates a DID on first boot without manual steps."""
        resp = httpx.get(
            f"{core_url}/v1/did", headers=auth_headers, timeout=10,
        )
        assert resp.status_code == 200
        did = resp.json().get("id", "")
        assert did.startswith("did:"), f"No DID generated on boot: {did}"
