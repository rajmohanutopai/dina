"""EU-specific PII recognizers for Microsoft Presidio.

Registers pattern-based recognizers for German, French, and Dutch
identity documents, plus SWIFT/BIC codes, that the default Presidio
engine does not cover.

Coverage:
    - Germany: Steuer-ID (tax ID), Personalausweisnummer (national ID)
    - France:  NIR (social security / INSEE), NIF (tax ID)
    - Netherlands: BSN (citizen service number)
    - Global:  SWIFT/BIC code

Each recognizer is a ``PatternRecognizer`` with regex patterns and
context words that boost confidence when found nearby.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from presidio_analyzer import RecognizerRegistry


def register_eu_recognizers(registry: RecognizerRegistry) -> None:
    """Register all EU-specific recognizers on *registry*."""
    from presidio_analyzer import Pattern, PatternRecognizer

    # ------------------------------------------------------------------
    # Germany
    # ------------------------------------------------------------------

    # Steuer-ID (Steueridentifikationsnummer) — 11 digits, first non-zero.
    # Full validation (ISO 7064 MOD 11,10 checksum + digit frequency)
    # requires a custom EntityRecognizer; regex + context is Phase 1.
    registry.add_recognizer(
        PatternRecognizer(
            supported_entity="DE_STEUER_ID",
            name="German Steuer-ID Recognizer",
            patterns=[
                Pattern(
                    name="de_steuer_id",
                    regex=r"\b[1-9]\d{10}\b",
                    score=0.3,
                ),
            ],
            context=[
                "steuer-id", "steuerid", "steueridentifikationsnummer",
                "identifikationsnummer", "idnr", "steuernummer",
                "finanzamt", "tin", "tax id", "tax identification",
                "german tax",
            ],
            supported_language="en",
        )
    )

    # Personalausweisnummer (national ID card, post-2010 format).
    # Uses restricted character set: digits + C,F,G,H,J,K,L,M,N,P,R,T,V,W,X,Y,Z.
    registry.add_recognizer(
        PatternRecognizer(
            supported_entity="DE_PERSONALAUSWEIS",
            name="German National ID Card Recognizer",
            patterns=[
                Pattern(
                    name="de_id_post2010",
                    regex=r"\b[CFGHJKLMNPRTVWXYZ][CFGHJKLMNPRTVWXYZ0-9]{8,9}\b",
                    score=0.3,
                ),
            ],
            context=[
                "ausweis", "personalausweis", "identifikation",
                "id-nummer", "identity card", "german id",
                "identification number", "personal id",
            ],
            supported_language="en",
        )
    )

    # ------------------------------------------------------------------
    # France
    # ------------------------------------------------------------------

    # NIR (Numero de Securite Sociale / INSEE number).
    # 15 digits: gender(1) + birth year(2) + birth month(2) + department(2)
    # + commune(3) + order(3) + control key(2).
    # Gender digit is 1 (male) or 2 (female).
    registry.add_recognizer(
        PatternRecognizer(
            supported_entity="FR_NIR",
            name="French Social Security Number Recognizer",
            patterns=[
                Pattern(
                    name="fr_nir_compact",
                    regex=r"\b[12]\d{2}(?:0[1-9]|1[0-2])\d{2}\d{3}\d{3}\d{2}\b",
                    score=0.5,
                ),
                Pattern(
                    name="fr_nir_spaced",
                    regex=r"\b[12]\s?\d{2}\s?(?:0[1-9]|1[0-2])\s?\d{2}\s?\d{3}\s?\d{3}\s?\d{2}\b",
                    score=0.4,
                ),
            ],
            context=[
                "securite sociale", "numero de securite sociale",
                "nir", "nss", "carte vitale", "assurance maladie",
                "insee", "immatriculation", "social security",
                "french social security",
            ],
            supported_language="en",
        )
    )

    # NIF (Numero Fiscal / SPI) — 13 digits, first digit 0-3.
    registry.add_recognizer(
        PatternRecognizer(
            supported_entity="FR_NIF",
            name="French Tax ID Recognizer",
            patterns=[
                Pattern(
                    name="fr_nif_compact",
                    regex=r"\b[0-3]\d{12}\b",
                    score=0.3,
                ),
                Pattern(
                    name="fr_nif_spaced",
                    regex=r"\b[0-3]\d\s?\d{2}\s?\d{3}\s?\d{3}\s?\d{3}\b",
                    score=0.25,
                ),
            ],
            context=[
                "numero fiscal", "nif", "spi", "impots", "impot",
                "fiscal", "tresor public", "avis d'imposition",
                "numero fiscal de reference", "french tax id",
                "tax identification", "tax id",
            ],
            supported_language="en",
        )
    )

    # ------------------------------------------------------------------
    # Netherlands
    # ------------------------------------------------------------------

    # BSN (Burgerservicenummer) — 9 digits, elfproef (11-proof) checksum.
    # Pure regex is very generic (9 digits), so base score is low.
    # Full elfproef validation requires a custom EntityRecognizer.
    registry.add_recognizer(
        PatternRecognizer(
            supported_entity="NL_BSN",
            name="Dutch BSN Recognizer",
            patterns=[
                Pattern(
                    name="nl_bsn",
                    regex=r"\b\d{9}\b",
                    score=0.15,
                ),
            ],
            context=[
                "burgerservicenummer", "bsn", "sofinummer",
                "sofi-nummer", "persoonsnummer", "belastingdienst",
                "burger service nummer", "citizen service number",
                "dutch citizen number", "personal number",
            ],
            supported_language="en",
        )
    )

    # ------------------------------------------------------------------
    # Global financial
    # ------------------------------------------------------------------

    # SWIFT/BIC code — 8 or 11 alphanumeric characters per ISO 9362.
    # Format: 4-letter bank + 2-letter country + 2 location + optional 3 branch.
    # Uses low base score (0.1) because pure-alpha 8-letter words match
    # too easily (e.g. "American").  Context words are essential.
    registry.add_recognizer(
        PatternRecognizer(
            supported_entity="SWIFT_BIC",
            name="SWIFT/BIC Code Recognizer",
            patterns=[
                # 11-char variant (with branch code) — more specific.
                Pattern(
                    name="swift_bic_11",
                    regex=r"\b[A-Z]{6}[A-Z0-9]{2}[A-Z0-9]{3}\b",
                    score=0.4,
                ),
                # 8-char variant — require at least one digit in the
                # location code (positions 7-8) to avoid matching common
                # English words like "American", "European", etc.
                Pattern(
                    name="swift_bic_8_with_digit",
                    regex=r"\b[A-Z]{6}(?:[A-Z][0-9]|[0-9][A-Z]|[0-9]{2})\b",
                    score=0.3,
                ),
            ],
            context=[
                "swift", "bic", "swift code", "bic code",
                "bank identifier", "wire transfer",
                "international transfer", "correspondent bank",
                "intermediary bank",
            ],
            supported_language="en",
        )
    )
