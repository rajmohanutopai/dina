"""Synchronous client for Dina Core admin endpoints via Unix domain socket.

Socket access = admin auth. No token needed.
Runs inside the Core container: docker compose exec core dina-admin ...
"""

from __future__ import annotations

from typing import Any

import httpx

from .config import Config


class AdminClientError(Exception):
    """Raised when a Dina admin API call fails."""


class AdminClient:
    """Synchronous client for Dina Core admin operations over Unix socket."""

    def __init__(self, config: Config) -> None:
        self._config = config
        transport = httpx.HTTPTransport(uds=config.socket_path)
        self._http = httpx.Client(
            base_url="http://localhost",  # required by httpx, ignored for UDS
            transport=transport,
            timeout=config.timeout,
        )

    # -- Context manager support ------------------------------------------

    def __enter__(self) -> AdminClient:
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def close(self) -> None:
        """Close the underlying HTTP client."""
        self._http.close()

    # -- Private helpers ---------------------------------------------------

    def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        """Send a request and translate transport / HTTP errors."""
        try:
            response = self._http.request(method, path, **kwargs)
            response.raise_for_status()
            return response
        except httpx.ConnectError as exc:
            raise AdminClientError(
                f"Cannot connect to socket at {self._config.socket_path}. "
                "Is Core running?"
            ) from exc
        except FileNotFoundError:
            raise AdminClientError(
                f"Socket not found at {self._config.socket_path}. Is Core running?"
            )
        except PermissionError:
            raise AdminClientError(
                f"Permission denied on {self._config.socket_path}."
            )
        except ConnectionRefusedError:
            raise AdminClientError(
                f"Core not listening on {self._config.socket_path}."
            )
        except httpx.TimeoutException as exc:
            raise AdminClientError(
                f"Request timed out on {self._config.socket_path}."
            ) from exc
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            if status == 501:
                raise AdminClientError(
                    "Not implemented on this Core version"
                ) from exc
            if status >= 500:
                raise AdminClientError(f"Server error ({status})") from exc
            raise AdminClientError(
                f"HTTP {status}: {exc.response.text}"
            ) from exc
        except httpx.RequestError as exc:
            raise AdminClientError(
                f"Request failed on {self._config.socket_path}: {exc}"
            ) from exc

    # -- Health -----------------------------------------------------------

    def healthz(self) -> dict:
        """GET /healthz — liveness probe."""
        resp = self._request("GET", "/healthz")
        try:
            return resp.json()
        except Exception:
            return {"status": resp.text.strip() or "ok"}

    def readyz(self) -> dict:
        """GET /readyz — readiness probe."""
        resp = self._request("GET", "/readyz")
        try:
            return resp.json()
        except Exception:
            return {"status": resp.text.strip() or "ok"}

    # -- Personas ---------------------------------------------------------

    def list_personas(self) -> list:
        """GET /v1/personas — returns persona_details (enriched) or personas (string IDs)."""
        resp = self._request("GET", "/v1/personas")
        data = resp.json()
        # Prefer persona_details (has name, tier, locked); fall back to personas (string IDs).
        if isinstance(data, dict):
            details = data.get("persona_details")
            if details:
                return details
            # Fallback: wrap string IDs as dicts for consistent downstream use.
            return [{"id": p, "name": p.replace("persona-", ""), "tier": "?"} for p in data.get("personas", [])]
        return data

    def create_persona(self, name: str, tier: str, passphrase: str, description: str = "") -> dict:
        """POST /v1/personas."""
        body: dict = {"name": name, "tier": tier, "passphrase": passphrase}
        if description:
            body["description"] = description
        resp = self._request("POST", "/v1/personas", json=body)
        return resp.json()

    def edit_persona(self, persona: str, description: str = "") -> dict:
        """POST /v1/persona/edit — update persona metadata."""
        body: dict = {"persona": persona}
        if description:
            body["description"] = description
        resp = self._request("POST", "/v1/persona/edit", json=body)
        return resp.json()

    def unlock_persona(self, persona: str, passphrase: str) -> dict:
        """POST /v1/persona/unlock."""
        resp = self._request(
            "POST", "/v1/persona/unlock",
            json={"persona": persona, "passphrase": passphrase},
        )
        return resp.json()

    # -- Devices ----------------------------------------------------------

    def list_devices(self) -> dict:
        """GET /v1/devices."""
        resp = self._request("GET", "/v1/devices")
        return resp.json()

    def initiate_pairing(self) -> dict:
        """POST /v1/pair/initiate — generate a 6-digit pairing code."""
        resp = self._request("POST", "/v1/pair/initiate")
        return resp.json()

    def revoke_device(self, device_id: str) -> None:
        """DELETE /v1/devices/{id}."""
        self._request("DELETE", f"/v1/devices/{device_id}")

    # -- Identity ---------------------------------------------------------

    def get_did(self) -> dict:
        """GET /v1/did — retrieve the node's DID document."""
        resp = self._request("GET", "/v1/did")
        return resp.json()

    def sign_data(self, data: str) -> dict:
        """POST /v1/did/sign — sign with the node's Ed25519 key."""
        resp = self._request("POST", "/v1/did/sign", json={"data": data})
        return resp.json()

    # -- Approvals --------------------------------------------------------

    def list_approvals(self) -> list:
        """GET /v1/approvals — list all pending approval requests."""
        resp = self._request("GET", "/v1/approvals")
        data = resp.json()
        return data.get("approvals", data) if isinstance(data, dict) else data

    def approve(self, approval_id: str, scope: str = "session") -> dict:
        """POST /v1/approvals/{id}/approve — approve a pending request."""
        resp = self._request(
            "POST", f"/v1/approvals/{approval_id}/approve",
            json={"scope": scope, "granted_by": "dina-admin"},
        )
        return resp.json()

    def deny(self, approval_id: str) -> dict:
        """POST /v1/approvals/{id}/deny — deny a pending request."""
        resp = self._request(
            "POST", f"/v1/approvals/{approval_id}/deny",
        )
        return resp.json()

    # -- vault ---------------------------------------------------------------

    def vault_query(
        self, persona: str, query: str = "", mode: str = "fts5",
        limit: int = 20, offset: int = 0,
    ) -> list:
        """POST /v1/vault/query — search or list a persona vault."""
        body: dict = {
            "persona": persona,
            "query": query,
            "mode": mode,
            "limit": limit,
            "include_all": True,
        }
        if offset > 0:
            body["offset"] = offset
        resp = self._request("POST", "/v1/vault/query", json=body)
        data = resp.json()
        return data.get("items", data) if isinstance(data, dict) else data

    def vault_delete(self, persona: str, item_id: str) -> None:
        """DELETE /v1/vault/item/{id}?persona={persona} — delete a vault item."""
        self._request("DELETE", f"/v1/vault/item/{item_id}", params={"persona": persona})

    # -- KV (admin-prefixed keys) ------------------------------------------

    def get_kv(self, key: str) -> str | None:
        """GET /v1/vault/kv/{key} — retrieve a KV value (None if missing)."""
        try:
            resp = self._request("GET", f"/v1/vault/kv/{key}")
            data = resp.json()
            return data.get("value")
        except AdminClientError as exc:
            if "404" in str(exc):
                return None
            raise

    def set_kv(self, key: str, value: str) -> None:
        """PUT /v1/vault/kv/{key} — store a KV value."""
        self._request("PUT", f"/v1/vault/kv/{key}", json={"value": value})

    # -- ask / remember (same path as CLI — Core proxies to Brain) ----------

    def ask(self, text: str, session: str = "admin") -> dict:
        """POST /api/v1/ask — vault-enriched reasoning via Brain."""
        resp = self._request("POST", "/api/v1/ask", json={
            "prompt": text,
            "session": session,
            "source": "admin",
        }, timeout=60.0)
        return resp.json()

    def remember(self, text: str, session: str = "admin") -> dict:
        """POST /api/v1/remember — store a memory via staging pipeline."""
        import time as _time
        resp = self._request("POST", "/api/v1/remember", json={
            "text": text,
            "session": session,
            "source": "admin",
            "source_id": f"admin-{int(_time.time() * 1000)}",
        }, timeout=30.0)
        return resp.json()

    # -- D2D inbox --------------------------------------------------------

    def inbox(self) -> dict:
        """GET /v1/msg/inbox — list received D2D messages."""
        resp = self._request("GET", "/v1/msg/inbox")
        return resp.json()
