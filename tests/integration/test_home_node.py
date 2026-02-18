"""Integration tests for the Home Node sidecar pattern and LLM routing.

The Home Node runs two processes:
  Go Core  -- lightweight, always-on; exposes vault, DID, PII, notify
  Python Brain -- heavyweight; classification, reasoning, whisper assembly

If the Brain crashes, the Core keeps running (sidecar resilience).
Internal endpoints are never exposed to the external network.

LLM routing decides where inference runs based on task type and persona.
Two profiles: Local (llama-server, 6GB RAM) and Cloud (Gemini 2.5 Flash Lite, 2GB RAM).
"""

from __future__ import annotations

import pytest

from tests.integration.mocks import (
    LLMTarget,
    MockDinaCore,
    MockGoCore,
    MockIdentity,
    MockLLMRouter,
    MockPIIScrubber,
    MockPythonBrain,
    MockSilenceClassifier,
    MockVault,
    MockWhisperAssembler,
    Notification,
    PersonaType,
    SilenceTier,
)


# -----------------------------------------------------------------------
# TestSidecarPattern
# -----------------------------------------------------------------------


class TestSidecarPattern:
    """Verify Go Core + Python Brain sidecar architecture."""

    def test_core_exposes_vault_query(
        self, mock_go_core: MockGoCore, mock_vault: MockVault
    ) -> None:
        """Go Core exposes /v1/vault/query for full-text search."""
        mock_vault.store(1, "laptop_verdict", {"product": "ThinkPad X1"})
        mock_vault.index_for_fts("laptop_verdict", "ThinkPad X1 laptop review")

        results = mock_go_core.vault_query("ThinkPad")

        assert "laptop_verdict" in results
        assert any(
            c["endpoint"] == "/v1/vault/query" for c in mock_go_core.api_calls
        )

    def test_core_exposes_vault_store(
        self, mock_go_core: MockGoCore, mock_vault: MockVault
    ) -> None:
        """Go Core exposes /v1/vault/store for writing data."""
        mock_go_core.vault_store("test_key", {"data": "value"}, tier=1)

        assert mock_vault.retrieve(1, "test_key") == {"data": "value"}
        assert any(
            c["endpoint"] == "/v1/vault/store" for c in mock_go_core.api_calls
        )

    def test_core_exposes_did_sign(
        self, mock_go_core: MockGoCore
    ) -> None:
        """Go Core exposes /v1/did/sign for data signing."""
        data = b"verdict payload"
        signature = mock_go_core.did_sign(data)

        assert isinstance(signature, str)
        assert len(signature) > 0
        assert any(
            c["endpoint"] == "/v1/did/sign" for c in mock_go_core.api_calls
        )

    def test_core_exposes_did_verify(
        self, mock_go_core: MockGoCore
    ) -> None:
        """Go Core exposes /v1/did/verify for signature verification."""
        data = b"verdict payload"
        signature = mock_go_core.did_sign(data)
        valid = mock_go_core.did_verify(data, signature)

        assert valid is True
        assert any(
            c["endpoint"] == "/v1/did/verify" for c in mock_go_core.api_calls
        )

    def test_core_exposes_pii_scrub(
        self, mock_go_core: MockGoCore
    ) -> None:
        """Go Core exposes /v1/pii/scrub for PII removal."""
        scrubbed, replacements = mock_go_core.pii_scrub(
            "Rajmohan at rajmohan@email.com"
        )

        assert "Rajmohan" not in scrubbed
        assert "rajmohan@email.com" not in scrubbed
        assert any(
            c["endpoint"] == "/v1/pii/scrub" for c in mock_go_core.api_calls
        )

    def test_core_exposes_notify(
        self, mock_go_core: MockGoCore
    ) -> None:
        """Go Core exposes /v1/notify for sending notifications."""
        notification = Notification(
            tier=SilenceTier.TIER_2_SOLICITED,
            title="Price alert",
            body="ThinkPad dropped to 140k INR.",
            source="price_monitor",
        )
        mock_go_core.notify(notification)

        assert len(mock_go_core._notifications_sent) == 1
        assert any(
            c["endpoint"] == "/v1/notify" for c in mock_go_core.api_calls
        )

    def test_brain_exposes_process(
        self, mock_brain: MockPythonBrain
    ) -> None:
        """Python Brain exposes process() for data classification."""
        result = mock_brain.process({
            "type": "email_incoming",
            "content": "Your order has shipped.",
        })

        assert result["processed"] is True
        assert result["tier"] == SilenceTier.TIER_3_ENGAGEMENT
        assert len(mock_brain.processed) == 1

    def test_brain_exposes_reason(
        self, mock_brain: MockPythonBrain
    ) -> None:
        """Python Brain exposes reason() for complex analysis."""
        answer = mock_brain.reason(
            "Should I buy the ThinkPad X1 or the MacBook Air?",
            context={"budget": "150000 INR"},
        )

        assert "ThinkPad" in answer or "Reasoned answer" in answer
        assert len(mock_brain.reasoned) == 1

    def test_brain_crash_doesnt_kill_core(
        self, mock_dina: MockDinaCore
    ) -> None:
        """If the Python Brain crashes (OOM), Go Core keeps running."""
        # Brain crashes
        mock_dina.brain.crash()

        # Brain calls now fail
        with pytest.raises(RuntimeError, match="Brain has crashed"):
            mock_dina.brain.process({"type": "test", "content": "hello"})

        # But Go Core is unaffected -- vault, DID, PII, notify all work
        mock_dina.go_core.vault_store("resilience_test", {"alive": True})
        assert mock_dina.vault.retrieve(1, "resilience_test") == {"alive": True}

        sig = mock_dina.go_core.did_sign(b"still working")
        assert mock_dina.go_core.did_verify(b"still working", sig) is True

        scrubbed, _ = mock_dina.go_core.pii_scrub("Rajmohan test")
        assert "Rajmohan" not in scrubbed

        notification = Notification(
            tier=SilenceTier.TIER_1_FIDUCIARY,
            title="Brain down",
            body="Brain is OOM, core still operational.",
        )
        mock_dina.go_core.notify(notification)
        assert len(mock_dina.go_core._notifications_sent) == 1

        # Brain can be restarted
        mock_dina.brain.restart()
        result = mock_dina.brain.process({"type": "test", "content": "recovered"})
        assert result["processed"] is True

    def test_internal_api_not_exposed_externally(
        self, mock_dina: MockDinaCore
    ) -> None:
        """Internal API endpoints are restricted to localhost only.

        We verify by checking that the Go Core API calls are logged
        with internal endpoint paths that a firewall/reverse-proxy
        would block from external access.
        """
        # Exercise several internal endpoints
        mock_dina.go_core.vault_store("internal_test", {"secret": True})
        mock_dina.go_core.vault_query("internal")
        mock_dina.go_core.did_sign(b"internal data")
        mock_dina.go_core.pii_scrub("Rajmohan internal")
        mock_dina.go_core.notify(Notification(
            tier=SilenceTier.TIER_3_ENGAGEMENT,
            title="internal",
            body="test",
        ))

        # All endpoints use internal /v1/ prefix
        for call in mock_dina.go_core.api_calls:
            assert call["endpoint"].startswith("/v1/"), (
                f"Endpoint {call['endpoint']} does not use internal /v1/ prefix"
            )

        # Verify we have all expected internal endpoints
        endpoints_hit = {c["endpoint"] for c in mock_dina.go_core.api_calls}
        expected = {
            "/v1/vault/store",
            "/v1/vault/query",
            "/v1/did/sign",
            "/v1/pii/scrub",
            "/v1/notify",
        }
        assert expected.issubset(endpoints_hit)


