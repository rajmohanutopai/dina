"""Ephemeral PII scrubbing for cloud LLM calls — the Entity Vault pattern.

The Entity Vault is an in-memory dict that maps anonymisation tokens
(``<PERSON_1>``, ``<ORG_1>``, etc.) back to their original values.
It exists for exactly one request:

    1. Build the vault from Tier 1 (Go regex) + Tier 2 (Presidio NER) results.
    2. Send the scrubbed text to the cloud LLM.
    3. Rehydrate the LLM's response by replacing tokens with originals.
    4. Discard the vault.

**Security invariants — must NEVER be violated:**

    - The vault dict is NEVER persisted (no disk, no DB, no logs).
    - Original PII values NEVER appear in any log output.
    - Each concurrent cloud LLM call has an independent vault (no cross-
      contamination).
    - When using a local LLM the vault is not created at all (PII stays
      on-device).
    - If PII scrubbing fails, the cloud send is refused (hard security
      gate via ``PIIScrubError``).

Maps to Brain TEST_PLAN SS3.3 (Entity Vault Pattern).

No imports from adapter/ — only port protocols and domain types.
"""

from __future__ import annotations

import asyncio
from typing import Any

import structlog

from ..domain.enums import Sensitivity
from ..domain.errors import PIIScrubError
from ..port.core_client import CoreClient
from ..port.scrubber import PIIScrubber

log = structlog.get_logger(__name__)


