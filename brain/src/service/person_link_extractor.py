"""Person identity link extractor — LLM-based extraction from stored notes.

Sends note content to the LLM with the identity extraction prompt.
High confidence → auto-confirmed. Medium/low → suggested + review.
LLM failure → nothing learned, no harm.
"""

from __future__ import annotations

import json
from typing import Any

import structlog

from ..prompts import PROMPT_PERSON_IDENTITY_EXTRACTION

log = structlog.get_logger(__name__)

EXTRACTOR_VERSION = "llm-v1"


class PersonLinkExtractor:
    """Extracts person identity links from stored notes via LLM.

    Parameters
    ----------
    llm:
        LLM router for extraction calls.
    core:
        Core HTTP client for writing extraction results.
    """

    def __init__(self, llm: Any, core: Any) -> None:
        self._llm = llm
        self._core = core

    async def extract(self, text: str, source_item_id: str) -> dict | None:
        """Extract identity links from a note and apply to Core.

        Returns the extraction result dict, or None on failure.
        """
        if not text or not text.strip():
            return None

        # Call LLM with the identity extraction prompt.
        try:
            messages = [
                {"role": "system", "content": PROMPT_PERSON_IDENTITY_EXTRACTION},
                {"role": "user", "content": text},
            ]
            resp = await self._llm.route(
                task_type="classification",
                prompt=text,
                messages=messages,
            )
            content = resp.get("content", "")
        except Exception as exc:
            log.warning("person_extract.llm_failed", error=str(exc))
            return None

        # Parse LLM response.
        links = self._parse_response(content)
        if not links:
            return None

        # Build extraction result for Core.
        result = {
            "source_item_id": source_item_id,
            "extractor_version": EXTRACTOR_VERSION,
            "results": [],
        }

        for link in links:
            name = link.get("name", "").strip()
            role_phrase = link.get("role_phrase", "").strip()
            relationship = link.get("relationship", "other").strip()
            confidence = link.get("confidence", "medium").strip().lower()
            evidence = link.get("evidence", "").strip()

            if not name and not role_phrase:
                continue  # nothing to link
            if confidence not in ("high", "medium", "low"):
                confidence = "medium"

            surfaces = []
            if name:
                surfaces.append({
                    "surface": name,
                    "surface_type": "name",
                    "confidence": confidence,
                })
            if role_phrase:
                surfaces.append({
                    "surface": role_phrase,
                    "surface_type": "role_phrase",
                    "confidence": confidence,
                })

            result["results"].append({
                "canonical_name": name or role_phrase,
                "relationship_hint": relationship,
                "surfaces": surfaces,
                "source_excerpt": evidence[:200] if evidence else text[:100],
            })

        if not result["results"]:
            return None

        # Apply to Core.
        try:
            resp = await self._core._request(
                "POST", "/v1/people/apply-extraction",
                json=result,
            )
            return resp.json()
        except Exception as exc:
            log.warning("person_extract.apply_failed", error=str(exc))
            return None

    def _parse_response(self, content: str) -> list[dict]:
        """Parse LLM JSON response into identity links."""
        try:
            text = content.strip()
            if text.startswith("```"):
                text = text.split("\n", 1)[-1].rsplit("```", 1)[0].strip()

            data = json.loads(text)
            links = data.get("identity_links", [])
            if not isinstance(links, list):
                return []
            return links
        except (json.JSONDecodeError, ValueError, KeyError) as exc:
            log.warning("person_extract.parse_failed", error=str(exc))
            return []
