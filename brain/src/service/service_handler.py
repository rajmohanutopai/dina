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

from .capabilities.registry import CAPABILITY_REGISTRY, get_ttl

logger = logging.getLogger(__name__)


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
        self._notifier = None  # Set via set_notifier() for operator notifications

    async def handle_query(self, from_did: str, body: dict) -> None:
        """Process an inbound service.query and respond via D2D."""
        capability = body.get("capability", "")
        query_id = body.get("query_id", "")
        params_raw = body.get("params", {})
        inbound_ttl = body.get("ttl_seconds", 0)  # preserve original requester TTL

        # Check local capability registry (allowlist).
        cap_config = CAPABILITY_REGISTRY.get(capability)
        if not cap_config:
            await self._send_response(
                from_did, query_id, capability, "unavailable", {},
                ttl_seconds=inbound_ttl,
            )
            return

        # Check local service config for MCP routing and response policy.
        svc_cap = self._config.get("capabilities", {}).get(capability, {})
        response_policy = svc_cap.get("response_policy", "auto")
        mcp_server = svc_cap.get("mcp_server", "")
        mcp_tool = svc_cap.get("mcp_tool", "")

        # WS2: review policy → create approval task, don't auto-respond.
        if response_policy == "review":
            await self._create_approval_task(from_did, query_id, capability, params_raw, body)
            return

        if not mcp_server or not mcp_tool:
            await self._send_response(
                from_did, query_id, capability, "unavailable", {},
                ttl_seconds=inbound_ttl,
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
                ttl_seconds=inbound_ttl,
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
                ttl_seconds=inbound_ttl,
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
                ttl_seconds=inbound_ttl,
            )
            return

        await self._send_response(
            from_did, query_id, capability, "success", result.model_dump(),
            ttl_seconds=inbound_ttl,
        )

    async def _create_approval_task(
        self, from_did: str, query_id: str, capability: str, params: dict, body: dict,
    ) -> None:
        """WS2: create an approval workflow_task for manual review + notify operator."""
        import json as json_mod
        import time
        import uuid

        ttl = body.get("ttl_seconds", get_ttl(capability))
        task_payload = {
            "from_did": from_did,
            "query_id": query_id,
            "capability": capability,
            "params": params,
            "service_name": self._config.get("name", ""),
            "ttl_seconds": ttl,
        }
        task_id = f"approval-{uuid.uuid4()}"
        await self._core.create_workflow_task(
            task_id=task_id,
            description=f"Service review: {capability} from {from_did}",
            origin="d2d",
            kind="approval",
            payload=json_mod.dumps(task_payload),
            expires_at=int(time.time()) + ttl,
            correlation_id=query_id,
        )
        logger.info("service_handler: approval task created, task_id=%s capability=%s", task_id, capability)

        # Notify operator via Telegram (if available).
        if hasattr(self, "_notifier") and self._notifier:
            await self._notifier(
                f"Service query for review:\n"
                f"  Capability: {capability}\n"
                f"  From: {from_did}\n"
                f"  Approve: /service_approve {task_id}"
            )

    async def execute_and_respond(self, task_id: str, task_payload: dict) -> None:
        """Execute an approved service query and send the response via Core.

        WS2: called by Guardian when an approval workflow_event arrives.
        Uses POST /v1/service/respond which atomically claims the task,
        opens a fresh provider window, and sends the D2D response.
        """
        from_did = task_payload.get("from_did", "")
        query_id = task_payload.get("query_id", "")
        capability = task_payload.get("capability", "")
        params_raw = task_payload.get("params", {})

        if not from_did or not query_id or not capability:
            logger.error(
                "service_handler: execute_and_respond missing fields, task_id=%s payload=%s",
                task_id, task_payload,
            )
            raise ValueError(
                f"approval task {task_id} has incomplete payload: "
                f"from_did={bool(from_did)}, query_id={bool(query_id)}, capability={bool(capability)}"
            )

        # Execute the capability via MCP — same routing as handle_query().
        # Uses self._config for MCP server/tool routing (same as auto-respond).
        try:
            cap_config = CAPABILITY_REGISTRY.get(capability)
            if not cap_config:
                raise ValueError(f"unsupported capability: {capability}")

            svc_cap = self._config.get("capabilities", {}).get(capability, {})
            mcp_server = svc_cap.get("mcp_server", "")
            mcp_tool = svc_cap.get("mcp_tool", "")
            if not mcp_server or not mcp_tool:
                raise RuntimeError(f"MCP routing not configured for {capability}")
            if self._mcp is None:
                raise RuntimeError("MCP client not configured")

            params = cap_config["params_model"](**params_raw)
            result_raw = await self._mcp.call_tool(mcp_server, mcp_tool, params.model_dump())
            result = cap_config["result_model"](**result_raw)

            response_body = {
                "query_id": query_id,
                "capability": capability,
                "status": "success",
                "result": result.model_dump(),
            }
        except Exception as exc:
            logger.warning(
                "service_handler: execute_and_respond MCP failed, task_id=%s error=%s",
                task_id, exc,
            )
            response_body = {
                "query_id": query_id,
                "capability": capability,
                "status": "error",
                "result": {"error": str(exc)},
            }

        # Send via Core's /v1/service/respond (atomic claim + fresh window + send).
        # Handle 409 Conflict gracefully — another caller already claimed the task.
        try:
            result = await self._core.send_service_respond(task_id, response_body)
            if isinstance(result, dict) and result.get("already_processed"):
                logger.info(
                    "service_handler: task already processed, task_id=%s status=%s",
                    task_id, result.get("status", ""),
                )
                return  # Success — someone else handled it or crash-recovered. ACK.
        except Exception as exc:
            err_str = str(exc)
            # 409 = another caller claimed it. Check if task has run_id (response sent).
            if "409" in err_str or "already claimed" in err_str.lower():
                # Verify the task is actually making progress (has run_id marker).
                task = await self._core.get_workflow_task(task_id)
                if task and task.get("run_id"):
                    logger.info(
                        "service_handler: task claimed with response enqueued, task_id=%s",
                        task_id,
                    )
                    return  # ACK — response was already sent.
                # No run_id — another caller claimed but hasn't sent yet. Don't ACK.
                # Core will retry delivery, and the claim will either complete or expire.
                logger.warning(
                    "service_handler: task claimed but no progress marker, task_id=%s",
                    task_id,
                )
                raise  # Don't ACK — let Core retry after claim expires.
            raise  # Real error — don't ACK, let Core retry.

    async def _send_response(
        self,
        to_did: str,
        query_id: str,
        capability: str,
        status: str,
        result: dict,
        ttl_seconds: int = 0,
    ) -> None:
        """Send a service.response back to the requester."""
        body = {
            "query_id": query_id,
            "capability": capability,
            "status": status,
            "result": result,
            "ttl_seconds": ttl_seconds if ttl_seconds > 0 else get_ttl(capability),
        }
        await self._core.send_d2d(
            to_did=to_did, payload=body, msg_type="service.response",
        )
