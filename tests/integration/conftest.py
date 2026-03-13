"""Shared pytest fixtures for Dina integration tests.

Dual-mode: set DINA_INTEGRATION=docker to use real HTTP clients against
Docker containers (docker-compose.test.yml). Without it, uses mocks.
"""

from __future__ import annotations

import os

import httpx
import pytest

# ---------------------------------------------------------------------------
# Docker mode detection
# ---------------------------------------------------------------------------

DOCKER_MODE = os.environ.get("DINA_INTEGRATION") == "docker"

from tests.integration.mocks import (
    DIDDocument,
    EstateBeneficiary,
    EstatePlan,
    ExpertAttestation,
    MockAdminAPI,
    MockAppView,
    MockAuditLog,
    MockServiceAuth,
    MockCalendarConnector,
    MockChaosMonkey,
    MockCrashLog,
    MockDeploymentProfile,
    MockDockerCompose,
    MockExportArchive,
    MockExternalAgent,
    MockGmailConnector,
    MockGoCore,
    MockHuman,
    MockIdentity,
    MockInboxSpool,
    MockIngressTier,
    MockLegalBot,
    MockLLMRouter,
    MockNoiseSession,
    MockOnboardingManager,
    MockOutbox,
    MockP2PChannel,
    MockPairingManager,
    MockPerformanceMetrics,
    MockPIIScrubber,
    MockPLCResolver,
    MockPushProvider,
    MockPythonBrain,
    MockRelay,
    MockTrustNetwork,
    MockReviewBot,
    MockRichClient,
    MockSchemaMigration,
    MockScratchpad,
    MockSilenceClassifier,
    MockStagingTier,
    MockThinClient,
    MockTimestampAnchor,
    MockTrustEvaluator,
    MockDinaCore,
    MockEstateManager,
    MockVault,
    MockTelegramConnector,
    MockVerificationLayer,
    MockWebSocketServer,
    MockWhisperAssembler,
    MockBackupManager,
    MockBootManager,
    MockBotQuerySanitizer,
    MockDeadDropIngress,
    MockHKDFKeyManager,
    MockHybridSearch,
    MockKVStore,
    MockReconnectBackoff,
    MockSharingPolicyManager,
    MockSSSManager,
    MockSTTProvider,
    MockSTTRouter,
    MockTaskQueue,
    MockVaultQuery,
    MockWatchdog,
    MockWSSessionManager,
    Argon2idParams,
    OAuthToken,
    OnboardingStep,
    OutcomeReport,
    PersonaType,
    SharingRule,
    TrustRing,
)

if DOCKER_MODE:
    from tests.integration.docker_services import DockerServices
    from tests.integration.real_clients import (
        RealAdminAPI,
        RealAuditLog,
        RealServiceAuth,
        RealDockerCompose,
        RealGoCore,
        RealPairingManager,
        RealPIIScrubber,
        RealPythonBrain,
        RealVault,
        RealWebSocketClient,
    )


# ---------------------------------------------------------------------------
# Docker services (session-scoped)
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def docker_services():
    """Start Docker containers for integration testing.

    Only active when DINA_INTEGRATION=docker. Session-scoped so containers
    are started once and shared across all tests.
    """
    if not DOCKER_MODE:
        yield None
        return

    svc = DockerServices()
    svc.start()
    yield svc
    svc.stop()


# ---------------------------------------------------------------------------
# Docker persona initialization (session-scoped)
# ---------------------------------------------------------------------------

_ALL_PERSONAS = ["personal", "consumer", "professional", "social",
                 "health", "financial", "citizen"]


@pytest.fixture(scope="session", autouse=True)
def docker_persona_setup(docker_services):
    """Create and unlock personas on real Go Core once per session.

    Also purges any stale integration_test items from prior runs.
    """
    if not DOCKER_MODE:
        return
    # Persona management requires an admin-scoped client token.
    token = docker_services.client_token
    headers = {"Authorization": f"Bearer {token}"}
    base = docker_services.core_url
    for name in _ALL_PERSONAS:
        httpx.post(
            f"{base}/v1/personas",
            json={"name": name, "tier": "open", "passphrase": "test"},
            headers=headers, timeout=10,
        )
        httpx.post(
            f"{base}/v1/persona/unlock",
            json={"persona": name, "passphrase": "test"},
            headers=headers, timeout=10,
        )

    # Clear all vaults at session start for a clean slate.
    clear_headers = {"Authorization": f"Bearer {docker_services.client_token}"}
    for name in _ALL_PERSONAS:
        try:
            httpx.post(
                f"{base}/v1/vault/clear",
                json={"persona": name},
                headers=clear_headers, timeout=10,
            )
        except Exception:
            pass



