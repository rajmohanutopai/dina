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
    monkeypatch.setenv("DINA_HTTPS", "0")
    sub_app = create_admin_app(mock_core, admin_config)
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


def test_login_page_renders(client) -> None:
    """GET /admin/login returns 200 HTML without auth."""
    resp = client.get("/admin/login")
    assert resp.status_code == 200
    assert "text/html" in resp.headers.get("content-type", "")
    assert "Dina" in resp.text
    assert "token" in resp.text.lower()


# TST-BRAIN-482 Login cookie stores stripped token
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


def test_login_invalid_token_rejected(client) -> None:
    """POST /admin/login with wrong token returns 403."""
    resp = client.post(
        "/admin/login",
        json={"token": "wrong-token"},
    )
    assert resp.status_code == 403


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


def test_dashboard_with_bearer(client, auth_headers) -> None:
    """GET /admin/dashboard with Bearer token returns 200 HTML."""
    resp = client.get("/admin/dashboard", headers=auth_headers)
    assert resp.status_code == 200
    assert "text/html" in resp.headers.get("content-type", "")


def test_dashboard_no_auth_returns_401(client) -> None:
    """GET /admin/dashboard without auth returns 401."""
    resp = client.get("/admin/dashboard")
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# SS8.7.3 HTML Pages Render
# ---------------------------------------------------------------------------


def test_history_page_renders(client, auth_headers) -> None:
    """GET /admin/history returns HTML page."""
    resp = client.get("/admin/history", headers=auth_headers)
    assert resp.status_code == 200
    assert "text/html" in resp.headers.get("content-type", "")
    assert "History" in resp.text


def test_contacts_page_renders(client, auth_headers) -> None:
    """GET /admin/contacts-page returns HTML page."""
    resp = client.get("/admin/contacts-page", headers=auth_headers)
    assert resp.status_code == 200
    assert "text/html" in resp.headers.get("content-type", "")
    assert "Contacts" in resp.text


def test_settings_page_renders(client, auth_headers) -> None:
    """GET /admin/settings-page returns HTML page."""
    resp = client.get("/admin/settings-page", headers=auth_headers)
    assert resp.status_code == 200
    assert "text/html" in resp.headers.get("content-type", "")
    assert "Settings" in resp.text


# ---------------------------------------------------------------------------
# SS8.7.4 History API
# ---------------------------------------------------------------------------


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


def test_chat_api_forwards_to_brain(client, auth_headers) -> None:
    """POST /admin/api/chat calls brain's reason endpoint."""
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "content": "Hello! I'm Dina.",
        "model": "test-model",
    }
    mock_response.raise_for_status = MagicMock()

    with patch("httpx.AsyncClient") as mock_client_cls:
        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client_cls.return_value = mock_client

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


def test_architecture_without_file_returns_404(client, auth_headers) -> None:
    """GET /admin/architecture returns 404 when dina.html not found."""
    resp = client.get("/admin/architecture", headers=auth_headers)
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# SS8.7.7 Security
# ---------------------------------------------------------------------------


def test_html_pages_require_auth(client) -> None:
    """All HTML page routes require authentication."""
    pages = ["/admin/dashboard", "/admin/history", "/admin/contacts-page", "/admin/settings-page"]
    for page in pages:
        resp = client.get(page)
        assert resp.status_code == 401, f"{page} should require auth"


def test_api_routes_require_auth(client) -> None:
    """API routes behind cookie auth require authentication."""
    resp = client.get("/admin/api/history/")
    assert resp.status_code == 401

    resp = client.post("/admin/api/chat", json={"prompt": "test"})
    assert resp.status_code == 401
