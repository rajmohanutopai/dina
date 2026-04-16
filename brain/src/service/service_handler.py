"""Provider-side handler for inbound service.query messages.

Revised architecture (WS2 transit demo):

    1. Check schema_hash — reject stale-schema requests.
    2. Validate params against provider-published JSON Schema.
    3. Create a delegation task for OpenClaw to execute.
    4. (OpenClaw executes, completes task, Core bridges result to D2D response.)

Dina never executes directly. The local execution plane (OpenClaw) does.
ServiceHandler only validates and delegates.

For review policy: create an approval task instead, notify operator.

No imports from adapter/ — uses CoreClient via constructor injection.
"""

from __future__ import annotations

import json as json_mod
import logging
import time
import uuid
from typing import Any

from .capabilities.registry import get_ttl

logger = logging.getLogger(__name__)


class ServiceHandler:
    """Handles inbound service.query messages on the provider side.

    Validates against provider-published JSON Schema, then delegates
    to OpenClaw via workflow task. Never calls MCP tools directly.
    """

    def __init__(
        self,
        core_client: Any,
        mcp_client: Any = None,  # kept for backward compat, not used in service path
        service_config: dict | None = None,
    ) -> None:
        self._core = core_client
        self._mcp = mcp_client  # only used by execute_and_respond (legacy/approval)
        self._config = service_config or {}
        self._notifier = None  # Set externally for operator notifications

    async def handle_query(self, from_did: str, body: dict) -> None:
        """Process an inbound service.query: validate → delegate to OpenClaw."""
        capability = body.get("capability", "")
        query_id = body.get("query_id", "")
        params = body.get("params", {})
        inbound_ttl = body.get("ttl_seconds", 0) or get_ttl(capability)
        request_schema_hash = body.get("schema_hash", "")

        # Check if this capability is configured locally.
        svc_cap = self._config.get("capabilities", {}).get(capability)
        if not svc_cap:
            await self._send_response(
                from_did, query_id, capability, "unavailable", {},
                ttl_seconds=inbound_ttl,
            )
            return

        response_policy = svc_cap.get("response_policy", "auto")

        # 1. Check schema_hash FIRST — reject stale-schema requests.
        cap_schema = self._config.get("capability_schemas", {}).get(capability)
        if cap_schema and request_schema_hash:
            local_hash = cap_schema.get("schema_hash", "")
            if local_hash and local_hash != request_schema_hash:
                await self._send_response(
                    from_did, query_id, capability, "error",
                    {"error": "schema_version_mismatch"},
                    ttl_seconds=inbound_ttl,
                )
                return

        # 2. Validate params against provider-published JSON Schema.
        #    Prevents malformed queries from reaching OpenClaw.
        if cap_schema and cap_schema.get("params"):
            try:
                import jsonschema
                jsonschema.validate(params, cap_schema["params"])
            except ImportError:
                pass  # jsonschema not installed — skip validation
            except Exception as e:
                logger.warning("service_handler: param validation failed for %s: %s", capability, e)
                await self._send_response(
                    from_did, query_id, capability, "error",
                    {"error": f"Invalid params: {e}"},
                    ttl_seconds=inbound_ttl,
                )
                return

        # 3. Review policy → create approval task, notify operator.
        if response_policy == "review":
            await self._create_approval_task(from_did, query_id, capability, params, body)
            return

        # 4. Auto policy → create delegation task for OpenClaw.
        #    Dina never executes directly.
        await self._create_execution_task(from_did, query_id, capability, params, inbound_ttl)

    async def _create_execution_task(
        self, from_did: str, query_id: str, capability: str, params: dict, ttl_seconds: int,
    ) -> None:
        """Create a delegation task for OpenClaw to execute."""
        task_id = f"svc-exec-{uuid.uuid4()}"
        task_payload = {
            "type": "service_query_execution",
            "from_did": from_did,
            "query_id": query_id,
            "capability": capability,
            "params": params,
            "ttl_seconds": ttl_seconds,
            "service_name": self._config.get("name", ""),
        }
        await self._core.create_workflow_task(
            task_id=task_id,
            description=(
                f"Execute service query: {capability}\n"
                f"Params: {json_mod.dumps(params)}\n"
                f"Use the appropriate tool to compute the result and return structured JSON."
            ),
            origin="d2d",
            kind="delegation",
            payload=json_mod.dumps(task_payload),
            expires_at=int(time.time()) + ttl_seconds,
            correlation_id=query_id,
        )
        logger.info(
            "service_handler: execution task created, task_id=%s capability=%s",
            task_id, capability,
        )

    async def _create_approval_task(
        self, from_did: str, query_id: str, capability: str, params: dict, body: dict,
    ) -> None:
        """Create an approval workflow_task for manual review + notify operator."""
        ttl = body.get("ttl_seconds", get_ttl(capability))
        task_payload = {
            "type": "service_query_execution",
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
        logger.info(
            "service_handler: approval task created, task_id=%s capability=%s",
            task_id, capability,
        )

        # Notify operator via Telegram (if available).
        if self._notifier:
            try:
                await self._notifier(
                    f"Service query for review:\n"
                    f"  Capability: {capability}\n"
                    f"  From: {from_did}\n"
                    f"  Approve: /service_approve {task_id}"
                )
            except Exception:
                pass  # best-effort

    async def execute_and_respond(self, task_id: str, task_payload: dict) -> None:
        """Execute an approved service query and send the response via Core.

        Called by Guardian when an approval workflow_event arrives.
        Uses POST /v1/service/respond which atomically claims the task,
        opens a fresh provider window, and sends the D2D response.
        """
        from_did = task_payload.get("from_did", "")
        query_id = task_payload.get("query_id", "")
        capability = task_payload.get("capability", "")

        if not from_did or not query_id or not capability:
            logger.error(
                "service_handler: execute_and_respond missing fields, task_id=%s",
                task_id,
            )
            raise ValueError(f"approval task {task_id} has incomplete payload")

        # For approval tasks, the result comes from OpenClaw via /task completion.
        # This method is called when the approval event fires — at that point,
        # the task transitions queued → claimed → executed by OpenClaw.
        # We just need to trigger the /v1/service/respond bridge.
        try:
            result = await self._core.send_service_respond(task_id, {
                "query_id": query_id,
                "capability": capability,
                "status": "success",
                "result": {},
            })
            if isinstance(result, dict) and result.get("already_processed"):
                logger.info(
                    "service_handler: task already processed, task_id=%s", task_id,
                )
                return
        except Exception as exc:
            err_str = str(exc)
            if "409" in err_str or "already claimed" in err_str.lower():
                task = await self._core.get_workflow_task(task_id)
                if task and task.get("run_id"):
                    return  # Response already sent
                raise  # Let Core retry
            raise

    async def _send_response(
        self,
        to_did: str,
        query_id: str,
        capability: str,
        status: str,
        result: dict,
        ttl_seconds: int = 0,
    ) -> None:
        """Send a service.response back to the requester (error/unavailable cases)."""
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
