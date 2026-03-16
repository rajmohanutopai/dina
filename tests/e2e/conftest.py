"""Shared pytest fixtures for Dina E2E tests — Docker-only.

The entire E2E suite requires DINA_E2E=docker and running Docker
containers (docker-compose-e2e.yml).  Each actor gets its own
Core+Brain container pair.  test_status.py manages the Docker lifecycle.

All actor fixtures (Don Alonso, Sancho, ChairMaker, Albert) create
RealHomeNode instances backed by real Go Core HTTP APIs.  There is
no mock fallback — if Docker isn't running, the suite skips.

Infrastructure mocks (PLC Directory, AppView, Relay, FCM, Payment
Gateway) are used for services that don't have Docker containers
in the E2E stack.
"""

from __future__ import annotations

import os
import time

import pytest

from tests.e2e.actors import HomeNode, Persona, PersonaType
from tests.e2e.mocks import (
    BotTrust,
    D2DMessage,
    DeviceType,
    EstateBeneficiary,
    EstatePlan,
    ExpertAttestation,
    MockAppView,
    MockD2DNetwork,
    MockFCM,
    MockMaliciousBot,
    MockOpenClaw,
    MockPaymentGateway,
    MockPDS,
    MockPLCDirectory,
    MockRelay,
    MockReviewBot,
    SharingPolicy,
    TrustRing,
)

# ---------------------------------------------------------------------------
# Docker mode — always active for E2E
# ---------------------------------------------------------------------------

DOCKER_MODE = os.environ.get("DINA_E2E") == "docker"

from tests.e2e.multi_node_services import MultiNodeDockerServices
from tests.e2e.real_nodes import RealHomeNode
from tests.e2e.real_d2d import RealD2DNetwork


# ---------------------------------------------------------------------------
# Docker services (session-scoped)
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def docker_services():
    """Start Docker containers for E2E testing.

    Session-scoped so containers are started once and shared across
    all tests.  Uses the multi-node stack (4 Core+Brain pairs:
    alonso, sancho, chairmaker, albert).

    Skips the entire E2E suite when DINA_E2E != 'docker'.
    """
    if not DOCKER_MODE:
        pytest.skip("E2E tests require Docker (DINA_E2E=docker)")

    svc = MultiNodeDockerServices()
    svc.start()
    yield svc
    svc.stop()


# ---------------------------------------------------------------------------
# Docker persona initialization (session-scoped)
# ---------------------------------------------------------------------------

_PERSONA_TIERS = {
    "general": "default",
    "health": "sensitive",
    "financial": "locked",
    "consumer": "standard",
    "professional": "standard",
    "social": "standard",
    "business": "standard",
}
_ALL_PERSONAS = list(_PERSONA_TIERS.keys())


@pytest.fixture(scope="session", autouse=True)
def e2e_persona_setup(docker_services):
    """Create and unlock personas on ALL real Go Core instances once per session.

    Iterates over all 4 actors (alonso, sancho, chairmaker, albert) and
    creates/unlocks every persona on each node.  Also clears vault data
    from prior runs via POST /v1/vault/clear.

    Uses CLIENT_TOKEN for persona and vault operations, respecting the
    authz model.  Only runs in Docker mode (docker_services skips otherwise).
    """
    import httpx

    # Persona create/unlock are admin-only → require CLIENT_TOKEN.
    # Vault clear also uses CLIENT_TOKEN in E2E test mode.
    admin_headers = {"Authorization": f"Bearer {docker_services.client_token}"}
    data_headers = {"Authorization": f"Bearer {docker_services.client_token}"}

    for actor in ["alonso", "sancho", "chairmaker", "albert"]:
        base = docker_services.core_url(actor)

        for name, tier in _PERSONA_TIERS.items():
            httpx.post(
                f"{base}/v1/personas",
                json={"name": name, "tier": tier, "passphrase": "test"},
                headers=admin_headers, timeout=10,
            )
            # Unlock sensitive/locked so tests can use them
            httpx.post(
                f"{base}/v1/persona/unlock",
                json={"persona": name, "passphrase": "test"},
                headers=admin_headers, timeout=10,
            )

        # Clear all vaults at session start for a clean slate
        for name in _ALL_PERSONAS:
            try:
                httpx.post(
                    f"{base}/v1/vault/clear",
                    json={"persona": name},
                    headers=data_headers, timeout=10,
                )
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Infrastructure fixtures (session-scoped — shared across all tests)
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def plc_directory() -> MockPLCDirectory:
    """Mock PLC Directory — DID resolution for all actors."""
    return MockPLCDirectory()


