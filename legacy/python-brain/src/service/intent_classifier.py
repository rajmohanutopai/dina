"""Intent classifier — routes a user query across Dina's three sources.

Runs once before the reasoning agent starts. Small, fast LLM call that
reads the user's query plus Dina's Working Memory (ToC) and decides:

  - which source(s) can answer: vault, trust_network, provider_services
  - which personas in the vault are relevant
  - which ToC entries the classifier actually saw (evidence trail)
  - whether the answer depends on live external state

Output feeds the reasoning agent's first-turn context. The reasoning
agent doesn't re-read the ToC — the classifier's output is the
distilled view. See docs/WORKING_MEMORY_DESIGN.md §9.

Design notes:

  - No scenario enumeration. The classifier prompt defines what each
    source *is*; the LLM generalises. See §9.1.
  - Soft priming, not hard shortlisting. The reasoning agent can still
    call any tool if the query evolves or the classifier missed
    something (§9.3).
  - Output is always best-effort: on LLM failure, return a
    conservative default that points to the vault but doesn't commit
    to sources. The reasoning agent falls back to the full tool set.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from typing import Any


log = logging.getLogger(__name__)


_SYSTEM_PROMPT = """\
You are the intent classifier for Dina, a sovereign personal AI.
Your job is to decide which information source(s) can answer a user
query — before any tool is called. You do NOT answer the query
yourself.

THE THREE SOURCES

- vault — the user's own captured data: preferences, relationships,
  personal plans, life facts, past decisions, notes.
- trust_network — peer-verified opinions and reputation about
  products, services, vendors, people. Static (opinions at a point in
  time).
- provider_services — live queries to service providers for current
  operational state: ETA, status, availability, pricing, inventory.
  Dynamic (changes minute to minute).

HOW TO DECIDE

For any query, name the sources needed. It can be more than one.
Think in two axes:

- Source of context: does the query need the user's own data? If yes,
  include "vault". Self-referential grammar (my, I have, for me) is a
  strong signal but not required.
- Temporal nature: does the answer depend on live state? If yes, the
  answer comes from "provider_services" (possibly parameterised with
  vault context).

WORKING MEMORY

You'll see a Working Memory block showing what topics the user has
captured recently, grouped by persona. Use it to decide:

- Is a topic from the query present in Working Memory? Then the vault
  has context; include "vault".
- Is the query about an established service relationship ("my dentist",
  "my lawyer", etc.)? Then live data likely lives with that provider —
  include "provider_services". The downstream agent will look up the
  user's preferred contact for that category via its own tool; you
  don't need to resolve the specific provider here.
- Is a persona (like "health" or "finance") clearly relevant to the
  query even if no specific topic matches? Name it in relevant_personas.

OUTPUT FORMAT

Return ONLY a JSON object, no prose, no code fence:

{
  "sources": ["vault", "provider_services"],       // always a list, may be one or more
  "relevant_personas": ["health"],               // empty [] if no vault match
  "toc_evidence": {
    "entity_matches": ["Dr Carl"],               // ToC entities present in the query
    "theme_matches": [],                         // ToC themes matching the query
    "persona_context": {                         // per-persona: topics worth anchoring on
      "health": ["dentist appointment", "Dr Carl"]
    }
  },
  "temporal": "live_state",                      // "static" | "live_state" | "comparative"
  "reasoning_hint": "Short prose: why this routing."
}

