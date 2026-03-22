"""PersonaRegistry — cached metadata about installed personas.

Answers: what personas exist, what tier, is it locked.
Does NOT answer: where content should go (that's PersonaRoutingPolicy).

Queries Core's GET /v1/personas at startup, caches the result.
Refreshes on persona-related 404, explicit events, or periodic poll.

No alias logic here — aliases are owned by PersonaRoutingPolicy.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

import structlog

log = structlog.get_logger(__name__)

_PERSONA_PREFIX = "persona-"

# Conservative fallback when Core is unreachable at startup.
# Matches Core's bootstrap personas — not a hard invariant.
_FALLBACK_PERSONAS = [
    {"id": "persona-general", "name": "general", "tier": "default", "locked": False},
    {"id": "persona-work", "name": "work", "tier": "standard", "locked": False},
    {"id": "persona-health", "name": "health", "tier": "sensitive", "locked": True},
    {"id": "persona-finance", "name": "finance", "tier": "sensitive", "locked": True},
]


@dataclass(frozen=True)
class PersonaInfo:
    """Immutable snapshot of a persona's metadata."""

    id: str       # "persona-general"
    name: str     # "general"
    tier: str     # "default", "standard", "sensitive", "locked"
    locked: bool  # whether the vault is currently locked


class PersonaRegistry:
    """Dynamic persona registry — queries Core, caches locally.

    Thread-safe. Constructed once in main.py, injected into services.
    """

    def __init__(self) -> None:
        self._personas: dict[str, PersonaInfo] = {}
        self._loaded: bool = False
        self._lock = asyncio.Lock()

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def load(self, core: Any) -> None:
        """Initial load from Core. Falls back to defaults ONLY if no prior cache."""
        async with self._lock:
            try:
                raw = await core.list_personas_detailed()
                self._ingest(raw)
                self._loaded = True
                log.info(
                    "persona_registry.loaded",
                    count=len(self._personas),
                    names=list(self._personas.keys()),
                )
            except Exception as exc:
                if not self._personas:
                    # First load — no prior cache, use fallback
                    log.warning(
                        "persona_registry.bootstrap_fallback",
                        error=str(exc),
                        fallback_count=len(_FALLBACK_PERSONAS),
                    )
                    self._ingest(_FALLBACK_PERSONAS)
                else:
                    # Refresh failure — keep last known good cache
                    log.warning(
                        "persona_registry.refresh_failed_keeping_cache",
                        error=str(exc),
                        cached_count=len(self._personas),
                    )
                self._loaded = False

    async def refresh(self, core: Any) -> None:
        """Re-fetch from Core. Keeps last known good cache on failure."""
        await self.load(core)

    # ------------------------------------------------------------------
    # Queries (synchronous — read from cache)
    # ------------------------------------------------------------------

    def normalize(self, name: str) -> str:
        """Strip the persona- prefix added by Core."""
        if name.startswith(_PERSONA_PREFIX):
            return name[len(_PERSONA_PREFIX):]
        return name

    def exists(self, name: str) -> bool:
        """Check if a canonical persona name exists in Core."""
        return self.normalize(name) in self._personas

    def tier(self, name: str) -> str | None:
        """Return the tier for a persona (must be canonical name)."""
        info = self._personas.get(self.normalize(name))
        return info.tier if info else None

    def locked(self, name: str) -> bool | None:
        """Return whether a persona is locked (must be canonical name)."""
        info = self._personas.get(self.normalize(name))
        return info.locked if info else None

    def all_names(self) -> list[str]:
        """Return all known canonical persona names."""
        return list(self._personas.keys())

    def is_loaded(self) -> bool:
        """True if registry has been populated from Core (not fallback)."""
        return self._loaded

    def update_locked(self, name: str, locked: bool) -> None:
        """Update the locked state for a specific persona (event-driven)."""
        norm = self.normalize(name)
        info = self._personas.get(norm)
        if info:
            # PersonaInfo is frozen — replace it
            self._personas[norm] = PersonaInfo(
                id=info.id, name=info.name, tier=info.tier, locked=locked,
            )

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _ingest(self, raw_details: list[dict]) -> None:
        """Parse raw persona_details dicts into PersonaInfo objects."""
        self._personas.clear()
        for d in raw_details:
            name = d.get("name", "")
            if not name:
                raw_id = d.get("id", "")
                name = raw_id[len(_PERSONA_PREFIX):] if raw_id.startswith(_PERSONA_PREFIX) else raw_id
            if name:
                self._personas[name] = PersonaInfo(
                    id=d.get("id", f"{_PERSONA_PREFIX}{name}"),
                    name=name,
                    tier=d.get("tier", "default"),
                    locked=d.get("locked", False),
                )
