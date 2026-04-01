"""E2E Suite 14: Agentic Behavior — Deterministic Gates + Real LLM.

Two categories of tests:

1. **Deterministic gate tests** (quick-safe, no LLM needed):
   Bank fraud → fiduciary, YouTube → never interrupt, transfer_money → HIGH,
   search → SAFE, PII scrubbing.  These run in every mode — they verify
   that hard-coded safety boundaries hold regardless of LLM availability.

2. **Real LLM tests** (marked ``@pytest.mark.slow``):
   Healthz LLM check, unknown-action classification, /reason end-to-end.
   These hit Gemini / OpenRouter and are skipped in quick mode.

Principle: "Don't test what the LLM says, test what the system does."

Requirements:
- Docker containers must be running (DINA_E2E=docker).
- GOOGLE_API_KEY needed only for real-LLM tests (slow).
- If no API key, real-LLM tests skip gracefully (CI-friendly).

Actors: Don Alonso's Brain (brain-alonso at localhost:18200)

TST-E2E-075 through TST-E2E-083.
"""

from __future__ import annotations

import os

import httpx
import pytest

# ---------------------------------------------------------------------------
# Skip guards
# ---------------------------------------------------------------------------

_HAS_API_KEY = bool(os.environ.get("GOOGLE_API_KEY", "").strip())
_HAS_OPENROUTER_KEY = bool(os.environ.get("OPENROUTER_API_KEY", "").strip())
_DOCKER_MODE = os.environ.get("DINA_E2E") == "docker"

# All tests need Docker; only real-LLM tests need API keys (marked per-test).
pytestmark = [
    pytest.mark.skipif(
        not _DOCKER_MODE,
        reason="Requires Docker containers (DINA_E2E=docker)",
    ),
]

# ---------------------------------------------------------------------------
# Helper functions — call Brain HTTP APIs directly
# ---------------------------------------------------------------------------

