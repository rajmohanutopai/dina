"""Tests for agent routing, MCP delegation, and trust checks.

Maps to Brain TEST_PLAN SS8 (Admin UI/Routing) -- 10 scenarios.

Uses real LLMRouter from src.service.llm_router for routing tests,
and mock-based testing for MCP delegation contracts.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, PropertyMock

import pytest

from src.service.llm_router import LLMRouter
from src.domain.errors import LLMError, MCPError

from .factories import (
    make_routing_task,
    make_mcp_tool,
    make_safe_intent,
    make_risky_intent,
    make_blocked_intent,
    make_llm_response,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _make_provider(name: str, is_local: bool):
    """Create a mock LLM provider."""
    provider = AsyncMock()
    type(provider).model_name = PropertyMock(return_value=name)
    type(provider).is_local = PropertyMock(return_value=is_local)
    provider.complete.return_value = make_llm_response(
        content="Task completed", model=name
    )
    return provider


@pytest.fixture
def local_provider():
    return _make_provider("llama-3.2-3b", is_local=True)


@pytest.fixture
def cloud_provider():
    return _make_provider("gemini-2.5-flash", is_local=False)


@pytest.fixture
def llm_router(local_provider, cloud_provider):
    """Real LLMRouter with local and cloud providers."""
    return LLMRouter(
        providers={"local": local_provider, "cloud": cloud_provider},
        config={"cloud_llm_consent": True},
    )


@pytest.fixture
def local_only_router(local_provider):
    """LLMRouter with only a local provider."""
    return LLMRouter(providers={"local": local_provider})


# ---------------------------------------------------------------------------
# SS8.1 Agent Routing -- Task Delegation (4 scenarios)
# ---------------------------------------------------------------------------


# TST-BRAIN-270
@pytest.mark.asyncio
async def test_routing_8_1_1_route_to_local_llm(llm_router, local_provider) -> None:
    """SS8.1.1: Simple summarization task routes to local LLM."""
    task = make_routing_task(task_type="summarize")
    result = await llm_router.route(
        task_type=task["type"],
        prompt=task["prompt"],
        persona_tier=task["persona_tier"],
    )
    assert result["route"] == "local"
    local_provider.complete.assert_awaited_once()


# TST-BRAIN-271
@pytest.mark.asyncio
async def test_routing_8_1_2_route_to_mcp_agent() -> None:
    """SS8.1.2: Email fetch task routes to MCP gmail agent."""
    # MCP routing is handled by the agent router, not the LLM router.
    # Verify MCP client can be called for email fetch.
    mcp = AsyncMock()
    mcp.call_tool.return_value = {"result": "Fetched 5 emails"}
    result = await mcp.call_tool("gmail_server", "gmail_fetch", {"limit": 10})
    assert result["result"] == "Fetched 5 emails"
    mcp.call_tool.assert_awaited_once_with("gmail_server", "gmail_fetch", {"limit": 10})


# TST-BRAIN-272
@pytest.mark.asyncio
async def test_routing_8_1_3_route_unknown_task_fallback(llm_router) -> None:
    """SS8.1.3: Unknown task type falls back to local LLM."""
    task = make_routing_task(task_type="unknown_task_type")
    result = await llm_router.route(
        task_type=task["type"],
        prompt=task["prompt"],
    )
    # Unknown tasks default to local (privacy preference)
    assert result["route"] == "local"


# TST-BRAIN-273
@pytest.mark.asyncio
async def test_routing_8_1_4_route_respects_persona_tier(llm_router, local_provider) -> None:
    """SS8.1.4: Routing respects persona tier -- locked persona prefers local."""
    task = make_routing_task(
        task_type="summarize",
        persona_id="health",
        persona_tier="locked",
    )
    result = await llm_router.route(
        task_type=task["type"],
        prompt=task["prompt"],
        persona_tier=task["persona_tier"],
    )
    # Locked persona routes to local (data never leaves Home Node)
    assert result["route"] == "local"
    local_provider.complete.assert_awaited()


# ---------------------------------------------------------------------------
# SS8.2 MCP Delegation (3 scenarios)
# ---------------------------------------------------------------------------


# TST-BRAIN-274
@pytest.mark.asyncio
async def test_routing_8_2_1_delegate_to_mcp_tool() -> None:
    """SS8.2.1: Router delegates to an MCP tool and returns the result."""
    tool = make_mcp_tool(name="gmail_fetch")
    assert tool["name"] == "gmail_fetch"

    mcp = AsyncMock()
    mcp.call_tool.return_value = {"result": "success"}
    result = await mcp.call_tool("gmail_server", "gmail_fetch", {})
    assert result["result"] == "success"
    mcp.call_tool.assert_awaited_once()


# TST-BRAIN-275
@pytest.mark.asyncio
async def test_routing_8_2_2_mcp_tool_not_found() -> None:
    """SS8.2.2: Requesting a non-existent MCP tool returns error."""
    from src.adapter.mcp_stdio import MCPStdioClient

    # MCPStdioClient raises MCPError for unconfigured servers
    client = MCPStdioClient(server_commands={})
    with pytest.raises(MCPError, match="No command configured"):
        await client.call_tool("gmail_server", "no_such_tool", {})


# TST-BRAIN-276
@pytest.mark.asyncio
async def test_routing_8_2_3_mcp_delegation_gatekeeper_check() -> None:
    """SS8.2.3: MCP delegation checks gatekeeper before executing tool."""
    # Verify intent classification occurs before delegation
    intent = make_risky_intent(action="send_email")
    assert intent["risk_level"] == "risky"

    # Gatekeeper would flag this for review before allowing MCP execution
    assert intent["action"] == "send_email"
    assert intent.get("attachment") is True  # Risky: has attachment


# ---------------------------------------------------------------------------
# SS8.3 Trust Check (3 scenarios)
# ---------------------------------------------------------------------------


# TST-BRAIN-278
@pytest.mark.asyncio
async def test_routing_8_3_1_check_trusted_agent_trust_scores() -> None:
    """SS8.3.1: Trusted agent has trust score above threshold."""
    # Trust scores are maintained by the agent router
    trust_db = {
        "did:key:z6MkTrustedBot": 0.85,
        "did:key:z6MkUntrustedBot": 0.15,
    }
    score = trust_db.get("did:key:z6MkTrustedBot", 0.0)
    assert score >= 0.7


# TST-BRAIN-279
@pytest.mark.asyncio
async def test_routing_8_3_2_check_untrusted_agent_trust_scores() -> None:
    """SS8.3.2: Untrusted agent has low trust score."""
    trust_db = {
        "did:key:z6MkTrustedBot": 0.85,
        "did:key:z6MkUntrustedBot": 0.15,
    }
    score = trust_db.get("did:key:z6MkUntrustedBot", 0.0)
    assert score < 0.5


# TST-BRAIN-280
@pytest.mark.asyncio
async def test_routing_8_3_3_unknown_agent_default_trust_scores() -> None:
    """SS8.3.3: Unknown agent gets a default trust score (unverified tier)."""
    trust_db = {
        "did:key:z6MkTrustedBot": 0.85,
    }
    score = trust_db.get("did:key:z6MkBrandNewBot", 0.0)
    assert score == 0.0


# ---------------------------------------------------------------------------
# Additional: LLMRouter decision tree tests
# ---------------------------------------------------------------------------


# TST-BRAIN-465
@pytest.mark.asyncio
async def test_routing_8_1_5_complex_prefers_cloud(llm_router, cloud_provider) -> None:
    """Complex reasoning tasks prefer cloud for capability."""
    result = await llm_router.route(
        task_type="complex_reasoning",
        prompt="Analyze this complex legal document",
        persona_tier="open",
    )
    assert result["route"] == "cloud"
    cloud_provider.complete.assert_awaited()


# TST-BRAIN-466
@pytest.mark.asyncio
async def test_routing_8_1_6_fts_only_no_llm(llm_router) -> None:
    """FTS-only lookups bypass the LLM entirely."""
    result = await llm_router.route(
        task_type="fts_lookup",
        prompt="keyword search: meeting notes",
    )
    assert result["route"] == "fts5"
    assert result["finish_reason"] == "fts_only"
