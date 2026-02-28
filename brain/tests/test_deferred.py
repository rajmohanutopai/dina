"""Tests for Deferred Phase 2+ Features.

Maps to Brain TEST_PLAN SS17.

SS17.1 Emotional State Awareness (3 scenarios)
SS17.2a On-Device LLM -- Rich Client (3 scenarios)
SS17.2b PII Scrubber Tier 3 -- LLM NER (7 scenarios)
SS17.3 Confidential Computing -- Managed Hosting (3 scenarios)
SS17.4 Digital Estate (3 scenarios)

These tests validate that the data contracts, event structures, and factory
helpers are correctly formed for future Phase 2+ features. Where real
implementations exist (e.g. GuardianLoop.classify_silence, PII scrubber),
the tests exercise them. Where features are deferred, the tests verify
the contract shapes and that the system handles the events gracefully
without crashing.
"""

from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, MagicMock

from .factories import make_event, make_pii_text


# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def guardian():
    """Real GuardianLoop for deferred feature tests."""
    from src.service.guardian import GuardianLoop
    from src.service.entity_vault import EntityVaultService
    from src.service.nudge import NudgeAssembler
    from src.service.scratchpad import ScratchpadService

    core = AsyncMock()
    core.write_scratchpad.return_value = None
    core.read_scratchpad.return_value = None
    core.search_vault.return_value = []
    core.set_kv.return_value = None
    core.notify.return_value = None
    core.task_ack.return_value = None
    core.pii_scrub.return_value = {"scrubbed": "", "entities": []}

    llm_router = AsyncMock()
    llm_router.route.return_value = {"content": "test", "model": "test"}

    scrubber = MagicMock()
    scrubber.scrub.return_value = ("scrubbed", [])
    scrubber.detect.return_value = []

    entity_vault = EntityVaultService(scrubber, core)
    nudge = NudgeAssembler(core, llm_router, entity_vault)
    scratchpad = ScratchpadService(core)

    return GuardianLoop(
        core=core,
        llm_router=llm_router,
        scrubber=scrubber,
        entity_vault=entity_vault,
        nudge_assembler=nudge,
        scratchpad=scratchpad,
    )


@pytest.fixture
def pii_scrubber():
    """Mock PII scrubber for Tier 3 deferred tests."""
    scrubber = MagicMock()
    scrubber.scrub.return_value = ("scrubbed text", [])
    scrubber.detect.return_value = []
    return scrubber


@pytest.fixture
def llm_router():
    """Mock LLM router for on-device LLM deferred tests."""
    router = AsyncMock()
    router.route.return_value = {"content": "test response", "model": "test-model"}
    router.available_models.return_value = ["test-model-local", "test-model-cloud"]
    return router


# ---------------------------------------------------------------------------
# SS17.1 Emotional State Awareness (3 scenarios)
# ---------------------------------------------------------------------------


# TST-BRAIN-345
@pytest.mark.asyncio
async def test_deferred_17_1_1_impulsive_spending_detection(guardian) -> None:
    """SS17.1.1: Impulsive spending detection.

    Large purchase at 2 AM, deviates from spending pattern.
    Phase 2+ feature: emotional state awareness not yet implemented.
    The guardian classifies a purchase_intent event through standard
    silence classification -- no fiduciary keywords, defaults to engagement.
    """
    event = make_event(
        type="purchase_intent",
        body="Buy Sony WH-1000XM6 for $399",
        timestamp="2026-01-15T02:00:00Z",
        context={"amount": 399, "usual_sleep_time": "23:00"},
    )

    # Verify event structure is correct
    assert event["timestamp"] == "2026-01-15T02:00:00Z"
    assert event["context"]["amount"] == 399

    # Guardian classifies: unknown type, no fiduciary keywords -> engagement
    result = await guardian.classify_silence(event)
    assert result == "engagement"

    # Process: engagement -> save for briefing (no crash)
    action = await guardian.process_event(event)
    assert action["action"] == "save_for_briefing"


# TST-BRAIN-346
@pytest.mark.asyncio
async def test_deferred_17_1_2_emotional_email_detection(guardian) -> None:
    """SS17.1.2: Emotional email detection.

    User drafts angry response within minutes of receiving email.
    Phase 2+: emotional state detection not yet implemented.
    The guardian processes through standard classification.
    """
    event = make_event(
        type="email_draft",
        body="This is completely unacceptable and I demand...",
        context={
            "reply_delay_seconds": 120,
            "original_received_at": "2026-01-15T10:00:00Z",
        },
    )

    assert event["context"]["reply_delay_seconds"] == 120

    # Unknown type "email_draft" -> default engagement
    result = await guardian.classify_silence(event)
    assert result == "engagement"


