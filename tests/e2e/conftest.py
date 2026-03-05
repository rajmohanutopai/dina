"""Shared pytest fixtures for Dina E2E tests.

Sets up the multi-node environment with named actors:
- Don Alonso (primary user), Sancho (friend), ChairMaker (seller),
  Albert (estate beneficiary), Dr. Carl (doctor contact)
- Mock services: PLC Directory, D2D network, OpenClaw, ReviewBot,
  MaliciousBot, AppView, Relay, FCM, Payment Gateway

Docker-only: requires DINA_E2E=docker and running Docker containers
(docker-compose-e2e.yml) for ALL 4 actors.  Each actor gets its own
Core+Brain container pair.  test_status.py manages the Docker lifecycle.
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

    Only active when DINA_E2E=docker.  Session-scoped so containers
    are started once and shared across all tests.  Uses the multi-node
    stack (4 Core+Brain pairs: alonso, sancho, chairmaker, albert).
    """
    if not DOCKER_MODE:
        yield None
        return

    svc = MultiNodeDockerServices()
    svc.start()
    yield svc
    svc.stop()


# ---------------------------------------------------------------------------
# Docker persona initialization (session-scoped)
# ---------------------------------------------------------------------------

_ALL_PERSONAS = [
    "personal", "health", "financial", "consumer",
    "professional", "social", "business",
]


