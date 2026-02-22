"""Port interface for PII scrubbing (Presidio-backed NER).

Matches Brain TEST_PLAN SS3 (PII Scrubber) and the contract in
``brain/tests/contracts.py::PIIScrubber``.

Implementations live in ``src/adapter/`` — ``scrubber_presidio.py``
(primary) and ``scrubber_spacy.py`` (legacy).
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable


@runtime_checkable
class PIIScrubber(Protocol):
    """Synchronous PII detection and scrubbing interface.

    Presidio wraps spaCy NER and adds structured PII detection,
    configurable entity filtering, and India-specific recognizers.

    SAFE entities (DATE, TIME, MONEY, PERCENT, NORP, etc.) are
    never scrubbed — they are essential for LLM reasoning and do
    not identify anyone.

    All methods are synchronous because NER inference is CPU-bound
    and already fast enough for single-request latency targets (100
    chunks < 5 s).
    """

    def scrub(self, text: str) -> tuple[str, list[dict]]:
        """Detect and replace PII entities with sequential tokens.

        Returns:
            A tuple of ``(scrubbed_text, entities)`` where *entities*
            is a list of dicts with keys ``type``, ``value``, ``token``.

        Example::

            scrubbed, ents = scrubber.scrub("Dr. Sharma at Apollo Hospital")
            # scrubbed == "<PERSON_1> at <ORG_1>"
            # ents == [
            #     {"type": "PERSON", "value": "Dr. Sharma", "token": "<PERSON_1>"},
            #     {"type": "ORG", "value": "Apollo Hospital", "token": "<ORG_1>"},
            # ]
        """
        ...

    def detect(self, text: str) -> list[dict]:
        """Detect PII entities without modifying the text.

        Returns a list of dicts with keys ``type`` and ``value``.
        """
        ...

    def rehydrate(self, text: str, entity_map: list[dict]) -> str:
        """Replace tokens in *text* with original values from entity_map.

        Parameters:
            text:       LLM response containing tokens like ``<PERSON_1>``.
            entity_map: List of entity dicts with ``token`` and ``value``.

        Returns:
            Text with tokens replaced by originals.  Tokens not found
            in entity_map are left as-is (handles hallucinated tags).
        """
        ...
