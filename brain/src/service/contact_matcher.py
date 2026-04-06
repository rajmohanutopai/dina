"""Contact mention detection in free text.

Matches known contact names AND aliases against text using word-boundary regex.
Both map to the same DID/contact record.
Longest-match-first ordering prevents partial matches.
"""

from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class MatchedContact:
    """A contact whose name was found in the text."""
    name: str                  # display name that matched
    did: str
    relationship: str          # spouse, child, friend, etc.
    data_responsibility: str   # household, care, financial, external
    span: tuple[int, int]      # (start, end) character offsets in original text


class ContactMatcher:
    """Detects mentions of known contacts in free text.

    Builds word-boundary regex patterns from the contact list.
    Longest-match-first ordering prevents "Jo" matching inside "John".
    Minimum name length 2 characters to avoid false positives.

    Parameters
    ----------
    contacts:
        List of contact dicts with at least: name, did, relationship,
        data_responsibility. Typically from Core's GET /v1/contacts.
    """

    def __init__(self, contacts: list[dict]) -> None:
        self._patterns: list[tuple[re.Pattern, dict]] = []

        # Build patterns for names AND aliases, sorted by length (longest first).
        entries: list[tuple[str, dict]] = []
        for c in contacts:
            info = {
                "did": c.get("did", ""),
                "relationship": c.get("relationship", "unknown"),
                "data_responsibility": c.get("data_responsibility", "external"),
            }

            # Primary name.
            name = (c.get("name") or c.get("display_name") or "").strip()
            if len(name) >= 2:
                entries.append((name, {**info, "name": name}))

            # Aliases (multi-alias list from API response).
            for alias in c.get("aliases", []):
                alias = alias.strip()
                if len(alias) >= 2:
                    entries.append((alias, {**info, "name": name or alias}))

        # Sort longest-first so "my daughter" matches before "daughter",
        # and "Emma Watson" matches before "Emma".
        entries.sort(key=lambda e: len(e[0]), reverse=True)

        # Dedup: same DID + same pattern text → keep only once.
        seen: set[tuple[str, str]] = set()
        for text, info in entries:
            key = (info["did"], text.lower())
            if key in seen:
                continue
            seen.add(key)
            pattern = re.compile(
                r"\b" + re.escape(text) + r"\b",
                re.IGNORECASE,
            )
            self._patterns.append((pattern, info))

    def find_mentions(self, text: str) -> list[MatchedContact]:
        """Find all mentioned contacts in text with character positions.

        Returns one MatchedContact per match. If the same contact matches
        multiple times, each occurrence is returned. Overlapping matches
        from different contacts are resolved longest-first (shorter
        patterns skip spans already claimed by longer ones).
        """
        if not text or not self._patterns:
            return []

        results: list[MatchedContact] = []
        claimed: list[tuple[int, int]] = []  # spans already matched

        for pattern, info in self._patterns:
            for m in pattern.finditer(text):
                span = (m.start(), m.end())
                # Skip if this span overlaps with an already-claimed span.
                if any(s <= span[0] < e or s < span[1] <= e for s, e in claimed):
                    continue
                results.append(MatchedContact(
                    name=info["name"],
                    did=info["did"],
                    relationship=info["relationship"],
                    data_responsibility=info["data_responsibility"],
                    span=span,
                ))
                claimed.append(span)

        # Sort by position in text.
        results.sort(key=lambda mc: mc.span[0])
        return results