# ---------------------------------------------------------------------------
# Per-test vault cleanup
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def docker_vault_cleanup():
    """No-op: per-test cleanup is not needed.

    RealVault filters search/retrieve results to only items tracked in the
    current test's _item_map, so stale items from prior tests are invisible.
    The vault is cleared once at session start via POST /v1/vault/clear.
    """
    yield []


# ---------------------------------------------------------------------------
# Core actors
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_human() -> MockHuman:
    return MockHuman()


@pytest.fixture
def mock_identity(docker_services) -> MockIdentity:
    if DOCKER_MODE:
        # Query the actual DID from the running Core node so all fixtures agree
        import httpx
        try:
            resp = httpx.get(
                f"{docker_services.core_url}/.well-known/atproto-did",
                timeout=5,
            )
            if resp.status_code == 200:
                text = resp.text.strip()
                if text.startswith("did:"):
                    return MockIdentity(did=text)
        except Exception:
            pass
    return MockIdentity(did="did:plc:a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0")


@pytest.fixture
def mock_vault(docker_services, docker_vault_cleanup) -> MockVault:
    if DOCKER_MODE:
        return RealVault(
            docker_services.core_url,
            docker_vault_cleanup,
        )
    return MockVault()


@pytest.fixture
def mock_dina(mock_identity: MockIdentity, mock_vault: MockVault,
              docker_services) -> MockDinaCore:
    dina = MockDinaCore(identity=mock_identity, vault=mock_vault)
    if DOCKER_MODE:
        real_scrubber = RealPIIScrubber(
            docker_services.core_url, docker_services.brain_url,
        )
        dina.scrubber = real_scrubber
        dina.go_core._scrubber = real_scrubber
    return dina


@pytest.fixture
def sancho_identity() -> MockIdentity:
    return MockIdentity(did="did:plc:b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1")


@pytest.fixture
def mock_another_dina(sancho_identity: MockIdentity) -> MockDinaCore:
    return MockDinaCore(identity=sancho_identity)


@pytest.fixture
def seller_identity() -> MockIdentity:
    return MockIdentity(did="did:plc:c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2")


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
    bot = MockReviewBot(trust_score=94)
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
    return MockLegalBot(trust_score=91)


@pytest.fixture
def mock_trust_network() -> MockTrustNetwork:
    return MockTrustNetwork()


# ---------------------------------------------------------------------------
# Home Node components
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_scrubber(docker_services) -> MockPIIScrubber:
    if DOCKER_MODE:
        return RealPIIScrubber(
            docker_services.core_url, docker_services.brain_url,
        )
    return MockPIIScrubber()


@pytest.fixture
def mock_go_core(mock_vault: MockVault, mock_identity: MockIdentity,
                 mock_scrubber: MockPIIScrubber, docker_services) -> MockGoCore:
    if DOCKER_MODE:
        return RealGoCore(
            docker_services.core_url, mock_vault,
            scrubber=mock_scrubber,
            client_token=docker_services.client_token,
        )
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
               mock_llm_router: MockLLMRouter,
               docker_services) -> MockPythonBrain:
    if DOCKER_MODE:
        return RealPythonBrain(
            docker_services.brain_url,
            mock_classifier, mock_whisper, mock_llm_router,
        )
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
def mock_telegram_connector() -> MockTelegramConnector:
    return MockTelegramConnector()


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
        trigger="custodian_threshold",
        custodian_threshold=3,
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


# ---------------------------------------------------------------------------
# Infrastructure: Auth & WebSocket (§1, §2)
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_service_auth(docker_services) -> MockServiceAuth:
    if DOCKER_MODE:
        return RealServiceAuth(
            docker_services.core_url, docker_services.client_token,
        )
    return MockServiceAuth()


@pytest.fixture
def mock_ws_server(docker_services) -> MockWebSocketServer:
    if DOCKER_MODE:
        return RealWebSocketClient(
            docker_services.core_url,
        )
    return MockWebSocketServer()


@pytest.fixture
def mock_admin_api(
    mock_identity: MockIdentity, mock_vault: MockVault, docker_services,
) -> MockAdminAPI:
    if DOCKER_MODE:
        return RealAdminAPI(
            docker_services.brain_url,
            core_url=docker_services.core_url,
        )
    return MockAdminAPI(mock_identity, mock_vault)


@pytest.fixture
def mock_pairing_manager(docker_services) -> MockPairingManager:
    if DOCKER_MODE:
        return RealPairingManager(
            docker_services.core_url,
        )
    return MockPairingManager()


@pytest.fixture
def mock_onboarding(
    mock_identity: MockIdentity, mock_vault: MockVault
) -> MockOnboardingManager:
    return MockOnboardingManager(mock_identity, mock_vault)


