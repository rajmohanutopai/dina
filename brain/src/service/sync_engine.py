"""Data ingestion orchestration — the Sync Engine.

The sync engine drives the periodic ingestion pipeline:

    1. Read the last sync cursor from core KV.
    2. Fetch new items via MCP (OpenClaw connectors).
    3. Triage: classify each item as PRIMARY / THIN / SKIP.
    4. For PRIMARY items: generate summary + embedding.
    5. Store to core vault in batches of 100.
    6. Update the sync cursor.

The engine handles deduplication (by ``source_id`` upsert), cursor
persistence across restarts, and batch size capping.

Maps to Brain TEST_PLAN SS5 (Sync Engine).

No imports from adapter/ — only port protocols and domain types.
"""

from __future__ import annotations

import json
import re
from collections import OrderedDict
from typing import Any

import structlog

from ..domain.errors import DinaError, MCPError
from ..port.core_client import CoreClient
from ..port.mcp import MCPClient

log = structlog.get_logger(__name__)

# Maximum number of items per batch store call to core.
_BATCH_SIZE = 100

# Maximum dedup IDs tracked per source before eviction (MED-08).
_MAX_SEEN_PER_SOURCE = 10_000

# MCP payload validation limits (MED-17).
_MAX_ITEM_SIZE = 256 * 1024  # 256 KB per item
_MAX_ITEMS_PER_BATCH = 1000

# Sender patterns that indicate automated / no-reply email — Pass 2a.
_NOREPLY_SENDER_RE = re.compile(
    r"(?:^noreply@|^no-reply@|@notifications\.|@marketing\.|@bounce\.|^mailer-daemon@)",
    re.IGNORECASE,
)

# Subject patterns that indicate auto-generated content — Pass 2a.
_AUTO_SUBJECT_RE = re.compile(
    r"(?:weekly digest|OTP|verification code|one-time password)",
    re.IGNORECASE,
)

# Gmail categories that are bulk-filtered at Pass 1.
_BULK_CATEGORIES = frozenset({
    "PROMOTIONS",
    "SOCIAL",
    "UPDATES",
    "FORUMS",
})

# Fiduciary keywords — always INGEST regardless of other filters.
_FIDUCIARY_KEYWORDS = re.compile(
    r"(?:security alert|sign-in|login|cancel|overdrawn|overdraft|suspend|expir)",
    re.IGNORECASE,
)


def _validate_mcp_items(raw: object) -> list[dict]:
    """Validate and sanitize MCP fetch result items (MED-17)."""
    if not isinstance(raw, dict):
        log.warning("sync.mcp.invalid_response_type", extra={"type": type(raw).__name__})
        return []
    items = raw.get("items", [])
    if not isinstance(items, list):
        log.warning("sync.mcp.invalid_items_type", extra={"type": type(items).__name__})
        return []
    validated: list[dict] = []
    for i, item in enumerate(items[:_MAX_ITEMS_PER_BATCH]):
        if not isinstance(item, dict):
            log.warning("sync.mcp.invalid_item", extra={"index": i})
            continue
        try:
            if len(json.dumps(item, default=str)) > _MAX_ITEM_SIZE:
                log.warning("sync.mcp.oversized_item", extra={"index": i})
                continue
        except (TypeError, ValueError):
            log.warning("sync.mcp.unserializable_item", extra={"index": i})
            continue
        validated.append(item)
    return validated


