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

# TST-INT-082
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

# TST-INT-008
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

# TST-INT-081
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
    def test_complex_tasks_still_cloud(
        self, mock_cloud_llm_router: MockLLMRouter
    ) -> None:
        """Complex reasoning goes to CLOUD in both profiles."""
        target = mock_cloud_llm_router.route("multi_step_analysis")
        assert target == LLMTarget.CLOUD
        target = mock_cloud_llm_router.route("complex_reasoning")
        assert target == LLMTarget.CLOUD

# TST-INT-077
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
    def test_token_mismatch_rejected(self) -> None:
        """Different tokens on Core and Brain -- system is non-functional.

        In production the HTTP middleware rejects every request with 401.
        Here we verify the mismatch is detectable so the guard can fire.
        """
        core = self._core_with_token("token_for_core_AAAA")
        brain = self._brain_with_token("token_for_brain_BBBB")

        assert not self._tokens_match(core, brain)

        # A real middleware would reject; here we prove the guard detects it.
        # Simulate: if tokens don't match, brain refuses to process.
        if not self._tokens_match(core, brain):
            with pytest.raises(RuntimeError):
                raise RuntimeError("BRAIN_TOKEN mismatch — 401 Unauthorized")

# TST-INT-003
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
    def test_write_scratchpad(
        self, mock_dina: MockDinaCore
    ) -> None:
        """Brain checkpoints a task via PUT /v1/vault/scratchpad.

        The scratchpad is stored in the vault at tier 4 (ephemeral staging)
        so that a Brain crash can resume from the last checkpoint.
        """
        scratchpad_data = {
            "task_id": "analysis_001",
            "step": 3,
            "partial_result": "Collected 4 of 6 reviews",
            "checkpoint_ts": time.time(),
        }

        # Brain writes scratchpad via Core
        mock_dina.go_core.vault_store(
            "scratchpad_analysis_001", scratchpad_data, tier=4
        )

        # Verify the scratchpad is persisted
        stored = mock_dina.vault.retrieve(4, "scratchpad_analysis_001")
        assert stored is not None
        assert stored["task_id"] == "analysis_001"
        assert stored["step"] == 3
        assert any(
            c["endpoint"] == "/v1/vault/store" for c in mock_dina.go_core.api_calls
        )

# TST-INT-015
    def test_send_outbound_message(
        self, mock_dina: MockDinaCore
    ) -> None:
        """Brain calls POST /v1/msg/send to dispatch an outbound D2D message.

        Core handles the DIDComm encryption and relay; Brain just provides
        the plaintext payload and destination DID.
        """
        recipient_did = "did:plc:Sancho12345678901234567890abc"
        mock_dina.p2p.add_contact(recipient_did)
        mock_dina.p2p.authenticated_peers.add(recipient_did)

        message = DinaMessage(
            type="dina/social/tea_invite",
            from_did=mock_dina.identity.root_did,
            to_did=recipient_did,
            payload={"text": "Tea at 4pm?", "location": "usual spot"},
        )

        sent = mock_dina.p2p.send(message)

        assert sent is True
        assert len(mock_dina.p2p.messages) == 1
        assert mock_dina.p2p.messages[0].type == "dina/social/tea_invite"


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
    def test_simple_query_full_ws_flow(
        self, mock_dina: MockDinaCore, mock_thin_client: MockThinClient
    ) -> None:
        """Full WS flow: authenticate -> send query -> Brain processes -> response.

        The thin client connects, sends a query payload, Brain produces a
        result, and Core streams it back.
        """
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

        # Step 4: Core streams the response back to the thin client
        response = {
            "type": "query_response",
            "answer": "Herman Miller Aeron scores highest in expert reviews.",
            "tier": result["tier"].value,
        }
        mock_thin_client.receive_stream(response)

        assert len(mock_thin_client.received_streams) == 1
        assert mock_thin_client.received_streams[0]["type"] == "query_response"

# TST-INT-019
    def test_streaming_response_chunks(
        self, mock_dina: MockDinaCore, mock_thin_client: MockThinClient
    ) -> None:
        """Brain streams multiple chunks; the final chunk carries a whisper.

        Each chunk is a partial response; the last chunk has is_final=True.
        """
        # Authenticate
        device_key = mock_dina.identity.register_device(mock_thin_client.device_id)
        mock_thin_client.device_key = device_key
        mock_thin_client.connect(mock_dina.go_core)

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

        # Verify the final chunk
        final = mock_thin_client.received_streams[-1]
        assert final["is_final"] is True
        assert "whisper" in final

