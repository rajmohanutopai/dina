"""HTTP adapter for dina-core — implements CoreClient protocol.

All vault, KV, PII, notification, task-ACK, identity, and D2D
messaging operations are mapped to core's REST endpoints at
``{base_url}`` (default ``http://core:8100``).

Endpoint mapping (must match core/cmd/dina-core/main.go routes):
    /v1/vault/query          POST   search vault items
    /v1/vault/store          POST   store single item
    /v1/vault/store/batch    POST   store batch of items
    /v1/vault/item/{id}      GET    get item by ID
    /v1/vault/kv/{key}       GET/PUT  key-value store
    /v1/did/sign             POST   Ed25519 signing
    /v1/msg/send             POST   D2D outbound message
    /v1/notify               POST   push notification
    /v1/task/ack             POST   task queue ACK
    /v1/pii/scrub            POST   Tier 1 PII regex
    /v1/reminder             POST   store a reminder
    /v1/reminders/pending    GET    list unfired reminders
    /v1/reminder/fire        POST   simulate firing (test-only)
    /healthz                 GET    liveness probe

Scratchpad is implemented over the KV store (scratchpad:{task_id}).

Third-party imports:  httpx, structlog.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import re
from typing import Any, TYPE_CHECKING
from urllib.parse import urlparse

import httpx
import structlog

from ..gen.core_types import (
    VaultItem,
    Contact,
    PairedDevice,
    StagingItem,
    Reminder,
    ApprovalRequest,
    ScrubResult,
    ImportResult,
    VaultQueryResponse,
    VaultStoreResponse,
    ContactListResponse,
    DeviceListResponse,
    PersonaListResponse,
    CompletePairingResponse,
    InitiatePairingResponse,
    SignResponse,
    ReminderListResponse,
    StagingClaimResponse,
)
from ..domain.errors import (
    ApprovalRequiredError,
    AuthorizationError,
    ConfigError,
    CoreUnreachableError,
    PersonaLockedError,
    WorkflowConflictError,
)

if TYPE_CHECKING:
    from .signing import ServiceIdentity

logger = structlog.get_logger(__name__)


def _normalize_path(path: str) -> str:
    """Replace dynamic path segments with placeholders for logging.

    Handles nested sub-resource paths like:
        /v1/vault/item/{id}  -> /v1/vault/item/{id}
        /v1/vault/kv/{key}   -> /v1/vault/kv/{id}
        /v1/contacts/{did}   -> /v1/contacts/{id}
        /v1/devices/{id}     -> /v1/devices/{id}
    """
    # First strip query string
    normalized = path.split("?")[0]
    # Handle nested sub-resource paths: /v1/vault/item/{id}, /v1/vault/kv/{key}
    normalized = re.sub(
        r'/v1/(vault|pair)/(item|kv|store|query)/[^/?]+',
        r'/v1/\1/\2/{id}',
        normalized,
    )
    # Handle top-level resource paths: /v1/contacts/{did}, /v1/devices/{id}
    normalized = re.sub(
        r'/v1/(contacts|personas|devices|msg|task|export|import)/[^/?]+',
        r'/v1/\1/{id}',
        normalized,
    )
    return normalized


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_TIMEOUT_S = 30.0
_MAX_RETRIES = 3
_BACKOFF_BASE_S = 1.0  # 1s, 2s, 4s


class CoreHTTPClient:
    """Implements CoreClient protocol via HTTP calls to core.

    Features:
    - Ed25519 signed requests (X-DID/X-Timestamp/X-Signature) via ServiceIdentity.
    - Falls back to ``Authorization: Bearer`` if service_identity is None.
    - 30-second timeout per request.
    - Retry with exponential backoff (1 s, 2 s, 4 s) for 5xx and
      connection errors.
    - No retry for HTTP 401 (fatal config error).
    - Raises ``PersonaLockedError`` for HTTP 403 with persona-locked body.
    - Raises ``AuthorizationError`` for other HTTP 403 responses.
    - Raises ``CoreUnreachableError`` for connection failures after retries.
    - Lazy ``httpx.AsyncClient`` creation.
    - Async context-manager support (``__aenter__`` / ``__aexit__``).
    """

    def __init__(
        self,
        base_url: str,
        bearer_token: str | None = None,
        *,
        service_identity: ServiceIdentity | None = None,
    ) -> None:
        if not base_url:
            raise ConfigError("CORE_URL must not be empty")
        if service_identity is None and not bearer_token:
            raise ConfigError("Either service_identity or bearer_token must be provided")
        self._base_url = base_url.rstrip("/")
        self._token = bearer_token
        self._identity = service_identity
        self._client: httpx.AsyncClient | None = None

    # -- Lifecycle -----------------------------------------------------------

    def _ensure_client(self) -> httpx.AsyncClient:
        """Lazily create the underlying httpx client."""
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                base_url=self._base_url,
                timeout=httpx.Timeout(_TIMEOUT_S),
            )
        return self._client

    async def __aenter__(self) -> CoreHTTPClient:
        self._ensure_client()
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: Any,
    ) -> None:
        await self.close()

    async def close(self) -> None:
        """Close the underlying HTTP client."""
        if self._client is not None and not self._client.is_closed:
            await self._client.aclose()
            self._client = None

    # -- Auth helpers --------------------------------------------------------

    def _sign_headers(
        self, method: str, path: str, body: bytes | None,
    ) -> dict[str, str]:
        """Build auth headers for a request.

        If service_identity is available, signs with Ed25519.
        Otherwise falls back to bearer token.
        """
        if self._identity is not None:
            parsed = urlparse(path)
            did, ts, nonce, sig = self._identity.sign_request(
                method=method,
                path=parsed.path,
                body=body,
                query=parsed.query,
            )
            return {"X-DID": did, "X-Timestamp": ts, "X-Nonce": nonce, "X-Signature": sig}
        if self._token:
            return {"Authorization": f"Bearer {self._token}"}
        return {}

    # -- Internal request helper ---------------------------------------------

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        content: bytes | None = None,
        headers: dict[str, str] | None = None,
    ) -> httpx.Response:
        """Issue an HTTP request with retry and error classification."""
        client = self._ensure_client()
        last_exc: BaseException | None = None

        # Serialize body once for both signing and sending.
        body_bytes: bytes | None = content
        if json is not None and body_bytes is None:
            import json as json_mod
            body_bytes = json_mod.dumps(json).encode("utf-8")

        # Build auth headers.
        auth_headers = self._sign_headers(method, path, body_bytes)
        merged_headers = {**auth_headers, **(headers or {})}
        if json is not None:
            merged_headers.setdefault("Content-Type", "application/json")

        # Cross-service request-ID propagation for audit correlation.
        try:
            import structlog.contextvars
            ctx = structlog.contextvars.get_contextvars()
            if rid := ctx.get("request_id"):
                merged_headers.setdefault("X-Request-ID", rid)
        except Exception:
            pass  # best-effort — don't fail requests over tracing

        for attempt in range(_MAX_RETRIES):
            try:
                resp = await client.request(
                    method,
                    path,
                    content=body_bytes,
                    headers=merged_headers,
                )

                # --- Non-retryable status codes ---
                if resp.status_code == 401:
                    raise ConfigError(
                        f"Core returned HTTP 401 — service authentication failed "
                        f"(path={_normalize_path(path)})"
                    )
                if resp.status_code == 403:
                    body = {}
                    try:
                        body = resp.json()
                    except Exception:
                        pass
                    error_code = body.get("error", "")
                    if error_code == "persona_locked" or "locked" in str(body).lower():
                        raise PersonaLockedError(
                            f"Persona locked (path={_normalize_path(path)})"
                        )
                    if error_code == "approval_required":
                        raise ApprovalRequiredError(
                            persona=body.get("persona", ""),
                            approval_id=body.get("approval_id", ""),
                            message=body.get("message", ""),
                        )
                    raise AuthorizationError(
                        f"Core denied access (path={_normalize_path(path)}, error={error_code or 'forbidden'})"
                    )

                # --- Core locked (waiting for passphrase) ---
                if resp.status_code == 503:
                    try:
                        body = resp.json()
                    except Exception:
                        body = {}
                    if body.get("error") == "core_locked":
                        raise CoreUnreachableError(
                            body.get("message", "Core is locked — waiting for passphrase. Run: ./run.sh --start")
                        )

                # --- Retryable server errors ---
                if resp.status_code >= 500:
                    msg = (
                        f"Core returned HTTP {resp.status_code} "
                        f"(path={_normalize_path(path)}, attempt={attempt + 1}/{_MAX_RETRIES})"
                    )
                    logger.warning("core_server_error", msg=msg)
                    last_exc = CoreUnreachableError(msg)
                    if attempt < _MAX_RETRIES - 1:
                        await asyncio.sleep(_BACKOFF_BASE_S * (2**attempt))
                        continue
                    raise last_exc

                # --- Success ---
                resp.raise_for_status()
                return resp

            except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
                msg = (
                    f"Core unreachable (path={_normalize_path(path)}, "
                    f"attempt={attempt + 1}/{_MAX_RETRIES}): {exc}"
                )
                logger.warning("core_connect_error", msg=msg)
                last_exc = CoreUnreachableError(msg)
                if attempt < _MAX_RETRIES - 1:
                    await asyncio.sleep(_BACKOFF_BASE_S * (2**attempt))
                    continue
                raise CoreUnreachableError(
                    f"Core unreachable after {_MAX_RETRIES} retries (path={_normalize_path(path)})"
                ) from exc

            except httpx.TimeoutException as exc:
                msg = (
                    f"Core request timed out after {_TIMEOUT_S}s "
                    f"(path={_normalize_path(path)}, attempt={attempt + 1}/{_MAX_RETRIES})"
                )
                logger.warning("core_timeout", msg=msg)
                last_exc = exc
                if attempt < _MAX_RETRIES - 1:
                    await asyncio.sleep(_BACKOFF_BASE_S * (2**attempt))
                    continue
                raise asyncio.TimeoutError(msg) from exc

        # Should never reach here, but satisfy the type checker.
        raise CoreUnreachableError(  # pragma: no cover
            f"Core unreachable after {_MAX_RETRIES} retries (path={_normalize_path(path)})"
        )

    # -- Vault CRUD ----------------------------------------------------------

    async def get_vault_item(
        self, persona_id: str, item_id: str, *, user_origin: str = "",
    ) -> VaultItem:
        """GET /v1/vault/item/{item_id}?persona={persona_id}."""
        qs = f"persona={persona_id}"
        if user_origin:
            qs += f"&user_origin={user_origin}"
        resp = await self._request("GET", f"/v1/vault/item/{item_id}?{qs}")
        return VaultItem.model_validate(resp.json())

    async def store_vault_item(
        self, persona_id: str, item: dict, *, user_origin: str = "",
    ) -> str:
        """POST /v1/vault/store — returns assigned item_id."""
        body: dict[str, Any] = {"persona": persona_id, "item": item}
        if user_origin:
            body["user_origin"] = user_origin
        resp = await self._request("POST", "/v1/vault/store", json=body)
        data = resp.json()
        return data.get("id", "")

    async def store_vault_batch(
        self, persona_id: str, items: list[dict], *, user_origin: str = "",
    ) -> None:
        """POST /v1/vault/store/batch — atomic batch store."""
        body: dict[str, Any] = {"persona": persona_id, "items": items}
        if user_origin:
            body["user_origin"] = user_origin
        await self._request("POST", "/v1/vault/store/batch", json=body)

    async def enrich_item(
        self, item_id: str, *, persona: str = "general",
        content_l0: str = "", content_l1: str = "",
        embedding: list[float] | None = None,
        enrichment_status: str = "", enrichment_version: str = "",
    ) -> dict:
        """PATCH /v1/vault/item/{id}/enrich — update enrichment fields only."""
        body: dict[str, Any] = {}
        if content_l0:
            body["content_l0"] = content_l0
        if content_l1:
            body["content_l1"] = content_l1
        if embedding:
            body["embedding"] = embedding
        if enrichment_status:
            body["enrichment_status"] = enrichment_status
        if enrichment_version:
            body["enrichment_version"] = enrichment_version
        resp = await self._request(
            "PATCH",
            f"/v1/vault/item/{item_id}/enrich?persona={persona}",
            json=body,
        )
        return resp.json()

    # -- Staging pipeline -------------------------------------------------

    async def staging_ingest(self, item: dict) -> str:
        """POST /v1/staging/ingest — push raw item to staging inbox."""
        resp = await self._request("POST", "/v1/staging/ingest", json=item)
        return resp.json().get("id", "")

    async def staging_claim(self, limit: int = 10) -> list[StagingItem]:
        """POST /v1/staging/claim — claim pending items for classification."""
        resp = await self._request("POST", "/v1/staging/claim", json={"limit": limit})
        data = resp.json()
        return [StagingItem.model_validate(i) for i in data.get("items", [])]

    async def staging_resolve(
        self, staging_id: str, target_persona: str, classified_item: dict,
        session: str = "", agent_did: str = "", user_origin: str = "",
    ) -> dict:
        """POST /v1/staging/resolve — Brain sends classification, Core decides."""
        extra_headers = {}
        if session:
            extra_headers["X-Session"] = session
        if agent_did:
            extra_headers["X-Agent-DID"] = agent_did
        body: dict = {
            "id": staging_id,
            "target_persona": target_persona,
            "classified_item": classified_item,
        }
        if user_origin:
            body["user_origin"] = user_origin
        resp = await self._request("POST", "/v1/staging/resolve", json=body,
                                   headers=extra_headers or None)
        return resp.json()

    async def staging_extend_lease(self, staging_id: str, extension_seconds: int = 900) -> dict:
        """POST /v1/staging/extend-lease — extend lease during long classification."""
        resp = await self._request("POST", "/v1/staging/extend-lease", json={
            "id": staging_id,
            "extension_seconds": extension_seconds,
        })
        return resp.json()

    async def staging_status(self, staging_id: str) -> dict:
        """GET /v1/staging/status/{id} — check staging item status."""
        resp = await self._request("GET", f"/v1/staging/status/{staging_id}")
        return resp.json()

    async def staging_fail(self, staging_id: str, error: str) -> dict:
        """POST /v1/staging/fail — report classification failure."""
        resp = await self._request("POST", "/v1/staging/fail", json={
            "id": staging_id,
            "error": error,
        })
        return resp.json()

    async def staging_resolve_multi(
        self, staging_id: str, targets: list[dict],
        session: str = "", agent_did: str = "", user_origin: str = "",
    ) -> dict:
        """POST /v1/staging/resolve — multi-persona resolve."""
        extra_headers = {}
        if session:
            extra_headers["X-Session"] = session
        if agent_did:
            extra_headers["X-Agent-DID"] = agent_did
        body: dict = {"id": staging_id, "targets": targets}
        if user_origin:
            body["user_origin"] = user_origin
        resp = await self._request("POST", "/v1/staging/resolve", json=body,
                                   headers=extra_headers or None)
        return resp.json()

    async def update_contact_last_seen(self, did: str, timestamp: int) -> None:
        """PUT /v1/contacts/{did} — update last_contact timestamp."""
        try:
            await self._request("PUT", f"/v1/contacts/{did}", json={
                "last_contact": timestamp,
            })
        except Exception:
            pass  # best-effort

    async def store_reminder(self, reminder: dict) -> str:
        """POST /v1/reminder — create a reminder with source lineage."""
        resp = await self._request("POST", "/v1/reminder", json=reminder)
        return resp.json().get("id", "")

    async def search_vault(
        self, persona_id: str, query: str, mode: str = "hybrid",
        embedding: list[float] | None = None,
        agent_did: str = "", session: str = "",
        include_all: bool = False,
        user_origin: str = "",
    ) -> list[VaultItem]:
        """POST /v1/vault/query — hybrid FTS5 + cosine.

        When agent_did and session are provided, Core attributes the access
        to the originating agent (for approval/grant enforcement) instead of
        to Brain's service key.

        When user_origin is provided (e.g. "telegram"), Core treats the
        request as user-originated, enabling auto-unlock for sensitive personas.
        """
        body: dict[str, Any] = {
            "persona": persona_id, "query": query, "mode": mode, "limit": 50,
        }
        if embedding:
            body["embedding"] = embedding
        if include_all:
            body["include_all"] = True
        if user_origin:
            body["user_origin"] = user_origin
        extra_headers = {}
        if agent_did:
            extra_headers["X-Agent-DID"] = agent_did
        if session:
            extra_headers["X-Session"] = session
        resp = await self._request(
            "POST",
            "/v1/vault/query",
            json=body,
            headers=extra_headers if extra_headers else None,
        )
        data = resp.json()
        return [VaultItem.model_validate(i) for i in data.get("items", [])]

    # -- Scratchpad (stored via KV) ------------------------------------------

    async def write_scratchpad(
        self, task_id: str, step: int, context: dict
    ) -> None:
        """Write checkpoint via KV at ``scratchpad:{task_id}``."""
        await self.set_kv(
            f"scratchpad:{task_id}",
            json.dumps({"step": step, "context": context}),
        )

    async def read_scratchpad(self, task_id: str) -> dict | None:
        """Read checkpoint from KV at ``scratchpad:{task_id}``."""
        raw = await self.get_kv(f"scratchpad:{task_id}")
        if raw is None:
            return None
        try:
            return json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return None

    # -- Key-Value store -----------------------------------------------------

    async def get_kv(self, key: str) -> str | None:
        """GET /v1/vault/kv/{key}."""
        try:
            resp = await self._request("GET", f"/v1/vault/kv/{key}")
            data = resp.json()
            return data.get("value")
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 404:
                return None
            raise

    async def set_kv(self, key: str, value: str) -> None:
        """PUT /v1/vault/kv/{key}."""
        await self._request(
            "PUT",
            f"/v1/vault/kv/{key}",
            json={"value": value},
        )

    # -- Audit ---------------------------------------------------------------

    async def audit_append(self, entry: dict) -> int:
        """POST /v1/audit/append — write an audit entry to Core."""
        resp = await self._request("POST", "/v1/audit/append", json=entry)
        data = resp.json()
        return data.get("id", 0)

    async def audit_query(
        self, action: str = "", limit: int = 20, **kwargs: str,
    ) -> list[dict]:
        """GET /v1/audit/query — read audit entries from Core."""
        params: list[str] = []
        if action:
            params.append(f"action={action}")
        if limit:
            params.append(f"limit={limit}")
        for k, v in kwargs.items():
            if v:
                params.append(f"{k}={v}")
        qs = "&".join(params)
        path = f"/v1/audit/query?{qs}" if qs else "/v1/audit/query"
        resp = await self._request("GET", path)
        data = resp.json()
        return data.get("entries", [])

    # -- Persona Approvals ---------------------------------------------------

    async def list_pending_approvals(self) -> list[dict]:
        """GET /v1/approvals — list pending approval requests."""
        resp = await self._request("GET", "/v1/approvals")
        return resp.json().get("approvals", [])

    async def approve_request(self, approval_id: str, scope: str = "session", granted_by: str = "telegram") -> dict:
        """POST /v1/approvals/{id}/approve — approve a pending request."""
        resp = await self._request("POST", f"/v1/approvals/{approval_id}/approve", json={
            "scope": scope, "granted_by": granted_by,
        })
        return resp.json()

    async def deny_request(self, approval_id: str) -> dict:
        """POST /v1/approvals/{id}/deny — deny a pending request."""
        resp = await self._request("POST", f"/v1/approvals/{approval_id}/deny")
        return resp.json()

    # -- Health --------------------------------------------------------------

    async def health(self) -> dict:
        """GET /healthz — returns ``{"status": "ok"}`` when core is live."""
        resp = await self._request("GET", "/healthz")
        return resp.json()

    # -- PII -----------------------------------------------------------------

    async def pii_scrub(self, text: str) -> ScrubResult:
        """POST /v1/pii/scrub — Tier 1 regex scrubbing via Go core."""
        resp = await self._request(
            "POST",
            "/v1/pii/scrub",
            json={"text": text},
        )
        return ScrubResult.model_validate(resp.json())

    # -- Notifications -------------------------------------------------------

    async def notify(self, device_id: str, payload: dict, priority: str = "solicited") -> None:
        """POST /v1/notify — broadcast notification to connected devices."""
        await self._request(
            "POST",
            "/v1/notify",
            json={"message": json.dumps(payload), "priority": priority},
        )

    # -- Workflow tasks (replaces delegated tasks) -----------------------------

    async def create_workflow_task(
        self,
        task_id: str,
        description: str,
        origin: str = "telegram",
        proposal_id: str = "",
        idempotency_key: str = "",
        requires_approval: bool = False,
        requested_runner: str = "",
        *,
        kind: str = "",
        status: str = "",
        payload: str = "",
        payload_type: str = "",
        expires_at: int = 0,
        correlation_id: str = "",
        priority: str = "",
    ) -> dict:
        """POST /v1/workflow/tasks — create a workflow task.

        ``payload_type`` is a strongly-typed discriminator for the JSON
        blob in ``payload`` (e.g. ``"service_query_execution"``). Core
        persists it on an indexed column so lookups don't depend on
        substring-matching the payload JSON — which would be brittle
        across Python/Go serialiser spacing.
        """
        body: dict = {
            "id": task_id,
            "description": description,
            "origin": origin,
            "proposal_id": proposal_id,
            "idempotency_key": idempotency_key,
            "requires_approval": requires_approval,
        }
        if requested_runner:
            body["requested_runner"] = requested_runner
        if kind:
            body["kind"] = kind
        if payload:
            body["payload"] = payload
        if payload_type:
            body["payload_type"] = payload_type
        if expires_at:
            body["expires_at"] = expires_at
        if correlation_id:
            body["correlation_id"] = correlation_id
        if priority:
            body["priority"] = priority
        try:
            resp = await self._request("POST", "/v1/workflow/tasks", json=body)
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 409:
                raise WorkflowConflictError(
                    f"workflow task create conflict: task_id={task_id}"
                ) from exc
            raise
        return resp.json()

    async def get_workflow_task(self, task_id: str) -> dict | None:
        """GET /v1/workflow/tasks/{id} — fetch a workflow task.
        Returns None only for 404. Other errors are raised."""
        try:
            resp = await self._request("GET", f"/v1/workflow/tasks/{task_id}")
            return resp.json()
        except Exception as exc:
            if "404" in str(exc) or "not found" in str(exc).lower():
                return None
            raise

    async def list_workflow_tasks(
        self, status: str = "", kind: str = "", limit: int = 0,
        order: str = "",
    ) -> list[dict]:
        """GET /v1/workflow/tasks — list workflow tasks."""
        parts = []
        if status:
            parts.append(f"status={status}")
        if kind:
            parts.append(f"kind={kind}")
        if limit > 0:
            parts.append(f"limit={limit}")
        if order:
            parts.append(f"order={order}")
        path = "/v1/workflow/tasks"
        if parts:
            path += "?" + "&".join(parts)
        resp = await self._request("GET", path)
        return resp.json().get("tasks", [])

    async def queue_task_by_proposal(self, proposal_id: str) -> None:
        """POST /v1/workflow/tasks/queue-by-proposal — transition task to queued."""
        await self._request(
            "POST",
            "/v1/workflow/tasks/queue-by-proposal",
            json={"proposal_id": proposal_id},
        )

    async def ack_workflow_event(self, event_id: int) -> None:
        """POST /v1/workflow/events/{event_id}/ack — acknowledge a workflow event."""
        await self._request(
            "POST",
            f"/v1/workflow/events/{event_id}/ack",
        )

    # -- Service Discovery (WS2) --

    async def send_service_query(
        self, to_did: str, capability: str, params: dict,
        query_id: str, ttl_seconds: int, service_name: str,
        origin_channel: str = "", schema_hash: str = "",
    ) -> dict:
        """POST /v1/service/query — send a service query via durable workflow task."""
        body = {
            "to_did": to_did,
            "capability": capability,
            "params": params,
            "query_id": query_id,
            "ttl_seconds": ttl_seconds,
            "service_name": service_name,
        }
        if origin_channel:
            body["origin_channel"] = origin_channel
        if schema_hash:
            body["schema_hash"] = schema_hash
        resp = await self._request(
            "POST",
            "/v1/service/query",
            json=body,
        )
        return resp.json()

    async def send_service_respond(self, task_id: str, response_body: dict) -> dict:
        """POST /v1/service/respond — send approved service response."""
        resp = await self._request(
            "POST",
            "/v1/service/respond",
            json={
                "task_id": task_id,
                "response_body": response_body,
            },
        )
        return resp.json()

    async def approve_workflow_task(self, task_id: str) -> dict:
        """POST /v1/workflow/tasks/{task_id}/approve — approve a pending task."""
        resp = await self._request(
            "POST",
            f"/v1/workflow/tasks/{task_id}/approve",
        )
        return resp.json()

    async def cancel_workflow_task(self, task_id: str) -> dict:
        """POST /v1/workflow/tasks/{task_id}/cancel — cancel a task (terminal).

        Raises ``WorkflowConflictError`` on HTTP 409 (task already in a
        terminal state, or transition not allowed).
        """
        try:
            resp = await self._request(
                "POST",
                f"/v1/workflow/tasks/{task_id}/cancel",
            )
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 409:
                raise WorkflowConflictError(
                    f"workflow task cancel conflict: task_id={task_id}"
                ) from exc
            raise
        return resp.json()

    # -- Task queue ACK ------------------------------------------------------

    async def task_ack(self, task_id: str) -> None:
        """POST /v1/task/ack — acknowledge successful task processing."""
        await self._request(
            "POST",
            "/v1/task/ack",
            json={"task_id": task_id},
        )

    # -- Identity / signing --------------------------------------------------

    async def did_sign(self, data: bytes) -> bytes:
        """POST /v1/did/sign — Ed25519 sign via core's keypair.

        Sends raw bytes as hex-encoded JSON payload.  Returns the
        signature bytes decoded from the hex response.
        """
        resp = await self._request(
            "POST",
            "/v1/did/sign",
            json={"data": data.hex()},
        )
        sig_hex = resp.json().get("signature", "")
        return bytes.fromhex(sig_hex)

    # -- Contacts (core directory) -------------------------------------------

    async def list_contacts(self) -> list[Contact]:
        """GET /v1/contacts — list all contacts from core directory."""
        resp = await self._request("GET", "/v1/contacts")
        data = resp.json()
        return [Contact.model_validate(c) for c in data.get("contacts", [])]

    async def add_contact(
        self,
        did: str,
        name: str,
        trust_level: str = "unknown",
        sharing_tier: str = "",
        relationship: str = "",
        data_responsibility: str = "",
    ) -> dict:
        """POST /v1/contacts — add contact to core directory."""
        body: dict[str, str] = {"did": did, "name": name, "trust_level": trust_level}
        if sharing_tier:
            body["sharing_tier"] = sharing_tier
        if relationship:
            body["relationship"] = relationship
        if data_responsibility:
            body["data_responsibility"] = data_responsibility
        resp = await self._request("POST", "/v1/contacts", json=body)
        return resp.json()

    async def update_contact(
        self,
        did: str,
        *,
        name: str = "",
        trust_level: str = "",
        sharing_tier: str = "",
        relationship: str = "",
        data_responsibility: str = "",
    ) -> dict:
        """PUT /v1/contacts/{did} — update contact fields (partial)."""
        body: dict[str, str] = {}
        if name:
            body["name"] = name
        if trust_level:
            body["trust_level"] = trust_level
        if sharing_tier:
            body["sharing_tier"] = sharing_tier
        if relationship:
            body["relationship"] = relationship
        if data_responsibility:
            body["data_responsibility"] = data_responsibility
        resp = await self._request("PUT", f"/v1/contacts/{did}", json=body)
        return resp.json()

    async def add_alias(self, did: str, alias: str) -> dict:
        """POST /v1/contacts/{did}/aliases — add alias."""
        import urllib.parse
        resp = await self._request(
            "POST", f"/v1/contacts/{urllib.parse.quote(did, safe='')}/aliases",
            json={"alias": alias},
        )
        return resp.json()

    async def remove_alias(self, did: str, alias: str) -> dict:
        """DELETE /v1/contacts/{did}/aliases/{alias} — remove alias."""
        import urllib.parse
        resp = await self._request(
            "DELETE",
            f"/v1/contacts/{urllib.parse.quote(did, safe='')}/aliases/{urllib.parse.quote(alias, safe='')}",
        )
        return resp.json()

    async def list_aliases(self, did: str) -> list[str]:
        """GET /v1/contacts/{did}/aliases — list aliases."""
        import urllib.parse
        resp = await self._request(
            "GET", f"/v1/contacts/{urllib.parse.quote(did, safe='')}/aliases",
        )
        return resp.json().get("aliases", [])

    async def delete_contact(self, did: str) -> dict:
        """DELETE /v1/contacts/{did} — remove contact from directory."""
        resp = await self._request("DELETE", f"/v1/contacts/{did}")
        return resp.json()

    # -- Vault query (correct endpoint) --------------------------------------

    async def query_vault(
        self,
        persona: str,
        query: str = "",
        *,
        mode: str = "fts5",
        types: list[str] | None = None,
        limit: int = 50,
        user_origin: str = "",
    ) -> list[VaultItem]:
        """POST /v1/vault/query — search vault items."""
        body: dict[str, Any] = {
            "persona": persona,
            "query": query,
            "mode": mode,
            "limit": limit,
        }
        if types:
            body["types"] = types
        if user_origin:
            body["user_origin"] = user_origin
        resp = await self._request("POST", "/v1/vault/query", json=body)
        data = resp.json()
        return [VaultItem.model_validate(i) for i in data.get("items", [])]

    # -- Personas ------------------------------------------------------------

    async def list_personas(self) -> list[str]:
        """GET /v1/personas — list persona IDs."""
        resp = await self._request("GET", "/v1/personas")
        data = resp.json()
        return data.get("personas", [])

    async def list_personas_detailed(self) -> list[dict]:
        """GET /v1/personas — return persona_details with tier + locked state.

        Falls back to constructing minimal dicts from the personas string
        array if Core hasn't been upgraded to return persona_details.
        """
        resp = await self._request("GET", "/v1/personas")
        data = resp.json()
        details = data.get("persona_details")
        if details:
            return details
        # Backward compat: Core returns only string IDs
        return [{"id": pid, "name": pid.removeprefix("persona-")} for pid in data.get("personas", [])]

    # -- Devices -------------------------------------------------------------

    async def list_devices(self) -> list[PairedDevice]:
        """GET /v1/devices — list registered devices."""
        resp = await self._request("GET", "/v1/devices")
        data = resp.json()
        return [PairedDevice.model_validate(d) for d in data.get("devices", [])]

    async def list_service_agents(self) -> list[dict]:
        """GET /v1/service/agents — names + DIDs of paired agent-role devices.

        Narrow surface Brain is allowed to call (unlike /v1/devices which
        is admin-only). Used by the provider-side ServiceHandler to
        render operator notifications like "Dispatching to
        busdriver-openclaw" using real device names.
        """
        resp = await self._request("GET", "/v1/service/agents")
        data = resp.json()
        return list(data.get("agents") or [])

    # -- Working memory ------------------------------------------------------

    async def memory_touch(
        self,
        *,
        persona: str,
        topic: str,
        kind: str,
        live_capability: str = "",
        live_provider_did: str = "",
        sample_item_id: str = "",
    ) -> dict:
        """POST /v1/memory/topic/touch — record a topic mention.

        Applies EWMA decay + increment on the persona's salience index.
        Variant → canonical mapping happens inside Core; the caller
        passes the extracted surface form. See
        docs/WORKING_MEMORY_DESIGN.md.
        """
        body = {
            "persona": persona,
            "topic": topic,
            "kind": kind,
        }
        if live_capability:
            body["live_capability"] = live_capability
        if live_provider_did:
            body["live_provider_did"] = live_provider_did
        if sample_item_id:
            body["sample_item_id"] = sample_item_id
        resp = await self._request("POST", "/v1/memory/topic/touch", json=body)
        return resp.json() if resp.status_code < 300 else {}

    async def memory_toc(
        self,
        *,
        personas: list[str] | None = None,
        limit: int = 50,
    ) -> list[dict]:
        """GET /v1/memory/toc — ranked ToC across unlocked personas.

        Returns the list under the "entries" key. Locked or unknown
        personas are silently skipped by Core. Salience is computed
        with decay applied at read time.
        """
        from urllib.parse import urlencode

        query: dict[str, str] = {"limit": str(limit)}
        if personas:
            query["persona"] = ",".join(personas)
        path = "/v1/memory/toc?" + urlencode(query)
        resp = await self._request("GET", path)
        data = resp.json() if resp.status_code < 300 else {}
        return list(data.get("entries") or [])

    async def initiate_pairing(self) -> InitiatePairingResponse:
        """POST /v1/pair/initiate — generate pairing code."""
        resp = await self._request("POST", "/v1/pair/initiate")
        return InitiatePairingResponse.model_validate(resp.json())

    async def complete_pairing(self, code: str, device_name: str,
                               public_key_multibase: str | None = None,
                               *, role: str | None = None) -> CompletePairingResponse:
        """POST /v1/pair/complete — register device."""
        body: dict = {"code": code, "device_name": device_name}
        if public_key_multibase:
            body["public_key_multibase"] = public_key_multibase
        if role:
            body["role"] = role
        resp = await self._request("POST", "/v1/pair/complete", json=body)
        return CompletePairingResponse.model_validate(resp.json())

    async def revoke_device(self, token_id: str) -> None:
        """DELETE /v1/devices/{id} — revoke device."""
        await self._request("DELETE", f"/v1/devices/{token_id}")

    # -- Identity ------------------------------------------------------------

    async def get_did(self) -> dict:
        """GET /v1/did — get identity DID document."""
        resp = await self._request("GET", "/v1/did")
        return resp.json()

    # -- Trust Network -------------------------------------------------------

    async def query_trust_profile(self, did: str) -> dict | None:
        """GET /v1/trust/resolve?did={did} — fetch full trust profile from AppView via Core."""
        import urllib.parse

        try:
            resp = await self._request(
                "GET",
                f"/v1/trust/resolve?did={urllib.parse.quote(did)}",
            )
            return resp.json()
        except Exception:
            logger.warning("trust_profile_query_failed", did=did)
            return None

    async def search_trust_network(
        self, query: str = "", category: str = "", subject_type: str = "", limit: int = 10
    ) -> dict | None:
        """GET /v1/trust/search — search AppView Trust Network for attestations.

        Used by the reasoning agent to find product reviews, merchant ratings,
        and trust evidence when the user asks about purchases or trust.
        """
        import urllib.parse

        params = {}
        if query:
            params["q"] = query
        if category:
            params["category"] = category
        if subject_type:
            params["subjectType"] = subject_type
        params["limit"] = str(limit)

        qs = urllib.parse.urlencode(params)
        try:
            resp = await self._request("GET", f"/v1/trust/search?{qs}")
            return resp.json()
        except Exception:
            logger.warning("trust_search_failed", query=query)
            return None

    # -- Dina-to-Dina messaging ----------------------------------------------

    async def send_d2d(self, to_did: str, payload: dict, msg_type: str) -> None:
        """POST /v1/msg/send — outbound D2D v1 message through core.

        Args:
            to_did:   Recipient DID.
            payload:  Message body dict (will be base64-encoded).
            msg_type: D2D v1 message type (e.g. "social.update",
                      "trust.vouch.request").  Must be one of the v1 families
                      accepted by Core — unknown types are rejected with 400.
        """
        import base64

        body_b64 = base64.b64encode(json.dumps(payload).encode()).decode()
        await self._request(
            "POST",
            "/v1/msg/send",
            json={"to": to_did, "body": body_b64, "type": msg_type},
        )

    # -- Service config --------------------------------------------------------

    async def get_service_config(self) -> dict | None:
        """GET /v1/service/config — retrieve local service configuration.

        Returns the service config dict if available, or None if the
        endpoint returns an empty body or a non-200 status.
        """
        try:
            resp = await self._request("GET", "/v1/service/config")
            data = resp.json()
            return data if data else None
        except Exception:
            logger.warning("get_service_config_failed")
            return None

    # -- Reminder endpoints ----------------------------------------------------

    async def store_reminder(self, reminder: dict) -> str:
        """POST /v1/reminder — store a new reminder and wake the loop."""
        resp = await self._request("POST", "/v1/reminder", json=reminder)
        data = resp.json()
        return data.get("id", "")

    async def list_pending_reminders(self) -> list[Reminder]:
        """GET /v1/reminders/pending — list unfired reminders."""
        resp = await self._request("GET", "/v1/reminders/pending")
        data = resp.json()
        return [Reminder.model_validate(r) for r in data.get("reminders", [])]

    async def fire_reminder(self, reminder_id: str) -> dict:
        """POST /v1/reminder/fire — simulate reminder firing (test-only)."""
        resp = await self._request(
            "POST",
            "/v1/reminder/fire",
            json={"reminder_id": reminder_id},
        )
        return resp.json()
