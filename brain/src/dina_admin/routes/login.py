"""Login routes for the admin UI.

GET /login — render login page (no auth required).
POST /login — validate CLIENT_TOKEN, set HttpOnly cookie.

No imports from dina_brain — module boundary enforced.
"""

from __future__ import annotations

import hmac
import logging
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

log = logging.getLogger(__name__)

router = APIRouter()

_TEMPLATE_DIR = Path(__file__).resolve().parent.parent / "templates"
templates = Jinja2Templates(directory=str(_TEMPLATE_DIR))

_client_token: str = ""


def set_client_token(token: str) -> None:
    """Set the CLIENT_TOKEN for validation. Called once during app creation."""
    global _client_token
    _client_token = token


class LoginRequest(BaseModel):
    """Login payload."""
    token: str


@router.get("/login", response_class=HTMLResponse)
async def login_page(request: Request) -> HTMLResponse:
    """Render the login page — no auth required."""
    return templates.TemplateResponse(request, "login.html")


@router.post("/login")
async def login(request: LoginRequest) -> JSONResponse:
    """Validate CLIENT_TOKEN and set HttpOnly cookie."""
    if not _client_token:
        raise HTTPException(status_code=503, detail="CLIENT_TOKEN not configured")

    if not hmac.compare_digest(request.token, _client_token):
        log.warning("admin.login_failed")
        raise HTTPException(status_code=403, detail="Invalid token")

    response = JSONResponse(content={"status": "ok", "redirect": "/admin/dashboard"})
    response.set_cookie(
        key="dina_client_token",
        value=request.token,
        httponly=True,
        samesite="strict",
        secure=False,
        max_age=86400,
        path="/admin",
    )
    log.info("admin.login_success")
    return response
