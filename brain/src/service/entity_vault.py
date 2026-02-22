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

        for msg in messages:
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
                    # NEVER log the original text — it contains PII
                )
                raise PIIScrubError(
                    f"PII scrubbing failed: {type(exc).__name__}"
                ) from exc

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
            response = await llm.complete(
                prompt=scrubbed_messages[-1]["content"]
                if scrubbed_messages
                else "",
            )
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

    def create_vault(self, entities: list[dict]) -> dict:
        """Create an in-memory replacement map from detected entities.

        Parameters
        ----------
        entities:
            List of entity dicts, each with keys ``token`` and ``value``.
            Example::

                [
                    {"type": "PERSON", "value": "Dr. Sharma", "token": "[PERSON_1]"},
                    {"type": "ORG", "value": "Apollo Hospital", "token": "[ORG_1]"},
                ]

        Returns
        -------
        dict
            Mapping from token string to original value::

                {"[PERSON_1]": "Dr. Sharma", "[ORG_1]": "Apollo Hospital"}
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

        Parameters
        ----------
        text:
            The LLM response containing tokens like ``[PERSON_1]``.
        vault:
            The ephemeral mapping produced by ``create_vault``.

        Returns
        -------
        str
            Text with all tokens replaced by the original PII values.
        """
        result = text
        for token, original in vault.items():
            result = result.replace(token, original)
        return result

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
        tier1_scrubbed = tier1_result.get("scrubbed", text)
        tier1_entities = tier1_result.get("entities", [])
        combined_entities.extend(tier1_entities)

        # -- Tier 2: Presidio NER scrub (local, in-process) --
        # Feed Tier 1 output to Tier 2 so Presidio sees tokens, not raw PII.
        if sensitivity == Sensitivity.GENERAL:
            # GENERAL: pattern-only (emails, phones, IDs — not names).
            scrub_fn = getattr(
                self._scrubber, "scrub_patterns_only", self._scrubber.scrub,
            )
            tier2_scrubbed, tier2_entities = scrub_fn(tier1_scrubbed)
        else:
            # ELEVATED / SENSITIVE: full NER scrubbing.
            tier2_scrubbed, tier2_entities = self._scrubber.scrub(tier1_scrubbed)
        combined_entities.extend(tier2_entities)

        return tier2_scrubbed, combined_entities