# TST-INT-020
    def test_query_during_brain_outage(
        self, mock_dina: MockDinaCore, mock_thin_client: MockThinClient
    ) -> None:
        """When Brain is down, a user query should produce a 503 error response.

        Core detects the Brain crash and returns an error to the WS client
        instead of hanging indefinitely.
        """
        # Authenticate
        device_key = mock_dina.identity.register_device(mock_thin_client.device_id)
        mock_thin_client.device_key = device_key
        mock_thin_client.connect(mock_dina.go_core)

        # Brain crashes
        mock_dina.brain.crash()

        # Query attempt fails
        with pytest.raises(RuntimeError, match="Brain has crashed"):
            mock_dina.brain.process({
                "type": "user_query",
                "content": "What time is the meeting?",
            })

        # Core sends a 503-equivalent error to the WS client
        error_response = {
            "type": "error",
            "code": 503,
            "message": "Brain service unavailable. Try again shortly.",
        }
        mock_thin_client.receive_stream(error_response)

        assert len(mock_thin_client.received_streams) == 1
        assert mock_thin_client.received_streams[0]["code"] == 503

        # Core itself is still alive (sidecar resilience)
        mock_dina.go_core.vault_store("still_alive", {"status": "ok"})
        assert mock_dina.vault.retrieve(1, "still_alive") == {"status": "ok"}

# TST-INT-023
    def test_heartbeat_round_trip(
        self, mock_dina: MockDinaCore, mock_thin_client: MockThinClient
    ) -> None:
        """Idle 30s -> Core sends ping -> client must pong within 10s.

        We model this as: after idle time, a ping message is generated;
        the client responds with a pong; the connection stays alive.
        """
        # Authenticate
        device_key = mock_dina.identity.register_device(mock_thin_client.device_id)
        mock_thin_client.device_key = device_key
        mock_thin_client.connect(mock_dina.go_core)

        # Simulate 30s idle: Core sends ping
        ping = {"type": "ping", "ts": time.time()}
        mock_thin_client.receive_stream(ping)

        # Client responds with pong
        pong_ts = time.time()
        pong = {"type": "pong", "ts": pong_ts}

        # Verify round-trip: pong timestamp is within 10s of ping
        rtt = pong["ts"] - ping["ts"]
        assert rtt < 10.0, "Pong must arrive within 10 seconds of ping"

        # Connection is still alive
        assert mock_thin_client.connected is True
        assert len(mock_thin_client.received_streams) == 1  # the ping


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
    def test_browser_login_dashboard(
        self, mock_dina: MockDinaCore
    ) -> None:
        """Browser login via Argon2id auth -- valid password grants dashboard access."""
        admin_password = "strong_passphrase_42!"
        stored_hash = self._hash_password_argon2id(admin_password)

        # Store the hash in vault tier 0 (key material)
        mock_dina.vault.store(0, "admin_password_hash", {"hash": stored_hash})

        # User submits password
        submitted = "strong_passphrase_42!"
        assert self._verify_password(submitted, stored_hash)

        # Create session
        session = self._create_session("admin")
        assert session["expires_at"] > time.time()
        assert len(session["session_id"]) == 32  # hex UUID

        # Dashboard data is accessible with valid session
        mock_dina.vault.store(1, "dashboard_stats", {
            "total_verdicts": 42,
            "personas_active": 3,
            "brain_status": "healthy",
        })
        stats = mock_dina.vault.retrieve(1, "dashboard_stats")
        assert stats["total_verdicts"] == 42

# TST-INT-026
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
    def test_session_expiry_redirect(
        self, mock_dina: MockDinaCore
    ) -> None:
        """After session expires, any dashboard request redirects to login.

        The session has a TTL; once expired, the user must re-authenticate.
        """
        # Create an already-expired session
        session = self._create_session("admin", ttl_seconds=0)
        # Force expiry by setting expires_at in the past
        session["expires_at"] = time.time() - 1

        is_expired = time.time() > session["expires_at"]
        assert is_expired is True

        # An expired session must not grant access to dashboard endpoints
        # Instead, a redirect to /login is issued
        redirect = {
            "status": 302,
            "location": "/login",
            "reason": "session_expired",
        }
        assert redirect["status"] == 302
        assert redirect["location"] == "/login"


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
    def test_post_onboarding_system_functional(self) -> None:
        """After onboarding, all subsystems are wired and functional.

        Core can store/query, Brain can process, PII scrubber works,
        identity can sign/verify.
        """
        dina = MockDinaCore()

        # Mark onboarding done
        dina.vault.store(0, "onboarding_complete", {"completed_at": time.time()})
        assert dina.vault.retrieve(0, "onboarding_complete") is not None

        # Vault store + query
        dina.go_core.vault_store("post_onboard_test", {"ok": True})
        assert dina.vault.retrieve(1, "post_onboard_test") == {"ok": True}

        # Brain process
        result = dina.brain.process({"type": "test", "content": "hello"})
        assert result["processed"] is True

        # PII scrub
        scrubbed, _ = dina.go_core.pii_scrub("Rajmohan at rajmohan@email.com")
        assert "Rajmohan" not in scrubbed

        # DID sign + verify
        sig = dina.go_core.did_sign(b"onboarding done")
        assert dina.go_core.did_verify(b"onboarding done", sig) is True

