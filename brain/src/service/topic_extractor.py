"""Topic extraction for the Working Memory index.

Reads a vault item's enriched content (L0 summary, L1 paragraph) and
emits a short list of entities and themes that should feed
`POST /v1/memory/topic/touch`. Single LLM call per item — piggybacks
on the existing enrichment pipeline, no new models or libraries.

See docs/WORKING_MEMORY_DESIGN.md, §6–§7. What counts as a topic:

  - entity: a named proper noun (Sancho, HDFC, Castro Station,
    Dr Carl). Unambiguous, references a specific person / place /
    organisation / named event.
  - theme: a recurring domain or common-noun phrase (tax planning,
    back pain, daughters school). Fuzzier; canonicalisation on the
    Core side collapses near-duplicates.

Design notes worth knowing here:
  - The extractor produces surface forms, NOT canonicals. Core's
    `ResolveAlias` collapses "tax planning"/"tax plan" into one row.
  - An item may produce zero topics (e.g., a trivial acknowledgment).
    Caller must handle that gracefully — no forced minimums.
  - Output is capped to keep the ingest cost bounded: ≤ 6 entities,
    ≤ 4 themes. The enrichment LLM already saw the content, so
    another request is cheap but we don't want runaway tag counts
    fragmenting salience.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any


log = logging.getLogger(__name__)


_PROMPT_TEMPLATE = """\
You are extracting topics from a vault item for Dina's Working Memory
index. This index tracks what subjects keep coming up in the user's
own data — so next time the user asks a question, Dina knows whether
they have relevant context stored.

Given the item below, return a JSON object with two fields:

  entities: named proper nouns — people, places, organisations, named
            events. Each entity is ONE referent. Examples: "Sancho",
            "HDFC Bank", "Castro Station", "Dr Carl", "Diwali 2026".
            Do NOT include pronouns ("I", "my wife") or generic types
            ("doctor", "bank").

  themes: recurring domains or common-noun phrases. Examples: "tax
          planning", "back pain", "daughters school", "home repairs",
          "work stress". 2-5 word phrases; lowercase.

Rules:
  - ≤ 6 entities. Only people/places/orgs actually named in the text.
  - ≤ 4 themes. Only domains the text is actually about.
  - Skip boilerplate (greetings, closings, pronoun-only references).
  - If the item is trivial (e.g. "ok" or "thanks"), return empty arrays.
  - Return ONLY the JSON object, no prose, no code fence.

Vault item:
  summary: {summary}
  content: {content}

JSON:
"""


class TopicExtractor:
    """Extracts entities + themes from an enriched vault item.

    Parameters
    ----------
    llm
        An LLM router with a `complete(prompt, task_type=..., max_tokens=...)`
        async method. The enrichment service already injects this; we
        reuse it rather than opening a new LLM client.
    entity_vault
        Optional PII scrubber with `scrub(text) -> (scrubbed, vault)`
        and `rehydrate(text, vault) -> text`. Topic extraction sends
        content to a cloud LLM, so PII must be scrubbed going in and
        rehydrated coming out — same contract as EnrichmentService.
    """

    def __init__(self, llm: Any, entity_vault: Any = None) -> None:
        self._llm = llm
        self._entity_vault = entity_vault

    async def extract(self, item_dict: dict) -> dict:
        """Return ``{"entities": [...], "themes": [...]}`` for an item.

        On any failure (LLM unavailable, malformed JSON, PII scrubber
        throws), returns empty lists rather than raising. Topic
        extraction is enrichment-of-enrichment — a nice-to-have, not
        load-bearing for staging to resolve.
        """
        summary = (item_dict.get("summary") or item_dict.get("content_l0") or "").strip()
        content = (item_dict.get("content_l1") or item_dict.get("body") or "").strip()

        # Keep prompt tight — the L1 is already a paragraph summary of
        # the full item, so truncating harder than the rest of the
        # pipeline does is unnecessary. But cap anyway to prevent
        # pathological inputs from blowing the LLM budget.
        if len(content) > 2000:
            content = content[:2000]
        if len(summary) > 500:
            summary = summary[:500]

        if not summary and not content:
            return {"entities": [], "themes": []}

        # PII scrub before leaving the process.
        pii_vault: dict = {}
        if self._entity_vault is not None:
            try:
                if summary:
                    summary, vault_s = await self._entity_vault.scrub(summary)
                    pii_vault.update(vault_s)
                if content:
                    content, vault_c = await self._entity_vault.scrub(content)
                    pii_vault.update(vault_c)
            except Exception as exc:
                log.warning("topic_extractor.scrub_failed", extra={"error": str(exc)})
                return {"entities": [], "themes": []}

        prompt = _PROMPT_TEMPLATE.format(summary=summary or "(empty)",
                                         content=content or "(empty)")

        try:
            result = await self._llm.route(
                task_type="classification",
                prompt=prompt,
                persona_tier="default",
            )
        except Exception as exc:
            log.warning("topic_extractor.llm_failed", extra={"error": str(exc)})
            return {"entities": [], "themes": []}

        raw = (result or {}).get("content", "")
        parsed = _parse_json_response(raw)
        entities = _sanitise_list(parsed.get("entities"), limit=6)
        themes = _sanitise_list(parsed.get("themes"), limit=4)

        # Rehydrate PII tokens so downstream memory rows hold original
        # proper nouns (the encrypted vault is the secure boundary —
        # the ToC that quotes these entity names must NOT contain
        # scrubbed placeholders).
        if pii_vault and self._entity_vault is not None:
            entities = [self._entity_vault.rehydrate(e, pii_vault) for e in entities]
            themes = [self._entity_vault.rehydrate(t, pii_vault) for t in themes]

        return {"entities": entities, "themes": themes}


# ---------------------------------------------------------------------------
# Small parsing helpers
# ---------------------------------------------------------------------------

def _parse_json_response(raw: str) -> dict:
    """Extract the first JSON object from an LLM response.

    Gemini sometimes wraps JSON in a ```json code fence even when we
    ask it not to. Strip the fence if present, then try json.loads.
    On any failure return an empty dict so the caller handles it the
    same way as a genuinely-empty response.
    """
    if not raw:
        return {}
    # Strip optional code fence.
    raw = raw.strip()
    if raw.startswith("```"):
        # Remove the opening fence and language marker, and the closing fence.
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)
    try:
        obj = json.loads(raw)
    except (ValueError, TypeError):
        return {}
    if isinstance(obj, dict):
        return obj
    return {}


def _sanitise_list(raw: Any, *, limit: int) -> list[str]:
    """Normalise an LLM-emitted list into a capped, deduped list of
    lowercase-trimmed strings. Drops empties and obvious junk (items
    longer than 80 chars are almost certainly malformed output).
    """
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, str):
            continue
        s = item.strip()
        if not s or len(s) > 80:
            continue
        key = s.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(s)
        if len(out) >= limit:
            break
    return out
