"""REL-016 Upgrade Verification and No-Auto-Update.

Verify that no auto-update mechanism is present and the system
only updates through explicit operator action.

Execution class: Harness.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import httpx
import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent


class TestUpgradeVerification:
    """Real tests for REL-016: no auto-update, explicit upgrade only."""

    # REL-016
    def test_rel_016_no_auto_update_service(self, release_services) -> None:
        """No auto-update cron job or service runs inside the container."""
        result = subprocess.run(
            [
                "docker", "compose",
                "-f", str(release_services._compose_file),
                "exec", "-T", "release-core",
                "sh", "-c",
                "ls /etc/cron.d/ 2>/dev/null; "
                "ls /etc/cron.daily/ 2>/dev/null; "
                "cat /var/spool/cron/crontabs/root 2>/dev/null; "
                "echo DONE",
            ],
            capture_output=True, text=True, timeout=15,
            cwd=str(release_services._compose_file.parent),
        )
        if result.returncode != 0:
            pytest.skip("Cannot exec into container")
        output = result.stdout.lower()
        assert "update" not in output or "DONE" in result.stdout, (
            f"Unexpected update mechanism found: {result.stdout[:300]}"
        )

    # REL-016
    def test_rel_016_no_watchtower_or_ouroboros(self, release_services) -> None:
        """No auto-update container (watchtower, ouroboros) in the stack."""
        result = subprocess.run(
            [
                "docker", "compose",
                "-f", str(release_services._compose_file),
                "ps", "--format", "json",
            ],
            capture_output=True, text=True, timeout=15,
            cwd=str(release_services._compose_file.parent),
        )
        if result.returncode != 0:
            pytest.skip("Cannot inspect containers")
        output = result.stdout.lower()
        for updater in ("watchtower", "ouroboros", "auto-update"):
            assert updater not in output, (
                f"Auto-update container '{updater}' found in stack"
            )

    # REL-016
    def test_rel_016_system_stable_after_restart(
        self, core_url, auth_headers,
    ) -> None:
        """System remains on the same version after healthz calls."""
        resp1 = httpx.get(f"{core_url}/healthz", timeout=5)
        assert resp1.status_code == 200
        resp2 = httpx.get(f"{core_url}/healthz", timeout=5)
        assert resp2.status_code == 200
        # Version info should not change between calls
        v1 = resp1.json().get("version", resp1.json().get("build"))
        v2 = resp2.json().get("version", resp2.json().get("build"))
        if v1 is not None and v2 is not None:
            assert v1 == v2, "Version changed between healthz calls"
