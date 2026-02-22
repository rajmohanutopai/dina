"""spaCy NER-based PII scrubber (Tier 2) — implements PIIScrubber protocol.

Uses spaCy's Named Entity Recognition pipeline (``en_core_web_sm``)
to detect person names, organisations, locations, dates, and
nationalities/religious/political groups.  Custom pattern rules add
coverage for medical terms that the base NER model does not catch.

Tier 2 runs **after** Tier 1 (Go regex via core) in the combined
pipeline.  It never sends data to a cloud LLM — all detection is
local and deterministic.

Third-party imports:  spacy (lazy), structlog.
"""

from __future__ import annotations

import re
from typing import Any

import structlog

from ..domain.errors import PIIScrubError

logger = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# Entity label mapping: spaCy label -> Dina token prefix
# ---------------------------------------------------------------------------

_LABEL_MAP: dict[str, str] = {
    "PERSON": "PERSON",
    "ORG": "ORG",
    "GPE": "LOC",       # geopolitical entity -> LOC
    "LOC": "LOC",       # geographic locations
    "FAC": "LOC",       # facilities (buildings, airports)
    "DATE": "DATE",
    "NORP": "GROUP",    # nationalities, religious, political groups
}

# ---------------------------------------------------------------------------
# Custom medical patterns (Tier 2 extension)
# ---------------------------------------------------------------------------

_MEDICAL_PATTERNS: list[dict[str, Any]] = [
    # Spinal disc conditions: L4-L5, C5-C6, etc.
    {"label": "MEDICAL", "pattern": [
        {"TEXT": {"REGEX": r"^[TCLS]\d$"}},
        {"TEXT": "-"},
        {"TEXT": {"REGEX": r"^[TCLS]\d$"}},
    ]},
    # "disc herniation", "disc bulge", etc.
    {"label": "MEDICAL", "pattern": [
        {"LOWER": "disc"},
        {"LOWER": {"IN": ["herniation", "bulge", "protrusion", "prolapse", "degeneration"]}},
    ]},
    # Combined spinal + condition: "L4-L5 disc herniation"
    {"label": "MEDICAL", "pattern": [
        {"TEXT": {"REGEX": r"^[TCLS]\d$"}},
        {"TEXT": "-"},
        {"TEXT": {"REGEX": r"^[TCLS]\d$"}},
        {"LOWER": "disc"},
        {"LOWER": {"IN": ["herniation", "bulge", "protrusion", "prolapse", "degeneration"]}},
    ]},
]

# URL regex — used to exclude entities detected inside URLs
_URL_RE = re.compile(
    r"https?://[^\s<>\"']+|www\.[^\s<>\"']+|[\w.-]+\.\w{2,}(?:/[^\s]*)?",
    re.IGNORECASE,
)


