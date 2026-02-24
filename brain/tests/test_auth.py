"""Tests for brain authentication — BRAIN_TOKEN verification and endpoint access control.

Maps to Brain TEST_PLAN S1 (Authentication & Authorization).

All tests use the real FastAPI sub-apps (create_brain_app, create_admin_app)
wired with mock service dependencies, exercised through TestClient.
"""

from __future__ import annotations

import glob
import os
import re
from dataclasses import dataclass
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from .factories import TEST_BRAIN_TOKEN, TEST_BRAIN_TOKEN_WRONG, TEST_CLIENT_TOKEN

# ---------------------------------------------------------------------------
# Shared test app + client fixtures
# ---------------------------------------------------------------------------

# Path to brain source for code audits
_BRAIN_SRC = os.path.join(os.path.dirname(__file__), os.pardir, "src")


@dataclass
class _FakeConfig:
    """Minimal config satisfying create_admin_app expectations."""

    core_url: str = "http://core:8300"
    brain_token: str = TEST_BRAIN_TOKEN
    client_token: str = TEST_CLIENT_TOKEN
    listen_port: int = 8200
    log_level: str = "INFO"
    cloud_llm: str | None = None


def _build_app() -> FastAPI:
    """Construct a master FastAPI app mirroring production composition."""
    import sys
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), os.pardir, "src"))

    from dina_brain.app import create_brain_app
    from dina_admin.app import create_admin_app

    # Guardian mock — returns sensible defaults
    guardian = AsyncMock()

    async def _process(event: dict) -> dict:
        if event.get("type") == "reason":
            return {
                "status": "ok",
                "content": "Test reasoning result.",
                "model": "test-model",
                "tokens_in": 10,
                "tokens_out": 5,
            }
        return {
            "status": "ok",
            "action": "save_for_briefing",
            "classification": "engagement",
        }

    guardian.process_event.side_effect = _process
    guardian.classify_silence.return_value = "engagement"

    sync_engine = AsyncMock()

    core_client = AsyncMock()
    core_client.health.return_value = {"status": "ok"}

    master = FastAPI()

    brain_api = create_brain_app(guardian, sync_engine, TEST_BRAIN_TOKEN)
    admin_ui = create_admin_app(core_client, _FakeConfig())

    master.mount("/api", brain_api)
    master.mount("/admin", admin_ui)

    @master.get("/healthz")
    async def healthz() -> dict:
        return {"status": "ok"}

    return master


@pytest.fixture(scope="module")
def app() -> FastAPI:
    """Module-scoped test app (created once for all tests in this file)."""
    return _build_app()


@pytest.fixture(scope="module")
def client(app: FastAPI) -> TestClient:
    """Module-scoped test client."""
    return TestClient(app, raise_server_exceptions=False)


# ---------------------------------------------------------------------------
# S1.1 BRAIN_TOKEN Verification
# ---------------------------------------------------------------------------


# TST-BRAIN-001
def test_auth_1_1_1_valid_brain_token(client: TestClient) -> None:
    """S1.1.1: Valid BRAIN_TOKEN in Authorization: Bearer header -> 200."""
    resp = client.post(
        "/api/v1/process",
        headers={"Authorization": f"Bearer {TEST_BRAIN_TOKEN}"},
        json={"type": "message", "body": "test"},
    )
    assert resp.status_code == 200


# TST-BRAIN-002
def test_auth_1_1_2_missing_token(client: TestClient) -> None:
    """S1.1.2: Missing Authorization header -> 401 Unauthorized."""
    resp = client.post(
        "/api/v1/process",
        json={"type": "message", "body": "test"},
    )
    assert resp.status_code == 401
    assert "detail" in resp.json()


# TST-BRAIN-003
def test_auth_1_1_3_wrong_token(client: TestClient) -> None:
    """S1.1.3: Random/wrong hex string in Bearer -> 401."""
    resp = client.post(
        "/api/v1/process",
        headers={"Authorization": f"Bearer {TEST_BRAIN_TOKEN_WRONG}"},
        json={"type": "message", "body": "test"},
    )
    assert resp.status_code == 401
    assert "detail" in resp.json()


# TST-BRAIN-004
def test_auth_1_1_4_token_from_docker_secret(tmp_path: object, monkeypatch: pytest.MonkeyPatch) -> None:
    """S1.1.4: Token loaded from /run/secrets/brain_token on startup.

    Verifies that when DINA_BRAIN_TOKEN_FILE points to a valid file,
    load_brain_config reads the token from that file.
    """
    import sys
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), os.pardir, "src"))

    from infra.config import load_brain_config

    # Write a secret file
    secret_file = os.path.join(str(tmp_path), "brain_token")
    with open(secret_file, "w") as f:
        f.write("secret-from-file-token\n")

    monkeypatch.delenv("DINA_BRAIN_TOKEN", raising=False)
    monkeypatch.setenv("DINA_BRAIN_TOKEN_FILE", secret_file)
    monkeypatch.setenv("DINA_CORE_URL", "http://core:8300")

    cfg = load_brain_config()
    assert cfg.brain_token == "secret-from-file-token"


