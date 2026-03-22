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

    * HTTP 401 -> fatal ``ConfigError`` (service auth failure), no retry.
    * HTTP 403 -> ``PersonaLockedError``, no retry.
    * HTTP 5xx -> retry with exponential backoff (max 3 attempts).
    * Timeout  -> ``asyncio.TimeoutError`` after 30 s.
    """

    # -- Vault CRUD --

    async def get_vault_item(self, persona_id: str, item_id: str) -> dict:
        """GET /v1/vault/item/{item_id}?persona={persona_id}."""
        ...

    async def store_vault_item(self, persona_id: str, item: dict) -> str:
        """POST /v1/vault/store — returns assigned item_id."""
        ...

    async def store_vault_batch(self, persona_id: str, items: list[dict]) -> None:
        """POST /v1/vault/store/batch — atomic batch store."""
        ...

    # -- Staging --

    async def staging_ingest(self, item: dict) -> str:
        """POST /v1/staging/ingest — stage content for classification."""
        ...

    async def search_vault(
        self, persona_id: str, query: str, mode: str = "hybrid",
        embedding: list[float] | None = None,
    ) -> list[dict]:
        """POST /v1/vault/query — hybrid FTS5 + cosine."""
        ...

    # -- Scratchpad (crash-recovery checkpoints via KV) --

    async def write_scratchpad(
        self, task_id: str, step: int, context: dict
    ) -> None:
        """Write checkpoint via KV at ``scratchpad:{task_id}``."""
        ...

    async def read_scratchpad(self, task_id: str) -> dict | None:
        """Read checkpoint from KV at ``scratchpad:{task_id}``."""
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
        """POST /v1/notify — broadcast notification to connected devices."""
        ...

    # -- Task queue ACK --

    async def task_ack(self, task_id: str) -> None:
        """POST /v1/task/ack — acknowledge successful task processing."""
        ...

    # -- Identity / signing --

    async def did_sign(self, data: bytes) -> bytes:
        """POST /v1/did/sign — Ed25519 sign via core's keypair (hex encoding)."""
        ...

    # -- Personas --

    async def list_personas(self) -> list[str]:
        """GET /v1/personas — list persona IDs."""
        ...

    async def list_personas_detailed(self) -> list[dict]:
        """GET /v1/personas — return persona_details with tier + locked state."""
        ...

    # -- Vault query (typed search) --

    async def query_vault(
        self,
        persona: str,
        query: str = "",
        *,
        mode: str = "fts5",
        types: list[str] | None = None,
        limit: int = 50,
    ) -> list[dict]:
        """POST /v1/vault/query — search vault items with type filtering."""
        ...

    # -- Dina-to-Dina messaging --

    async def send_d2d(self, to_did: str, payload: dict) -> None:
        """POST /v1/msg/send — outbound DIDComm message through core."""
        ...

    # -- Reminders --

    async def store_reminder(self, reminder: dict) -> str:
        """POST /v1/reminder — store a new reminder and wake the loop."""
        ...

    async def list_pending_reminders(self) -> list[dict]:
        """GET /v1/reminders/pending — list unfired reminders."""
        ...

    async def fire_reminder(self, reminder_id: str) -> dict:
        """POST /v1/reminder/fire — simulate reminder firing (test-only)."""
        ...
