"""Port interface for PII scrubbing (Tier 2 spaCy NER).

Matches Brain TEST_PLAN SS3 (PII Scrubber) and the contract in
``brain/tests/contracts.py::PIIScrubber``.

Implementations live in ``src/adapter/``.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable


@runtime_checkable
class PIIScrubber(Protocol):
    """Synchronous PII detection and scrubbing interface.

    Tier 2 scrubbing uses spaCy Named Entity Recognition to detect
    entities that regex-based Tier 1 (Go core) cannot catch: person
    names, organisations, locations, dates, and custom medical terms.

    All methods are synchronous because spaCy inference is CPU-bound
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
            # scrubbed == "[PERSON_1] at [ORG_1]"
            # ents == [
            #     {"type": "PERSON", "value": "Dr. Sharma", "token": "[PERSON_1]"},
            #     {"type": "ORG", "value": "Apollo Hospital", "token": "[ORG_1]"},
            # ]
        """
        ...

    def detect(self, text: str) -> list[dict]:
        """Detect PII entities without modifying the text.

        Returns a list of dicts with keys ``type`` and ``value``.
        """
        ...
