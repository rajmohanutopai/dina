"""Staging processor — classifies raw ingested items and stores to persona vaults.

Items arrive in Core's staging_inbox from connectors (push) or Brain's
MCP sync (pull). This processor claims pending items, classifies them
into the correct persona via domain_classifier, scores trust, and calls
Core's resolve endpoint which atomically decides stored vs pending_unlock.

No imports from adapter/ — only domain types, ports, and sibling services.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

log = logging.getLogger(__name__)

# Sensitivity ranking for "highest sensitivity wins" persona routing.
# When domain_classifier is uncertain, default to the most protective persona.
_SENSITIVITY_RANK = {
    "health": 5,
    "financial": 4,
    "finance": 4,
    "work": 3,
    "social": 1,      # maps to general at Core level
    "consumer": 1,    # maps to general at Core level
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
        persona_selector: Any = None,
    ) -> None:
        self._core = core
        self._enrichment = enrichment
        self._trust_scorer = trust_scorer
        self._classify = domain_classifier
        self._event_extractor = event_extractor
        self._selector = persona_selector

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
            item_id = item.id or ""
            if not item_id:
                continue

            try:
                # Build a plain dict for classifier and trust scorer
                # (they expect dict inputs).
                ingress_channel = getattr(item, "ingress_channel", "") or ""
                origin_did = getattr(item, "origin_did", "") or ""

                item_dict = {
                    "id": item.id or "",
                    "type": item.type or "note",
                    "source": item.source or "",
                    "source_id": item.source_id or "",
                    "summary": item.summary or "",
                    "body": item.body or "",
                    "sender": item.sender or "",
                    "metadata": item.metadata or "{}",
                    "connector_id": item.connector_id or "",
                    # Ingress provenance — server-derived by Core
                    "ingress_channel": ingress_channel,
                    "origin_did": origin_did,
                    "origin_kind": getattr(item, "origin_kind", "") or "",
                    "producer_id": getattr(item, "producer_id", "") or "",
                }

                # D2D items: origin_did IS the sender's DID — set contact_did
                # so the trust scorer can do contact ring lookup via _find_contact().
                if ingress_channel == "d2d" and origin_did:
                    item_dict["contact_did"] = origin_did

                # Classify persona.
                personas, routing_meta = await self._classify_personas(item_dict)

                # Score trust.
                provenance = {}
                if self._trust_scorer is not None:
                    provenance = self._trust_scorer.score(item_dict)

                # Extract original timestamp from metadata if present.
                # Staging items carry the original event timestamp in
                # metadata so vault items reflect when the event occurred,
                # not when the staging processor drained them.
                original_ts = 0
                meta_raw = item.metadata or "{}"
                try:
                    meta = json.loads(meta_raw)
                    original_ts = int(meta.get("timestamp", 0))
                except (json.JSONDecodeError, TypeError, ValueError):
                    pass

                # Build classified VaultItem template with lineage.
                base_classified: dict[str, Any] = {
                    "type": item.type or "note",
                    "source": item.source or "",
                    "source_id": item.source_id or "",
                    "summary": item.summary or "",
                    "body_text": item.body or "",
                    "sender": provenance.get("sender", item.sender or ""),
                    "sender_trust": provenance.get("sender_trust", ""),
                    "source_type": provenance.get("source_type", ""),
                    "confidence": provenance.get("confidence", ""),
                    "retrieval_policy": provenance.get("retrieval_policy", "caveated"),
                    "contact_did": provenance.get("contact_did", ""),
                    "metadata": meta_raw,
                    "staging_id": item_id,
                    "connector_id": item.connector_id or "",
                }
                if original_ts:
                    base_classified["timestamp"] = original_ts
                # Store routing metadata inside the metadata JSON blob
                # (Core's VaultItem has no top-level routing field).
                if routing_meta:
                    try:
                        existing_meta = json.loads(meta_raw) if meta_raw else {}
                    except (json.JSONDecodeError, TypeError):
                        existing_meta = {}
                    existing_meta["routing"] = routing_meta
                    base_classified["metadata"] = json.dumps(existing_meta)

                # VT6: Heartbeat lease extension during enrichment (the slow
                # LLM step). Extends every 5 minutes by 15 minutes — additive
                # from the current lease, so the deadline keeps moving forward.
                heartbeat_task: asyncio.Task | None = None

                async def _lease_heartbeat(sid: str) -> None:
                    """Extend lease every 5 min while enrichment runs."""
                    try:
                        while True:
                            await asyncio.sleep(300)  # 5 minutes
                            try:
                                await self._core.staging_extend_lease(sid, 900)
                            except Exception:
                                pass  # best-effort
                    except asyncio.CancelledError:
                        pass

                heartbeat_task = asyncio.create_task(_lease_heartbeat(item_id))

                # Enrich before resolve: generate L0+L1+embedding so every
                # vault item is fully enriched at publication time.
                # If enrichment fails, item stays in staging for retry
                # (Sweep requeues failed items with retry_count <= 3).
                try:
                    base_classified = await self._enrichment.enrich_raw(base_classified)
                except Exception as enrich_exc:
                    if heartbeat_task:
                        heartbeat_task.cancel()
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
                finally:
                    if heartbeat_task and not heartbeat_task.done():
                        heartbeat_task.cancel()

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
                # "resolved" is the GH10 status (O(n) scan removed); treat as stored.
                if resolve_status in ("stored", "resolved") and self._event_extractor is not None:
                    try:
                        await self._event_extractor.extract_and_create(
                            item_dict, personas[0], vault_item_id=f"stg-{item_id}",
                        )
                    except Exception:
                        pass  # best-effort

                # Update contact last_contact if sender is known.
                sender = item.sender or ""
                if sender and self._trust_scorer is not None:
                    contact = self._trust_scorer._find_contact(item_dict)
                    if contact:
                        try:
                            import time as _time
                            await self._core.update_contact_last_seen(
                                contact.did or "", int(_time.time()),
                            )
                        except Exception:
                            pass  # best-effort

                log.info("staging.resolved", extra={
                    "id": item_id, "personas": personas,
                })

                # Surface ambiguous routing for daily brief.
                if routing_meta and routing_meta.get("status") == "ambiguous":
                    log.info("staging.routing_ambiguous", extra={
                        "id": item_id,
                        "candidates": routing_meta.get("candidates", []),
                        "reason": routing_meta.get("reason", ""),
                    })
                    # Store as a brief-surfaceable event via Core KV
                    try:
                        brief_item = json.dumps({
                            "type": "routing_ambiguous",
                            "item_id": item_id,
                            "summary": base_classified.get("summary", ""),
                            "candidates": routing_meta.get("candidates", []),
                            "reason": routing_meta.get("reason", ""),
                        })
                        await self._core.set_kv(
                            f"brief:routing_ambiguous:{item_id}", brief_item,
                        )
                        # Append to index so Guardian can find all pending items
                        index_raw = await self._core.get_kv("brief:routing_ambiguous_index")
                        index = json.loads(index_raw) if index_raw else []
                        if item_id not in index:
                            index.append(item_id)
                            await self._core.set_kv(
                                "brief:routing_ambiguous_index", json.dumps(index),
                            )
                    except Exception:
                        pass  # best-effort

            except Exception as exc:
                log.warning("staging.classify_failed", extra={
                    "id": item_id, "error": str(exc),
                })
                try:
                    await self._core.staging_fail(item_id, str(exc))
                except Exception:
                    pass

        return resolved

    async def _classify_personas(self, item: dict) -> tuple[list[str], dict | None]:
        """Classify item into one or more personas. Highest sensitivity first.

        Returns (persona_list, routing_meta). routing_meta is set when
        routing was ambiguous — for daily brief surfacing.
        All names are validated against the registry when available.
        """
        primary, routing_meta = await self._classify_persona_with_meta(item)

        # Check for secondary persona signals in the content.
        text = (item.get("body", "") + " " + item.get("summary", "")).lower()

        health_words = {"pain", "health", "medical", "doctor", "diagnosis", "symptom"}
        work_words = {"work", "productivity", "office", "meeting", "deadline", "project"}
        finance_words = {"invoice", "payment", "bill", "salary", "tax", "bank"}

        has_health = any(w in text for w in health_words)
        has_work = any(w in text for w in work_words)
        has_finance = any(w in text for w in finance_words)

        # Resolve secondary signals to installed personas via prefix match.
        secondary = set()
        if has_health:
            p = self._find_persona_by_prefix("health")
            if p and p != primary:
                secondary.add(p)
        if has_work:
            p = self._find_persona_by_prefix("work")
            if p and p != primary:
                secondary.add(p)
        if has_finance:
            p = self._find_persona_by_prefix("financ")
            if p and p != primary:
                secondary.add(p)

        result = [primary]
        for p in sorted(secondary, key=lambda p: _SENSITIVITY_RANK.get(p, 0), reverse=True):
            if p not in result:
                result.append(p)

        return result, routing_meta

    async def _classify_persona_with_meta(self, item: dict) -> tuple[str, dict | None]:
        """Classify item into a single persona, returning routing metadata.

        Returns (persona_name, routing_meta). routing_meta is set when
        routing was ambiguous (for daily brief surfacing).
        """
        persona = await self._classify_persona(item)

        # Check if this was an ambiguous routing that fell to general
        routing_meta = None
        if persona == "general" and self._selector:
            registry = self._selector._registry
            # Get domain hint for ambiguity detection
            domain_hint = None
            if self._classify is not None:
                try:
                    result = self._classify(item)
                    if isinstance(result, str):
                        domain_hint = result
                    elif isinstance(result, dict):
                        domain_hint = result.get("domain", "")
                except Exception:
                    pass

            if domain_hint and domain_hint != "general":
                # Check if there were multiple matches (ambiguous)
                prefix = {"financial": "financ", "finance": "financ",
                          "health": "health", "medical": "health",
                          "work": "work"}.get(domain_hint, domain_hint)
                matches = [n for n in registry.all_names() if n.startswith(prefix)]
                if len(matches) > 1:
                    routing_meta = {
                        "status": "ambiguous",
                        "domain": domain_hint,
                        "candidates": matches,
                        "reason": f"Multiple personas match '{domain_hint}': {matches}. Stored in general for review.",
                    }

        return persona, routing_meta

    async def _classify_persona(self, item: dict) -> str:
        """Classify item into a single persona.

        Resolution order:
        1. Injected domain classifier (keyword/source-based)
        2. PersonaSelector (LLM picks from installed personas)
        3. Deterministic type-based fallback
        4. Default to "general"
        """
        # 1. Get domain hint from classifier (for sensitivity + selector hint)
        domain_hint = None
        if self._classify is not None:
            try:
                result = self._classify(item)
                if isinstance(result, str) and result:
                    domain_hint = result
                elif isinstance(result, dict):
                    domain_hint = result.get("domain", "")
            except Exception:
                pass

        # 2. LLM-assisted selector — picks from installed personas
        #    Don't pass "general" as hint — it's a non-signal that would
        #    short-circuit the selector and block the type fallback.
        effective_hint = domain_hint if domain_hint and domain_hint != "general" else None
        if self._selector:
            try:
                result = await self._selector.select(item, persona_hint=effective_hint)
                if result is not None and result.primary:
                    return result.primary
            except Exception:
                pass

        # 3. Deterministic fallback — validate against registry before using.
        #    For custom installations (e.g. financial_me instead of finance),
        #    find the best matching installed persona by prefix/substring.
        candidate = self._resolve_fallback(item.get("type", ""), domain_hint)
        if candidate:
            return candidate

        # 4. Default
        return "general"

    def _resolve_fallback(self, item_type: str, domain_hint: str | None) -> str | None:
        """Find the best installed persona for a type or domain hint.

        Checks exact match first, then prefix match against registry.
        Returns None if no installed persona matches.
        """
        # Map item types and domains to search prefixes
        _HINT_MAP = {
            # item types
            "health_context": "health",
            "medical_record": "health",
            "medical_note": "health",
            "finance_context": "financ",
            "work_context": "work",
            # classifier domains
            "health": "health",
            "medical": "health",
            "financial": "financ",
            "finance": "financ",
            "work": "work",
        }

        # Try item type first, then domain hint
        for key in (item_type, domain_hint):
            if not key or key == "general":
                continue
            prefix = _HINT_MAP.get(key, key)
            match = self._find_persona_by_prefix(prefix)
            if match:
                return match
        return None

    def _find_persona_by_prefix(self, prefix: str) -> str | None:
        """Find an installed persona matching the prefix.

        With registry: exact match wins, then prefix match.
        Without registry: expand known prefixes to canonical names.
        """
        if not self._selector:
            # No registry — expand only known prefixes to canonical names.
            # Do NOT return arbitrary strings as persona names.
            _PREFIX_EXPAND = {
                "financ": "finance",
                "health": "health",
                "medical": "health",
                "work": "work",
            }
            return _PREFIX_EXPAND.get(prefix)

        registry = self._selector._registry

        # Exact match
        if registry.exists(prefix):
            return prefix

        # Prefix match against installed personas
        matches = sorted(n for n in registry.all_names() if n.startswith(prefix))
        if len(matches) == 1:
            return matches[0]
        if matches:
            # Ambiguous — multiple matches. Store routing metadata on item
            # for daily brief surfacing, then return None (→ general).
            return None
        return None