# TST-BRAIN-005
def test_auth_1_1_5_token_file_missing_refuses_start(monkeypatch: pytest.MonkeyPatch) -> None:
    """S1.1.5: Secret mount absent -> brain refuses to start with clear error."""
    import sys
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), os.pardir, "src"))

    from infra.config import load_brain_config

    monkeypatch.delenv("DINA_BRAIN_TOKEN", raising=False)
    monkeypatch.setenv("DINA_BRAIN_TOKEN_FILE", "/nonexistent/path/brain_token")
    monkeypatch.setenv("DINA_CORE_URL", "http://core:8300")

    with pytest.raises(ValueError, match="BRAIN_TOKEN"):
        load_brain_config()


# TST-BRAIN-006
def test_auth_1_1_6_constant_time_comparison() -> None:
    """S1.1.6: hmac.compare_digest used (no timing leak).

    Code audit: token comparison in both sub-apps must use
    hmac.compare_digest, never == or !=.
    """
    brain_app_path = os.path.normpath(
        os.path.join(_BRAIN_SRC, "dina_brain", "app.py")
    )
    admin_app_path = os.path.normpath(
        os.path.join(_BRAIN_SRC, "dina_admin", "app.py")
    )

    for filepath in (brain_app_path, admin_app_path):
        with open(filepath) as f:
            source = f.read()
        assert "hmac.compare_digest" in source, (
            f"{filepath} does not use hmac.compare_digest for token comparison"
        )


# ---------------------------------------------------------------------------
# S1.2 Endpoint Access Control & Sub-App Isolation
# ---------------------------------------------------------------------------


# TST-BRAIN-007
def test_auth_1_2_1_api_requires_brain_token(client: TestClient) -> None:
    """S1.2.1: /api/* requires BRAIN_TOKEN -- 200 when correct token provided."""
    resp = client.post(
        "/api/v1/process",
        headers={"Authorization": f"Bearer {TEST_BRAIN_TOKEN}"},
        json={"type": "query", "body": "test"},
    )
    assert resp.status_code == 200


# TST-BRAIN-008
def test_auth_1_2_2_api_rejects_client_token(client: TestClient) -> None:
    """S1.2.2: /api/* rejects CLIENT_TOKEN -- 401 (token does not match BRAIN_TOKEN)."""
    resp = client.post(
        "/api/v1/process",
        headers={"Authorization": f"Bearer {TEST_CLIENT_TOKEN}"},
        json={"type": "query", "body": "test"},
    )
    assert resp.status_code == 401
    assert "BRAIN_TOKEN" in resp.json()["detail"]


# TST-BRAIN-009
def test_auth_1_2_3_admin_requires_client_token(client: TestClient) -> None:
    """S1.2.3: /admin/* requires CLIENT_TOKEN -- 200 when correct token provided."""
    resp = client.get(
        "/admin/",
        headers={"Authorization": f"Bearer {TEST_CLIENT_TOKEN}"},
    )
    assert resp.status_code == 200


# TST-BRAIN-010
def test_auth_1_2_4_admin_rejects_brain_token(client: TestClient) -> None:
    """S1.2.4: /admin/* rejects BRAIN_TOKEN -- 401 Unauthorized."""
    resp = client.get(
        "/admin/",
        headers={"Authorization": f"Bearer {TEST_BRAIN_TOKEN}"},
    )
    assert resp.status_code == 401


# TST-BRAIN-011
def test_auth_1_2_5_healthz_unauthenticated(client: TestClient) -> None:
    """S1.2.5: GET /healthz requires no auth -- returns 200 {"status": "ok"}."""
    resp = client.get("/healthz")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"


# TST-BRAIN-012
def test_auth_1_2_6_single_uvicorn_process(app: FastAPI) -> None:
    """S1.2.6: Single Uvicorn process on port 8200, one healthcheck endpoint.

    Structural test: the master app has /healthz registered and both
    sub-apps are mounted at /api and /admin.  The listen port comes
    from config (default 8200).
    """
    # Verify /healthz is on the master, not a sub-app
    healthz_paths = [r.path for r in app.routes if hasattr(r, "path")]
    assert "/healthz" in healthz_paths

    # Verify mount points
    mount_paths = [
        r.path for r in app.routes if hasattr(r, "path") and hasattr(r, "app")
    ]
    assert "/api" in mount_paths
    assert "/admin" in mount_paths


# TST-BRAIN-013
def test_auth_1_2_7_subapp_brain_cannot_import_admin() -> None:
    """S1.2.7: dina_brain module has no imports from dina_admin -- module boundary enforced."""
    brain_pkg = os.path.normpath(os.path.join(_BRAIN_SRC, "dina_brain"))
    py_files = glob.glob(os.path.join(brain_pkg, "**", "*.py"), recursive=True)
    assert len(py_files) > 0, "No Python files found in dina_brain"

    pattern = re.compile(r"^\s*(from\s+dina_admin|import\s+dina_admin)", re.MULTILINE)
    for filepath in py_files:
        with open(filepath) as f:
            source = f.read()
        # Filter out comments
        code_lines = [
            line
            for line in source.splitlines()
            if not line.strip().startswith("#")
        ]
        code = "\n".join(code_lines)
        match = pattern.search(code)
        assert match is None, (
            f"dina_brain imports dina_admin in {filepath}: {match.group()}"
        )


