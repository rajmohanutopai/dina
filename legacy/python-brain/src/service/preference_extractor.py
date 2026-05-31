"""Extract user-asserted preference bindings from captured memory.

When the user writes something like "my dentist Dr Carl is on April 19"
or "my accountant is Linda Smith", they're *asserting* a preference:
"Dr Carl is who I go to for dental things." The `PreferenceExtractor`
surfaces those assertions so the staging processor can update the
matched contact's ``preferred_for`` list.

Regex-based on purpose — deterministic, no LLM spend, and good enough
for the common phrasings. LLM augmentation (catching more creative
phrasings like "I've been seeing Dr Patel for my teeth for years") can
be a follow-up layer, called only when regex finds nothing.

See docs/WORKING_MEMORY_DESIGN.md §6.1 for why this replaces the old
auto-enriched ``live_capability`` stamp on ToC entries — capability
metadata belongs in AppView; user preference belongs on the contact.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass


log = logging.getLogger(__name__)


# Role word → category (or categories) it implies. Lowercase keys.
# Categories are the values that end up in Contact.preferred_for, so
# they should be stable, human-readable, lowercase strings. Keep the
# list conservative — adding a role is cheap; removing one later is
# painful (back-fill implications).
_ROLE_TO_CATEGORIES: dict[str, tuple[str, ...]] = {
    "dentist": ("dental",),
    "doctor": ("medical",),
    "physician": ("medical",),
    "gp": ("medical",),
    "paediatrician": ("pediatric",),
    "pediatrician": ("pediatric",),
    "accountant": ("tax", "accounting"),
    "cpa": ("tax", "accounting"),
    "lawyer": ("legal",),
    "attorney": ("legal",),
    "mechanic": ("automotive",),
    "plumber": ("plumbing",),
    "electrician": ("electrical",),
    "vet": ("veterinary",),
    "veterinarian": ("veterinary",),
    "barber": ("hair",),
    "hairdresser": ("hair",),
    "stylist": ("hair",),
    "therapist": ("mental_health",),
    "psychiatrist": ("mental_health",),
    "psychologist": ("mental_health",),
    "trainer": ("fitness",),
    "coach": ("fitness",),
    "pharmacist": ("pharmacy",),
    "optometrist": ("optical",),
    "chiropractor": ("chiropractic",),
    "physiotherapist": ("physiotherapy",),
    "physio": ("physiotherapy",),
    "realtor": ("real_estate",),
    "broker": ("real_estate",),
    "banker": ("banking",),
    "florist": ("floral",),
    "tailor": ("tailoring",),
    "architect": ("architecture",),
    "contractor": ("construction",),
    "landscaper": ("landscaping",),
    "gardener": ("landscaping",),
    "nanny": ("childcare",),
    "babysitter": ("childcare",),
    "tutor": ("education",),
    "teacher": ("education",),
}


# ----- Patterns -----------------------------------------------------------
#
# Two phrasings cover almost everything we've seen in captured memory:
#
#   1. "my <role> <Name>"        — "my dentist Dr Carl", "my lawyer Kate Jones"
#   2. "my <role> is <Name>"     — "my dentist is Dr Carl"
#
# The name group is lenient: allow an optional title (Dr, Dr., Mr, Mrs,
# Ms, Prof), then 1–3 capitalised words. Matches single-word first names
# ("Linda"), last-name-only forms ("Dr Patel"), and standard
# "Firstname Lastname" pairs. It explicitly avoids grabbing lowercase
# trailing verbs ("my dentist Dr Carl is on April 19" → name stops at
# "Dr Carl", not "Dr Carl is on April 19").
#
# Both patterns require the role word to be followed by at least one
# space, so "my dentistry" won't fire for role=dentist.

_ROLE_ALTERNATION = "|".join(
    sorted((re.escape(r) for r in _ROLE_TO_CATEGORIES.keys()), key=len, reverse=True)
)

# The `my` anchor and role word are case-insensitive (users write "my"
# or "My"; roles are usually lowercase). The name portion is
# deliberately case-SENSITIVE so capitalised proper nouns anchor the
# match and prevent the regex from grabbing trailing lowercase words
# ("is", "on", "about"). Python's inline flag syntax `(?i:...)` and
# `(?-i:...)` scope the flag per-group.
_ROLE_CI = rf"(?i:{_ROLE_ALTERNATION})"
_TITLE_CI = r"(?i:(?:Dr\.?|Mr\.?|Mrs\.?|Ms\.?|Prof\.?))"
_NAME_CS = r"[A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){0,2}"

_PATTERN_DIRECT = re.compile(
    rf"(?i:\bmy)\s+((?i:{_ROLE_ALTERNATION}))\s+({_TITLE_CI}\s+)?({_NAME_CS})"
)

_PATTERN_IS = re.compile(
    rf"(?i:\bmy)\s+((?i:{_ROLE_ALTERNATION}))\s+(?i:is)\s+({_TITLE_CI}\s+)?({_NAME_CS})"
)

# "my <role> ... with <Name>" — matches phrasings like
# "my dentist appointment with Dr Carl", "my lawyer consultation
# with Kate Jones", "my trainer session with Aaron". The `.{0,60}?`
# bridges an arbitrary short run of filler words (appointment,
# meeting, consultation, session, call, etc.) without anchoring on a
# specific vocabulary. Non-greedy so it stops at the first "with".
_PATTERN_WITH = re.compile(
    rf"(?i:\bmy)\s+((?i:{_ROLE_ALTERNATION}))\s+[a-z]+(?:\s+[a-z]+){{0,3}}?\s+(?i:with)\s+"
    rf"({_TITLE_CI}\s+)?({_NAME_CS})"
)


@dataclass(frozen=True)
class PreferenceCandidate:
    """A surface-level (role, name, categories) tuple extracted from text.

    The caller is responsible for resolving ``name`` to a contact DID
    (via the contact directory + aliases) and merging ``categories``
    into that contact's existing ``preferred_for`` list. The extractor
    does no storage.
    """
    role: str
    name: str
    categories: tuple[str, ...]


class PreferenceExtractor:
    """Regex-based extractor for user-asserted preference bindings.

    Stateless — safe to share across threads / concurrent calls.
    """

    def __init__(self) -> None:
        # Kept as attributes for easy override in tests / subclasses.
        self._pattern_direct = _PATTERN_DIRECT
        self._pattern_is = _PATTERN_IS
        self._pattern_with = _PATTERN_WITH
        self._role_map = _ROLE_TO_CATEGORIES

    def extract(self, text: str) -> list[PreferenceCandidate]:
        """Return all preference candidates found in ``text``.

        Deduplicates by (role, lowercased-name): if the same assertion
        appears twice in one item ("My dentist Dr Carl. I saw my
        dentist Dr Carl yesterday."), it only counts once.

        Candidates with an unknown role are never emitted — the regex
        restricts matches to our role alternation, so this is enforced
        at the pattern level rather than as a post-filter.
        """
        if not text:
            return []

        seen: set[tuple[str, str]] = set()
        out: list[PreferenceCandidate] = []

        # Order matters: `is` and `with` forms are more specific than the
        # direct form, so they run first. Dedup below collapses
        # overlapping matches by (role, name).
        for pattern in (self._pattern_is, self._pattern_with, self._pattern_direct):
            for match in pattern.finditer(text):
                role_word = match.group(1).lower()
                # Groups 2 (title) and 3 (name) for the `is` and direct
                # patterns alike — both use the same name sub-group shape.
                title = (match.group(2) or "").strip()
                name = match.group(3).strip()
                full_name = f"{title} {name}".strip() if title else name
                key = (role_word, full_name.lower())
                if key in seen:
                    continue
                seen.add(key)
                cats = self._role_map.get(role_word)
                if not cats:
                    continue
                out.append(PreferenceCandidate(
                    role=role_word,
                    name=full_name,
                    categories=cats,
                ))

        return out

    @property
    def known_roles(self) -> tuple[str, ...]:
        """Sorted tuple of role words the extractor will recognise.

        Exposed for diagnostics / admin UI listings. Tests also lock
        against this to catch accidental role drift.
        """
        return tuple(sorted(self._role_map.keys()))

    def categories_for_role(self, role: str) -> tuple[str, ...]:
        """Look up categories for a role, or empty tuple if unknown."""
        return self._role_map.get(role.lower(), ())