# -----------------------------------------------------------------------
# TestLLMRouting
# -----------------------------------------------------------------------


class TestLLMRouting:
    """Verify that tasks are routed to the correct LLM target."""

    def test_simple_lookup_uses_sqlite_no_llm(
        self, mock_llm_router: MockLLMRouter
    ) -> None:
        """Simple FTS lookups use SQLite directly, no LLM call."""
        target = mock_llm_router.route("fts_search")
        assert target == LLMTarget.NONE

        target = mock_llm_router.route("exact_match")
        assert target == LLMTarget.NONE

        target = mock_llm_router.route("id_lookup")
        assert target == LLMTarget.NONE

        # Verify routing log records the reason
        assert all(
            entry["reason"] == "no_llm_needed"
            for entry in mock_llm_router.routing_log
        )

    def test_basic_summarization_uses_local(
        self, mock_llm_router: MockLLMRouter
    ) -> None:
        """Summarization and drafting use the local LLM (Gemma 3n)."""
        target = mock_llm_router.route("summarize")
        assert target == LLMTarget.LOCAL

        target = mock_llm_router.route("draft")
        assert target == LLMTarget.LOCAL

        target = mock_llm_router.route("classify")
        assert target == LLMTarget.LOCAL

        # Verify routing log records basic_task reason
        local_entries = [
            e for e in mock_llm_router.routing_log
            if e["target"] == LLMTarget.LOCAL
        ]
        assert all(e["reason"] == "basic_task" for e in local_entries)

    def test_complex_reasoning_uses_cloud(
        self, mock_llm_router: MockLLMRouter
    ) -> None:
        """Multi-step analysis and complex reasoning go to cloud via scrubber."""
        target = mock_llm_router.route("multi_step_analysis")
        assert target == LLMTarget.CLOUD

        target = mock_llm_router.route("complex_reasoning")
        assert target == LLMTarget.CLOUD

        cloud_entries = [
            e for e in mock_llm_router.routing_log
            if e["target"] == LLMTarget.CLOUD
        ]
        assert all(e["reason"] == "complex_task" for e in cloud_entries)

    def test_sensitive_persona_never_uses_cloud(
        self, mock_llm_router: MockLLMRouter
    ) -> None:
        """Health and financial persona data NEVER leaves the device."""
        # Even complex reasoning stays local for sensitive personas
        target_health = mock_llm_router.route(
            "complex_reasoning", persona=PersonaType.HEALTH
        )
        assert target_health == LLMTarget.LOCAL

        target_financial = mock_llm_router.route(
            "multi_step_analysis", persona=PersonaType.FINANCIAL
        )
        assert target_financial == LLMTarget.LOCAL

        # Verify the reason is sensitive_persona override
        sensitive_entries = [
            e for e in mock_llm_router.routing_log
            if e["reason"] == "sensitive_persona"
        ]
        assert len(sensitive_entries) == 2
        assert all(
            e["target"] == LLMTarget.LOCAL for e in sensitive_entries
        )

        # Non-sensitive persona still goes to cloud
        target_consumer = mock_llm_router.route(
            "complex_reasoning", persona=PersonaType.CONSUMER
        )
        assert target_consumer == LLMTarget.CLOUD

    def test_latency_sensitive_uses_on_device(
        self, mock_llm_router: MockLLMRouter
    ) -> None:
        """Interactive chat uses on-device LLM for lowest latency."""
        target = mock_llm_router.route("interactive_chat")
        assert target == LLMTarget.ON_DEVICE

        on_device_entries = [
            e for e in mock_llm_router.routing_log
            if e["target"] == LLMTarget.ON_DEVICE
        ]
        assert len(on_device_entries) == 1
        assert on_device_entries[0]["reason"] == "latency_sensitive"


