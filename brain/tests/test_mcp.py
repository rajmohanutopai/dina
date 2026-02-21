"""Tests for MCP Client — Agent Delegation, Safety, Protocol, and Query Sanitization.

Maps to Brain TEST_PLAN SS6 (MCP Client -- Agent Delegation).

SS6.1 Agent Routing (5 scenarios)
SS6.2 Agent Safety -- Intent Verification (16 scenarios)
SS6.3 MCP Protocol (4 scenarios)
SS6.4 Query Sanitization (8 scenarios)
"""

from __future__ import annotations

import pytest

from .factories import (
    make_safe_intent,
    make_risky_intent,
    make_blocked_intent,
    make_mcp_tool,
    make_event,
    make_engagement_event,
)


# ---------------------------------------------------------------------------
# SS6.1 Agent Routing (5 scenarios)
# ---------------------------------------------------------------------------


# TST-BRAIN-226
@pytest.mark.asyncio
async def test_mcp_6_1_1_route_to_specialist_agent(
    mock_mcp_client, mock_agent_router
) -> None:
    """SS6.1.1: Task requiring legal review routes to specialist legal-review agent."""
    pytest.skip("MCP agent routing not yet implemented")

    # Expected: Router identifies "legal_review" capability, selects the legal
    # specialist agent via MCP, and delegates the task.
    # task = {"type": "legal_review", "prompt": "Review this NDA for red flags"}
    # result = await mock_agent_router.route_task(task)
    # assert result["handler"].startswith("mcp:")
    # assert "legal" in result["handler"]


# TST-BRAIN-227
@pytest.mark.asyncio
async def test_mcp_6_1_2_route_by_capability(
    mock_mcp_client, mock_agent_router
) -> None:
    """SS6.1.2: Task requiring image analysis routes to agent with that capability."""
    pytest.skip("MCP capability-based routing not yet implemented")

    # Expected: Router matches "image_analysis" capability to the correct MCP
    # agent, not just by name but by declared capability set.
    # task = {"type": "image_analysis", "prompt": "Describe this product photo"}
    # result = await mock_agent_router.route_task(task)
    # assert result["handler"] == "mcp:image_analyzer"


# TST-BRAIN-228
@pytest.mark.asyncio
async def test_mcp_6_1_3_route_by_reputation(
    mock_mcp_client, mock_agent_router
) -> None:
    """SS6.1.3: When multiple agents can handle a task, highest reputation score wins."""
    pytest.skip("MCP reputation-based routing not yet implemented")

    # Expected: Two agents both capable of "summarize", but agent A has
    # reputation 0.9 and agent B has 0.6 — agent A is selected.
    # mock_agent_router.check_reputation.side_effect = [0.9, 0.6]
    # task = {"type": "summarize", "prompt": "Summarize this article"}
    # result = await mock_agent_router.route_task(task)
    # assert result["handler"] contains the higher-reputation agent
    # COVERAGE GAP C1: Add verification that brain maintains per-bot scores
    # locally and recalculates after each interaction outcome.
    # bot_scores = await brain.get_bot_scores()
    # assert "did:key:z6MkChairBot" in bot_scores
    # await brain.record_outcome("did:key:z6MkChairBot", {"satisfaction": "positive"})
    # updated_scores = await brain.get_bot_scores()
    # assert updated_scores["did:key:z6MkChairBot"] > bot_scores["did:key:z6MkChairBot"]


# TST-BRAIN-229
@pytest.mark.asyncio
async def test_mcp_6_1_4_no_suitable_agent_fallback(
    mock_mcp_client, mock_agent_router
) -> None:
    """SS6.1.4: No suitable MCP agent available — falls back to local LLM."""
    pytest.skip("MCP fallback routing not yet implemented")

    # Expected: When no MCP agent matches the required capability, the router
    # falls back to the local LLM instead of failing.
    # mock_mcp_client.list_tools.return_value = []
    # task = {"type": "obscure_task", "prompt": "Do something unusual"}
    # result = await mock_agent_router.route_task(task)
    # assert result["handler"] == "local_llm"


# TST-BRAIN-230
@pytest.mark.asyncio
async def test_mcp_6_1_5_agent_timeout(
    mock_mcp_client, mock_agent_router
) -> None:
    """SS6.1.5: Agent that takes longer than 30s times out gracefully."""
    pytest.skip("MCP agent timeout not yet implemented")

    # Expected: MCP call_tool times out after 30s, error is caught, and the
    # router falls back or returns a timeout error to the caller.
    # import asyncio
    # mock_mcp_client.call_tool.side_effect = asyncio.TimeoutError()
    # result = await mock_agent_router.route_task(task)
    # assert result["handler"] == "timeout" or result.get("error")