@pytest.fixture(scope="session")
def d2d_network(docker_services) -> MockD2DNetwork:
    """D2D delivery between Home Nodes via real Go Core HTTP calls."""
    did_to_core_url = {
        "did:plc:alonso": docker_services.core_url("alonso"),
        "did:plc:sancho": docker_services.core_url("sancho"),
        "did:plc:chairmaker": docker_services.core_url("chairmaker"),
        "did:plc:albert": docker_services.core_url("albert"),
    }
    return RealD2DNetwork(did_to_core_url, docker_services.client_token)


@pytest.fixture(scope="session")
def appview() -> MockAppView:
    """Mock Trust Network AppView."""
    av = MockAppView()
    # Pre-populate bot trusts
    av.update_bot_trust("did:plc:reviewbot", 94)
    av.update_bot_trust("did:plc:malbot", 12)
    return av


@pytest.fixture(scope="session")
def relay() -> MockRelay:
    """Mock AT Protocol Relay."""
    return MockRelay()


@pytest.fixture(scope="session")
def fcm() -> MockFCM:
    """Mock FCM/APNs push notification capture."""
    return MockFCM()


@pytest.fixture(scope="session")
def payment_gateway() -> MockPaymentGateway:
    """Mock Payment Gateway."""
    return MockPaymentGateway()


# ---------------------------------------------------------------------------
# Actor Home Nodes (session-scoped)
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def _core_private_keys(docker_services) -> dict[str, bytes | None]:
    """Extract Ed25519 private keys from all Core containers (once per session).

    These keys enable RealHomeNode to sign Brain API requests with Ed25519
    (same protocol as BrainSigner in tests/system/conftest.py).
    """
    keys: dict[str, bytes | None] = {}
    for actor in ["alonso", "sancho", "chairmaker", "albert"]:
        try:
            keys[actor] = docker_services.extract_core_private_key(actor)
        except (RuntimeError, Exception):
            keys[actor] = None
    return keys


@pytest.fixture(scope="session")
def don_alonso(plc_directory, d2d_network, docker_services, _core_private_keys) -> HomeNode:
    """Don Alonso — Primary User (Trust Ring 3).

    RealHomeNode backed by real Go Core (vault, persona, KV, health,
    PII scrubbing, DID signing, device pairing all hit real APIs).
    Brain API calls use Ed25519 signing.
    """
    node = RealHomeNode(
        core_url=docker_services.core_url("alonso"),
        brain_url=docker_services.brain_url("alonso"),
        client_token=docker_services.client_token,
        core_private_key_pem=_core_private_keys.get("alonso"),
        did="did:plc:alonso",
        display_name="Don Alonso",
        trust_ring=TrustRing.RING_3_SKIN_IN_GAME,
        plc=plc_directory,
        network=d2d_network,
    )

    # Setup
    node.first_run_setup("alonso@example.com", "passphrase123")

    # Create personas
    node.create_persona("health", PersonaType.HEALTH, "restricted")
    node.create_persona("financial", PersonaType.FINANCIAL, "locked")
    node.create_persona("consumer", PersonaType.CONSUMER, "open")
    node.create_persona("professional", PersonaType.PROFESSIONAL, "open")
    node.create_persona("social", PersonaType.SOCIAL, "open")

    # Pair devices: phone + laptop
    code1 = node.generate_pairing_code()
    phone = node.pair_device(code1, DeviceType.RICH_CLIENT)
    code2 = node.generate_pairing_code()
    laptop = node.pair_device(code2, DeviceType.RICH_CLIENT)

    # Contacts — pushes to real Go Core via POST /v1/contacts
    node.add_contact("did:plc:sancho", "Sancho", TrustRing.RING_2_VERIFIED)
    node.add_contact("did:plc:drcarl", "Dr. Carl", TrustRing.RING_2_VERIFIED)
    node.add_contact("did:plc:albert", "Albert", TrustRing.RING_2_VERIFIED)
    node.add_contact("did:plc:chairmaker", "ChairMaker", TrustRing.RING_3_SKIN_IN_GAME)

    # Sharing policies
    node.set_sharing_policy("did:plc:sancho",
                            presence="eta_only", context="full",
                            availability="free_busy", preferences="full")
    node.set_sharing_policy("did:plc:drcarl", health="full")
    node.set_sharing_policy("did:plc:chairmaker", preferences="summary")

    # Pre-populate vault with context
    node.vault_store("general", "sancho_last_visit",
                     {"event": "visit", "date": "3 weeks ago",
                      "context": "mother was ill"})
    node.vault_store("general", "sancho_preferences",
                     {"tea": "strong chai", "relationship": "close friend"})
    node.vault_store("general", "book_promise",
                     {"item": "The Little Prince", "for": "daughter",
                      "date": "last Tuesday"})

    # Estate plan
    node.set_estate_plan(EstatePlan(
        beneficiaries=[
            EstateBeneficiary(
                did="did:plc:albert",
                personas=["general", "health"],
                access_level="full_decrypt",
            ),
        ],
        custodian_threshold=3,
        custodian_total=5,
        default_action="destroy",
    ))

    return node


