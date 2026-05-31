"""Shared sensitive-domain signal detection — single source of truth.

Every component that needs to detect health/finance/legal keywords in text
imports from here. This prevents drift between domain_classifier.py,
staging_processor.py, and subject_attributor.py.

Two levels of API:
  - has_health_signal(text), has_finance_signal(text) — boolean checks
    (used by secondary persona expansion in staging_processor)
  - find_sensitive_hits(text) — per-span multi-hit detection with positions
    (used by subject_attributor for per-fact routing)
"""

from __future__ import annotations

import re
from dataclasses import dataclass


# ---------------------------------------------------------------------------
# Canonical keyword patterns — moved from domain_classifier.py
# ---------------------------------------------------------------------------

HEALTH_STRONG = re.compile(
    r"\b(?:diagnosis|diagnosed|prescription|symptom|blood\s*(?:sugar|pressure|test)|"
    r"cholesterol|A1C|biopsy|MRI|CT\s*scan|radiology|oncology|pathology|"
    r"medication|dosage|insulin|chemotherapy|surgery|hospital|clinic|"
    r"patient|medical\s*record|lab\s*result|hemoglobin|platelet|"
    r"x-ray|ultrasound|ecg|ekg|diabetes|diabetic|hypertension)\b",
    re.IGNORECASE,
)

HEALTH_WEAK = re.compile(
    r"\b(?:doctor|health|wellness|diet|exercise|weight|sleep|"
    r"headache|migraines?|fever|cold(?!\s+brew)|flu|allerg(?:y|ies|ic)|vitamin)\b",
    re.IGNORECASE,
)

FINANCE_STRONG = re.compile(
    r"\b(?:bank\s*account|credit\s*card|debit\s*card|loan|mortgage|"
    r"tax\s*return|salary|income|investment|portfolio|"
    r"account\s*number|routing\s*number|swift|iban|"
    r"ssn|social\s*security)\b",
    re.IGNORECASE,
)

FINANCE_WEAK = re.compile(
    r"\b(?:money|payment|price|cost|budget|expense|savings|"
    r"insurance|premium|interest\s*rate|tax(?:es)?)\b",
    re.IGNORECASE,
)

LEGAL_STRONG = re.compile(
    r"\b(?:lawsuit|subpoena|deposition|court\s*order|litigation|"
    r"attorney|lawyer|legal\s*counsel|affidavit|indictment|"
    r"bail|probation|verdict|plea|custody|restraining\s*order)\b",
    re.IGNORECASE,
)

# Word sets for quick boolean checks (secondary expansion in staging_processor).
# These must be a SUBSET of the regex patterns above — never define new keywords here.
HEALTH_WORDS = frozenset({
    "pain", "health", "medical", "doctor", "diagnosis", "symptom",
    "allergy", "prescription", "medication", "surgery", "hospital",
    "blood pressure", "cholesterol",
})

FINANCE_WORDS = frozenset({
    "invoice", "payment", "bill", "salary", "tax", "bank",
    "insurance", "mortgage", "loan", "budget", "expense",
    "credit card", "investment",
})

WORK_WORDS = frozenset({
    "work", "productivity", "office", "meeting", "deadline", "project",
    "standup", "sprint", "manager", "colleague", "presentation",
})


# ---------------------------------------------------------------------------
# Boolean signal checks (for secondary expansion)
# ---------------------------------------------------------------------------

def has_health_signal(text: str) -> bool:
    """True if text contains any health-domain keyword."""
    t = text.lower()
    return any(w in t for w in HEALTH_WORDS) or bool(HEALTH_STRONG.search(text))


def has_finance_signal(text: str) -> bool:
    """True if text contains any finance-domain keyword."""
    t = text.lower()
    return any(w in t for w in FINANCE_WORDS) or bool(FINANCE_STRONG.search(text))


def has_work_signal(text: str) -> bool:
    """True if text contains any work-domain keyword."""
    t = text.lower()
    return any(w in t for w in WORK_WORDS)


# ---------------------------------------------------------------------------
# Per-span hit detection (for subject attribution)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class SensitiveHit:
    """A single sensitive-keyword match with position in the original text."""
    span: tuple[int, int]  # (start, end) character offsets
    domain: str            # "health" | "finance" | "legal"
    keyword: str           # matched text
    strength: str          # "strong" | "weak"


def find_sensitive_hits(text: str) -> list[SensitiveHit]:
    """Find ALL sensitive-domain keyword matches in text with positions.

    Returns one SensitiveHit per keyword match. Overlapping hits of the same
    domain are merged into a single span to prevent duplicate attributions.
    A single sentence can produce hits from different domains.
    """
    raw_hits: list[SensitiveHit] = []

    for m in HEALTH_STRONG.finditer(text):
        raw_hits.append(SensitiveHit(
            span=(m.start(), m.end()), domain="health",
            keyword=m.group(), strength="strong",
        ))
    for m in HEALTH_WEAK.finditer(text):
        raw_hits.append(SensitiveHit(
            span=(m.start(), m.end()), domain="health",
            keyword=m.group(), strength="weak",
        ))
    for m in FINANCE_STRONG.finditer(text):
        raw_hits.append(SensitiveHit(
            span=(m.start(), m.end()), domain="finance",
            keyword=m.group(), strength="strong",
        ))
    for m in FINANCE_WEAK.finditer(text):
        raw_hits.append(SensitiveHit(
            span=(m.start(), m.end()), domain="finance",
            keyword=m.group(), strength="weak",
        ))
    for m in LEGAL_STRONG.finditer(text):
        raw_hits.append(SensitiveHit(
            span=(m.start(), m.end()), domain="legal",
            keyword=m.group(), strength="strong",
        ))

    # Merge overlapping hits of the same domain.
    return _merge_overlapping(raw_hits)


def _merge_overlapping(hits: list[SensitiveHit]) -> list[SensitiveHit]:
    """Merge overlapping same-domain hits into single spans.

    Keeps the strongest hit when merging. Sorts by (domain, start).
    """
    if not hits:
        return []

    # Group by domain, then merge overlapping spans within each group.
    by_domain: dict[str, list[SensitiveHit]] = {}
    for h in hits:
        by_domain.setdefault(h.domain, []).append(h)

    merged: list[SensitiveHit] = []
    for domain, group in by_domain.items():
        group.sort(key=lambda h: h.span[0])
        current = group[0]
        for h in group[1:]:
            if h.span[0] <= current.span[1] + 2:  # merge adjacent (within 2 chars)
                # Overlapping — extend span, keep strongest
                strength = "strong" if current.strength == "strong" or h.strength == "strong" else "weak"
                keyword = current.keyword if current.strength == "strong" else h.keyword
                current = SensitiveHit(
                    span=(current.span[0], max(current.span[1], h.span[1])),
                    domain=domain, keyword=keyword, strength=strength,
                )
            else:
                merged.append(current)
                current = h
        merged.append(current)

    merged.sort(key=lambda h: h.span[0])
    return merged