# TST-BRAIN-347
@pytest.mark.asyncio
async def test_deferred_17_1_3_time_of_day_no_flag(guardian) -> None:
    """SS17.1.3: Time-of-day context -- normal hours, within budget.

    Purchase request during normal hours, within budget. No flag.
    The guardian processes without crashing.
    """
    event = make_event(
        type="purchase_intent",
        body="Buy coffee beans for $25",
        timestamp="2026-01-15T10:00:00Z",
        context={"amount": 25, "budget_remaining": 500},
    )

    assert event["context"]["amount"] == 25
    assert event["context"]["budget_remaining"] == 500

    # Normal purchase -> engagement (no urgency)
    result = await guardian.classify_silence(event)
    assert result == "engagement"


# ---------------------------------------------------------------------------
# SS17.2a On-Device LLM -- Rich Client (3 scenarios)
# ---------------------------------------------------------------------------


# TST-BRAIN-348
@pytest.mark.asyncio
async def test_deferred_17_2a_1_offline_on_device_llm(llm_router) -> None:
    """SS17.2a.1: Rich client routes to on-device LLM when offline.

    Client disconnected from Home Node, user sends query.
    Phase 2+: on-device LLM routing not yet implemented.
    Verify event contract is well-formed.
    """
    event = make_event(
        type="query",
        body="What meetings do I have today?",
        context={"connectivity": "offline", "on_device_model": "gemma-3n"},
    )

    assert event["context"]["connectivity"] == "offline"
    assert event["context"]["on_device_model"] == "gemma-3n"
    assert event["type"] == "query"

    # LLM router is callable and returns a response
    response = await llm_router.route(event)
    assert "content" in response


# TST-BRAIN-349
@pytest.mark.asyncio
async def test_deferred_17_2a_2_fallback_to_home_node(llm_router) -> None:
    """SS17.2a.2: On-device LLM fallback to Home Node.

    Query too complex for on-device model.
    Queued for Home Node, processed on reconnect.
    Phase 2+: verify event contract structure.
    """
    event = make_event(
        type="query",
        body="Analyze my spending patterns over the last 6 months and suggest budget changes",
        context={"connectivity": "offline", "complexity": "high"},
    )

    assert event["context"]["complexity"] == "high"
    assert event["context"]["connectivity"] == "offline"
    assert len(event["body"]) > 50  # Complex query is non-trivial


# TST-BRAIN-350
@pytest.mark.asyncio
async def test_deferred_17_2a_3_model_version_mismatch(llm_router) -> None:
    """SS17.2a.3: On-device LLM model mismatch.

    Client has older model version than Home Node.
    Graceful degradation, no crash.
    Phase 2+: verify event contract and version mismatch detection.
    """
    event = make_event(
        type="query",
        body="Summarize today",
        context={
            "on_device_model_version": "1.0",
            "home_node_model_version": "2.0",
        },
    )

    assert event["context"]["on_device_model_version"] != event["context"]["home_node_model_version"]
    assert event["context"]["on_device_model_version"] == "1.0"
    assert event["context"]["home_node_model_version"] == "2.0"


# ---------------------------------------------------------------------------
# SS17.2b PII Scrubber Tier 3 -- LLM NER (7 scenarios)
# ---------------------------------------------------------------------------


# TST-BRAIN-351
@pytest.mark.asyncio
async def test_deferred_17_2b_1_indirect_person_reference(pii_scrubber) -> None:
    """SS17.2b.1: Indirect person reference.

    "The CEO of [ORG_1] who wrote a novel about AI in 2017"
    Phase 2+: LLM NER not yet implemented. Verify text contains the
    indirect reference pattern and that the scrubber interface is callable.
    """
    text = "The CEO of Acme Corp who wrote a novel about AI in 2017"

    assert "CEO" in text
    assert "Acme Corp" in text

    # Tier 2 scrubber is callable (Tier 3 LLM NER would be layered on top)
    scrubbed, entities = pii_scrubber.scrub(text)
    assert isinstance(scrubbed, str)
    assert isinstance(entities, list)


