"""Tests for agent routing, MCP delegation, and reputation checks.

Maps to Brain TEST_PLAN §8 (Admin UI/Routing) — 10 scenarios.
"""

from __future__ import annotations

import pytest

from .factories import (
    make_routing_task,
    make_mcp_tool,
    make_safe_intent,
    make_risky_intent,
    make_blocked_intent,
)


# ---------------------------------------------------------------------------
# §8.1 Agent Routing — Task Delegation (4 scenarios)
# ---------------------------------------------------------------------------


# TST-BRAIN-270
@pytest.mark.asyncio
async def test_routing_8_1_1_route_to_local_llm(mock_agent_router) -> None:
    """§8.1.1: Simple summarization task routes to local LLM."""
    pytest.skip("AgentRouter not yet implemented")

    task = make_routing_task(task_type="summarize")
    result = await mock_agent_router.route_task(task)
    assert result["handler"] == "local_llm"
    mock_agent_router.route_task.assert_awaited_once_with(task)


# TST-BRAIN-271
@pytest.mark.asyncio
async def test_routing_8_1_2_route_to_mcp_agent(mock_agent_router) -> None:
    """§8.1.2: Email fetch task routes to MCP gmail agent."""
    pytest.skip("AgentRouter not yet implemented")

    task = make_routing_task(task_type="fetch_email", prompt="Get latest emails")
    mock_agent_router.route_task.return_value = {
        "handler": "mcp:gmail_fetch",
        "result": "Fetched 5 emails",
    }
    result = await mock_agent_router.route_task(task)
    assert result["handler"] == "mcp:gmail_fetch"


# TST-BRAIN-272
@pytest.mark.asyncio
async def test_routing_8_1_3_route_unknown_task_fallback(mock_agent_router) -> None:
    """§8.1.3: Unknown task type falls back to local LLM."""
    pytest.skip("AgentRouter not yet implemented")

    task = make_routing_task(task_type="unknown_task_type")
    result = await mock_agent_router.route_task(task)
    # Fallback to local_llm for unknown task types.
    assert "handler" in result


# TST-BRAIN-273
@pytest.mark.asyncio
async def test_routing_8_1_4_route_respects_persona_tier(mock_agent_router) -> None:
    """§8.1.4: Routing respects persona tier — locked persona rejects external agents."""
    pytest.skip("AgentRouter not yet implemented")

    task = make_routing_task(
        task_type="fetch_health_records",
        persona_id="health",
        persona_tier="locked",
    )
    mock_agent_router.route_task.return_value = {
        "handler": "rejected",
        "reason": "persona locked",
    }
    result = await mock_agent_router.route_task(task)
    assert result["handler"] == "rejected"


# ---------------------------------------------------------------------------
# §8.2 MCP Delegation (3 scenarios)
# ---------------------------------------------------------------------------


# TST-BRAIN-274
@pytest.mark.asyncio
async def test_routing_8_2_1_delegate_to_mcp_tool(
    mock_agent_router, mock_mcp_client
) -> None:
    """§8.2.1: Router delegates to an MCP tool and returns the result."""
    pytest.skip("AgentRouter + MCPClient integration not yet implemented")

    tool = make_mcp_tool(name="gmail_fetch")
    # When real: router calls mcp_client.call_tool() under the hood.
    result = await mock_mcp_client.call_tool("gmail_server", "gmail_fetch", {})
    assert result["result"] == "success"


# TST-BRAIN-275
@pytest.mark.asyncio
async def test_routing_8_2_2_mcp_tool_not_found(
    mock_agent_router, mock_mcp_client
) -> None:
    """§8.2.2: Requesting a non-existent MCP tool returns error."""
    pytest.skip("AgentRouter + MCPClient integration not yet implemented")

    mock_mcp_client.call_tool.side_effect = ValueError("tool not found: no_such_tool")
    with pytest.raises(ValueError, match="tool not found"):
        await mock_mcp_client.call_tool("gmail_server", "no_such_tool", {})


# TST-BRAIN-276
@pytest.mark.asyncio
async def test_routing_8_2_3_mcp_delegation_gatekeeper_check(
    mock_agent_router, mock_mcp_client
) -> None:
    """§8.2.3: MCP delegation checks gatekeeper before executing tool."""
    pytest.skip("AgentRouter + Gatekeeper integration not yet implemented")

    # When real: the router must call gatekeeper.evaluate_intent() before
    # delegating to any MCP tool. Risky tools are flagged, blocked tools
    # are denied.
    intent = make_risky_intent(action="send_email")
    # Verify the gatekeeper is consulted before MCP execution.


# ---------------------------------------------------------------------------
# §8.3 Reputation Check (3 scenarios)
# ---------------------------------------------------------------------------


# TST-BRAIN-278
@pytest.mark.asyncio
async def test_routing_8_3_1_check_trusted_agent_reputation(
    mock_agent_router,
) -> None:
    """§8.3.1: Trusted agent has reputation score above threshold."""
    pytest.skip("AgentRouter not yet implemented")

    score = await mock_agent_router.check_reputation("did:key:z6MkTrustedBot")
    assert score >= 0.7  # mock returns 0.85


# TST-BRAIN-279
@pytest.mark.asyncio
async def test_routing_8_3_2_check_untrusted_agent_reputation(
    mock_agent_router,
) -> None:
    """§8.3.2: Untrusted agent has low reputation score."""
    pytest.skip("AgentRouter not yet implemented")

    mock_agent_router.check_reputation.return_value = 0.15
    score = await mock_agent_router.check_reputation("did:key:z6MkUntrustedBot")
    assert score < 0.5


# TST-BRAIN-280
@pytest.mark.asyncio
async def test_routing_8_3_3_unknown_agent_default_reputation(
    mock_agent_router,
) -> None:
    """§8.3.3: Unknown agent gets a default reputation score (unverified tier)."""
    pytest.skip("AgentRouter not yet implemented")

    mock_agent_router.check_reputation.return_value = 0.0
    score = await mock_agent_router.check_reputation("did:key:z6MkBrandNewBot")
    assert score == 0.0