class TestOnlineModeLLMRouting:
    """Online Mode: no local LLM, basic tasks go to Gemini 2.5 Flash Lite."""

    def test_basic_tasks_route_to_cloud(
        self, mock_cloud_llm_router: MockLLMRouter
    ) -> None:
        """In Online Mode, summarize/draft/classify go to CLOUD (Flash Lite)
        instead of LOCAL (no llama-server available)."""
        for task in ("summarize", "draft", "classify"):
            target = mock_cloud_llm_router.route(task)
            assert target == LLMTarget.CLOUD

        cloud_entries = [
            e for e in mock_cloud_llm_router.routing_log
            if e["reason"] == "basic_task_cloud_profile"
        ]
        assert len(cloud_entries) == 3

    def test_complex_tasks_still_cloud(
        self, mock_cloud_llm_router: MockLLMRouter
    ) -> None:
        """Complex reasoning goes to CLOUD in both profiles."""
        target = mock_cloud_llm_router.route("multi_step_analysis")
        assert target == LLMTarget.CLOUD
        target = mock_cloud_llm_router.route("complex_reasoning")
        assert target == LLMTarget.CLOUD

    def test_sensitive_persona_never_cloud_even_in_online_mode(
        self, mock_cloud_llm_router: MockLLMRouter
    ) -> None:
        """Health/financial data NEVER goes to cloud, even in Online Mode.
        Routes to on-device LLM instead."""
        target = mock_cloud_llm_router.route(
            "summarize", persona=PersonaType.HEALTH
        )
        assert target != LLMTarget.CLOUD
        assert target == LLMTarget.ON_DEVICE

        target = mock_cloud_llm_router.route(
            "complex_reasoning", persona=PersonaType.FINANCIAL
        )
        assert target != LLMTarget.CLOUD
        assert target == LLMTarget.ON_DEVICE

    def test_fts_still_no_llm_in_online_mode(
        self, mock_cloud_llm_router: MockLLMRouter
    ) -> None:
        """SQLite FTS lookups need no LLM regardless of mode."""
        target = mock_cloud_llm_router.route("fts_search")
        assert target == LLMTarget.NONE