@pytest.fixture(scope="session")
def sancho(plc_directory, d2d_network, docker_services, _core_private_keys) -> HomeNode:
    """Sancho -- Close Friend (Trust Ring 2).

    RealHomeNode backed by real Go Core + Brain (Ed25519 signed).
    """
    node = RealHomeNode(
        core_url=docker_services.core_url("sancho"),
        brain_url=docker_services.brain_url("sancho"),
        client_token=docker_services.client_token,
        core_private_key_pem=_core_private_keys.get("sancho"),
        did="did:plc:sancho",
        display_name="Sancho",
        trust_ring=TrustRing.RING_2_VERIFIED,
        plc=plc_directory,
        network=d2d_network,
    )

    node.first_run_setup("sancho@example.com", "passphrase456")
    node.create_persona("social", PersonaType.SOCIAL, "open")

    code = node.generate_pairing_code()
    node.pair_device(code, DeviceType.RICH_CLIENT)

    # Contacts — pushes to real Go Core via POST /v1/contacts
    node.add_contact("did:plc:alonso", "Don Alonso", TrustRing.RING_2_VERIFIED)

    node.set_sharing_policy("did:plc:alonso",
                            presence="eta_only", context="full",
                            preferences="full")

    # Vault context
    node.vault_store("general", "mother_health",
                     {"status": "was ill 3 weeks ago"})
    node.vault_store("general", "tea_preference",
                     {"preference": "strong chai"})

    return node


@pytest.fixture(scope="session")
def chairmaker(plc_directory, d2d_network, docker_services, _core_private_keys) -> HomeNode:
    """ChairMaker -- Seller (Trust Ring 3).

    RealHomeNode backed by real Go Core + Brain (Ed25519 signed).
    """
    node = RealHomeNode(
        core_url=docker_services.core_url("chairmaker"),
        brain_url=docker_services.brain_url("chairmaker"),
        client_token=docker_services.client_token,
        core_private_key_pem=_core_private_keys.get("chairmaker"),
        did="did:plc:chairmaker",
        display_name="ChairMaker",
        trust_ring=TrustRing.RING_3_SKIN_IN_GAME,
        plc=plc_directory,
        network=d2d_network,
    )

    node.first_run_setup("chairmaker@example.com", "passphrase789")
    node.create_persona("business", PersonaType.BUSINESS, "open")

    # Business context
    node.vault_store("business", "product_aeron",
                     {"product": "Herman Miller Aeron", "price": 72000,
                      "currency": "INR", "available": True})
    node.vault_store("business", "business_stats",
                     {"transactions": 50, "since": 2023, "avg_rating": 91})
    return node


@pytest.fixture(scope="session")
def albert(plc_directory, d2d_network, docker_services, _core_private_keys) -> HomeNode:
    """Albert -- Estate Beneficiary (Trust Ring 2).

    RealHomeNode backed by real Go Core + Brain (Ed25519 signed).
    """
    node = RealHomeNode(
        core_url=docker_services.core_url("albert"),
        brain_url=docker_services.brain_url("albert"),
        client_token=docker_services.client_token,
        core_private_key_pem=_core_private_keys.get("albert"),
        did="did:plc:albert",
        display_name="Albert",
        trust_ring=TrustRing.RING_2_VERIFIED,
        plc=plc_directory,
        network=d2d_network,
    )

    node.first_run_setup("albert@example.com", "passphrase_albert")

    # Contacts — pushes to real Go Core via POST /v1/contacts
    node.add_contact("did:plc:alonso", "Don Alonso", TrustRing.RING_2_VERIFIED)

    return node


# ---------------------------------------------------------------------------
# MCP Agent fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def openclaw() -> MockOpenClaw:
    """OpenClaw — Task agent for Gmail, Calendar, forms, web search."""
    oc = MockOpenClaw()

    # Pre-populate Gmail with 5000 emails
    emails = []
    categories = ["PRIMARY", "PROMOTIONS", "SOCIAL", "UPDATES", "FORUMS"]
    for i in range(50):  # 50 emails for mock (scale concept preserved)
        cat = categories[i % len(categories)]
        emails.append({
            "id": f"email_{i:04d}",
            "subject": f"Test email {i}" if cat == "PRIMARY" else f"Promo {i}",
            "sender": f"sender{i}@example.com" if cat == "PRIMARY" else f"noreply@promo{i}.com",
            "category": cat,
            "timestamp": time.time() - (i * 3600),
            "body": f"Body of email {i}. Contains some text about products and meetings.",
        })
    oc.gmail.add_emails(emails)

    # Calendar events
    now = time.time()
    oc.calendar.add_events([
        {"id": "cal_001", "title": "Meeting with Sancho",
         "start": now + 14400, "end": now + 18000,
         "attendees": ["sancho@example.com"], "location": "Office"},
        {"id": "cal_002", "title": "License renewal deadline",
         "start": now + 7 * 86400, "end": now + 7 * 86400 + 3600,
         "attendees": [], "location": ""},
    ])

    # Web search results
    oc.add_web_results("best office chair", [
        {"title": "Steelcase Leap Review", "url": "https://example.com/leap"},
        {"title": "Herman Miller Aeron", "url": "https://example.com/aeron"},
    ])

    return oc


