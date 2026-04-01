"""FastAPI sub-app for the brain API (/api/*).

Routes are authenticated via Ed25519 signed requests (X-DID / X-Timestamp /
X-Signature headers) from pinned service keys.

Module isolation: this module does NOT import from ``dina_admin``.

Maps to Brain TEST_PLAN SS10 (API Endpoints) and SS1 (Authentication).
"""

from __future__ import annotations
import logging
import os
from typing import Any, Callable, TYPE_CHECKING

from fastapi import Depends, FastAPI, HTTPException, Request

from .routes import pii as pii_route
from .routes import process as process_route
from .routes import proposals as proposals_route
from .routes import reason as reason_route
from .routes import trace as trace_route

if TYPE_CHECKING:
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

log = logging.getLogger(__name__)

# SEC-LOW-01: Disable docs/openapi in production
_env = os.environ.get("DINA_ENV", "production").lower()
_is_dev = _env in ("development", "test")
if not _is_dev and os.environ.get("DINA_TEST_MODE", "").lower() == "true":
    _is_dev = True


def create_brain_app(
    guardian: Any,
    sync_engine: Any,
    scrubber: Any = None,
    *,
    core_public_key: "Ed25519PublicKey | Callable[[], Ed25519PublicKey | None] | None" = None,
) -> FastAPI:
    """Create the brain API sub-app with Ed25519 signature verification.

    Parameters
    ----------
    guardian:
        GuardianLoop instance for event processing and reasoning.
    sync_engine:
        SyncEngine instance for ingestion pipeline access.
    scrubber:
        PII scrubber instance (Presidio structured PII patterns).
        Optional — if None, ``/v1/pii/scrub`` returns 503.
    core_public_key:
        Core's Ed25519 public key for verifying signed requests.
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
    # Request-ID propagation — cross-service audit correlation
    # ------------------------------------------------------------------

    @app.middleware("http")
    async def request_id_middleware(request: Request, call_next):
        try:
            from ..infra.logging import bind_request_id
        except ImportError:
            from infra.logging import bind_request_id
        incoming_rid = request.headers.get("X-Request-ID")
        rid = bind_request_id(incoming_rid)
        response = await call_next(request)
        response.headers["X-Request-ID"] = rid
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
        # BR5: /v1/process added — it drives the full guardian loop (LLM calls,
        # vault queries, nudge assembly) and is at least as expensive as /v1/reason.
        if _path in ("/v1/reason", "/v1/pii/scrub", "/v1/process"):
            key = request.headers.get("authorization", request.client.host if request.client else "unknown")
            if not _reason_limiter.allow(key):
                from fastapi.responses import JSONResponse
                return JSONResponse(status_code=429, content={"detail": "Rate limit exceeded"})
        return await call_next(request)

    # ------------------------------------------------------------------
    # Auth dependency — Ed25519 signature
    # ------------------------------------------------------------------

    async def verify_service_auth(request: Request) -> None:
        """Verify request authentication.

        Checks Ed25519 signature headers (X-DID, X-Timestamp, X-Signature).

        Raises
        ------
        HTTPException 401
            If authentication fails or no credentials provided.
        """
        # Path 1: Ed25519 signed request
        x_did = request.headers.get("x-did")
        x_ts = request.headers.get("x-timestamp")
        x_nonce = request.headers.get("x-nonce", "")
        x_sig = request.headers.get("x-signature")

        if x_did and x_ts and x_sig:
            # Resolve key — may be a lazy-loading callable or a static key.
            resolved_key = core_public_key() if callable(core_public_key) else core_public_key
            if resolved_key is None:
                # BR6: Generic message — don't reveal that the key is missing vs invalid.
                log.warning("brain_api.no_core_key: Core public key not loaded")
                raise HTTPException(status_code=401, detail="Authentication required")

            try:
                from ..adapter.signing import ServiceIdentity
            except ImportError:
                from adapter.signing import ServiceIdentity

            body = await request.body()
            ok = ServiceIdentity.verify_request(
                public_key=resolved_key,
                method=request.method,
                path=request.url.path,
                query=request.url.query or "",
                timestamp=x_ts,
                nonce=x_nonce,
                body=body,
                signature_hex=x_sig,
            )
            if not ok:
                log.warning("brain_api.signature_invalid: %s", x_did)
                raise HTTPException(status_code=401, detail="Invalid signature")
            return

        log.warning("brain_api.no_auth")
        raise HTTPException(status_code=401, detail="Authentication required")

    # ------------------------------------------------------------------
    # Inject dependencies into route modules
    # ------------------------------------------------------------------

    process_route.set_guardian(guardian)
    proposals_route.set_guardian(guardian)
    reason_route.set_dependencies(guardian, sync_engine)
    pii_route.set_scrubber(scrubber)

    # ------------------------------------------------------------------
    # Include routers — all routes require service auth
    # ------------------------------------------------------------------

    app.include_router(
        process_route.router,
        dependencies=[Depends(verify_service_auth)],
    )
    app.include_router(
        reason_route.router,
        dependencies=[Depends(verify_service_auth)],
    )
    app.include_router(
        pii_route.router,
        dependencies=[Depends(verify_service_auth)],
    )
    app.include_router(
        proposals_route.router,
        dependencies=[Depends(verify_service_auth)],
    )
    # Trace endpoint — no auth required (debugging tool, no sensitive data).
    app.include_router(trace_route.router)

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