# ---------------------------------------------------------------------------
# SS6.2 Agent Safety -- Intent Verification (16 scenarios)
# ---------------------------------------------------------------------------


# TST-BRAIN-231
@pytest.mark.asyncio
async def test_mcp_6_2_1_safe_intent_auto_approved(
    mock_mcp_client, mock_guardian
) -> None:
    """SS6.2.1: Safe intent (fetch_weather) auto-approved without user review."""
    intent = make_safe_intent()
    assert intent["risk_level"] == "safe"

    pytest.skip("Intent verification not yet implemented")

    # Expected: Guardian classifies as safe, auto-approves, agent proceeds.
    # result = await mock_guardian.process_event(intent)
    # assert result["action"] == "auto_approve"


# TST-BRAIN-232
@pytest.mark.asyncio
async def test_mcp_6_2_2_risky_intent_flagged(
    mock_mcp_client, mock_guardian
) -> None:
    """SS6.2.2: Risky intent (send_email) flagged for user review before execution."""
    intent = make_risky_intent()
    assert intent["risk_level"] == "risky"

    pytest.skip("Intent verification not yet implemented")

    # Expected: Guardian flags the intent, execution pauses until user approves.
    # result = await mock_guardian.process_event(intent)
    # assert result["action"] == "flag_for_review"
    # assert result.get("requires_user_approval") is True


# TST-BRAIN-233
@pytest.mark.asyncio
async def test_mcp_6_2_3_blocked_intent_denied(
    mock_mcp_client, mock_guardian
) -> None:
    """SS6.2.3: Blocked intent (untrusted bot reading vault) denied outright."""
    intent = make_blocked_intent()
    assert intent["risk_level"] == "blocked"

    pytest.skip("Intent verification not yet implemented")

    # Expected: Guardian blocks the intent immediately, no user prompt needed.
    # result = await mock_guardian.process_event(intent)
    # assert result["action"] == "deny"


# TST-BRAIN-234
@pytest.mark.asyncio
async def test_mcp_6_2_4_agent_raw_vault_access_blocked(
    mock_mcp_client, mock_guardian
) -> None:
    """SS6.2.4: Agent attempts to access raw vault data — blocked regardless of trust."""
    intent = make_safe_intent(action="read_vault", target="raw_data")

    pytest.skip("Raw vault access blocking not yet implemented")

    # Expected: Even a trusted agent cannot access raw vault data.
    # The safety layer intercepts and blocks the intent.
    # result = await mock_guardian.process_event(intent)
    # assert result["action"] == "deny"
    # assert "raw vault" in result.get("reason", "").lower()


# TST-BRAIN-235
@pytest.mark.asyncio
async def test_mcp_6_2_5_untrusted_source_higher_scrutiny(
    mock_mcp_client, mock_guardian, mock_agent_router
) -> None:
    """SS6.2.5: Agent from untrusted source gets elevated scrutiny threshold."""
    intent = make_safe_intent(
        agent_did="did:key:z6MkUnknownBot",
        trust_level="untrusted",
    )

    pytest.skip("Trust-level-based scrutiny not yet implemented")

    # Expected: Even a nominally "safe" action from an untrusted agent
    # is escalated to "risky" for additional review.
    # mock_agent_router.check_reputation.return_value = 0.1
    # result = await mock_guardian.process_event(intent)
    # assert result["action"] in ("flag_for_review", "deny")


# TST-BRAIN-236
@pytest.mark.asyncio
async def test_mcp_6_2_6_agent_response_pii_leakage_check(
    mock_mcp_client, mock_pii_scrubber
) -> None:
    """SS6.2.6: Agent response is scanned for PII leakage before delivery to user."""
    pytest.skip("Agent response PII validation not yet implemented")

    # Expected: After agent returns a response, PII scrubber scans it.
    # If the response contains PII that was NOT in the original query,
    # it is flagged or redacted.
    # response = {"result": "Dr. Sharma's records at john@example.com"}
    # entities = mock_pii_scrubber.detect(response["result"])
    # assert len(entities) > 0  # PII detected in response