@pytest.fixture(scope="session", autouse=True)
def e2e_persona_setup(docker_services):
    """Create and unlock personas on ALL real Go Core instances once per session.

    Iterates over all 4 actors (alonso, sancho, chairmaker, albert) and
    creates/unlocks every persona on each node.  Also clears vault data
    from prior runs via POST /v1/vault/clear.

    Uses CLIENT_TOKEN for persona and vault operations, respecting the
    authz model.
    Only active in Docker mode.
    """
    if not DOCKER_MODE or docker_services is None:
        return

    import httpx

    # Persona create/unlock are admin-only → require CLIENT_TOKEN.
    # Vault clear also uses CLIENT_TOKEN in E2E test mode.
    admin_headers = {"Authorization": f"Bearer {docker_services.client_token}"}
    data_headers = {"Authorization": f"Bearer {docker_services.client_token}"}

    for actor in ["alonso", "sancho", "chairmaker", "albert"]:
        base = docker_services.core_url(actor)

        for name in _ALL_PERSONAS:
            httpx.post(
                f"{base}/v1/personas",
                json={"name": name, "tier": "open", "passphrase": "test"},
                headers=admin_headers, timeout=10,
            )
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
    """D2D delivery between Home Nodes.

    In Docker mode: RealD2DNetwork backed by real HTTP calls between
    Core containers.  In mock mode: MockD2DNetwork (in-memory).
    """
    if DOCKER_MODE and docker_services is not None:
        did_to_core_url = {
            "did:plc:alonso": docker_services.core_url("alonso"),
            "did:plc:sancho": docker_services.core_url("sancho"),
            "did:plc:chairmaker": docker_services.core_url("chairmaker"),
            "did:plc:albert": docker_services.core_url("albert"),
        }
        return RealD2DNetwork(did_to_core_url, docker_services.client_token)
    return MockD2DNetwork()


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
def don_alonso(plc_directory, d2d_network, docker_services) -> HomeNode:
    """Don Alonso — Primary User (Trust Ring 3).

    In Docker mode: RealHomeNode (vault/persona/KV/health hit real Go Core).
    In mock mode: regular HomeNode (pure in-memory).
    """
    if DOCKER_MODE and docker_services is not None:
        node = RealHomeNode(
            core_url=docker_services.core_url("alonso"),
            brain_url=docker_services.brain_url("alonso"),
            client_token=docker_services.client_token,
            did="did:plc:alonso",
            display_name="Don Alonso",
            trust_ring=TrustRing.RING_3_SKIN_IN_GAME,
            plc=plc_directory,
            network=d2d_network,
        )
    else:
        node = HomeNode(
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

    # Contacts — in Docker mode, also pushes to real Go Core via POST /v1/contacts
    if DOCKER_MODE and hasattr(node, "add_contact"):
        node.add_contact("did:plc:sancho", "Sancho", TrustRing.RING_2_VERIFIED)
        node.add_contact("did:plc:drcarl", "Dr. Carl", TrustRing.RING_2_VERIFIED)
        node.add_contact("did:plc:albert", "Albert", TrustRing.RING_2_VERIFIED)
        node.add_contact("did:plc:chairmaker", "ChairMaker", TrustRing.RING_3_SKIN_IN_GAME)
    else:
        node.contacts["did:plc:sancho"] = {
            "name": "Sancho", "ring": TrustRing.RING_2_VERIFIED,
        }
        node.contacts["did:plc:drcarl"] = {
            "name": "Dr. Carl", "ring": TrustRing.RING_2_VERIFIED,
        }
        node.contacts["did:plc:albert"] = {
            "name": "Albert", "ring": TrustRing.RING_2_VERIFIED,
        }
        node.contacts["did:plc:chairmaker"] = {
            "name": "ChairMaker", "ring": TrustRing.RING_3_SKIN_IN_GAME,
        }

    # Sharing policies
    node.set_sharing_policy("did:plc:sancho",
                            presence="eta_only", context="full",
                            availability="free_busy", preferences="full")
    node.set_sharing_policy("did:plc:drcarl", health="full")
    node.set_sharing_policy("did:plc:chairmaker", preferences="summary")

    # Pre-populate vault with context
    node.vault_store("personal", "sancho_last_visit",
                     {"event": "visit", "date": "3 weeks ago",
                      "context": "mother was ill"})
    node.vault_store("personal", "sancho_preferences",
                     {"tea": "strong chai", "relationship": "close friend"})
    node.vault_store("personal", "book_promise",
                     {"item": "The Little Prince", "for": "daughter",
                      "date": "last Tuesday"})

    # Estate plan
    node.set_estate_plan(EstatePlan(
        beneficiaries=[
            EstateBeneficiary(
                did="did:plc:albert",
                personas=["personal", "health"],
                access_level="full_decrypt",
            ),
        ],
        custodian_threshold=3,
        custodian_total=5,
        default_action="destroy",
    ))

    return node


@pytest.fixture(scope="session")
def sancho(plc_directory, d2d_network, docker_services) -> HomeNode:
    """Sancho -- Close Friend (Trust Ring 2).

    In Docker mode: RealHomeNode backed by real Go Core.
    In mock mode: regular HomeNode (pure in-memory).
    """
    if DOCKER_MODE and docker_services is not None:
        node = RealHomeNode(
            core_url=docker_services.core_url("sancho"),
            brain_url=docker_services.brain_url("sancho"),
            client_token=docker_services.client_token,
            did="did:plc:sancho",
            display_name="Sancho",
            trust_ring=TrustRing.RING_2_VERIFIED,
            plc=plc_directory,
            network=d2d_network,
        )
    else:
        node = HomeNode(
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

    # Contacts -- in Docker mode use add_contact for real API
    if DOCKER_MODE and hasattr(node, "add_contact"):
        node.add_contact("did:plc:alonso", "Don Alonso", TrustRing.RING_2_VERIFIED)
    else:
        node.contacts["did:plc:alonso"] = {
            "name": "Don Alonso", "ring": TrustRing.RING_2_VERIFIED,
        }

    node.set_sharing_policy("did:plc:alonso",
                            presence="eta_only", context="full",
                            preferences="full")

    # Vault context
    node.vault_store("personal", "mother_health",
                     {"status": "was ill 3 weeks ago"})
    node.vault_store("personal", "tea_preference",
                     {"preference": "strong chai"})

    return node


@pytest.fixture(scope="session")
def chairmaker(plc_directory, d2d_network, docker_services) -> HomeNode:
    """ChairMaker -- Seller (Trust Ring 3).

    In Docker mode: RealHomeNode backed by real Go Core.
    In mock mode: regular HomeNode (pure in-memory).
    """
    if DOCKER_MODE and docker_services is not None:
        node = RealHomeNode(
            core_url=docker_services.core_url("chairmaker"),
            brain_url=docker_services.brain_url("chairmaker"),
            client_token=docker_services.client_token,
            did="did:plc:chairmaker",
            display_name="ChairMaker",
            trust_ring=TrustRing.RING_3_SKIN_IN_GAME,
            plc=plc_directory,
            network=d2d_network,
        )
    else:
        node = HomeNode(
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
def albert(plc_directory, d2d_network, docker_services) -> HomeNode:
    """Albert -- Estate Beneficiary (Trust Ring 2).

    In Docker mode: RealHomeNode backed by real Go Core.
    In mock mode: regular HomeNode (pure in-memory).
    """
    if DOCKER_MODE and docker_services is not None:
        node = RealHomeNode(
            core_url=docker_services.core_url("albert"),
            brain_url=docker_services.brain_url("albert"),
            client_token=docker_services.client_token,
            did="did:plc:albert",
            display_name="Albert",
            trust_ring=TrustRing.RING_2_VERIFIED,
            plc=plc_directory,
            network=d2d_network,
        )
    else:
        node = HomeNode(
            did="did:plc:albert",
            display_name="Albert",
            trust_ring=TrustRing.RING_2_VERIFIED,
            plc=plc_directory,
            network=d2d_network,
        )

    node.first_run_setup("albert@example.com", "passphrase_albert")

    # Contacts -- in Docker mode use add_contact for real API
    if DOCKER_MODE and hasattr(node, "add_contact"):
        node.add_contact("did:plc:alonso", "Don Alonso", TrustRing.RING_2_VERIFIED)
    else:
        node.contacts["did:plc:alonso"] = {
            "name": "Don Alonso", "ring": TrustRing.RING_2_VERIFIED,
        }

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
    """Reset per-test mutable state while preserving session setup."""
    # Save and restore notification/audit state
    for node in [don_alonso, sancho, chairmaker, albert]:
        node.notifications.clear()
        node.briefing_queue.clear()
        node.dnd_active = False
        node._brain_crashed = False
        node._request_counts.clear()
        node._seen_msg_ids.clear()
        node.spool.clear()
        node._vault_locked = False
        # Keep vault data, devices, contacts, sharing policies
    yield


@pytest.fixture
def fresh_don_alonso(plc_directory, d2d_network) -> HomeNode:
    """A fresh Don Alonso node for tests that need clean state. Always mock."""
    node = HomeNode(
        did=f"did:plc:alonso_fresh_{id(object())}",
        display_name="Don Alonso (fresh)",
        trust_ring=TrustRing.RING_3_SKIN_IN_GAME,
        plc=plc_directory,
        network=d2d_network,
    )
    return node