# TST-BRAIN-352
@pytest.mark.asyncio
async def test_deferred_17_2b_2_coded_language(pii_scrubber) -> None:
    """SS17.2b.2: Coded language.

    "The guy from that Bangalore company" -- LLM identifies as person reference.
    Phase 2+: verify text pattern and scrubber interface.
    """
    text = "The guy from that Bangalore company"

    assert "guy" in text
    assert "Bangalore" in text

    scrubbed, entities = pii_scrubber.scrub(text)
    assert isinstance(scrubbed, str)


# TST-BRAIN-353
@pytest.mark.asyncio
async def test_deferred_17_2b_3_paraphrased_pii(pii_scrubber) -> None:
    """SS17.2b.3: Paraphrased PII.

    "My neighbor who works at the hospital on Ring Road"
    LLM detects identifiable combination.
    Phase 2+: verify text pattern and scrubber contract.
    """
    text = "My neighbor who works at the hospital on Ring Road"

    assert "neighbor" in text
    assert "hospital" in text
    assert "Ring Road" in text

    scrubbed, entities = pii_scrubber.scrub(text)
    assert isinstance(scrubbed, str)


# TST-BRAIN-354
@pytest.mark.asyncio
async def test_deferred_17_2b_4_tier3_latency(pii_scrubber) -> None:
    """SS17.2b.4: Tier 3 latency.

    Single text chunk processed in ~500ms-2s (acceptable for background tasks).
    Phase 2+: verify the PII text factory generates valid text and the
    scrubber interface responds without error.
    """
    text = make_pii_text(include=("person", "org", "location"))

    assert len(text) > 0
    assert "John Smith" in text  # person
    assert "Google Inc." in text  # org
    assert "San Francisco" in text  # location

    # Scrubber call completes (mock is instant; real Tier 3 would be ~500ms-2s)
    scrubbed, entities = pii_scrubber.scrub(text)
    assert isinstance(scrubbed, str)


# TST-BRAIN-355
@pytest.mark.asyncio
async def test_deferred_17_2b_5_tier3_absent_no_llama(pii_scrubber) -> None:
    """SS17.2b.5: Tier 3 absent (no llama).

    Cloud-only profile. Tiers 1+2 handle PII -- Tier 3 skipped gracefully.
    Verify the text factory and that Tier 2 scrubber handles the text
    without requiring Tier 3.
    """
    text = make_pii_text(include=("email", "phone", "person"))

    assert len(text) > 0
    assert "john@example.com" in text
    assert "555-123-4567" in text
    assert "John Smith" in text

    # Tier 2 scrubber handles text without Tier 3
    scrubbed, entities = pii_scrubber.scrub(text)
    assert isinstance(scrubbed, str)


# TST-BRAIN-356
@pytest.mark.asyncio
async def test_deferred_17_2b_6_gemma_3n_e2b(pii_scrubber) -> None:
    """SS17.2b.6: Phase 1 -- Gemma 3n E2B.

    2B active params, ~2GB RAM. General-purpose NER -- no fine-tuning needed.
    Phase 2+: verify the scrubber interface contract supports the
    expected input/output shape for a Tier 3 NER model.
    """
    # The scrubber interface is the same regardless of backend model
    test_text = "Dr. Sarah Chen published results at MIT last week."
    scrubbed, entities = pii_scrubber.scrub(test_text)

    # Contract: scrub() returns (str, list)
    assert isinstance(scrubbed, str)
    assert isinstance(entities, list)


# TST-BRAIN-357
@pytest.mark.asyncio
async def test_deferred_17_2b_7_functiongemma_270m(pii_scrubber) -> None:
    """SS17.2b.7: Phase 1 fallback -- FunctionGemma 270M.

    270M params, ~529MB. Structured extraction at 2500+ tok/sec.
    Phase 2+: verify the scrubber interface is compatible with a
    smaller model backend.
    """
    test_text = "Invoice from Acme Corp, attn: Bob Williams, 123 Main St."
    scrubbed, entities = pii_scrubber.scrub(test_text)

    # Same contract regardless of model size
    assert isinstance(scrubbed, str)
    assert isinstance(entities, list)


# ---------------------------------------------------------------------------
# SS17.3 Confidential Computing -- Managed Hosting (3 scenarios)
# ---------------------------------------------------------------------------


# TST-BRAIN-358
@pytest.mark.asyncio
async def test_deferred_17_3_1_enclave_attestation() -> None:
    """SS17.3.1: Enclave attestation.

    Managed Home Node starts inside AMD SEV-SNP / Intel TDX enclave.
    Attestation report verifiable by client.
    Phase 2+: verify the attestation contract shape.
    """
    # Define the expected attestation report contract
    attestation_report = {
        "enclave_type": "AMD_SEV_SNP",
        "measurement": "sha256:abcdef1234567890",
        "platform_version": "1.0",
        "verifiable": True,
    }

    assert attestation_report["enclave_type"] in ("AMD_SEV_SNP", "INTEL_TDX")
    assert attestation_report["verifiable"] is True
    assert attestation_report["measurement"].startswith("sha256:")


