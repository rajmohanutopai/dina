"""Synchronous HTTP client wrapping Dina Core."""

from __future__ import annotations

import json as _json
import uuid
from typing import Any

import httpx

from .config import Config
from .signing import CLIIdentity


class DinaClientError(Exception):
    """Raised when a Dina API call fails."""


class DinaClient:
    """Synchronous HTTP client for Dina Core.

    All requests are authenticated via Ed25519 request signing
    (X-DID / X-Timestamp / X-Signature headers).
    """

    def __init__(self, config: Config, verbose: bool = False) -> None:
        self._identity = CLIIdentity()
        self._identity.ensure_loaded()
        self._verbose = verbose
        self._req_id = uuid.uuid4().hex[:12]
        self._core = httpx.Client(
            base_url=config.core_url,
            timeout=config.timeout,
        )

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
        """Close the underlying HTTP client."""
        self._core.close()

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
        client: httpx.Client,
        method: str,
        path: str,
        **kwargs: Any,
    ) -> httpx.Response:
        """Send a request and translate transport / HTTP errors."""
        # Sign Core requests with Ed25519.
        if client is self._core:
            body_bytes = self._extract_body(kwargs)
            # Extract query string from params if present
            query = ""
            if "params" in kwargs and kwargs["params"]:
                from urllib.parse import urlencode
                query = urlencode(kwargs["params"], doseq=True)
            did, ts, nonce, sig = self._identity.sign_request(method, path, body_bytes, query=query)
            headers = kwargs.get("headers") or {}
            headers["X-DID"] = did
            headers["X-Timestamp"] = ts
            headers["X-Nonce"] = nonce
            headers["X-Signature"] = sig
            headers["X-Request-ID"] = self._req_id
            kwargs["headers"] = headers

        if self._verbose:
            import sys
            print(f"  >> {method} {path}", file=sys.stderr)
            print(f"     DID: {kwargs.get('headers', {}).get('X-DID', 'n/a')}", file=sys.stderr)
            if "json" in kwargs:
                import json as _json
                print(f"     Body: {_json.dumps(kwargs['json'])[:200]}", file=sys.stderr)

        try:
            response = client.request(method, path, **kwargs)
            if self._verbose:
                import sys
                print(f"  << {response.status_code} ({len(response.content)} bytes)", file=sys.stderr)
                if response.status_code >= 400:
                    print(f"     Response: {response.text[:300]}", file=sys.stderr)
            response.raise_for_status()
            return response
        except httpx.ConnectError:
            raise DinaClientError(
                f"Cannot reach Dina at {client.base_url}. Is it running?"
            )
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            # Parse server error message
            try:
                err_body = exc.response.json()
                server_msg = err_body.get("error", exc.response.text)
                # Surface actionable guidance when present (e.g. migration hints).
                detail = err_body.get("message", "")
                if detail:
                    server_msg = f"{server_msg} — {detail}"
            except Exception:
                server_msg = exc.response.text.strip()
            if status == 401:
                raise DinaClientError(
                    f"Authentication failed: {server_msg}"
                ) from exc
            if status == 403:
                raise DinaClientError(
                    f"Access denied: {server_msg}"
                ) from exc
            if status >= 500:
                raise DinaClientError(
                    f"Server error ({status}): {server_msg}"
                ) from exc
            raise DinaClientError(
                f"HTTP {status}: {server_msg}"
            ) from exc

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
            data = resp.json()
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
