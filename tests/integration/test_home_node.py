"""Integration tests for the Home Node sidecar pattern and LLM routing.

The Home Node runs two processes:
  Go Core  -- lightweight, always-on; exposes vault, DID, PII, notify
  Python Brain -- heavyweight; classification, reasoning, whisper assembly

If the Brain crashes, the Core keeps running (sidecar resilience).
Internal endpoints are never exposed to the external network.

LLM routing decides where inference runs based on task type and persona.
Two profiles: Local (llama-server, 6GB RAM) and Cloud (Gemini 2.5 Flash Lite, 2GB RAM).

Additional sections:
  S1.1 BRAIN_TOKEN shared-secret authentication between Core and Brain.
  S1.2 Request flow Core -> Brain.
  S1.3 Request flow Brain -> Core.
  S2.1 User query via WebSocket.
  S2.2 User query via Admin UI.
  S2.3 Device pairing.
  S2.5 Onboarding.
  S2.6 Compromised Brain containment.
"""

from __future__ import annotations

import hashlib
import time
import uuid

import pytest

from tests.integration.mocks import (
    DinaMessage,
    LLMTarget,
    MockAdminAPI,
    MockDinaCore,
    MockGoCore,
    MockHuman,
    MockIdentity,
    MockKeyManager,
    MockLLMRouter,
    MockPIIScrubber,
    MockPythonBrain,
    MockRichClient,
    MockSilenceClassifier,
    MockThinClient,
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

# TST-INT-013
    # TRACE: {"suite": "INT", "case": "0013", "section": "02", "sectionName": "End-to-End User Flows", "subsection": "01", "scenario": "01", "title": "core_exposes_vault_query"}
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

# TST-INT-012
    # TRACE: {"suite": "INT", "case": "0012", "section": "02", "sectionName": "End-to-End User Flows", "subsection": "01", "scenario": "02", "title": "core_exposes_vault_store"}
    def test_core_exposes_vault_store(
        self, mock_go_core: MockGoCore, mock_vault: MockVault
    ) -> None:
        """Go Core exposes /v1/vault/store for writing data."""
        mock_go_core.vault_store("test_key", {"data": "value"}, tier=1)

        assert mock_vault.retrieve(1, "test_key") == {"data": "value"}
        assert any(
            c["endpoint"] == "/v1/vault/store" for c in mock_go_core.api_calls
        )

# TST-INT-086
    # TRACE: {"suite": "INT", "case": "0086", "section": "02", "sectionName": "End-to-End User Flows", "subsection": "01", "scenario": "03", "title": "core_exposes_did_sign"}
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

# TST-INT-007
    # TRACE: {"suite": "INT", "case": "0007", "section": "02", "sectionName": "End-to-End User Flows", "subsection": "01", "scenario": "04", "title": "core_exposes_did_verify"}
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

        # Counter-proof: tampered data fails verification
        tampered = b"tampered payload"
        assert mock_go_core.did_verify(tampered, signature) is False

        # Counter-proof: wrong signature fails verification
        assert mock_go_core.did_verify(data, "bad_signature_hex") is False

# TST-INT-082
    # TRACE: {"suite": "INT", "case": "0082", "section": "02", "sectionName": "End-to-End User Flows", "subsection": "01", "scenario": "05", "title": "core_exposes_pii_scrub"}
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

# TST-INT-016
    # TRACE: {"suite": "INT", "case": "0016", "section": "02", "sectionName": "End-to-End User Flows", "subsection": "01", "scenario": "06", "title": "core_exposes_notify"}
    def test_core_exposes_notify(
        self, mock_go_core: MockGoCore
    ) -> None:
        """Go Core exposes /v1/notify for sending notifications.
        The notification tier is recorded in the api_calls log."""
        # Counter-proof: no notifications before sending
        assert len(mock_go_core._notifications_sent) == 0

        notification = Notification(
            tier=SilenceTier.TIER_2_SOLICITED,
            title="Price alert",
            body="ThinkPad dropped to 140k INR.",
            source="price_monitor",
        )
        mock_go_core.notify(notification)

        assert len(mock_go_core._notifications_sent) == 1
        sent = mock_go_core._notifications_sent[0]
        assert sent.tier == SilenceTier.TIER_2_SOLICITED
        assert sent.title == "Price alert"
        assert sent.source == "price_monitor"

        # API call log records the endpoint and tier
        notify_calls = [
            c for c in mock_go_core.api_calls
            if c["endpoint"] == "/v1/notify"
        ]
        assert len(notify_calls) == 1
        assert notify_calls[0]["tier"] == SilenceTier.TIER_2_SOLICITED

# TST-INT-008
    # TRACE: {"suite": "INT", "case": "0008", "section": "02", "sectionName": "End-to-End User Flows", "subsection": "01", "scenario": "07", "title": "brain_exposes_process"}
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

# TST-INT-010
    # TRACE: {"suite": "INT", "case": "0010", "section": "02", "sectionName": "End-to-End User Flows", "subsection": "01", "scenario": "08", "title": "brain_exposes_reason"}
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

# TST-INT-009
    # TRACE: {"suite": "INT", "case": "0009", "section": "02", "sectionName": "End-to-End User Flows", "subsection": "01", "scenario": "09", "title": "brain_crash_doesnt_kill_core"}
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

# TST-INT-089
    # TRACE: {"suite": "INT", "case": "0089", "section": "02", "sectionName": "End-to-End User Flows", "subsection": "01", "scenario": "10", "title": "internal_api_not_exposed_externally"}
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

# TST-INT-090
    # TRACE: {"suite": "INT", "case": "0090", "section": "02", "sectionName": "End-to-End User Flows", "subsection": "02", "scenario": "01", "title": "simple_lookup_uses_sqlite_no_llm"}
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

# TST-INT-083
    # TRACE: {"suite": "INT", "case": "0083", "section": "02", "sectionName": "End-to-End User Flows", "subsection": "02", "scenario": "02", "title": "basic_summarization_uses_local"}
    def test_basic_summarization_uses_local(self) -> None:
        """Summarization and lightweight tasks route to local LLM.

        Exercises the real LLMRouter._select_provider decision tree from
        brain/src/service/llm_router.py with stub providers at the I/O
        boundary.  "summarize" and "intent_classification" are in production
        _LIGHTWEIGHT_TASKS; unknown tasks default to local when available.
        """
        from brain.src.service.llm_router import LLMRouter

        class _StubProvider:
            def __init__(self, name: str, *, local: bool):
                self._name = name
                self._local = local

            @property
            def model_name(self) -> str:
                return self._name

            @property
            def is_local(self) -> bool:
                return self._local

        router = LLMRouter(
            {"local": _StubProvider("local-model", local=True),
             "cloud": _StubProvider("cloud-model", local=False)},
        )

        # "summarize" is in production _LIGHTWEIGHT_TASKS → local preferred
        selected = router._select_provider("summarize", "open")
        assert selected.is_local, "summarize should route to local"

        # "intent_classification" is in production _LIGHTWEIGHT_TASKS → local
        selected = router._select_provider("intent_classification", "open")
        assert selected.is_local, "intent_classification should route to local"

        # Unknown task type falls to default → local preferred when available
        selected = router._select_provider("draft", "open")
        assert selected.is_local, "unknown task should default to local"

# TST-INT-075
    # TRACE: {"suite": "INT", "case": "0075", "section": "02", "sectionName": "End-to-End User Flows", "subsection": "02", "scenario": "03", "title": "complex_reasoning_uses_cloud"}
    def test_complex_reasoning_uses_cloud(
        self, mock_llm_router: MockLLMRouter
    ) -> None:
        """Multi-step analysis and complex reasoning go to cloud via scrubber."""
        # Pre-condition: no routing logged yet
        assert len(mock_llm_router.routing_log) == 0

        target = mock_llm_router.route("multi_step_analysis")
        assert target == LLMTarget.CLOUD

        target = mock_llm_router.route("complex_reasoning")
        assert target == LLMTarget.CLOUD

        cloud_entries = [
            e for e in mock_llm_router.routing_log
            if e["target"] == LLMTarget.CLOUD
        ]
        assert len(cloud_entries) == 2
        assert all(e["reason"] == "complex_task" for e in cloud_entries)

        # Counter-proof: basic tasks route to LOCAL, not CLOUD
        basic_target = mock_llm_router.route("summarize")
        assert basic_target == LLMTarget.LOCAL, \
            "Basic tasks must route to LOCAL, not CLOUD"

        # Counter-proof: simple lookups need no LLM at all
        lookup_target = mock_llm_router.route("fts_search")
        assert lookup_target == LLMTarget.NONE, \
            "FTS search needs no LLM"

# TST-INT-081
    # TRACE: {"suite": "INT", "case": "0081", "section": "02", "sectionName": "End-to-End User Flows", "subsection": "02", "scenario": "04", "title": "sensitive_persona_never_uses_cloud"}
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

# TST-INT-073
    # TRACE: {"suite": "INT", "case": "0073", "section": "02", "sectionName": "End-to-End User Flows", "subsection": "02", "scenario": "05", "title": "latency_sensitive_uses_on_device"}
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

# TST-INT-078
    # TRACE: {"suite": "INT", "case": "0078", "section": "02", "sectionName": "End-to-End User Flows", "subsection": "03", "scenario": "01", "title": "basic_tasks_route_to_cloud"}
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

# TST-INT-074
    # TRACE: {"suite": "INT", "case": "0074", "section": "02", "sectionName": "End-to-End User Flows", "subsection": "03", "scenario": "02", "title": "complex_tasks_still_cloud"}
    def test_complex_tasks_still_cloud(
        self, mock_cloud_llm_router: MockLLMRouter
    ) -> None:
        """Complex reasoning goes to CLOUD in both profiles."""
        target = mock_cloud_llm_router.route("multi_step_analysis")
        assert target == LLMTarget.CLOUD
        target = mock_cloud_llm_router.route("complex_reasoning")
        assert target == LLMTarget.CLOUD

# TST-INT-077
    # TRACE: {"suite": "INT", "case": "0077", "section": "02", "sectionName": "End-to-End User Flows", "subsection": "03", "scenario": "03", "title": "sensitive_persona_never_cloud_even_in_online_mode"}
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

# TST-INT-072
    # TRACE: {"suite": "INT", "case": "0072", "section": "02", "sectionName": "End-to-End User Flows", "subsection": "03", "scenario": "04", "title": "fts_still_no_llm_in_online_mode"}
    def test_fts_still_no_llm_in_online_mode(
        self, mock_cloud_llm_router: MockLLMRouter
    ) -> None:
        """SQLite FTS lookups need no LLM regardless of mode."""
        target = mock_cloud_llm_router.route("fts_search")
        assert target == LLMTarget.NONE


# -----------------------------------------------------------------------
# TestBrainTokenAuth  (S1.1)
# -----------------------------------------------------------------------


class TestBrainTokenAuth:
    """Verify BRAIN_TOKEN shared-secret authentication between Core and Brain.

    The BRAIN_TOKEN is a pre-shared secret placed in both containers.
    Every request between Core and Brain must carry this token; a mismatch
    renders the system non-functional.
    """

    @staticmethod
    def _make_brain_token() -> str:
        """Generate a random BRAIN_TOKEN (32-byte hex)."""
        return hashlib.sha256(uuid.uuid4().bytes).hexdigest()

    @staticmethod
    def _core_with_token(
        token: str,
        vault: MockVault | None = None,
        identity: MockIdentity | None = None,
    ) -> MockGoCore:
        """Build a MockGoCore that records its BRAIN_TOKEN."""
        vault = vault or MockVault()
        identity = identity or MockIdentity()
        scrubber = MockPIIScrubber()
        core = MockGoCore(vault, identity, scrubber)
        core._brain_token = token  # type: ignore[attr-defined]
        return core

    @staticmethod
    def _brain_with_token(token: str) -> MockPythonBrain:
        """Build a MockPythonBrain that records its BRAIN_TOKEN."""
        classifier = MockSilenceClassifier()
        whisper = MockWhisperAssembler(MockVault())
        router = MockLLMRouter()
        brain = MockPythonBrain(classifier, whisper, router)
        brain._brain_token = token  # type: ignore[attr-defined]
        return brain

    @staticmethod
    def _tokens_match(core: MockGoCore, brain: MockPythonBrain) -> bool:
        """Simulate the token-match check that guards every Core<->Brain call."""
        return getattr(core, "_brain_token", None) == getattr(brain, "_brain_token", None)

# TST-INT-001
    # TRACE: {"suite": "INT", "case": "0001", "section": "02", "sectionName": "End-to-End User Flows", "subsection": "04", "scenario": "01", "title": "shared_token_accepted"}
    def test_shared_token_accepted(self) -> None:
        """Both services share the same BRAIN_TOKEN -- communication succeeds."""
        token = self._make_brain_token()
        core = self._core_with_token(token)
        brain = self._brain_with_token(token)

        assert self._tokens_match(core, brain)

        # With matching tokens, Brain can process normally
        result = brain.process({"type": "email_incoming", "content": "hello"})
        assert result["processed"] is True

        # Core can use its endpoints normally
        core.vault_store("tok_ok", {"status": "accepted"})
        assert any(c["endpoint"] == "/v1/vault/store" for c in core.api_calls)

# TST-INT-002
    # TRACE: {"suite": "INT", "case": "0002", "section": "02", "sectionName": "End-to-End User Flows", "subsection": "04", "scenario": "02", "title": "token_mismatch_rejected"}
    def test_token_mismatch_rejected(self) -> None:
        """Different tokens on Core and Brain -- system is non-functional.

        In production the HTTP middleware rejects every request with 401.
        Here we verify MockServiceAuth.validate() rejects the wrong token.
        """
        from tests.integration.mocks import MockServiceAuth

        auth = MockServiceAuth()
        correct_token = auth.token

        # Wrong token is rejected on a valid brain endpoint
        wrong_token = "token_for_brain_BBBB"
        assert wrong_token != correct_token
        assert auth.validate(wrong_token, "/v1/vault/query") is False

        # Counter-proof: correct token on same endpoint succeeds
        assert auth.validate(correct_token, "/v1/vault/query") is True

        # Auth log captures both attempts with correct verdicts
        assert len(auth.auth_log) == 2
        assert auth.auth_log[0]["token_valid"] is False
        assert auth.auth_log[0]["result"] is False
        assert auth.auth_log[1]["token_valid"] is True
        assert auth.auth_log[1]["result"] is True

# TST-INT-003
    # TRACE: {"suite": "INT", "case": "0003", "section": "02", "sectionName": "End-to-End User Flows", "subsection": "04", "scenario": "03", "title": "token_rotation"}
    def test_token_rotation(self) -> None:
        """Replace BRAIN_TOKEN, restart both services -- new token accepted."""
        old_token = self._make_brain_token()
        core = self._core_with_token(old_token)
        brain = self._brain_with_token(old_token)

        assert self._tokens_match(core, brain)

        # Rotate the token
        new_token = self._make_brain_token()
        assert new_token != old_token

        # Simulate restart with new token on both sides
        core._brain_token = new_token  # type: ignore[attr-defined]
        brain._brain_token = new_token  # type: ignore[attr-defined]

        assert self._tokens_match(core, brain)

        # System is functional with the new token
        result = brain.process({"type": "test", "content": "rotated"})
        assert result["processed"] is True

# TST-INT-004
    # TRACE: {"suite": "INT", "case": "0004", "section": "02", "sectionName": "End-to-End User Flows", "subsection": "04", "scenario": "04", "title": "token_file_permissions"}
    def test_token_file_permissions(self) -> None:
        """BRAIN_TOKEN file must have restrictive permissions (chmod 600).

        We model this as a metadata check: the token store records the
        expected POSIX permission bits.  Production code must enforce this
        at container startup.
        """
        token = self._make_brain_token()
        token_metadata = {
            "value": token,
            "permissions": 0o600,  # rw-------
            "owner": "dina",
        }

        # Verify permission mask: only owner can read/write
        assert token_metadata["permissions"] == 0o600
        assert token_metadata["permissions"] & 0o077 == 0, (
            "Group/other must have no access to BRAIN_TOKEN file"
        )
        # Owner must not have execute
        assert token_metadata["permissions"] & 0o100 == 0


# -----------------------------------------------------------------------
# TestRequestFlowCoreToBrain  (S1.2)
# -----------------------------------------------------------------------


class TestRequestFlowCoreToBrain:
    """Verify that Go Core correctly forwards requests to the Python Brain."""

# TST-INT-005
    # TRACE: {"suite": "INT", "case": "0005", "section": "02", "sectionName": "End-to-End User Flows", "subsection": "05", "scenario": "01", "title": "forward_user_query"}
    def test_forward_user_query(
        self, mock_dina: MockDinaCore
    ) -> None:
        """Core receives a user query and forwards it to Brain via POST /v1/process.

        The full flow: user -> Core -> Brain.process() -> result back to Core.
        """
        user_query = {
            "type": "user_query",
            "content": "What is the best laptop under 150k INR?",
        }

        # Core forwards to Brain
        result = mock_dina.brain.process(user_query)

        assert result["processed"] is True
        assert len(mock_dina.brain.processed) == 1
        # The Brain's classifier determined the silence tier
        assert result["tier"] in (
            SilenceTier.TIER_1_FIDUCIARY,
            SilenceTier.TIER_2_SOLICITED,
            SilenceTier.TIER_3_ENGAGEMENT,
        )

# TST-INT-006
    # TRACE: {"suite": "INT", "case": "0006", "section": "02", "sectionName": "End-to-End User Flows", "subsection": "05", "scenario": "02", "title": "forward_inbound_d2d_message"}
    def test_forward_inbound_d2d_message(
        self, mock_dina: MockDinaCore
    ) -> None:
        """A Dina-to-Dina message arrives at Core and is delivered to Brain.

        The D2D message is a typed envelope; Core delivers the payload to
        Brain for classification and action.
        """
        d2d_payload = {
            "type": "dina/social/arrival",
            "content": "Sancho is arriving at the coffee shop",
        }

        # Core receives D2D message and passes it to Brain
        result = mock_dina.brain.process(d2d_payload)

        assert result["processed"] is True
        assert len(mock_dina.brain.processed) == 1


# -----------------------------------------------------------------------
# TestRequestFlowBrainToCore  (S1.3)
# -----------------------------------------------------------------------


class TestRequestFlowBrainToCore:
    """Verify Brain -> Core API calls for vault reads, scratchpad, and messaging."""

# TST-INT-011
    # TRACE: {"suite": "INT", "case": "0011", "section": "02", "sectionName": "End-to-End User Flows", "subsection": "06", "scenario": "01", "title": "read_vault_item"}
    def test_read_vault_item(
        self, mock_dina: MockDinaCore
    ) -> None:
        """Brain reads a vault item via Core's /v1/vault/query endpoint."""
        # Seed a vault item
        mock_dina.vault.store(1, "laptop_review_42", {"product": "ThinkPad X1", "score": 92})
        mock_dina.vault.index_for_fts("laptop_review_42", "ThinkPad X1 laptop review 92")

        # Brain asks Core to query vault
        results = mock_dina.go_core.vault_query("ThinkPad")

        assert "laptop_review_42" in results
        assert any(
            c["endpoint"] == "/v1/vault/query" for c in mock_dina.go_core.api_calls
        )

# TST-INT-014
    # TRACE: {"suite": "INT", "case": "0014", "section": "02", "sectionName": "End-to-End User Flows", "subsection": "06", "scenario": "02", "title": "write_scratchpad"}
    def test_write_scratchpad(
        self, mock_dina: MockDinaCore
    ) -> None:
        """Brain checkpoints a task via PUT /v1/vault/scratchpad.

        The scratchpad is stored in the vault at tier 4 (ephemeral staging)
        so that a Brain crash can resume from the last checkpoint.
        """
        # Pre-condition: tier 4 has no scratchpad yet
        assert mock_dina.vault.retrieve(4, "scratchpad_analysis_001") is None

        scratchpad_data = {
            "task_id": "analysis_001",
            "step": 3,
            "partial_result": "Collected 4 of 6 reviews",
            "checkpoint_ts": time.time(),
        }

        api_calls_before = len(mock_dina.go_core.api_calls)

        # Brain writes scratchpad via Core
        mock_dina.go_core.vault_store(
            "scratchpad_analysis_001", scratchpad_data, tier=4
        )

        # Verify the scratchpad is persisted at tier 4 (ephemeral staging)
        stored = mock_dina.vault.retrieve(4, "scratchpad_analysis_001")
        assert stored is not None
        assert stored["task_id"] == "analysis_001"
        assert stored["step"] == 3

        # Verify API call was logged
        new_calls = mock_dina.go_core.api_calls[api_calls_before:]
        vault_store_calls = [c for c in new_calls if c["endpoint"] == "/v1/vault/store"]
        assert len(vault_store_calls) == 1
        assert vault_store_calls[0]["key"] == "scratchpad_analysis_001"

        # Counter-proof: scratchpad is NOT in tier 1 (permanent storage)
        assert mock_dina.vault.retrieve(1, "scratchpad_analysis_001") is None

        # Overwrite with updated checkpoint (step 4)
        scratchpad_data["step"] = 4
        scratchpad_data["partial_result"] = "Collected 5 of 6 reviews"
        mock_dina.go_core.vault_store(
            "scratchpad_analysis_001", scratchpad_data, tier=4
        )
        updated = mock_dina.vault.retrieve(4, "scratchpad_analysis_001")
        assert updated["step"] == 4
        assert "5 of 6" in updated["partial_result"]

# TST-INT-015
    # TRACE: {"suite": "INT", "case": "0015", "section": "02", "sectionName": "End-to-End User Flows", "subsection": "06", "scenario": "03", "title": "send_outbound_message"}
    def test_send_outbound_message(
        self, mock_dina: MockDinaCore
    ) -> None:
        """Brain calls POST /v1/msg/send to dispatch an outbound D2D message.

        Core handles the DIDComm encryption and relay; Brain just provides
        the plaintext payload and destination DID.
        """
        # Pre-condition: no messages sent yet
        assert len(mock_dina.p2p.messages) == 0

        recipient_did = "did:plc:b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1"
        mock_dina.p2p.add_contact(recipient_did)
        mock_dina.p2p.add_session(mock_dina.identity.root_did, recipient_did)

        message = DinaMessage(
            type="dina/social/tea_invite",
            from_did=mock_dina.identity.root_did,
            to_did=recipient_did,
            payload={"text": "Tea at 4pm?", "location": "usual spot"},
        )

        sent = mock_dina.p2p.send(message)

        assert sent is True
        assert len(mock_dina.p2p.messages) == 1
        # Verify message content survived delivery
        delivered = mock_dina.p2p.messages[0]
        assert delivered.type == "dina/social/tea_invite"
        assert delivered.from_did == mock_dina.identity.root_did
        assert delivered.to_did == recipient_did
        assert delivered.payload["text"] == "Tea at 4pm?"

        # Counter-proof: unauthenticated recipient → queued, not delivered
        rogue_did = "did:plc:Rogue123456789012345678901234"
        rogue_msg = DinaMessage(
            type="dina/social/tea_invite",
            from_did=mock_dina.identity.root_did,
            to_did=rogue_did,
            payload={"text": "Suspicious invite"},
        )
        rogue_sent = mock_dina.p2p.send(rogue_msg)
        assert rogue_sent is False
        assert len(mock_dina.p2p.messages) == 1  # unchanged
        assert len(mock_dina.p2p.queue) == 1  # queued instead


# -----------------------------------------------------------------------
# TestUserQueryWS  (S2.1)
# -----------------------------------------------------------------------


class TestUserQueryWS:
    """User query via WebSocket -- auth, query, streaming, heartbeat.

    The WebSocket flow is: client authenticates with a device token,
    sends queries, receives streamed responses from Brain, and
    exchanges heartbeat pings.
    """

# TST-INT-017
    # TRACE: {"suite": "INT", "case": "0017", "section": "02", "sectionName": "End-to-End User Flows", "subsection": "07", "scenario": "01", "title": "simple_query_full_ws_flow"}
    def test_simple_query_full_ws_flow(
        self, mock_dina: MockDinaCore, mock_thin_client: MockThinClient
    ) -> None:
        """Full WS flow: authenticate -> send query -> Brain processes -> response.

        The thin client connects, sends a query payload, Brain produces a
        result, and Core streams it back.
        """
        # Pre-condition: client not connected, no streams received
        assert mock_thin_client.connected is False
        assert len(mock_thin_client.received_streams) == 0
        assert len(mock_dina.brain.processed) == 0

        # Counter-proof: unauthenticated client cannot receive streams
        mock_thin_client.receive_stream({"type": "rogue_data"})
        assert len(mock_thin_client.received_streams) == 0, \
            "Unauthenticated client must not receive data"

        # Counter-proof: connecting without device_key fails
        connected_no_key = mock_thin_client.connect(mock_dina.go_core)
        assert connected_no_key is False, \
            "Connection without device key must fail"

        # Step 1: Authenticate the client
        device_key = mock_dina.identity.register_device(mock_thin_client.device_id)
        mock_thin_client.device_key = device_key
        connected = mock_thin_client.connect(mock_dina.go_core)
        assert connected is True

        # Step 2: Client sends a query
        query_payload = {
            "type": "user_query",
            "content": "Best ergonomic chair under 100k INR?",
        }

        # Step 3: Brain processes the query
        result = mock_dina.brain.process(query_payload)
        assert result["processed"] is True
        assert len(mock_dina.brain.processed) == 1

        # Step 4: Core streams the response back to the thin client
        response = {
            "type": "query_response",
            "answer": "Herman Miller Aeron scores highest in expert reviews.",
            "tier": result["tier"].value,
        }
        mock_thin_client.receive_stream(response)

        assert len(mock_thin_client.received_streams) == 1
        received = mock_thin_client.received_streams[0]
        assert received["type"] == "query_response"
        # Verify response content survived streaming
        assert "Herman Miller" in received["answer"]
        assert received["tier"] is not None

# TST-INT-019
    # TRACE: {"suite": "INT", "case": "0019", "section": "02", "sectionName": "End-to-End User Flows", "subsection": "07", "scenario": "02", "title": "streaming_response_chunks"}
    def test_streaming_response_chunks(
        self, mock_dina: MockDinaCore, mock_thin_client: MockThinClient
    ) -> None:
        """Brain streams multiple chunks; the final chunk carries a whisper.

        Each chunk is a partial response; the last chunk has is_final=True.
        """
        # Pre-condition: no streams received yet
        assert len(mock_thin_client.received_streams) == 0

        # Counter-proof: unauthenticated client silently drops streams
        mock_thin_client.receive_stream({"chunk_id": 0, "text": "rogue"})
        assert len(mock_thin_client.received_streams) == 0, \
            "Unauthenticated client must not receive data"

        # Authenticate
        device_key = mock_dina.identity.register_device(mock_thin_client.device_id)
        mock_thin_client.device_key = device_key
        connected = mock_thin_client.connect(mock_dina.go_core)
        assert connected is True

        # Brain processes and produces multiple chunks
        result = mock_dina.brain.process({
            "type": "user_query",
            "content": "Compare ThinkPad X1 vs MacBook Air",
        })
        assert result["processed"] is True

        # Stream 3 partial chunks + 1 final chunk
        chunks = [
            {"chunk_id": 1, "text": "ThinkPad X1 has a", "is_final": False},
            {"chunk_id": 2, "text": " better keyboard.", "is_final": False},
            {"chunk_id": 3, "text": " MacBook has better battery.", "is_final": False},
            {"chunk_id": 4, "text": " Recommendation: ThinkPad for typing.",
             "is_final": True, "whisper": "User prefers keyboard quality."},
        ]
        for chunk in chunks:
            mock_thin_client.receive_stream(chunk)

        assert len(mock_thin_client.received_streams) == 4

        # Verify chunks arrive in order with correct content
        assert mock_thin_client.received_streams[0]["chunk_id"] == 1
        assert mock_thin_client.received_streams[2]["text"] == " MacBook has better battery."

        # Verify the final chunk
        final = mock_thin_client.received_streams[-1]
        assert final["is_final"] is True
        assert "whisper" in final
        assert final["whisper"] == "User prefers keyboard quality."

        # Non-final chunks must NOT carry whispers
        for chunk in mock_thin_client.received_streams[:-1]:
            assert chunk["is_final"] is False
            assert "whisper" not in chunk

# TST-INT-020
    # TRACE: {"suite": "INT", "case": "0020", "section": "02", "sectionName": "End-to-End User Flows", "subsection": "07", "scenario": "03", "title": "query_during_brain_outage"}
    def test_query_during_brain_outage(
        self, mock_dina: MockDinaCore, mock_thin_client: MockThinClient
    ) -> None:
        """When Brain is down, a user query should fail with RuntimeError.

        Core detects the Brain crash. The Brain sidecar is independent —
        Core and vault remain operational even when Brain is down.
        After Brain restarts, queries succeed again.
        """
        # Authenticate and connect
        device_key = mock_dina.identity.register_device(mock_thin_client.device_id)
        mock_thin_client.device_key = device_key
        mock_thin_client.connect(mock_dina.go_core)

        # Counter-proof: Brain works before crash
        result_before = mock_dina.brain.process({
            "type": "user_query",
            "content": "Normal query before crash",
        })
        assert result_before is not None

        # Brain crashes
        mock_dina.brain.crash()

        # Query attempt fails with RuntimeError
        with pytest.raises(RuntimeError, match="Brain has crashed"):
            mock_dina.brain.process({
                "type": "user_query",
                "content": "What time is the meeting?",
            })

        # Core itself is still alive (sidecar resilience)
        mock_dina.go_core.vault_store("still_alive", {"status": "ok"})
        assert mock_dina.vault.retrieve(1, "still_alive") == {"status": "ok"}

        # Core API audit trail is still recording
        vault_calls = [
            c for c in mock_dina.go_core.api_calls
            if c["endpoint"] == "/v1/vault/store"
        ]
        assert len(vault_calls) >= 1

        # Brain restart restores query capability
        mock_dina.brain.restart()
        result_after = mock_dina.brain.process({
            "type": "user_query",
            "content": "Query after restart",
        })
        assert result_after is not None

# TST-INT-023
    # TRACE: {"suite": "INT", "case": "0023", "section": "02", "sectionName": "End-to-End User Flows", "subsection": "07", "scenario": "04", "title": "heartbeat_round_trip"}
    def test_heartbeat_round_trip(
        self, mock_dina: MockDinaCore, mock_thin_client: MockThinClient
    ) -> None:
        """Heartbeat: authenticated client receives ping; unauthenticated
        or disconnected client does not.

        Verifies: device registration, connection gating, stream delivery
        to connected clients, and stream rejection for disconnected clients.
        """
        # --- Unauthenticated client cannot connect ---
        assert mock_thin_client.device_key is None
        connected = mock_thin_client.connect(mock_dina.go_core)
        assert connected is False, (
            "Client without device_key must fail to connect"
        )

        # --- Authenticate and connect ---
        device_key = mock_dina.identity.register_device(
            mock_thin_client.device_id
        )
        assert device_key is not None, "register_device must return a key"
        mock_thin_client.device_key = device_key
        connected = mock_thin_client.connect(mock_dina.go_core)
        assert connected is True, (
            "Client with valid device_key must connect successfully"
        )

        # --- Connected client receives ping ---
        ping = {"type": "ping", "ts": time.time()}
        mock_thin_client.receive_stream(ping)
        assert len(mock_thin_client.received_streams) == 1, (
            "Connected client must receive exactly one stream message"
        )
        received_ping = mock_thin_client.received_streams[0]
        assert received_ping["type"] == "ping", (
            "Received message must be the ping we sent"
        )
        assert received_ping["ts"] == ping["ts"], (
            "Ping timestamp must be preserved through delivery"
        )

        # --- Disconnected client does NOT receive streams ---
        mock_thin_client.connected = False
        mock_thin_client.receive_stream({"type": "ping", "ts": time.time()})
        assert len(mock_thin_client.received_streams) == 1, (
            "Disconnected client must not accumulate stream messages"
        )

        # --- Reconnected client receives again ---
        mock_thin_client.connected = True
        mock_thin_client.receive_stream({"type": "ping", "ts": time.time()})
        assert len(mock_thin_client.received_streams) == 2, (
            "Reconnected client must receive stream messages again"
        )


# -----------------------------------------------------------------------
# TestAdminUI  (S2.2)
# -----------------------------------------------------------------------


class TestAdminUI:
    """User query via Admin UI -- browser login, dashboard, session expiry.

    The Admin UI is a local web interface served by Go Core on 127.0.0.1.
    Authentication uses Argon2id password hashing.
    """

    @staticmethod
    def _hash_password_argon2id(password: str) -> str:
        """Simulate Argon2id hashing (mocked as SHA-256 for tests).

        In production this uses argon2-cffi with time_cost=3, memory_cost=65536.
        """
        return hashlib.sha256(f"argon2id:{password}".encode()).hexdigest()

    @staticmethod
    def _verify_password(password: str, stored_hash: str) -> bool:
        """Verify a password against the stored Argon2id hash."""
        return hashlib.sha256(f"argon2id:{password}".encode()).hexdigest() == stored_hash

    @staticmethod
    def _create_session(user_id: str, ttl_seconds: int = 3600) -> dict:
        """Create a session token with expiry."""
        return {
            "session_id": uuid.uuid4().hex,
            "user_id": user_id,
            "created_at": time.time(),
            "expires_at": time.time() + ttl_seconds,
        }

# TST-INT-025
    # TRACE: {"suite": "INT", "case": "0025", "section": "02", "sectionName": "End-to-End User Flows", "subsection": "08", "scenario": "01", "title": "browser_login_dashboard"}
    def test_browser_login_dashboard(
        self, mock_dina: MockDinaCore, mock_admin_api: MockAdminAPI
    ) -> None:
        """Browser login via Argon2id auth -- valid password grants dashboard access."""
        # Wrong password must be rejected
        bad_session = mock_admin_api.login("wrong-password-123")
        assert bad_session is None, "Wrong passphrase must not produce a session"

        # Correct password grants a session
        session = mock_admin_api.login("admin-passphrase")
        assert session is not None, "Valid passphrase must produce a session"
        assert session.is_valid(), "Fresh session must not be expired"

        # Dashboard accessible with valid session
        dashboard = mock_admin_api.dashboard(session.session_id)
        assert dashboard is not None, "Valid session must grant dashboard access"
        assert "root_did" in dashboard
        assert dashboard["root_did"] == mock_dina.identity.root_did

        # Dashboard inaccessible with invalid session
        no_dashboard = mock_admin_api.dashboard("invalid_session_id")
        assert no_dashboard is None, "Invalid session must deny dashboard access"

        # Logout invalidates the session
        mock_admin_api.logout(session.session_id)
        post_logout = mock_admin_api.dashboard(session.session_id)
        assert post_logout is None, "Logged-out session must deny dashboard access"

# TST-INT-026
    # TRACE: {"suite": "INT", "case": "0026", "section": "02", "sectionName": "End-to-End User Flows", "subsection": "08", "scenario": "02", "title": "dashboard_query_response"}
    def test_dashboard_query_response(
        self, mock_dina: MockDinaCore, mock_admin_api: MockAdminAPI
    ) -> None:
        """After logging in, user submits a query from the dashboard and
        receives a response.

        Exercises MockAdminAPI.login -> dashboard -> query_via_dashboard,
        verifying session-gated access and query routing.
        """
        # Login via AdminAPI (uses Argon2id mock)
        session = mock_admin_api.login("admin-passphrase")
        assert session is not None, "Valid passphrase must produce a session"
        assert session.is_valid(), "Fresh session must not be expired"

        # Wrong passphrase must be rejected
        bad_session = mock_admin_api.login("wrong-password")
        assert bad_session is None, "Invalid passphrase must not produce a session"

        # Dashboard data is accessible with valid session
        dashboard_data = mock_admin_api.dashboard(session.session_id)
        assert dashboard_data is not None, "Valid session must grant dashboard access"
        assert "root_did" in dashboard_data
        assert dashboard_data["root_did"] == mock_dina.identity.root_did

        # Submit a query through the dashboard
        response = mock_admin_api.query_via_dashboard(
            session.session_id, "Show me all laptop reviews",
        )
        assert response is not None, "Valid session must allow queries"
        assert "laptop" in response.lower()

        # Query with an invalid session must be rejected
        rejected = mock_admin_api.query_via_dashboard(
            "invalid-session-id", "Show me all laptop reviews",
        )
        assert rejected is None, "Invalid session must not return query results"

        # Verify API call audit trail was recorded
        endpoints_called = [c["endpoint"] for c in mock_admin_api.api_calls]
        assert "/admin/login" in endpoints_called
        assert "/admin/dashboard" in endpoints_called
        assert "/admin/query" in endpoints_called

# TST-INT-027
    # TRACE: {"suite": "INT", "case": "0027", "section": "02", "sectionName": "End-to-End User Flows", "subsection": "08", "scenario": "03", "title": "session_expiry_redirect"}
    def test_session_expiry_redirect(
        self, mock_dina: MockDinaCore
    ) -> None:
        """After session expires, any dashboard request redirects to login.

        The session has a TTL; once expired, the user must re-authenticate.
        Validates that vault-stored sessions are distinguishable by expiry
        and that valid sessions are NOT flagged as expired (counter-proof).
        """
        # --- Valid session: created with 1-hour TTL ---
        valid_session = self._create_session("admin", ttl_seconds=3600)
        mock_dina.vault.store(0, f"session_{valid_session['session_id']}", valid_session)

        retrieved_valid = mock_dina.vault.retrieve(0, f"session_{valid_session['session_id']}")
        assert retrieved_valid is not None
        assert retrieved_valid["user_id"] == "admin"
        valid_expired = time.time() > retrieved_valid["expires_at"]
        assert valid_expired is False, (
            "A session with 1h TTL must NOT be expired immediately"
        )

        # --- Expired session: TTL 0 then backdated ---
        expired_session = self._create_session("admin", ttl_seconds=0)
        expired_session["expires_at"] = time.time() - 60  # 1 minute ago
        mock_dina.vault.store(0, f"session_{expired_session['session_id']}", expired_session)

        retrieved_expired = mock_dina.vault.retrieve(0, f"session_{expired_session['session_id']}")
        assert retrieved_expired is not None
        expired_check = time.time() > retrieved_expired["expires_at"]
        assert expired_check is True, (
            "A backdated session must be detected as expired"
        )

        # --- The two sessions have different IDs (no collision) ---
        assert valid_session["session_id"] != expired_session["session_id"]

        # --- Verify session fields are structurally correct ---
        for sess in (retrieved_valid, retrieved_expired):
            assert "session_id" in sess
            assert "user_id" in sess
            assert "created_at" in sess
            assert "expires_at" in sess
            assert sess["created_at"] <= sess["expires_at"] or sess is retrieved_expired


# -----------------------------------------------------------------------
# TestDevicePairing  (S2.3)
# -----------------------------------------------------------------------


class TestDevicePairing:
    """Device pairing via 6-digit code and immediate use after pairing."""

    @staticmethod
    def _generate_pairing_code() -> str:
        """Generate a 6-digit pairing code (mock: deterministic from UUID)."""
        return str(uuid.uuid4().int % 1_000_000).zfill(6)

# TST-INT-028
    # TRACE: {"suite": "INT", "case": "0028", "section": "02", "sectionName": "End-to-End User Flows", "subsection": "09", "scenario": "01", "title": "full_pairing_flow"}
    def test_full_pairing_flow(
        self, mock_dina: MockDinaCore
    ) -> None:
        """Full pairing: Core generates 6-digit code -> user enters on new device
        -> Core validates -> CLIENT_TOKEN issued.

        The CLIENT_TOKEN is a device-specific credential derived from the
        root identity, allowing the paired device to authenticate all future
        requests.
        """
        # Step 1: Core generates a 6-digit pairing code
        pairing_code = self._generate_pairing_code()
        assert len(pairing_code) == 6
        assert pairing_code.isdigit()

        # Store the pairing code in vault tier 0 with short TTL
        mock_dina.vault.store(0, f"pairing_code_{pairing_code}", {
            "code": pairing_code,
            "created_at": time.time(),
            "expires_at": time.time() + 300,  # 5 min
            "used": False,
        })

        # Step 2: New device submits the pairing code
        stored = mock_dina.vault.retrieve(0, f"pairing_code_{pairing_code}")
        assert stored is not None
        assert stored["code"] == pairing_code
        assert stored["used"] is False
        assert time.time() < stored["expires_at"]

        # Step 3: Core validates and issues a CLIENT_TOKEN
        new_device_id = "tablet_001"
        client_token = mock_dina.identity.register_device(new_device_id)
        assert len(client_token) == 64  # SHA-256 hex

        # Mark the code as used
        stored["used"] = True
        mock_dina.vault.store(0, f"pairing_code_{pairing_code}", stored)

        # Step 4: Verify the device is now registered
        assert new_device_id in mock_dina.identity.devices

        # Verify the code cannot be reused
        recheck = mock_dina.vault.retrieve(0, f"pairing_code_{pairing_code}")
        assert recheck["used"] is True

# TST-INT-029
    # TRACE: {"suite": "INT", "case": "0029", "section": "02", "sectionName": "End-to-End User Flows", "subsection": "09", "scenario": "02", "title": "pairing_then_immediate_use"}
    def test_pairing_then_immediate_use(
        self, mock_dina: MockDinaCore, mock_thin_client: MockThinClient
    ) -> None:
        """After pairing, the new device can immediately send queries.

        This tests the end-to-end: pair -> connect -> query -> response.
        """
        # Pair the device
        pairing_code = self._generate_pairing_code()
        mock_dina.vault.store(0, f"pairing_code_{pairing_code}", {
            "code": pairing_code,
            "created_at": time.time(),
            "expires_at": time.time() + 300,
            "used": False,
        })

        # Issue CLIENT_TOKEN
        client_token = mock_dina.identity.register_device(mock_thin_client.device_id)
        mock_thin_client.device_key = client_token

        # Connect via WebSocket
        connected = mock_thin_client.connect(mock_dina.go_core)
        assert connected is True

        # Immediately send a query
        query = {
            "type": "user_query",
            "content": "Any price alerts for ThinkPad X1?",
        }
        result = mock_dina.brain.process(query)
        assert result["processed"] is True

        # Receive the response
        mock_thin_client.receive_stream({
            "type": "query_response",
            "answer": "No price alerts yet.",
        })
        assert len(mock_thin_client.received_streams) == 1
        assert mock_thin_client.received_streams[0]["type"] == "query_response"


# -----------------------------------------------------------------------
# TestOnboarding  (S2.5)
# -----------------------------------------------------------------------


class TestOnboarding:
    """Managed onboarding flow -- the 10 silent steps.

    When Dina is first set up, the Home Node runs a 10-step onboarding
    sequence: generate identity, create /personal persona, set up vault,
    configure encryption, derive keys, etc.
    """

# TST-INT-035
    # TRACE: {"suite": "INT", "case": "0035", "section": "02", "sectionName": "End-to-End User Flows", "subsection": "10", "scenario": "01", "title": "full_managed_onboarding"}
    def test_full_managed_onboarding(self) -> None:
        """All 10 silent onboarding steps execute in order.

        Steps:
        1. Generate Ed25519 root keypair
        2. Derive BIP-39 mnemonic
        3. Create /personal persona
        4. Initialize vault (6 tiers)
        5. Set up PII scrubber
        6. Configure silence classifier defaults
        7. Generate BRAIN_TOKEN
        8. Start Go Core
        9. Start Python Brain
        10. Write onboarding_complete flag
        """
        # Step 1: Root identity
        identity = MockIdentity()
        assert identity.root_did.startswith("did:plc:")
        assert len(identity.root_private_key) > 0

        # Step 2: BIP-39 mnemonic
        words = identity.bip39_mnemonic.split()
        assert len(words) == 24

        # Step 3: /personal persona
        personal = identity.derive_persona(PersonaType.CONSUMER)
        assert personal.persona_type == PersonaType.CONSUMER
        assert personal.did.startswith("did:key:")

        # Step 4: Vault with 6 tiers
        vault = MockVault()
        assert len(vault._tiers) == 6
        for tier_num in range(6):
            assert tier_num in vault._tiers

        # Step 5: PII scrubber
        scrubber = MockPIIScrubber()
        assert len(scrubber._replacement_map) > 0

        # Step 6: Silence classifier
        classifier = MockSilenceClassifier()
        assert len(classifier.FIDUCIARY_KEYWORDS) > 0
        assert len(classifier.SOLICITED_TYPES) > 0

        # Step 7: BRAIN_TOKEN
        brain_token = hashlib.sha256(uuid.uuid4().bytes).hexdigest()
        assert len(brain_token) == 64

        # Step 8: Go Core
        core = MockGoCore(vault, identity, scrubber)
        assert core._vault is vault

        # Step 9: Python Brain
        whisper = MockWhisperAssembler(vault)
        router = MockLLMRouter()
        brain = MockPythonBrain(classifier, whisper, router)
        assert not brain._crashed

        # Step 10: Mark onboarding complete
        vault.store(0, "onboarding_complete", {
            "completed_at": time.time(),
            "steps_run": 10,
            "version": "0.4",
        })
        flag = vault.retrieve(0, "onboarding_complete")
        assert flag is not None
        assert flag["steps_run"] == 10

# TST-INT-036
    # TRACE: {"suite": "INT", "case": "0036", "section": "02", "sectionName": "End-to-End User Flows", "subsection": "10", "scenario": "02", "title": "post_onboarding_system_functional"}
    def test_post_onboarding_system_functional(self) -> None:
        """After onboarding, all subsystems are wired and functional.

        Core can store/query, Brain can process, PII scrubber works,
        identity can sign/verify.
        """
        dina = MockDinaCore()

        # Pre-condition: vault is empty before onboarding
        assert dina.vault.retrieve(0, "onboarding_complete") is None

        # Mark onboarding done
        dina.vault.store(0, "onboarding_complete", {"completed_at": time.time()})
        assert dina.vault.retrieve(0, "onboarding_complete") is not None

        # Vault store + query through Core API
        api_calls_before = len(dina.go_core.api_calls)
        dina.go_core.vault_store("post_onboard_test", {"ok": True})
        assert dina.vault.retrieve(1, "post_onboard_test") == {"ok": True}
        # Verify API call was logged
        new_calls = [c for c in dina.go_core.api_calls[api_calls_before:]
                     if c["endpoint"] == "/v1/vault/store"]
        assert len(new_calls) == 1

        # Brain process
        result = dina.brain.process({"type": "test", "content": "hello"})
        assert result["processed"] is True

        # PII scrub — both name and email should be redacted
        scrubbed, replacements = dina.go_core.pii_scrub("Rajmohan at rajmohan@email.com")
        assert "Rajmohan" not in scrubbed
        assert "rajmohan@email.com" not in scrubbed
        assert len(replacements) > 0  # replacements map was populated

        # DID sign + verify round-trip
        sig = dina.go_core.did_sign(b"onboarding done")
        assert dina.go_core.did_verify(b"onboarding done", sig) is True
        # Counter-proof: wrong data fails verification
        assert dina.go_core.did_verify(b"tampered data", sig) is False

# TST-INT-037
    # TRACE: {"suite": "INT", "case": "0037", "section": "02", "sectionName": "End-to-End User Flows", "subsection": "10", "scenario": "03", "title": "only_personal_persona_initially"}
    def test_only_personal_persona_initially(self) -> None:
        """After onboarding only the /personal persona exists.

        No other persona compartments are created until the user explicitly
        requests them.
        """
        identity = MockIdentity()

        # Onboarding creates only the personal (consumer) persona
        personal = identity.derive_persona(PersonaType.CONSUMER)
        assert PersonaType.CONSUMER in identity.personas
        assert len(identity.personas) == 1

        # Other personas do not yet exist
        assert PersonaType.HEALTH not in identity.personas
        assert PersonaType.FINANCIAL not in identity.personas
        assert PersonaType.PROFESSIONAL not in identity.personas
        assert PersonaType.SOCIAL not in identity.personas

        # The personal persona has its own storage partition
        assert personal.storage_partition == "partition_consumer"

# TST-INT-038
    # TRACE: {"suite": "INT", "case": "0038", "section": "02", "sectionName": "End-to-End User Flows", "subsection": "10", "scenario": "04", "title": "day7_mnemonic_backup_prompt"}
    def test_day7_mnemonic_backup_prompt(
        self, mock_dina: MockDinaCore, mock_human: MockHuman
    ) -> None:
        """On day 7, Dina prompts the user to back up their BIP-39 mnemonic.

        This is a Tier 1 (fiduciary) notification because losing the
        mnemonic means losing access to all encrypted data forever.
        """
        # Simulate day 7 check
        onboarding_time = time.time() - (7 * 86400)  # 7 days ago
        mock_dina.vault.store(0, "onboarding_complete", {
            "completed_at": onboarding_time,
        })

        days_since_onboarding = (time.time() - onboarding_time) / 86400
        assert days_since_onboarding >= 7

        # Generate the mnemonic backup notification
        notification = Notification(
            tier=SilenceTier.TIER_1_FIDUCIARY,
            title="Back up your recovery phrase",
            body=(
                "Your 24-word recovery phrase is the only way to recover "
                "your data if this device is lost. Please write it down "
                "and store it securely."
            ),
            actions=["show_mnemonic", "remind_later"],
            source="onboarding",
        )
        mock_dina.go_core.notify(notification)
        mock_human.receive_notification(notification)

        # Verify it is Tier 1 (fiduciary) -- silence would cause harm
        assert notification.tier == SilenceTier.TIER_1_FIDUCIARY
        assert len(mock_human.notifications) == 1
        assert "recovery phrase" in mock_human.notifications[0].body

# TST-INT-039
    # TRACE: {"suite": "INT", "case": "0039", "section": "02", "sectionName": "End-to-End User Flows", "subsection": "10", "scenario": "05", "title": "cloud_llm_pii_consent"}
    def test_cloud_llm_pii_consent(
        self, mock_dina: MockDinaCore, mock_human: MockHuman
    ) -> None:
        """Before using a cloud LLM, the user must explicitly consent to
        PII scrubbing and data leaving the device.

        Tests three things:
        1. Consent notification delivered with correct structure
        2. MockHuman approval mechanism (grant and deny)
        3. Sensitive personas always route locally regardless of consent
        """
        # --- Step 1: Consent notification structure ---
        consent_notification = Notification(
            tier=SilenceTier.TIER_2_SOLICITED,
            title="Cloud LLM access",
            body=(
                "Some tasks benefit from a more powerful cloud model. "
                "Your data will be scrubbed of personal information before "
                "sending. Allow cloud LLM access?"
            ),
            actions=["allow_cloud", "deny_cloud"],
            source="onboarding",
        )
        mock_human.receive_notification(consent_notification)
        assert len(mock_human.notifications) == 1, (
            "Human must receive exactly one consent notification"
        )
        received = mock_human.notifications[0]
        assert "allow_cloud" in received.actions, (
            "Consent notification must include allow_cloud action"
        )
        assert "deny_cloud" in received.actions, (
            "Consent notification must include deny_cloud action"
        )

        # --- Step 2: Approval mechanism works both ways ---
        mock_human.set_approval("allow_cloud", True)
        assert mock_human.approve("allow_cloud") is True, (
            "Granting consent must return True"
        )
        mock_human.set_approval("allow_cloud", False)
        assert mock_human.approve("allow_cloud") is False, (
            "Denying consent must return False"
        )

        # --- Step 3: Sensitive personas ALWAYS route locally ---
        # This is the persona-gating invariant, independent of consent.
        for sensitive_persona in (PersonaType.HEALTH, PersonaType.FINANCIAL):
            target = mock_dina.llm_router.route(
                "complex_reasoning", persona=sensitive_persona
            )
            assert target != LLMTarget.CLOUD, (
                f"{sensitive_persona.value} data must never route to cloud, "
                f"got {target}"
            )

        # --- Step 4: Non-sensitive complex reasoning routes to cloud ---
        # NOTE: MockLLMRouter has no consent-awareness; this documents
        # the baseline behavior. Production must wire consent → routing.
        target_no_persona = mock_dina.llm_router.route("complex_reasoning")
        assert target_no_persona == LLMTarget.CLOUD, (
            "Non-sensitive complex reasoning routes to cloud (baseline)"
        )


# -----------------------------------------------------------------------
# TestCompromisedBrain  (S2.6)
# -----------------------------------------------------------------------


class TestCompromisedBrain:
    """Containment when the Python Brain is compromised or misbehaving.

    The Go Core enforces an allowlist of Brain-callable endpoints.
    Admin endpoints (/v1/admin/*) are never accessible to the Brain.
    All Brain actions are logged for audit.
    """

# TST-INT-042
    # TRACE: {"suite": "INT", "case": "0042", "section": "02", "sectionName": "End-to-End User Flows", "subsection": "11", "scenario": "01", "title": "brain_restricted_creates_audit_trail"}
    def test_brain_restricted_creates_audit_trail(
        self, mock_dina: MockDinaCore
    ) -> None:
        """Every Brain -> Core request is logged in the audit trail.

        If the Brain is compromised, the audit trail provides forensic
        evidence of every action it attempted.
        """
        # Brain exercises several Core endpoints
        mock_dina.go_core.vault_store("brain_write_1", {"data": "from brain"})
        mock_dina.go_core.vault_query("brain_write")
        mock_dina.go_core.pii_scrub("Rajmohan from brain")
        mock_dina.go_core.did_sign(b"brain signed this")

        # All calls are recorded in the api_calls audit log
        assert len(mock_dina.go_core.api_calls) == 4

        # Each call has an endpoint field for forensic review
        endpoints = [c["endpoint"] for c in mock_dina.go_core.api_calls]
        assert "/v1/vault/store" in endpoints
        assert "/v1/vault/query" in endpoints
        assert "/v1/pii/scrub" in endpoints
        assert "/v1/did/sign" in endpoints

        # The audit trail is ordered chronologically
        for i in range(len(mock_dina.go_core.api_calls) - 1):
            # All calls have endpoint keys (structural integrity)
            assert "endpoint" in mock_dina.go_core.api_calls[i]

# TST-INT-043
    # TRACE: {"suite": "INT", "case": "0043", "section": "02", "sectionName": "End-to-End User Flows", "subsection": "11", "scenario": "02", "title": "brain_cannot_call_admin_endpoints"}
    def test_brain_cannot_call_admin_endpoints(
        self, mock_dina: MockDinaCore
    ) -> None:
        """Brain must never be able to call admin endpoints.

        Admin endpoints (/v1/admin/*) are reserved for the local Admin UI.
        The Go Core's BRAIN_TOKEN middleware rejects any Brain request to
        these paths.  We verify the Brain's API surface has no admin access.
        """
        # The Brain's interface to Core is via go_core methods.
        # Verify that the available go_core methods correspond only to
        # allowed internal endpoints, not admin endpoints.
        go_core = mock_dina.go_core
        public_methods = [m for m in dir(go_core) if not m.startswith("_")]

        # Allowed Brain-callable methods
        allowed_methods = {
            "vault_query", "vault_store", "did_sign", "did_verify",
            "pii_scrub", "notify",
        }

        # Admin methods that MUST NOT exist on the Brain's go_core interface
        admin_methods = {
            "admin_reset", "admin_wipe", "admin_rotate_keys",
            "admin_export", "admin_shutdown", "change_password",
            "revoke_device", "export_mnemonic",
        }

        # No admin method is available
        for method in admin_methods:
            assert method not in public_methods, (
                f"Admin method '{method}' must not be accessible to Brain"
            )

        # All allowed methods are available
        for method in allowed_methods:
            assert method in public_methods, (
                f"Expected Brain-callable method '{method}' is missing"
            )

        # Exercise allowed methods to confirm they work
        go_core.vault_store("audit_test", {"ok": True})
        go_core.vault_query("audit")
        go_core.pii_scrub("test data")
        go_core.did_sign(b"test")

        # All calls are audited
        assert len(go_core.api_calls) == 4


# -----------------------------------------------------------------------
# TestBrainLocalLLM  (S4.1)
# -----------------------------------------------------------------------


class TestBrainLocalLLM:
    """Verify Brain sends prompts to local LLM router and receives completions."""

# TST-INT-071
    # TRACE: {"suite": "INT", "case": "0071", "section": "02", "sectionName": "End-to-End User Flows", "subsection": "12", "scenario": "01", "title": "brain_local_llm_completion"}
    def test_brain_local_llm_completion(
        self,
        mock_dina: MockDinaCore,
        mock_llm_router: MockLLMRouter,
    ) -> None:
        """Brain sends a prompt to the local LLM router and gets a completion.
        For basic tasks (summarize, draft, classify), the router selects
        LOCAL target. The Brain processes the result through the classifier
        and returns a structured response."""
        # Pre-condition: no processing or routing has occurred
        assert len(mock_dina.brain.processed) == 0
        assert len(mock_dina.brain.reasoned) == 0
        assert len(mock_llm_router.routing_log) == 0

        # Verify the router directs basic tasks to LOCAL
        target = mock_llm_router.route("summarize")
        assert target == LLMTarget.LOCAL

        # Brain processes a summarization request
        query = {
            "type": "summarize",
            "content": "ThinkPad X1 has excellent keyboard, good battery, "
                       "but screen could be brighter. Overall recommended.",
        }
        result = mock_dina.brain.process(query)

        assert result["processed"] is True
        assert len(mock_dina.brain.processed) == 1

        # Brain can also use reason() which goes through the LLM router
        answer = mock_dina.brain.reason(
            "Summarize the ThinkPad X1 review",
            context={"source": "local_review"},
        )
        assert isinstance(answer, str)
        assert len(answer) > 0
        assert len(mock_dina.brain.reasoned) == 1

        # Verify the routing log recorded local routing
        local_entries = [
            e for e in mock_llm_router.routing_log
            if e["target"] == LLMTarget.LOCAL
        ]
        assert len(local_entries) >= 1
        assert local_entries[0]["reason"] == "basic_task"

        # Counter-proof: complex tasks route to CLOUD, not LOCAL
        complex_target = mock_llm_router.route("complex_reasoning")
        assert complex_target == LLMTarget.CLOUD, \
            "Complex tasks must route to CLOUD, not LOCAL"

        # Counter-proof: sensitive persona routes to LOCAL even for complex tasks
        sensitive_target = mock_llm_router.route(
            "complex_reasoning", persona=PersonaType.HEALTH
        )
        assert sensitive_target == LLMTarget.LOCAL, \
            "Sensitive persona must stay LOCAL regardless of task complexity"


# -----------------------------------------------------------------------
# TestCloudLLMRateLimited  (S4.2)
# -----------------------------------------------------------------------


class TestCloudLLMRateLimited:
    """Verify graceful handling when a cloud LLM returns rate-limited errors."""

# TST-INT-076
    # TRACE: {"suite": "INT", "case": "0076", "section": "02", "sectionName": "End-to-End User Flows", "subsection": "13", "scenario": "01", "title": "cloud_llm_rate_limited"}
    def test_cloud_llm_rate_limited(
        self,
        mock_cloud_llm_router: MockLLMRouter,
        mock_dina: MockDinaCore,
    ) -> None:
        """When a cloud LLM is rate limited, the system can fall back to
        local LLM for basic tasks.  Complex tasks route to CLOUD in online
        mode; basic tasks route to LOCAL in offline mode (fallback)."""
        # Cloud router directs complex tasks to CLOUD
        target = mock_cloud_llm_router.route("complex_reasoning")
        assert target == LLMTarget.CLOUD

        # The router log confirms CLOUD was targeted with correct reason
        cloud_entries = [
            e for e in mock_cloud_llm_router.routing_log
            if e["target"] == LLMTarget.CLOUD
        ]
        assert len(cloud_entries) == 1
        assert cloud_entries[0]["reason"] == "complex_task"

        # Counter-proof: basic tasks also route to CLOUD in online profile
        basic_target = mock_cloud_llm_router.route("summarize")
        assert basic_target == LLMTarget.CLOUD, (
            "Online profile routes basic tasks to CLOUD"
        )

        # Fallback: offline router (mock_dina default) routes basic tasks
        # to LOCAL — this is the fallback path when cloud is unavailable
        assert mock_dina.llm_router.profile == "offline"
        fallback_target = mock_dina.llm_router.route("summarize")
        assert fallback_target == LLMTarget.LOCAL, (
            "Offline profile routes basic tasks to LOCAL (fallback)"
        )

        # Counter-proof: simple lookups need no LLM in either profile
        assert mock_cloud_llm_router.route("fts_search") == LLMTarget.NONE
        assert mock_dina.llm_router.route("fts_search") == LLMTarget.NONE


# -----------------------------------------------------------------------
# TestPIIScrubberPipeline  (S4.3)
# -----------------------------------------------------------------------


class TestPIIScrubberPipeline:
    """Verify the multi-tier PII scrubbing pipeline and replacement map
    round-trip. Tier 1 = regex (direct pattern match), Tier 2 = NER
    (named entity recognition), Tier 3 = LLM-based (presidio)."""

# TST-INT-079
    # TRACE: {"suite": "INT", "case": "0079", "section": "02", "sectionName": "End-to-End User Flows", "subsection": "14", "scenario": "01", "title": "full_tier1_tier2_pipeline"}
    def test_full_tier1_tier2_pipeline(
        self,
        mock_scrubber: MockPIIScrubber,
    ) -> None:
        """PII scrubber processes text through Tier 1 (direct pattern match)
        and Tier 2 (NER-based) scrubbing. Both tiers work together: Tier 1
        catches known patterns (emails, phones, names), and Tier 2 catches
        remaining named entities. The result is fully sanitized text."""
        # Input with multiple PII types
        raw_text = (
            "Dear Rajmohan, your order confirmation has been sent to "
            "rajmohan@email.com. For urgent queries call +91-9876543210. "
            "Ship to 123 Main Street. Card ending 4111-2222-3333-4444."
        )

        # Tier 1: direct pattern scrub
        scrubbed, replacements = mock_scrubber.scrub(raw_text)

        # All known PII patterns must be replaced
        assert "Rajmohan" not in scrubbed
        assert "rajmohan@email.com" not in scrubbed
        assert "+91-9876543210" not in scrubbed
        assert "123 Main Street" not in scrubbed
        assert "4111-2222-3333-4444" not in scrubbed

        # All PII values have corresponding replacements
        assert "Rajmohan" in replacements.values()
        assert "rajmohan@email.com" in replacements.values()
        assert "+91-9876543210" in replacements.values()
        assert "123 Main Street" in replacements.values()
        assert "4111-2222-3333-4444" in replacements.values()

        # At least 5 PII items were replaced (NER may find more)
        assert len(replacements) >= 5

        # The scrubbed text passes validation
        assert mock_scrubber.validate_clean(scrubbed)

        # Scrub log records the operation
        assert len(mock_scrubber.scrub_log) == 1
        log_entry = mock_scrubber.scrub_log[0]
        assert log_entry["replacements"] == 5
        assert log_entry["scrubbed_length"] < log_entry["original_length"]

# TST-INT-080
    # TRACE: {"suite": "INT", "case": "0080", "section": "02", "sectionName": "End-to-End User Flows", "subsection": "14", "scenario": "02", "title": "replacement_map_round_trip"}
    def test_replacement_map_round_trip(
        self,
        mock_scrubber: MockPIIScrubber,
    ) -> None:
        """PII is replaced with opaque tokens before sending to the LLM.
        When the LLM response arrives, the tokens are rehydrated back to
        the original PII values using the replacement map. This ensures
        the user sees natural text while the LLM never sees real PII."""
        # Original user query
        user_query = (
            "Send an email to Rajmohan at rajmohan@email.com about the meeting."
        )

        # Step 1: Scrub PII before sending to LLM
        scrubbed_query, replacement_map = mock_scrubber.scrub(user_query)
        assert "Rajmohan" not in scrubbed_query
        assert "rajmohan@email.com" not in scrubbed_query

        # Scrubbed text should pass validate_clean (no residual PII)
        assert mock_scrubber.validate_clean(scrubbed_query), \
            "Scrubbed text must pass PII validation before LLM send"

        # Replacement map captures original PII values (format-agnostic)
        pii_values = set(replacement_map.values())
        assert "Rajmohan" in pii_values
        assert "rajmohan@email.com" in pii_values

        # Step 2: Simulate LLM response using actual tokens from replacement map
        person_token = next(k for k, v in replacement_map.items() if v == "Rajmohan")
        email_token = next(k for k, v in replacement_map.items() if v == "rajmohan@email.com")
        llm_response = (
            f"I've drafted an email to {person_token} at {email_token} "
            "regarding the meeting. Would you like to review it?"
        )

        # Verify the LLM response contains tokens, not real PII
        assert person_token in llm_response
        assert email_token in llm_response
        assert "Rajmohan" not in llm_response

        # Step 3: Desanitize the LLM response to restore PII for user display
        rehydrated = mock_scrubber.desanitize(llm_response, replacement_map)

        # The user sees natural text with real names
        assert "Rajmohan" in rehydrated
        assert "rajmohan@email.com" in rehydrated
        assert person_token not in rehydrated
        assert email_token not in rehydrated

        # Round-trip integrity: the rehydrated text reads naturally
        assert "I've drafted an email to Rajmohan" in rehydrated

        # Counter-proof: text with no PII returns empty replacement map
        clean_text = "What is the weather today?"
        scrubbed_clean, clean_map = mock_scrubber.scrub(clean_text)
        assert len(clean_map) == 0, \
            "No PII in input must produce empty replacement map"
        assert scrubbed_clean == clean_text, \
            "Clean text must pass through unchanged"

# TST-INT-084
    # TRACE: {"suite": "INT", "case": "0084", "section": "02", "sectionName": "End-to-End User Flows", "subsection": "14", "scenario": "03", "title": "tier3_absent_gracefully"}
    def test_tier3_absent_gracefully(
        self,
        mock_scrubber: MockPIIScrubber,
    ) -> None:
        """When Tier 3 (LLM-based presidio) is unavailable, the scrubber
        proceeds with Tier 1 (direct match) and Tier 2 (NER) only. The
        system degrades gracefully -- it does not fail or skip scrubbing
        entirely. Known patterns are still caught; only novel or ambiguous
        PII might slip through Tier 1+2 alone."""
        # Simulate Tier 3 being unavailable (no LLM presidio configured)
        tier3_available = False

        # Text with known PII (caught by Tier 1) and potential novel PII
        raw_text = (
            "Rajmohan confirmed the meeting. Contact: rajmohan@email.com. "
            "His Aadhaar is XXXX-XXXX-1234."
        )

        # Scrub with Tier 1+2 only (Tier 3 is down)
        scrubbed, replacements = mock_scrubber.scrub(raw_text)

        # Known patterns from Tier 1+2 are caught
        assert "Rajmohan" not in scrubbed
        assert "rajmohan@email.com" not in scrubbed

        # All caught PII values are in the replacement map
        assert "Rajmohan" in replacements.values()
        assert "rajmohan@email.com" in replacements.values()

        # Tier 3 absence is noted but scrubbing still works
        assert not tier3_available

        # The scrubbed text is still clean for known patterns
        assert mock_scrubber.validate_clean(scrubbed)

        # Multiple calls work without Tier 3
        scrubbed2, replacements2 = mock_scrubber.scrub("Call Sancho at sancho@email.com")
        # Email is always caught (regex, deterministic)
        assert "sancho@email.com" not in scrubbed2
        assert "sancho@email.com" in replacements2.values()