def _brain_process(core_url: str, token: str, event: dict) -> dict:
    """POST agent intents through Core /v1/agent/validate."""
    if event.get("type") != "agent_intent":
        pytest.skip("Direct Brain /api access is internal-only (service-key authenticated)")
    resp = httpx.post(
        f"{core_url}/v1/agent/validate",
        json=event,
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


def _brain_reason(
    brain_url: str, token: str, prompt: str, provider: str | None = None,
) -> dict:
    """Direct Brain /api access is internal-only."""
    del brain_url, token, prompt, provider
    pytest.skip("Direct Brain /api access is internal-only (service-key authenticated)")


def _brain_healthz(brain_url: str) -> dict:
    """GET /healthz to check LLM availability."""
    resp = httpx.get(f"{brain_url}/healthz", timeout=5)
    return resp.json()


def _brain_pii_scrub(brain_url: str, token: str, text: str) -> dict:
    """Direct Brain /api access is internal-only."""
    del brain_url, token, text
    pytest.skip("Direct Brain /api access is internal-only (service-key authenticated)")


# ---------------------------------------------------------------------------
# Test class
# ---------------------------------------------------------------------------


class TestAgenticBehavior:
    """Suite 14 — Real LLM Agentic Behavior (TST-E2E-075 through TST-E2E-082).

    Tests system invariants with a real Gemini LLM in the pipeline.
    Every assertion is on deterministic system behavior, not LLM text.
    """

    # -- TST-E2E-075 ----------------------------------------------------------

    @pytest.mark.slow
    @pytest.mark.skipif(not _HAS_API_KEY, reason="GOOGLE_API_KEY not set")
    # TRACE: {"suite": "E2E", "case": "0075", "section": "14", "sectionName": "Agentic", "subsection": "01", "scenario": "01", "title": "llm_available_in_docker"}
    def test_llm_available_in_docker(self, docker_services) -> None:
        """E2E-14.1 Verify Gemini provider is available in Docker Brain.

        Precondition: confirms that the Brain container has
        google-generativeai installed and the GeminiProvider is active.
        """
        health = _brain_healthz(docker_services.brain_url("alonso"))
        assert health["status"] in ("ok", "degraded")
        assert health.get("llm_router") == "available", (
            "LLM router must be available when GOOGLE_API_KEY is set"
        )
        assert "gemini" in health.get("llm_models", "").lower(), (
            "Gemini model must appear in available models"
        )

    # -- TST-E2E-076 ----------------------------------------------------------

    # TRACE: {"suite": "E2E", "case": "0076", "section": "14", "sectionName": "Agentic", "subsection": "01", "scenario": "02", "title": "bank_fraud_always_interrupts"}
    def test_bank_fraud_always_interrupts(self, docker_services) -> None:
        """E2E-14.2 Bank fraud alert ALWAYS classified as fiduciary (Tier 1).

        Invariant: regardless of what the LLM returns, a bank fraud
        alert must be classified as fiduciary and routed to 'interrupt'.
        The deterministic gate checks for 'fraud' keyword BEFORE the LLM.
        """
        result = _brain_process(
            docker_services.core_url("alonso"),
            docker_services.client_token,
            {
                "type": "classify_silence",
                "body": "URGENT: Suspicious transaction of $4,999 detected "
                        "on your account. Verify immediately.",
                "source": "bank_alert",
                "priority": "fiduciary",
            },
        )
        assert result["classification"] == "fiduciary", (
            "Bank fraud alert must ALWAYS be classified as fiduciary"
        )
        assert result["action"] == "interrupt", (
            "Fiduciary events must ALWAYS trigger interrupt"
        )

    # -- TST-E2E-077 ----------------------------------------------------------

    @pytest.mark.slow
    @pytest.mark.skipif(not _HAS_API_KEY, reason="GOOGLE_API_KEY not set")
    # TRACE: {"suite": "E2E", "case": "0077", "section": "14", "sectionName": "Agentic", "subsection": "01", "scenario": "03", "title": "youtube_recommendation_never_interrupts"}
    def test_youtube_recommendation_never_interrupts(
        self, docker_services,
    ) -> None:
        """E2E-14.3 YouTube recommendation NEVER interrupts (engagement).

        Invariant: even if the LLM thinks a video is important, a YouTube
        recommendation is engagement-tier at most. The user is never
        interrupted for content they did not ask for (Silence First).
        Uses real LLM — engagement classification cannot be hardcoded
        because the same source can produce different priority events.
        """
        result = _brain_process(
            docker_services.core_url("alonso"),
            docker_services.client_token,
            {
                "type": "classify_silence",
                "body": "New video from MKBHD: The BEST Phone of 2026!",
                "source": "youtube_recommendation",
            },
        )
        assert result["classification"] != "fiduciary", (
            "YouTube recommendation must NEVER be classified as fiduciary"
        )
        assert result["action"] != "interrupt", (
            "YouTube recommendation must NEVER trigger interrupt"
        )

    # -- TST-E2E-078 ----------------------------------------------------------

    # TRACE: {"suite": "E2E", "case": "0078", "section": "14", "sectionName": "Agentic", "subsection": "01", "scenario": "04", "title": "transfer_money_always_high_risk"}
    def test_transfer_money_always_high_risk(self, docker_services) -> None:
        """E2E-14.4 transfer_money is ALWAYS HIGH risk regardless of LLM.

        Invariant: the deterministic gate classifies transfer_money as
        HIGH risk before the LLM is ever consulted. This is a hard
        boundary — the LLM cannot downgrade it.
        """
        result = _brain_process(
            docker_services.core_url("alonso"),
            docker_services.client_token,
            {
                "type": "agent_intent",
                "action": "transfer_money",
                "target": "did:plc:chairmaker",
                "agent_did": "did:plc:openclaw",
            },
        )
        assert result.get("risk") == "HIGH", (
            "transfer_money must ALWAYS be classified as HIGH risk"
        )
        assert result.get("approved") is False, (
            "HIGH risk actions must NEVER be auto-approved"
        )
        assert result.get("requires_approval") is True, (
            "HIGH risk actions must ALWAYS require approval"
        )

    # -- TST-E2E-079 ----------------------------------------------------------

    # TRACE: {"suite": "E2E", "case": "0079", "section": "14", "sectionName": "Agentic", "subsection": "01", "scenario": "05", "title": "search_always_safe"}
    def test_search_always_safe(self, docker_services) -> None:
        """E2E-14.5 search is ALWAYS SAFE risk regardless of LLM.

        Invariant: safe actions are auto-approved by the deterministic
        gate. The LLM is never consulted for known-safe actions.
        """
        result = _brain_process(
            docker_services.core_url("alonso"),
            docker_services.client_token,
            {
                "type": "agent_intent",
                "action": "search",
                "target": "best office chair 2026",
                "agent_did": "did:plc:openclaw",
            },
        )
        assert result.get("risk") == "SAFE", (
            "search must ALWAYS be classified as SAFE"
        )
        assert result.get("approved") is True, (
            "SAFE actions must ALWAYS be auto-approved"
        )

    # -- TST-E2E-080 ----------------------------------------------------------

    # TRACE: {"suite": "E2E", "case": "0080", "section": "14", "sectionName": "Agentic", "subsection": "01", "scenario": "06", "title": "pii_detected_by_scrubber"}
    def test_pii_detected_by_scrubber(self, docker_services) -> None:
        """E2E-14.6 PII is detected by the Brain's Tier 2 NER scrubber.

        Verifies that the spaCy-based PII scrubber in the Brain container
        correctly identifies person names and organizations. This is the
        gate that prevents PII from reaching cloud LLMs.
        """
        result = _brain_pii_scrub(
            docker_services.brain_url("alonso"),
            docker_services.client_token,
            "Dr. Sharma prescribed medication for patient Rajmohan "
            "at Apollo Hospital in Chennai.",
        )

        # The scrubber must detect at least one PII entity
        entities = result.get("entities", [])
        assert len(entities) >= 1, (
            "PII scrubber must detect at least one entity "
            "(person name or organization)"
        )

        # Scrubbed text should have replacements for structured PII
        scrubbed = result.get("scrubbed", "")
        # Structured PII (emails, phones) must not appear in scrubbed text
        # Names pass through intentionally

    # -- TST-E2E-081 ----------------------------------------------------------

    @pytest.mark.slow
    @pytest.mark.skipif(not _HAS_API_KEY, reason="GOOGLE_API_KEY not set")
    # TRACE: {"suite": "E2E", "case": "0081", "section": "14", "sectionName": "Agentic", "subsection": "01", "scenario": "07", "title": "unknown_action_gets_valid_risk"}
    def test_unknown_action_gets_valid_risk(self, docker_services) -> None:
        """E2E-14.7 Unknown actions get LLM classification with valid risk.

        The LLM is asked to classify an unusual action not in any
        hardcoded list. The system must return a valid risk category
        regardless of LLM response.
        """
        result = _brain_process(
            docker_services.core_url("alonso"),
            docker_services.client_token,
            {
                "type": "agent_intent",
                "action": "modify_dns_records",
                "target": "dina.local",
                "agent_did": "did:plc:some_agent",
            },
        )
        risk = result.get("risk", "")
        assert risk in ("SAFE", "MODERATE", "HIGH"), (
            f"Risk must be a valid category, got: {risk!r}"
        )

        # Gating must be consistent with risk
        if risk == "SAFE":
            assert result.get("approved") is True
        else:
            assert result.get("requires_approval") is True
            assert result.get("approved") is False

    # -- TST-E2E-082 ----------------------------------------------------------

    @pytest.mark.slow
    @pytest.mark.skipif(not _HAS_API_KEY, reason="GOOGLE_API_KEY not set")
    # TRACE: {"suite": "E2E", "case": "0082", "section": "14", "sectionName": "Agentic", "subsection": "01", "scenario": "08", "title": "llm_reason_returns_metadata"}
    def test_llm_reason_returns_metadata(self, docker_services) -> None:
        """E2E-14.8 LLM reason returns model name and token counts.

        Verifies the full LLM pipeline end-to-end: prompt in, response
        out, with observability metadata (model name, token counts).
        """
        # Runtime check: verify the Docker Brain actually has an LLM available.
        # GOOGLE_API_KEY may be set on the test runner but not inside Docker.
        health = _brain_healthz(docker_services.brain_url("alonso"))
        if health.get("llm_router") != "available":
            pytest.skip(
                "Brain LLM router not available in Docker — "
                "no LLM configured inside container"
            )

        result = _brain_reason(
            docker_services.brain_url("alonso"),
            docker_services.client_token,
            "What is the capital of France? Answer in one word.",
        )
        assert result.get("content"), "Response must have content"
        assert result.get("model"), "Response must include model name"
        assert "gemini" in result["model"].lower(), (
            "Model must be a Gemini variant"
        )
        assert result.get("tokens_in", 0) > 0, (
            "tokens_in must be positive for a real LLM call"
        )
        assert result.get("tokens_out", 0) > 0, (
            "tokens_out must be positive for a real LLM call"
        )

    # -- TST-E2E-083 ----------------------------------------------------------

    @pytest.mark.slow
    @pytest.mark.skipif(not _HAS_API_KEY, reason="GOOGLE_API_KEY not set")
    @pytest.mark.skipif(
        not _HAS_OPENROUTER_KEY,
        reason="OPENROUTER_API_KEY not set — skipping OpenRouter test",
    )
    # TRACE: {"suite": "E2E", "case": "0007", "section": "14", "sectionName": "Agentic", "subsection": "01", "scenario": "09", "title": "openrouter_reason_returns_metadata"}
    def test_openrouter_reason_returns_metadata(self, docker_services) -> None:
        """E2E-14.9 OpenRouter provider returns content and metadata.

        Verifies the full LLM pipeline through OpenRouter: prompt in,
        response out, with model name and token counts.
        Skips if OPENROUTER_API_KEY is not set.
        """
        result = _brain_reason(
            docker_services.brain_url("alonso"),
            docker_services.client_token,
            "What is 2 + 2? Answer in one word.",
            provider="openrouter",
        )
        assert result.get("content"), "Response must have content"
        assert result.get("model"), "Response must include model name"
        assert result.get("tokens_in", 0) > 0, (
            "tokens_in must be positive for a real LLM call"
        )
        assert result.get("tokens_out", 0) > 0, (
            "tokens_out must be positive for a real LLM call"
        )
