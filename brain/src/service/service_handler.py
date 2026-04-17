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

from ..domain.errors import WorkflowConflictError
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

        # 1. Check schema_hash FIRST — reject stale or missing hashes.
        #    If the provider has a schema configured the requester MUST supply
        #    the matching hash. Silently letting unhashed requests through was
        #    a protocol bypass (callers could opt out of version checking).
        cap_schema = self._config.get("capability_schemas", {}).get(capability)
        local_hash = cap_schema.get("schema_hash", "") if cap_schema else ""
        if local_hash and local_hash != request_schema_hash:
            await self._send_response(
                from_did, query_id, capability, "error",
                {"error": "schema_version_mismatch"},
                ttl_seconds=inbound_ttl,
            )
            return

        # 2. Validate params against provider-published JSON Schema.
        #    Prevents malformed queries from reaching OpenClaw. Both the
        #    request (ValidationError) and a broken local schema
        #    (SchemaError) are treated as a failure of the contract and
        #    returned as an error — a malformed schema in config is the
        #    provider's bug, not a reason to let the query through.
        if cap_schema and cap_schema.get("params"):
            import jsonschema
            try:
                jsonschema.validate(params, cap_schema["params"])
            except jsonschema.ValidationError as e:
                logger.warning("service_handler: param validation failed for %s: %s", capability, e.message)
                await self._send_response(
                    from_did, query_id, capability, "error",
                    {"error": f"Invalid params: {e.message}"},
                    ttl_seconds=inbound_ttl,
                )
                return
            except jsonschema.SchemaError as e:
                logger.error("service_handler: local params schema is invalid for %s: %s", capability, e.message)
                await self._send_response(
                    from_did, query_id, capability, "error",
                    {"error": "provider_schema_invalid"},
                    ttl_seconds=inbound_ttl,
                )
                return

        # 3. Review policy → create approval task, notify operator.
        if response_policy == "review":
            await self._create_approval_task(
                from_did, query_id, capability, params, body, request_schema_hash,
                schema_snapshot=cap_schema,
            )
            return

        # 4. Auto policy → create delegation task for OpenClaw.
        #    Dina never executes directly.
        await self._create_execution_task(
            from_did, query_id, capability, params, inbound_ttl,
            schema_hash=request_schema_hash,
            schema_snapshot=cap_schema,
        )

    async def _create_execution_task(
        self,
        from_did: str,
        query_id: str,
        capability: str,
        params: dict,
        ttl_seconds: int,
        *,
        schema_hash: str = "",
        schema_snapshot: dict | None = None,
        task_id: str | None = None,
    ) -> str:
        """Create a delegation task for OpenClaw to execute. Returns task_id.

        Persists both the schema_hash AND the schema snapshot (params +
        result JSON Schemas agreed on at query time). The completion bridge
        validates the result against the snapshot, not whatever the provider
        config says at completion time — so an in-flight schema update
        can't violate the contract the requester thought it had.
        """
        tid = task_id or f"svc-exec-{uuid.uuid4()}"
        task_payload = {
            "type": "service_query_execution",
            "from_did": from_did,
            "query_id": query_id,
            "capability": capability,
            "params": params,
            "ttl_seconds": ttl_seconds,
            "service_name": self._config.get("name", ""),
            "schema_hash": schema_hash,
            "schema_snapshot": schema_snapshot or {},
        }
        # Description is human-readable metadata that surfaces in task lists
        # and logs — keep it abstract. Params live in the structured payload
        # so sensitive values (coordinates, ids, search text) aren't duplicated
        # into plain-text surfaces.
        await self._core.create_workflow_task(
            task_id=tid,
            description=f"Execute service query: {capability}",
            origin="d2d",
            kind="delegation",
            payload=json_mod.dumps(task_payload),
            payload_type="service_query_execution",
            expires_at=int(time.time()) + ttl_seconds,
            correlation_id=query_id,
        )
        logger.info(
            "service_handler: execution task created, task_id=%s capability=%s",
            tid, capability,
        )
        return tid

    async def _create_approval_task(
        self,
        from_did: str,
        query_id: str,
        capability: str,
        params: dict,
        body: dict,
        schema_hash: str = "",
        *,
        schema_snapshot: dict | None = None,
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
            "schema_hash": schema_hash,
            "schema_snapshot": schema_snapshot or {},
        }
        task_id = f"approval-{uuid.uuid4()}"
        await self._core.create_workflow_task(
            task_id=task_id,
            description=f"Service review: {capability} from {from_did}",
            origin="d2d",
            kind="approval",
            payload=json_mod.dumps(task_payload),
            payload_type="service_query_execution",
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
        """Trigger OpenClaw execution for an approved service query.

        Called by Guardian when a `workflow.approved` event fires on an
        approval task. Under the "Dina never executes" rule, approval does
        NOT produce a response directly — it creates a delegation task so
        OpenClaw claims it, executes, and the completion bridge emits the
        D2D service.response. Same downstream path as the auto-policy flow.

        Idempotent: the execution task's ID is derived from the approval
        task ID, so reconciliation retries don't spawn duplicates.
        """
        from_did = task_payload.get("from_did", "")
        query_id = task_payload.get("query_id", "")
        capability = task_payload.get("capability", "")
        params = task_payload.get("params", {}) or {}
        ttl_seconds = task_payload.get("ttl_seconds", 0) or get_ttl(capability)
        schema_hash = task_payload.get("schema_hash", "")
        schema_snapshot = task_payload.get("schema_snapshot") or {}

        if not from_did or not query_id or not capability:
            logger.error(
                "service_handler: execute_and_respond missing fields, task_id=%s",
                task_id,
            )
            raise ValueError(f"approval task {task_id} has incomplete payload")

        # Deterministic execution task ID → create is idempotent across retries.
        # WorkflowConflictError (HTTP 409) means the execution task already
        # exists from a previous attempt — keep going so the approval task
        # still gets cancelled.
        exec_task_id = f"svc-exec-from-{task_id}"
        try:
            await self._create_execution_task(
                from_did=from_did,
                query_id=query_id,
                capability=capability,
                params=params,
                ttl_seconds=ttl_seconds,
                schema_hash=schema_hash,
                schema_snapshot=schema_snapshot,
                task_id=exec_task_id,
            )
        except WorkflowConflictError:
            logger.info(
                "service_handler: execution task already exists, task_id=%s",
                exec_task_id,
            )

        # Close out the approval task so reconciliation doesn't re-process it.
        # WFQueued → WFCancelled is a valid terminal transition; 409 means
        # the approval task was already cancelled/terminated — safe to ignore.
        try:
            await self._core.cancel_workflow_task(task_id)
        except WorkflowConflictError:
            logger.info(
                "service_handler: approval task already terminal, task_id=%s",
                task_id,
            )

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
