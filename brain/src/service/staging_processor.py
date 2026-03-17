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

    Every item is enriched (L0+L1+embedding) before vault publication.
    If enrichment fails, the item stays in staging for retry.

    Parameters
    ----------
    core:
        HTTP client for dina-core (staging + vault operations).
    enrichment:
        EnrichmentService for L0/L1/embedding generation. Required.
    trust_scorer:
        TrustScorer instance for provenance assignment.
    domain_classifier:
        Callable that classifies item type/content into a persona name.
        If None, defaults to "general".
    """

    def __init__(
        self,
        core: Any,
        enrichment: Any,
        trust_scorer: Any = None,
        domain_classifier: Any = None,
        event_extractor: Any = None,
    ) -> None:
        self._core = core
        self._enrichment = enrichment
        self._trust_scorer = trust_scorer
        self._classify = domain_classifier
        self._event_extractor = event_extractor

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
                personas = self._classify_personas(item)

                # Score trust.
                provenance = {}
                if self._trust_scorer is not None:
                    provenance = self._trust_scorer.score(item)

                # Build classified VaultItem template with lineage.
                base_classified = {
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
                    "contact_did": provenance.get("contact_did", item.get("contact_did", "")),
                    "metadata": item.get("metadata", "{}"),
                    "staging_id": item_id,
                    "connector_id": item.get("connector_id", ""),
                }

                # Enrich before resolve: generate L0+L1+embedding so every
                # vault item is fully enriched at publication time.
                # If enrichment fails, item stays in staging for retry
                # (Sweep requeues failed items with retry_count <= 3).
                try:
                    base_classified = await self._enrichment.enrich_raw(base_classified)
                except Exception as enrich_exc:
                    log.warning("staging.enrichment_failed", extra={
                        "id": item_id, "error": str(enrich_exc),
                    })
                    try:
                        await self._core.staging_fail(
                            item_id, f"enrichment failed: {enrich_exc}",
                        )
                    except Exception:
                        pass
                    continue  # skip to next item — do not resolve

                resolve_status = "stored"
                if len(personas) == 1:
                    result = await self._core.staging_resolve(item_id, personas[0], base_classified)
                    resolve_status = result.get("status", "stored") if isinstance(result, dict) else "stored"
                else:
                    targets = []
                    for persona in personas:
                        copy = dict(base_classified)
                        copy["id"] = f"stg-{item_id}-{persona}"
                        targets.append({"persona": persona, "classified_item": copy})
                    result = await self._core.staging_resolve_multi(item_id, targets)
                    resolve_status = result.get("status", "stored") if isinstance(result, dict) else "stored"

                resolved += 1

                # Only extract reminders when content was actually stored.
                # pending_unlock means the persona is locked — no vault item exists yet.
                if resolve_status == "stored" and self._event_extractor is not None:
                    try:
                        await self._event_extractor.extract_and_create(
                            item, personas[0], vault_item_id=f"stg-{item_id}",
                        )
                    except Exception:
                        pass  # best-effort

                # Update contact last_contact if sender is known.
                sender = item.get("sender", "")
                if sender and self._trust_scorer is not None:
                    contact = self._trust_scorer._find_contact(item)
                    if contact:
                        try:
                            import time as _time
                            await self._core.update_contact_last_seen(
                                contact.get("did", ""), int(_time.time()),
                            )
                        except Exception:
                            pass  # best-effort

                log.info("staging.resolved", extra={
                    "id": item_id, "personas": personas,
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

    def _classify_personas(self, item: dict) -> list[str]:
        """Classify item into one or more personas. Highest sensitivity first.

        Returns a list of persona names. Most items map to one persona.
        Multi-persona items (e.g., "back pain affecting work") return
        both personas so Core can store copies in each vault.
        """
        primary = self._classify_persona(item)

        # Check for secondary persona signals in the content.
        text = (item.get("body", "") + " " + item.get("summary", "")).lower()
        secondary = set()

        # Health + work cross-over.
        health_words = {"pain", "health", "medical", "doctor", "diagnosis", "symptom"}
        work_words = {"work", "productivity", "office", "meeting", "deadline", "project"}
        finance_words = {"invoice", "payment", "bill", "salary", "tax", "bank"}

        has_health = any(w in text for w in health_words)
        has_work = any(w in text for w in work_words)
        has_finance = any(w in text for w in finance_words)

        if has_health and primary != "health":
            secondary.add("health")
        if has_work and primary != "work":
            secondary.add("work")
        if has_finance and primary not in ("financial", "finance"):
            secondary.add("financial")

        # Build result: primary first, then secondary sorted by sensitivity.
        result = [primary]
        for p in sorted(secondary, key=lambda p: _SENSITIVITY_RANK.get(p, 0), reverse=True):
            if p not in result:
                result.append(p)

        return result

    def _classify_persona(self, item: dict) -> str:
        """Classify item into a single persona. Highest sensitivity wins."""
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
