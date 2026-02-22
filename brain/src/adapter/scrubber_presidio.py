"""Presidio-based PII scrubber — implements PIIScrubber protocol.

Uses Microsoft Presidio (AnalyzerEngine + AnonymizerEngine) wrapping
spaCy NER to detect PII entities with proper entity type control.

Key design decisions:

- **SAFE_ENTITIES** whitelist — DATE, TIME, MONEY, PERCENT, etc. are
  never scrubbed.  These are essential for LLM reasoning and do not
  identify anyone.
- **COUNTRY_NAMES** filter — country-level GPE (India, USA, UK) passes
  through; city/state-level GPE is still scrubbed.
- **Short entity filter** — entities <= 2 characters are skipped.
- **Synthetic data replacement** — when Faker is available, PII is
  replaced with realistic fake values (``Dr. Meera Patel`` instead of
  ``<PERSON_1>``).  LLMs reason measurably better with natural language
  than with tags.  Falls back to numbered tags if Faker is not installed.
- **Consistent fakes** — the same real value always maps to the same
  fake value within a single ``scrub()`` call, so the LLM sees coherent
  references across a long context.
- **India-specific recognizers** — Aadhaar, PAN, IFSC, UPI, etc.
- **EU recognizers** — German Steuer-ID, Personalausweis, French NIR/NIF,
  Dutch BSN, SWIFT/BIC.

Third-party imports: presidio_analyzer, presidio_anonymizer, spacy (lazy),
faker (optional).
"""

from __future__ import annotations

import os
import re
from typing import Any

import structlog

from ..domain.errors import PIIScrubError

logger = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# Entity types that should NEVER be scrubbed — they don't identify anyone
# and are essential for LLM reasoning.
# ---------------------------------------------------------------------------

SAFE_ENTITIES: frozenset[str] = frozenset({
    # Presidio entity names
    "DATE_TIME",
    "NRP",          # nationalities, religious, political groups
    # spaCy entity labels (may pass through Presidio)
    "DATE",
    "TIME",
    "MONEY",
    "PERCENT",
    "QUANTITY",
    "ORDINAL",
    "CARDINAL",
    "NORP",
    "EVENT",
    "WORK_OF_ART",
    "LAW",
    "PRODUCT",
    "LANGUAGE",
})

# ---------------------------------------------------------------------------
# Country names — country-level GPE is not PII.
# ---------------------------------------------------------------------------

COUNTRY_NAMES: frozenset[str] = frozenset({
    "India", "USA", "US", "United States", "UK", "United Kingdom",
    "China", "Japan", "Germany", "France", "Canada", "Australia",
    "Brazil", "Russia", "Italy", "Spain", "Mexico", "South Korea",
    "Indonesia", "Netherlands", "Saudi Arabia", "Turkey", "Switzerland",
    "Sweden", "Norway", "Denmark", "Finland", "Ireland", "Singapore",
    "New Zealand", "Israel", "Thailand", "Malaysia", "Philippines",
    "Vietnam", "Pakistan", "Bangladesh", "Sri Lanka", "Nepal",
    "South Africa", "Nigeria", "Egypt", "Kenya", "Argentina",
    "Colombia", "Chile", "Peru", "Poland", "Belgium", "Austria",
    "Portugal", "Greece", "Czech Republic", "Romania", "Hungary",
    "Ukraine", "UAE", "United Arab Emirates", "Qatar", "Kuwait",
    "Oman", "Bahrain", "Jordan", "Lebanon", "Iraq", "Iran",
})

