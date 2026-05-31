"""Tests for Admin HTML UI pages.

Maps to Brain TEST_PLAN SS8.7 (HTML Admin UI).

Tests the Jinja2-rendered HTML pages, login flow, cookie auth,
and the chat/history API endpoints.

Uses real FastAPI admin sub-app with TestClient and mock core_client.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.dina_admin.app import create_admin_app

from .factories import TEST_CLIENT_TOKEN


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def mock_core():
    """Mock core client for admin UI tests."""
    core = AsyncMock()
    core.health.return_value = {"status": "healthy"}
    core.get_kv.return_value = None
    core.set_kv.return_value = None
    core.store_vault_item.return_value = "item-001"
    core.search_vault.return_value = []
    return core


@pytest.fixture
def admin_config():
    """Config with CLIENT_TOKEN for admin tests."""
    config = MagicMock()
    config.client_token = TEST_CLIENT_TOKEN
    config.brain_token = "test-brain-token-xxx"
    config.core_url = "http://core:8300"
    config.listen_port = 8200
    config.log_level = "INFO"
    config.cloud_llm = None
    return config


@pytest.fixture
def admin_app(mock_core, admin_config, monkeypatch):
    """Create admin sub-app mounted on a parent FastAPI app."""
    # TestClient uses HTTP; secure cookies won't be sent back over HTTP.
    monkeypatch.setenv("DINA_ENV", "test")
    monkeypatch.setenv("DINA_HTTPS", "0")
    # Provide a mock guardian so /api/chat works.
    guardian = AsyncMock()
    guardian.process_event.return_value = {
        "content": "Hello! I'm Dina.",
        "model": "test-model",
        "tokens_in": 10,
        "tokens_out": 5,
    }
    sub_app = create_admin_app(mock_core, admin_config, guardian=guardian)
    parent = FastAPI()
    parent.mount("/admin", sub_app)
    return parent, mock_core, admin_config


@pytest.fixture
def client(admin_app):
    """TestClient for the admin app."""
    app, _, _ = admin_app
    return TestClient(app)


@pytest.fixture
def auth_headers():
    """Authorization headers with valid CLIENT_TOKEN."""
    return {"Authorization": f"Bearer {TEST_CLIENT_TOKEN}"}


# ---------------------------------------------------------------------------
# SS8.7.1 Login Flow
# ---------------------------------------------------------------------------


# TRACE: {"suite": "BRAIN", "case": "0005", "section": "08", "sectionName": "Admin UI", "subsection": "01", "scenario": "01", "title": "login_page_renders"}
def test_login_page_renders(client) -> None:
    """GET /admin/login returns 200 HTML without auth."""
    resp = client.get("/admin/login")
    assert resp.status_code == 200
    assert "text/html" in resp.headers.get("content-type", "")
    assert "Dina" in resp.text
    assert "token" in resp.text.lower()


# TST-BRAIN-482 Login cookie stores stripped token
# TRACE: {"suite": "BRAIN", "case": "0482", "section": "08", "sectionName": "Admin UI", "subsection": "01", "scenario": "02", "title": "login_valid_token_sets_cookie"}
def test_login_valid_token_sets_cookie(client) -> None:
    """POST /admin/login with valid token sets HttpOnly cookie."""
    resp = client.post(
        "/admin/login",
        json={"token": TEST_CLIENT_TOKEN},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    assert "redirect" in data

    # Cookie should be set
    cookies = resp.cookies
    assert "dina_client_token" in cookies


# TRACE: {"suite": "BRAIN", "case": "0006", "section": "08", "sectionName": "Admin UI", "subsection": "01", "scenario": "03", "title": "login_invalid_token_rejected"}
def test_login_invalid_token_rejected(client) -> None:
    """POST /admin/login with wrong token returns 403."""
    resp = client.post(
        "/admin/login",
        json={"token": "wrong-token"},
    )
    assert resp.status_code == 403


# TRACE: {"suite": "BRAIN", "case": "0007", "section": "08", "sectionName": "Admin UI", "subsection": "01", "scenario": "04", "title": "login_empty_token_rejected"}
def test_login_empty_token_rejected(client) -> None:
    """POST /admin/login with empty token returns 403."""
    resp = client.post(
        "/admin/login",
        json={"token": ""},
    )
    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# SS8.7.2 Cookie Auth
# ---------------------------------------------------------------------------


# TRACE: {"suite": "BRAIN", "case": "0008", "section": "08", "sectionName": "Admin UI", "subsection": "01", "scenario": "05", "title": "dashboard_with_cookie"}
def test_dashboard_with_cookie(client) -> None:
    """GET /admin/dashboard with valid cookie returns 200 HTML."""
    # First login to get cookie
    login_resp = client.post(
        "/admin/login",
        json={"token": TEST_CLIENT_TOKEN},
    )
    assert login_resp.status_code == 200

    # Access dashboard with cookie (auto-sent by TestClient)
    resp = client.get("/admin/dashboard")
    assert resp.status_code == 200
    assert "text/html" in resp.headers.get("content-type", "")
    assert "Dashboard" in resp.text


# TRACE: {"suite": "BRAIN", "case": "0009", "section": "08", "sectionName": "Admin UI", "subsection": "01", "scenario": "06", "title": "dashboard_with_bearer"}
def test_dashboard_with_bearer(client, auth_headers) -> None:
    """GET /admin/dashboard with Bearer token returns 200 HTML."""
    resp = client.get("/admin/dashboard", headers=auth_headers)
    assert resp.status_code == 200
    assert "text/html" in resp.headers.get("content-type", "")


# TRACE: {"suite": "BRAIN", "case": "0010", "section": "08", "sectionName": "Admin UI", "subsection": "01", "scenario": "07", "title": "dashboard_no_auth_returns_401"}
def test_dashboard_no_auth_returns_401(client) -> None:
    """GET /admin/dashboard without auth returns 401."""
    resp = client.get("/admin/dashboard")
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# SS8.7.3 HTML Pages Render
# ---------------------------------------------------------------------------


# TRACE: {"suite": "BRAIN", "case": "0011", "section": "08", "sectionName": "Admin UI", "subsection": "01", "scenario": "08", "title": "history_page_renders"}
def test_history_page_renders(client, auth_headers) -> None:
    """GET /admin/history returns HTML page."""
    resp = client.get("/admin/history", headers=auth_headers)
    assert resp.status_code == 200
    assert "text/html" in resp.headers.get("content-type", "")
    assert "History" in resp.text


# TRACE: {"suite": "BRAIN", "case": "0012", "section": "08", "sectionName": "Admin UI", "subsection": "01", "scenario": "09", "title": "contacts_page_renders"}
def test_contacts_page_renders(client, auth_headers) -> None:
    """GET /admin/contacts-page returns HTML page."""
    resp = client.get("/admin/contacts-page", headers=auth_headers)
    assert resp.status_code == 200
    assert "text/html" in resp.headers.get("content-type", "")
    assert "Contacts" in resp.text


# TRACE: {"suite": "BRAIN", "case": "0013", "section": "08", "sectionName": "Admin UI", "subsection": "01", "scenario": "10", "title": "settings_page_renders"}
def test_settings_page_renders(client, auth_headers) -> None:
    """GET /admin/settings-page returns HTML page."""
    resp = client.get("/admin/settings-page", headers=auth_headers)
    assert resp.status_code == 200
    assert "text/html" in resp.headers.get("content-type", "")
    assert "Settings" in resp.text


# ---------------------------------------------------------------------------
# SS8.7.4 History API
# ---------------------------------------------------------------------------


# TRACE: {"suite": "BRAIN", "case": "0014", "section": "08", "sectionName": "Admin UI", "subsection": "01", "scenario": "11", "title": "history_api_returns_paginated"}
def test_history_api_returns_paginated(client, auth_headers) -> None:
    """GET /admin/api/history/ returns paginated JSON."""
    resp = client.get("/admin/api/history/", headers=auth_headers)
    assert resp.status_code == 200
    data = resp.json()
    assert "items" in data
    assert "page" in data
    assert "total" in data
    assert data["page"] == 1


# ---------------------------------------------------------------------------
# SS8.7.5 Chat API
# ---------------------------------------------------------------------------


# TRACE: {"suite": "BRAIN", "case": "0015", "section": "08", "sectionName": "Admin UI", "subsection": "01", "scenario": "12", "title": "chat_api_forwards_to_brain"}
def test_chat_api_forwards_to_brain(client, auth_headers) -> None:
    """POST /admin/api/chat calls guardian directly (not httpx)."""
    # The chat endpoint calls _guardian.process_event() directly.
    # The guardian mock is configured in the admin_app fixture.
    resp = client.post(
        "/admin/api/chat",
        json={"prompt": "Hello"},
        headers=auth_headers,
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["content"] == "Hello! I'm Dina."


# ---------------------------------------------------------------------------
# SS8.7.6 Architecture Page
# ---------------------------------------------------------------------------


# TRACE: {"suite": "BRAIN", "case": "0016", "section": "08", "sectionName": "Admin UI", "subsection": "01", "scenario": "13", "title": "architecture_without_file_returns_404"}
def test_architecture_without_file_returns_404(client, auth_headers) -> None:
    """GET /admin/architecture returns 404 when dina.html not found."""
    resp = client.get("/admin/architecture", headers=auth_headers)
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# SS8.7.7 Security
# ---------------------------------------------------------------------------


# TRACE: {"suite": "BRAIN", "case": "0017", "section": "08", "sectionName": "Admin UI", "subsection": "01", "scenario": "14", "title": "html_pages_require_auth"}
def test_html_pages_require_auth(client) -> None:
    """All HTML page routes require authentication."""
    pages = ["/admin/dashboard", "/admin/history", "/admin/contacts-page", "/admin/settings-page"]
    for page in pages:
        resp = client.get(page)
        assert resp.status_code == 401, f"{page} should require auth"


# TRACE: {"suite": "BRAIN", "case": "0018", "section": "08", "sectionName": "Admin UI", "subsection": "01", "scenario": "15", "title": "api_routes_require_auth"}
def test_api_routes_require_auth(client) -> None:
    """API routes behind cookie auth require authentication."""
    resp = client.get("/admin/api/history/")
    assert resp.status_code == 401

    resp = client.post("/admin/api/chat", json={"prompt": "test"})
    assert resp.status_code == 401