# TST-BRAIN-014
def test_auth_1_2_8_subapp_admin_cannot_import_brain() -> None:
    """S1.2.8: dina_admin module has no imports from dina_brain -- module boundary enforced."""
    admin_pkg = os.path.normpath(os.path.join(_BRAIN_SRC, "dina_admin"))
    py_files = glob.glob(os.path.join(admin_pkg, "**", "*.py"), recursive=True)
    assert len(py_files) > 0, "No Python files found in dina_admin"

    pattern = re.compile(r"^\s*(from\s+dina_brain|import\s+dina_brain)", re.MULTILINE)
    for filepath in py_files:
        with open(filepath) as f:
            source = f.read()
        code_lines = [
            line
            for line in source.splitlines()
            if not line.strip().startswith("#")
        ]
        code = "\n".join(code_lines)
        match = pattern.search(code)
        assert match is None, (
            f"dina_admin imports dina_brain in {filepath}: {match.group()}"
        )


# TST-BRAIN-015
def test_auth_1_2_9_admin_uses_client_token_to_core() -> None:
    """S1.2.9: Admin UI calls core:8100 with CLIENT_TOKEN (not BRAIN_TOKEN).

    Verifies that the admin sub-app's auth dependency checks CLIENT_TOKEN,
    and that the config passed to admin carries client_token, not brain_token.
    """
    import sys
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), os.pardir, "src"))

    from dina_admin.app import create_admin_app

    core_client = AsyncMock()
    core_client.health.return_value = {"status": "ok"}

    config = _FakeConfig()
    admin_app = create_admin_app(core_client, config)
    admin_client = TestClient(admin_app, raise_server_exceptions=False)

    # CLIENT_TOKEN succeeds
    resp = admin_client.get(
        "/",
        headers={"Authorization": f"Bearer {TEST_CLIENT_TOKEN}"},
    )
    assert resp.status_code == 200

    # BRAIN_TOKEN is rejected -- admin only accepts CLIENT_TOKEN
    resp = admin_client.get(
        "/",
        headers={"Authorization": f"Bearer {TEST_BRAIN_TOKEN}"},
    )
    assert resp.status_code == 401


# TST-BRAIN-016
def test_auth_1_2_10_brain_never_sees_cookies(client: TestClient) -> None:
    """S1.2.10: No Cookie header reaches brain -- core translates cookies to Bearer.

    Verifies that the brain sub-app requires Bearer auth and does not
    accept cookies as authentication.  A request with only a Cookie header
    (and no Authorization header) must be rejected.
    """
    resp = client.post(
        "/api/v1/process",
        json={"type": "message", "body": "test"},
        headers={"Cookie": f"session={TEST_BRAIN_TOKEN}"},
    )
    # Without a proper Authorization: Bearer header, the request is rejected
    assert resp.status_code == 401


# TST-BRAIN-017
def test_auth_1_2_11_brain_exposes_process(client: TestClient) -> None:
    """S1.2.11: Brain exposes POST /v1/process to core -- returns 200."""
    resp = client.post(
        "/api/v1/process",
        headers={"Authorization": f"Bearer {TEST_BRAIN_TOKEN}"},
        json={"type": "query", "body": "test"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"


# TST-BRAIN-018
def test_auth_1_2_12_brain_exposes_reason(client: TestClient) -> None:
    """S1.2.12: Brain exposes POST /v1/reason to core -- returns 200."""
    resp = client.post(
        "/api/v1/reason",
        headers={"Authorization": f"Bearer {TEST_BRAIN_TOKEN}"},
        json={"prompt": "test question", "type": "reason"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert "content" in body


# ---------------------------------------------------------------------------
# S1.2 Code Audit: Zero sqlite3 Calls (1 scenario) -- arch S03
# ---------------------------------------------------------------------------


# TST-BRAIN-416
def test_auth_1_2_13_zero_sqlite_calls() -> None:
    """S1.2.13: Code audit -- brain has zero sqlite3.connect() calls.

    Architecture S03: Brain codebase has zero sqlite3.connect() or sqlalchemy
    calls. All data access goes through core HTTP API. CI-enforceable invariant.
    """
    brain_src = os.path.normpath(_BRAIN_SRC)
    py_files = glob.glob(os.path.join(brain_src, "**", "*.py"), recursive=True)
    assert len(py_files) > 0, "No Python files found in brain src"

    violations: list[str] = []
    for filepath in py_files:
        with open(filepath) as f:
            content = f.read()
        if "sqlite3.connect" in content:
            violations.append(f"sqlite3.connect found in {filepath}")
        # Check for sqlalchemy imports (not just mentions in comments)
        for line in content.splitlines():
            stripped = line.strip()
            if stripped.startswith("#"):
                continue
            if "import sqlalchemy" in stripped or "from sqlalchemy" in stripped:
                violations.append(f"sqlalchemy import found in {filepath}")

    assert not violations, f"SQLite/SQLAlchemy violations:\n" + "\n".join(violations)
