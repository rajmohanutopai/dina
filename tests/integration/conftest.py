"""Shared pytest fixtures for Dina integration tests."""

from __future__ import annotations

import pytest

from tests.integration.mocks import (
    DIDDocument,
    EstateBeneficiary,
    EstatePlan,
    ExpertAttestation,
    MockCalendarConnector,
    MockPLCResolver,
    MockDinaCore,
    MockEstateManager,
    MockExternalAgent,
    MockGmailConnector,
    MockGoCore,
    MockHuman,
    MockIdentity,
    MockLegalBot,
    MockLLMRouter,
    MockP2PChannel,
    MockPIIScrubber,
    MockPythonBrain,
    MockRelay,
    MockReputationGraph,
    MockReviewBot,
    MockRichClient,
    MockSilenceClassifier,
    MockStagingTier,
    MockThinClient,
    MockTrustEvaluator,
    MockVault,
    MockWhatsAppConnector,
    MockWhisperAssembler,
    OAuthToken,
    OutcomeReport,
    PersonaType,
    SharingRule,
    TrustRing,
)


# ---------------------------------------------------------------------------
# Core actors
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_human() -> MockHuman:
    return MockHuman()


@pytest.fixture
def mock_identity() -> MockIdentity:
    return MockIdentity(did="did:plc:TestUser1234567890abcdefghijk")


@pytest.fixture
def mock_vault() -> MockVault:
    return MockVault()


@pytest.fixture
def mock_dina(mock_identity: MockIdentity, mock_vault: MockVault) -> MockDinaCore:
    return MockDinaCore(identity=mock_identity, vault=mock_vault)


@pytest.fixture
def sancho_identity() -> MockIdentity:
    return MockIdentity(did="did:plc:Sancho12345678901234567890abc")


@pytest.fixture
def mock_another_dina(sancho_identity: MockIdentity) -> MockDinaCore:
    return MockDinaCore(identity=sancho_identity)


@pytest.fixture
def seller_identity() -> MockIdentity:
    return MockIdentity(did="did:plc:Seller12345678901234567890abc")


@pytest.fixture
def mock_seller_dina(seller_identity: MockIdentity) -> MockDinaCore:
    return MockDinaCore(identity=seller_identity)


@pytest.fixture
def mock_dinas_fleet() -> list[MockDinaCore]:
    """Fleet of 10 Dinas for aggregation tests."""
    return [MockDinaCore() for _ in range(10)]


@pytest.fixture
def mock_telegram() -> dict[str, list]:
    """Telegram-like messaging interface mock."""
    return {"sent": [], "received": []}


# ---------------------------------------------------------------------------
# External systems
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_external_agent() -> MockExternalAgent:
    return MockExternalAgent(name="OpenClaw")


@pytest.fixture
def mock_review_bot() -> MockReviewBot:
    bot = MockReviewBot(reputation=94)
    # Pre-populate with some product responses
    bot.add_response("laptop", {
        "recommendations": [
            {
                "product": "ThinkPad X1 Carbon",
                "score": 92,
                "sources": [
                    {
                        "type": "expert",
                        "creator_name": "MKBHD",
                        "source_url": "https://youtube.com/watch?v=abc123",
                        "deep_link": "https://youtube.com/watch?v=abc123&t=260",
                        "deep_link_context": "See battery stress test at 4:20",
                    }
                ],
                "cons": ["expensive"],
                "confidence": 0.87,
            }
        ],
        "bot_signature": "mock_sig_review",
        "bot_did": bot.bot_did,
    })
    bot.add_response("chair", {
        "recommendations": [
            {
                "product": "Herman Miller Aeron",
                "score": 91,
                "sources": [
                    {
                        "type": "expert",
                        "creator_name": "RTINGS.com",
                        "source_url": "https://rtings.com/chairs/reviews/aeron",
                        "deep_link": "https://rtings.com/chairs/reviews/aeron#lumbar",
                        "deep_link_context": "See lumbar support stress test",
                    },
                    {
                        "type": "outcome",
                        "sample_size": 4200,
                        "still_using_1yr": 0.89,
                    },
                ],
                "cons": ["price_high"],
                "confidence": 0.89,
            }
        ],
        "bot_signature": "mock_sig_review",
        "bot_did": bot.bot_did,
    })
    return bot


