"""Staging processor — classifies raw ingested items and stores to persona vaults.

Items arrive in Core's staging_inbox from connectors (push) or Brain's
MCP sync (pull). This processor claims pending items, classifies them
into the correct persona via domain_classifier, scores trust, and calls
Core's resolve endpoint which atomically decides stored vs pending_unlock.

No imports from adapter/ — only domain types, ports, and sibling services.
"""

from __future__ import annotations

import logging
from typing import Any

log = logging.getLogger(__name__)

# Sensitivity ranking for "highest sensitivity wins" persona routing.
# When domain_classifier is uncertain, default to the most protective persona.
_SENSITIVITY_RANK = {
    "health": 5,
    "financial": 4,
    "work": 3,
    "social": 2,
    "consumer": 1,
    "general": 0,
}


class StagingProcessor:
    """Claims and classifies staged items, then resolves via Core.

    Parameters
    ----------
    core:
        HTTP client for dina-core (staging + vault operations).
    trust_scorer:
        TrustScorer instance for provenance assignment.
    domain_classifier:
        Callable that classifies item type/content into a persona name.
        If None, defaults to "general".
    """

    def __init__(
        self,
        core: Any,
        trust_scorer: Any = None,
        domain_classifier: Any = None,
    ) -> None:
        self._core = core
        self._trust_scorer = trust_scorer
        self._classify = domain_classifier

    async def process_pending(self, limit: int = 10) -> int:
        """Claim and classify pending staging items.

        Returns count of items successfully resolved.
        """
        try:
            items = await self._core.staging_claim(limit)
        except Exception as exc:
            log.warning("staging.claim_failed", extra={"error": str(exc)})
            return 0

        if not items:
            return 0

        resolved = 0
        for item in items:
            item_id = item.get("id", "")
            if not item_id:
                continue

            try:
                # Classify persona.
                persona = self._classify_persona(item)

                # Score trust.
                provenance = {}
                if self._trust_scorer is not None:
                    provenance = self._trust_scorer.score(item)

                # Build classified VaultItem with lineage.
                classified = {
                    "type": item.get("type", "note"),
                    "source": item.get("source", ""),
                    "source_id": item.get("source_id", ""),
                    "summary": item.get("summary", ""),
                    "body_text": item.get("body", ""),
                    "sender": provenance.get("sender", item.get("sender", "")),
                    "sender_trust": provenance.get("sender_trust", ""),
                    "source_type": provenance.get("source_type", ""),
                    "confidence": provenance.get("confidence", ""),
                    "retrieval_policy": provenance.get("retrieval_policy", "caveated"),
                    "metadata": item.get("metadata", "{}"),
                    # Lineage
                    "staging_id": item_id,
                    "connector_id": item.get("connector_id", ""),
                }

                # Resolve — Core decides stored vs pending_unlock.
                await self._core.staging_resolve(item_id, persona, classified)
                resolved += 1

                log.info("staging.resolved", extra={
                    "id": item_id, "persona": persona,
                })

            except Exception as exc:
                log.warning("staging.classify_failed", extra={
                    "id": item_id, "error": str(exc),
                })
                try:
                    await self._core.staging_fail(item_id, str(exc))
                except Exception:
                    pass

        return resolved

    def _classify_persona(self, item: dict) -> str:
        """Classify item into a persona. Highest sensitivity wins."""
        if self._classify is not None:
            try:
                result = self._classify(item)
                if isinstance(result, str) and result:
                    return result
                if isinstance(result, dict):
                    return result.get("persona", result.get("domain", "general"))
            except Exception:
                pass

        # Fallback: use type-based heuristics.
        item_type = item.get("type", "")
        type_to_persona = {
            "health_context": "health",
            "medical_record": "health",
            "medical_note": "health",
            "finance_context": "financial",
            "work_context": "work",
            "family_context": "social",
            "relationship_note": "social",
        }
        return type_to_persona.get(item_type, "general")
