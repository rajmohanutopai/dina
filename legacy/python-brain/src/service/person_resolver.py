"""Person surface resolver for recall expansion.

Resolves query text against confirmed person surfaces to find
synonym sets for search expansion. Uses the shared SurfaceMatcher
infrastructure (word-boundary regex, longest-match-first).

Only confirmed surfaces are used for expansion. Suggested surfaces
are excluded to prevent false-merge-driven recall errors.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

import structlog

log = structlog.get_logger(__name__)


@dataclass(frozen=True)
class ResolvedPerson:
    """A person resolved from a query surface."""
    person_id: str
    canonical_name: str
    surfaces: list[str]        # all confirmed surface forms
    contact_did: str = ""      # linked contact DID if any
    relationship_hint: str = ""


class PersonResolver:
    """Resolves person mentions in text and provides synonym sets for recall.

    Parameters
    ----------
    core:
        Core HTTP client for fetching person data.
    """

    def __init__(self, core: Any) -> None:
        self._core = core
        self._cache: dict[str, list[dict]] = {}  # normalized surface → person surface records
        self._people: dict[str, dict] = {}        # person_id → person record
        self._patterns: list[tuple[re.Pattern, str, str]] = []  # (pattern, normalized, person_id)

    async def refresh(self) -> None:
        """Reload confirmed person surfaces from Core."""
        try:
            resp = await self._core._request("GET", "/v1/people")
            people = resp.json().get("people", [])
        except Exception as exc:
            log.warning("person_resolver.refresh_failed", error=str(exc))
            return

        self._cache.clear()
        self._people.clear()
        self._patterns.clear()

        entries: list[tuple[str, str, str]] = []  # (surface_text, normalized, person_id)

        for p in people:
            pid = p.get("person_id", "")
            if not pid or p.get("status") == "rejected":
                continue
            self._people[pid] = p

            for s in p.get("surfaces", []):
                if s.get("status") != "confirmed":
                    continue
                surface = s.get("surface", "").strip()
                normalized = surface.lower().strip()
                if len(normalized) < 2:
                    continue

                self._cache.setdefault(normalized, []).append(s)
                entries.append((surface, normalized, pid))

        # Build regex patterns: longest-first, word-boundary.
        entries.sort(key=lambda e: len(e[0]), reverse=True)
        seen: set[tuple[str, str]] = set()
        for surface, normalized, pid in entries:
            key = (normalized, pid)
            if key in seen:
                continue
            seen.add(key)
            pattern = re.compile(r"\b" + re.escape(surface) + r"\b", re.IGNORECASE)
            self._patterns.append((pattern, normalized, pid))

    def resolve(self, text: str) -> list[ResolvedPerson]:
        """Find person mentions in text and return resolved persons with synonym sets.

        Only confirmed surfaces are matched. Returns one ResolvedPerson per
        matched person (deduped by person_id).
        """
        if not text or not self._patterns:
            return []

        matched_pids: dict[str, ResolvedPerson] = {}
        claimed: list[tuple[int, int]] = []

        for pattern, normalized, pid in self._patterns:
            for m in pattern.finditer(text):
                span = (m.start(), m.end())
                if any(s <= span[0] < e or s < span[1] <= e for s, e in claimed):
                    continue
                claimed.append(span)

                if pid not in matched_pids:
                    person = self._people.get(pid, {})
                    # Gather all confirmed surfaces for this person.
                    all_surfaces = []
                    for s in person.get("surfaces", []):
                        if s.get("status") == "confirmed":
                            all_surfaces.append(s.get("surface", ""))

                    matched_pids[pid] = ResolvedPerson(
                        person_id=pid,
                        canonical_name=person.get("canonical_name", ""),
                        surfaces=all_surfaces,
                        contact_did=person.get("contact_did", ""),
                        relationship_hint=person.get("relationship_hint", ""),
                    )

        return list(matched_pids.values())

    def expand_search_terms(self, text: str) -> list[str]:
        """Given query text, return expanded search terms from person synonyms.

        For each person mentioned, includes all their confirmed surfaces.
        """
        resolved = self.resolve(text)
        terms = []
        for rp in resolved:
            for surface in rp.surfaces:
                if surface.lower() not in text.lower():
                    terms.append(surface)
        return terms
