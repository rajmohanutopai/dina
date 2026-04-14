"""Provider-side handler for inbound service.query messages.

When another Dina sends a ``service.query`` (e.g. "what is bus 42's
ETA?"), this handler:

    1. Checks the local capability registry (allowlist).
    2. Validates the query params against the capability's Pydantic model.
    3. Routes the query to the appropriate MCP tool.
    4. Validates the tool result against the capability's result model.
    5. Sends a ``service.response`` back to the requester via Core D2D.

No imports from adapter/ -- uses CoreClient and MCPClient via
constructor injection.
"""

from __future__ import annotations

import logging
from typing import Any

from .capabilities.eta_query import EtaQueryParams, EtaQueryResult

logger = logging.getLogger(__name__)

# Per-capability allowlist: maps capability name to validation models.
# MCP routing (server + tool) comes from the local service config
# stored in Core, not hard-coded here.
CAPABILITY_REGISTRY: dict[str, dict] = {
    "eta_query": {
        "params_model": EtaQueryParams,
        "result_model": EtaQueryResult,
    },
}


class ServiceHandler:
    """Handles inbound service.query messages on the provider side."""

    def __init__(
        self,
        core_client: Any,
        mcp_client: Any,
        service_config: dict | None = None,
    ) -> None:
        self._core = core_client
        self._mcp = mcp_client
        self._config = service_config or {}

    async def handle_query(self, from_did: str, body: dict) -> None:
        """Process an inbound service.query and respond via D2D."""
        capability = body.get("capability", "")
        query_id = body.get("query_id", "")
        params_raw = body.get("params", {})

        # Check local capability registry (allowlist).
        cap_config = CAPABILITY_REGISTRY.get(capability)
        if not cap_config:
            await self._send_response(
                from_did, query_id, capability, "unavailable", {},
            )
            return

        # Check local service config for MCP routing.
        svc_cap = self._config.get("capabilities", {}).get(capability, {})
        mcp_server = svc_cap.get("mcp_server", "")
        mcp_tool = svc_cap.get("mcp_tool", "")
        if not mcp_server or not mcp_tool:
            await self._send_response(
                from_did, query_id, capability, "unavailable", {},
            )
            return

        # Validate params.
        try:
            params = cap_config["params_model"](**params_raw)
        except Exception as e:
            logger.warning(
                "service_handler: invalid params for %s: %s", capability, e,
            )
            await self._send_response(
                from_did, query_id, capability, "error",
                {"error": "invalid query parameters"},
            )
            return

        # Call MCP tool.
        try:
            result_raw = await self._mcp.call_tool(
                mcp_server, mcp_tool, params.model_dump(),
            )
        except Exception as e:
            logger.warning(
                "service_handler: MCP call failed for %s: %s", capability, e,
            )
            await self._send_response(
                from_did, query_id, capability, "error",
                {"error": "service temporarily unavailable"},
            )
            return

        # Validate result.
        try:
            result = cap_config["result_model"](**result_raw)
        except Exception as e:
            logger.warning(
                "service_handler: invalid result from %s: %s", capability, e,
            )
            await self._send_response(
                from_did, query_id, capability, "error",
                {"error": "invalid tool result"},
            )
            return

        await self._send_response(
            from_did, query_id, capability, "success", result.model_dump(),
        )

    async def _send_response(
        self,
        to_did: str,
        query_id: str,
        capability: str,
        status: str,
        result: dict,
    ) -> None:
        """Send a service.response back to the requester."""
        body = {
            "query_id": query_id,
            "capability": capability,
            "status": status,
            "result": result,
            "ttl_seconds": 60,
        }
        await self._core.send_d2d(
            to_did=to_did, payload=body, msg_type="service.response",
        )
