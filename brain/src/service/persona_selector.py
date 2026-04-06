"""PersonaSelector — LLM-assisted persona selection from installed set.

Chooses which persona(s) an item belongs to by asking the LLM to pick
from the actual installed personas. Never invents persona names.

Resolution order:
1. Explicit valid persona_hint → use it
2. Constrained LLM selection → choose from installed list only
3. Validate → drop anything not in registry
4. Fallback → default persona
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

import structlog

from ..prompts import PROMPT_PERSONA_CLASSIFY_SYSTEM as _SYSTEM_PROMPT
from .persona_registry import PersonaInfo, PersonaRegistry

log = structlog.get_logger(__name__)


@dataclass
class SelectionResult:
    """Result of persona selection."""

    primary: str | None = None
    secondary: list[str] = field(default_factory=list)
    confidence: float = 0.0
    reason: str = ""
    has_event: bool = False
    event_hint: str = ""
    attribution_corrections: list[dict] = field(default_factory=list)
    # LLM corrections to deterministic attributions, by stable ID:
    # [{"id": 1, "corrected_bucket": "self_explicit", "reason": "..."}]


class PersonaSelector:
    """Selects persona(s) for an item using constrained LLM selection.

    Parameters
    ----------
    registry:
        PersonaRegistry for validation.
    llm:
        LLM router for classification calls.
    default_persona:
        Fallback persona when LLM is unavailable or low-confidence.
    """

    def __init__(
        self,
        registry: PersonaRegistry,
        llm: Any = None,
        default_persona: str = "general",
    ) -> None:
        self._registry = registry
        self._llm = llm
        self._default = default_persona

    async def select(
        self,
        item: dict,
        persona_hint: str | None = None,
    ) -> SelectionResult | None:
        """Select persona(s) for an item.

        1. If persona_hint is valid, use it directly.
        2. Otherwise, ask LLM to choose from installed personas.
        3. Validate result against registry.
        4. Return None if no confident selection — caller uses deterministic fallback.
        """
        # 1. Explicit valid hint
        if persona_hint:
            norm = self._registry.normalize(persona_hint)
            if self._registry.exists(norm):
                return SelectionResult(
                    primary=norm,
                    confidence=1.0,
                    reason="explicit persona hint",
                )

        # 2. LLM selection
        if self._llm:
            try:
                result = await self._llm_select(item)
                if result and result.primary:
                    return result
            except Exception as exc:
                log.warning("persona_selector.llm_failed", error=str(exc))

        # No confident answer — return None so caller can use deterministic fallback
        return None

    async def _llm_select(self, item: dict) -> SelectionResult | None:
        """Ask the LLM to choose from installed personas."""
        personas = self._registry.all_names()
        if not personas:
            return None

        # Build persona descriptions for the prompt — include description
        # from the registry so the LLM knows what each persona is for.
        persona_list = []
        for name in personas:
            tier = self._registry.tier(name) or "default"
            desc = self._registry.description(name)
            entry: dict = {"name": name, "tier": tier}
            if desc:
                entry["description"] = desc
            persona_list.append(entry)

        # Build item context (scrub to essentials)
        item_context = {
            "item_type": item.get("type", ""),
            "source": item.get("source", ""),
            "sender": item.get("sender", ""),
            "summary": (item.get("summary", "") or "")[:200],
            "body_preview": (item.get("body", "") or "")[:300],
        }

        # Include mentioned contacts for relationship-aware routing.
        mentioned = item.get("mentioned_contacts")
        if mentioned:
            item_context["mentioned_contacts"] = mentioned

        # Include attribution candidates for LLM correction.
        attribution_candidates = item.get("attribution_candidates")
        if attribution_candidates:
            item_context["attribution_candidates"] = attribution_candidates

        import datetime as _dt
        today = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%d")

        prompt = json.dumps({
            "today": today,
            "available_personas": persona_list,
            **item_context,
        }, indent=2)

        messages = [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ]

        resp = await self._llm.route(
            task_type="classification",
            prompt=prompt,
            messages=messages,
        )

        content = resp.get("content", "")
        return self._parse_response(content)

    def _parse_response(self, content: str) -> SelectionResult | None:
        """Parse LLM JSON response and validate against registry."""
        try:
            # Extract JSON from possible markdown code fences
            text = content.strip()
            if text.startswith("```"):
                text = text.split("\n", 1)[-1].rsplit("```", 1)[0].strip()

            data = json.loads(text)

            primary = data.get("primary", "")
            secondary = data.get("secondary", [])
            confidence = float(data.get("confidence", 0.0))
            reason = data.get("reason", "")

            # Validate primary
            if primary and not self._registry.exists(primary):
                log.warning(
                    "persona_selector.invalid_primary",
                    primary=primary,
                    available=self._registry.all_names(),
                )
                return None

            # Filter secondary to valid personas only
            valid_secondary = [
                s for s in secondary
                if s != primary and self._registry.exists(s)
            ]

            return SelectionResult(
                primary=primary or None,
                secondary=valid_secondary,
                confidence=confidence,
                reason=reason,
                has_event=bool(data.get("has_event", False)),
                event_hint=data.get("event_hint", ""),
                attribution_corrections=data.get("attribution_corrections", []),
            )
        except (json.JSONDecodeError, ValueError, KeyError) as exc:
            log.warning("persona_selector.parse_failed", error=str(exc))
            return None
