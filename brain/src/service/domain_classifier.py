"""4-layer domain sensitivity classifier.

Determines the sensitivity level of user text to control PII scrub
intensity.  Higher sensitivity = more aggressive scrubbing.

Pipeline (short-circuits on SENSITIVE/LOCAL_ONLY):

    Layer 1: Persona override  — ``/health`` persona → SENSITIVE.
    Layer 2: Keyword signals   — health/finance/legal keywords → score.
    Layer 3: Vault context     — sensitive source data → SENSITIVE.
    Layer 4: LLM fallback      — only if confidence < 0.5 and LLM available.

Selection: highest-confidence layer wins.

No imports from adapter/ — only domain types.
"""

from __future__ import annotations

import re
from typing import Any

import structlog

from ..domain.enums import Sensitivity
from ..domain.types import Classification

logger = structlog.get_logger(__name__)


# ---------------------------------------------------------------------------
# Layer 1: Persona → Sensitivity mapping
# ---------------------------------------------------------------------------

_PERSONA_MAP: dict[str, tuple[Sensitivity, str]] = {
    "health": (Sensitivity.SENSITIVE, "health persona override"),
    "medical": (Sensitivity.SENSITIVE, "medical persona override"),
    "financial": (Sensitivity.ELEVATED, "financial persona override"),
    "finance": (Sensitivity.ELEVATED, "financial persona override"),
    "legal": (Sensitivity.ELEVATED, "legal persona override"),
    "work": (Sensitivity.ELEVATED, "work persona override"),
    "general": (Sensitivity.GENERAL, "general persona"),
    "personal": (Sensitivity.GENERAL, "personal → general"),
    "social": (Sensitivity.GENERAL, "social → general"),
}

# ---------------------------------------------------------------------------
# Layer 2: Keyword signals → domain + sensitivity
# ---------------------------------------------------------------------------

_HEALTH_STRONG = re.compile(
    r"\b(?:diagnosis|prescription|symptom|blood\s*(?:sugar|pressure|test)|"
    r"cholesterol|A1C|biopsy|MRI|CT\s*scan|radiology|oncology|pathology|"
    r"medication|dosage|insulin|chemotherapy|surgery|hospital|clinic|"
    r"patient|medical\s*record|lab\s*result|hemoglobin|platelet|"
    r"x-ray|ultrasound|ecg|ekg)\b",
    re.IGNORECASE,
)

_HEALTH_WEAK = re.compile(
    r"\b(?:doctor|health|wellness|diet|exercise|weight|sleep|"
    r"headache|fever|cold|flu|allergy|vitamin)\b",
    re.IGNORECASE,
)

_FINANCE_STRONG = re.compile(
    r"\b(?:bank\s*account|credit\s*card|debit\s*card|loan|mortgage|"
    r"tax\s*return|salary|income|investment|portfolio|"
    r"aadhaar|pan\s*card|pan\s*number|ifsc|neft|rtgs|upi|"
    r"account\s*number|routing\s*number|swift|iban)\b",
    re.IGNORECASE,
)

_FINANCE_WEAK = re.compile(
    r"\b(?:money|payment|price|cost|budget|expense|savings|"
    r"insurance|premium|interest\s*rate)\b",
    re.IGNORECASE,
)

_LEGAL_STRONG = re.compile(
    r"\b(?:lawsuit|subpoena|deposition|court\s*order|litigation|"
    r"attorney|lawyer|legal\s*counsel|affidavit|indictment|"
    r"bail|probation|verdict|plea|custody|restraining\s*order)\b",
    re.IGNORECASE,
)


def _keyword_classify(text: str) -> Classification | None:
    """Layer 2: keyword-based classification."""
    health_strong = len(_HEALTH_STRONG.findall(text))
    health_weak = len(_HEALTH_WEAK.findall(text))
    finance_strong = len(_FINANCE_STRONG.findall(text))
    finance_weak = len(_FINANCE_WEAK.findall(text))
    legal_strong = len(_LEGAL_STRONG.findall(text))

    # Score each domain.
    health_score = health_strong * 0.3 + health_weak * 0.1
    finance_score = finance_strong * 0.3 + finance_weak * 0.1
    legal_score = legal_strong * 0.3

    best_domain = "general"
    best_score = 0.0
    best_sensitivity = Sensitivity.GENERAL

    if health_score > best_score:
        best_score = health_score
        best_domain = "health"
        best_sensitivity = Sensitivity.SENSITIVE if health_strong else Sensitivity.ELEVATED

    if finance_score > best_score:
        best_score = finance_score
        best_domain = "financial"
        best_sensitivity = Sensitivity.SENSITIVE if finance_strong else Sensitivity.ELEVATED

    if legal_score > best_score:
        best_score = legal_score
        best_domain = "legal"
        best_sensitivity = Sensitivity.SENSITIVE

    if best_score < 0.1:
        return None

    confidence = min(best_score, 1.0)
    return Classification(
        sensitivity=best_sensitivity,
        domain=best_domain,
        reason=f"keyword signals: {best_domain} (score={best_score:.2f})",
        confidence=confidence,
    )


