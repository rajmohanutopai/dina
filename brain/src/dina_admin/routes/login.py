"""Login routes for the admin UI.

GET /login — render login page (no auth required).
POST /login — validate CLIENT_TOKEN, set HttpOnly cookie.

No imports from dina_brain — module boundary enforced.
"""

from __future__ import annotations

import collections
import hmac
import logging
import ipaddress
import os
import secrets
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, Field

log = logging.getLogger(__name__)

router = APIRouter()

# MEDIUM-05: CIDR-based trusted proxy list (replaces boolean flag)
_TRUSTED_CIDRS: list = []
_raw_cidrs = os.environ.get("DINA_TRUSTED_PROXIES", "")
if _raw_cidrs:
    for _cidr in _raw_cidrs.split(","):
        _cidr = _cidr.strip()
        if _cidr:
            _TRUSTED_CIDRS.append(ipaddress.ip_network(_cidr, strict=False))


def _get_client_ip(request: Request) -> str:
    """Extract client IP, respecting X-Forwarded-For when proxy is trusted.

    Only trusts XFF if the direct connection (request.client.host) is from
    a trusted proxy CIDR.  Walks XFF right-to-left and returns the first
    non-trusted hop.
    """
    direct_ip = request.client.host if request.client else "unknown"
    if not _TRUSTED_CIDRS:
        return direct_ip
    # MEDIUM-05: Verify the direct connection is from a trusted proxy
    try:
        direct_addr = ipaddress.ip_address(direct_ip)
    except ValueError:
        return direct_ip
    if not any(direct_addr in net for net in _TRUSTED_CIDRS):
        # Direct connection is not from a trusted proxy — ignore XFF
        return direct_ip
    xff = request.headers.get("x-forwarded-for", "")
    if xff:
        parts = [p.strip() for p in xff.split(",")]
        for ip_str in reversed(parts):
            try:
                addr = ipaddress.ip_address(ip_str)
            except ValueError:
                continue
            if not any(addr in net for net in _TRUSTED_CIDRS):
                return ip_str
    return direct_ip

_TEMPLATE_DIR = Path(__file__).resolve().parent.parent / "templates"
templates = Jinja2Templates(directory=str(_TEMPLATE_DIR))

_client_token: str = ""

# Server-side session store: session_id -> {"created": float, "csrf_token": str}
_sessions: dict[str, dict] = {}

# Brute-force throttling (MED-06)
_MAX_ATTEMPTS = 5
_LOCKOUT_SECONDS = 900  # 15 minutes
_MAX_TRACKED_IPS = 10_000
_EVICT_COUNT = 1_000  # evict oldest 10% when full
_login_attempts: collections.OrderedDict[str, list[float]] = collections.OrderedDict()

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
    token: str = Field(..., max_length=512)


@router.get("/login", response_class=HTMLResponse)
async def login_page(request: Request) -> HTMLResponse:
    """Render the login page — no auth required."""
    # Pass CSP nonce for standalone template (login.html doesn't extend base.html)
    nonce = getattr(request.state, "csp_nonce", "")
    return templates.TemplateResponse(request, "login.html", {"csp_nonce": nonce})


@router.post("/login")
async def login(raw_request: Request, body: LoginRequest) -> JSONResponse:
    """Validate CLIENT_TOKEN and set HttpOnly cookie."""
    if not _client_token:
        raise HTTPException(status_code=503, detail="CLIENT_TOKEN not configured")

    client_ip = _get_client_ip(raw_request)

    # --- MED-06: Brute-force throttling ---
    now = time.time()
    attempts = _login_attempts.get(client_ip, [])
    recent = [t for t in attempts if now - t < _LOCKOUT_SECONDS]
    # MED-04: Move to end (most recent) and enforce size bound
    _login_attempts.pop(client_ip, None)
    _login_attempts[client_ip] = recent
    if len(_login_attempts) > _MAX_TRACKED_IPS:
        for _ in range(_EVICT_COUNT):
            if _login_attempts:
                _login_attempts.popitem(last=False)
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

    # --- LOW-02: Secure flag matches actual transport layer ---
    is_https = raw_request.url.scheme == "https"
    if not is_https:
        log.warning("admin.cookies.insecure", extra={"detail": "Secure cookie flag disabled — HTTP request"})

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
    if not session_id or session_id not in _sessions:
        response = JSONResponse(content={"status": "ok", "redirect": "/admin/login"})
        response.delete_cookie("dina_client_token", path="/admin")
        return response
    # Verify CSRF for state-changing operation
    csrf_header = request.headers.get("x-csrf-token", "")
    expected = get_csrf_token(session_id)
    if expected and not hmac.compare_digest(csrf_header, expected):
        raise HTTPException(status_code=403, detail="CSRF token mismatch")
    del _sessions[session_id]
    response = JSONResponse(content={"status": "ok", "redirect": "/admin/login"})
    response.delete_cookie("dina_client_token", path="/admin")
    log.info("admin.logout")
    return response