@pytest.fixture(scope="session")
def reviewbot() -> MockReviewBot:
    """ReviewBot — Specialist review bot (trust score 94)."""
    bot = MockReviewBot(trust_score=94)
    bot.add_product_response("ergonomic chair", {
        "recommendations": [
            {
                "product": "Herman Miller Aeron",
                "score": 92,
                "sources": [
                    {
                        "type": "expert",
                        "creator_name": "MKBHD",
                        "source_url": "https://youtube.com/watch?v=abc123",
                        "deep_link": "https://youtube.com/watch?v=abc123&t=260",
                        "deep_link_context": "battery stress test at 4:20",
                    },
                ],
            },
            {
                "product": "Steelcase Leap",
                "score": 88,
                "sources": [],
            },
        ],
    })
    bot.add_product_response("office chair", {
        "recommendations": [
            {"product": "Herman Miller Aeron", "score": 92, "sources": []},
        ],
    })
    return bot


@pytest.fixture(scope="session")
def malicious_bot() -> MockMaliciousBot:
    """MaliciousBot — Untrusted bot (trust score 12)."""
    return MockMaliciousBot()


# ---------------------------------------------------------------------------
# Per-test reset fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def cli_identity(tmp_path_factory):
    """Generate a CLIIdentity keypair for E2E signing tests."""
    from dina_cli.signing import CLIIdentity
    identity_dir = tmp_path_factory.mktemp("cli_identity")
    identity = CLIIdentity(identity_dir=identity_dir)
    identity.generate()
    return identity


@pytest.fixture(autouse=True)
def reset_node_state(don_alonso, sancho, chairmaker, albert):
    """Reset per-test mutable state while preserving session setup.

    Cleared: notifications, briefing queue, DND, brain crash flag,
    rate limits, dedup set, spool, vault lock, audit log, KV store,
    tasks, staging, outbox, scratchpad, brain event/crash logs,
    PDS records/tombstones, test clock.

    Preserved: vault data, devices, contacts, sharing policies,
    personas, estate plan, identity, LLM responses.
    """
    for node in [don_alonso, sancho, chairmaker, albert]:
        # Clear real Go Core KV state if backed by Docker
        if isinstance(node, RealHomeNode):
            node.clear_real_kv()
        node.notifications.clear()
        node.briefing_queue.clear()
        node.dnd_active = False
        node._brain_crashed = False
        node._request_counts.clear()
        node._seen_msg_ids.clear()
        node.spool.clear()
        node._vault_locked = False
        node.audit_log.clear()
        node.kv_store.clear()
        node.tasks.clear()
        node.staging.clear()
        node.outbox.clear()
        node.scratchpad.clear()
        node._processed_events.clear()
        node._crash_log.clear()
        node._revoked_agents.clear()
        node._deferred_queue.clear()
        node.pds.records.clear()
        node.pds.tombstones.clear()
        node._test_clock = None
    yield


@pytest.fixture
def fresh_don_alonso(request, plc_directory, d2d_network) -> HomeNode:
    """A fresh Don Alonso node for tests that need clean state.

    WARNING: Always a mock HomeNode (not RealHomeNode). Tests using this
    fixture exercise in-memory mock behavior, not real Go Core APIs.
    This means assertions in these tests validate mock logic only.

    TODO: Move tests that depend on this fixture to tests/integration/
    or create a lightweight RealHomeNode pool for clean-state scenarios.
    """
    import warnings
    warnings.warn(
        f"{request.node.nodeid}: uses fresh_don_alonso (mock HomeNode, "
        f"not backed by real Go Core)",
        stacklevel=1,
    )
    node = HomeNode(
        did=f"did:plc:alonso_fresh_{id(object())}",
        display_name="Don Alonso (fresh)",
        trust_ring=TrustRing.RING_3_SKIN_IN_GAME,
        plc=plc_directory,
        network=d2d_network,
    )
    return node