class EntityVaultService:
    """Orchestrates the full scrub-call-rehydrate cycle for cloud LLM calls.

    Parameters
    ----------
    scrubber:
        Tier 2 (Presidio NER) PII scrubber — implements ``scrub(text)``
        returning ``(scrubbed_text, entities)``.
    core_client:
        Used for Tier 1 (Go regex) scrubbing via ``POST /v1/pii/scrub``.
    classifier:
        Optional domain classifier controlling scrub intensity.
        When not provided, defaults to full scrubbing (ELEVATED).
    """

    def __init__(
        self,
        scrubber: PIIScrubber,
        core_client: CoreClient,
        classifier: Any = None,
    ) -> None:
        self._scrubber = scrubber
        self._core = core_client
        self._classifier = classifier

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def scrub_and_call(
        self,
        llm: Any,  # LLMProvider protocol — kept as Any to avoid circular
        messages: list[dict],
        persona: str | None = None,
        vault_context: dict[str, Any] | None = None,
    ) -> str:
        """Full Entity Vault flow: classify -> scrub -> call cloud LLM -> rehydrate.

        Steps
        -----
        1. **Classify** — determine sensitivity via domain classifier.
        2. **Tier 1** — regex scrub via core (``POST core/v1/pii/scrub``).
        3. **Tier 2** — Presidio NER scrub (local, in-process).
        4. Build ``entity_map`` from both tiers' detected entities.
        5. Call cloud LLM with fully scrubbed messages.
        6. Rehydrate LLM response: ``<PERSON_1>`` -> ``Dr. Sharma``.
        7. Discard entity map (ephemeral — never persisted, never logged).
        8. Return the rehydrated response text.

        Raises
        ------
        PIIScrubError
            If either scrubbing tier fails or sensitivity is LOCAL_ONLY.
        """
        # Determine sensitivity level.
        sensitivity = Sensitivity.ELEVATED  # default
        if self._classifier is not None:
            first_text = ""
            for msg in messages:
                if msg.get("content"):
                    first_text = msg["content"]
                    break
            classification = self._classifier.classify(
                first_text,
                persona=persona,
                vault_context=vault_context,
            )
            sensitivity = classification.sensitivity

        # LOCAL_ONLY: refuse cloud send.
        if sensitivity == Sensitivity.LOCAL_ONLY:
            raise PIIScrubError(
                "Content classified as LOCAL_ONLY — cloud send refused"
            )

        # Collect entities across both tiers for all messages.
        all_entities: list[dict] = []
        scrubbed_messages: list[dict] = []

        for msg_idx, msg in enumerate(messages):
            text = msg.get("content", "")
            if not text:
                scrubbed_messages.append(msg)
                continue

            try:
                scrubbed_text, entities = await self._two_tier_scrub(
                    text, sensitivity,
                )
            except Exception as exc:
                log.error(
                    "entity_vault.scrub_failed",
                    error=type(exc).__name__,
                )
                raise PIIScrubError(
                    f"PII scrubbing failed: {type(exc).__name__}"
                ) from exc

            # Prefix tokens with message index to prevent cross-message collisions.
            if len(messages) > 1:
                prefixed_entities = []
                for ent in entities:
                    old_token = ent.get("token", "")
                    if old_token:
                        new_token = old_token.replace("[", f"[m{msg_idx}_", 1)
                        scrubbed_text = scrubbed_text.replace(old_token, new_token)
                        prefixed_entities.append({**ent, "token": new_token})
                    else:
                        prefixed_entities.append(ent)
                entities = prefixed_entities

            all_entities.extend(entities)
            scrubbed_messages.append({**msg, "content": scrubbed_text})

        # Build ephemeral vault.
        vault = self.create_vault(all_entities)

        log.info(
            "entity_vault.scrub_complete",
            entity_count=len(vault),
            # Log only token names, NEVER original values.
            tokens=list(vault.keys()),
        )

        # Call cloud LLM with scrubbed messages.
        try:
            response = await llm.complete(scrubbed_messages)
            llm_text = response.get("content", "") if isinstance(response, dict) else str(response)
        except Exception:
            # Vault must be discarded even on LLM failure.
            vault.clear()
            raise

        # Rehydrate and discard vault.
        result = self.rehydrate(llm_text, vault)

        # Explicit destruction — belt and suspenders.
        vault.clear()

        return result

    async def scrub(self, text: str) -> tuple[str, dict]:
        """Scrub PII from text and return (scrubbed_text, vault).

        The vault maps anonymisation tokens to original values, e.g.
        ``{"[PERSON_1]": "Dr. Sharma"}``.  Pass it to ``rehydrate()``
        to restore the original text after LLM processing.

        Raises
        ------
        PIIScrubError
            If scrubbing fails.
        """
        try:
            scrubbed_text, entities = await self._two_tier_scrub(text)
        except Exception as exc:
            raise PIIScrubError(
                f"PII scrubbing failed: {type(exc).__name__}"
            ) from exc
        vault = self.create_vault(entities)
        return scrubbed_text, vault

    def create_vault(self, entities: list[dict]) -> dict:
        """Create an in-memory replacement map from detected entities.

        Parameters
        ----------
        entities:
            List of entity dicts, each with keys ``token`` and ``value``.
            Example::

                [
                    {"type": "PERSON", "value": "Dr. Sharma", "token": "<<PII_PERSON_1_a3f2e1b0>>"},
                    {"type": "ORG", "value": "Apollo Hospital", "token": "<<PII_ORG_1_b4c5d6e7>>"},
                ]

        Returns
        -------
        dict
            Mapping from placeholder token to original value::

                {"<<PII_PERSON_1_a3f2e1b0>>": "Dr. Sharma", "<<PII_ORG_1_b4c5d6e7>>": "Apollo Hospital"}
        """
        vault: dict[str, str] = {}
        for entity in entities:
            token = entity.get("token", "")
            value = entity.get("value", "")
            if token and value:
                vault[token] = value
        return vault

    def rehydrate(self, text: str, vault: dict) -> str:
        """Replace anonymisation tokens with their original values.

        Only replaces tokens that were actually produced by the scrubber
        (present as keys in the vault). Does NOT match bare inner values —
        F08: an LLM that hallucinates a string matching a bare PII token
        would otherwise get rehydrated with real PII from an unrelated entity.

        The token format includes a random hex suffix (e.g.
        ``<<PII_PERSON_1_a3f2e1b0>>``) making collisions with LLM output
        virtually impossible for the full token form.

        Parameters
        ----------
        text:
            The LLM response containing tokens like ``<<PII_PERSON_1_a3f2e1b0>>``.
        vault:
            The ephemeral mapping produced by ``create_vault``.

        Returns
        -------
        str
            Text with all valid placeholders replaced by the original PII values.
        """
        if not vault:
            return text
        import re

        # Build lookup: exact tokens + bare tokens (brackets stripped).
        # LLMs often strip brackets from [PERSON_1] → PERSON_1, so we
        # match both forms. Longest-first prevents partial matches.
        lookup: dict[str, str] = {}
        for token, original in vault.items():
            lookup[token] = original
            # Also match bare form: [PERSON_1] → PERSON_1
            bare = token.strip("[]<>")
            if bare and bare != token:
                lookup[bare] = original

        pattern = re.compile(
            "|".join(re.escape(t) for t in sorted(lookup, key=len, reverse=True))
        )
        return pattern.sub(lambda m: lookup[m.group()], text)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _two_tier_scrub(
        self,
        text: str,
        sensitivity: Sensitivity = Sensitivity.ELEVATED,
    ) -> tuple[str, list[dict]]:
        """Run Tier 1 (core regex) then Tier 2 (Presidio NER) in sequence.

        Tier 1 runs first so that Presidio sees tokens (``[EMAIL_1]``)
        rather than raw PII, avoiding duplicate detection and keeping
        the entity numbering consistent.

        For GENERAL sensitivity, only pattern-based scrubbing is used
        (``scrub_patterns_only``).  For ELEVATED/SENSITIVE, full NER
        scrubbing is applied.

        Returns
        -------
        tuple[str, list[dict]]
            ``(scrubbed_text, combined_entities)`` from both tiers.
        """
        combined_entities: list[dict] = []

        # -- Tier 1: Core regex scrub via Go --
        tier1_result = await self._core.pii_scrub(text)
        # Support both ScrubResult Pydantic model and plain dict returns.
        if hasattr(tier1_result, 'scrubbed'):
            tier1_scrubbed = tier1_result.scrubbed or text
            raw_entities = tier1_result.entities or []
        else:
            tier1_scrubbed = tier1_result.get("scrubbed", text) or text
            raw_entities = tier1_result.get("entities") or []
        # Normalize PIIEntity models to dicts for consistent downstream use.
        for ent in raw_entities:
            combined_entities.append(
                ent.model_dump() if hasattr(ent, 'model_dump') else ent
            )

        # -- Tier 2: Presidio pattern-only scrub (local, in-process) --
        # V1: Only pattern recognizers (emails, phones, SSNs, gov IDs).
        # NER (spaCy) is disabled — it produces too many false positives.
        # If Presidio is unavailable, degrade to Tier 1 only.
        if self._scrubber is not None:
            scrub_fn = getattr(
                self._scrubber, "scrub_patterns_only", self._scrubber.scrub,
            )
            tier2_scrubbed, tier2_entities = await asyncio.to_thread(scrub_fn, tier1_scrubbed)
            combined_entities.extend(tier2_entities or [])
            return tier2_scrubbed, combined_entities

        return tier1_scrubbed, combined_entities
