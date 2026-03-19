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
        """GET /v1/personas."""
        resp = self._request("GET", "/v1/personas")
        return resp.json()

    def create_persona(self, name: str, tier: str, passphrase: str) -> dict:
        """POST /v1/personas."""
        resp = self._request(
            "POST", "/v1/personas",
            json={"name": name, "tier": tier, "passphrase": passphrase},
        )
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