# TST-BRAIN-237
@pytest.mark.asyncio
async def test_mcp_6_2_7_agent_cannot_access_encryption_keys(
    mock_mcp_client, mock_guardian
) -> None:
    """SS6.2.7: Agent intent targeting encryption keys is always denied."""
    intent = make_blocked_intent(action="read_keys", target="encryption_keys")

    pytest.skip("Key access protection not yet implemented")

    # Expected: Any intent targeting encryption keys is unconditionally blocked.
    # result = await mock_guardian.process_event(intent)
    # assert result["action"] == "deny"
    # assert "keys" in result.get("reason", "").lower()


# TST-BRAIN-238
@pytest.mark.asyncio
async def test_mcp_6_2_8_agent_cannot_access_persona_metadata(
    mock_mcp_client, mock_guardian
) -> None:
    """SS6.2.8: Agent cannot access persona metadata (cross-compartment leak)."""
    intent = make_blocked_intent(action="list_personas", target="all")

    pytest.skip("Persona metadata protection not yet implemented")

    # Expected: Agent cannot enumerate or read persona metadata.
    # Personas are cryptographic compartments — no cross-compartment access.
    # result = await mock_guardian.process_event(intent)
    # assert result["action"] == "deny"


# TST-BRAIN-239
@pytest.mark.asyncio
async def test_mcp_6_2_9_agent_cannot_initiate_calls_to_dina(
    mock_mcp_client, mock_guardian
) -> None:
    """SS6.2.9: Agent cannot initiate unsolicited calls to Dina — only respond to delegation."""
    pytest.skip("Agent call initiation blocking not yet implemented")

    # Expected: MCP protocol enforces that agents only respond to Dina's
    # requests. An agent cannot push unsolicited messages to Dina.
    # Incoming unsolicited agent messages are dropped.


# TST-BRAIN-240
@pytest.mark.asyncio
async def test_mcp_6_2_10_disconnect_compromised_agent(
    mock_mcp_client, mock_guardian
) -> None:
    """SS6.2.10: Agent with repeated blocked intents is blacklisted and disconnected."""
    pytest.skip("Compromised agent blacklisting not yet implemented")

    # Expected: After N blocked intents (e.g., 3), the agent is blacklisted.
    # Further connection attempts from this agent_did are refused.
    # for _ in range(3):
    #     intent = make_blocked_intent(agent_did="did:key:z6MkBadBot")
    #     await mock_guardian.process_event(intent)
    # # Agent should now be blacklisted
    # status = await mock_guardian.check_agent_status("did:key:z6MkBadBot")
    # assert status == "blacklisted"
    # mock_mcp_client.disconnect.assert_awaited()


# TST-BRAIN-241
@pytest.mark.asyncio
async def test_mcp_6_2_11_agent_cannot_enumerate_other_agents(
    mock_mcp_client, mock_guardian
) -> None:
    """SS6.2.11: Agent cannot discover or enumerate other connected agents."""
    intent = make_blocked_intent(action="list_agents", target="all")

    pytest.skip("Agent enumeration protection not yet implemented")

    # Expected: Agent cannot query the list of other agents connected to Dina.
    # result = await mock_guardian.process_event(intent)
    # assert result["action"] == "deny"


# TST-BRAIN-242
@pytest.mark.asyncio
async def test_mcp_6_2_12_constraint_draft_only_enforced(
    mock_mcp_client, mock_guardian
) -> None:
    """SS6.2.12: Constraint 'draft_only' prevents agent from sending (only drafts)."""
    intent = make_risky_intent(
        action="send_email",
        constraints={"draft_only": True},
    )

    pytest.skip("Constraint enforcement not yet implemented")

    # Expected: Agent is allowed to draft but not send. The guardian
    # ensures the "draft_only" constraint is enforced at execution time.
    # result = await mock_guardian.process_event(intent)
    # assert result["action"] == "approve_with_constraints"
    # assert result["constraints"]["draft_only"] is True


# TST-BRAIN-243
@pytest.mark.asyncio
async def test_mcp_6_2_13_constraint_no_payment_enforced(
    mock_mcp_client, mock_guardian
) -> None:
    """SS6.2.13: Constraint 'no_payment' prevents agent from initiating any payment."""
    intent = make_risky_intent(
        action="purchase_item",
        constraints={"no_payment": True},
    )

    pytest.skip("Payment constraint enforcement not yet implemented")

    # Expected: Agent cannot initiate payment even if the task involves a purchase.
    # Cart Handover principle: Dina advises but never touches money.
    # result = await mock_guardian.process_event(intent)
    # assert result["action"] == "deny" or result["constraints"]["no_payment"] is True


