"""Tests for brain authentication — Ed25519 service-key verification and endpoint access control.

Maps to Brain TEST_PLAN S1 (Authentication & Authorization).

All tests use the real FastAPI sub-apps (create_brain_app, create_admin_app)
wired with mock service dependencies, exercised through TestClient.
"""

from __future__ import annotations

import glob
import json
import os
import re
from dataclasses import dataclass
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from .factories import (
    TEST_BRAIN_TOKEN,
    TEST_CLIENT_TOKEN,
    TEST_CORE_PUBLIC_KEY,
    sign_test_request,
)

# ---------------------------------------------------------------------------
# Shared test app + client fixtures
# ---------------------------------------------------------------------------

# Path to brain source for code audits
_BRAIN_SRC = os.path.join(os.path.dirname(__file__), os.pardir, "src")


@dataclass
class _FakeConfig:
    """Minimal config satisfying create_admin_app expectations."""

    core_url: str = "http://core:8300"
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

    brain_api = create_brain_app(
        guardian, sync_engine, core_public_key=TEST_CORE_PUBLIC_KEY,
    )
    admin_ui = create_admin_app(core_client, _FakeConfig())

    master.mount("/api", brain_api)
    master.mount("/admin", admin_ui)

    @master.get("/healthz")
    async def healthz() -> dict:
        return {"status": "ok"}

    return master


def _signed_post(client: TestClient, path: str, data: dict) -> "Response":
    """POST with Ed25519 signed headers."""
    body = json.dumps(data).encode()
    headers = sign_test_request("POST", path, body)
    headers["Content-Type"] = "application/json"
    return client.post(path, content=body, headers=headers)


@pytest.fixture(scope="module")
def app() -> FastAPI:
    """Module-scoped test app (created once for all tests in this file)."""
    return _build_app()


@pytest.fixture(scope="module")
def client(app: FastAPI) -> TestClient:
    """Module-scoped test client."""
    return TestClient(app, raise_server_exceptions=False)


@pytest.fixture(autouse=True)
def _clear_nonce_cache() -> None:
    """Reset the signing nonce cache between tests to prevent replay rejection."""
    from adapter.signing import _nonce_cache
    _nonce_cache._current.clear()
    _nonce_cache._previous.clear()


# ---------------------------------------------------------------------------
# S1.1 Ed25519 Service-Key Verification
# ---------------------------------------------------------------------------


# TST-BRAIN-001
# TRACE: {"suite": "BRAIN", "case": "0001", "section": "01", "sectionName": "Authentication & Authorization", "subsection": "01", "scenario": "01", "title": "valid_service_key"}
def test_auth_1_1_1_valid_service_key(client: TestClient) -> None:
    """S1.1.1: Valid Ed25519 signed request -> 200."""
    resp = _signed_post(client, "/api/v1/process", {"type": "message", "body": "test"})
    assert resp.status_code == 200


# TST-BRAIN-002
# TRACE: {"suite": "BRAIN", "case": "0002", "section": "01", "sectionName": "Authentication & Authorization", "subsection": "01", "scenario": "02", "title": "missing_auth"}
def test_auth_1_1_2_missing_auth(client: TestClient) -> None:
    """S1.1.2: Missing auth headers -> 401 Unauthorized."""
    resp = client.post(
        "/api/v1/process",
        json={"type": "message", "body": "test"},
    )
    assert resp.status_code == 401
    assert "detail" in resp.json()


# TST-BRAIN-003
# TRACE: {"suite": "BRAIN", "case": "0003", "section": "01", "sectionName": "Authentication & Authorization", "subsection": "01", "scenario": "03", "title": "wrong_signature"}
def test_auth_1_1_3_wrong_signature(client: TestClient) -> None:
    """S1.1.3: Invalid signature in X-Signature -> 401."""
    resp = client.post(
        "/api/v1/process",
        json={"type": "message", "body": "test"},
        headers={
            "X-DID": "did:key:zFakeKey",
            "X-Timestamp": "2026-01-01T00:00:00Z",
            "X-Signature": "deadbeef" * 16,
        },
    )
    assert resp.status_code == 401
    assert "detail" in resp.json()


