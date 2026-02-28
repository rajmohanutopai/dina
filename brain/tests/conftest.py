"""Pytest fixtures and mock factories for dina-brain tests.

Provides mock implementations of all contracts.  Real implementations are
loaded via the fixture-swap pattern: try the real import, fall back to mock
on ImportError or missing optional deps (e.g. spacy).
"""

from __future__ import annotations

import sys
from unittest.mock import AsyncMock, MagicMock

import pytest

from .factories import (
    TEST_BRAIN_TOKEN,
    TEST_CLIENT_TOKEN,
    make_llm_response,
    make_vault_item,
    make_contact,
    make_device,
    make_persona,
    make_system_status,
    make_activity_entry,
    make_embedding,
)

# Ensure brain src is importable when running tests from the brain/ directory.
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[1] / "src"))


# ---------- Auth ----------


@pytest.fixture
def brain_token() -> str:
    """Deterministic BRAIN_TOKEN for testing."""
    return TEST_BRAIN_TOKEN


@pytest.fixture
def client_token() -> str:
    """Deterministic CLIENT_TOKEN for testing."""
    return TEST_CLIENT_TOKEN


# ---------- Guardian Loop ----------


@pytest.fixture
def mock_guardian() -> AsyncMock:
    """Mock guardian that classifies everything as 'engagement'."""
    guardian = AsyncMock()
    guardian.classify_silence.return_value = "engagement"
    guardian.process_event.return_value = {"action": "save_for_briefing"}
    return guardian


@pytest.fixture
def guardian(mock_guardian, mock_core_client, mock_llm_router, mock_pii_scrubber):
    """Real GuardianLoop wired with mock dependencies, falls back to pure mock."""
    try:
        from src.service.guardian import GuardianLoop
        from src.service.entity_vault import EntityVaultService
        from src.service.nudge import NudgeAssembler
        from src.service.scratchpad import ScratchpadService

        entity_vault = EntityVaultService(mock_pii_scrubber, mock_core_client)
        nudge = NudgeAssembler(mock_core_client)
        scratchpad = ScratchpadService(mock_core_client)

        return GuardianLoop(
            core=mock_core_client,
            llm_router=mock_llm_router,
            scrubber=mock_pii_scrubber,
            entity_vault=entity_vault,
            nudge_assembler=nudge,
            scratchpad=scratchpad,
        )
    except (ImportError, TypeError):
        return mock_guardian


# ---------- PII Scrubber ----------


@pytest.fixture
def mock_pii_scrubber() -> MagicMock:
    """Mock PII scrubber that does basic token replacement."""
    scrubber = MagicMock()
    scrubber.scrub.return_value = ("[PERSON_1] at [ORG_1]", [
        {"type": "PERSON", "value": "Dr. Sharma", "token": "[PERSON_1]"},
        {"type": "ORG", "value": "Apollo Hospital", "token": "[ORG_1]"},
    ])
    scrubber.detect.return_value = [
        {"type": "PERSON", "value": "Dr. Sharma"},
        {"type": "ORG", "value": "Apollo Hospital"},
    ]
    return scrubber


@pytest.fixture
def pii_scrubber(mock_pii_scrubber):
    """Real PresidioScrubber if presidio is installed, else SpacyScrubber, else mock."""
    try:
        from src.adapter.scrubber_presidio import PresidioScrubber
        return PresidioScrubber()
    except (ImportError, OSError):
        try:
            from src.adapter.scrubber_spacy import SpacyScrubber
            return SpacyScrubber()
        except (ImportError, OSError):
            return mock_pii_scrubber


@pytest.fixture
def domain_classifier():
    """DomainClassifier for sensitivity classification tests."""
    try:
        from src.service.domain_classifier import DomainClassifier
        return DomainClassifier()
    except ImportError:
        pytest.skip("DomainClassifier not importable")


# ---------- LLM Router ----------


@pytest.fixture
def mock_llm_router() -> AsyncMock:
    """Mock LLM router that returns a canned response."""
    router = AsyncMock()
    router.route.return_value = make_llm_response()
    router.available_models.return_value = ["test-model-local", "test-model-cloud"]
    return router


@pytest.fixture
def mock_llm_client() -> AsyncMock:
    """Mock LLM client for direct model calls."""
    client = AsyncMock()
    client.complete.return_value = make_llm_response()
    return client


# ---------- Sync Engine ----------


@pytest.fixture
def mock_sync_engine() -> AsyncMock:
    """Mock sync engine for ingestion testing."""
    engine = AsyncMock()
    engine.ingest.return_value = "item-001"
    engine.dedup.return_value = False  # not a duplicate
    engine.get_cursor.return_value = "2026-01-01T00:00:00Z"
    engine.set_cursor.return_value = None
    return engine


