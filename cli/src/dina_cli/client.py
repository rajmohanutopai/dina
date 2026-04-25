"""Synchronous HTTP client wrapping Dina Core.

Routes every request through the transport selector (direct HTTP or
MsgBox WebSocket relay) so the same code works on LAN, Docker, and
NAT'd mobile deployments.
"""

from __future__ import annotations

import json as _json
import uuid
from typing import Any

import httpx

from .config import Config
from .signing import CLIIdentity
from .transport import (
    Transport,
    TransportError,
    TransportResponse,
    select_transport,
)


class DinaClientError(Exception):
    """Raised when a Dina API call fails."""


class _ClientResponse:
    """Minimal httpx.Response-like adapter around TransportResponse.

    The DinaClient body only uses ``.status_code``, ``.text``, ``.content``,
    ``.json()``, ``.headers``, and ``.raise_for_status()`` — implementing
    those lets the rest of the client stay unchanged.
    """

    def __init__(self, tr: TransportResponse) -> None:
        self._tr = tr
        self.status_code = tr.status
        self.headers = tr.headers
        self.text = tr.body

    @property
    def content(self) -> bytes:
        return self.text.encode("utf-8") if self.text else b""

    def json(self) -> Any:
        return _json.loads(self.text) if self.text else {}

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            # Build a lightweight HTTPStatusError so existing except-handlers
            # (which pull .status_code, .json(), .text from exc.response) keep
            # working unchanged.
            fake_req = httpx.Request("GET", "http://dina")
            fake_resp = httpx.Response(
                status_code=self.status_code,
                content=self.content,
                headers=dict(self.headers),
                request=fake_req,
            )
            raise httpx.HTTPStatusError(
                f"HTTP {self.status_code}", request=fake_req, response=fake_resp,
            )


