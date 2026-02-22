"""Frozen dataclasses representing the core domain types for dina-brain.

Every type here is immutable (``frozen=True``) so that domain objects
cannot be accidentally mutated after construction.  Slots are enabled
for memory efficiency.

No imports from adapter/ or infra/ are permitted here.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


# ---------------------------------------------------------------------------
# Vault & Search
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class VaultItem:
    """A single item stored in the encrypted personal vault.

    Matches the schema returned by core's ``GET /v1/vault/{persona}/items/{id}``.
    """

    id: str
    type: str
    persona: str
    source: str
    source_id: str
    summary: str
    body_text: str
    timestamp: int
    ingested_at: int
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class SearchResult:
    """A single search hit combining FTS5 and cosine similarity scores.

    ``relevance`` is the merged score: ``0.4 * fts5_rank + 0.6 * cosine_similarity``.
    """

    id: str
    type: str
    summary: str
    fts5_rank: float
    cosine_similarity: float
    relevance: float


# ---------------------------------------------------------------------------
# Silence & Nudge
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class NudgePayload:
    """Context-injection payload assembled by the guardian loop.

    Delivered via WebSocket overlay when the user opens a conversation.

    Attributes:
        text:    Human-readable nudge text.
        sources: Vault item IDs or deep-link URIs used to build the nudge.
        tier:    Silence-First priority: 1 = fiduciary (interrupt),
                 2 = solicited (notify), 3 = engagement (silent/briefing).
        trigger: The event or context that caused the nudge to be assembled.
    """

    text: str
    sources: list[str]
    tier: int
    trigger: str


# ---------------------------------------------------------------------------
# Task Queue
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class TaskEvent:
    """An event received from core's task queue for brain processing.

    Attributes:
        task_id:    Unique identifier (correlates with ``dina_tasks.id``).
        type:       Task type — ``"process"`` or ``"reason"``.
        payload:    Arbitrary JSON payload from the originating event.
        attempt:    1-based retry counter.  ``attempt > 1`` means the task
                    was requeued after a previous failure or timeout.
        timeout_at: ISO-8601 timestamp after which core will requeue.
    """

    task_id: str
    type: str
    payload: dict[str, Any]
    attempt: int
    timeout_at: str


# ---------------------------------------------------------------------------
# PII
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ScrubResult:
    """Result of running the combined Tier 1 + Tier 2 PII scrubbing pipeline.

    Attributes:
        scrubbed:        Text with all detected PII replaced by tokens
                         (e.g. ``[PERSON_1]``, ``[EMAIL_1]``).
        entities:        List of detected entities, each a dict with keys
                         ``type``, ``value``, and ``token``.
        replacement_map: Mapping from token to original value, used by
                         the Entity Vault for rehydration after LLM response.
    """

    scrubbed: str
    entities: list[dict[str, str]]
    replacement_map: dict[str, str]


# ---------------------------------------------------------------------------
# LLM
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ReasonResult:
    """Result of a multi-step LLM reasoning task.

    Identical shape to ``LLMResponse`` but carries semantic intent — the
    output of a ``TaskType.REASON`` task that may span multiple scratchpad
    checkpoints.
    """

    content: str
    model: str
    tokens_in: int
    tokens_out: int
    finish_reason: str


@dataclass(frozen=True, slots=True)
class LLMResponse:
    """Raw response from a single LLM completion call.

    Used by the LLM router and client to return structured results
    regardless of which provider handled the request.
    """

    content: str
    model: str
    tokens_in: int
    tokens_out: int
    finish_reason: str


# ---------------------------------------------------------------------------
# Sync
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class SyncResult:
    """Outcome of a single sync cycle for a connector.

    Attributes:
        fetched: Number of items fetched from the external source.
        stored:  Number of items successfully stored in the vault.
        skipped: Number of items skipped (dedup, triage SKIP, etc.).
        cursor:  Updated cursor value to persist in core KV for the
                 next sync cycle.
    """

    fetched: int
    stored: int
    skipped: int
    cursor: str