# Presidio entity type -> Dina token prefix
_LABEL_MAP: dict[str, str] = {
    "PERSON": "PERSON",
    "ORGANIZATION": "ORG",
    "LOCATION": "LOC",
    "GPE": "LOC",
    "ORG": "ORG",
    "LOC": "LOC",
    "FAC": "LOC",
    "EMAIL_ADDRESS": "EMAIL",
    "PHONE_NUMBER": "PHONE",
    "CREDIT_CARD": "CREDIT_CARD",
    "CRYPTO": "CRYPTO",
    "IP_ADDRESS": "IP",
    "MEDICAL_LICENSE": "MEDICAL",
    "URL": "URL",
    "US_SSN": "SSN",
    "AADHAAR_NUMBER": "AADHAAR_NUMBER",
    "IN_PAN": "IN_PAN",
    "IN_PHONE_NUMBER": "IN_PHONE",
    "IN_IFSC": "IN_IFSC",
    "IN_UPI_ID": "IN_UPI_ID",
    "IN_PASSPORT": "IN_PASSPORT",
    "IN_BANK_ACCOUNT": "IN_BANK_ACCOUNT",
    # EU recognizers
    "DE_STEUER_ID": "DE_STEUER_ID",
    "DE_PERSONALAUSWEIS": "DE_PERSONALAUSWEIS",
    "FR_NIR": "FR_NIR",
    "FR_NIF": "FR_NIF",
    "NL_BSN": "NL_BSN",
    "SWIFT_BIC": "SWIFT_BIC",
}

# URL regex — used to exclude entities detected inside URLs
_URL_RE = re.compile(
    r"https?://[^\s<>\"']+|www\.[^\s<>\"']+|[\w.-]+\.\w{2,}(?:/[^\s]*)?",
    re.IGNORECASE,
)


# ---------------------------------------------------------------------------
# Faker generator mapping: entity_type -> (faker, counter) -> fake string.
# Each generator receives a Faker instance and a 1-based counter (used as
# seed offset so repeated calls produce different values).
# ---------------------------------------------------------------------------


def _faker_person(faker: Any, n: int) -> str:
    faker.seed_instance(hash(("PERSON", n)) % (2**32))
    return faker.name()


def _faker_org(faker: Any, n: int) -> str:
    faker.seed_instance(hash(("ORG", n)) % (2**32))
    return faker.company()


def _faker_loc(faker: Any, n: int) -> str:
    faker.seed_instance(hash(("LOC", n)) % (2**32))
    return faker.city()


def _faker_email(faker: Any, n: int) -> str:
    faker.seed_instance(hash(("EMAIL", n)) % (2**32))
    return faker.email()


def _faker_phone(faker: Any, n: int) -> str:
    faker.seed_instance(hash(("PHONE", n)) % (2**32))
    return faker.phone_number()


def _faker_credit_card(faker: Any, n: int) -> str:
    faker.seed_instance(hash(("CREDIT_CARD", n)) % (2**32))
    return faker.credit_card_number()


def _faker_ssn(faker: Any, n: int) -> str:
    faker.seed_instance(hash(("SSN", n)) % (2**32))
    return faker.ssn()


def _faker_ip(faker: Any, n: int) -> str:
    faker.seed_instance(hash(("IP", n)) % (2**32))
    return faker.ipv4()


def _faker_url(faker: Any, n: int) -> str:
    faker.seed_instance(hash(("URL", n)) % (2**32))
    return faker.url()


def _faker_fallback(faker: Any, n: int) -> str:
    """Fallback: alphanumeric string for unknown entity types."""
    faker.seed_instance(hash(("UNKNOWN", n)) % (2**32))
    return faker.bothify("???-####-???")


_FAKER_GENERATORS: dict[str, Any] = {
    "PERSON": _faker_person,
    "ORG": _faker_org,
    "LOC": _faker_loc,
    "EMAIL": _faker_email,
    "PHONE": _faker_phone,
    "IN_PHONE": _faker_phone,
    "CREDIT_CARD": _faker_credit_card,
    "SSN": _faker_ssn,
    "IP": _faker_ip,
    "URL": _faker_url,
}