# TST-BRAIN-244
@pytest.mark.asyncio
async def test_mcp_6_2_14_silence_protocol_checked_before_delegation(
    mock_mcp_client, mock_guardian, mock_silence_classifier
) -> None:
    """SS6.2.14: Silence protocol is checked before delegating to an agent."""
    intent = make_safe_intent()
    event = make_engagement_event()

    pytest.skip("Silence protocol integration with MCP not yet implemented")

    # Expected: Before delegating a task triggered by an engagement-tier event,
    # the silence classifier is consulted. If the event is deferred (DND),
    # the agent delegation is also deferred.
    # classification = await mock_silence_classifier.classify(event)
    # if classification["action"] == "save_for_briefing":
    #     # Delegation should be deferred, not executed immediately


# TST-BRAIN-245
@pytest.mark.asyncio
async def test_mcp_6_2_15_agent_outcome_recorded_in_tier3(
    mock_mcp_client, mock_guardian, mock_agent_router
) -> None:
    """SS6.2.15: Agent execution outcome is recorded in Tier 3 of the Reputation Graph."""
    intent = make_safe_intent()

    pytest.skip("Agent outcome recording not yet implemented")

    # Expected: After agent completes a task, the outcome (success/failure/quality)
    # is recorded in Tier 3 (outcome data) of the Reputation Graph.
    # This contributes to the trust function:
    # f(identity anchors, transaction history, outcome data, peer attestations, time)
    # result = await mock_agent_router.route_task({"type": "fetch_weather"})
    # outcome = await mock_agent_router.record_outcome(intent["agent_did"], result)
    # assert outcome["tier"] == 3
    # assert outcome["recorded"] is True


# TST-BRAIN-246
@pytest.mark.asyncio
async def test_mcp_6_2_16_no_raw_vault_data_to_agents(
    mock_mcp_client, mock_guardian, mock_core_client
) -> None:
    """SS6.2.16: Agents receive questions only — raw vault data never leaves Home Node."""
    pytest.skip("Raw data isolation enforcement not yet implemented")

    # Expected: When delegating to an MCP agent, the router sends only
    # the question/prompt — never raw vault contents. The Thin Agent principle:
    # "Raw data never leaves the Home Node — external bots get questions only."
    # query_sent = capture_mcp_query(mock_mcp_client)
    # assert "vault_data" not in query_sent
    # assert "raw" not in query_sent


# ---------------------------------------------------------------------------
# SS6.3 MCP Protocol (4 scenarios)
# ---------------------------------------------------------------------------


# TST-BRAIN-247
@pytest.mark.asyncio
async def test_mcp_6_3_1_initialize_session(mock_mcp_client) -> None:
    """SS6.3.1: MCP session initializes with tool listing and capability exchange."""
    pytest.skip("MCP session initialization not yet implemented")

    # Expected: Calling list_tools establishes a session and returns available tools.
    # tools = await mock_mcp_client.list_tools("agent_server")
    # assert isinstance(tools, list)
    # assert len(tools) >= 1
    # assert all("name" in t for t in tools)


# TST-BRAIN-248
@pytest.mark.asyncio
async def test_mcp_6_3_2_tool_invocation(mock_mcp_client) -> None:
    """SS6.3.2: Tool invocation sends correct args and returns structured result."""
    tool = make_mcp_tool(name="gmail_fetch")
    assert tool["name"] == "gmail_fetch"

    pytest.skip("MCP tool invocation not yet implemented")

    # Expected: call_tool sends the tool name and args to the MCP server,
    # receives a structured JSON result.
    # result = await mock_mcp_client.call_tool("gmail_server", "gmail_fetch", {"limit": 10})
    # assert "result" in result


# TST-BRAIN-249
@pytest.mark.asyncio
async def test_mcp_6_3_3_session_cleanup(mock_mcp_client) -> None:
    """SS6.3.3: MCP session is cleanly disconnected after task completion."""
    pytest.skip("MCP session cleanup not yet implemented")

    # Expected: After task completes, disconnect is called to release resources.
    # await mock_mcp_client.disconnect("agent_server")
    # mock_mcp_client.disconnect.assert_awaited_once_with("agent_server")


