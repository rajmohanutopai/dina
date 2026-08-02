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
                f"HTTP {self.status_code}",
                request=fake_req,
                response=fake_resp,
            )


class DinaClient:
    """Synchronous HTTP client for Dina Core.

    All requests are authenticated via Ed25519 request signing
    (X-DID / X-Timestamp / X-Signature headers) and tunnelled over
    the configured transport (direct HTTP or MsgBox WS relay).
    """

    def __init__(
        self,
        config: Config,
        verbose: bool = False,
        *,
        identity: CLIIdentity | None = None,
    ) -> None:
        self._identity = identity or CLIIdentity()
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
                kwargs.pop("json"),
                separators=(",", ":"),
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
            from urllib.parse import quote, urlencode

            # Core's canonical query serializer follows encodeURIComponent
            # (spaces are %20), not form encoding (spaces are +). Sign and send
            # the exact representation Core reconstructs.
            query = urlencode(kwargs["params"], doseq=True, quote_via=quote)
        did, ts, nonce, sig = self._identity.sign_request(
            method,
            path,
            body_bytes,
            query=query,
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

            via = getattr(self._transport, "transport_name", "?")
            print(f"  >> {method} {path} [via {via}]", file=sys.stderr)
            print(f"     DID: {did}", file=sys.stderr)
            if body_bytes:
                # Metadata only — even in --verbose, never dump the request body:
                # it carries vault queries / user content / PII (CLI.5).
                print(f"     Body: <{len(body_bytes)} bytes>", file=sys.stderr)

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
                method,
                full_path,
                headers,
                body=body_str,
            )
        except TransportError as exc:
            raise DinaClientError(f"Cannot reach Dina: {exc}") from exc

        response = _ClientResponse(tr)
        if self._verbose:
            import sys

            print(
                f"  << {response.status_code} ({len(response.content)} bytes)",
                file=sys.stderr,
            )
            if response.status_code >= 400:
                # Metadata only — don't echo the error response body to logs
                # even on failure; it may carry vault/error context (CLI.5).
                print(
                    f"     (error body: {len(response.content)} bytes)", file=sys.stderr
                )

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
        if self._config.role == "agent":
            body["session_id"] = session
        elif session:
            headers["X-Session"] = session
        resp = self._request(
            self._core,
            "POST",
            "/api/v1/ask",
            json=body,
            headers=headers,
        )
        return resp.json()

    def ask_status(self, request_id: str, session: str = "") -> dict:
        """Poll the status of a pending ask request."""
        params = {"session_id": session} if self._config.role == "agent" else None
        resp = self._request(
            self._core,
            "GET",
            f"/api/v1/ask/{request_id}/status",
            params=params,
        )
        return resp.json()

    # -- Coding-agent gate (raw tool-call classification) ------------------

    def gate(
        self,
        tool_name: str,
        tool_input: dict,
        mode: str = "enforce",
        session: str = "",
        host_session: str = "",
        cwd: str | None = None,
        approval_surface: str = "host",
    ) -> dict:
        """Classify a raw coding-agent tool call via POST /v1/agent/gate.

        Sends the RAW ``(tool_name, tool_input)`` for Core to classify + score
        (Core owns the policy — the caller never decides). Returns the decision
        ``{action, risk, outcome, enforced, permit_id, task_id, reason}`` where
        ``outcome`` is ``allow`` | ``approval_required`` | ``deny``. Raises
        ``DinaClientError`` on any non-2xx (a 501 when the node has no gate
        wired, a 401 for a bad/missing session) so the PreToolUse hook can fail
        CLOSED. Pass either an opaque Core ``session`` or the host's stable
        ``host_session`` id; Core atomically resolves the latter to a
        DID-bound session. Supplying neither is rejected.
        """
        if session and host_session:
            raise ValueError("pass either session or host_session, not both")
        if mode != "enforce":
            raise ValueError("gate mode is resolved by Dina Core")
        body: dict[str, Any] = {
            "tool_name": tool_name,
            "tool_input": tool_input,
            "approval_surface": approval_surface,
        }
        if session:
            body["session_id"] = session
        if host_session:
            body["host_session_id"] = host_session
        if cwd:
            body["cwd"] = cwd
        resp = self._request(self._core, "POST", "/v1/agent/gate", json=body)
        return resp.json()

    def audit_query(self, limit: int = 20, action: str = "") -> dict:
        """Read audit entries through the surface allowed for this caller.

        Coding agents receive only their own projected gate decisions. User and
        admin clients retain the legacy owner audit endpoint.
        """
        path = "/v1/agent/audit" if self._config.role == "agent" else "/v1/audit/query"
        params = {"limit": str(limit)}
        if action:
            params["action"] = action
        return self._request(self._core, "GET", path, params=params).json()

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
            params={"persona": persona},
            json=item,
        )
        return resp.json()

    def vault_query(
        self,
        persona: str,
        query: str,
        types: list[str] | None = None,
        limit: int = 50,
        extra_headers: dict[str, str] | None = None,
        session: str = "",
    ) -> list[dict]:
        """Query the vault and return matching items.

        This is an internal/admin surface; coding agents should normally use
        :meth:`ask`. When an agent does use the route, its live Core session is
        carried in the signed JSON body rather than the unsigned X-Session
        header.
        """
        body: dict[str, Any] = {
            "text": query,
            "mode": "hybrid",
            "types": types or [],
            "limit": limit,
        }
        if self._config.role == "agent":
            if not session:
                raise ValueError("agent vault query requires a session")
            body["session_id"] = session
        kwargs: dict[str, Any] = {
            "params": {"persona": persona},
            "json": body,
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
                self._core,
                "GET",
                f"/v1/vault/kv/{key}",
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

    def remember(
        self,
        text: str,
        session: str = "",
        source_id: str = "",
        metadata: str = "",
        persona: str = "",
    ) -> dict:
        """Store a memory through the route appropriate for this caller.

        Coding agents use the narrow, session-bound memory facade. User/device
        callers retain the legacy staging pipeline, which can classify the
        memory asynchronously.
        """
        if self._config.role == "agent":
            if not source_id:
                raise ValueError(
                    "agent remember requires a stable source_id/request_id for idempotency"
                )
            body: dict[str, Any] = {
                "content": text,
                "session_id": session,
                "request_id": source_id,
            }
            if persona:
                body["persona"] = persona
            resp = self._request(
                self._core,
                "POST",
                "/v1/agent/memory",
                json=body,
            )
            return resp.json()

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

    def remember_check(self, item_id: str, session: str = "") -> dict:
        """Check status of a pending remember through the caller's owned surface."""
        if self._config.role == "agent":
            resp = self._request(
                self._core,
                "POST",
                "/v1/agent/memory/status",
                json={"item_id": item_id, "session_id": session},
            )
            return resp.json()
        resp = self._request(
            self._core,
            "GET",
            f"/api/v1/remember/{item_id}",
        )
        return resp.json()

    def pii_scrub(self, text: str) -> dict:
        """Scrub PII from text."""
        path = "/v1/agent/scrub" if self._config.role == "agent" else "/v1/pii/scrub"
        resp = self._request(
            self._core,
            "POST",
            path,
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

        Core authenticates via Ed25519 signature (device auth). Agent callers
        carry the session in the signed JSON body; legacy user/device callers
        retain the compatibility header.
        """
        body = dict(event)
        extra_headers: dict[str, str] = {}
        if self._config.role == "agent":
            if not session:
                raise ValueError("agent validation requires a session")
            body["session_id"] = session
        elif session:
            extra_headers["X-Session"] = session
        resp = self._request(
            self._core,
            "POST",
            "/v1/agent/validate",
            json=body,
            headers=extra_headers if extra_headers else None,
        )
        return resp.json()

    def get_proposal_status(self, proposal_id: str, session: str = "") -> dict:
        """Poll proposal status via Core's intent proposal endpoint."""
        extra: dict[str, str] = {}
        params: dict[str, str] = {}
        if self._config.role == "agent":
            if not session:
                raise ValueError("agent proposal status requires a session")
            params["session_id"] = session
        elif session:
            extra["X-Session"] = session
        resp = self._request(
            self._core,
            "GET",
            f"/v1/intent/proposals/{proposal_id}/status",
            params=params if params else None,
            headers=extra if extra else None,
        )
        return resp.json()

    # -- Sessions --------------------------------------------------------------

    def session_start(self, name: str) -> dict:
        """Start or resume a Core session for the host task name."""
        resp = self._request(
            self._core,
            "POST",
            "/v1/session/start",
            json={"host_session_id": name},
        )
        return resp.json()

    def session_end(self, session_id: str) -> dict:
        """End a session and revoke all grants (POST /v1/session/end)."""
        resp = self._request(
            self._core,
            "POST",
            "/v1/session/end",
            json={"session_id": session_id},
        )
        return resp.json()

    def session_list(self) -> dict:
        """List this authenticated caller's active Core sessions."""
        resp = self._request(self._core, "GET", "/v1/sessions")
        return resp.json()

    # -- Connected reasoning backend -----------------------------------------

    def context_prepare(
        self,
        *,
        session: str,
        query: str,
        purpose: str = "",
        personas: list[str] | None = None,
        limit: int | None = None,
    ) -> dict:
        """Request a bounded, scrubbed context projection from Dina Core."""
        if not session or not query.strip():
            raise ValueError("context prepare requires session and query")
        body: dict[str, Any] = {
            "session_id": session,
            "query": query,
        }
        if purpose:
            body["purpose"] = purpose
        if personas is not None:
            body["personas"] = personas
        if limit is not None:
            body["limit"] = limit
        return self._request(
            self._core,
            "POST",
            "/v1/agent/context/prepare",
            json=body,
        ).json()

    def memory_propose(
        self,
        *,
        session: str,
        request_id: str,
        source_text: str,
        proposal: dict[str, Any],
    ) -> dict:
        """Submit a structured memory proposal for Core-owned validation/commit."""
        if not session or not request_id or not source_text.strip():
            raise ValueError(
                "memory propose requires session, request_id, and source_text"
            )
        return self._request(
            self._core,
            "POST",
            "/v1/agent/memory/propose",
            json={
                "session_id": session,
                "request_id": request_id,
                "source_text": source_text,
                "proposal": proposal,
            },
        ).json()

    def reasoning_status(self, backend_id: str, session: str) -> dict:
        """Return this bound backend's pending-work and availability status."""
        if not backend_id or not session:
            raise ValueError("reasoning status requires backend_id and session")
        return self._request(
            self._core,
            "GET",
            "/v1/reasoning/status",
            params={"backend_id": backend_id, "session_id": session},
        ).json()

    def reasoning_backends(self) -> dict:
        """List active connected-Brain bindings owned by this exact agent DID."""
        return self._request(
            self._core,
            "GET",
            "/v1/reasoning/backends/self",
        ).json()

    def reasoning_begin(
        self,
        *,
        backend_id: str,
        session: str,
        task_kind: str,
        input_data: Any,
        purpose: str = "",
        idempotency_key: str = "",
        personas: list[str] | None = None,
        limit: int | None = None,
        public_evidence_sources: list[str] | None = None,
    ) -> dict:
        """Create and claim one inline reasoning job for this active host turn."""
        if not backend_id or not session or not task_kind:
            raise ValueError(
                "reasoning begin requires backend_id, session, and task_kind"
            )
        body: dict[str, Any] = {
            "backend_id": backend_id,
            "session_id": session,
            "task_kind": task_kind,
            "input": input_data,
        }
        if purpose:
            body["purpose"] = purpose
        if idempotency_key:
            body["idempotency_key"] = idempotency_key
        if personas is not None:
            body["personas"] = personas
        if limit is not None:
            body["limit"] = limit
        if public_evidence_sources:
            body["public_evidence_sources"] = public_evidence_sources
        return self._request(
            self._core,
            "POST",
            "/v1/reasoning/begin",
            json=body,
        ).json()

    def reasoning_claim(
        self,
        *,
        backend_id: str,
        session: str,
        lease_ms: int = 120_000,
    ) -> dict:
        """Claim one eligible durable reasoning job for this exact backend."""
        if not backend_id or not session:
            raise ValueError("reasoning claim requires backend_id and session")
        if lease_ms < 1_000 or lease_ms > 300_000:
            raise ValueError("reasoning lease_ms must be between 1000 and 300000")
        return self._request(
            self._core,
            "POST",
            "/v1/reasoning/claim",
            json={
                "backend_id": backend_id,
                "session_id": session,
                "lease_ms": lease_ms,
            },
        ).json()

    def reasoning_heartbeat(
        self,
        *,
        task_id: str,
        backend_id: str,
        session: str,
        claim_id: str,
        context_ticket_id: str,
        lease_ms: int = 120_000,
    ) -> dict:
        """Renew an exact reasoning claim without weakening its policy snapshot."""
        if not all((task_id, backend_id, session, claim_id, context_ticket_id)):
            raise ValueError("reasoning heartbeat requires all claim identifiers")
        if lease_ms < 1_000 or lease_ms > 300_000:
            raise ValueError("reasoning lease_ms must be between 1000 and 300000")
        return self._request(
            self._core,
            "POST",
            f"/v1/reasoning/{task_id}/heartbeat",
            json={
                "backend_id": backend_id,
                "session_id": session,
                "claim_id": claim_id,
                "context_ticket_id": context_ticket_id,
                "lease_ms": lease_ms,
            },
        ).json()

    def reasoning_complete(
        self,
        *,
        task_id: str,
        backend_id: str,
        session: str,
        claim_id: str,
        context_ticket_id: str,
        execution_id: str,
        policy_snapshot_hash: str,
        context_projection_hash: str | None,
        result: Any,
        evidence_ids: list[str] | None = None,
    ) -> dict:
        """Submit a proposal for Core validation and claim-fenced completion."""
        if not all(
            (
                task_id,
                backend_id,
                session,
                claim_id,
                context_ticket_id,
                execution_id,
                policy_snapshot_hash,
            )
        ):
            raise ValueError("reasoning completion requires all claim identifiers")
        body: dict[str, Any] = {
            "backend_id": backend_id,
            "session_id": session,
            "claim_id": claim_id,
            "context_ticket_id": context_ticket_id,
            "execution_id": execution_id,
            "policy_snapshot_hash": policy_snapshot_hash,
            "context_projection_hash": context_projection_hash,
            "result": result,
        }
        if evidence_ids is not None:
            body["evidence_ids"] = evidence_ids
        return self._request(
            self._core,
            "POST",
            f"/v1/reasoning/{task_id}/complete",
            json=body,
        ).json()

    def reasoning_fail(
        self,
        *,
        task_id: str,
        backend_id: str,
        session: str,
        claim_id: str,
        context_ticket_id: str,
        error: str,
        retryable: bool,
    ) -> dict:
        """Report an exact reasoning attempt failure to Core."""
        if not all((task_id, backend_id, session, claim_id, context_ticket_id, error)):
            raise ValueError("reasoning failure requires all claim identifiers")
        return self._request(
            self._core,
            "POST",
            f"/v1/reasoning/{task_id}/fail",
            json={
                "backend_id": backend_id,
                "session_id": session,
                "claim_id": claim_id,
                "context_ticket_id": context_ticket_id,
                "error": error,
                "retryable": retryable,
            },
        ).json()

    def proposal_status(self, proposal_id: str) -> dict:
        """Poll intent proposal status (GET /v1/intent/proposals/{id}/status)."""
        resp = self._request(
            self._core,
            "GET",
            f"/v1/intent/proposals/{proposal_id}/status",
        )
        return resp.json()

    # -- Delegated tasks -------------------------------------------------------

    def claim_task(
        self, lease_seconds: int = 300, runner_filter: str = ""
    ) -> dict | None:
        """Claim the next queued delegated task (POST /v1/workflow/tasks/claim).
        If runner_filter is set, only claims tasks matching that runner.
        Returns task dict or None if no work available."""
        body: dict = {"lease_seconds": lease_seconds}
        if runner_filter:
            body["runner_filter"] = runner_filter
        resp = self._request(
            self._core,
            "POST",
            "/v1/workflow/tasks/claim",
            json=body,
        )
        if resp.status_code == 204:
            return None
        return resp.json()

    def task_heartbeat(self, task_id: str, lease_seconds: int = 300) -> None:
        """Extend lease on a claimed task (POST /v1/workflow/tasks/{id}/heartbeat)."""
        self._request(
            self._core,
            "POST",
            f"/v1/workflow/tasks/{task_id}/heartbeat",
            json={"lease_seconds": lease_seconds},
        )

    def task_complete(
        self, task_id: str, result: str, assigned_runner: str = ""
    ) -> None:
        """Mark task as completed (POST /v1/workflow/tasks/{id}/complete)."""
        body: dict = {"result": result}
        if assigned_runner:
            body["assigned_runner"] = assigned_runner
        self._request(
            self._core,
            "POST",
            f"/v1/workflow/tasks/{task_id}/complete",
            json=body,
        )

    def task_fail(self, task_id: str, error: str, assigned_runner: str = "") -> None:
        """Mark task as failed (POST /v1/workflow/tasks/{id}/fail)."""
        body: dict = {"error": error}
        if assigned_runner:
            body["assigned_runner"] = assigned_runner
        self._request(
            self._core,
            "POST",
            f"/v1/workflow/tasks/{task_id}/fail",
            json=body,
        )

    def mark_running(
        self, task_id: str, run_id: str = "", assigned_runner: str = ""
    ) -> None:
        """Mark task as running (POST /v1/workflow/tasks/{id}/running)."""
        body: dict = {"run_id": run_id}
        if assigned_runner:
            body["assigned_runner"] = assigned_runner
        self._request(
            self._core,
            "POST",
            f"/v1/workflow/tasks/{task_id}/running",
            json=body,
        )

    def task_progress(self, task_id: str, message: str) -> None:
        """Update progress on a claimed task (POST /v1/workflow/tasks/{id}/progress)."""
        self._request(
            self._core,
            "POST",
            f"/v1/workflow/tasks/{task_id}/progress",
            json={"message": message},
        )

    def get_task(self, task_id: str) -> dict | None:
        """Get a delegated task by ID (GET /v1/workflow/tasks/{id}).
        Returns None only for 404. Other errors are raised."""
        try:
            resp = self._request(
                self._core,
                "GET",
                f"/v1/workflow/tasks/{task_id}",
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
            self._core,
            "GET",
            "/v1/workflow/tasks",
            params=params,
        )
        return resp.json().get("tasks", [])

    # -- Service query (WS2 schema-driven discovery) ------------------------

    def send_service_query(
        self,
        *,
        to_did: str,
        capability: str,
        params: dict,
        session: str = "",
        request_id: str = "",
        service_name: str = "",
        ttl_seconds: int = 60,
        schema_hash: str = "",
        service_uri: str = "",
        grant_id: str = "",
        origin_channel: str = "",
    ) -> dict:
        """POST /v1/service/query — send a schema-driven service query.

        Params go structured (not flattened into the payload) so the
        provider's jsonschema validator can reject malformed requests.
        schema_hash is the canonical per-capability hash from the
        provider's published profile on AppView; providing a stale hash
        surfaces as ``schema_version_mismatch`` rather than silently
        executing against a newer schema.

        Coding agents first receive a payload-bound owner approval and must poll
        :meth:`action_status` with action ``service_invoke``. A completed action
        contains ``service_task_id``; poll :meth:`service_query_status` with that
        id for the asynchronous service result.
        """
        import uuid as _uuid

        if self._config.role == "agent" and not session:
            raise ValueError("agent service query requires a session")
        if self._config.role == "agent" and not request_id:
            raise ValueError("agent service query requires a stable request_id")

        body: dict[str, Any] = {
            "to_did": to_did,
            "capability": capability,
            "params": params,
            "ttl_seconds": ttl_seconds,
            "service_name": service_name or capability,
        }
        if schema_hash:
            body["schema_hash"] = schema_hash
        if service_uri:
            body["service_uri"] = service_uri
        if grant_id:
            body["grant_id"] = grant_id
        if origin_channel:
            body["origin_channel"] = origin_channel
        if self._config.role == "agent":
            body["session_id"] = session
            body["request_id"] = request_id
            path = "/v1/agent/service/invoke"
        else:
            body["query_id"] = str(_uuid.uuid4())
            path = "/v1/service/query"
        resp = self._request(self._core, "POST", path, json=body)
        return resp.json()

    def find_services(
        self,
        *,
        session: str,
        intent: str = "",
        capability: str = "",
        query: str = "",
        lat: float | None = None,
        lng: float | None = None,
        radius_km: float | None = None,
        limit: int = 10,
    ) -> dict:
        """Discover services through Core's bounded AppView façade."""
        if self._config.role == "agent" and not session:
            raise ValueError("agent service discovery requires a session")
        body: dict[str, Any] = {"session_id": session, "limit": limit}
        if intent:
            body["intent"] = intent
        if capability:
            body["capability"] = capability
        if query:
            body["q"] = query
        if lat is not None:
            body["lat"] = lat
        if lng is not None:
            body["lng"] = lng
        if radius_km is not None:
            body["radius_km"] = radius_km
        return self._request(
            self._core,
            "POST",
            "/v1/agent/service/search",
            json=body,
        ).json()

    def publish_service(
        self,
        *,
        rkey: str,
        config: dict,
        session: str,
        request_id: str = "",
    ) -> dict:
        """Request an owned listing save; PDS publication is asynchronous."""
        from urllib.parse import quote

        if self._config.role == "agent" and not session:
            raise ValueError("agent service publication requires a session")
        if self._config.role == "agent" and not request_id:
            raise ValueError("agent service publication requires a stable request_id")
        if self._config.role == "agent":
            return self._request(
                self._core,
                "POST",
                "/v1/agent/service/publish",
                json={
                    "session_id": session,
                    "request_id": request_id,
                    "rkey": rkey,
                    "config": config,
                },
            ).json()
        saved = self._request(
            self._core,
            "PUT",
            f"/v1/service/config/{quote(rkey, safe='')}",
            json=config,
            params={"session_id": session} if self._config.role == "agent" else None,
        ).json()
        publication = self.service_publication_status(
            rkey=rkey,
            session=session,
        )
        publication_status = publication.get("publication_status")
        messages = {
            "published": "saved locally and published",
            "not_published": "saved locally; listing is not publicly published",
            "not_configured": (
                "saved locally; public publication requires a PDS identity"
            ),
            "failed": "saved locally; publication failed",
        }
        return {
            **saved,
            **publication,
            "rkey": rkey,
            "message": messages.get(
                publication_status,
                "saved locally; publication pending",
            ),
        }

    def service_query_status(self, *, task_id: str, session: str) -> dict:
        """Read an agent-owned service query without exposing its stored params."""
        if self._config.role == "agent" and not session:
            raise ValueError("agent service status requires a session")
        return self._request(
            self._core,
            "POST",
            "/v1/agent/service/status",
            json={"session_id": session, "task_id": task_id},
        ).json()

    def service_publication_status(self, *, rkey: str, session: str) -> dict:
        """Read the durable PDS publication receipt for one owned listing."""
        if self._config.role == "agent" and not session:
            raise ValueError("agent service publication status requires a session")
        return self._request(
            self._core,
            "POST",
            "/v1/agent/service/publication-status",
            json={"session_id": session, "rkey": rkey},
        ).json()

    # -- PeerLens (bounded read + owner-approved durable publish) ----------

    def search_peerlens(
        self,
        *,
        session: str,
        query: str = "",
        category: str = "",
        domain: str = "",
        subject_type: str = "",
        sentiment: str = "",
        min_confidence: str = "",
        author_did: str = "",
        tags: list[str] | None = None,
        sort: str = "relevant",
        limit: int = 10,
    ) -> dict:
        """Search public PeerLens reviews through Core's bounded AppView proxy."""
        if not session:
            raise ValueError("PeerLens search requires a live Dina session")
        body: dict[str, Any] = {
            "session_id": session,
            "sort": sort,
            "limit": limit,
        }
        for key, value in (
            ("q", query),
            ("category", category),
            ("domain", domain),
            ("subject_type", subject_type),
            ("sentiment", sentiment),
            ("min_confidence", min_confidence),
            ("author_did", author_did),
        ):
            if value:
                body[key] = value
        if tags:
            body["tags"] = tags
        return self._request(
            self._core,
            "POST",
            "/v1/agent/peerlens/search",
            json=body,
        ).json()

    def publish_review(
        self,
        *,
        record: dict,
        session: str,
        request_id: str,
    ) -> dict:
        """Request owner approval for one public, durable PeerLens review."""
        if not session:
            raise ValueError("review publication requires a live Dina session")
        if not request_id:
            raise ValueError("review publication requires a stable request_id")
        return self._request(
            self._core,
            "POST",
            "/v1/agent/peerlens/attest",
            json={
                "session_id": session,
                "request_id": request_id,
                "record": record,
            },
        ).json()

    def review_status(self, *, request_id: str, session: str) -> dict:
        """Poll approval and durable PDS publication for one owned review."""
        if not session:
            raise ValueError("review status requires a live Dina session")
        if not request_id:
            raise ValueError("review status requires a stable request_id")
        return self._request(
            self._core,
            "POST",
            "/v1/agent/peerlens/status",
            json={"session_id": session, "request_id": request_id},
        ).json()

    # -- Vault metadata + reminders (session-scoped read projections) ------

    def list_vaults(self, *, session: str) -> dict:
        """List vault metadata and this session's read access, never contents."""
        if not session:
            raise ValueError("vault listing requires a live Dina session")
        return self._request(
            self._core,
            "POST",
            "/v1/agent/vaults",
            json={"session_id": session},
        ).json()

    def list_reminders(self, *, session: str, limit: int = 50) -> dict:
        """List active reminders from vaults readable by this exact session."""
        if not session:
            raise ValueError("reminder listing requires a live Dina session")
        if limit < 1 or limit > 100:
            raise ValueError("reminder limit must be between 1 and 100")
        return self._request(
            self._core,
            "POST",
            "/v1/agent/reminders",
            json={"session_id": session, "limit": limit},
        ).json()

    # -- Talk + delegation (owner-approved facade actions) -----------------

    def talk(
        self,
        *,
        contact: str,
        text: str,
        session: str,
        request_id: str,
        in_reply_to: str = "",
    ) -> dict:
        """Ask this Dina to send one exact message to a known contact.

        The first call normally returns ``pending_approval``. Poll
        :meth:`action_status` with the same request id; the first poll after
        owner approval performs the idempotent send.
        """
        if not session:
            raise ValueError("Talk requires a live Dina session")
        if not request_id:
            raise ValueError("Talk requires a stable request_id")
        body: dict[str, Any] = {
            "session_id": session,
            "request_id": request_id,
            "contact": contact,
            "text": text,
        }
        if in_reply_to:
            body["in_reply_to"] = in_reply_to
        return self._request(
            self._core,
            "POST",
            "/v1/agent/talk",
            json=body,
        ).json()

    def delegate(
        self,
        *,
        runner: str,
        description: str,
        input_data: dict,
        session: str,
        request_id: str,
    ) -> dict:
        """Create one owner-approved task for a named external agent runner."""
        if not session:
            raise ValueError("delegation requires a live Dina session")
        if not request_id:
            raise ValueError("delegation requires a stable request_id")
        return self._request(
            self._core,
            "POST",
            "/v1/agent/delegate",
            json={
                "session_id": session,
                "request_id": request_id,
                "runner": runner,
                "description": description,
                "input": input_data,
            },
        ).json()

    def action_status(self, *, action: str, request_id: str, session: str) -> dict:
        """Poll and idempotently continue an owner-approved facade action."""
        if action not in (
            "talk",
            "delegate",
            "service_publish",
            "service_invoke",
        ):
            raise ValueError(
                "action must be 'talk', 'delegate', 'service_publish', or "
                "'service_invoke'"
            )
        if not session:
            raise ValueError("action status requires a live Dina session")
        if not request_id:
            raise ValueError("action status requires a stable request_id")
        return self._request(
            self._core,
            "POST",
            "/v1/agent/action/status",
            json={
                "session_id": session,
                "action": action,
                "request_id": request_id,
            },
        ).json()