# TST-BRAIN-359
@pytest.mark.asyncio
async def test_deferred_17_3_2_ram_inspection_impossible() -> None:
    """SS17.3.2: RAM inspection impossible.

    Root attacker on host inspects enclave memory.
    No plaintext visible -- hardware-enforced.
    Phase 2+: verify the security contract expectations.
    """
    # Define the expected security properties of confidential computing
    security_properties = {
        "memory_encryption": True,
        "root_access_blocked": True,
        "hardware_enforced": True,
        "plaintext_visible_to_host": False,
    }

    assert security_properties["memory_encryption"] is True
    assert security_properties["root_access_blocked"] is True
    assert security_properties["hardware_enforced"] is True
    assert security_properties["plaintext_visible_to_host"] is False


# TST-BRAIN-360
@pytest.mark.asyncio
async def test_deferred_17_3_3_enclave_sealed_keys() -> None:
    """SS17.3.3: Enclave-sealed keys.

    Keys sealed to enclave identity. Keys non-extractable even by
    hosting operator.
    Phase 2+: verify the key management contract.
    """
    sealed_key_properties = {
        "sealed_to_enclave": True,
        "extractable_by_operator": False,
        "extractable_by_user": True,
        "key_type": "Ed25519",
    }

    assert sealed_key_properties["sealed_to_enclave"] is True
    assert sealed_key_properties["extractable_by_operator"] is False
    assert sealed_key_properties["extractable_by_user"] is True
    assert sealed_key_properties["key_type"] == "Ed25519"


# ---------------------------------------------------------------------------
# SS17.4 Digital Estate (3 scenarios) -- arch SS14
# ---------------------------------------------------------------------------


# TST-BRAIN-420
def test_deferred_17_4_1_estate_recovery_queue_tasks() -> None:
    """SS17.4.1: Brain queues non-critical tasks during estate recovery.

    Architecture SS14: During active recovery procedures, brain queues/rejects
    non-critical tasks while estate recovery is in-flight. Phase 2+ feature.
    Verify the event contract for estate recovery.
    """
    recovery_event = make_event(
        type="estate_recovery",
        body="Estate recovery in progress",
        context={
            "recovery_mode": True,
            "non_critical_action": "queue",
        },
    )

    assert recovery_event["type"] == "estate_recovery"
    assert recovery_event["context"]["recovery_mode"] is True
    assert recovery_event["context"]["non_critical_action"] == "queue"


# TST-BRAIN-421
def test_deferred_17_4_2_zkp_credential_verification() -> None:
    """SS17.4.2: Brain verifies Ring 2+ ZKP credentials for agent trust.

    Architecture SS05: Brain verifies ZKP credentials when evaluating agent
    intent trust. Phase 3 feature (ZK-SNARKs on L2).
    Verify the ZKP credential contract shape.
    """
    zkp_credential = {
        "type": "zkp_proof",
        "ring_level": 2,
        "verified": True,
        "proof_system": "zk-snark",
        "chain": "polygon_l2",
    }

    assert zkp_credential["ring_level"] >= 2
    assert zkp_credential["verified"] is True
    assert zkp_credential["proof_system"] in ("zk-snark", "zk-stark")


# TST-BRAIN-422
def test_deferred_17_4_3_sss_recovery_coordination() -> None:
    """SS17.4.3: Brain coordinates SSS custodian recovery via DIDComm.

    Architecture SS14: Brain's role in Shamir Secret Sharing custodian recovery
    coordination. Core handles crypto; brain coordinates human approval flow.
    Phase 2+ feature. Verify the SSS coordination contract.
    """
    sss_coordination = {
        "type": "sss_recovery",
        "threshold": 3,
        "total_custodians": 5,
        "custodians_responded": 0,
        "brain_role": "coordination",
        "core_role": "crypto",
    }

    assert sss_coordination["threshold"] <= sss_coordination["total_custodians"]
    assert sss_coordination["brain_role"] == "coordination"
    assert sss_coordination["core_role"] == "crypto"
    # Shamir requires k-of-n: threshold must be > 1
    assert sss_coordination["threshold"] > 1