class DinaClient:
    """Synchronous HTTP client for Dina Core.

    All requests are authenticated via Ed25519 request signing
    (X-DID / X-Timestamp / X-Signature headers) and tunnelled over
    the configured transport (direct HTTP or MsgBox WS relay).
    """

    def __init__(self, config: Config, verbose: bool = False) -> None:
        self._identity = CLIIdentity()
        self._identity.ensure_loaded()
        self._verbose = verbose
        self._req_id = uuid.uuid4().hex[:12]
        self._config = config
        # Legacy sentinel — callers still pass `self._core` as the first arg to
        # `_request` for backward compat; `_request` ignores the value, but the
        # attribute must exist on the instance.
        self._core = None
        try:
            self._transport: Transport = select_transport(
                mode=config.transport_mode,
                core_url=config.core_url or None,
                msgbox_url=config.msgbox_url or None,
                homenode_did=config.homenode_did or None,
                timeout=config.timeout,
            )
        except TransportError as exc:
            raise DinaClientError(
                f"Cannot establish transport: {exc}. "
                f"Check DINA_CORE_URL / DINA_MSGBOX_URL / DINA_HOMENODE_DID "
                f"or rerun `dina configure`."
            ) from exc

    @property
    def req_id(self) -> str:
        """Return the request ID for this client instance (for trace correlation)."""
        return self._req_id

    # -- Context manager support ------------------------------------------

    def __enter__(self) -> DinaClient:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: Any,
    ) -> None:
        self.close()

    def close(self) -> None:
        """Release transport resources (no-op for direct; idempotent for msgbox)."""
        close_fn = getattr(self._transport, "close", None)
        if close_fn:
            try:
                close_fn()
            except Exception:
                pass

    # -- Private helpers ---------------------------------------------------

    @staticmethod
    def _extract_body(kwargs: dict) -> bytes:
        """Extract/serialize the request body from kwargs.

        When ``json=`` is present, serialize it ourselves with compact
        separators so the hash matches what httpx transmits.  The ``json``
        key is replaced with ``content`` + ``Content-Type`` header.
        """
        if "json" in kwargs:
            body_bytes = _json.dumps(
                kwargs.pop("json"), separators=(",", ":"),
            ).encode("utf-8")
            kwargs["content"] = body_bytes
            headers = kwargs.get("headers") or {}
            headers["Content-Type"] = "application/json"
            kwargs["headers"] = headers
            return body_bytes
        raw = kwargs.get("content")
        if isinstance(raw, str):
            return raw.encode("utf-8")
        return raw or b""

    def _request(
        self,
        client: Any,
        method: str,
        path: str,
        **kwargs: Any,
    ) -> _ClientResponse:
        """Send a request via the configured transport and translate errors.

        The ``client`` arg is kept for signature compatibility with earlier
        callers that passed ``self._core``; it is ignored — everything routes
        through ``self._transport`` now.
        """
        body_bytes = self._extract_body(kwargs)
        query = ""
        if "params" in kwargs and kwargs["params"]:
            from urllib.parse import urlencode
            query = urlencode(kwargs["params"], doseq=True)
        did, ts, nonce, sig = self._identity.sign_request(
            method, path, body_bytes, query=query,
        )
        headers = dict(kwargs.get("headers") or {})
        headers["X-DID"] = did
        headers["X-Timestamp"] = ts
        headers["X-Nonce"] = nonce
        headers["X-Signature"] = sig
        # X-Request-ID is the per-client trace correlation header — same
        # for every call this client makes, so logs can be grouped to one
        # CLI invocation. Distinct from the per-call RPC envelope ID below.
        headers["X-Request-ID"] = self._req_id

        if self._verbose:
            import sys
            print(f"  >> {method} {path}", file=sys.stderr)
            print(f"     DID: {did}", file=sys.stderr)
            if body_bytes:
                preview = body_bytes[:200].decode("utf-8", errors="replace")
                print(f"     Body: {preview}", file=sys.stderr)

        full_path = f"{path}?{query}" if query else path
        body_str = body_bytes.decode("utf-8") if body_bytes else None

        # NOTE: do NOT pass request_id=self._req_id here. MsgBoxTransport uses
        # its `request_id` argument as both the RPC envelope ID and the
        # idempotency cache key on Core (rpc_idempotency.go keyed on
        # from_did + request_id). Passing the per-client ID would make the
        # first response stick — every subsequent claim/mark_running/progress
        # call would get the cached first response back, never executing.
        # Symptom: agent-daemon "claims" forever, real ops never land.
        # Let MsgBoxTransport.request generate a fresh UUID per call.
        try:
            tr = self._transport.request(
                method, full_path, headers, body=body_str,
            )
        except TransportError as exc:
            raise DinaClientError(
                f"Cannot reach Dina: {exc}"
            ) from exc

        response = _ClientResponse(tr)
        if self._verbose:
            import sys
            print(
                f"  << {response.status_code} ({len(response.content)} bytes)",
                file=sys.stderr,
            )
            if response.status_code >= 400:
                print(f"     Response: {response.text[:300]}", file=sys.stderr)

        if response.status_code < 400:
            return response

        # Parse server error message for user-facing context.
        try:
            err_body = response.json()
            server_msg = err_body.get("error", response.text)
            detail = err_body.get("message", "")
            if detail:
                server_msg = f"{server_msg} — {detail}"
        except Exception:
            server_msg = (response.text or "").strip()

        status = response.status_code
        if status == 401:
            raise DinaClientError(f"Authentication failed: {server_msg}")
        if status == 403:
            raise DinaClientError(f"Access denied: {server_msg}")
        if status >= 500:
            raise DinaClientError(f"Server error ({status}): {server_msg}")
        raise DinaClientError(f"HTTP {status}: {server_msg}")

    # -- Ask (Brain-mediated reasoning, persona-blind) ---------------------

    def ask(self, prompt: str, session: str = "") -> dict:
        """Send a reasoning query to Brain via Core proxy.

        Brain decides which personas to search. The agent never
        specifies a persona — Brain handles routing, PII scrubbing,
        and context assembly.
        """
        body: dict[str, Any] = {"prompt": prompt}
        headers: dict[str, str] = {}
        if session:
            headers["X-Session"] = session
        resp = self._request(
            self._core, "POST", "/api/v1/ask",
            json=body, headers=headers,
        )
        return resp.json()

    def ask_status(self, request_id: str) -> dict:
        """Poll the status of a pending ask request."""
        resp = self._request(
            self._core, "GET", f"/api/v1/ask/{request_id}/status",
        )
        return resp.json()

    # -- Staging (universal content ingestion) ------------------------------

    def staging_ingest(self, item: dict, session: str = "") -> dict:
        """Ingest content into the staging inbox for Brain classification.

        All memory-producing CLI writes go through staging.
        Provenance (ingress_channel, origin_kind) is set server-side.

        When ``session`` is provided, it is sent as ``X-Session`` header
        for session-scoped access control and also stored in item metadata
        for traceability.
        """
        extra_headers = {}
        if session:
            extra_headers["X-Session"] = session
        resp = self._request(
            self._core,
            "POST",
            "/v1/staging/ingest",
            json=item,
            headers=extra_headers if extra_headers else None,
        )
        return resp.json()

    # -- Vault (admin/internal only — agents use reason()) ----------------

    def vault_store(self, persona: str, item: dict) -> dict:
        """Store an item in the vault (legacy — prefer staging_ingest)."""
        resp = self._request(
            self._core,
            "POST",
            "/v1/vault/store",
            json={"persona": persona, "item": item},
        )
        return resp.json()

    def vault_query(
        self,
        persona: str,
        query: str,
        types: list[str] | None = None,
        limit: int = 50,
        extra_headers: dict[str, str] | None = None,
    ) -> list[dict]:
        """Query the vault and return matching items."""
        kwargs: dict[str, Any] = {
            "json": {
                "persona": persona,
                "query": query,
                "mode": "hybrid",
                "types": types or [],
                "limit": limit,
            },
        }
        if extra_headers:
            kwargs["headers"] = extra_headers
        resp = self._request(self._core, "POST", "/v1/vault/query", **kwargs)
        return resp.json().get("items") or []

    # -- Key/Value ---------------------------------------------------------

    def kv_get(self, key: str, session: str = "") -> str | None:
        """Get a KV value by key. Returns None if the key does not exist."""
        extra = {}
        if session:
            extra["X-Session"] = session
        try:
            resp = self._request(
                self._core, "GET", f"/v1/vault/kv/{key}",
                headers=extra if extra else None,
            )
            try:
                data = resp.json()
            except (_json.JSONDecodeError, ValueError, TypeError):
                data = None
            return data.get("value") if isinstance(data, dict) else resp.text
        except DinaClientError as exc:
            if "HTTP 404" in str(exc):
                return None
            raise

    def kv_set(self, key: str, value: str, session: str = "") -> None:
        """Set a KV value. Pass session for agent-scoped writes."""
        extra = {"Content-Type": "text/plain"}
        if session:
            extra["X-Session"] = session
        self._request(
            self._core,
            "PUT",
            f"/v1/vault/kv/{key}",
            content=value,
            headers=extra,
        )

    # -- PII ---------------------------------------------------------------

    def remember(self, text: str, session: str = "", source_id: str = "", metadata: str = "") -> dict:
        """Store a memory via POST /api/v1/remember.

        Returns semantic completion: stored / needs_approval / processing / failed.
        Blocks up to ~15s waiting for staging to complete.
        Use remember_check(id) to poll if status is 'processing'.
        """
        resp = self._request(
            self._core,
            "POST",
            "/api/v1/remember",
            json={
                "text": text,
                "session": session,
                "source": "dina-cli",
                "source_id": source_id,
                "metadata": metadata,
            },
        )
        return resp.json()

    def remember_check(self, item_id: str) -> dict:
        """Check status of a pending remember via GET /api/v1/remember/{id}."""
        resp = self._request(
            self._core,
            "GET",
            f"/api/v1/remember/{item_id}",
        )
        return resp.json()

    def pii_scrub(self, text: str) -> dict:
        """Scrub PII from text."""
        resp = self._request(
            self._core,
            "POST",
            "/v1/pii/scrub",
            json={"text": text},
        )
        return resp.json()

    # -- DID ---------------------------------------------------------------

    def did_get(self) -> dict:
        """Retrieve the DID document."""
        resp = self._request(self._core, "GET", "/v1/did")
        return resp.json()

    # -- Brain -------------------------------------------------------------

    def process_event(self, event: dict, session: str = "") -> dict:
        """Send an event to Core's agent validation proxy.

        Core authenticates via Ed25519 signature (device auth) and forwards
        to brain's guardian internally. When ``session`` is provided, it is
        sent as ``X-Session`` header for session-scoped approval grants.
        """
        extra_headers = {}
        if session:
            extra_headers["X-Session"] = session
        resp = self._request(
            self._core,
            "POST",
            "/v1/agent/validate",
            json=event,
            headers=extra_headers if extra_headers else None,
        )
        return resp.json()

    def get_proposal_status(self, proposal_id: str, session: str = "") -> dict:
        """Poll proposal status via Core's intent proposal endpoint."""
        extra = {}
        if session:
            extra["X-Session"] = session
        resp = self._request(
            self._core,
            "GET",
            f"/v1/intent/proposals/{proposal_id}/status",
            headers=extra if extra else None,
        )
        return resp.json()

    # -- Sessions --------------------------------------------------------------

    def session_start(self, name: str) -> dict:
        """Start a named session (POST /v1/session/start)."""
        resp = self._request(
            self._core, "POST", "/v1/session/start", json={"name": name},
        )
        return resp.json()

    def session_end(self, name: str) -> None:
        """End a session and revoke all grants (POST /v1/session/end)."""
        self._request(
            self._core, "POST", "/v1/session/end", json={"name": name},
        )

    def proposal_status(self, proposal_id: str) -> dict:
        """Poll intent proposal status (GET /v1/intent/proposals/{id}/status)."""
        resp = self._request(
            self._core, "GET", f"/v1/intent/proposals/{proposal_id}/status",
        )
        return resp.json()

    # -- Delegated tasks -------------------------------------------------------

    def claim_task(self, lease_seconds: int = 300, runner_filter: str = "") -> dict | None:
        """Claim the next queued delegated task (POST /v1/workflow/tasks/claim).
        If runner_filter is set, only claims tasks matching that runner.
        Returns task dict or None if no work available."""
        body: dict = {"lease_seconds": lease_seconds}
        if runner_filter:
            body["runner_filter"] = runner_filter
        resp = self._request(
            self._core, "POST", "/v1/workflow/tasks/claim",
            json=body,
        )
        if resp.status_code == 204:
            return None
        return resp.json()

    def task_heartbeat(self, task_id: str, lease_seconds: int = 300) -> None:
        """Extend lease on a claimed task (POST /v1/workflow/tasks/{id}/heartbeat)."""
        self._request(
            self._core, "POST", f"/v1/workflow/tasks/{task_id}/heartbeat",
            json={"lease_seconds": lease_seconds},
        )

    def task_complete(self, task_id: str, result: str, assigned_runner: str = "") -> None:
        """Mark task as completed (POST /v1/workflow/tasks/{id}/complete)."""
        body: dict = {"result": result}
        if assigned_runner:
            body["assigned_runner"] = assigned_runner
        self._request(
            self._core, "POST", f"/v1/workflow/tasks/{task_id}/complete",
            json=body,
        )

    def task_fail(self, task_id: str, error: str, assigned_runner: str = "") -> None:
        """Mark task as failed (POST /v1/workflow/tasks/{id}/fail)."""
        body: dict = {"error": error}
        if assigned_runner:
            body["assigned_runner"] = assigned_runner
        self._request(
            self._core, "POST", f"/v1/workflow/tasks/{task_id}/fail",
            json=body,
        )

    def mark_running(self, task_id: str, run_id: str = "", assigned_runner: str = "") -> None:
        """Mark task as running (POST /v1/workflow/tasks/{id}/running)."""
        body: dict = {"run_id": run_id}
        if assigned_runner:
            body["assigned_runner"] = assigned_runner
        self._request(
            self._core, "POST", f"/v1/workflow/tasks/{task_id}/running",
            json=body,
        )

    def task_progress(self, task_id: str, message: str) -> None:
        """Update progress on a claimed task (POST /v1/workflow/tasks/{id}/progress)."""
        self._request(
            self._core, "POST", f"/v1/workflow/tasks/{task_id}/progress",
            json={"message": message},
        )

    def get_task(self, task_id: str) -> dict | None:
        """Get a delegated task by ID (GET /v1/workflow/tasks/{id}).
        Returns None only for 404. Other errors are raised."""
        try:
            resp = self._request(
                self._core, "GET", f"/v1/workflow/tasks/{task_id}",
            )
            return resp.json()
        except DinaClientError as e:
            if "404" in str(e) or "not found" in str(e).lower():
                return None
            raise

    def list_tasks(self, status: str = "") -> list[dict]:
        """List delegated tasks (GET /v1/workflow/tasks)."""
        params = {}
        if status:
            params["status"] = status
        resp = self._request(
            self._core, "GET", "/v1/workflow/tasks", params=params,
        )
        return resp.json().get("tasks", [])

    # -- Service query (WS2 schema-driven discovery) ------------------------

    def send_service_query(
        self,
        *,
        to_did: str,
        capability: str,
        params: dict,
        service_name: str = "",
        ttl_seconds: int = 60,
        schema_hash: str = "",
        origin_channel: str = "",
    ) -> dict:
        """POST /v1/service/query — send a schema-driven service query.

        Params go structured (not flattened into the payload) so the
        provider's jsonschema validator can reject malformed requests.
        schema_hash is the canonical per-capability hash from the
        provider's published profile on AppView; providing a stale hash
        surfaces as ``schema_version_mismatch`` rather than silently
        executing against a newer schema.

        Returns ``{"task_id": "...", "query_id": "..."}``. The response
        arrives asynchronously via a workflow_event — poll ``get_task``
        with the returned task_id to observe the terminal status.
        """
        import uuid as _uuid
        body: dict[str, Any] = {
            "to_did": to_did,
            "capability": capability,
            "params": params,
            "query_id": str(_uuid.uuid4()),
            "ttl_seconds": ttl_seconds,
            "service_name": service_name or capability,
        }
        if schema_hash:
            body["schema_hash"] = schema_hash
        if origin_channel:
            body["origin_channel"] = origin_channel
        resp = self._request(
            self._core, "POST", "/v1/service/query",
            json=body,
        )
        return resp.json()
