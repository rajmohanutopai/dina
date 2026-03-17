"""Source trust scoring for vault item provenance.

Assigns sender_trust, source_type, confidence, and retrieval_policy
based on who sent the item and where it came from.

Rules:
    - User statements: self / high / normal
    - Known contacts (trusted): contact_ring1 / high / normal
    - Known contacts (other): contact_ring2 / medium / normal
    - Verified service domains: service / high / normal
    - Unknown senders: unknown / low / caveated
    - Marketing/noreply: marketing / low / briefing_only
    - Missing sender on service items: unknown / low / caveated (never silently normal)

No imports from adapter/ — only domain types and sibling services.
"""

from __future__ import annotations

import re
from typing import Any


# Verified service domains (known providers whose data is trustworthy).
VERIFIED_SERVICE_DOMAINS = frozenset({
    # Health
    "myhealth.va.gov", "mychart.com", "practo.com",
    # Financial
    "chase.com", "bankofamerica.com", "paypal.com",
    "hdfcbank.com", "sbi.co.in", "icicibank.com",
    # Tech platforms
    "google.com", "apple.com", "microsoft.com",
    # Government
    "gov.in", "irs.gov", "ssa.gov",
})

# Marketing/noreply sender patterns.
MARKETING_PATTERNS = re.compile(
    r"(?:^noreply@|^no-reply@|^donotreply@"
    r"|@notifications\.|@marketing\.|@bounce\."
    r"|@promo\.|@newsletter\.|@campaigns\."
    r"|unsubscribe)",
    re.IGNORECASE,
)


class TrustScorer:
    """Scores vault items for source trust and provenance.

    Parameters
    ----------
    contacts:
        List of contact dicts with ``did`` and ``trust_level`` keys.
        Updated via ``update_contacts()`` when the contact list changes.
    """

    def __init__(self, contacts: list[dict[str, Any]] | None = None) -> None:
        self._contacts: dict[str, dict[str, Any]] = {}
        if contacts:
            self.update_contacts(contacts)

    def update_contacts(self, contacts: list[dict[str, Any]]) -> None:
        """Rebuild the contact lookup from a fresh contact list."""
        self._contacts = {c.get("did", ""): c for c in contacts if c.get("did")}

    def score(self, item: dict[str, Any]) -> dict[str, str]:
        """Return provenance fields for a vault item.

        Returns dict with: sender, sender_trust, source_type,
        confidence, retrieval_policy.
        """
        sender = item.get("sender", "")
        source = item.get("source", "")

        # User-created content (CLI, admin, manual notes).
        if source in ("user", "cli", "admin", "telegram"):
            return {
                "sender": sender or "user",
                "sender_trust": "self",
                "source_type": "self",
                "confidence": "high",
                "retrieval_policy": "normal",
            }

        # Marketing/bulk patterns.
        if sender and MARKETING_PATTERNS.search(sender):
            return {
                "sender": sender,
                "sender_trust": "marketing",
                "source_type": "marketing",
                "confidence": "low",
                "retrieval_policy": "briefing_only",
            }

        # Known contact (by DID).
        contact = self._find_contact(item)
        if contact:
            trust_level = contact.get("trust_level", "unknown")
            ring = "contact_ring1" if trust_level in ("trusted", "verified") else "contact_ring2"
            return {
                "sender": sender or contact.get("did", ""),
                "sender_trust": ring,
                "source_type": "contact",
                "confidence": "high" if trust_level in ("trusted", "verified") else "medium",
                "retrieval_policy": "normal",
            }

        # Verified service domain.
        if sender and _is_verified_domain(sender):
            return {
                "sender": sender,
                "sender_trust": "contact_ring2",
                "source_type": "service",
                "confidence": "high",
                "retrieval_policy": "normal",
            }

        # Unknown sender — conservative default.
        return {
            "sender": sender,
            "sender_trust": "unknown",
            "source_type": "unknown",
            "confidence": "low",
            "retrieval_policy": "caveated",
        }

    async def check_contradiction(
        self, core: Any, persona_id: str, item: dict[str, Any],
    ) -> str:
        """Check if a new item contradicts existing vault data.

        Returns the ID of the contradicted item, or empty string.
        Only checks high-signal item types (health, financial).
        Uses keyword overlap as a simple heuristic — full semantic
        contradiction detection is Phase 2 (requires LLM classification).
        """
        # Only check items where contradictions matter.
        check_types = {
            "health_context", "medical_record", "medical_note",
            "finance_context",
        }
        if item.get("type") not in check_types:
            return ""

        summary = item.get("summary", "")
        if not summary or len(summary) < 10:
            return ""

        try:
            existing = await core.search_vault(persona_id, summary, mode="fts5")
        except Exception:
            return ""

        if not existing:
            return ""

        # Simple heuristic: if an existing item from a higher-trust source
        # covers the same topic, flag as potential contradiction.
        new_trust = item.get("sender_trust", "unknown")
        high_trust = {"self", "contact_ring1"}
        for ex in existing:
            ex_trust = ex.get("sender_trust", ex.get("SenderTrust", ""))
            if ex_trust in high_trust and new_trust not in high_trust:
                return ex.get("id", ex.get("ID", ""))

        return ""

    def _find_contact(self, item: dict[str, Any]) -> dict[str, Any] | None:
        """Match item to a known contact by DID."""
        contact_did = item.get("contact_did", "")
        if contact_did and contact_did in self._contacts:
            return self._contacts[contact_did]
        return None


def _is_verified_domain(sender: str) -> bool:
    """Check if sender email is from a verified service domain."""
    if "@" not in sender:
        return False
    domain = sender.split("@")[-1].lower()
    # Check exact match and parent domain (e.g. mail.google.com → google.com).
    if domain in VERIFIED_SERVICE_DOMAINS:
        return True
    parts = domain.split(".")
    if len(parts) >= 2:
        parent = ".".join(parts[-2:])
        if parent in VERIFIED_SERVICE_DOMAINS:
            return True
    return False
