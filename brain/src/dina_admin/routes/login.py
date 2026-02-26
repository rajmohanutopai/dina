"""Login routes for the admin UI.

GET /login — render login page (no auth required).
POST /login — validate CLIENT_TOKEN, set HttpOnly cookie.

No imports from dina_brain — module boundary enforced.
"""

from __future__ import annotations

import hmac
import logging
import os
import secrets
import time
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

# Server-side session store: session_id -> {"created": float}
_sessions: dict[str, dict] = {}


def set_client_token(token: str) -> None:
    """Set the CLIENT_TOKEN for validation. Called once during app creation."""
    global _client_token
    _client_token = token


def validate_session(session_id: str) -> bool:
    """Check if a session ID is valid and not expired."""
    session = _sessions.get(session_id)
    if not session:
        return False
    if time.time() - session["created"] > 86400:  # 24h expiry
        del _sessions[session_id]
        return False
    return True


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

    if not hmac.compare_digest(request.token.strip(), _client_token):
        log.warning("admin.login_failed")
        raise HTTPException(status_code=403, detail="Invalid token")

    session_id = secrets.token_urlsafe(32)
    _sessions[session_id] = {"created": time.time()}

    is_https = os.environ.get("DINA_HTTPS", "").lower() in ("1", "true", "yes")

    response = JSONResponse(content={"status": "ok", "redirect": "/admin/dashboard"})
    response.set_cookie(
        key="dina_client_token",
        value=session_id,
        httponly=True,
        samesite="strict",
        secure=is_https,
        max_age=86400,
        path="/admin",
    )
    log.info("admin.login_success")
    return response


@router.post("/logout")
async def logout(request: Request) -> JSONResponse:
    """Clear the auth cookie, invalidate session, and redirect to login page."""
    session_id = request.cookies.get("dina_client_token")
    if session_id and session_id in _sessions:
        del _sessions[session_id]
    response = JSONResponse(content={"status": "ok", "redirect": "/admin/login"})
    response.delete_cookie("dina_client_token", path="/admin")
    log.info("admin.logout")
    return response
