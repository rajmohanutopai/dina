"""FastAPI sub-app for the brain API (/api/*).

All routes require BRAIN_TOKEN in ``Authorization: Bearer`` header.
Uses ``hmac.compare_digest`` for constant-time token comparison to
prevent timing attacks (Brain TEST_PLAN SS1.1.6).

Module isolation: this module does NOT import from ``dina_admin``.

Maps to Brain TEST_PLAN SS10 (API Endpoints) and SS1 (Authentication).
"""

from __future__ import annotations

import hmac
import logging
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .routes import process as process_route
from .routes import reason as reason_route

log = logging.getLogger(__name__)


def create_brain_app(
    guardian: Any,
    sync_engine: Any,
    brain_token: str,
) -> FastAPI:
    """Create the brain API sub-app with BRAIN_TOKEN auth middleware.

    Parameters
    ----------
    guardian:
        GuardianLoop instance for event processing and reasoning.
    sync_engine:
        SyncEngine instance for ingestion pipeline access.
    brain_token:
        The shared secret for authenticating requests from core.
        Compared with ``hmac.compare_digest`` (constant-time).

    Returns
    -------
    FastAPI
        A sub-app to be mounted at ``/api`` on the master app.
    """
    app = FastAPI(
        title="Dina Brain API",
        description="Internal API for dina-core to delegate processing and reasoning.",
        version="0.4.0",
    )
    security = HTTPBearer()

    # ------------------------------------------------------------------
    # Auth dependency
    # ------------------------------------------------------------------

    async def verify_brain_token(
        credentials: HTTPAuthorizationCredentials = Depends(security),
    ) -> HTTPAuthorizationCredentials:
        """Verify that the request carries a valid BRAIN_TOKEN.

        Uses ``hmac.compare_digest`` for constant-time comparison to
        prevent timing side-channel attacks (SS1.1.6).

        Raises
        ------
        HTTPException 401
            If the token is missing, malformed, or does not match.
        """
        if not hmac.compare_digest(credentials.credentials, brain_token):
            log.warning("brain_api.auth_failed")
            raise HTTPException(status_code=401, detail="Invalid BRAIN_TOKEN")
        return credentials

    # ------------------------------------------------------------------
    # Inject dependencies into route modules
    # ------------------------------------------------------------------

    process_route.set_guardian(guardian)
    reason_route.set_dependencies(guardian, sync_engine)

    # ------------------------------------------------------------------
    # Include routers — all routes require BRAIN_TOKEN
    # ------------------------------------------------------------------

    app.include_router(
        process_route.router,
        dependencies=[Depends(verify_brain_token)],
    )
    app.include_router(
        reason_route.router,
        dependencies=[Depends(verify_brain_token)],
    )

    # ------------------------------------------------------------------
    # Exception handlers for consistent error format
    # ------------------------------------------------------------------

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, exc: Exception) -> None:
        """Catch-all for unhandled exceptions.

        Returns a consistent JSON error with the ``detail`` field.
        Logs the error type and path but never the request body (PII).
        """
        from fastapi.responses import JSONResponse

        log.error(
            "brain_api.unhandled_exception",
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