class SyncEngine:
    """Orchestrates periodic data ingestion from external sources.

    Parameters
    ----------
    core:
        Typed HTTP client for dina-core (vault storage, KV cursors).
    mcp:
        MCP client for delegating fetch operations to OpenClaw connectors.
    llm:
        LLM router for triage classification (Pass 2b batch classify).
    """

    def __init__(
        self,
        core: CoreClient,
        mcp: MCPClient,
        llm: Any,  # LLMRouter — kept as Any to avoid circular
    ) -> None:
        self._core = core
        self._mcp = mcp
        self._llm = llm
        # In-memory dedup set for the current session (bounded, MED-08).
        self._seen_ids: dict[str, OrderedDict[str, None]] = {}

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def ingest(self, source: str, data: dict) -> str:
        """Ingest a single item. Returns the assigned ``item_id``.

        Parameters
        ----------
        source:
            Data source identifier (``"gmail"``, ``"calendar"``, etc.).
        data:
            Normalised item dict with at least ``source_id``, ``type``,
            ``summary``, and ``body_text`` keys.
        """
        source_id = data.get("source_id", "")

        # Dedup check.
        if await self.dedup(source, source_id):
            log.info("sync.ingest.duplicate", source=source, source_id=source_id)
            return source_id

        # Store in vault under the default persona.
        persona_id = data.get("persona_id", "default")
        item_id = await self._core.store_vault_item(persona_id, data)

        # Track seen ID (with bounded eviction — MED-08).
        seen = self._seen_ids.setdefault(source, OrderedDict())
        if source_id not in seen:
            if len(seen) >= _MAX_SEEN_PER_SOURCE:
                for _ in range(_MAX_SEEN_PER_SOURCE // 10):
                    if seen:
                        seen.popitem(last=False)
            seen[source_id] = None

        log.info(
            "sync.ingest.stored",
            source=source,
            source_id=source_id,
            item_id=item_id,
        )
        return item_id

    async def dedup(self, source: str, source_id: str) -> bool:
        """Check if an item is a duplicate.

        First checks the in-memory set (fast path), then falls back to
        a core vault search by ``source_id`` (cold path).

        Returns ``True`` if the item has already been ingested.
        """
        # Fast: in-memory check.
        if source_id in self._seen_ids.get(source, OrderedDict()):
            return True

        # Slow: ask core.
        try:
            results = await self._core.search_vault(
                "default", f"source_id:{source_id}", mode="exact"
            )
            if results:
                seen = self._seen_ids.setdefault(source, OrderedDict())
                if source_id not in seen:
                    if len(seen) >= _MAX_SEEN_PER_SOURCE:
                        for _ in range(_MAX_SEEN_PER_SOURCE // 10):
                            if seen:
                                seen.popitem(last=False)
                    seen[source_id] = None
                return True
        except Exception:
            # If search fails, assume not a duplicate (safe default).
            pass

        return False

    def get_cursor(self, source: str) -> str | None:
        """Get the sync cursor for a source.

        This is a synchronous convenience wrapper; the actual read
        happens in ``run_sync_cycle`` via core KV.
        """
        # This method exists for protocol compatibility; real cursor
        # reads are async and go through core KV.
        return None

    async def set_cursor(self, source: str, value: str) -> None:
        """Update the sync cursor for a source in core KV."""
        key = f"{source}_cursor"
        await self._core.set_kv(key, value)
        log.info("sync.cursor_updated", source=source, cursor=value)

    async def run_sync_cycle(self, source: str) -> dict:
        """Execute a full sync cycle for *source*.

        Steps
        -----
        1. Read last sync cursor from core KV.
        2. Fetch new items via MCP -> OpenClaw.
        3. Triage: classify PRIMARY / THIN / SKIP.
        4. For PRIMARY items: generate summary + embedding.
        5. Store to core vault in batches of 100.
        6. Update sync cursor.
        7. Return stats ``{fetched, stored, skipped, cursor}``.

        Returns
        -------
        dict
            ``{"fetched": int, "stored": int, "skipped": int, "cursor": str}``
        """
        # Step 1: Read cursor.
        cursor_key = f"{source}_cursor"
        cursor = await self._core.get_kv(cursor_key)
        log.info("sync.cycle_start", source=source, cursor=cursor)

        # Step 2: Fetch new items via MCP.
        try:
            fetch_args: dict[str, Any] = {"since": cursor} if cursor else {}
            fetch_result = await self._mcp.call_tool(
                server=source,
                tool=f"{source}_fetch",
                args=fetch_args,
            )
        except Exception as exc:
            log.error(
                "sync.fetch_failed",
                source=source,
                error=type(exc).__name__,
            )
            raise MCPError(
                f"Failed to fetch from {source}: {type(exc).__name__}"
            ) from exc

        items = _validate_mcp_items(fetch_result)

        fetched = len(items)
        stored = 0
        skipped = 0
        new_cursor = cursor or ""

        # Step 3-5: Triage and store in batches.
        batch: list[dict] = []
        for item in items:
            try:
                classification = self._triage(item)
            except Exception as exc:
                log.warning("sync.triage.error", extra={"error": type(exc).__name__})
                continue

            if classification == "SKIP":
                skipped += 1
                continue

            # PRIMARY or THIN — store it.
            batch.append(item)

            if len(batch) >= _BATCH_SIZE:
                await self._store_batch("default", batch)
                stored += len(batch)
                batch = []

        # Flush remaining batch.
        if batch:
            await self._store_batch("default", batch)
            stored += len(batch)

        # Step 6: Update cursor.
        if items:
            # Use the last item's timestamp as the new cursor.
            last_ts = items[-1].get("timestamp", "")
            if last_ts:
                new_cursor = last_ts

        if new_cursor and new_cursor != cursor:
            await self.set_cursor(source, new_cursor)

        stats = {
            "fetched": fetched,
            "stored": stored,
            "skipped": skipped,
            "cursor": new_cursor,
        }
        log.info("sync.cycle_complete", source=source, **stats)
        return stats

    # ------------------------------------------------------------------
    # Triage logic
    # ------------------------------------------------------------------

    def _triage(self, item: dict) -> str:
        """Classify an item as PRIMARY, THIN, or SKIP.

        Pass 1: Gmail category filter.
        Pass 2a: Regex sender + subject filter.
        Fiduciary override: always INGEST security / financial alerts.
        """
        subject = item.get("subject", "")
        sender = item.get("sender", "")
        category = item.get("category", "PRIMARY")

        # Fiduciary override — always INGEST regardless of sender/category.
        if _FIDUCIARY_KEYWORDS.search(subject):
            return "PRIMARY"

        # Pass 1: Bulk category filter.
        if category.upper() in _BULK_CATEGORIES:
            return "SKIP"

        # Pass 2a: Regex sender filter.
        if _NOREPLY_SENDER_RE.search(sender):
            return "SKIP"

        # Pass 2a: Regex subject filter.
        if _AUTO_SUBJECT_RE.search(subject):
            return "SKIP"

        # Default: PRIMARY (will be fully ingested).
        return "PRIMARY"

    # ------------------------------------------------------------------
    # Batch storage
    # ------------------------------------------------------------------

    async def _store_batch(
        self, persona_id: str, items: list[dict]
    ) -> None:
        """Store a batch of items to core vault.

        Retries once on failure (atomic — all or nothing on core side).
        """
        try:
            await self._core.store_vault_batch(persona_id, items)
        except Exception:
            log.warning(
                "sync.batch_retry",
                persona_id=persona_id,
                batch_size=len(items),
            )
            # Single retry for transient failures.
            await self._core.store_vault_batch(persona_id, items)

        # Track seen IDs (with bounded eviction — MED-08).
        for item in items:
            source = item.get("source", "unknown")
            source_id = item.get("source_id", "")
            if source_id:
                seen = self._seen_ids.setdefault(source, OrderedDict())
                if source_id not in seen:
                    if len(seen) >= _MAX_SEEN_PER_SOURCE:
                        for _ in range(_MAX_SEEN_PER_SOURCE // 10):
                            if seen:
                                seen.popitem(last=False)
                    seen[source_id] = None
