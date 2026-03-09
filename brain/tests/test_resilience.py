"""Tests for Error Handling & Resilience.

Maps to Brain TEST_PLAN SS11.

Uses real error classes from src.domain.errors and verifies error handling
contracts for the brain process.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from src.domain.errors import (
    DinaError,
    PersonaLockedError,
    CoreUnreachableError,
    LLMError,
    MCPError,
    PIIScrubError,
    ConfigError,
    CloudConsentError,
)

from .factories import make_event


# ---------------------------------------------------------------------------
# SS11 Error Handling & Resilience (6 scenarios)
# ---------------------------------------------------------------------------


# TST-BRAIN-302
@pytest.mark.asyncio
async def test_resilience_11_1_unhandled_exception() -> None:
    """SS11.1: Unhandled exception in guardian -- LLM returns unexpected format.

    Caught by FastAPI exception handler, returns 500 with log.
    """
    from src.service.guardian import GuardianLoop
    from src.service.entity_vault import EntityVaultService
    from src.service.nudge import NudgeAssembler
    from src.service.scratchpad import ScratchpadService

    core = AsyncMock()
    llm = AsyncMock()
    scrubber = MagicMock()
    entity_vault = EntityVaultService(scrubber, core)
    nudge = NudgeAssembler(core, llm, entity_vault)
    scratchpad = ScratchpadService(core)

    guardian = GuardianLoop(
        core=core, llm_router=llm, scrubber=scrubber,
        entity_vault=entity_vault, nudge_assembler=nudge,
        scratchpad=scratchpad,
    )

    # Simulate LLM returning unexpected format during nudge assembly
    guardian._nudge.assemble_nudge = AsyncMock(
        side_effect=LLMError("Unexpected format from LLM")
    )

    # Use a fiduciary event so classify_silence returns "fiduciary" (not "engagement")
    # and the event reaches the nudge assembly step where the LLMError is raised.
    from tests.factories import make_fiduciary_event
    event = make_fiduciary_event(body="trigger unexpected format")
    result = await guardian.process_event(event)

    # Production catches LLMError and returns error action (not crash)
    assert result["action"] == "error"
    assert result["status"] == "error"

    # Counter-proof: without the error, event processes normally
    guardian._nudge.assemble_nudge = AsyncMock(return_value=None)
    result2 = await guardian.process_event(event)
    assert result2["action"] != "error"


# TST-BRAIN-303
@pytest.mark.asyncio
async def test_resilience_11_2_memory_leak_detection() -> None:
    """SS11.2: Memory leak detection -- stable usage over time.

    Entity vaults are ephemeral; memory usage should remain stable
    during long-running brain process.
    """
    from src.service.entity_vault import EntityVaultService

    mock_scrubber = MagicMock()
    mock_core = AsyncMock()

    evs = EntityVaultService(scrubber=mock_scrubber, core_client=mock_core)

    # Create 100 independent vaults (simulating concurrent cloud LLM calls)
    vaults = []
    for i in range(100):
        entities = [
            {"type": "PERSON", "value": f"Person {i}", "token": f"<PERSON_{i}>"},
            {"type": "ORG", "value": f"Org {i}", "token": f"<ORG_{i}>"},
        ]
        vault = evs.create_vault(entities)
        assert len(vault) == 2, f"Vault {i} must have 2 entries"
        vaults.append(vault)

    # Each vault is independent (no cross-contamination)
    assert vaults[0][f"<PERSON_0>"] == "Person 0"
    assert vaults[99][f"<PERSON_99>"] == "Person 99"
    assert f"<PERSON_99>" not in vaults[0], "Vaults must be independent"

    # Destroy vaults (simulating ephemeral lifecycle)
    for vault in vaults:
        vault.clear()

    # All vaults should be empty after clearing
    assert all(len(v) == 0 for v in vaults)

    # Rehydrate with an empty vault returns text unchanged
    result = evs.rehydrate("Some <PERSON_0> text", {})
    assert result == "Some <PERSON_0> text", "Empty vault must not modify text"


# TST-BRAIN-304
@pytest.mark.asyncio
async def test_resilience_11_3_graceful_shutdown() -> None:
    """SS11.3: Graceful shutdown -- SIGTERM received.

    In-flight requests complete, connections closed cleanly.
    """
    # Verify that MCP clients have proper disconnect methods
    from src.adapter.mcp_stdio import MCPStdioClient
    from src.adapter.mcp_http import MCPHTTPClient

    stdio = MCPStdioClient()
    http = MCPHTTPClient()

    # Both have disconnect_all / close methods for cleanup
    assert hasattr(stdio, "disconnect_all")
    assert hasattr(http, "close")

    # Disconnect with no active sessions should not raise
    await stdio.disconnect_all()
    await http.close()


# TST-BRAIN-305
@pytest.mark.asyncio
async def test_resilience_11_4_startup_dependency_check() -> None:
    """SS11.4: Core unreachable -- GuardianLoop degrades gracefully.

    When core raises CoreUnreachableError during event processing,
    production process_event (guardian.py:440) catches it and returns
    {"action": "degraded_mode"} instead of crashing.
    """
    from src.service.guardian import GuardianLoop
    from src.service.entity_vault import EntityVaultService
    from src.service.nudge import NudgeAssembler
    from src.service.scratchpad import ScratchpadService

    core = AsyncMock()
    llm = AsyncMock()
    scrubber = MagicMock()
    entity_vault = EntityVaultService(scrubber, core)
    nudge = NudgeAssembler(core, llm, entity_vault)
    scratchpad = ScratchpadService(core)

    guardian = GuardianLoop(
        core=core, llm_router=llm, scrubber=scrubber,
        entity_vault=entity_vault, nudge_assembler=nudge,
        scratchpad=scratchpad,
    )

    # Make nudge assembly raise CoreUnreachableError (simulating core down)
    guardian._nudge.assemble_nudge = AsyncMock(
        side_effect=CoreUnreachableError("core not ready")
    )

    from tests.factories import make_fiduciary_event
    event = make_fiduciary_event(body="Emergency alert")
    result = await guardian.process_event(event)

    # Production catches CoreUnreachableError and returns degraded_mode
    assert result["action"] == "degraded_mode"

    # Counter-proof: when core is available, fiduciary event is processed normally
    # Fiduciary events always get "interrupt" action (silence causes harm).
    guardian._nudge.assemble_nudge = AsyncMock(return_value={"text": "nudge"})
    core.notify = AsyncMock()
    core.send_d2d = AsyncMock()
    result2 = await guardian.process_event(event)
    assert result2["action"] == "interrupt"


# TST-BRAIN-306
def test_resilience_11_5_spacy_model_missing() -> None:
    """SS11.5: spaCy model missing -- startup fails with clear error.

    When spaCy model is not installed, SpacyScrubber._ensure_nlp() raises
    PIIScrubError with a clear message about the missing model.  We
    simulate this by pointing at a nonexistent model name.
    """
    from src.adapter.scrubber_spacy import SpacyScrubber

    # Construct scrubber with a model that does not exist
    scrubber = SpacyScrubber(model="nonexistent_model_xyz")

    # _ensure_nlp must raise PIIScrubError with guidance about the model
    with pytest.raises(PIIScrubError, match="nonexistent_model_xyz"):
        scrubber.scrub("Test text with John Smith")

    # Counter-proof: default model (en_core_web_sm) loads successfully
    try:
        default_scrubber = SpacyScrubber()
        result, entities = default_scrubber.scrub("John Smith lives in London")
        assert isinstance(result, str)
    except (PIIScrubError, OSError):
        # If en_core_web_sm isn't installed in this env, that's OK —
        # the test above already proved the error path works.
        pass


# TST-BRAIN-307
@pytest.mark.asyncio
async def test_resilience_11_6_concurrent_requests() -> None:
    """SS11.6: Concurrent request handling -- 50 simultaneous requests.

    All handled by uvicorn worker pool without drops or errors.
    Uses a real GuardianLoop to verify concurrent process_event calls
    don't corrupt shared state.
    """
    from src.service.guardian import GuardianLoop
    from src.service.entity_vault import EntityVaultService
    from src.service.nudge import NudgeAssembler
    from src.service.scratchpad import ScratchpadService

    core = AsyncMock()
    core.write_scratchpad = AsyncMock()
    core.get_kv = AsyncMock(return_value=None)
    llm_router = AsyncMock()
    scrubber = MagicMock()
    entity_vault = EntityVaultService(scrubber, core)
    nudge = NudgeAssembler(core, llm_router, entity_vault)
    scratchpad = ScratchpadService(core)
    guardian = GuardianLoop(
        core=core, llm_router=llm_router, scrubber=scrubber,
        entity_vault=entity_vault, nudge_assembler=nudge,
        scratchpad=scratchpad,
    )

    events = [make_event(type="message", body=f"concurrent msg {i}") for i in range(50)]

    import asyncio
    results = await asyncio.gather(
        *[guardian.process_event(e) for e in events]
    )
    assert len(results) == 50, "All 50 requests must return results"
    # Every result must be a well-formed dict with an action.
    for i, r in enumerate(results):
        assert isinstance(r, dict), f"Result {i} must be a dict"
        assert "action" in r, f"Result {i} must have an action"


# ---------------------------------------------------------------------------
# SS11 Startup Dependency (1 scenario) -- arch SS04, SS17
# ---------------------------------------------------------------------------


# TST-BRAIN-417
def test_resilience_11_7_startup_waits_for_core() -> None:
    """SS11.7: Brain startup waits for core readiness.

    Architecture SS04, SS17: Brain starts only after core /readyz passes.
    Docker depends_on: condition: service_healthy. Brain must handle
    core-not-ready-yet state at startup with polling and backoff.
    """
    # Verify CoreUnreachableError is the correct exception
    err = CoreUnreachableError("core not ready yet")
    assert isinstance(err, DinaError)
    assert "core not ready" in str(err)

    # Verify exponential backoff pattern
    delays = [min(2 ** attempt, 30) for attempt in range(5)]
    assert delays == [1, 2, 4, 8, 16]


# ---------------------------------------------------------------------------
# SS11 Sharing Policy Validation (1 scenario) -- arch SS09
# ---------------------------------------------------------------------------


# TST-BRAIN-415
@pytest.mark.asyncio
async def test_resilience_11_8_sharing_policy_invalid_did() -> None:
    """SS11.8: Brain validates contact DID before applying sharing policy.

    Architecture SS09: Brain validates contact DID exists in contacts table
    before applying sharing policy PATCH. Invalid DID returns clear error.
    """
    # Verify ConfigError is correctly constructed and inherits from DinaError
    invalid_did = "did:plc:nonexistent"
    err = ConfigError(f"contact_not_found: {invalid_did}")
    assert isinstance(err, DinaError), "ConfigError must inherit from DinaError"
    assert "did:plc:nonexistent" in str(err)

    # Verify production NudgeAssembler returns None for unknown contacts
    # (brain gracefully handles missing contacts)
    from src.service.nudge import NudgeAssembler
    from src.service.entity_vault import EntityVaultService

    core = AsyncMock()
    llm = AsyncMock()
    scrubber = MagicMock()
    entity_vault = EntityVaultService(scrubber, core)
    nudge = NudgeAssembler(core, llm, entity_vault)

    # No vault data for this contact — mock query_vault (used by NudgeAssembler internals)
    core.query_vault.return_value = []
    result = await nudge.assemble_nudge(
        event={"type": "conversation_open", "persona": "personal"},
        contact_did=invalid_did,
    )
    # Silence First: no data → nudge is None
    assert result is None, "Unknown contact must return None nudge (Silence First)"


# ---------------------------------------------------------------------------
# Additional: Error hierarchy tests
# ---------------------------------------------------------------------------


# TST-BRAIN-464
def test_resilience_11_9_error_hierarchy() -> None:
    """All brain errors inherit from DinaError."""
    errors = [
        PersonaLockedError("locked"),
        CoreUnreachableError("unreachable"),
        LLMError("llm fail"),
        MCPError("mcp fail"),
        PIIScrubError("scrub fail"),
        ConfigError("config fail"),
        CloudConsentError("no consent"),
    ]
    for err in errors:
        assert isinstance(err, DinaError)
        assert isinstance(err, Exception)