@pytest.fixture
def mock_legal_bot() -> MockLegalBot:
    return MockLegalBot(reputation=91)


@pytest.fixture
def mock_reputation_graph() -> MockReputationGraph:
    return MockReputationGraph()


# ---------------------------------------------------------------------------
# Home Node components
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_scrubber() -> MockPIIScrubber:
    return MockPIIScrubber()


@pytest.fixture
def mock_go_core(mock_vault: MockVault, mock_identity: MockIdentity,
                 mock_scrubber: MockPIIScrubber) -> MockGoCore:
    return MockGoCore(mock_vault, mock_identity, mock_scrubber)


@pytest.fixture
def mock_classifier() -> MockSilenceClassifier:
    return MockSilenceClassifier()


@pytest.fixture
def mock_whisper(mock_vault: MockVault) -> MockWhisperAssembler:
    return MockWhisperAssembler(mock_vault)


@pytest.fixture
def mock_llm_router() -> MockLLMRouter:
    """Offline Mode LLM router (llama-server + whisper-server available)."""
    return MockLLMRouter(profile="offline")


@pytest.fixture
def mock_cloud_llm_router() -> MockLLMRouter:
    """Online Mode LLM router (Gemini Flash Lite + Deepgram, no local LLM)."""
    return MockLLMRouter(profile="online")


@pytest.fixture
def mock_brain(mock_classifier: MockSilenceClassifier,
               mock_whisper: MockWhisperAssembler,
               mock_llm_router: MockLLMRouter) -> MockPythonBrain:
    return MockPythonBrain(mock_classifier, mock_whisper, mock_llm_router)


@pytest.fixture
def mock_staging() -> MockStagingTier:
    return MockStagingTier()


@pytest.fixture
def mock_trust_evaluator() -> MockTrustEvaluator:
    return MockTrustEvaluator()


# ---------------------------------------------------------------------------
# Communication
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_p2p() -> MockP2PChannel:
    return MockP2PChannel()


@pytest.fixture
def mock_plc_resolver() -> MockPLCResolver:
    return MockPLCResolver()


@pytest.fixture
def mock_relay() -> MockRelay:
    return MockRelay()


# ---------------------------------------------------------------------------
# Ingestion
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_gmail_connector() -> MockGmailConnector:
    return MockGmailConnector()


@pytest.fixture
def mock_calendar_connector() -> MockCalendarConnector:
    return MockCalendarConnector()


@pytest.fixture
def mock_whatsapp_connector() -> MockWhatsAppConnector:
    return MockWhatsAppConnector()


# ---------------------------------------------------------------------------
# Client devices
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_rich_client() -> MockRichClient:
    return MockRichClient(device_id="phone_001", cache_months=6)


@pytest.fixture
def mock_thin_client() -> MockThinClient:
    return MockThinClient(device_id="glasses_001")


# ---------------------------------------------------------------------------
# Estate
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_estate_manager(mock_identity: MockIdentity) -> MockEstateManager:
    plan = EstatePlan(
        trigger="dead_mans_switch",
        switch_interval_days=90,
        beneficiaries=[
            EstateBeneficiary(
                name="Daughter",
                dina_did="did:plc:Daughter1234567890123456789",
                receives_personas=[PersonaType.SOCIAL, PersonaType.HEALTH],
                access_type="full_decrypt",
            ),
            EstateBeneficiary(
                name="Spouse",
                dina_did="did:plc:Spouse123456789012345678901",
                receives_personas=[PersonaType.FINANCIAL, PersonaType.CITIZEN],
                access_type="full_decrypt",
            ),
            EstateBeneficiary(
                name="Colleague",
                dina_did="did:plc:Colleague12345678901234567",
                receives_personas=[PersonaType.PROFESSIONAL],
                access_type="read_only_90_days",
            ),
        ],
        default_action="destroy",
    )
    return MockEstateManager(mock_identity, plan)