@pytest.fixture
def sync_engine(mock_sync_engine, mock_core_client, mock_mcp_client):
    """Real SyncEngine wired with mock dependencies."""
    try:
        from src.service.sync_engine import SyncEngine
        return SyncEngine(core=mock_core_client, mcp=mock_mcp_client)
    except (ImportError, TypeError):
        return mock_sync_engine


@pytest.fixture
def mock_sync_scheduler() -> AsyncMock:
    """Mock sync scheduler."""
    scheduler = AsyncMock()
    scheduler.schedule.return_value = None
    scheduler.trigger_now.return_value = None
    scheduler.stop.return_value = None
    return scheduler


# ---------- MCP Client ----------


@pytest.fixture
def mock_mcp_client() -> AsyncMock:
    """Mock MCP client for agent delegation."""
    client = AsyncMock()
    client.call_tool.return_value = {"result": "success"}
    client.list_tools.return_value = [
        {"name": "gmail_fetch", "description": "Fetch emails"},
        {"name": "calendar_read", "description": "Read calendar"},
    ]
    client.disconnect.return_value = None
    return client


# ---------- Core Client ----------


@pytest.fixture
def mock_core_client() -> AsyncMock:
    """Mock core client for vault/scratchpad operations."""
    client = AsyncMock()
    client.health.return_value = {"status": "ok"}
    client.get_vault_item.return_value = make_vault_item()
    client.store_vault_item.return_value = "item-001"
    client.store_vault_batch.return_value = None
    client.search_vault.return_value = [make_vault_item()]
    client.write_scratchpad.return_value = None
    client.read_scratchpad.return_value = None
    client.get_kv.return_value = "2026-01-01T00:00:00Z"
    client.set_kv.return_value = None
    return client


# ---------- Agent Router ----------


@pytest.fixture
def mock_agent_router() -> AsyncMock:
    """Mock agent router for task delegation."""
    router = AsyncMock()
    router.route_task.return_value = {"handler": "local_llm", "result": "Task completed"}
    router.check_trust.return_value = 0.85
    return router


# ---------- Silence Classifier ----------


@pytest.fixture
def mock_silence_classifier() -> AsyncMock:
    """Mock silence classifier for edge case testing."""
    classifier = AsyncMock()
    classifier.classify.return_value = {
        "priority": "engagement",
        "reason": "non-urgent notification",
        "action": "save_for_briefing",
    }
    classifier.apply_dnd.return_value = {
        "priority": "engagement",
        "deferred": True,
        "action": "defer_until_dnd_ends",
    }
    return classifier


# ---------- Admin Client ----------


@pytest.fixture
def mock_admin_client() -> AsyncMock:
    """Mock admin client for admin UI tests."""
    client = AsyncMock()
    # Dashboard
    client.get_system_status.return_value = make_system_status()
    client.get_recent_activity.return_value = [
        make_activity_entry(action=f"action_{i}") for i in range(10)
    ]
    # Contacts
    client.list_contacts.return_value = [make_contact()]
    client.add_contact.return_value = make_contact()
    client.update_contact.return_value = make_contact(sharing_tier="locked")
    client.remove_contact.return_value = None
    # Devices
    client.list_devices.return_value = [make_device()]
    client.initiate_pairing.return_value = {"pairing_code": "ABCD-1234"}
    client.revoke_device.return_value = None
    # Personas
    client.list_personas.return_value = [make_persona()]
    client.create_persona.return_value = make_persona(persona_id="work", tier="locked")
    client.update_persona_tier.return_value = make_persona(tier="locked")
    client.delete_persona.return_value = None
    return client


# ---------- Embedding Client ----------


@pytest.fixture
def mock_embedding_client() -> AsyncMock:
    """Mock embedding client for embedding generation tests."""
    client = AsyncMock()
    client.embed.return_value = make_embedding()
    client.embed_batch.return_value = [make_embedding(source_id=f"src_{i}") for i in range(3)]
    client.available.return_value = True
    return client


@pytest.fixture
def mock_embedding_client_unavailable() -> AsyncMock:
    """Mock embedding client that is unreachable."""
    client = AsyncMock()
    client.embed.side_effect = ConnectionError("Embedding service unavailable")
    client.available.return_value = False
    return client


# ---------- Config ----------


@pytest.fixture
def brain_config() -> dict:
    """Default brain configuration for testing."""
    return {
        "CORE_URL": "http://core:8300",
        "BRAIN_TOKEN": TEST_BRAIN_TOKEN,
        "LISTEN_PORT": 8200,
        "LOG_LEVEL": "INFO",
    }


@pytest.fixture
def real_brain_config(monkeypatch):
    """Load real BrainConfig from environment (with test defaults)."""
    monkeypatch.setenv("DINA_BRAIN_TOKEN", TEST_BRAIN_TOKEN)
    monkeypatch.setenv("DINA_CORE_URL", "http://core:8300")
    try:
        from src.infra.config import load_brain_config
        return load_brain_config()
    except ImportError:
        pytest.skip("src.infra.config not importable")
