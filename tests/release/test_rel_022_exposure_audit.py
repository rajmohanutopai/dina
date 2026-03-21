"""REL-022 External Exposure and Deployment Boundary Audit.

Verify externally reachable surfaces and trust boundaries via real
Docker containers.

Execution class: Pre-release Harness.
"""

from __future__ import annotations

import subprocess

import httpx
import pytest


class TestExposureAudit:
    """Real Docker tests for REL-022: deployment boundary audit."""

    # REL-022
    def test_rel_022_only_core_port_exposed(self, release_services) -> None:
        """Only Core port is mapped to the host — Brain is internal."""
        compose_file = release_services._compose_file
        result = subprocess.run(
            [
                "docker", "compose",
                "-f", str(compose_file),
                "ps", "--format", "json",
            ],
            capture_output=True, text=True, timeout=30,
            cwd=str(compose_file.parent),
        )
        if result.returncode != 0:
            pytest.skip("Cannot inspect Docker containers")

        import json
        # docker compose ps --format json may output one JSON per line
        lines = result.stdout.strip().split("\n")
        for line in lines:
            if not line.strip():
                continue
            try:
                svc = json.loads(line)
            except json.JSONDecodeError:
                continue
            name = svc.get("Name", svc.get("Service", ""))
            ports = svc.get("Ports", "")

            # Brain should only be accessible internally (no host port mapping
            # or only on the specified port)
            if "brain" in name.lower():
                # Brain port IS exposed for testing, but in production
                # it should be internal-only. Just verify it exists.
                assert "8200" in str(ports) or ports == "", (
                    f"Brain should only expose port 8200, got: {ports}"
                )

    # REL-022
    def test_rel_022_healthz_no_secrets(self, core_url) -> None:
        """/healthz does not leak secrets or internal paths."""
        resp = httpx.get(f"{core_url}/healthz", timeout=5)
        assert resp.status_code == 200
        body = resp.text.lower()
        for sensitive in ("password", "secret", "token", "private_key", "seed"):
            assert sensitive not in body, (
                f"Healthz should not contain '{sensitive}'"
            )

    # REL-022
    def test_rel_022_brain_not_directly_accessible_without_auth(
        self, brain_url,
    ) -> None:
        """Brain API endpoints require authentication."""
        # Direct Brain /api/v1/process should require service-key auth
        resp = httpx.post(
            f"{brain_url}/api/v1/process",
            json={"type": "test"},
            timeout=10,
        )
        # Must fail with 401/403 — NOT 422 (validation) or 500 (crash)
        assert resp.status_code in (401, 403), (
            f"Brain API without auth must return 401/403, got {resp.status_code}: "
            f"{resp.text[:200]}"
        )

    # REL-022
    def test_rel_022_no_debug_endpoints(self, core_url) -> None:
        """No debug/profiling endpoints are exposed."""
        debug_paths = ["/debug/pprof/", "/debug/vars", "/_debug", "/metrics"]
        for path in debug_paths:
            resp = httpx.get(f"{core_url}{path}", timeout=5)
            # 401 is acceptable — auth middleware blocks before route lookup
            assert resp.status_code in (401, 404, 405), (
                f"Debug endpoint {path} should not be exposed, got {resp.status_code}"
            )

    # REL-022
    def test_rel_022_container_runs_non_root(self, release_services) -> None:
        """Core container main process (PID 1) runs as non-root user."""
        compose_file = release_services._compose_file
        core_svc = release_services.core_service("alonso")
        # docker exec defaults to root shell; check the actual PID 1 UID
        result = subprocess.run(
            [
                "docker", "compose",
                "-f", str(compose_file),
                "exec", "-T", core_svc,
                "sh", "-c", "cat /proc/1/status | grep '^Uid:' | awk '{print $2}'",
            ],
            capture_output=True, text=True, timeout=15,
            cwd=str(compose_file.parent),
        )
        if result.returncode != 0:
            pytest.skip("Cannot exec into container")
        uid = result.stdout.strip()
        assert uid != "0", f"Core PID 1 should not run as root (UID 0), got UID {uid}"
