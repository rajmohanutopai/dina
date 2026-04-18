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

import structlog

from ..domain.errors import ApprovalRequiredError

log = structlog.get_logger(__name__)

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
        reminder_planner: Any = None,
        telegram: Any = None,
        topic_extractor: Any = None,
        appview_client: Any = None,
    ) -> None:
        self._core = core
        self._enrichment = enrichment
        self._trust_scorer = trust_scorer
        self._classify = domain_classifier
        self._event_extractor = event_extractor
        self._selector = persona_selector
        self._reminder_planner = reminder_planner
        self._telegram = telegram
        # Working-memory topic extractor — populates topic_salience
        # via POST /v1/memory/topic/touch after each successful resolve.
        # Optional: if None, memory updates are skipped (no-op).
        self._topic_extractor = topic_extractor
        # AppView client — optional; when present, entity topics are
        # enriched with live_capability markers by resolving entity →
        # contact DID → that DID's published service profile (see
        # docs/WORKING_MEMORY_DESIGN.md §6.1). Silent no-op if absent.
        self._appview_client = appview_client
        self._person_extractor = None  # Set externally after construction.
        self._last_attribution_corrections: list[dict] = []

    async def process_pending(self, limit: int = 10) -> int:
        """Claim and classify pending staging items.

        Returns count of items successfully resolved.
        """
        try:
            items = await self._core.staging_claim(limit)
        except Exception as exc:
            log.warning("staging.claim_failed", error=str(exc))
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
                log.info(
                    "staging.classified",
                    id=item.id,
                    personas=personas,
                    domain=(routing_meta or {}).get("domain", ""),
                    sensitivity=(routing_meta or {}).get("sensitivity", ""),
                    summary=(item.summary or "")[:80],
                )

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
                    log.warning("staging.enrichment_failed", id=item_id, error=str(enrich_exc))
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

                # Extract session + agent DID from item provenance for
                # session-scoped access control. Both are required for
                # AccessPersona() to enforce the correct grant check.
                item_session = ""
                # Only pass agent_did for actual agent callers.
                # User-originated items (telegram, admin) should NOT set agent_did,
                # otherwise Core's auth middleware treats Brain as an "agent" caller
                # and requires session-based approval even for open personas.
                item_agent_did = ""
                if ingress_channel not in ("telegram", "admin", ""):
                    item_agent_did = origin_did
                try:
                    _meta = json.loads(item.metadata or "{}")
                    item_session = _meta.get("session", "")
                except (json.JSONDecodeError, TypeError):
                    pass

                # Plan reminders BEFORE resolve — the KV must be written
                # before staging status becomes "stored", so callers polling
                # staging_status can read the plan immediately after seeing "stored".
                event_hint = getattr(self, "_last_event_hint", "")
                self._last_event_hint = ""  # reset
                if event_hint and self._reminder_planner:
                    try:
                        content = item.body or item.summary or ""
                        plan_result = await self._reminder_planner.plan_and_create(
                            content=content,
                            event_hint=event_hint,
                            persona=personas[0],
                            vault_item_id=f"stg-{item_id}",
                            source=item_dict.get("source", ""),
                        )
                        n = len(plan_result.get("reminders", []))
                        if n > 0:
                            log.info("staging.reminders_planned",
                                     id=item_id, count=n,
                                     summary=plan_result.get("summary", ""))
                            try:
                                await self._core.set_kv(
                                    f"reminder_plan:{item_id}",
                                    json.dumps(plan_result),
                                )
                            except Exception:
                                pass  # best-effort

                            # Push reminder plan to Telegram with Edit/Delete buttons.
                            if self._telegram and hasattr(self._telegram, "send_reminder_plan"):
                                try:
                                    if not self._telegram._paired_users:
                                        await self._telegram.load_paired_users()
                                    for chat_id in self._telegram._paired_users:
                                        await self._telegram.send_reminder_plan(chat_id, plan_result)
                                except Exception:
                                    pass  # best-effort
                    except Exception as exc:
                        log.warning("staging.reminder_plan_failed",
                                    id=item_id, error=str(exc))
                # User-originated items (Telegram, admin) bypass persona
                # access approval — the user IS the owner, consent is implicit.
                _user_origin = ""
                if ingress_channel in ("telegram", "admin"):
                    _user_origin = ingress_channel

                resolve_status = "stored"
                if len(personas) == 1:
                    result = await self._core.staging_resolve(
                        item_id, personas[0], base_classified,
                        session=item_session, agent_did=item_agent_did,
                        user_origin=_user_origin,
                    )
                    resolve_status = result.get("status", "stored") if isinstance(result, dict) else "stored"
                else:
                    targets = []
                    for persona in personas:
                        copy = dict(base_classified)
                        copy["id"] = f"stg-{item_id}-{persona}"
                        targets.append({"persona": persona, "classified_item": copy})
                    result = await self._core.staging_resolve_multi(
                        item_id, targets,
                        session=item_session, agent_did=item_agent_did,
                        user_origin=_user_origin,
                    )
                    resolve_status = result.get("status", "stored") if isinstance(result, dict) else "stored"

                resolved += 1

                # Legacy regex extractor — only for stored items without planner.
                if resolve_status in ("stored", "resolved"):
                    if not (event_hint and self._reminder_planner) and self._event_extractor is not None:
                        try:
                            await self._event_extractor.extract_and_create(
                                item_dict, personas[0], vault_item_id=f"stg-{item_id}",
                            )
                        except Exception:
                            pass

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

                log.info("staging.resolved", id=item_id, personas=personas)

                # Working-memory topic extraction. Best-effort: any
                # failure here is logged but never blocks the resolve.
                # See docs/WORKING_MEMORY_DESIGN.md §7 — topic counters
                # are a derived index; rebuild-from-scratch is always safe.
                if self._topic_extractor and resolve_status in ("stored", "resolved"):
                    try:
                        topics = await self._topic_extractor.extract(base_classified)
                        entities = topics.get("entities") or []
                        themes = topics.get("themes") or []
                        # Enrich entities with live_capability (§6.1):
                        # entity name → contacts lookup → DID → AppView
                        # service profile → first capability. This is what
                        # lets the classifier route "is my dentist
                        # appointment still confirmed?" to both vault and
                        # the dentist's service, instead of vault alone.
                        entity_enrichment = await self._enrich_entities_with_live_capability(
                            entities,
                        )
                        for persona in personas:
                            for name in entities:
                                enrich = entity_enrichment.get(name.lower(), {})
                                try:
                                    await self._core.memory_touch(
                                        persona=persona, topic=name, kind="entity",
                                        sample_item_id=f"stg-{item_id}",
                                        live_capability=enrich.get("capability", ""),
                                        live_provider_did=enrich.get("did", ""),
                                    )
                                except Exception as texc:
                                    log.debug(
                                        "staging.memory_touch_entity_failed",
                                        id=item_id, topic=name, error=str(texc),
                                    )
                            for name in themes:
                                try:
                                    await self._core.memory_touch(
                                        persona=persona, topic=name, kind="theme",
                                        sample_item_id=f"stg-{item_id}",
                                    )
                                except Exception as texc:
                                    log.debug(
                                        "staging.memory_touch_theme_failed",
                                        id=item_id, topic=name, error=str(texc),
                                    )
                        if entities or themes:
                            log.info(
                                "staging.memory_touched",
                                id=item_id,
                                entities=len(entities),
                                themes=len(themes),
                                enriched_entities=sum(
                                    1 for e in entity_enrichment.values() if e.get("capability")
                                ),
                            )
                    except Exception as texc:
                        log.warning(
                            "staging.topic_extract_failed",
                            id=item_id, error=str(texc),
                        )

                # Surface routing review items for daily brief.
                if routing_meta:
                    review_kind = routing_meta.get("kind") or routing_meta.get("status", "")
                    if review_kind in ("ambiguous", "ambiguous_persona", "unresolved_subject_ownership"):
                        log.info("staging.routing_review",
                            id=item_id, kind=review_kind,
                            reason=routing_meta.get("reason", ""),
                        )
                        try:
                            brief_item = json.dumps({
                                "type": f"routing_{review_kind}",
                                "kind": review_kind,
                                "item_id": item_id,
                                "summary": base_classified.get("summary", ""),
                                **{k: v for k, v in routing_meta.items()
                                   if k not in ("kind", "type")},
                            })
                            await self._core.set_kv(
                                f"brief:routing_review:{item_id}", brief_item,
                            )
                            index_raw = await self._core.get_kv("brief:routing_review_index")
                            index = json.loads(index_raw) if index_raw else []
                            if item_id not in index:
                                index.append(item_id)
                                await self._core.set_kv(
                                    "brief:routing_review_index", json.dumps(index),
                                )
                        except Exception:
                            pass  # best-effort

                # Enqueue person identity extraction (async, post-publish).
                if self._person_extractor and item.type in ("note", ""):
                    body = item.body or item.summary or ""
                    if body.strip():
                        try:
                            await self._person_extractor.extract(body, item_id)
                        except Exception as exc:
                            log.warning("staging.person_extract_failed",
                                id=item_id, error=str(exc))

            except ApprovalRequiredError as exc:
                # Core already marked the item as pending_unlock and created
                # an approval request. Nothing to do here — GetStatus will
                # return pending_unlock so RememberHandler reports needs_approval.
                log.info("staging.needs_approval",
                    id=item_id,
                    persona=exc.persona,
                    approval_id=exc.approval_id,
                )
            except Exception as exc:
                err_str = str(exc)
                log.warning("staging.classify_failed", id=item_id, error=err_str)
                try:
                    await self._core.staging_fail(item_id, err_str)
                except Exception:
                    pass

        return resolved

    async def _enrich_entities_with_live_capability(
        self, entity_names: list[str],
    ) -> dict[str, dict]:
        """Resolve entity topic names to DID + capability via contacts + AppView.

        For each extracted entity, try to find a matching contact in
        Core's contacts table (case-insensitive name/alias match), then
        look up that DID's service profile on AppView. If the DID
        advertises any capability, return it so the memory_touch call
        can stamp ``live_capability`` + ``live_provider_did`` on the
        topic row.

        Best-effort everywhere: an unreachable AppView, missing
        contacts endpoint, or unknown entity all produce an empty
        mapping for that name — the caller treats "no enrichment" as
        the absence of a live-service path, not an error.

        Returns a dict keyed by lower-cased entity name:
            {"dr carl": {"did": "did:plc:...", "capability": "appointment_status"}}
        """
        if not entity_names:
            return {}
        if self._appview_client is None:
            return {}

        # Load contacts once per batch (small list, one HTTP round-trip).
        try:
            contacts_resp = await self._core._request("GET", "/v1/contacts")
            contacts = contacts_resp.json().get("contacts", []) or []
        except Exception as exc:
            log.debug("staging.enrich_contacts_failed", error=str(exc))
            return {}

        # Build lowercase name → DID map, including aliases.
        name_to_did: dict[str, str] = {}
        for c in contacts:
            did = c.get("did") or ""
            if not did:
                continue
            name = (c.get("name") or c.get("display_name") or "").strip().lower()
            if name and len(name) >= 2:
                name_to_did[name] = did
            for alias in c.get("aliases") or []:
                alias_l = (alias or "").strip().lower()
                if alias_l and len(alias_l) >= 2:
                    name_to_did[alias_l] = did

        out: dict[str, dict] = {}
        for name in entity_names:
            key = (name or "").strip().lower()
            if not key:
                continue
            did = name_to_did.get(key)
            if not did:
                continue  # entity isn't a known contact → no live path
            try:
                discoverable, capabilities = await self._appview_client.is_discoverable(did)
            except Exception as exc:
                log.debug(
                    "staging.enrich_appview_failed",
                    name=name, did=did, error=str(exc),
                )
                continue
            if not discoverable or not capabilities:
                continue
            # First capability wins. For multi-capability providers we
            # could extend this later to record all of them, but the
            # ToC row has a single live_capability slot — a reasonable
            # V1 constraint until we see providers that actually need
            # multiple.
            out[key] = {"did": did, "capability": capabilities[0]}
        return out

    async def _classify_personas(self, item: dict) -> tuple[list[str], dict | None]:
        """Classify item into one or more personas. Highest sensitivity first.

        Returns (persona_list, routing_meta). routing_meta is set when
        routing was ambiguous or subject ownership is unresolved.
        All names are validated against the registry when available.
        """
        # Clear stale attribution corrections from prior items.
        self._last_attribution_corrections = []

        # --- Step 1: Deterministic subject attribution (always runs) ---
        text = (item.get("body", "") + " " + item.get("summary", "")).strip()
        attributions = self._run_subject_attribution(text)

        # Inject attribution candidates into item for LLM context.
        if attributions:
            item["attribution_candidates"] = [
                {
                    "id": i + 1,
                    "subject": (a.contact.name if a.contact else a.subject_bucket),
                    "fact": a.hit.keyword,
                    "domain": a.hit.domain,
                    "bucket": a.subject_bucket,
                }
                for i, a in enumerate(attributions)
            ]
            # Mentioned contacts for LLM awareness.
            seen_dids: set[str] = set()
            mentioned = []
            for a in attributions:
                if a.contact and a.contact.did not in seen_dids:
                    seen_dids.add(a.contact.did)
                    mentioned.append({
                        "name": a.contact.name,
                        "relationship": a.contact.relationship,
                        "data_responsibility": a.contact.data_responsibility,
                    })
            if mentioned:
                item["mentioned_contacts"] = mentioned

        # --- Step 2: Primary classification (LLM or deterministic) ---
        primary, routing_meta = await self._classify_persona_with_meta(item)

        # --- Step 3: Apply LLM attribution corrections if available ---
        if attributions and self._last_attribution_corrections:
            attributions = self._apply_llm_corrections(
                attributions, self._last_attribution_corrections
            )
            self._last_attribution_corrections = []

        # --- Step 4: Responsibility override on primary ---
        primary, override_meta = self._apply_responsibility_override(
            primary, attributions, text
        )
        if override_meta and not routing_meta:
            routing_meta = override_meta
        elif override_meta and routing_meta:
            # Merge: unresolved subject takes priority.
            routing_meta.update(override_meta)

        # --- Step 5: Secondary expansion with responsibility filter ---
        text_lower = text.lower()
        from .sensitive_signals import has_health_signal, has_finance_signal, has_work_signal

        has_health = has_health_signal(text_lower)
        has_work = has_work_signal(text_lower)
        has_finance = has_finance_signal(text_lower)

        # Check if all sensitive attributions were overridden by the routing matrix.
        # An attribution is "overridden" when the matrix says its domain should
        # NOT go to a sensitive vault for that responsibility level.
        all_sensitive_overridden = False
        if attributions:
            sensitive_attrs = [a for a in attributions if a.hit.domain in ("health", "finance")]
            if sensitive_attrs:
                all_overridden = True
                for a in sensitive_attrs:
                    if self._keeps_sensitive(a.data_responsibility, a.hit.domain):
                        all_overridden = False
                        break
                all_sensitive_overridden = all_overridden

        secondary = set()
        if has_health and not all_sensitive_overridden:
            p = self._find_persona_by_prefix("health")
            if p and p != primary:
                secondary.add(p)
        if has_work:
            p = self._find_persona_by_prefix("work")
            if p and p != primary:
                secondary.add(p)
        if has_finance and not all_sensitive_overridden:
            p = self._find_persona_by_prefix("financ")
            if p and p != primary:
                secondary.add(p)

        result = [primary]
        for p in sorted(secondary, key=lambda p: _SENSITIVITY_RANK.get(p, 0), reverse=True):
            if p not in result:
                result.append(p)

        return result, routing_meta

    @staticmethod
    def _keeps_sensitive(responsibility: str, domain: str) -> bool:
        """Apply the routing matrix: does this responsibility keep sensitive routing?

        Returns True if the fact should stay in a sensitive vault.
        """
        if responsibility == "self":
            return True
        if responsibility == "household":
            return True
        if responsibility == "care" and domain == "health":
            return True
        if responsibility == "financial" and domain == "finance":
            return True
        if responsibility == "unresolved":
            return True  # Conservative: keep sensitive, flag for review
        # external, or care+finance, or financial+health → general
        return False

    # -- Subject attribution helpers ----------------------------------------

    def _run_subject_attribution(self, text: str) -> list:
        """Run deterministic subject attribution. Returns FactAttribution list."""
        if not text or not self._trust_scorer:
            return []
        try:
            from .contact_matcher import ContactMatcher
            from .subject_attributor import SubjectAttributor

            # Build ContactMatcher from trust_scorer's contact cache.
            contact_dicts = []
            for c in self._trust_scorer._contacts.values():
                contact_dicts.append({
                    "name": c.name or "",
                    "did": c.did or "",
                    "relationship": getattr(c, "relationship", "unknown") or "unknown",
                    "data_responsibility": getattr(c, "data_responsibility", "external") or "external",
                })

            matcher = ContactMatcher(contact_dicts) if contact_dicts else None
            attributor = SubjectAttributor(matcher)
            return attributor.attribute(text)
        except Exception as exc:
            log.warning("staging.attribution_failed", error=str(exc))
            return []

    def _apply_llm_corrections(self, attributions: list, corrections: list[dict]) -> list:
        """Apply LLM attribution corrections by stable ID."""
        from .subject_attributor import FactAttribution
        correction_map = {c.get("id"): c for c in corrections if "id" in c}
        if not correction_map:
            return attributions

        updated = []
        for i, a in enumerate(attributions):
            cid = i + 1  # 1-indexed IDs
            if cid in correction_map:
                corrected = correction_map[cid]
                new_bucket = corrected.get("corrected_bucket", a.subject_bucket)
                # Map bucket to data_responsibility.
                resp_map = {
                    "self_explicit": "self",
                    "household_implicit": "household",
                    "known_contact": a.data_responsibility,
                    "unknown_third_party": "external",
                    "unresolved": "unresolved",
                }
                new_resp = resp_map.get(new_bucket, a.data_responsibility)
                updated.append(FactAttribution(
                    hit=a.hit,
                    subject_bucket=new_bucket,
                    contact=a.contact,
                    data_responsibility=new_resp,
                ))
            else:
                updated.append(a)
        return updated

    def _apply_responsibility_override(
        self, primary: str, attributions: list, text: str = ""
    ) -> tuple[str, dict | None]:
        """Apply per-fact responsibility routing override.

        Returns (possibly_overridden_primary, routing_meta_or_none).
        """
        if not attributions:
            return primary, None

        # Only override health/finance primaries.
        if primary not in ("health", "finance"):
            # Check if primary matches a health/finance-prefixed persona.
            is_sensitive_primary = any(
                primary.startswith(p) for p in ("health", "finance", "financ", "medical")
            )
            if not is_sensitive_primary:
                return primary, None

        sensitive_domain = "health" if primary.startswith("health") or primary.startswith("medical") else "finance"

        # Evaluate each sensitive attribution.
        keeps_sensitive = False
        has_unresolved = False
        unresolved_facts = []

        for a in attributions:
            if a.hit.domain not in ("health", "finance"):
                continue

            resp = a.data_responsibility
            domain = a.hit.domain

            if resp == "unresolved":
                has_unresolved = True
                keeps_sensitive = True
                # Extract surrounding context (up to 60 chars around the hit).
                start = max(0, a.hit.span[0] - 20)
                end = min(len(text), a.hit.span[1] + 40) if text else a.hit.span[1]
                snippet = text[start:end].strip() if text else a.hit.keyword
                unresolved_facts.append({
                    "text": snippet,
                    "domain": domain,
                    "span": list(a.hit.span),
                })
            elif self._keeps_sensitive(resp, domain):
                keeps_sensitive = True

        routing_meta = None
        if has_unresolved:
            routing_meta = {
                "kind": "unresolved_subject_ownership",
                "unresolved_facts": unresolved_facts,
                "reason": "Sensitive fact could not be safely attributed",
                "suggested_action": "review_and_attribute",
            }

        if keeps_sensitive:
            return primary, routing_meta
        else:
            # All sensitive facts belong to external contacts → override to general.
            log.info(
                "staging.responsibility_override",
                original=primary,
                overridden_to="general",
                attribution_count=len(attributions),
            )
            return "general", routing_meta

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
                    # Capture event flag for reminder planning after resolve.
                    if result.has_event:
                        self._last_event_hint = result.event_hint
                        log.info("staging.event_detected", hint=result.event_hint)
                    # Capture attribution corrections for responsibility override.
                    if result.attribution_corrections:
                        self._last_attribution_corrections = result.attribution_corrections
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
