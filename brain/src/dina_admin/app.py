"""FastAPI sub-app for the admin UI (/admin/*).

All authenticated routes accept CLIENT_TOKEN via cookie OR Bearer header.
Login routes require no authentication.

Uses ``hmac.compare_digest`` for constant-time token comparison to
prevent timing attacks.

Module isolation: this module does NOT import from ``dina_brain``.

Maps to Brain TEST_PLAN SS8 (Admin UI) and SS1.2 (Endpoint Access Control).
"""

from __future__ import annotations

import hmac
import logging
import os
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .routes import contacts as contacts_route
from .routes import dashboard as dashboard_route
from .routes import devices as devices_route
from .routes import settings as settings_route
from .routes import login as login_route
from .routes.login import get_csrf_token, validate_session
from .routes import pages as pages_route
from .routes import chat as chat_route
from .routes import history as history_route

log = logging.getLogger(__name__)

# SEC-LOW-01: Disable docs/openapi in production
_env = os.environ.get("DINA_ENV", "production").lower()
_is_dev = _env in ("development", "test")
if not _is_dev and os.environ.get("DINA_TEST_MODE", "").lower() == "true":
    _is_dev = True


def create_admin_app(
    core_client: Any,
    config: Any,
    *,
    dina_html_path: str | None = None,
    images_dir: str | None = None,
    llm_reload_callback: Any | None = None,
) -> FastAPI:
    """Create the admin UI sub-app with CLIENT_TOKEN auth middleware.

    Parameters
    ----------
    core_client:
        CoreHTTPClient instance configured with CLIENT_TOKEN for
        calling core:8100.  Admin routes use this to proxy requests.
    config:
        BrainConfig instance containing CLIENT_TOKEN and other settings.
    dina_html_path:
        Optional path to dina.html for the architecture visualization page.
    images_dir:
        Optional path to the images directory for architecture illustrations.
    llm_reload_callback:
        Optional async callback that rebuilds LLM providers from stored
        keys.  Wired into the settings route for hot-reload on save.

    Returns
    -------
    FastAPI
        A sub-app to be mounted at ``/admin`` on the master app.
    """
    app = FastAPI(
        title="Dina Admin",
        description="Admin UI for managing contacts, devices, personas, and settings.",
        version="0.5.0",
        docs_url="/docs" if _is_dev else None,
        redoc_url="/redoc" if _is_dev else None,
        openapi_url="/openapi.json" if _is_dev else None,
    )

    # ------------------------------------------------------------------
    # MED-02: Security headers middleware
    # ------------------------------------------------------------------

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; "
            "script-src 'self' 'unsafe-inline'; "
            "style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; "
            "frame-ancestors 'none'"
        )
        if _env == "production":
            response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        return response

    # ------------------------------------------------------------------
    # MED-14: Rate limiting on expensive endpoints
    # ------------------------------------------------------------------

    try:
        from ..infra.rate_limit import TokenBucketLimiter
    except ImportError:
        from infra.rate_limit import TokenBucketLimiter
    _chat_limiter = TokenBucketLimiter(rate=10/60, burst=5)

    @app.middleware("http")
    async def rate_limit_chat(request: Request, call_next):
        if request.url.path == "/api/chat":
            key = request.cookies.get("dina_client_token", request.client.host if request.client else "unknown")
            if not _chat_limiter.allow(key):
                from fastapi.responses import JSONResponse
                return JSONResponse(status_code=429, content={"detail": "Rate limit exceeded"})
        return await call_next(request)

    client_token = getattr(config, "client_token", None) or ""

    # ------------------------------------------------------------------
    # Auth dependency: Cookie-or-Bearer (all authenticated routes)
    # ------------------------------------------------------------------

    async def verify_cookie_or_bearer(request: Request) -> str:
        """Check Bearer header first, then cookie.

        Accepts both ``Authorization: Bearer <token>`` and the
        ``dina_client_token`` HttpOnly cookie set at login.

        Raises
        ------
        HTTPException 401
            If neither a valid Bearer token nor a valid cookie is present.
        """
        if not client_token:
            raise HTTPException(
                status_code=503,
                detail="CLIENT_TOKEN not configured",
            )

        # Try Authorization header
        auth = request.headers.get("authorization", "")
        if auth.startswith("Bearer "):
            token = auth[7:]
            if hmac.compare_digest(token, client_token):
                return token

        # Try cookie (session-based validation)
        cookie_val = request.cookies.get("dina_client_token", "")
        if cookie_val and validate_session(cookie_val):
            # MED-05: CSRF validation for state-changing methods with cookie auth
            if request.method in ("POST", "PUT", "DELETE"):
                csrf_header = request.headers.get("x-csrf-token", "")
                expected = get_csrf_token(cookie_val)
                if expected and not hmac.compare_digest(csrf_header, expected):
                    raise HTTPException(status_code=403, detail="CSRF token mismatch")
            return cookie_val

        raise HTTPException(status_code=401, detail="Authentication required")

    # ------------------------------------------------------------------
    # Inject dependencies into route modules
    # ------------------------------------------------------------------

    # Existing JSON routes
    dashboard_route.set_dependencies(core_client, config)
    contacts_route.set_core_client(core_client)
    devices_route.set_core_client(core_client)
    settings_route.set_dependencies(core_client, config)
    if llm_reload_callback is not None:
        settings_route.set_llm_reload_callback(llm_reload_callback)

    # New routes
    login_route.set_client_token(client_token)
    pages_route.set_config(config)
    chat_route.set_config(config)
    history_route.set_core_client(core_client)

    # ------------------------------------------------------------------
    # Include routers — JSON API (cookie-or-bearer auth)
    # ------------------------------------------------------------------

    app.include_router(
        dashboard_route.router,
        dependencies=[Depends(verify_cookie_or_bearer)],
    )
    app.include_router(
        contacts_route.router,
        dependencies=[Depends(verify_cookie_or_bearer)],
    )
    app.include_router(
        devices_route.router,
        dependencies=[Depends(verify_cookie_or_bearer)],
    )
    app.include_router(
        settings_route.router,
        dependencies=[Depends(verify_cookie_or_bearer)],
    )

    # ------------------------------------------------------------------
    # Include routers — login (no auth required)
    # ------------------------------------------------------------------

    app.include_router(login_route.router)
    # LOW-03: Logout CSRF is accepted risk — logout is a nuisance, not a breach.
    # Session validation is done inside the logout handler itself.

    # ------------------------------------------------------------------
    # Include routers — HTML pages + new API (cookie-or-bearer auth)
    # ------------------------------------------------------------------

    app.include_router(
        pages_route.router,
        dependencies=[Depends(verify_cookie_or_bearer)],
    )
    app.include_router(
        chat_route.router,
        dependencies=[Depends(verify_cookie_or_bearer)],
    )
    app.include_router(
        history_route.router,
        dependencies=[Depends(verify_cookie_or_bearer)],
    )

    # ------------------------------------------------------------------
    # Architecture visualization (dina.html)
    # ------------------------------------------------------------------

    _dina_html = Path(dina_html_path) if dina_html_path else None

    @app.get("/architecture")
    async def architecture_page(
        _token: str = Depends(verify_cookie_or_bearer),
    ) -> FileResponse:
        """Serve dina.html — architecture visualization."""
        if _dina_html and _dina_html.is_file():
            return FileResponse(str(_dina_html), media_type="text/html")
        raise HTTPException(status_code=404, detail="dina.html not found")

    # ------------------------------------------------------------------
    # Static files: images for architecture page
    # ------------------------------------------------------------------
    # LOW-04: Architecture images are intentionally public — they contain no
    # secrets or user data. Protecting them adds complexity without security value.

    _images_dir = Path(images_dir) if images_dir else None
    if _images_dir and _images_dir.is_dir():
        app.mount(
            "/images",
            StaticFiles(directory=str(_images_dir)),
            name="images",
        )

    # ------------------------------------------------------------------
    # Exception handlers for consistent error format
    # ------------------------------------------------------------------

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, exc: Exception) -> None:
        """Catch-all for unhandled exceptions.

        Returns a consistent JSON error with the ``detail`` field.
        """
        from fastapi.responses import JSONResponse

        log.error(
            "admin_api.unhandled_exception",
            extra={
                "path": request.url.path,
                "error": type(exc).__name__,
            },
        )
        return JSONResponse(
            status_code=500,
            content={"detail": "Internal server error"},
        )

    return app