# TST-BRAIN-004
# TRACE: {"suite": "BRAIN", "case": "0004", "section": "01", "sectionName": "Authentication & Authorization", "subsection": "01", "scenario": "04", "title": "service_key_dir_config"}
def test_auth_1_1_4_service_key_dir_config(monkeypatch: pytest.MonkeyPatch) -> None:
    """S1.1.4: SERVICE_KEY_DIR is read from DINA_SERVICE_KEY_DIR env var."""
    import sys
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), os.pardir, "src"))

    from infra.config import load_brain_config

    monkeypatch.setenv("DINA_SERVICE_KEY_DIR", "/custom/keys")
    monkeypatch.setenv("DINA_CORE_URL", "http://core:8300")

    cfg = load_brain_config()
    assert cfg.service_key_dir == "/custom/keys"


# TST-BRAIN-005
# TRACE: {"suite": "BRAIN", "case": "0005", "section": "01", "sectionName": "Authentication & Authorization", "subsection": "01", "scenario": "05", "title": "service_key_dir_default"}
def test_auth_1_1_5_service_key_dir_default(monkeypatch: pytest.MonkeyPatch) -> None:
    """S1.1.5: SERVICE_KEY_DIR defaults to /run/secrets/service_keys."""
    import sys
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), os.pardir, "src"))

    from infra.config import load_brain_config

    monkeypatch.delenv("DINA_SERVICE_KEY_DIR", raising=False)
    monkeypatch.setenv("DINA_CORE_URL", "http://core:8300")

    cfg = load_brain_config()
    assert cfg.service_key_dir == "/run/secrets/service_keys"


# TST-BRAIN-006
# TRACE: {"suite": "BRAIN", "case": "0006", "section": "01", "sectionName": "Authentication & Authorization", "subsection": "01", "scenario": "06", "title": "constant_time_comparison"}
def test_auth_1_1_6_constant_time_comparison() -> None:
    """S1.1.6: Admin sub-app uses hmac.compare_digest for CLIENT_TOKEN (no timing leak).

    Brain sub-app uses Ed25519 signature verification (inherently constant-time).

    We use AST parsing to verify that hmac.compare_digest is actually
    *called* in the admin auth path, not just imported or mentioned in
    a comment.
    """
    import ast

    admin_app_path = os.path.normpath(
        os.path.join(_BRAIN_SRC, "dina_admin", "app.py")
    )

    with open(admin_app_path) as f:
        source = f.read()

    # AST-level check: hmac.compare_digest must appear as a Call node,
    # not just as a string in a comment or dead code.
    tree = ast.parse(source, filename=admin_app_path)
    found_call = False
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            func = node.func
            # Match hmac.compare_digest(...)
            if (
                isinstance(func, ast.Attribute)
                and func.attr == "compare_digest"
                and isinstance(func.value, ast.Name)
                and func.value.id == "hmac"
            ):
                found_call = True
                break
    assert found_call, (
        f"{admin_app_path} does not *call* hmac.compare_digest — "
        "string presence alone could be a comment or dead code"
    )

    # Also verify that raw '==' is NOT used on token/secret variables.
    # Scan for patterns like `token == ` or `== client_token` which
    # would indicate an insecure comparison path.
    for node in ast.walk(tree):
        if isinstance(node, ast.Compare):
            for comparator_group in [node.left, *node.comparators]:
                if isinstance(comparator_group, ast.Name) and comparator_group.id in (
                    "token", "client_token", "csrf_header", "expected",
                ):
                    for op in node.ops:
                        assert not isinstance(op, ast.Eq), (
                            f"{admin_app_path} uses '==' on security-sensitive "
                            f"variable '{comparator_group.id}' — must use "
                            "hmac.compare_digest to prevent timing leaks"
                        )

    # Brain sub-app uses Ed25519 verify (not bearer tokens).
    brain_app_path = os.path.normpath(
        os.path.join(_BRAIN_SRC, "dina_brain", "app.py")
    )
    with open(brain_app_path) as f:
        brain_source = f.read()

    # AST-level check: verify_request must be called, not just imported.
    brain_tree = ast.parse(brain_source, filename=brain_app_path)
    found_verify = False
    for node in ast.walk(brain_tree):
        if isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Attribute) and func.attr == "verify_request":
                found_verify = True
                break
            if isinstance(func, ast.Name) and func.id == "verify_request":
                found_verify = True
                break
    assert found_verify, (
        f"{brain_app_path} does not *call* verify_request — "
        "string presence alone could be an import or comment"
    )