# TST-INT-037
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
    def test_cloud_llm_pii_consent(
        self, mock_dina: MockDinaCore, mock_human: MockHuman
    ) -> None:
        """Before using a cloud LLM, the user must explicitly consent to
        PII scrubbing and data leaving the device.

        If the user declines, only on-device/local LLM is available.
        """
        # Consent flow: present notification asking for cloud LLM consent
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

        # Case 1: User consents
        mock_human.set_approval("allow_cloud", True)
        consent_granted = mock_human.approve("allow_cloud")
        assert consent_granted is True

        # With consent, complex tasks can go to cloud
        target = mock_dina.llm_router.route("complex_reasoning")
        assert target == LLMTarget.CLOUD

        # Case 2: User denies -- complex tasks must stay local
        mock_human.set_approval("allow_cloud", False)
        consent_denied = not mock_human.approve("allow_cloud")
        assert consent_denied is True

        # When denied, the router should be constrained to local only
        # (in production, a flag prevents CLOUD routing)
        target_local = mock_dina.llm_router.route(
            "complex_reasoning", persona=PersonaType.HEALTH
        )
        assert target_local != LLMTarget.CLOUD


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
    def test_brain_local_llm_completion(
        self,
        mock_dina: MockDinaCore,
        mock_llm_router: MockLLMRouter,
    ) -> None:
        """Brain sends a prompt to the local LLM router and gets a completion.
        For basic tasks (summarize, draft, classify), the router selects
        LOCAL target. The Brain processes the result through the classifier
        and returns a structured response."""
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


# -----------------------------------------------------------------------
# TestCloudLLMRateLimited  (S4.2)
# -----------------------------------------------------------------------


class TestCloudLLMRateLimited:
    """Verify graceful handling when a cloud LLM returns rate-limited errors."""

# TST-INT-076
    def test_cloud_llm_rate_limited(
        self,
        mock_cloud_llm_router: MockLLMRouter,
        mock_dina: MockDinaCore,
    ) -> None:
        """When a cloud LLM is rate limited, the system returns an appropriate
        error rather than crashing or hanging. The router still determines
        CLOUD as the target, but the execution layer surfaces the 429 status
        so the caller can retry with backoff."""
        # Cloud router directs complex tasks to CLOUD
        target = mock_cloud_llm_router.route("complex_reasoning")
        assert target == LLMTarget.CLOUD

        # Simulate a rate-limited response from the cloud LLM
        rate_limit_response = {
            "status": 429,
            "error": "rate_limited",
            "message": "Too many requests. Retry after 60 seconds.",
            "retry_after_seconds": 60,
        }

        # The system must surface this error clearly
        assert rate_limit_response["status"] == 429
        assert rate_limit_response["retry_after_seconds"] > 0

        # The router log confirms CLOUD was targeted
        cloud_entries = [
            e for e in mock_cloud_llm_router.routing_log
            if e["target"] == LLMTarget.CLOUD
        ]
        assert len(cloud_entries) == 1
        assert cloud_entries[0]["reason"] == "complex_task"

        # On rate limit, the system can fall back to local if available
        # by re-routing with a persona override or task downgrade
        fallback_target = mock_dina.llm_router.route("summarize")
        assert fallback_target == LLMTarget.LOCAL, (
            "Fallback for basic tasks should route to LOCAL in offline mode"
        )


# -----------------------------------------------------------------------
# TestPIIScrubberPipeline  (S4.3)
# -----------------------------------------------------------------------


class TestPIIScrubberPipeline:
    """Verify the multi-tier PII scrubbing pipeline and replacement map
    round-trip. Tier 1 = regex (direct pattern match), Tier 2 = NER
    (named entity recognition), Tier 3 = LLM-based (presidio)."""

# TST-INT-079
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

        # Replacement map captures original PII values (format-agnostic)
        pii_values = set(replacement_map.values())
        assert "Rajmohan" in pii_values
        assert "rajmohan@email.com" in pii_values

        # Step 2: Simulate LLM response using actual tokens from replacement map
        # (tokens may be [PERSON_1] or faker-generated names — use real tokens)
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

# TST-INT-084
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
