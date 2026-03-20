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

from ..gen.core_types import Contact


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
        List of ``Contact`` Pydantic models with ``did`` and ``trust_level`` fields.
        Updated via ``update_contacts()`` when the contact list changes.
    """

    def __init__(self, contacts: list[Contact] | None = None) -> None:
        self._contacts: dict[str, Contact] = {}
        self._sender_index: dict[str, Contact] = {}
        if contacts:
            self.update_contacts(contacts)

    def update_contacts(self, contacts: list[Contact]) -> None:
        """Rebuild the contact lookup from a fresh contact list."""
        self._contacts = {c.did: c for c in contacts if c.did}
        # Reverse index: sender identifiers → contact for sender-based fallback.
        # Connector items arrive without contact_did; this lets us match
        # by sender email when the DID field is absent.
        #
        # Indexed fields (all lowercased):
        #   - name: often set to email address for email contacts
        #   - alias: explicit email/handle association (set by admin)
        self._sender_index: dict[str, Contact] = {}
        for c in contacts:
            if not c.did:
                continue
            for val_raw in (c.name, c.alias):
                val = (val_raw or "").strip().lower()
                if val:
                    self._sender_index[val] = c

    def score(self, item: dict[str, Any]) -> dict[str, str]:
        """Return provenance fields for a vault item.

        Primary input: (ingress_channel, origin_kind) — set server-side.
        Fallback: source string matching (for legacy connector items).

        Returns dict with: sender, sender_trust, source_type,
        confidence, retrieval_policy.
        """
        sender = item.get("sender", "")
        source = item.get("source", "")
        ingress_channel = item.get("ingress_channel", "")
        origin_kind = item.get("origin_kind", "")

        # ── Primary: structured provenance (ingress_channel + origin_kind) ──

        if ingress_channel == "cli" and origin_kind == "user":
            return {
                "sender": sender or "user",
                "sender_trust": "self",
                "source_type": "self",
                "confidence": "high",
                "retrieval_policy": "normal",
            }

        if ingress_channel == "cli" and origin_kind == "agent":
            return {
                "sender": sender or "agent",
                "sender_trust": "unknown",
                "source_type": "service",
                "confidence": "medium",
                "retrieval_policy": "caveated",
            }

        if ingress_channel == "telegram":
            return {
                "sender": sender or "user",
                "sender_trust": "self",
                "source_type": "self",
                "confidence": "high",
                "retrieval_policy": "normal",
            }

        if ingress_channel == "admin":
            return {
                "sender": sender or "admin",
                "sender_trust": "self",
                "source_type": "self",
                "confidence": "high",
                "retrieval_policy": "normal",
            }

        if ingress_channel == "d2d":
            # D2D trust depends on sender's contact status
            contact = self._find_contact(item)
            if contact:
                trust_level = contact.trust_level or "unknown"
                ring = "contact_ring1" if trust_level in ("trusted", "verified") else "contact_ring2"
                return {
                    "sender": sender or (contact.did or ""),
                    "sender_trust": ring,
                    "source_type": "contact",
                    "confidence": "medium",
                    "retrieval_policy": "caveated",
                    "contact_did": contact.did or "",
                }
            return {
                "sender": sender,
                "sender_trust": "unknown",
                "source_type": "unknown",
                "confidence": "low",
                "retrieval_policy": "quarantine",
            }

        if ingress_channel == "connector":
            # Connector items are always service/unknown trust.
            # Never fall through to source-string matching — connectors
            # could spoof source="telegram" to escalate trust.
            return {
                "sender": sender,
                "sender_trust": "unknown",
                "source_type": "service",
                "confidence": "low",
                "retrieval_policy": "caveated",
            }

        # ── Fallback: source-string matching (items without ingress_channel) ──

        # User-created content (source-based — for items without ingress_channel)
        if source in ("user", "cli", "admin", "telegram", "dina-cli"):
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
            trust_level = contact.trust_level or "unknown"
            ring = "contact_ring1" if trust_level in ("trusted", "verified") else "contact_ring2"
            return {
                "sender": sender or (contact.did or ""),
                "sender_trust": ring,
                "source_type": "contact",
                "confidence": "high" if trust_level in ("trusted", "verified") else "medium",
                "retrieval_policy": "normal",
                "contact_did": contact.did or "",
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
            ex_trust = ex.sender_trust or ""
            if ex_trust in high_trust and new_trust not in high_trust:
                return ex.id or ""

        return ""

    def _find_contact(self, item: dict[str, Any]) -> Contact | None:
        """Match item to a known contact by DID or sender email/name.

        Priority: contact_did (explicit) → sender email (reverse index).
        This ensures connector items without contact_did can still match
        known contacts by their sender address.
        """
        # Primary: explicit DID match.
        contact_did = item.get("contact_did", "")
        if contact_did and contact_did in self._contacts:
            return self._contacts[contact_did]
        # Fallback: match by sender email/name via reverse index.
        sender = item.get("sender", "").strip().lower()
        if sender and hasattr(self, "_sender_index") and sender in self._sender_index:
            return self._sender_index[sender]
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
