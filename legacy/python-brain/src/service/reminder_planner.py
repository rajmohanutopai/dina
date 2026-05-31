"""Reminder Planner — LLM-driven reminder generation from temporal events.

When the classification LLM flags has_event=true, this service:
1. Queries the vault for context about the people/topics mentioned
2. Asks an LLM to plan actionable reminders with specific times
3. Creates the reminders in Core
4. Returns a human-friendly summary for the user

The LLM decides everything: how many reminders, what times, what text.
No hardcoded rules for birthdays vs appointments vs payments.
"""

from __future__ import annotations

import datetime as _dt
import json
from typing import Any

import structlog

from ..prompts import PROMPT_REMINDER_PLANNER_SYSTEM as _PLANNER_PROMPT

log = structlog.get_logger(__name__)


class ReminderPlanner:
    """Plans reminders using LLM + vault context.

    Parameters
    ----------
    core:
        HTTP client for Core (vault queries, reminder creation).
    llm:
        LLM router for planning calls.
    """

    def __init__(self, core: Any, llm: Any) -> None:
        self._core = core
        self._llm = llm

    async def plan_and_create(
        self,
        content: str,
        event_hint: str,
        persona: str,
        vault_item_id: str = "",
        source: str = "",
    ) -> dict:
        """Plan reminders for a temporal event and create them in Core.

        Returns dict with 'reminders' (list of created reminder dicts)
        and 'summary' (human-friendly one-liner).
        """
        # 1. Query vault for context about people/topics mentioned.
        vault_context = await self._gather_vault_context(content, event_hint)

        # 2. Ask LLM to plan reminders.
        import os as _os
        tz_name = _os.environ.get("DINA_TIMEZONE", "UTC")
        try:
            import zoneinfo as _zi
            user_tz = _zi.ZoneInfo(tz_name)
        except Exception:
            user_tz = _dt.timezone.utc
        now = _dt.datetime.now(user_tz)
        today = now.strftime("%Y-%m-%dT%H:%M:%S%z")

        context_text = ""
        if vault_context:
            context_text = "Relevant context from the user's vault:\n"
            for item in vault_context:
                context_text += f"- {item}\n"
        else:
            context_text = "No additional vault context available."

        prompt = _PLANNER_PROMPT.format(
            today=today,
            content=content,
            vault_context=context_text,
            timezone=tz_name,
        )

        try:
            resp = await self._llm.route(
                task_type="summarization",  # lite model: fast, consistent JSON output
                prompt=prompt,
                messages=[
                    {"role": "system", "content": "You are a personal reminder planner. Respond with JSON only."},
                    {"role": "user", "content": prompt},
                ],
            )
        except Exception as exc:
            log.warning("reminder_planner.llm_failed", error=str(exc))
            return {"reminders": [], "summary": "Could not plan reminders."}

        # 3. Parse LLM response.
        raw = resp.get("content", "")
        planned = self._parse_response(raw)

        # 4. Create reminders in Core.
        created = []
        for r in planned.get("reminders", []):
            try:
                fire_at = r.get("fire_at", "")
                dt = _dt.datetime.fromisoformat(fire_at.replace("Z", "+00:00"))
                trigger_ts = int(dt.timestamp())

                # Skip past reminders.
                if trigger_ts <= int(now.timestamp()):
                    continue

                reminder = {
                    "type": "",  # one-time
                    "message": r.get("message", ""),
                    "trigger_at": trigger_ts,
                    "metadata": "{}",
                    "source_item_id": vault_item_id,
                    "source": source,
                    "persona": persona,
                    "kind": r.get("kind", "reminder"),
                }
                rem_id = await self._core.store_reminder(reminder)
                # Generate a short external ID (4 chars) for user-facing display.
                import hashlib
                short_id = hashlib.md5(rem_id.encode()).hexdigest()[:4]
                r["id"] = rem_id
                r["short_id"] = short_id
                created.append(r)
                log.info("reminder_planner.created",
                         id=rem_id, kind=r.get("kind"), fire_at=fire_at,
                         message=r.get("message", "")[:60])
            except Exception as exc:
                log.warning("reminder_planner.create_failed", error=str(exc))

        summary = planned.get("summary", f"{len(created)} reminder(s) set.")
        return {"reminders": created, "summary": summary}

    async def _gather_vault_context(self, content: str, event_hint: str) -> list[str]:
        """Query vault for relevant context about people/topics in the content."""
        context_items: list[str] = []

        # Extract search terms — names, nouns, anything that might find
        # related vault items. Only exclude true grammatical stop words.
        _STOP = {
            "the", "a", "an", "is", "are", "was", "were", "be", "been",
            "am", "do", "does", "did", "has", "have", "had", "will",
            "would", "could", "should", "may", "might", "shall", "can",
            "and", "but", "or", "nor", "not", "no", "so", "if", "then",
            "than", "that", "this", "these", "those", "it", "its",
            "of", "in", "on", "at", "to", "for", "by", "with", "from",
            "up", "out", "off", "over", "into", "onto", "upon",
            "he", "she", "they", "we", "you", "i", "me", "my", "mine",
            "your", "yours", "his", "her", "our", "their", "them",
            "who", "what", "when", "where", "how", "which", "whom",
            "about", "after", "before", "between", "through", "during",
        }
        search_terms = set()
        for word in (event_hint + " " + content).split():
            cleaned = word.strip(".,!?;:'\"()[]{}#@")
            # Strip possessives: Emma's → Emma
            if cleaned.endswith("'s") or cleaned.endswith("\u2019s"):
                cleaned = cleaned[:-2]
            if len(cleaned) > 2 and cleaned.lower() not in _STOP:
                search_terms.add(cleaned)

        # Prioritize proper nouns (capitalized words = likely names).
        prioritized = sorted(search_terms, key=lambda t: (0 if t[0].isupper() else 1, t))

        # Search vault for each term (best-effort, limited).
        log.info("reminder_planner.vault_search", terms=prioritized[:5])
        for term in prioritized[:5]:
            try:
                items = await self._core.search_vault(
                    "general", term, mode="fts5",
                    user_origin="admin",
                )
                for item in items:
                    summary = getattr(item, "summary", "") or ""
                    if summary and summary not in context_items:
                        context_items.append(summary[:150])
                if items:
                    log.info("reminder_planner.vault_found", term=term, count=len(items))
            except Exception as exc:
                log.warning("reminder_planner.vault_search_failed", term=term, error=str(exc))

        return context_items[:5]  # cap at 5 items

    def _parse_response(self, content: str) -> dict:
        """Parse LLM JSON response."""
        try:
            text = content.strip()
            if text.startswith("```"):
                text = text.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
            return json.loads(text)
        except (json.JSONDecodeError, ValueError):
            log.warning("reminder_planner.parse_failed", content=content[:100])
            return {"reminders": [], "summary": "Could not parse reminder plan."}