# TST-BRAIN-250
@pytest.mark.asyncio
async def test_mcp_6_3_4_server_unreachable(mock_mcp_client) -> None:
    """SS6.3.4: MCP server unreachable — error handled gracefully, no crash."""
    pytest.skip("MCP server unreachable handling not yet implemented")

    # Expected: Connection error is caught, logged, and returned as an error
    # result rather than crashing the brain process.
    # mock_mcp_client.call_tool.side_effect = ConnectionError("server unreachable")
    # with pytest.raises(ConnectionError):
    #     await mock_mcp_client.call_tool("dead_server", "some_tool", {})


# ---------------------------------------------------------------------------
# SS6.4 Query Sanitization (8 scenarios)
# ---------------------------------------------------------------------------


# TST-BRAIN-251
@pytest.mark.asyncio
async def test_mcp_6_4_1_query_includes_context_not_identity(
    mock_mcp_client, mock_pii_scrubber
) -> None:
    """SS6.4.1: Query sent to agent includes product context but not user identity."""
    pytest.skip("Query sanitization not yet implemented")

    # Expected: Query contains "looking for a chair under $500" but NOT
    # the user's name, email, or any persona-identifying information.
    # sanitized = sanitize_query("I, John Smith, want a chair under $500")
    # assert "chair" in sanitized
    # assert "$500" in sanitized
    # assert "John Smith" not in sanitized


# TST-BRAIN-252
@pytest.mark.asyncio
async def test_mcp_6_4_2_budget_from_financial_persona_stripped(
    mock_mcp_client, mock_pii_scrubber
) -> None:
    """SS6.4.2: Exact budget from financial persona is stripped or generalized."""
    pytest.skip("Financial persona query sanitization not yet implemented")

    # Expected: Specific budget figures from the financial persona are generalized.
    # "budget: $47,523.89" becomes "budget: moderate" or is omitted entirely.
    # sanitized = sanitize_query(
    #     "Find chairs within my budget of $47,523.89",
    #     persona_id="financial",
    # )
    # assert "$47,523.89" not in sanitized


# TST-BRAIN-253
@pytest.mark.asyncio
async def test_mcp_6_4_3_medical_details_generalized(
    mock_mcp_client, mock_pii_scrubber
) -> None:
    """SS6.4.3: Specific medical details are generalized before sending to agent."""
    pytest.skip("Medical query sanitization not yet implemented")

    # Expected: "L4-L5 disc herniation" becomes "back condition" or similar.
    # Specific diagnoses, medications, and lab values are generalized.
    # sanitized = sanitize_query(
    #     "Find ergonomic chairs for L4-L5 disc herniation",
    #     persona_id="health",
    # )
    # assert "L4-L5" not in sanitized
    # assert "herniation" not in sanitized
    # assert "back" in sanitized or "ergonomic" in sanitized


# TST-BRAIN-254
@pytest.mark.asyncio
async def test_mcp_6_4_4_no_persona_data_in_query(
    mock_mcp_client, mock_pii_scrubber
) -> None:
    """SS6.4.4: No persona metadata (persona_id, tier, compartment) appears in the query."""
    pytest.skip("Persona metadata stripping not yet implemented")

    # Expected: The agent sees a clean query with no persona identifiers.
    # Sovereign Identity principle: compartments are never exposed externally.
    # sanitized = sanitize_query("Find a chair", persona_id="shopping")
    # assert "shopping" not in sanitized
    # assert "persona" not in sanitized.lower()


# TST-BRAIN-255
@pytest.mark.asyncio
async def test_mcp_6_4_5_past_purchase_context_included(
    mock_mcp_client, mock_pii_scrubber
) -> None:
    """SS6.4.5: Relevant past purchase context is included (anonymized)."""
    pytest.skip("Purchase context inclusion not yet implemented")

    # Expected: "Previously bought an ergonomic chair" context is included
    # but without order IDs, transaction amounts, or vendor-specific details.
    # sanitized = sanitize_query(
    #     "Find a new chair",
    #     context={"past_purchases": ["ergonomic chair (2024)", "standing desk (2023)"]},
    # )
    # assert "ergonomic chair" in sanitized
    # assert no specific order IDs or prices


# TST-BRAIN-256
@pytest.mark.asyncio
async def test_mcp_6_4_6_no_pii_even_if_user_types_pii(
    mock_mcp_client, mock_pii_scrubber
) -> None:
    """SS6.4.6: Even if user types PII in their query, it is scrubbed before agent sees it."""
    pytest.skip("User-typed PII scrubbing not yet implemented")

    # Expected: PII scrubber runs on user input before delegation.
    # query = "My SSN is 123-45-6789, find me a chair"
    # sanitized = sanitize_query(query)
    # assert "123-45-6789" not in sanitized
    # assert "[SSN_1]" not in sanitized  # Tokens also stripped, not just replaced


