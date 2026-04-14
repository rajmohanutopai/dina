"""Requester-side service query orchestrator.

Turns a user ask (e.g. "when does bus 42 arrive?") into a lifecycle:

    1. Search AppView for matching public services.
    2. Send a ``service.query`` D2D message to the best candidate.
    3. Track the pending query with a TTL.
    4. Handle the inbound ``service.response`` and notify the user.
    5. Expire unanswered queries after TTL.

No imports from adapter/ — uses CoreClient and AppViewClient via
constructor injection.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass
from typing import Any


@dataclass
class PendingQuery:
    """In-flight service query awaiting a response."""
    query_id: str
    service_did: str
    service_name: str
    sent_at: float
    ttl_seconds: int
    notified: bool = False


class ServiceQueryOrchestrator:
    """Turns a user ask into a public service query lifecycle."""

    def __init__(
        self,
        appview_client: Any,
        core_client: Any,
        notifier: Any,
    ) -> None:
        self._appview = appview_client
        self._core = core_client
        self._notify = notifier
        self._pending: dict[str, PendingQuery] = {}

    # ------------------------------------------------------------------
    # Requester side: user ask -> service.query
    # ------------------------------------------------------------------

    async def handle_user_query(
        self, capability: str, params: dict, user_text: str = "",
    ) -> None:
        """Send a service query to the best matching public service."""
        lat = params.get("location", {}).get("lat")
        lng = params.get("location", {}).get("lng")
        if lat is None or lng is None:
            await self._notify("Cannot search services without location.")
            return

        candidates = await self._appview.search_services(
            capability=capability, lat=lat, lng=lng,
            q=user_text or None,
        )
        if not candidates:
            await self._notify("No services found for this query.")
            return

        service = candidates[0]  # Phase 1: best ranked result
        query_id = str(uuid.uuid4())

        body = {
            "query_id": query_id,
            "capability": capability,
            "params": params,
            "ttl_seconds": 60,
        }

        try:
            await self._core.send_d2d(
                to_did=service["operatorDid"],
                payload=body,
                msg_type="service.query",
            )
        except Exception:
            await self._notify(
                f"Failed to send query to {service.get('name', 'service')}.",
            )
            return

        self._pending[query_id] = PendingQuery(
            query_id=query_id,
            service_did=service["operatorDid"],
            service_name=service.get("name", "Unknown Service"),
            sent_at=time.time(),
            ttl_seconds=60,
        )
        await self._notify(f"Asking {service.get('name', 'service')}...")

    # ------------------------------------------------------------------
    # Requester side: inbound service.response -> notify user
    # ------------------------------------------------------------------

    async def handle_service_response(
        self, from_did: str, body: dict,
    ) -> None:
        """Handle an inbound service.response -- notify the user."""
        query_id = body.get("query_id", "")
        pending = self._pending.pop(query_id, None)

        status = body.get("status", "")
        if status == "success":
            result = body.get("result", {})
            eta = result.get("eta_minutes")
            vehicle = result.get("vehicle_type", "")
            route = result.get("route_name", "")
            name = pending.service_name if pending else "Service"
            parts = []
            if route:
                parts.append(route)
            if vehicle:
                parts.append(vehicle)
            msg = " ".join(parts) or name
            if eta is not None:
                await self._notify(f"{msg} -- {eta} minutes away")
            else:
                await self._notify(f"{msg} -- response received")
        elif status == "unavailable":
            name = pending.service_name if pending else "Service"
            await self._notify(f"{name} -- service unavailable")
        else:
            name = pending.service_name if pending else "Service"
            error = body.get("result", {}).get("error", "unknown")
            await self._notify(f"{name} -- error: {error}")

    # ------------------------------------------------------------------
    # Timeout sweep (called periodically by guardian health loop)
    # ------------------------------------------------------------------

    async def check_timeouts(self) -> None:
        """Notify user for expired pending queries and remove them."""
        now = time.time()
        expired: list[PendingQuery] = []
        for qid, pq in list(self._pending.items()):
            if now - pq.sent_at > pq.ttl_seconds and not pq.notified:
                pq.notified = True
                expired.append(pq)
        for pq in expired:
            await self._notify(f"No response yet from {pq.service_name}.")
            self._pending.pop(pq.query_id, None)
