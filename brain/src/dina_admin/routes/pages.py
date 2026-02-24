"""HTML page routes for the admin UI.

Serves Jinja2-rendered HTML pages. Requires CLIENT_TOKEN via cookie
or Authorization header (enforced by the app-level dependency).

All data mutations go through the existing JSON API endpoints
via fetch() in the browser.

No imports from dina_brain — module boundary enforced.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates

log = logging.getLogger(__name__)

router = APIRouter()

_TEMPLATE_DIR = Path(__file__).resolve().parent.parent / "templates"
templates = Jinja2Templates(directory=str(_TEMPLATE_DIR))

_config: Any = None


def set_config(config: Any) -> None:
    """Set config. Called once during app creation."""
    global _config
    _config = config


@router.get("/dashboard", response_class=HTMLResponse)
async def dashboard_page(request: Request) -> HTMLResponse:
    """Render the dashboard page."""
    return templates.TemplateResponse(request, "dashboard.html", {
        "page": "dashboard",
    })


@router.get("/history", response_class=HTMLResponse)
async def history_page(request: Request) -> HTMLResponse:
    """Render the history page."""
    return templates.TemplateResponse(request, "history.html", {
        "page": "history",
    })


@router.get("/contacts-page", response_class=HTMLResponse)
async def contacts_page(request: Request) -> HTMLResponse:
    """Render the contacts page."""
    return templates.TemplateResponse(request, "contacts.html", {
        "page": "contacts",
    })


@router.get("/settings-page", response_class=HTMLResponse)
async def settings_page(request: Request) -> HTMLResponse:
    """Render the settings page."""
    return templates.TemplateResponse(request, "settings.html", {
        "page": "settings",
    })


@router.get("/devices-page", response_class=HTMLResponse)
async def devices_page(request: Request) -> HTMLResponse:
    """Render the devices page."""
    return templates.TemplateResponse(request, "devices.html", {
        "page": "devices",
    })
