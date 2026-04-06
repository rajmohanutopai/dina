"""Per-fact subject ownership attribution for persona routing.

Deterministic layer — works without LLM. Detects WHO a sensitive fact
belongs to by analyzing subject references near each keyword hit.

Five ownership buckets:
  self_explicit       — "I have", "my blood pressure"
  household_implicit  — "my daughter has", "my son's"
  known_contact       — matched by ContactMatcher
  unknown_third_party — role phrases: "my colleague", "my mother"
  unresolved          — pronouns or unknown proper names

The LLM layer (persona_selector) can refine these attributions via
stable-ID corrections. This module provides the deterministic floor.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .contact_matcher import ContactMatcher, MatchedContact
from .sensitive_signals import SensitiveHit, find_sensitive_hits


# ---------------------------------------------------------------------------
# Subject ownership buckets
# ---------------------------------------------------------------------------

SELF_EXPLICIT = "self_explicit"
HOUSEHOLD_IMPLICIT = "household_implicit"
KNOWN_CONTACT = "known_contact"
UNKNOWN_THIRD_PARTY = "unknown_third_party"
UNRESOLVED = "unresolved"


@dataclass(frozen=True)
class FactAttribution:
    """Attribution of one sensitive fact to one subject."""
    hit: SensitiveHit                        # the sensitive keyword hit
    subject_bucket: str                      # one of the 5 buckets
    contact: MatchedContact | None = None    # set for known_contact
    data_responsibility: str = "external"    # routing signal


# ---------------------------------------------------------------------------
# Regex patterns for subject detection
# ---------------------------------------------------------------------------

# First-person references (self_explicit).
_SELF_PATTERN = re.compile(
    r"\b(?:I\s+(?:have|am|need|take|got|was)|"
    r"[Mm]y\s+(?!daughter|son|wife|husband|spouse|child|kid|baby|"
    r"colleague|friend|boss|coworker|neighbor|"
    r"mother|father|brother|sister|uncle|aunt)(?:\w+)|"
    r"[Mm]ine|[Oo]ur\s)\b",
    re.IGNORECASE,
)

# Simpler self-possessive for "my blood pressure", "my prescription".
_MY_PATTERN = re.compile(r"\b[Mm]y\b")

# Household kinship (household_implicit).
_HOUSEHOLD_KINSHIP = re.compile(
    r"\b[Mm]y\s+(?:daughter|son|wife|husband|spouse|child|kid|baby)(?:'s)?\b",
    re.IGNORECASE,
)

# Role-based third-party phrases (unknown_third_party).
_ROLE_THIRD_PARTY = re.compile(
    r"\b[Mm]y\s+(?:colleague|friend|boss|coworker|neighbor|"
    r"mother|father|brother|sister|uncle|aunt|grandma|grandmother|"
    r"grandpa|grandfather|mom|dad)(?:'s)?\b",
    re.IGNORECASE,
)

# Pronouns (unresolved unless carry-forward applies).
_PRONOUN_SUBJECT = re.compile(
    r"\b(?:[Hh]e|[Ss]he|[Tt]hey|[Hh]is|[Hh]er|[Tt]heir)\b",
)

# Personal state/measurement patterns — used to distinguish self-facts
# from generic topical mentions when no explicit subject is found.
_PERSONAL_STATE = re.compile(
    r"(?:"
    r"\b(?:is|was|are)\s+\d"  # "is 130", "was 85" — no trailing \b (digits continue)
    r"|\bdue\s+(?:Friday|Monday|Tuesday|Wednesday|Thursday|Saturday|Sunday|"
    r"tomorrow|next|this|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b"
    r"|\b(?:prescribed|diagnosed|need\s+to\s+refill|need\s+to\s+schedule|"
    r"need\s+to\s+renew|need\s+to\s+pay|"
    r"appointment|scheduled|booked|expires|renewal)\b"
    r")",
    re.IGNORECASE,
)

# Sentence boundary splitter.
_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")


# ---------------------------------------------------------------------------
# Core attribution logic
# ---------------------------------------------------------------------------


class SubjectAttributor:
    """Detects subject ownership for each sensitive fact in text.

    Parameters
    ----------
    contact_matcher:
        ContactMatcher instance built from the user's contact list.
    """

    def __init__(self, contact_matcher: ContactMatcher | None = None) -> None:
        self._matcher = contact_matcher

    def attribute(self, text: str) -> list[FactAttribution]:
        """Detect sensitive hits and attribute each to a subject.

        Algorithm:
        1. Find all sensitive keyword hits (spans) via find_sensitive_hits()
        2. For each hit, find the nearest governing subject
        3. Return one or more FactAttributions per hit (coordinated subjects
           produce multiple attributions for a single hit)
        """
        if not text:
            return []

        hits = find_sensitive_hits(text)
        if not hits:
            return []

        # Find all contact mentions once (reused across hits).
        contact_mentions = self._matcher.find_mentions(text) if self._matcher else []

        # Find all subject reference spans in the text.
        subject_refs = self._find_all_subject_refs(text, contact_mentions)

        attributions: list[FactAttribution] = []
        for hit in hits:
            hit_attrs = self._bind_subjects(hit, text, subject_refs)
            attributions.extend(hit_attrs)

        return attributions

    def _find_all_subject_refs(
        self, text: str, contact_mentions: list[MatchedContact]
    ) -> list[_SubjectRef]:
        """Find all subject references in the text.

        Precedence: stored contact/alias > kinship pattern > role pattern > self > pronoun.
        A span claimed by a higher-priority match is skipped by lower-priority patterns.
        """
        refs: list[_SubjectRef] = []
        claimed_spans: list[tuple[int, int]] = []

        def _overlaps(span: tuple[int, int]) -> bool:
            return any(s <= span[0] < e or s < span[1] <= e for s, e in claimed_spans)

        # 1. Known contacts (highest priority — includes alias matches).
        # Stored alias wins over kinship regex.
        for mc in contact_mentions:
            refs.append(_SubjectRef(
                span=mc.span,
                bucket=KNOWN_CONTACT,
                contact=mc,
                data_responsibility=mc.data_responsibility,
            ))
            claimed_spans.append(mc.span)

        # 2. Household kinship (fallback — only if not already a contact match).
        for m in _HOUSEHOLD_KINSHIP.finditer(text):
            span = (m.start(), m.end())
            if _overlaps(span):
                continue  # span claimed by a contact alias
            refs.append(_SubjectRef(
                span=span,
                bucket=HOUSEHOLD_IMPLICIT,
                contact=None,
                data_responsibility="household",
            ))
            claimed_spans.append(span)

        # 3. Role-based third-party (fallback).
        for m in _ROLE_THIRD_PARTY.finditer(text):
            span = (m.start(), m.end())
            if _overlaps(span):
                continue
            refs.append(_SubjectRef(
                span=span,
                bucket=UNKNOWN_THIRD_PARTY,
                contact=None,
                data_responsibility="external",
            ))
            claimed_spans.append(span)

        # 4. Self-possessive "my" (only if not captured by kinship/role/contact).
        for m in _MY_PATTERN.finditer(text):
            span = (m.start(), m.end())
            # Skip if this "my" is part of a kinship or role phrase already captured.
            if any(r.span[0] <= span[0] < r.span[1] for r in refs):
                continue
            refs.append(_SubjectRef(
                span=span,
                bucket=SELF_EXPLICIT,
                contact=None,
                data_responsibility="self",
            ))

        # 5. First-person "I have", "I am", "I need"
        for m in re.finditer(r"\b[Ii]\s+(?:have|am|need|take|got|was)\b", text):
            span = (m.start(), m.end())
            if _overlaps(span):
                continue
            refs.append(_SubjectRef(
                span=span,
                bucket=SELF_EXPLICIT,
                contact=None,
                data_responsibility="self",
            ))

        # 6. Pronouns (lowest priority)
        for m in _PRONOUN_SUBJECT.finditer(text):
            span = (m.start(), m.end())
            if _overlaps(span):
                continue
            refs.append(_SubjectRef(
                span=span,
                bucket=UNRESOLVED,
                contact=None,
                data_responsibility="unresolved",
            ))

        refs.sort(key=lambda r: r.span[0])
        return refs

    def _bind_subjects(
        self,
        hit: SensitiveHit,
        text: str,
        subject_refs: list[_SubjectRef],
    ) -> list[FactAttribution]:
        """Bind one sensitive hit to its governing subject(s).

        Nearest-governing-subject rule: scan leftward from the hit for
        subject references. Coordinated subjects ("X and Y have ...")
        each get an independent attribution.
        """
        hit_start = hit.span[0]

        # Find the sentence containing this hit.
        sentences = _SENTENCE_SPLIT.split(text)
        sent_start = 0
        sent_text = text
        for s in sentences:
            s_end = sent_start + len(s)
            if sent_start <= hit_start < s_end:
                sent_text = s
                break
            sent_start = s_end + 1  # +1 for the space after sentence boundary

        # Find subject refs in this sentence, to the LEFT of the hit.
        candidates: list[_SubjectRef] = []
        for ref in subject_refs:
            if ref.span[0] >= sent_start and ref.span[1] <= sent_start + len(sent_text):
                if ref.span[0] < hit_start:
                    candidates.append(ref)

        if not candidates:
            # No subject found. Apply no-subject rule:
            # Personal state pattern → self_explicit, else → unresolved.
            if _PERSONAL_STATE.search(sent_text):
                return [FactAttribution(
                    hit=hit, subject_bucket=SELF_EXPLICIT,
                    data_responsibility="self",
                )]
            return [FactAttribution(
                hit=hit, subject_bucket=UNRESOLVED,
                data_responsibility="unresolved",
            )]

        # Check for coordinated subjects that GOVERN this specific hit.
        # Only subjects immediately preceding the hit (no intervening non-coordinated
        # subject) can be coordinated for it.
        coordinated = self._find_coordinated_subjects_for_hit(candidates, text, hit)
        if coordinated and len(coordinated) > 1:
            # Each coordinated subject gets its own attribution.
            return [
                FactAttribution(
                    hit=hit,
                    subject_bucket=ref.bucket,
                    contact=ref.contact,
                    data_responsibility=ref.data_responsibility,
                )
                for ref in coordinated
            ]

        # Single nearest subject (closest to the hit, leftward).
        nearest = max(candidates, key=lambda r: r.span[1])

        # Pronoun carry-forward: if the nearest is a pronoun, look for
        # an explicit subject earlier in the sentence.
        if nearest.bucket == UNRESOLVED:
            explicit = [c for c in candidates if c.bucket != UNRESOLVED]
            if explicit:
                # Inherit the most recent explicit subject's bucket.
                carried = max(explicit, key=lambda r: r.span[1])
                return [FactAttribution(
                    hit=hit,
                    subject_bucket=carried.bucket,
                    contact=carried.contact,
                    data_responsibility=carried.data_responsibility,
                )]

        return [FactAttribution(
            hit=hit,
            subject_bucket=nearest.bucket,
            contact=nearest.contact,
            data_responsibility=nearest.data_responsibility,
        )]

    def _find_coordinated_subjects_for_hit(
        self, candidates: list[_SubjectRef], text: str, hit: SensitiveHit
    ) -> list[_SubjectRef] | None:
        """Detect coordinated subjects that govern a specific hit.

        Only returns a coordinated group if the group is immediately
        adjacent to the hit (the last subject in the group is the nearest
        to the hit). This prevents "Emma and Sancho have allergies, but
        Sancho owes taxes" from attributing the tax hit to Emma.
        """
        if len(candidates) < 2:
            return None

        # Find the nearest subject to this hit.
        nearest = max(candidates, key=lambda r: r.span[1])

        # Walk backward from nearest to find a coordinated chain.
        chain = [nearest]
        for i in range(len(candidates) - 2, -1, -1):
            prev = candidates[i]
            curr = chain[-1]  # most recently added (walking backward)
            between = text[prev.span[1]:curr.span[0]].strip().lower()
            if between in ("and", ",", ", and", "and also"):
                chain.append(prev)
            else:
                break

        chain.reverse()  # restore left-to-right order
        return chain if len(chain) > 1 else None


# ---------------------------------------------------------------------------
# Internal types
# ---------------------------------------------------------------------------

@dataclass
class _SubjectRef:
    """A subject reference found in the text."""
    span: tuple[int, int]
    bucket: str
    contact: MatchedContact | None
    data_responsibility: str
