"""Synchronous HTTP client wrapping Dina Core."""

from __future__ import annotations

import json as _json
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
        self._core = httpx.Client(
            base_url=config.core_url,
            timeout=config.timeout,
        )

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
            did, ts, sig = self._identity.sign_request(method, path, body_bytes, query=query)
            headers = kwargs.get("headers") or {}
            headers["X-DID"] = did
            headers["X-Timestamp"] = ts
            headers["X-Signature"] = sig
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
                server_msg = exc.response.json().get("error", exc.response.text)
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

    # -- Reasoning (Brain-mediated, persona-blind) -------------------------

    def reason(self, prompt: str, session: str = "") -> dict:
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
            self._core, "POST", "/api/v1/reason",
            json=body, headers=headers,
        )
        return resp.json()

    # -- Vault (admin/internal only — agents use reason()) ----------------

    def vault_store(self, persona: str, item: dict) -> dict:
        """Store an item in the vault."""
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

    def kv_get(self, key: str) -> str | None:
        """Get a KV value by key. Returns None if the key does not exist."""
        try:
            resp = self._request(self._core, "GET", f"/v1/vault/kv/{key}")
            return resp.text
        except DinaClientError as exc:
            if "HTTP 404" in str(exc):
                return None
            raise

    def kv_set(self, key: str, value: str) -> None:
        """Set a KV value."""
        self._request(
            self._core,
            "PUT",
            f"/v1/vault/kv/{key}",
            content=value,
            headers={"Content-Type": "text/plain"},
        )

    # -- PII ---------------------------------------------------------------

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

    def process_event(self, event: dict) -> dict:
        """Send an event to Core's agent validation proxy.

        Core authenticates via Ed25519 signature (device auth) and forwards
        to brain's guardian internally.
        """
        resp = self._request(
            self._core,
            "POST",
            "/v1/agent/validate",
            json=event,
        )
        return resp.json()