class DomainClassifier:
    """4-layer sensitivity classifier.

    Parameters
    ----------
    llm:
        Optional LLM client for Layer 4 fallback.  If None, Layer 4
        is skipped and low-confidence results default to GENERAL.
    """

    # Tier → Sensitivity mapping (Brain-side logic).
    _TIER_SENSITIVITY = {
        "sensitive": Sensitivity.SENSITIVE,
        "locked": Sensitivity.SENSITIVE,
        "standard": Sensitivity.ELEVATED,
        "default": Sensitivity.GENERAL,
    }

    def __init__(self, llm: Any = None, registry: Any = None) -> None:
        self._llm = llm
        self._registry = registry

    def _resolve_persona_sensitivity(self, key: str) -> tuple[Sensitivity | None, str]:
        """Resolve persona name to sensitivity level.

        Uses registry (dynamic) first, falls back to static _PERSONA_MAP.
        Returns (sensitivity, reason) or (None, "") if unknown.
        """
        if self._registry:
            tier = self._registry.tier(key)
            if tier:
                sensitivity = self._TIER_SENSITIVITY.get(tier, Sensitivity.GENERAL)
                return sensitivity, f"{key} persona (tier={tier})"
        # Fallback to static map
        if key in _PERSONA_MAP:
            return _PERSONA_MAP[key]
        return None, ""

    def classify(
        self,
        text: str,
        persona: str | None = None,
        vault_context: dict[str, Any] | None = None,
    ) -> Classification:
        """Classify text sensitivity through the 4-layer pipeline.

        Parameters
        ----------
        text:
            The user's query or message text.
        persona:
            Active persona name (e.g. "health", "financial").
        vault_context:
            Optional metadata about the source data.

        Returns
        -------
        Classification
            Sensitivity level, domain, reason, and confidence.
        """
        # Layer 1: Persona override.
        if persona:
            key = persona.strip("/").lower()
            sensitivity, reason = self._resolve_persona_sensitivity(key)
            if sensitivity is not None:
                result = Classification(
                    sensitivity=sensitivity,
                    domain=key if key in ("health", "medical", "financial", "finance", "legal") else "general",
                    reason=reason,
                    confidence=0.95,
                )
                logger.debug("domain_classifier.persona_override", result=result)
                # Short-circuit on SENSITIVE/LOCAL_ONLY.
                if result.sensitivity in (Sensitivity.SENSITIVE, Sensitivity.LOCAL_ONLY):
                    return result
                # Otherwise, continue to see if keywords push higher.
                persona_result = result
            else:
                persona_result = None
        else:
            persona_result = None

        # Layer 2: Keyword signals.
        keyword_result = _keyword_classify(text)

        # Layer 3: Vault context.
        vault_result = None
        if vault_context:
            source = vault_context.get("source", "").lower()
            item_type = vault_context.get("type", "").lower()
            if source in ("health_system", "medical", "hospital", "clinic"):
                vault_result = Classification(
                    sensitivity=Sensitivity.SENSITIVE,
                    domain="health",
                    reason=f"vault source is '{source}'",
                    confidence=0.9,
                )
            elif source in ("bank", "financial", "tax"):
                vault_result = Classification(
                    sensitivity=Sensitivity.SENSITIVE,
                    domain="financial",
                    reason=f"vault source is '{source}'",
                    confidence=0.9,
                )
            elif item_type in ("medical_record", "lab_result", "prescription"):
                vault_result = Classification(
                    sensitivity=Sensitivity.SENSITIVE,
                    domain="health",
                    reason=f"vault item type is '{item_type}'",
                    confidence=0.9,
                )

        # Select: highest confidence wins.
        candidates: list[Classification] = []
        if persona_result:
            candidates.append(persona_result)
        if keyword_result:
            candidates.append(keyword_result)
        if vault_result:
            candidates.append(vault_result)

        if candidates:
            best = max(candidates, key=lambda c: c.confidence)
            # If there's a tie in confidence, prefer higher sensitivity.
            sensitivity_rank = {
                Sensitivity.LOCAL_ONLY: 4,
                Sensitivity.SENSITIVE: 3,
                Sensitivity.ELEVATED: 2,
                Sensitivity.GENERAL: 1,
            }
            ties = [c for c in candidates if c.confidence == best.confidence]
            if len(ties) > 1:
                best = max(ties, key=lambda c: sensitivity_rank.get(c.sensitivity, 0))
            return best

        # Layer 4: LLM fallback — skipped for now (no LLM in classifier).
        # Default to GENERAL.
        return Classification(
            sensitivity=Sensitivity.GENERAL,
            domain="general",
            reason="no signals detected — default general",
            confidence=0.3,
        )