class SpacyScrubber:
    """Implements PIIScrubber via spaCy NER (Tier 2 scrubbing).

    Detects: PERSON, ORG, GPE/LOC, DATE, NORP + custom rules for MEDICAL.
    Replaces with sequential tokens: [PERSON_1], [ORG_1], [LOC_1], etc.

    Key behaviours:
    - Multiple entities of the same type get sequential numbers.
    - Text with no entities passes through unchanged.
    - URLs are preserved (entities within URLs are not mangled).
    - Non-English text handled best-effort (no crash).
    - 100 chunks < 5 seconds performance target.

    Gracefully degrades if spaCy or the model is not installed.
    """

    def __init__(self, model: str = "en_core_web_sm") -> None:
        self._model_name = model
        self._nlp: Any = None  # lazy-loaded spaCy Language object
        self._loaded = False
        self._unavailable = False

    # -- Lazy model loading --------------------------------------------------

    def _ensure_nlp(self) -> Any:
        """Load the spaCy model on first use.

        Raises PIIScrubError if spacy or the model is not installed.
        """
        if self._unavailable:
            raise PIIScrubError(
                f"spaCy model '{self._model_name}' is not available. "
                f"Run: python -m spacy download {self._model_name}"
            )

        if self._nlp is not None:
            return self._nlp

        try:
            import spacy  # type: ignore[import-untyped]
        except ImportError as exc:
            self._unavailable = True
            raise PIIScrubError(
                "spacy package not installed. "
                "Run: pip install spacy"
            ) from exc

        try:
            self._nlp = spacy.load(self._model_name)
        except OSError as exc:
            self._unavailable = True
            raise PIIScrubError(
                f"spaCy model '{self._model_name}' not found. "
                f"Run: python -m spacy download {self._model_name}"
            ) from exc

        # Add custom medical entity patterns via EntityRuler
        try:
            if "entity_ruler" not in self._nlp.pipe_names:
                ruler = self._nlp.add_pipe(
                    "entity_ruler",
                    before="ner",
                    config={"overwrite_ents": False},
                )
                ruler.add_patterns(_MEDICAL_PATTERNS)
        except Exception as exc:
            # Non-fatal — medical detection will be best-effort
            logger.warning(
                "spacy_ruler_setup_failed",
                error=str(exc),
            )

        self._loaded = True
        logger.info(
            "spacy_model_loaded",
            model=self._model_name,
            pipes=self._nlp.pipe_names,
        )
        return self._nlp

    # -- URL span detection --------------------------------------------------

    @staticmethod
    def _url_spans(text: str) -> list[tuple[int, int]]:
        """Return character-offset spans for all URLs in text."""
        return [(m.start(), m.end()) for m in _URL_RE.finditer(text)]

    @staticmethod
    def _overlaps_url(
        start: int, end: int, url_spans: list[tuple[int, int]]
    ) -> bool:
        """Check if a character range overlaps any URL span."""
        for u_start, u_end in url_spans:
            if start < u_end and end > u_start:
                return True
        return False

    # -- PIIScrubber protocol ------------------------------------------------

    def scrub(self, text: str) -> tuple[str, list[dict]]:
        """Run NER, replace entities with sequential tokens.

        Returns:
            ``(scrubbed_text, entities)`` where *entities* is a list of
            dicts with keys ``type``, ``value``, ``token``.

        Raises:
            PIIScrubError: If spaCy model cannot be loaded.
        """
        nlp = self._ensure_nlp()

        try:
            doc = nlp(text)
        except Exception as exc:
            logger.warning("spacy_processing_error", error=str(exc))
            raise PIIScrubError(f"spaCy processing failed: {exc}") from exc

        url_spans = self._url_spans(text)

        # Collect entities with their positions, filtering out URL-embedded ones
        raw_entities: list[dict[str, Any]] = []
        for ent in doc.ents:
            label = ent.label_
            mapped = _LABEL_MAP.get(label, label)

            # Skip entities embedded in URLs
            if self._overlaps_url(ent.start_char, ent.end_char, url_spans):
                continue

            raw_entities.append({
                "type": mapped,
                "value": ent.text,
                "start": ent.start_char,
                "end": ent.end_char,
            })

        if not raw_entities:
            return text, []

        # Assign sequential tokens per entity type
        type_counters: dict[str, int] = {}
        entities: list[dict[str, str]] = []

        # Sort by position (start offset) to ensure deterministic ordering
        raw_entities.sort(key=lambda e: e["start"])

        for ent in raw_entities:
            ent_type = ent["type"]
            count = type_counters.get(ent_type, 0) + 1
            type_counters[ent_type] = count
            token = f"[{ent_type}_{count}]"

            entities.append({
                "type": ent_type,
                "value": ent["value"],
                "token": token,
            })
            ent["token"] = token

        # Replace entities in reverse order (right to left) to preserve offsets
        scrubbed = text
        for ent in reversed(raw_entities):
            scrubbed = (
                scrubbed[: ent["start"]]
                + ent["token"]
                + scrubbed[ent["end"]:]
            )

        return scrubbed, entities

    def detect(self, text: str) -> list[dict]:
        """Detect PII entities without replacing them.

        Returns a list of dicts with keys ``type`` and ``value``.

        Raises:
            PIIScrubError: If spaCy model cannot be loaded.
        """
        nlp = self._ensure_nlp()

        try:
            doc = nlp(text)
        except Exception as exc:
            logger.warning("spacy_detect_error", error=str(exc))
            raise PIIScrubError(f"spaCy processing failed: {exc}") from exc

        url_spans = self._url_spans(text)

        results: list[dict[str, str]] = []
        for ent in doc.ents:
            label = ent.label_
            mapped = _LABEL_MAP.get(label, label)

            if self._overlaps_url(ent.start_char, ent.end_char, url_spans):
                continue

            results.append({
                "type": mapped,
                "value": ent.text,
            })

        return results
