"""India-specific PII recognizers for Microsoft Presidio.

Registers pattern-based recognizers for Indian identity documents,
phone numbers, and financial identifiers that the default Presidio
engine does not cover.

Each recognizer is a ``PatternRecognizer`` with regex patterns and
optional context words that boost confidence when found nearby.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from presidio_analyzer import RecognizerRegistry


def register_indian_recognizers(registry: RecognizerRegistry) -> None:
    """Register all India-specific recognizers on *registry*."""
    from presidio_analyzer import Pattern, PatternRecognizer

    # -- Aadhaar Number (12 digits, first digit never 0 or 1) ---------------
    registry.add_recognizer(
        PatternRecognizer(
            supported_entity="AADHAAR_NUMBER",
            name="Indian Aadhaar Recognizer",
            patterns=[
                Pattern(
                    name="aadhaar_spaced",
                    regex=r"\b[2-9]\d{3}\s?\d{4}\s?\d{4}\b",
                    score=0.7,
                ),
            ],
            context=["aadhaar", "uid", "uidai", "unique identification"],
            supported_language="en",
        )
    )

    # -- PAN (Permanent Account Number): 5 letters + 4 digits + 1 letter ----
    registry.add_recognizer(
        PatternRecognizer(
            supported_entity="IN_PAN",
            name="Indian PAN Recognizer",
            patterns=[
                Pattern(
                    name="pan",
                    regex=r"\b[A-Z]{5}[0-9]{4}[A-Z]\b",
                    score=0.7,
                ),
            ],
            context=["pan", "permanent account", "income tax", "pan card"],
            supported_language="en",
        )
    )

    # -- Indian Phone Number: +91 prefix, 10 digits starting 6-9 -----------
    registry.add_recognizer(
        PatternRecognizer(
            supported_entity="IN_PHONE_NUMBER",
            name="Indian Phone Number Recognizer",
            patterns=[
                Pattern(
                    name="in_phone_plus91",
                    regex=r"\+91[\s-]?[6-9]\d{9}\b",
                    score=0.7,
                ),
                Pattern(
                    name="in_phone_091",
                    regex=r"\b0?91[\s-]?[6-9]\d{9}\b",
                    score=0.6,
                ),
            ],
            context=["phone", "mobile", "contact", "call", "whatsapp"],
            supported_language="en",
        )
    )

    # -- IFSC Code: 4 letters + 0 + 6 alphanumeric -------------------------
    registry.add_recognizer(
        PatternRecognizer(
            supported_entity="IN_IFSC",
            name="Indian IFSC Recognizer",
            patterns=[
                Pattern(
                    name="ifsc",
                    regex=r"\b[A-Z]{4}0[A-Z0-9]{6}\b",
                    score=0.6,
                ),
            ],
            context=["ifsc", "bank", "neft", "rtgs", "imps", "branch"],
            supported_language="en",
        )
    )

    # -- UPI ID: username@provider (known UPI handles) ----------------------
    _upi_handles = (
        "okicici|okaxis|oksbi|okhdfcbank|okkotak|ybl|paytm|ibl|upi|apl"
        "|axisbank|barodampay|citi|citigold|dbs|dlb|federal|freecharge"
        "|hsbc|icici|idbi|idfcfirst|indus|kotak|kbl|kvb|mahb|pnb|rbl"
        "|sbi|scb|sib|uboi|uco|unionbankofindia|vijb|waicici|waaxis"
        "|wasbi|wahdfcbank"
    )
    registry.add_recognizer(
        PatternRecognizer(
            supported_entity="IN_UPI_ID",
            name="Indian UPI ID Recognizer",
            patterns=[
                Pattern(
                    name="upi_id",
                    regex=rf"\b[\w.]+@(?:{_upi_handles})\b",
                    score=0.85,
                ),
            ],
            context=["upi", "pay", "payment", "vpa", "send money"],
            supported_language="en",
        )
    )

    # -- Indian Passport: 1 letter + 7 digits (context-boosted) -------------
    registry.add_recognizer(
        PatternRecognizer(
            supported_entity="IN_PASSPORT",
            name="Indian Passport Recognizer",
            patterns=[
                Pattern(
                    name="in_passport",
                    regex=r"\b[A-Z][0-9]{7}\b",
                    score=0.3,  # low base — needs context words
                ),
            ],
            context=["passport", "travel document", "passport number"],
            supported_language="en",
        )
    )

    # -- Indian Bank Account: 9–18 digits (context-boosted) -----------------
    registry.add_recognizer(
        PatternRecognizer(
            supported_entity="IN_BANK_ACCOUNT",
            name="Indian Bank Account Recognizer",
            patterns=[
                Pattern(
                    name="in_bank_account",
                    regex=r"\b\d{9,18}\b",
                    score=0.2,  # very low base — needs context words
                ),
            ],
            context=[
                "account number", "bank account", "a/c", "savings",
                "current account", "account no",
            ],
            supported_language="en",
        )
    )