# ---------------------------------------------------------------------------
# S1.2 Endpoint Access Control & Sub-App Isolation
# ---------------------------------------------------------------------------


# TST-BRAIN-007
# TRACE: {"suite": "BRAIN", "case": "0007", "section": "01", "sectionName": "Authentication & Authorization", "subsection": "02", "scenario": "01", "title": "api_requires_service_key"}
def test_auth_1_2_1_api_requires_service_key(client: TestClient) -> None:
    """S1.2.1: /api/* requires Ed25519 service key -- 200 when correctly signed."""
    resp = _signed_post(client, "/api/v1/process", {"type": "query", "body": "test"})
    assert resp.status_code == 200


# TST-BRAIN-008
# TRACE: {"suite": "BRAIN", "case": "0008", "section": "01", "sectionName": "Authentication & Authorization", "subsection": "02", "scenario": "02", "title": "api_rejects_client_token"}
def test_auth_1_2_2_api_rejects_client_token(client: TestClient) -> None:
    """S1.2.2: /api/* rejects CLIENT_TOKEN bearer -- 401."""
    resp = client.post(
        "/api/v1/process",
        headers={"Authorization": f"Bearer {TEST_CLIENT_TOKEN}"},
        json={"type": "query", "body": "test"},
    )
    assert resp.status_code == 401
    body = resp.json()
    assert body.get("status") != "ok", "CLIENT_TOKEN must not grant API access"
    # Counter-proof: Ed25519 signed request succeeds.
    signed_resp = _signed_post(client, "/api/v1/process", {"type": "query", "body": "test"})
    assert signed_resp.status_code == 200, "Ed25519 signed request must succeed (counter-proof)"


# TST-BRAIN-009
# TRACE: {"suite": "BRAIN", "case": "0009", "section": "01", "sectionName": "Authentication & Authorization", "subsection": "02", "scenario": "03", "title": "admin_requires_client_token"}
def test_auth_1_2_3_admin_requires_client_token(client: TestClient) -> None:
    """S1.2.3: /admin/* requires CLIENT_TOKEN -- 200 when correct token provided."""
    resp = client.get(
        "/admin/",
        headers={"Authorization": f"Bearer {TEST_CLIENT_TOKEN}"},
    )
    assert resp.status_code == 200


# TST-BRAIN-010
# TRACE: {"suite": "BRAIN", "case": "0010", "section": "01", "sectionName": "Authentication & Authorization", "subsection": "02", "scenario": "04", "title": "admin_rejects_brain_token"}
def test_auth_1_2_4_admin_rejects_brain_token(client: TestClient) -> None:
    """S1.2.4: /admin/* rejects BRAIN_TOKEN -- 401 Unauthorized."""
    resp = client.get(
        "/admin/",
        headers={"Authorization": f"Bearer {TEST_BRAIN_TOKEN}"},
    )
    assert resp.status_code == 401


# TST-BRAIN-011
# TRACE: {"suite": "BRAIN", "case": "0011", "section": "01", "sectionName": "Authentication & Authorization", "subsection": "02", "scenario": "05", "title": "healthz_unauthenticated"}
def test_auth_1_2_5_healthz_unauthenticated(client: TestClient) -> None:
    """S1.2.5: GET /healthz requires no auth -- returns 200 {"status": "ok"}."""
    resp = client.get("/healthz")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"


