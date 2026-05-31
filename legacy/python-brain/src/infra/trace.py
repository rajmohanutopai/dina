"""In-memory request trace store for Brain.

Stores structured trace events keyed by request_id. Events auto-expire
after a retention period. Used by handlers and services to record the
request flow for debugging via ``dina-admin trace <req_id>``.

The store is a simple dict with TTL — not SQLite, since Brain doesn't
own persistent storage. Traces are ephemeral debugging aids.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field


@dataclass
class TraceEvent:
    ts_ms: int
    step: str
    component: str
    detail: dict


@dataclass
class _TraceEntry:
    events: list[TraceEvent] = field(default_factory=list)
    created_at: float = field(default_factory=time.time)


class TraceStore:
    """Thread-safe in-memory trace store with TTL-based expiry."""

    def __init__(self, max_entries: int = 500, ttl_seconds: int = 600) -> None:
        self._store: dict[str, _TraceEntry] = {}
        self._lock = threading.Lock()
        self._max_entries = max_entries
        self._ttl = ttl_seconds

    def emit(self, req_id: str, step: str, component: str, detail: dict | None = None) -> None:
        """Append a trace event for a request."""
        if not req_id:
            return
        event = TraceEvent(
            ts_ms=int(time.time() * 1000),
            step=step,
            component=component,
            detail=detail or {},
        )
        with self._lock:
            if req_id not in self._store:
                self._store[req_id] = _TraceEntry()
            self._store[req_id].events.append(event)
            # Evict oldest entries if over capacity.
            if len(self._store) > self._max_entries:
                oldest = min(self._store, key=lambda k: self._store[k].created_at)
                del self._store[oldest]

    def query(self, req_id: str) -> list[dict]:
        """Return all trace events for a request_id as dicts."""
        with self._lock:
            entry = self._store.get(req_id)
            if not entry:
                return []
            return [
                {
                    "ts_ms": e.ts_ms,
                    "step": e.step,
                    "component": e.component,
                    "detail": e.detail,
                }
                for e in entry.events
            ]

    def purge(self) -> int:
        """Remove expired entries. Returns count removed."""
        cutoff = time.time() - self._ttl
        removed = 0
        with self._lock:
            expired = [k for k, v in self._store.items() if v.created_at < cutoff]
            for k in expired:
                del self._store[k]
                removed += 1
        return removed


# Singleton — imported by services that need to emit traces.
trace_store = TraceStore()