# ---------------------------------------------------------------------------
# Infrastructure: Docker & Crash Recovery (§5, §6)
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_compose(docker_services) -> MockDockerCompose:
    if DOCKER_MODE:
        return RealDockerCompose(docker_services)
    return MockDockerCompose()


@pytest.fixture
def mock_compose_local_llm() -> MockDockerCompose:
    return MockDockerCompose(profile="local-llm")


@pytest.fixture
def mock_scratchpad() -> MockScratchpad:
    return MockScratchpad()


@pytest.fixture
def mock_outbox() -> MockOutbox:
    return MockOutbox()


@pytest.fixture
def mock_inbox_spool() -> MockInboxSpool:
    return MockInboxSpool()


@pytest.fixture
def mock_crash_log() -> MockCrashLog:
    return MockCrashLog()


# ---------------------------------------------------------------------------
# Infrastructure: Migration & Performance (§12, §13, §14)
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_schema_migration() -> MockSchemaMigration:
    return MockSchemaMigration()


@pytest.fixture
def mock_export_archive() -> MockExportArchive:
    return MockExportArchive()


@pytest.fixture
def mock_perf_metrics() -> MockPerformanceMetrics:
    return MockPerformanceMetrics()


@pytest.fixture
def mock_chaos_monkey() -> MockChaosMonkey:
    return MockChaosMonkey()


# ---------------------------------------------------------------------------
# Infrastructure: Compliance & Audit (§15)
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_audit_log(docker_services) -> MockAuditLog:
    if DOCKER_MODE:
        return RealAuditLog(docker_services.core_url)
    return MockAuditLog()


# ---------------------------------------------------------------------------
# Infrastructure: Phase 2+ (§16)
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_push_provider() -> MockPushProvider:
    return MockPushProvider()


@pytest.fixture
def mock_deployment_profile() -> MockDeploymentProfile:
    return MockDeploymentProfile()


@pytest.fixture
def mock_noise_session(mock_identity: MockIdentity,
                       sancho_identity: MockIdentity) -> MockNoiseSession:
    return MockNoiseSession(mock_identity.root_did, sancho_identity.root_did)


@pytest.fixture
def mock_app_view() -> MockAppView:
    return MockAppView()


@pytest.fixture
def mock_ingress_community() -> MockIngressTier:
    return MockIngressTier.community("my-dina")


@pytest.fixture
def mock_verification_layer() -> MockVerificationLayer:
    return MockVerificationLayer()


@pytest.fixture
def mock_timestamp_anchor() -> MockTimestampAnchor:
    return MockTimestampAnchor()


# ---------------------------------------------------------------------------
# Architecture Validation: SSS, Backup, STT, Bot Sanitizer (§17)
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_sss_manager(mock_identity: MockIdentity) -> MockSSSManager:
    return MockSSSManager(mock_identity, threshold=3, total_shares=5)


@pytest.fixture
def mock_backup_manager(
    mock_vault: MockVault, mock_identity: MockIdentity
) -> MockBackupManager:
    return MockBackupManager(mock_vault, mock_identity)


@pytest.fixture
def mock_stt_router() -> MockSTTRouter:
    return MockSTTRouter()


@pytest.fixture
def mock_bot_sanitizer() -> MockBotQuerySanitizer:
    return MockBotQuerySanitizer()


# ---------------------------------------------------------------------------
# Architecture Validation: MEDIUM gap mocks
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_dead_drop() -> MockDeadDropIngress:
    return MockDeadDropIngress()


@pytest.fixture
def mock_task_queue() -> MockTaskQueue:
    return MockTaskQueue()


@pytest.fixture
def mock_hkdf(mock_identity: MockIdentity) -> MockHKDFKeyManager:
    return MockHKDFKeyManager(mock_identity.root_private_key)


@pytest.fixture
def mock_vault_query(mock_vault: MockVault) -> MockVaultQuery:
    return MockVaultQuery(mock_vault)


@pytest.fixture
def mock_hybrid_search() -> MockHybridSearch:
    return MockHybridSearch()


@pytest.fixture
def mock_kv_store() -> MockKVStore:
    return MockKVStore()


@pytest.fixture
def mock_boot_manager(mock_identity: MockIdentity) -> MockBootManager:
    return MockBootManager(mock_identity)


@pytest.fixture
def mock_sharing_policy() -> MockSharingPolicyManager:
    return MockSharingPolicyManager()


@pytest.fixture
def mock_watchdog() -> MockWatchdog:
    return MockWatchdog()


@pytest.fixture
def mock_ws_session_mgr() -> MockWSSessionManager:
    return MockWSSessionManager()


@pytest.fixture
def mock_reconnect_backoff() -> MockReconnectBackoff:
    return MockReconnectBackoff()
