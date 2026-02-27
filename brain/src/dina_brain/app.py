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
import os
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .routes import pii as pii_route
from .routes import process as process_route
from .routes import reason as reason_route

log = logging.getLogger(__name__)

# SEC-LOW-01: Disable docs/openapi in production
_env = os.environ.get("DINA_ENV", "production").lower()
_is_dev = _env in ("development", "test")
if not _is_dev and os.environ.get("DINA_TEST_MODE", "").lower() == "true":
    _is_dev = True


def create_brain_app(
    guardian: Any,
    sync_engine: Any,
    brain_token: str,
    scrubber: Any = None,
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
    scrubber:
        PII scrubber instance (Tier 2 NER).  Optional — if None,
        the ``/v1/pii/scrub`` endpoint returns text unchanged.

    Returns
    -------
    FastAPI
        A sub-app to be mounted at ``/api`` on the master app.
    """
    app = FastAPI(
        title="Dina Brain API",
        description="Internal API for dina-core to delegate processing and reasoning.",
        version="0.4.0",
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
        return response

    # ------------------------------------------------------------------
    # MED-07: Body size limit (1 MiB)
    # ------------------------------------------------------------------

    _MAX_BODY_BYTES = 1 * 1024 * 1024

    @app.middleware("http")
    async def limit_body_size(request: Request, call_next):
        if request.method in ("POST", "PUT", "PATCH"):
            # MEDIUM-07: Pre-check Content-Length to reject before any read
            cl = request.headers.get("content-length")
            if cl is not None:
                try:
                    if int(cl) > _MAX_BODY_BYTES:
                        from fastapi.responses import JSONResponse
                        return JSONResponse(
                            status_code=413,
                            content={"detail": "Request body too large"},
                        )
                except ValueError:
                    pass
            # Streaming read with early cutoff — protects against chunked
            # or missing Content-Length uploads that bypass the header check.
            # We cache the result on request._body so downstream handlers
            # (request.body(), request.json()) still work correctly.
            chunks: list[bytes] = []
            total = 0
            async for chunk in request.stream():
                total += len(chunk)
                if total > _MAX_BODY_BYTES:
                    from fastapi.responses import JSONResponse
                    return JSONResponse(
                        status_code=413,
                        content={"detail": "Request body too large"},
                    )
                chunks.append(chunk)
            request._body = b"".join(chunks)
        return await call_next(request)

    # ------------------------------------------------------------------
    # MED-14: Rate limiting on expensive endpoints
    # ------------------------------------------------------------------

    try:
        from ..infra.rate_limit import TokenBucketLimiter
    except ImportError:
        from infra.rate_limit import TokenBucketLimiter
    _reason_limiter = TokenBucketLimiter(rate=10/60, burst=5)

    @app.middleware("http")
    async def rate_limit_reasoning(request: Request, call_next):
        _path = request.scope.get("path", request.url.path)
        if _path in ("/v1/reason", "/v1/pii/scrub"):
            key = request.headers.get("authorization", request.client.host if request.client else "unknown")
            if not _reason_limiter.allow(key):
                from fastapi.responses import JSONResponse
                return JSONResponse(status_code=429, content={"detail": "Rate limit exceeded"})
        return await call_next(request)

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
    pii_route.set_scrubber(scrubber)

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
    app.include_router(
        pii_route.router,
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
            content={"detail": "Internal server error"},
        )

    return app