# TST-BRAIN-012
# TRACE: {"suite": "BRAIN", "case": "0012", "section": "01", "sectionName": "Authentication & Authorization", "subsection": "02", "scenario": "06", "title": "single_uvicorn_process"}
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
# TRACE: {"suite": "BRAIN", "case": "0013", "section": "01", "sectionName": "Authentication & Authorization", "subsection": "02", "scenario": "07", "title": "subapp_brain_cannot_import_admin"}
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
# TRACE: {"suite": "BRAIN", "case": "0014", "section": "01", "sectionName": "Authentication & Authorization", "subsection": "02", "scenario": "08", "title": "subapp_admin_cannot_import_brain"}
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
# TRACE: {"suite": "BRAIN", "case": "0015", "section": "01", "sectionName": "Authentication & Authorization", "subsection": "02", "scenario": "09", "title": "admin_uses_client_token_to_core"}
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
# TRACE: {"suite": "BRAIN", "case": "0016", "section": "01", "sectionName": "Authentication & Authorization", "subsection": "02", "scenario": "10", "title": "brain_never_sees_cookies"}
def test_auth_1_2_10_brain_never_sees_cookies(client: TestClient) -> None:
    """S1.2.10: No Cookie header reaches brain -- core translates cookies to Bearer.

    Verifies that the brain sub-app requires Ed25519 signed auth and does not
    accept cookies as authentication.  A request with only a Cookie header
    (and no X-DID/X-Signature headers) must be rejected.
    """
    resp = client.post(
        "/api/v1/process",
        json={"type": "message", "body": "test"},
        headers={"Cookie": f"session={TEST_BRAIN_TOKEN}"},
    )
    assert resp.status_code == 401
    # Cookie must not grant access — verify no success indicators.
    body = resp.json()
    assert body.get("status") != "ok", "Cookie-only request must not succeed"
    # Verify the same request WITH proper signing succeeds (counter-proof).
    signed_resp = _signed_post(client, "/api/v1/process", {"type": "query", "body": "test"})
    assert signed_resp.status_code == 200, "Signed request must succeed (counter-proof)"


# TST-BRAIN-017
# TRACE: {"suite": "BRAIN", "case": "0017", "section": "01", "sectionName": "Authentication & Authorization", "subsection": "02", "scenario": "11", "title": "brain_exposes_process"}
def test_auth_1_2_11_brain_exposes_process(client: TestClient) -> None:
    """S1.2.11: Brain exposes POST /v1/process to core -- returns 200."""
    resp = _signed_post(client, "/api/v1/process", {"type": "query", "body": "test process endpoint"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"


# TST-BRAIN-018
# TRACE: {"suite": "BRAIN", "case": "0018", "section": "01", "sectionName": "Authentication & Authorization", "subsection": "02", "scenario": "12", "title": "brain_exposes_reason"}
def test_auth_1_2_12_brain_exposes_reason(client: TestClient) -> None:
    """S1.2.12: Brain exposes POST /v1/reason to core -- returns 200."""
    resp = _signed_post(
        client, "/api/v1/reason", {"prompt": "test question", "type": "reason"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert "content" in body


# ---------------------------------------------------------------------------
# S1.2 Code Audit: Zero sqlite3 Calls (1 scenario) -- arch S03
# ---------------------------------------------------------------------------


# TST-BRAIN-416
# TRACE: {"suite": "BRAIN", "case": "0416", "section": "01", "sectionName": "Authentication & Authorization", "subsection": "02", "scenario": "13", "title": "zero_sqlite_calls"}
def test_auth_1_2_13_zero_sqlite_calls() -> None:
    """S1.2.13: Code audit -- brain has zero sqlite3/sqlalchemy usage.

    Architecture S03: Brain codebase has zero sqlite3 or sqlalchemy
    calls. All data access goes through core HTTP API. CI-enforceable invariant.

    Checks for: sqlite3.connect, import sqlite3, from sqlite3,
    import sqlalchemy, from sqlalchemy — in non-comment lines.
    """
    brain_src = os.path.normpath(_BRAIN_SRC)
    py_files = glob.glob(os.path.join(brain_src, "**", "*.py"), recursive=True)
    assert len(py_files) > 0, "No Python files found in brain src"

    # Patterns that indicate direct database usage (bypassing core HTTP API)
    _SQLITE_PATTERNS = [
        re.compile(r"\bsqlite3\.connect\b"),
        re.compile(r"\bimport\s+sqlite3\b"),
        re.compile(r"\bfrom\s+sqlite3\b"),
        re.compile(r"\bimport\s+sqlalchemy\b"),
        re.compile(r"\bfrom\s+sqlalchemy\b"),
    ]

    violations: list[str] = []
    for filepath in py_files:
        with open(filepath) as f:
            for lineno, line in enumerate(f, 1):
                stripped = line.strip()
                if stripped.startswith("#"):
                    continue
                for pat in _SQLITE_PATTERNS:
                    if pat.search(stripped):
                        violations.append(
                            f"{filepath}:{lineno}: {pat.pattern}"
                        )

    assert not violations, (
        f"SQLite/SQLAlchemy violations (brain must use core HTTP API only):\n"
        + "\n".join(violations)
    )
