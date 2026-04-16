"""Requester-side service query — WS2 simplified.

WS2 replaces Phase 1's in-memory tracking with durable workflow tasks.
This module now provides:
1. format_service_query_result() — formats workflow events into user notifications
2. ServiceQueryOrchestrator — routes queries through POST /v1/service/query

Removed from Phase 1:
- PendingQuery dataclass (workflow_task tracks state)
- _pending dict (Core owns lifecycle)
- handle_service_response() (workflow event delivery replaces DIDComm routing)
- check_timeouts() (Core sweeper handles expiry)

No imports from adapter/ — uses CoreClient via constructor injection.
"""

from __future__ import annotations

import json
import uuid
from typing import Any

from .capabilities.registry import get_ttl


# ---------------------------------------------------------------------------
# Rich formatters for workflow event → user notification
# ---------------------------------------------------------------------------

def format_service_query_result(details: dict) -> str:
    """Format a workflow event's details into a user notification.

    Called by Guardian._handle_service_query_result() when a service_query
    workflow_event is delivered. The details come from Core's
    CompleteWithDetails (success) or ExpireTasks (timeout).

    Response_status vocabulary:
    - success: provider responded with data
    - unavailable: provider explicitly declined
    - error: provider returned an error (details["error"] has text)
    - expired: Core-generated timeout (no response within TTL)
    """
    status = details.get("response_status", "")
    capability = details.get("capability", "")
    service_name = details.get("service_name", "Service")

    if status == "expired":
        return f"No response from {service_name}."
    if status == "success":
        formatter = _FORMATTERS.get(capability, _format_generic)
        return formatter(details, service_name)
    if status == "unavailable":
        return f"{service_name} — service unavailable."
    if status == "error":
        error_text = details.get("error", "unknown")
        return f"{service_name} — error: {error_text}"
    return f"{service_name} — unexpected status: {status}"


def _format_eta(details: dict, name: str) -> str:
    """Format an eta_query response with map URL.

    Produces plain-text output with a plain URL (not Markdown link).
    Telegram auto-linkifies URLs — no parse_mode needed.
    """
    result = details.get("result", {})
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except (json.JSONDecodeError, TypeError):
            result = {}

    status = result.get("status", "on_route")

    if status == "not_on_route":
        msg = result.get("message", "")
        return msg or f"{name} doesn't serve your area."
    if status == "out_of_service":
        msg = result.get("message", "")
        return msg or f"{name} is not running at this time."
    if status == "not_found":
        msg = result.get("message", "")
        return msg or f"{name} — route not found."

    eta = result.get("eta_minutes")
    stop_name = result.get("stop_name", "")
    vehicle = result.get("vehicle_type", "Bus")
    route = result.get("route_name", "")
    map_url = result.get("map_url", "")

    lines = []
    route_label = f"{vehicle} {route}" if route else name
    lines.append(f"{route_label}")
    if eta is not None and stop_name:
        lines.append(f"{eta} min to {stop_name}")
    elif eta is not None:
        lines.append(f"{eta} minutes away")
    if map_url:
        lines.append(map_url)

    return "\n".join(lines)


def _format_generic(details: dict, name: str) -> str:
    """Generic formatter for capabilities without a specific formatter."""
    result = details.get("result", {})
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except (json.JSONDecodeError, TypeError):
            pass
    return f"{name} — response received: {json.dumps(result)[:200]}"


_FORMATTERS: dict[str, Any] = {
    "eta_query": _format_eta,
}


# ---------------------------------------------------------------------------
# ServiceQueryOrchestrator — WS2: routes through Core POST /v1/service/query
# ---------------------------------------------------------------------------


class ServiceQueryOrchestrator:
    """Turns a user ask into a public service query via Core endpoint.

    WS2: no in-memory tracking. Core creates a durable workflow_task,
    sends D2D, and tracks the response. Brain receives the result as a
    workflow_event (formatted by format_service_query_result above).
    """

    def __init__(
        self,
        appview_client: Any,
        core_client: Any,
        notifier: Any,
    ) -> None:
        self._appview = appview_client
        self._core = core_client
        self._notify = notifier

    async def handle_user_query(
        self, capability: str, params: dict, user_text: str = "",
    ) -> None:
        """Send a service query through Core's POST /v1/service/query."""
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

        service = candidates[0]
        query_id = str(uuid.uuid4())
        ttl_seconds = get_ttl(capability)

        try:
            # WS2: route through Core endpoint (creates workflow_task + sends D2D).
            await self._core.send_service_query(
                to_did=service["operatorDid"],
                capability=capability,
                params=params,
                query_id=query_id,
                ttl_seconds=ttl_seconds,
                service_name=service.get("name", "Unknown Service"),
            )
        except Exception:
            await self._notify(
                f"Failed to send query to {service.get('name', 'service')}.",
            )
            return

        await self._notify(f"Asking {service.get('name', 'service')}...")
