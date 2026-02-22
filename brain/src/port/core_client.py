"""Port interface for typed HTTP calls to dina-core.

Matches Brain TEST_PLAN SS7 (Core Client) and the contract in
``brain/tests/contracts.py::CoreClient``.

Implementations live in ``src/infra/`` or ``src/adapter/``; the domain
and service layers depend only on this protocol.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable


@runtime_checkable
class CoreClient(Protocol):
    """Typed async HTTP client for dina-core's REST API.

    Every method maps to a single core endpoint.  Implementations must
    handle retries, timeouts (30 s), and error classification:

    * HTTP 401 -> fatal ``ConfigError`` (bad BRAIN_TOKEN), no retry.
    * HTTP 403 -> ``PersonaLockedError``, no retry.
    * HTTP 5xx -> retry with exponential backoff (max 3 attempts).
    * Timeout  -> ``asyncio.TimeoutError`` after 30 s.
    """

    # -- Vault CRUD --

    async def get_vault_item(self, persona_id: str, item_id: str) -> dict:
        """GET /v1/vault/{persona_id}/items/{item_id}."""
        ...

    async def store_vault_item(self, persona_id: str, item: dict) -> str:
        """POST /v1/vault/{persona_id}/items — returns assigned item_id."""
        ...

    async def store_vault_batch(self, persona_id: str, items: list[dict]) -> None:
        """POST /v1/vault/{persona_id}/items/batch — atomic batch store."""
        ...

    async def search_vault(
        self, persona_id: str, query: str, mode: str = "hybrid"
    ) -> list[dict]:
        """POST /v1/vault/{persona_id}/search — hybrid FTS5 + cosine."""
        ...

    # -- Scratchpad (crash-recovery checkpoints) --

    async def write_scratchpad(
        self, task_id: str, step: int, context: dict
    ) -> None:
        """PUT /v1/scratchpad/{task_id} — write checkpoint."""
        ...

    async def read_scratchpad(self, task_id: str) -> dict | None:
        """GET /v1/scratchpad/{task_id} — latest checkpoint or None."""
        ...

    # -- Key-Value store --

    async def get_kv(self, key: str) -> str | None:
        """GET /v1/vault/kv/{key}."""
        ...

    async def set_kv(self, key: str, value: str) -> None:
        """PUT /v1/vault/kv/{key}."""
        ...

    # -- Health --

    async def health(self) -> dict:
        """GET /healthz — returns ``{"status": "ok"}`` when core is live."""
        ...

    # -- PII --

    async def pii_scrub(self, text: str) -> dict:
        """POST /v1/pii/scrub — Tier 1 regex scrubbing via Go core."""
        ...

    # -- Notifications --

    async def notify(self, device_id: str, payload: dict) -> None:
        """POST /v1/notify/{device_id} — push notification to device."""
        ...

    # -- Task queue ACK --

    async def task_ack(self, task_id: str) -> None:
        """POST /v1/task/ack — acknowledge successful task processing."""
        ...

    # -- Identity / signing --

    async def did_sign(self, data: bytes) -> bytes:
        """POST /v1/identity/sign — Ed25519 sign via core's keypair."""
        ...

    # -- Dina-to-Dina messaging --

    async def send_d2d(self, to_did: str, payload: dict) -> None:
        """POST /v1/dina/send — outbound DIDComm message through core."""
        ...