Do NOT include extra keys. Do NOT answer the query."""


@dataclass
class IntentClassification:
    """Structured classification output.

    Mirrors the JSON shape above. Field names are snake_case to match
    what the reasoning agent's prompt expects. Provide a conservative
    fallback via `.default()` for error paths.
    """

    sources: list[str] = field(default_factory=list)
    relevant_personas: list[str] = field(default_factory=list)
    toc_evidence: dict = field(default_factory=dict)
    temporal: str = ""
    reasoning_hint: str = ""

    @classmethod
    def default(cls) -> "IntentClassification":
        """Conservative fallback when the classifier can't produce a
        result: don't commit to a source, so the reasoning agent keeps
        the full tool set. ``reasoning_hint`` signals the fallback to
        the reasoning agent so it knows the classifier was unavailable.
        """
        return cls(
            sources=["vault"],
            relevant_personas=[],
            toc_evidence={},
            temporal="",
            reasoning_hint="Classifier unavailable; reasoning agent should use its full tool set.",
        )

    def to_dict(self) -> dict:
        """JSON-serialisable view, suitable for injection into the
        reasoning agent's first-turn context.
        """
        return {
            "sources": list(self.sources),
            "relevant_personas": list(self.relevant_personas),
            "toc_evidence": dict(self.toc_evidence),
            "temporal": self.temporal,
            "reasoning_hint": self.reasoning_hint,
        }


class IntentClassifier:
    """Pre-reasoning routing classifier.

    Parameters
    ----------
    llm
        LLMRouter — the classifier uses ``task_type="classification"``
        so the router can pick the cheapest appropriate model.
    toc_fetcher
        Async callable ``() -> list[dict]`` returning the current ToC
        entries for the reasoning turn. Typically ``core.memory_toc``.
    """

    def __init__(self, llm: Any, toc_fetcher: Any) -> None:
        self._llm = llm
        self._fetch_toc = toc_fetcher

    async def classify(self, query: str) -> IntentClassification:
        """Run the classifier for a single user query.

        Always returns a classification; never raises. On LLM failure
        returns ``IntentClassification.default()`` so the caller can
        keep going.
        """
        query = (query or "").strip()
        if not query:
            return IntentClassification.default()

        try:
            toc_entries = await self._fetch_toc() or []
        except Exception as exc:
            log.warning("intent_classifier.toc_fetch_failed", extra={"error": str(exc)})
            toc_entries = []

        prompt = self._build_prompt(query, toc_entries)
        try:
            result = await self._llm.route(
                task_type="classification",
                prompt=prompt,
                persona_tier="default",
            )
        except Exception as exc:
            log.warning("intent_classifier.llm_failed", extra={"error": str(exc)})
            return IntentClassification.default()

        raw = (result or {}).get("content", "")
        parsed = _parse_json(raw)
        if not parsed:
            log.warning("intent_classifier.unparseable_response", extra={"raw": raw[:200]})
            return IntentClassification.default()

        return _coerce(parsed)

    # -- Prompt construction -----------------------------------------------

    def _build_prompt(self, query: str, toc: list[dict]) -> str:
        toc_block = _render_toc_for_prompt(toc)
        return (
            _SYSTEM_PROMPT
            + "\n\nWorking Memory:\n"
            + toc_block
            + "\n\nUser query:\n"
            + query
            + "\n\nClassification JSON:"
        )


# ---------------------------------------------------------------------------
# ToC rendering for the classifier prompt
# ---------------------------------------------------------------------------

def _render_toc_for_prompt(entries: list[dict]) -> str:
    """Compact, persona-grouped ToC view the classifier prompt can read.

    Format mirrors §8 of the design doc — persona name, then a short
    list of topics. Capability metadata is no longer rendered inline
    here: the downstream reasoning agent resolves provider bindings
    via contact preferences (``preferred_for``) rather than via
    pre-stamped ToC markers.
    """
    if not entries:
        return "(empty — user has not captured any topics yet)"

    grouped: dict[str, list[dict]] = {}
    for e in entries:
        grouped.setdefault(e.get("persona") or "general", []).append(e)

    lines: list[str] = []
    for persona, rows in grouped.items():
        labels: list[str] = []
        for row in rows:
            topic = row.get("topic") or ""
            if not topic:
                continue
            labels.append(topic)
        if labels:
            lines.append(f"  {persona}: " + ", ".join(labels))
    return "\n".join(lines) if lines else "(empty)"


# ---------------------------------------------------------------------------
# JSON parsing and coercion
# ---------------------------------------------------------------------------

def _parse_json(raw: str) -> dict:
    """Extract the first JSON object from an LLM response. Handles the
    code-fence case even when we ask the model to skip it.
    """
    if not raw:
        return {}
    raw = raw.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)
    try:
        obj = json.loads(raw)
    except (ValueError, TypeError):
        return {}
    return obj if isinstance(obj, dict) else {}


_ALLOWED_SOURCES = {"vault", "trust_network", "provider_services", "general_knowledge"}
_ALLOWED_TEMPORAL = {"static", "live_state", "comparative", ""}


def _coerce(data: dict) -> IntentClassification:
    """Normalise a parsed LLM response into an IntentClassification.

    Filters unknown source names and temporal values so the reasoning
    agent's context never contains garbage. Keeps `toc_evidence` as-is
    since its structure is LLM-generated; the reasoning agent treats it
    as a hint, not a contract.
    """
    sources = [s for s in _as_str_list(data.get("sources")) if s in _ALLOWED_SOURCES]
    if not sources:
        # LLM gave us nothing actionable — retreat to the conservative
        # default rather than propagating an empty list.
        sources = ["vault"]

    personas = _as_str_list(data.get("relevant_personas"))
    toc_ev = data.get("toc_evidence")
    if not isinstance(toc_ev, dict):
        toc_ev = {}

    temporal = data.get("temporal") or ""
    if temporal not in _ALLOWED_TEMPORAL:
        temporal = ""

    hint = data.get("reasoning_hint")
    if not isinstance(hint, str):
        hint = ""

    return IntentClassification(
        sources=sources,
        relevant_personas=personas,
        toc_evidence=toc_ev,
        temporal=temporal,
        reasoning_hint=hint,
    )


def _as_str_list(v: Any) -> list[str]:
    if not isinstance(v, list):
        return []
    out: list[str] = []
    for item in v:
        if isinstance(item, str):
            s = item.strip()
            if s:
                out.append(s)
    return out