# TST-BRAIN-257
@pytest.mark.asyncio
async def test_mcp_6_4_7_attribution_preserved_in_response(
    mock_mcp_client,
) -> None:
    """SS6.4.7: Bot response includes attribution (Deep Link Default principle)."""
    pytest.skip("Attribution preservation not yet implemented")

    # Expected: Agent response credits sources per Deep Link Default principle.
    # "MKBHD says the battery is bad, here's the timestamp" — not just extracts.
    # response = {"result": "Battery lasts 8h", "source": "MKBHD", "timestamp": "4:32"}
    # processed = process_agent_response(response)
    # assert processed.get("attribution") is not None
    # assert "MKBHD" in processed["attribution"]


# TST-BRAIN-258
@pytest.mark.asyncio
async def test_mcp_6_4_8_bot_response_without_attribution(
    mock_mcp_client,
) -> None:
    """SS6.4.8: Bot response lacking attribution is flagged for the user."""
    pytest.skip("Attribution enforcement not yet implemented")

    # Expected: If an agent returns a response without source attribution,
    # the system flags it as unverified. Verified Truth principle.
    # response = {"result": "Battery lasts 8h"}  # No source
    # processed = process_agent_response(response)
    # assert processed.get("attribution_missing") is True
    # assert processed.get("verified") is False


# ---------------------------------------------------------------------------
# §6.1 Reputation AppView (3 scenarios) — arch §08
# ---------------------------------------------------------------------------


# TST-BRAIN-408
def test_mcp_6_1_6_reputation_appview_query(mock_mcp_client) -> None:
    """§6.1.6: Brain queries Reputation AppView API for product scores.

    Architecture §08: Brain queries GET /v1/reputation?did=... to get
    product scores, expert attestations, and bot scores for recommendations.
    """
    pytest.skip("Reputation AppView query not yet implemented")
    # result = await reputation_client.query_reputation("did:plc:chair_expert")
    # assert "overall_score" in result
    # assert "attestation_count" in result


# TST-BRAIN-409
def test_mcp_6_1_7_reputation_appview_fallback(mock_mcp_client) -> None:
    """§6.1.7: Reputation AppView unavailable → web search fallback.

    Architecture §08: When Reputation AppView is unavailable, brain degrades
    gracefully to web search via OpenClaw. No disruption to user.
    """
    pytest.skip("Reputation AppView fallback not yet implemented")
    # mock_mcp_client.call_tool.side_effect = ConnectionError("AppView down")
    # result = await brain.get_recommendation("best ergonomic chair")
    # assert result["source"] == "web_search"  # fallback to OpenClaw


# TST-BRAIN-410
def test_mcp_6_1_8_bot_reputation_tracking(mock_mcp_client) -> None:
    """§6.1.8: Brain recalculates per-bot reputation after each interaction.

    Architecture §10: Brain maintains per-bot reputation scores locally.
    After each interaction outcome, brain recalculates bot score.
    Next query routes to updated best bot.
    """
    pytest.skip("Bot reputation tracking not yet implemented")
    # outcome = {"bot_did": "did:key:z6MkChairBot", "satisfaction": "positive"}
    # await reputation_client.submit_outcome("did:key:z6MkChairBot", outcome)
    # new_score = await reputation_client.query_reputation("did:key:z6MkChairBot")
    # assert new_score["overall_score"] > previous_score


# ---------------------------------------------------------------------------
# §6.2 Bot Response PII Validation (1 scenario) — arch §10, §11
# ---------------------------------------------------------------------------


# TST-BRAIN-395
def test_mcp_6_2_17_bot_response_pii_validation(mock_mcp_client, mock_pii_scrubber) -> None:
    """§6.2.17: Bot response with leaked PII detected and scrubbed.

    Architecture §10, §11: Brain must validate bot/agent responses for PII
    leakage before showing to user. Bot response may contain leaked entities
    (email, name) that brain must detect via spaCy NER and scrub/flag.
    """
    pytest.skip("Bot response PII validation not yet implemented")
    # bot_response = make_bot_response(
    #     content="Contact john@example.com for the best deal from John Smith"
    # )
    # scrubbed = await brain.validate_bot_response(bot_response)
    # assert "john@example.com" not in scrubbed["content"]
    # assert "John Smith" not in scrubbed["content"]
