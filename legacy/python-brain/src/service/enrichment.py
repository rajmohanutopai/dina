"""Tiered content enrichment — generates L0/L1 summaries for vault items.

L0 (one line): what it is, who from, when. Deterministic from metadata when possible.
L1 (one paragraph): key facts, names, dates, numbers. Preserves provenance.
L2: the original content (already stored as body).

Embeddings are regenerated from L1 when enrichment completes (better than raw L2).

No imports from adapter/ — only domain types and sibling services.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any

log = logging.getLogger(__name__)

# Current enrichment prompt version. Bumped when the prompt changes
# so items can be re-enriched with the new prompt.
_PROMPT_VERSION = 1

from ..prompts import PROMPT_ENRICHMENT_USER as _ENRICH_PROMPT  # noqa: E402
from ..prompts import PROMPT_ENRICHMENT_LOW_TRUST_INSTRUCTION as _LOW_TRUST_INSTRUCTION  # noqa: E402


class EnrichmentService:
    """Generates L0/L1 content summaries for vault items.

    Parameters
    ----------
    core:
        HTTP client for dina-core (read/write vault items).
    llm:
        LLM router for summarization.
    embed_model:
        Name of the embedding model (for enrichment_version tracking).
    """

    def __init__(
        self, core: Any, llm: Any,
        embed_model: str = "default",
        entity_vault: Any = None,
    ) -> None:
        self._core = core
        self._llm = llm
        self._embed_model = embed_model
        # FC2: PII scrubber for cloud-bound enrichment prompts.
        self._entity_vault = entity_vault

    async def enrich_raw(self, item_dict: dict) -> dict:
        """Enrich a classified item dict before vault publication.

        Generates L0, L1, and embedding in-memory without any Core HTTP
        calls. The caller is responsible for sending the enriched dict
        to Core (e.g. via staging_resolve).

        Returns the dict with content_l0, content_l1, embedding,
        enrichment_status, and enrichment_version populated.

        Raises on LLM failure so the caller can handle (e.g. staging_fail).
        """
        body = item_dict.get("body_text", "")
        summary = item_dict.get("summary", "")
        sender = item_dict.get("sender", "")
        sender_trust = item_dict.get("sender_trust", "")
        confidence = item_dict.get("confidence", "")
        item_type = item_dict.get("type", "")
        source = item_dict.get("source", "")
        timestamp = item_dict.get("timestamp", 0)

        # L0: deterministic from metadata when possible.
        l0 = _generate_l0_deterministic(
            item_type, sender, summary, timestamp,
            sender_trust, confidence,
        )

        # L0 + L1 via LLM (single call). No fallback — if LLM is
        # unavailable, enrichment fails and the item stays in staging.
        if self._llm is None:
            raise RuntimeError("enrichment requires LLM — no provider available")

        # Use body for LLM input; fall back to summary for summary-only
        # items (calendar events, dead references, short notes).
        llm_input = body or summary
        llm_summary = summary

        # FC2: Scrub ALL PII fields before sending to cloud LLM.
        # Body, summary, and sender can all contain PII (e.g. email addresses).
        # Source is a system identifier (gmail, d2d) — not PII, safe to pass.
        # If scrubbing fails, enrichment fails (fail-closed).
        #
        # The scrubbed text is used ONLY for the LLM call. The vault stores
        # original (unscrubbed) data — the vault IS the encrypted secure
        # boundary. PII tokens like <<PII:...>> must never be persisted in
        # vault items, otherwise query-time retrieval leaks scrub artifacts.
        llm_sender = sender
        pii_vault: dict = {}
        if self._entity_vault is not None:
            try:
                if llm_input:
                    scrubbed_input, vault_input = await self._entity_vault.scrub(llm_input)
                    llm_input = scrubbed_input
                    pii_vault.update(vault_input)
                if summary:
                    scrubbed_summary, vault_summary = await self._entity_vault.scrub(summary)
                    llm_summary = scrubbed_summary
                    pii_vault.update(vault_summary)
                if sender:
                    scrubbed_sender, _ = await self._entity_vault.scrub(sender)
                    llm_sender = scrubbed_sender
            except Exception as exc:
                raise RuntimeError(
                    f"enrichment: PII scrub failed — refusing to send raw content to cloud LLM: {exc}"
                ) from exc

        l1 = ""
        if llm_input:
            l0_llm, l1 = await self._generate_l0_l1_llm(
                item_type, source, llm_sender, llm_summary, llm_input,
                sender_trust, confidence,
            )
            if not l0 or len(l0) < 10:
                l0 = l0_llm

        if not l1:
            raise RuntimeError(
                f"LLM failed to generate L1 for item (type={item_type}, "
                f"body_len={len(body)}, summary_len={len(summary)})"
            )

        # Rehydrate PII tokens in L0/L1 before storing in vault.
        # The LLM generated these from scrubbed input, so they contain
        # tokens like <<PII:West Kennethhaven>> or [PERSON_1]. Vault data
        # must contain original values — the encrypted vault is the secure
        # boundary, not PII scrub tokens.
        if pii_vault and self._entity_vault is not None:
            l0 = self._entity_vault.rehydrate(l0, pii_vault)
            l1 = self._entity_vault.rehydrate(l1, pii_vault)

        # Embedding from L1 (not L2 — L1 is cleaner, better semantic quality).
        # Use the rehydrated L1 so semantic search matches original terms.
        embedding = await self._llm.embed(l1[:2000])

        version = json.dumps({
            "prompt_v": _PROMPT_VERSION,
            "embed_model": self._embed_model,
            "enriched_at": int(time.time()),
        })

        item_dict["content_l0"] = l0
        item_dict["content_l1"] = l1
        item_dict["enrichment_status"] = "ready"
        item_dict["enrichment_version"] = version
        item_dict["embedding"] = embedding

        return item_dict

    async def enrich_item(self, persona: str, item_id: str) -> bool:
        """Enrich a single vault item with L0/L1/embedding.

        Fetches the item from Core, enriches via enrich_raw(), then
        PATCHes Core with the results. Used by the legacy enrichment
        sweep for pre-migration items.

        Returns True on success, False on failure.
        """
        try:
            await self._core.enrich_item(
                item_id, persona=persona,
                enrichment_status="processing",
            )
        except Exception:
            pass  # best-effort status update

        try:
            item = await self._core.get_vault_item(persona, item_id)
            if item is None:
                log.warning("enrichment.item_not_found", extra={"id": item_id})
                return False

            # Normalize field names (Core returns PascalCase, we use snake_case).
            raw = {
                "body_text": item.get("body_text", item.get("body", item.get("BodyText", ""))),
                "summary": item.get("summary", item.get("Summary", "")),
                "sender": item.get("sender", item.get("Sender", "")),
                "sender_trust": item.get("sender_trust", item.get("SenderTrust", "")),
                "confidence": item.get("confidence", item.get("Confidence", "")),
                "type": item.get("type", item.get("Type", "")),
                "source": item.get("source", item.get("Source", "")),
                "timestamp": item.get("timestamp", item.get("Timestamp", 0)),
            }

            enriched = await self.enrich_raw(raw)

            await self._core.enrich_item(
                item_id, persona=persona,
                content_l0=enriched.get("content_l0", ""),
                content_l1=enriched.get("content_l1", ""),
                embedding=enriched.get("embedding"),
                enrichment_status="ready",
                enrichment_version=enriched.get("enrichment_version", ""),
            )

            log.info("enrichment.complete", extra={
                "id": item_id,
                "l0_len": len(enriched.get("content_l0", "")),
                "l1_len": len(enriched.get("content_l1", "")),
            })
            return True

        except Exception as exc:
            log.warning("enrichment.failed", extra={
                "id": item_id, "error": str(exc),
            })
            try:
                await self._core.enrich_item(
                    item_id, persona=persona,
                    enrichment_status="failed",
                )
            except Exception:
                pass
            return False

    async def enrich_pending(self, persona: str, limit: int = 10) -> int:
        """Enrich pending/failed items. Returns count of items enriched."""
        try:
            items = await self._core.search_vault(
                persona, query="", mode="fts5",
                include_all=True,
            )
        except Exception:
            return 0

        # Filter to pending/failed items.
        pending = [
            it for it in items
            if it.get("enrichment_status", it.get("EnrichmentStatus", ""))
            in ("pending", "failed")
        ][:limit]

        enriched = 0
        for item in pending:
            item_id = item.get("id", item.get("ID", ""))
            if item_id and await self.enrich_item(persona, item_id):
                enriched += 1

        return enriched

    async def _generate_l0_l1_llm(
        self,
        item_type: str, source: str, sender: str,
        summary: str, body: str,
        sender_trust: str, confidence: str,
    ) -> tuple[str, str]:
        """Generate L0 + L1 via a single LLM call. Returns (l0, l1)."""
        is_low_trust = sender_trust in ("unknown", "marketing") or confidence == "low"

        provenance_instruction = ""
        if is_low_trust:
            source_desc = f"email from {sender}" if sender else "source"
            provenance_instruction = _LOW_TRUST_INSTRUCTION.format(
                source_desc=source_desc,
            )

        prompt = _ENRICH_PROMPT.format(
            provenance_instruction=provenance_instruction,
            item_type=item_type or "unknown",
            source=source or "unknown",
            sender=sender or "unknown",
            summary=summary or "(no subject)",
            body=body[:4000],  # cap to avoid token explosion
        )

        try:
            result = await self._llm.route(
                task_type="summarization",
                prompt=prompt,
                persona_tier="default",
            )
            content = result.get("content", "")

            # Parse JSON response.
            # Strip markdown code fences if present.
            content = content.strip()
            if content.startswith("```"):
                content = content.split("\n", 1)[-1]
                content = content.rsplit("```", 1)[0]
            parsed = json.loads(content)
            return parsed.get("l0", ""), parsed.get("l1", "")

        except (json.JSONDecodeError, KeyError, TypeError) as exc:
            log.warning("enrichment.llm_parse_failed", extra={"error": str(exc)})
            return "", ""
        except Exception as exc:
            log.warning("enrichment.llm_call_failed", extra={"error": str(exc)})
            return "", ""


def _generate_l0_deterministic(
    item_type: str, sender: str, summary: str,
    timestamp: int, sender_trust: str, confidence: str,
) -> str:
    """Generate L0 from metadata when possible (no LLM needed).

    Returns empty string if metadata is insufficient.
    """
    is_low_trust = sender_trust in ("unknown", "marketing") or confidence == "low"

    # Format date from timestamp.
    date_str = ""
    if timestamp and timestamp > 0:
        try:
            import datetime
            dt = datetime.datetime.fromtimestamp(timestamp, tz=datetime.timezone.utc)
            date_str = dt.strftime("%b %d, %Y")
        except (ValueError, OSError):
            pass

    # Low-trust items: always caveat.
    if is_low_trust and summary:
        sender_desc = f"from {sender}" if sender else "from unknown sender"
        return f"Unverified {item_type or 'content'} {sender_desc}: {summary[:80]}"

    # Build from available metadata.
    parts = []
    if item_type:
        parts.append(item_type.replace("_", " ").title())
    if sender and sender != "user":
        parts.append(f"from {sender}")
    if date_str:
        parts.append(date_str)
    if summary and not parts:
        return summary[:120]
    if summary:
        parts.append(f"— {summary[:80]}")

    return ", ".join(parts) if parts else ""