class PresidioScrubber:
    """Implements PIIScrubber via Microsoft Presidio.

    Detects: PERSON, ORG, LOCATION, EMAIL, PHONE, CREDIT_CARD + India
    recognizers (Aadhaar, PAN, IFSC, UPI, etc.) + EU recognizers.

    When Faker is installed, replaces PII with realistic synthetic data
    (``Dr. Meera Patel`` instead of ``<PERSON_1>``).  LLMs reason better
    with natural language than with tags.  Falls back to numbered tags
    if Faker is not available.

    SAFE_ENTITIES (DATE, TIME, MONEY, PERCENT, NORP, etc.) are never
    scrubbed — they are essential for LLM reasoning.
    """

    def __init__(
        self,
        model: str | None = None,
        use_faker: bool = True,
        faker_locale: str | None = None,
    ) -> None:
        self._model_name = model or os.environ.get(
            "DINA_SPACY_MODEL", "en_core_web_sm"
        )
        self._analyzer: Any = None
        self._loaded = False
        self._unavailable = False
        self._use_faker = use_faker
        self._faker: Any = None
        self._faker_locale = faker_locale or os.environ.get(
            "DINA_FAKER_LOCALE", "en_US",
        )

    # -- Faker integration --------------------------------------------------

    def _ensure_faker(self) -> Any | None:
        """Lazy-load Faker.  Returns None if unavailable."""
        if self._faker is not None:
            return self._faker
        if not self._use_faker:
            return None
        try:
            from faker import Faker as FakerClass
            self._faker = FakerClass(self._faker_locale)
            return self._faker
        except ImportError:
            self._use_faker = False
            return None

    def _generate_fake(
        self,
        entity_type: str,
        real_value: str,
        seen: dict[str, str],
        counter: dict[str, int],
    ) -> str:
        """Generate a fake replacement for *real_value*.

        Uses Faker when available, falls back to ``<TYPE_N>`` tags.

        Parameters:
            entity_type: Mapped entity type (PERSON, ORG, LOC, etc.).
            real_value:  The original PII string.
            seen:        Per-call cache mapping real_value -> fake_value
                         so the same real entity always gets the same fake.
            counter:     Per-type counter for tag fallback numbering.

        Returns:
            The fake replacement string.
        """
        # Consistent within a single scrub() call.
        if real_value in seen:
            return seen[real_value]

        count = counter.get(entity_type, 0) + 1
        counter[entity_type] = count

        faker = self._ensure_faker()
        if faker is not None:
            fake = _FAKER_GENERATORS.get(entity_type, _faker_fallback)(
                faker, count,
            )
        else:
            fake = f"<{entity_type}_{count}>"

        seen[real_value] = fake
        return fake

    # -- Lazy loading -------------------------------------------------------

    def _ensure_analyzer(self) -> Any:
        """Load Presidio AnalyzerEngine on first use."""
        if self._unavailable:
            raise PIIScrubError(
                "Presidio is not available. "
                "Run: pip install presidio-analyzer presidio-anonymizer"
            )

        if self._analyzer is not None:
            return self._analyzer

        try:
            from presidio_analyzer import AnalyzerEngine
            from presidio_analyzer.nlp_engine import (
                NlpEngineProvider,
            )
        except ImportError as exc:
            self._unavailable = True
            raise PIIScrubError(
                "presidio-analyzer not installed. "
                "Run: pip install presidio-analyzer presidio-anonymizer"
            ) from exc

        try:
            provider = NlpEngineProvider(
                nlp_configuration={
                    "nlp_engine_name": "spacy",
                    "models": [
                        {"lang_code": "en", "model_name": self._model_name},
                    ],
                }
            )
            nlp_engine = provider.create_engine()
            self._analyzer = AnalyzerEngine(nlp_engine=nlp_engine)
        except Exception as exc:
            self._unavailable = True
            raise PIIScrubError(
                f"Failed to initialize Presidio with spaCy model "
                f"'{self._model_name}': {exc}"
            ) from exc

        # Register India-specific recognizers.
        try:
            from .recognizers_india import register_indian_recognizers
            register_indian_recognizers(self._analyzer.registry)
        except Exception as exc:
            logger.warning(
                "india_recognizers_setup_failed", error=str(exc),
            )

        # Register EU-specific recognizers (Germany, France, Netherlands, SWIFT).
        try:
            from .recognizers_eu import register_eu_recognizers
            register_eu_recognizers(self._analyzer.registry)
        except Exception as exc:
            logger.warning(
                "eu_recognizers_setup_failed", error=str(exc),
            )

        self._loaded = True
        logger.info(
            "presidio_analyzer_loaded",
            model=self._model_name,
        )
        return self._analyzer

    # -- URL span detection -------------------------------------------------

    @staticmethod
    def _url_spans(text: str) -> list[tuple[int, int]]:
        """Return character-offset spans for all URLs in text."""
        return [(m.start(), m.end()) for m in _URL_RE.finditer(text)]

    @staticmethod
    def _overlaps_url(
        start: int, end: int, url_spans: list[tuple[int, int]],
    ) -> bool:
        """Check if a character range overlaps any URL span."""
        for u_start, u_end in url_spans:
            if start < u_end and end > u_start:
                return True
        return False

    # -- PIIScrubber protocol -----------------------------------------------

    def scrub(self, text: str, language: str = "en") -> tuple[str, list[dict]]:
        """Detect and replace PII entities with sequential tokens.

        SAFE_ENTITIES (DATE, TIME, MONEY, PERCENT, etc.) pass through
        unchanged.

        Returns:
            ``(scrubbed_text, entities)`` where *entities* is a list of
            dicts with keys ``type``, ``value``, ``token``.
        """
        analyzer = self._ensure_analyzer()

        try:
            results = analyzer.analyze(
                text=text,
                language=language,
            )
        except Exception as exc:
            logger.warning("presidio_analysis_error", error=str(exc))
            raise PIIScrubError(f"Presidio analysis failed: {exc}") from exc

        url_spans = self._url_spans(text)

        # Filter and collect entities.
        raw_entities: list[dict[str, Any]] = []
        for result in results:
            entity_type = result.entity_type

            # Skip SAFE entities.
            if entity_type in SAFE_ENTITIES:
                continue

            start, end = result.start, result.end
            value = text[start:end]

            # Skip entities embedded in URLs.
            if self._overlaps_url(start, end, url_spans):
                continue

            # Skip very short entities (<= 2 chars).
            if len(value.strip()) <= 2:
                continue

            # Skip country-level GPE.
            if entity_type in ("LOCATION", "GPE") and value.strip() in COUNTRY_NAMES:
                continue

            mapped = _LABEL_MAP.get(entity_type, entity_type)
            raw_entities.append({
                "type": mapped,
                "value": value,
                "start": start,
                "end": end,
            })

        if not raw_entities:
            return text, []

        # Deduplicate overlapping entities — keep highest-scoring / longest.
        raw_entities.sort(key=lambda e: e["start"])
        deduped: list[dict[str, Any]] = []
        for ent in raw_entities:
            if deduped and ent["start"] < deduped[-1]["end"]:
                # Overlapping — keep the longer one.
                if (ent["end"] - ent["start"]) > (
                    deduped[-1]["end"] - deduped[-1]["start"]
                ):
                    deduped[-1] = ent
            else:
                deduped.append(ent)
        raw_entities = deduped

        # Generate replacements (Faker or tags) per entity.
        type_counters: dict[str, int] = {}
        seen: dict[str, str] = {}  # real_value -> fake (consistency)
        entities: list[dict[str, str]] = []

        for ent in raw_entities:
            ent_type = ent["type"]
            token = self._generate_fake(
                ent_type, ent["value"], seen, type_counters,
            )

            entities.append({
                "type": ent_type,
                "value": ent["value"],
                "token": token,
            })
            ent["token"] = token

        # Replace entities right-to-left to preserve offsets.
        scrubbed = text
        for ent in reversed(raw_entities):
            scrubbed = (
                scrubbed[: ent["start"]]
                + ent["token"]
                + scrubbed[ent["end"]:]
            )

        return scrubbed, entities

    def scrub_patterns_only(
        self, text: str, language: str = "en",
    ) -> tuple[str, list[dict]]:
        """Tier 1 only — regex patterns, no NER.

        Detects emails, phones, credit cards, SSNs, and India-specific
        IDs but NOT person names, orgs, or locations.
        """
        analyzer = self._ensure_analyzer()

        # Only use pattern-based recognizers (no NER entities).
        ner_entities = {
            "PERSON", "ORGANIZATION", "LOCATION", "GPE", "ORG", "LOC",
            "FAC", "NRP", "NORP",
        }

        try:
            results = analyzer.analyze(
                text=text,
                language=language,
            )
        except Exception as exc:
            raise PIIScrubError(f"Presidio analysis failed: {exc}") from exc

        url_spans = self._url_spans(text)

        raw_entities: list[dict[str, Any]] = []
        for result in results:
            entity_type = result.entity_type

            # Skip NER-detected entities and SAFE entities.
            if entity_type in ner_entities or entity_type in SAFE_ENTITIES:
                continue

            start, end = result.start, result.end
            value = text[start:end]

            if self._overlaps_url(start, end, url_spans):
                continue

            if len(value.strip()) <= 2:
                continue

            mapped = _LABEL_MAP.get(entity_type, entity_type)
            raw_entities.append({
                "type": mapped,
                "value": value,
                "start": start,
                "end": end,
            })

        if not raw_entities:
            return text, []

        raw_entities.sort(key=lambda e: e["start"])

        type_counters: dict[str, int] = {}
        seen: dict[str, str] = {}
        entities: list[dict[str, str]] = []

        for ent in raw_entities:
            ent_type = ent["type"]
            token = self._generate_fake(
                ent_type, ent["value"], seen, type_counters,
            )

            entities.append({
                "type": ent_type,
                "value": ent["value"],
                "token": token,
            })
            ent["token"] = token

        scrubbed = text
        for ent in reversed(raw_entities):
            scrubbed = (
                scrubbed[: ent["start"]]
                + ent["token"]
                + scrubbed[ent["end"]:]
            )

        return scrubbed, entities

    def detect(self, text: str, language: str = "en") -> list[dict]:
        """Detect PII entities without replacing them.

        Returns a list of dicts with keys ``type`` and ``value``.
        """
        analyzer = self._ensure_analyzer()

        try:
            results = analyzer.analyze(text=text, language=language)
        except Exception as exc:
            raise PIIScrubError(f"Presidio analysis failed: {exc}") from exc

        url_spans = self._url_spans(text)
        detected: list[dict[str, str]] = []

        for result in results:
            entity_type = result.entity_type

            if entity_type in SAFE_ENTITIES:
                continue

            start, end = result.start, result.end
            value = text[start:end]

            if self._overlaps_url(start, end, url_spans):
                continue

            if len(value.strip()) <= 2:
                continue

            if entity_type in ("LOCATION", "GPE") and value.strip() in COUNTRY_NAMES:
                continue

            mapped = _LABEL_MAP.get(entity_type, entity_type)
            detected.append({"type": mapped, "value": value})

        return detected

    def rehydrate(self, text: str, entity_map: list[dict]) -> str:
        """Replace tokens in *text* with original values from entity_map.

        Handles hallucinated tags gracefully — tokens not in the map are
        left as-is.

        Parameters:
            text:       LLM response containing tokens like ``<PERSON_1>``.
            entity_map: List of entity dicts with ``token`` and ``value`` keys.

        Returns:
            Text with tokens replaced by originals.
        """
        result = text
        for entity in entity_map:
            token = entity.get("token", "")
            value = entity.get("value", "")
            if token and value:
                result = result.replace(token, value)
        return result