# ---------------------------------------------------------------------------
# Pre-populated sample data
# ---------------------------------------------------------------------------

@pytest.fixture
def sample_contacts(sancho_identity: MockIdentity,
                    seller_identity: MockIdentity) -> dict[str, dict]:
    return {
        "sancho": {
            "did": sancho_identity.root_did,
            "name": "Sancho",
            "relationship": "close_friend",
            "trust_ring": TrustRing.RING_2_VERIFIED,
            "tea_preference": "strong chai, less sugar",
            "notes": "Mother was ill last month",
        },
        "maria": {
            "did": "did:plc:Maria123456789012345678901234",
            "name": "Maria",
            "relationship": "friend",
            "trust_ring": TrustRing.RING_2_VERIFIED,
        },
        "seller_abc": {
            "did": seller_identity.root_did,
            "name": "ChairMaker Co.",
            "relationship": "seller",
            "trust_ring": TrustRing.RING_3_SKIN_IN_GAME,
        },
    }


@pytest.fixture
def sample_memory(mock_vault: MockVault,
                  sancho_identity: MockIdentity) -> MockVault:
    """Pre-populated memory entries."""
    # Sancho context
    mock_vault.store(1, "contact_sancho", {
        "contact": sancho_identity.root_did,
        "last_message": "He asked for the PDF last week",
        "context_flag": "Mother was ill last month",
        "preference": "He likes strong chai, less sugar",
    })
    mock_vault.index_for_fts("contact_sancho",
                             "Sancho PDF mother ill chai tea strong")

    # Book promise
    mock_vault.store(1, "promise_book", {
        "type": "promise",
        "to": "daughter",
        "content": "Read 'The Little Prince' to daughter",
        "date": "last Tuesday",
    })
    mock_vault.index_for_fts("promise_book",
                             "daughter book Little Prince promise read Tuesday")

    # Happiness moments
    mock_vault.store(1, "moment_happy_1", {
        "type": "moment",
        "emotion": "happy",
        "content": "Family picnic at the park",
        "date": "2025-06-15",
    })
    mock_vault.index_for_fts("moment_happy_1",
                             "happy family picnic park joy")

    return mock_vault


@pytest.fixture
def sample_products() -> list[dict]:
    return [
        {
            "product_id": "thinkpad_x1_2025",
            "name": "ThinkPad X1 Carbon 2025",
            "category": "laptops",
            "price_range": "150000-200000_INR",
        },
        {
            "product_id": "aeron_2025",
            "name": "Herman Miller Aeron 2025",
            "category": "office_chairs",
            "price_range": "80000-120000_INR",
        },
    ]


@pytest.fixture
def sample_events() -> list[dict]:
    return [
        {
            "id": "meeting_1",
            "type": "calendar_event",
            "title": "Team standup",
            "time": "2026-02-15T09:00:00Z",
            "duration_minutes": 30,
        },
        {
            "id": "license_renewal",
            "type": "reminder",
            "title": "Driver's license expires",
            "time": "2026-02-22T00:00:00Z",
        },
    ]


@pytest.fixture
def sample_sharing_rules(
    sancho_identity: MockIdentity,
    seller_identity: MockIdentity,
) -> list[SharingRule]:
    return [
        SharingRule(
            contact_did=sancho_identity.root_did,
            persona=PersonaType.SOCIAL,
            allowed=["arrival", "departure", "context_flags", "tea_preference"],
            denied=["financial", "health_details", "professional"],
        ),
        SharingRule(
            contact_did=seller_identity.root_did,
            persona=PersonaType.CONSUMER,
            allowed=["product_requirements", "budget_range", "trust_ring"],
            denied=["name", "address", "contact_details", "other_persona"],
        ),
    ]
