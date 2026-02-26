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

# Server-side session store: session_id -> {"created": float, "csrf_token": str}
_sessions: dict[str, dict] = {}

# Brute-force throttling (MED-06)
_MAX_ATTEMPTS = 5
_LOCKOUT_SECONDS = 900  # 15 minutes
_login_attempts: dict[str, list[float]] = {}

# Session store bounds (LOW-01)
_MAX_SESSIONS = 100


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


def get_csrf_token(session_id: str) -> str:
    """Get CSRF token for a session."""
    session = _sessions.get(session_id)
    return session.get("csrf_token", "") if session else ""


class LoginRequest(BaseModel):
    """Login payload."""
    token: str


@router.get("/login", response_class=HTMLResponse)
async def login_page(request: Request) -> HTMLResponse:
    """Render the login page — no auth required."""
    return templates.TemplateResponse(request, "login.html")


@router.post("/login")
async def login(raw_request: Request, body: LoginRequest) -> JSONResponse:
    """Validate CLIENT_TOKEN and set HttpOnly cookie."""
    if not _client_token:
        raise HTTPException(status_code=503, detail="CLIENT_TOKEN not configured")

    client_ip = raw_request.client.host if raw_request.client else "unknown"

    # --- MED-06: Brute-force throttling ---
    now = time.time()
    attempts = _login_attempts.get(client_ip, [])
    recent = [t for t in attempts if now - t < _LOCKOUT_SECONDS]
    _login_attempts[client_ip] = recent
    if len(recent) >= _MAX_ATTEMPTS:
        log.warning("admin.login_throttled", extra={"ip": client_ip, "attempts": len(recent)})
        raise HTTPException(status_code=429, detail="Too many attempts. Try again later.")

    if not hmac.compare_digest(body.token.strip(), _client_token):
        _login_attempts.setdefault(client_ip, []).append(now)
        log.warning("admin.login_failed", extra={"ip": client_ip})
        raise HTTPException(status_code=403, detail="Invalid token")

    # Successful login — clear throttle attempts
    _login_attempts.pop(client_ip, None)

    # --- LOW-01: Evict expired sessions and enforce hard cap ---
    expired = [sid for sid, s in _sessions.items() if now - s["created"] > 86400]
    for sid in expired:
        del _sessions[sid]
    if len(_sessions) >= _MAX_SESSIONS:
        oldest_sid = min(_sessions, key=lambda s: _sessions[s]["created"])
        del _sessions[oldest_sid]

    # --- MED-05: CSRF token in session ---
    session_id = secrets.token_urlsafe(32)
    csrf_token = secrets.token_hex(32)
    _sessions[session_id] = {"created": now, "csrf_token": csrf_token}

    # --- LOW-02: Default secure=True (opt out with DINA_HTTPS=0) ---
    is_https = os.environ.get("DINA_HTTPS", "1").lower() not in ("0", "false", "no")

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
