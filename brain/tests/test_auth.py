"""Tests for brain authentication — BRAIN_TOKEN verification and endpoint access control.

Maps to Brain TEST_PLAN §1 (Authentication & Authorization).
"""

from __future__ import annotations

import pytest

from .factories import TEST_BRAIN_TOKEN, TEST_BRAIN_TOKEN_WRONG, TEST_CLIENT_TOKEN


# ---------------------------------------------------------------------------
# §1.1 BRAIN_TOKEN Verification
# ---------------------------------------------------------------------------


# TST-BRAIN-001
@pytest.mark.asyncio
async def test_auth_1_1_1_valid_brain_token() -> None:
    """§1.1.1: Valid BRAIN_TOKEN in Authorization: Bearer header -> 200."""
    pytest.skip("TokenVerifier not yet implemented")
    # header = f"Bearer {TEST_BRAIN_TOKEN}"
    # response = await app_client.get("/api/v1/health", headers={"Authorization": header})
    # assert response.status_code == 200


# TST-BRAIN-002
@pytest.mark.asyncio
async def test_auth_1_1_2_missing_token() -> None:
    """§1.1.2: Missing Authorization header -> 401 Unauthorized."""
    pytest.skip("TokenVerifier not yet implemented")
    # response = await app_client.get("/api/v1/health", headers={})
    # assert response.status_code == 401


# TST-BRAIN-003
@pytest.mark.asyncio
async def test_auth_1_1_3_wrong_token() -> None:
    """§1.1.3: Random/wrong hex string in Bearer -> 401."""
    pytest.skip("TokenVerifier not yet implemented")
    # header = f"Bearer {TEST_BRAIN_TOKEN_WRONG}"
    # response = await app_client.get("/api/v1/health", headers={"Authorization": header})
    # assert response.status_code == 401


# TST-BRAIN-004
@pytest.mark.asyncio
async def test_auth_1_1_4_token_from_docker_secret() -> None:
    """§1.1.4: Token loaded from /run/secrets/brain_token on startup."""
    pytest.skip("TokenVerifier not yet implemented")
    # Verify that when the secret mount exists, the token is read from file.


# TST-BRAIN-005
@pytest.mark.asyncio
async def test_auth_1_1_5_token_file_missing_refuses_start() -> None:
    """§1.1.5: Secret mount absent -> brain refuses to start with clear error."""
    pytest.skip("TokenVerifier not yet implemented")
    # Verify startup fails with descriptive error when /run/secrets/brain_token is missing.


# TST-BRAIN-006
@pytest.mark.asyncio
async def test_auth_1_1_6_constant_time_comparison() -> None:
    """§1.1.6: hmac.compare_digest used (no timing leak)."""
    pytest.skip("TokenVerifier not yet implemented")
    # Code audit: token comparison must use hmac.compare_digest, never ==.


# ---------------------------------------------------------------------------
# §1.2 Endpoint Access Control & Sub-App Isolation
# ---------------------------------------------------------------------------


# TST-BRAIN-007
@pytest.mark.asyncio
async def test_auth_1_2_1_api_requires_brain_token() -> None:
    """§1.2.1: /api/* requires BRAIN_TOKEN — 200 when correct token provided."""
    pytest.skip("App not yet implemented")
    # response = await app_client.post(
    #     "/api/v1/process",
    #     headers={"Authorization": f"Bearer {TEST_BRAIN_TOKEN}"},
    #     json={"type": "query", "body": "test"},
    # )
    # assert response.status_code == 200


# TST-BRAIN-008
@pytest.mark.asyncio
async def test_auth_1_2_2_api_rejects_client_token() -> None:
    """§1.2.2: /api/* rejects CLIENT_TOKEN — 403 Forbidden."""
    pytest.skip("App not yet implemented")
    # response = await app_client.post(
    #     "/api/v1/process",
    #     headers={"Authorization": f"Bearer {TEST_CLIENT_TOKEN}"},
    #     json={"type": "query", "body": "test"},
    # )
    # assert response.status_code == 403


# TST-BRAIN-009
@pytest.mark.asyncio
async def test_auth_1_2_3_admin_requires_client_token() -> None:
    """§1.2.3: /admin/* requires CLIENT_TOKEN — 200 when correct token provided."""
    pytest.skip("App not yet implemented")
    # response = await app_client.get(
    #     "/admin/",
    #     headers={"Authorization": f"Bearer {TEST_CLIENT_TOKEN}"},
    # )
    # assert response.status_code == 200


