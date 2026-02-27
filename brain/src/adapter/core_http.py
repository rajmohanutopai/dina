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
    /healthz                 GET    liveness probe

Scratchpad is implemented over the KV store (scratchpad:{task_id}).

Third-party imports:  httpx, structlog.
"""

from __future__ import annotations

import asyncio
import base64
import json
import re
from typing import Any

import httpx
import structlog

from ..domain.errors import (
    AuthorizationError,
    ConfigError,
    CoreUnreachableError,
    PersonaLockedError,
)

logger = structlog.get_logger(__name__)


def _normalize_path(path: str) -> str:
    """Replace dynamic path segments with placeholders for logging."""
    return re.sub(r'/v1/(vault|contacts|personas)/[^/?]+', r'/v1/\1/{id}', path)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_TIMEOUT_S = 30.0
_MAX_RETRIES = 3
_BACKOFF_BASE_S = 1.0  # 1s, 2s, 4s


class CoreHTTPClient:
    """Implements CoreClient protocol via HTTP calls to core.

    Features:
    - ``Authorization: Bearer {brain_token}`` on every request.
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

    def __init__(self, base_url: str, brain_token: str) -> None:
        if not base_url:
            raise ConfigError("CORE_URL must not be empty")
        if not brain_token:
            raise ConfigError("BRAIN_TOKEN must not be empty")
        self._base_url = base_url.rstrip("/")
        self._token = brain_token
        self._client: httpx.AsyncClient | None = None

    # -- Lifecycle -----------------------------------------------------------

    def _ensure_client(self) -> httpx.AsyncClient:
        """Lazily create the underlying httpx client."""
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                base_url=self._base_url,
                headers={"Authorization": f"Bearer {self._token}"},
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

        for attempt in range(_MAX_RETRIES):
            try:
                resp = await client.request(
                    method,
                    path,
                    json=json,
                    content=content,
                    headers=headers,
                )

                # --- Non-retryable status codes ---
                if resp.status_code == 401:
                    raise ConfigError(
                        f"Core returned HTTP 401 — BRAIN_TOKEN is invalid "
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
                    raise AuthorizationError(
                        f"Core denied access (path={_normalize_path(path)}, error={error_code or 'forbidden'})"
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

    async def get_vault_item(self, persona_id: str, item_id: str) -> dict:
        """GET /v1/vault/item/{item_id}?persona={persona_id}."""
        resp = await self._request(
            "GET",
            f"/v1/vault/item/{item_id}?persona={persona_id}",
        )
        return resp.json()

    async def store_vault_item(self, persona_id: str, item: dict) -> str:
        """POST /v1/vault/store — returns assigned item_id."""
        resp = await self._request(
            "POST",
            "/v1/vault/store",
            json={"persona": persona_id, "item": item},
        )
        data = resp.json()
        return data.get("id", data.get("item_id", ""))

    async def store_vault_batch(
        self, persona_id: str, items: list[dict]
    ) -> None:
        """POST /v1/vault/store/batch — atomic batch store."""
        await self._request(
            "POST",
            "/v1/vault/store/batch",
            json={"persona": persona_id, "items": items},
        )

    async def search_vault(
        self, persona_id: str, query: str, mode: str = "hybrid"
    ) -> list[dict]:
        """POST /v1/vault/query — hybrid FTS5 + cosine."""
        resp = await self._request(
            "POST",
            "/v1/vault/query",
            json={"persona": persona_id, "query": query, "mode": mode, "limit": 50},
        )
        data = resp.json()
        items = data.get("items", []) if isinstance(data, dict) else data
        return items if items else []

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
            return data.get("value") if isinstance(data, dict) else str(data)
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

    # -- Health --------------------------------------------------------------

    async def health(self) -> dict:
        """GET /healthz — returns ``{"status": "ok"}`` when core is live."""
        resp = await self._request("GET", "/healthz")
        return resp.json()

    # -- PII -----------------------------------------------------------------

    async def pii_scrub(self, text: str) -> dict:
        """POST /v1/pii/scrub — Tier 1 regex scrubbing via Go core."""
        resp = await self._request(
            "POST",
            "/v1/pii/scrub",
            json={"text": text},
        )
        return resp.json()

    # -- Notifications -------------------------------------------------------

    async def notify(self, device_id: str, payload: dict) -> None:
        """POST /v1/notify — broadcast notification to connected devices."""
        await self._request(
            "POST",
            "/v1/notify",
            json={"message": json.dumps(payload)},
        )

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

    async def list_contacts(self) -> list[dict]:
        """GET /v1/contacts — list all contacts from core directory."""
        resp = await self._request("GET", "/v1/contacts")
        data = resp.json()
        return data if isinstance(data, list) else []

    async def add_contact(self, did: str, name: str, trust_level: str = "unknown") -> dict:
        """POST /v1/contacts — add contact to core directory."""
        resp = await self._request(
            "POST",
            "/v1/contacts",
            json={"did": did, "name": name, "trust_level": trust_level},
        )
        return resp.json()

    async def update_contact(
        self, did: str, *, name: str = "", trust_level: str = ""
    ) -> dict:
        """PUT /v1/contacts/{did} — update contact name/trust."""
        body: dict[str, str] = {}
        if name:
            body["name"] = name
        if trust_level:
            body["trust_level"] = trust_level
        resp = await self._request("PUT", f"/v1/contacts/{did}", json=body)
        return resp.json()

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
    ) -> list[dict]:
        """POST /v1/vault/query — search vault items."""
        body: dict[str, Any] = {
            "persona": persona,
            "query": query,
            "mode": mode,
            "limit": limit,
        }
        if types:
            body["types"] = types
        resp = await self._request("POST", "/v1/vault/query", json=body)
        data = resp.json()
        items = data.get("items", []) if isinstance(data, dict) else data
        return items if items else []

    # -- Personas ------------------------------------------------------------

    async def list_personas(self) -> list[str]:
        """GET /v1/personas — list persona IDs."""
        resp = await self._request("GET", "/v1/personas")
        data = resp.json()
        return data if isinstance(data, list) else []

    # -- Devices -------------------------------------------------------------

    async def list_devices(self) -> list[dict]:
        """GET /v1/devices — list registered devices."""
        resp = await self._request("GET", "/v1/devices")
        data = resp.json()
        return data.get("devices", []) if isinstance(data, dict) else data

    async def initiate_pairing(self) -> dict:
        """POST /v1/pair/initiate — generate pairing code."""
        resp = await self._request("POST", "/v1/pair/initiate")
        return resp.json()

    async def complete_pairing(self, code: str, device_name: str,
                               public_key_multibase: str | None = None) -> dict:
        """POST /v1/pair/complete — register device."""
        body: dict = {"code": code, "device_name": device_name}
        if public_key_multibase:
            body["public_key_multibase"] = public_key_multibase
        resp = await self._request("POST", "/v1/pair/complete", json=body)
        return resp.json()

    async def revoke_device(self, token_id: str) -> None:
        """DELETE /v1/devices/{id} — revoke device."""
        await self._request("DELETE", f"/v1/devices/{token_id}")

    # -- Identity ------------------------------------------------------------

    async def get_did(self) -> dict:
        """GET /v1/did — get identity DID document."""
        resp = await self._request("GET", "/v1/did")
        return resp.json()

    # -- Dina-to-Dina messaging ----------------------------------------------

    async def send_d2d(self, to_did: str, payload: dict) -> None:
        """POST /v1/msg/send — outbound DIDComm message through core."""
        import base64

        body_b64 = base64.b64encode(json.dumps(payload).encode()).decode()
        await self._request(
            "POST",
            "/v1/msg/send",
            json={"to": to_did, "body": body_b64, "type": "dina/d2d"},
        )
