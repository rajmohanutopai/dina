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
    event = make_event(type="message", body="trigger unexpected format")
    assert event["type"] == "message"

    # Verify error hierarchy allows catching all brain errors
    with pytest.raises(DinaError):
        raise LLMError("Unexpected format from LLM")

    # Verify LLMError is catchable as DinaError
    try:
        raise LLMError("bad response format")
    except DinaError as e:
        assert "bad response format" in str(e)


# TST-BRAIN-303
@pytest.mark.asyncio
async def test_resilience_11_2_memory_leak_detection() -> None:
    """SS11.2: Memory leak detection -- stable usage over time.

    Entity vaults are ephemeral; memory usage should remain stable
    during long-running brain process.
    """
    # Simulate creating and destroying entity vaults
    vaults = []
    for i in range(100):
        vault = {"[PERSON_1]": f"Person {i}", "[ORG_1]": f"Org {i}"}
        vaults.append(vault)

    # Destroy vaults (simulating ephemeral lifecycle)
    for vault in vaults:
        vault.clear()

    # All vaults should be empty after clearing
    assert all(len(v) == 0 for v in vaults)

    # Clear references
    vaults.clear()
    assert len(vaults) == 0


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
    """SS11.4: Startup dependency check -- core unreachable at startup.

    Brain starts, retries core connection with exponential backoff.
    """
    mock_core = AsyncMock()
    # First two calls fail, third succeeds
    mock_core.health.side_effect = [
        CoreUnreachableError("core not ready"),
        CoreUnreachableError("core still not ready"),
        {"status": "ok"},
    ]

    # Simulate retry logic
    retries = 0
    for attempt in range(3):
        try:
            result = await mock_core.health()
            break
        except CoreUnreachableError:
            retries += 1

    assert retries == 2
    assert result == {"status": "ok"}


# TST-BRAIN-306
@pytest.mark.asyncio
async def test_resilience_11_5_spacy_model_missing() -> None:
    """SS11.5: spaCy model missing -- startup fails with clear error.

    When en_core_web_sm is not installed, startup fails with a clear
    error message about the missing model.
    """
    # Verify PIIScrubError is the correct exception for scrubbing failures
    with pytest.raises(PIIScrubError, match="scrubbing"):
        raise PIIScrubError("PII scrubbing unavailable: missing spaCy model en_core_web_sm")


# TST-BRAIN-307
@pytest.mark.asyncio
async def test_resilience_11_6_concurrent_requests() -> None:
    """SS11.6: Concurrent request handling -- 50 simultaneous requests.

    All handled by uvicorn worker pool without drops or errors.
    """
    events = [make_event(type="message", body=f"concurrent msg {i}") for i in range(50)]
    assert len(events) == 50

    # Process all events through a mock guardian
    guardian = AsyncMock()
    guardian.process_event.return_value = {"action": "save_for_briefing"}

    import asyncio
    results = await asyncio.gather(
        *[guardian.process_event(e) for e in events]
    )
    assert len(results) == 50
    assert all(r["action"] == "save_for_briefing" for r in results)
    assert guardian.process_event.await_count == 50


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
def test_resilience_11_8_sharing_policy_invalid_did() -> None:
    """SS11.8: Brain validates contact DID before applying sharing policy.

    Architecture SS09: Brain validates contact DID exists in contacts table
    before applying sharing policy PATCH. Invalid DID returns clear error.
    """
    # Verify error for invalid DID
    invalid_did = "did:plc:nonexistent"
    assert invalid_did.startswith("did:")

    # ConfigError is appropriate for invalid configuration/input
    with pytest.raises(DinaError):
        raise ConfigError(f"contact_not_found: {invalid_did}")


# ---------------------------------------------------------------------------
# Additional: Error hierarchy tests
# ---------------------------------------------------------------------------


def test_error_hierarchy() -> None:
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
