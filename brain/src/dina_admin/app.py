"""FastAPI sub-app for the admin UI (/admin/*).

All routes require CLIENT_TOKEN in ``Authorization: Bearer`` header.
Admin UI calls core:8100 with CLIENT_TOKEN (not BRAIN_TOKEN).

Uses ``hmac.compare_digest`` for constant-time token comparison to
prevent timing attacks.

Module isolation: this module does NOT import from ``dina_brain``.

Maps to Brain TEST_PLAN SS8 (Admin UI) and SS1.2 (Endpoint Access Control).
"""

from __future__ import annotations

import hmac
import logging
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .routes import contacts as contacts_route
from .routes import dashboard as dashboard_route
from .routes import settings as settings_route

log = logging.getLogger(__name__)


def create_admin_app(core_client: Any, config: Any) -> FastAPI:
    """Create the admin UI sub-app with CLIENT_TOKEN auth middleware.

    Parameters
    ----------
    core_client:
        CoreHTTPClient instance configured with CLIENT_TOKEN for
        calling core:8100.  Admin routes use this to proxy requests.
    config:
        BrainConfig instance containing CLIENT_TOKEN and other settings.

    Returns
    -------
    FastAPI
        A sub-app to be mounted at ``/admin`` on the master app.
    """
    app = FastAPI(
        title="Dina Admin",
        description="Admin UI for managing contacts, devices, personas, and settings.",
        version="0.4.0",
    )
    security = HTTPBearer()

    client_token = getattr(config, "client_token", None) or ""

    # ------------------------------------------------------------------
    # Auth dependency
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
            # No CLIENT_TOKEN configured — reject all admin requests
            raise HTTPException(
                status_code=503,
                detail="CLIENT_TOKEN not configured",
            )

        if not hmac.compare_digest(credentials.credentials, client_token):
            log.warning("admin_api.auth_failed")
            raise HTTPException(status_code=403, detail="Invalid CLIENT_TOKEN")
        return credentials

    # ------------------------------------------------------------------
    # Inject dependencies into route modules
    # ------------------------------------------------------------------

    dashboard_route.set_dependencies(core_client, config)
    contacts_route.set_core_client(core_client)
    settings_route.set_dependencies(core_client, config)

    # ------------------------------------------------------------------
    # Include routers — all routes require CLIENT_TOKEN
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
