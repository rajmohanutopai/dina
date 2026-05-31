"""Convenience wrapper for emitting trace events.

Reads the current request_id from structlog contextvars so callers
don't need to pass it explicitly. Usage:

    from ..infra.trace_emit import trace
    trace("trust_search.request", "brain", {"query": "chair"})
"""

from __future__ import annotations

import structlog

from .trace import trace_store


def trace(step: str, component: str = "brain", detail: dict | None = None) -> None:
    """Emit a trace event using the current structlog request_id."""
    ctx = structlog.contextvars.get_contextvars()
    req_id = ctx.get("request_id", "")
    if req_id:
        trace_store.emit(req_id, step, component, detail)
