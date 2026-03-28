"""Trace query endpoint — GET /api/v1/trace/{req_id}.

Returns all trace events recorded by Brain for a given request_id.
Used by ``dina-admin trace`` alongside Core's trace endpoint to
provide a unified request timeline.
"""

from __future__ import annotations

from fastapi import APIRouter

from ...infra.trace import trace_store

router = APIRouter()


@router.get("/v1/trace/{req_id}")
async def get_trace(req_id: str) -> dict:
    events = trace_store.query(req_id)
    return {"req_id": req_id, "events": events}