# TST-BRAIN-010
@pytest.mark.asyncio
async def test_auth_1_2_4_admin_rejects_brain_token() -> None:
    """§1.2.4: /admin/* rejects BRAIN_TOKEN — 403 Forbidden."""
    pytest.skip("App not yet implemented")
    # response = await app_client.get(
    #     "/admin/",
    #     headers={"Authorization": f"Bearer {TEST_BRAIN_TOKEN}"},
    # )
    # assert response.status_code == 403


# TST-BRAIN-011
@pytest.mark.asyncio
async def test_auth_1_2_5_healthz_unauthenticated() -> None:
    """§1.2.5: GET /healthz requires no auth — returns 200 {"status": "ok"}."""
    pytest.skip("App not yet implemented")
    # response = await app_client.get("/healthz")
    # assert response.status_code == 200
    # assert response.json()["status"] == "ok"


# TST-BRAIN-012
@pytest.mark.asyncio
async def test_auth_1_2_6_single_uvicorn_process() -> None:
    """§1.2.6: Single Uvicorn process on port 8200, one healthcheck endpoint."""
    pytest.skip("App not yet implemented")
    # Verify one uvicorn process, one port, one healthcheck.


# TST-BRAIN-013
@pytest.mark.asyncio
async def test_auth_1_2_7_subapp_brain_cannot_import_admin() -> None:
    """§1.2.7: dina_brain module has no imports from dina_admin — module boundary enforced."""
    pytest.skip("Module isolation not yet implemented")
    # Code audit: grep dina_brain source for "from dina_admin" or "import dina_admin".


# TST-BRAIN-014
@pytest.mark.asyncio
async def test_auth_1_2_8_subapp_admin_cannot_import_brain() -> None:
    """§1.2.8: dina_admin module has no imports from dina_brain — module boundary enforced."""
    pytest.skip("Module isolation not yet implemented")
    # Code audit: grep dina_admin source for "from dina_brain" or "import dina_brain".


# TST-BRAIN-015
@pytest.mark.asyncio
async def test_auth_1_2_9_admin_uses_client_token_to_core() -> None:
    """§1.2.9: Admin UI calls core:8100 with CLIENT_TOKEN (not BRAIN_TOKEN)."""
    pytest.skip("Admin UI not yet implemented")
    # When admin UI requests vault data, it uses CLIENT_TOKEN to call core.


# TST-BRAIN-016
@pytest.mark.asyncio
async def test_auth_1_2_10_brain_never_sees_cookies() -> None:
    """§1.2.10: No Cookie header reaches brain — core translates cookies to Bearer before proxying."""
    pytest.skip("App not yet implemented")
    # Inspect inbound request: no Cookie header present.


# TST-BRAIN-017
@pytest.mark.asyncio
async def test_auth_1_2_11_brain_exposes_process() -> None:
    """§1.2.11: Brain exposes POST /v1/process to core — returns 200 with guardian response."""
    pytest.skip("App not yet implemented")
    # response = await app_client.post(
    #     "/v1/process",
    #     headers={"Authorization": f"Bearer {TEST_BRAIN_TOKEN}"},
    #     json={"type": "query", "body": "test"},
    # )
    # assert response.status_code == 200


# TST-BRAIN-018
@pytest.mark.asyncio
async def test_auth_1_2_12_brain_exposes_reason() -> None:
    """§1.2.12: Brain exposes POST /v1/reason to core — returns 200 with reasoning result."""
    pytest.skip("App not yet implemented")
    # response = await app_client.post(
    #     "/v1/reason",
    #     headers={"Authorization": f"Bearer {TEST_BRAIN_TOKEN}"},
    #     json={"type": "complex_decision", "body": "test"},
    # )
    # assert response.status_code == 200


# ---------------------------------------------------------------------------
# §1.2 Code Audit: Zero sqlite3 Calls (1 scenario) — arch §03
# ---------------------------------------------------------------------------


# TST-BRAIN-416
def test_auth_1_2_13_zero_sqlite_calls() -> None:
    """§1.2.13: Code audit — brain has zero sqlite3.connect() calls.

    Architecture §03: Brain codebase has zero sqlite3.connect() or sqlalchemy
    calls. All data access goes through core HTTP API. CI-enforceable invariant.
    """
    pytest.skip("SQLite audit not yet implemented")
    # import glob, re
    # brain_files = glob.glob("dina_brain/**/*.py", recursive=True)
    # for f in brain_files:
    #     content = open(f).read()
    #     assert "sqlite3.connect" not in content, f"sqlite3.connect found in {f}"
    #     assert "sqlalchemy" not in content, f"sqlalchemy found in {f}"
