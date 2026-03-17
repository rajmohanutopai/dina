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

# Enrichment LLM prompt — single call produces both L0 and L1.
_ENRICH_PROMPT = """\
Given the following content, produce a JSON object with exactly two fields:
- "l0": one sentence describing what this is, who it's from, and when. \
Include the source/sender name and date if available.
- "l1": one paragraph summarizing the key facts. Preserve all names, dates, \
and numbers exactly. Do not infer unstated facts. Do not add opinions.

{provenance_instruction}

Content type: {item_type}
Source: {source}
Sender: {sender}
Subject: {summary}

--- Content ---
{body}
--- End Content ---

Respond with ONLY the JSON object, no other text."""

_LOW_TRUST_INSTRUCTION = (
    'IMPORTANT: This content is from an unverified source. '
    'Start l0 with "Unverified {source_desc} claims..." '
    'Start l1 with "An unverified source claims..."'
)


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

    def __init__(self, core: Any, llm: Any, embed_model: str = "default") -> None:
        self._core = core
        self._llm = llm
        self._embed_model = embed_model

    async def enrich_item(self, persona: str, item_id: str) -> bool:
        """Enrich a single vault item with L0/L1/embedding.

        Returns True on success, False on failure.
        """
        try:
            # Mark as processing (prevents duplicate work).
            await self._core.enrich_item(
                item_id, persona=persona,
                enrichment_status="processing",
            )
        except Exception:
            pass  # best-effort status update

        try:
            # Fetch the item (L2 = body).
            item = await self._core.get_vault_item(persona, item_id)
            if item is None:
                log.warning("enrichment.item_not_found", extra={"id": item_id})
                return False

            body = item.get("body_text", item.get("body", item.get("BodyText", "")))
            summary = item.get("summary", item.get("Summary", ""))
            sender = item.get("sender", item.get("Sender", ""))
            sender_trust = item.get("sender_trust", item.get("SenderTrust", ""))
            confidence = item.get("confidence", item.get("Confidence", ""))
            item_type = item.get("type", item.get("Type", ""))
            source = item.get("source", item.get("Source", ""))
            timestamp = item.get("timestamp", item.get("Timestamp", 0))

            # Generate L0 (deterministic when possible).
            l0 = _generate_l0_deterministic(
                item_type, sender, summary, timestamp,
                sender_trust, confidence,
            )

            # Generate L0 + L1 via LLM (one call).
            l1 = ""
            if body and self._llm is not None:
                l0_llm, l1 = await self._generate_l0_l1_llm(
                    item_type, source, sender, summary, body,
                    sender_trust, confidence,
                )
                # Use LLM L0 only if deterministic was insufficient.
                if not l0 or len(l0) < 10:
                    l0 = l0_llm

            # Fallback: L1 = truncated L2 if LLM failed.
            if not l1:
                l1 = (body or summary or "")[:500]

            # Generate embedding from L1.
            embedding = None
            if l1 and self._llm is not None:
                try:
                    embedding = await self._llm.embed(l1[:2000])
                except Exception:
                    log.debug("enrichment.embed_failed", extra={"id": item_id})

            # Build enrichment version metadata.
            version = json.dumps({
                "prompt_v": _PROMPT_VERSION,
                "embed_model": self._embed_model,
                "enriched_at": int(time.time()),
            })

            # PATCH Core with enrichment results.
            await self._core.enrich_item(
                item_id, persona=persona,
                content_l0=l0,
                content_l1=l1,
                embedding=embedding,
                enrichment_status="ready",
                enrichment_version=version,
            )

            log.info("enrichment.complete", extra={
                "id": item_id, "l0_len": len(l0), "l1_len": len(l1),
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
