"""FastAPI sub-app for the admin UI (/admin/*).

JSON API routes require CLIENT_TOKEN in ``Authorization: Bearer`` header.
HTML page routes accept CLIENT_TOKEN via cookie OR Bearer header.
Login routes require no authentication.

Uses ``hmac.compare_digest`` for constant-time token comparison to
prevent timing attacks.

Module isolation: this module does NOT import from ``dina_brain``.

Maps to Brain TEST_PLAN SS8 (Admin UI) and SS1.2 (Endpoint Access Control).
"""

from __future__ import annotations

import hmac
import logging
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .routes import contacts as contacts_route
from .routes import dashboard as dashboard_route
from .routes import settings as settings_route
from .routes import login as login_route
from .routes import pages as pages_route
from .routes import chat as chat_route
from .routes import history as history_route

log = logging.getLogger(__name__)


def create_admin_app(
    core_client: Any,
    config: Any,
    *,
    dina_html_path: str | None = None,
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

    Returns
    -------
    FastAPI
        A sub-app to be mounted at ``/admin`` on the master app.
    """
    app = FastAPI(
        title="Dina Admin",
        description="Admin UI for managing contacts, devices, personas, and settings.",
        version="0.5.0",
    )
    security = HTTPBearer()

    client_token = getattr(config, "client_token", None) or ""

    # ------------------------------------------------------------------
    # Auth dependency: Bearer-only (for JSON API routes — unchanged)
    # ------------------------------------------------------------------

    async def verify_client_token(
        credentials: HTTPAuthorizationCredentials = Depends(security),
    ) -> HTTPAuthorizationCredentials:
        """Verify that the request carries a valid CLIENT_TOKEN.

        Uses ``hmac.compare_digest`` for constant-time comparison.

        Raises
        ------
        HTTPException 401
            If the token is missing or malformed.
        HTTPException 403
            If the token does not match CLIENT_TOKEN (e.g. BRAIN_TOKEN
            was sent instead).
        """
        if not client_token:
            raise HTTPException(
                status_code=503,
                detail="CLIENT_TOKEN not configured",
            )

        if not hmac.compare_digest(credentials.credentials, client_token):
            log.warning("admin_api.auth_failed")
            raise HTTPException(status_code=403, detail="Invalid CLIENT_TOKEN")
        return credentials

    # ------------------------------------------------------------------
    # Auth dependency: Cookie-or-Bearer (for HTML page routes)
    # ------------------------------------------------------------------

    async def verify_cookie_or_bearer(request: Request) -> str:
        """Check Bearer header first, then cookie.

        Used by HTML page routes so that browser requests (with cookie)
        and API requests (with Bearer token) both work.

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

        # Try cookie
        cookie_token = request.cookies.get("dina_client_token", "")
        if cookie_token and hmac.compare_digest(cookie_token, client_token):
            return cookie_token

        raise HTTPException(status_code=401, detail="Authentication required")

    # ------------------------------------------------------------------
    # Inject dependencies into route modules
    # ------------------------------------------------------------------

    # Existing JSON routes
    dashboard_route.set_dependencies(core_client, config)
    contacts_route.set_core_client(core_client)
    settings_route.set_dependencies(core_client, config)

    # New routes
    login_route.set_client_token(client_token)
    pages_route.set_config(config)
    chat_route.set_config(config)
    history_route.set_core_client(core_client)

    # ------------------------------------------------------------------
    # Include routers — existing JSON API (Bearer-only auth)
    # ------------------------------------------------------------------

    app.include_router(
        dashboard_route.router,
        dependencies=[Depends(verify_client_token)],
    )
    app.include_router(
        contacts_route.router,
        dependencies=[Depends(verify_client_token)],
    )
    app.include_router(
        settings_route.router,
        dependencies=[Depends(verify_client_token)],
    )

    # ------------------------------------------------------------------
    # Include routers — login (no auth required)
    # ------------------------------------------------------------------

    app.include_router(login_route.router)

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
            content={"detail": f"Internal server error: {type(exc).__name__}"},
        )

    return app
