"""Tests for agentic vault context assembly.

Tests the tool-calling architecture:
  - ToolExecutor — executes vault tools against mock core
  - ReasoningAgent — agentic loop (LLM → tool calls → execute → repeat)
  - VaultContextAssembler — backward-compatible wrapper
"""

from __future__ import annotations

import pytest
from unittest.mock import AsyncMock

from src.gen.core_types import VaultItem


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _make_text_response(content: str = "test response") -> dict:
    """LLM response with text content, no tool calls."""
    return {
        "content": content,
        "model": "test-model",
        "tokens_in": 10,
        "tokens_out": 20,
        "finish_reason": "stop",
    }


def _make_tool_call_response(calls: list[dict]) -> dict:
    """LLM response requesting tool calls."""
    return {
        "content": "",
        "model": "test-model",
        "tokens_in": 10,
        "tokens_out": 20,
        "finish_reason": "stop",
        "tool_calls": calls,
    }


@pytest.fixture
def mock_core_client() -> AsyncMock:
    """Mock core client for vault operations."""
    from unittest.mock import MagicMock

    client = AsyncMock()
    client.list_personas.return_value = ["personal", "consumer"]
    client.search_vault.return_value = []
    client.query_vault.return_value = []
    client.health.return_value = {"status": "ok"}

    # Default _request mock returns empty contacts so the alias-hint path
    # in VaultContextAssembler.reason() works cleanly without warnings.
    default_resp = MagicMock()
    default_resp.json.return_value = {"contacts": []}
    client._request = AsyncMock(return_value=default_resp)

    return client


@pytest.fixture
def mock_llm_router() -> AsyncMock:
    """Mock LLM router that returns text by default."""
    router = AsyncMock()
    router.route.return_value = _make_text_response()
    return router


@pytest.fixture
def tool_executor(mock_core_client):
    """ToolExecutor wired with mock core client."""
    from src.service.vault_context import ToolExecutor
    return ToolExecutor(mock_core_client)


@pytest.fixture
def reasoning_agent(mock_core_client, mock_llm_router):
    """ReasoningAgent wired with mock dependencies."""
    from src.service.vault_context import ReasoningAgent
    return ReasoningAgent(core=mock_core_client, llm_router=mock_llm_router)


@pytest.fixture
def vault_assembler(mock_core_client, mock_llm_router):
    """VaultContextAssembler with mock dependencies."""
    from src.service.vault_context import VaultContextAssembler
    return VaultContextAssembler(
        core=mock_core_client, llm_router=mock_llm_router,
    )


# =========================================================================
# ToolExecutor — tool execution against mock core
# =========================================================================


class TestToolExecutor:
    """Tests for individual tool execution."""

    @pytest.mark.asyncio
    # TRACE: {"suite": "BRAIN", "case": "0240", "section": "02", "sectionName": "Guardian Loop (Core AI Reasoning)", "subsection": "01", "scenario": "01", "title": "list_personas"}
    async def test_list_personas(self, tool_executor, mock_core_client):
        """list_personas returns personas with preview summaries."""
        mock_core_client.search_vault.return_value = [
            VaultItem(summary="Chronic lower back pain", type="health_context", source="test"),
            VaultItem(summary="Family vacation plans", type="note", source="test"),
        ]
        result = await tool_executor.execute("list_personas", {})
        mock_core_client.list_personas.assert_called_once()
        # Should return enriched persona info, not just names
        assert len(result["personas"]) == 2
        personal = result["personas"][0]
        assert personal["name"] == "personal"
        assert personal["item_count"] == 2
        assert "Chronic lower back pain" in personal["recent_summaries"]

    @pytest.mark.asyncio
    # TRACE: {"suite": "BRAIN", "case": "0241", "section": "02", "sectionName": "Guardian Loop (Core AI Reasoning)", "subsection": "01", "scenario": "02", "title": "list_personas_empty_vault"}
    async def test_list_personas_empty_vault(self, tool_executor, mock_core_client):
        """list_personas with empty vaults shows zero items."""
        mock_core_client.search_vault.return_value = []
        result = await tool_executor.execute("list_personas", {})
        personal = result["personas"][0]
        assert personal["item_count"] == 0
        assert personal["recent_summaries"] == []

    @pytest.mark.asyncio
    # TRACE: {"suite": "BRAIN", "case": "0242", "section": "02", "sectionName": "Guardian Loop (Core AI Reasoning)", "subsection": "01", "scenario": "03", "title": "browse_vault_returns_items"}
    async def test_browse_vault_returns_items(self, tool_executor, mock_core_client):
        """browse_vault returns recent items without search query."""
        mock_core_client.search_vault.return_value = [
            VaultItem(id="item-1", summary="Chronic lower back pain", type="health", source="test"),
            VaultItem(id="item-2", summary="Family trip to Goa", type="note", source="test"),
        ]
        result = await tool_executor.execute("browse_vault", {"persona": "personal"})
        assert len(result["items"]) == 2
        assert result["items"][0]["summary"] == "Chronic lower back pain"

    @pytest.mark.asyncio
    # TRACE: {"suite": "BRAIN", "case": "0243", "section": "02", "sectionName": "Guardian Loop (Core AI Reasoning)", "subsection": "01", "scenario": "04", "title": "browse_vault_locked_persona"}
    async def test_browse_vault_locked_persona(self, tool_executor, mock_core_client):
        """browse_vault on locked persona returns note."""
        from src.domain.errors import PersonaLockedError
        mock_core_client.search_vault.side_effect = PersonaLockedError("locked")
        result = await tool_executor.execute("browse_vault", {"persona": "financial"})
        assert result["items"] == []
        assert "locked" in result.get("note", "").lower()

    @pytest.mark.asyncio
    # TRACE: {"suite": "BRAIN", "case": "0244", "section": "02", "sectionName": "Guardian Loop (Core AI Reasoning)", "subsection": "01", "scenario": "05", "title": "browse_vault_missing_persona"}
    async def test_browse_vault_missing_persona(self, tool_executor):
        """browse_vault without persona returns error."""
        result = await tool_executor.execute("browse_vault", {})
        assert "error" in result

    @pytest.mark.asyncio
    # TRACE: {"suite": "BRAIN", "case": "0245", "section": "02", "sectionName": "Guardian Loop (Core AI Reasoning)", "subsection": "01", "scenario": "06", "title": "search_vault_returns_items"}
    async def test_search_vault_returns_items(self, tool_executor, mock_core_client):
        """search_vault returns items from the specified persona."""
        mock_core_client.search_vault.return_value = [
            VaultItem(id="item-1", summary="Back pain history", type="health", source="test"),
        ]
        result = await tool_executor.execute("search_vault", {
            "persona": "personal", "query": "back pain",
        })
        assert len(result["items"]) == 1
        assert result["items"][0]["summary"] == "Back pain history"
        mock_core_client.search_vault.assert_called_once_with(
            "personal", "back pain", mode="hybrid", embedding=None,
            agent_did="", session="", user_origin="",
        )

    @pytest.mark.asyncio
    # TRACE: {"suite": "BRAIN", "case": "0246", "section": "02", "sectionName": "Guardian Loop (Core AI Reasoning)", "subsection": "01", "scenario": "07", "title": "search_vault_caps_results"}
    async def test_search_vault_caps_results(self, tool_executor, mock_core_client):
        """search_vault caps results at _MAX_ITEMS_PER_QUERY."""
        mock_core_client.search_vault.return_value = [
            VaultItem(id=f"item-{i}", summary=f"Item {i}", type="note", source="test")
            for i in range(20)
        ]
        result = await tool_executor.execute("search_vault", {
            "persona": "consumer", "query": "chairs",
        })
        assert len(result["items"]) <= 5

    @pytest.mark.asyncio
    # TRACE: {"suite": "BRAIN", "case": "0247", "section": "02", "sectionName": "Guardian Loop (Core AI Reasoning)", "subsection": "01", "scenario": "08", "title": "search_vault_locked_persona"}
    async def test_search_vault_locked_persona(self, tool_executor, mock_core_client):
        """Locked persona returns empty items with note."""
        from src.domain.errors import PersonaLockedError
        mock_core_client.search_vault.side_effect = PersonaLockedError("locked")
        result = await tool_executor.execute("search_vault", {
            "persona": "personal", "query": "health",
        })
        assert result["items"] == []
        assert "locked" in result.get("note", "").lower()

    @pytest.mark.asyncio
    # TRACE: {"suite": "BRAIN", "case": "0248", "section": "02", "sectionName": "Guardian Loop (Core AI Reasoning)", "subsection": "01", "scenario": "09", "title": "search_vault_missing_params"}
    async def test_search_vault_missing_params(self, tool_executor):
        """Missing persona/query returns error."""
        result = await tool_executor.execute("search_vault", {})
        assert "error" in result

    @pytest.mark.asyncio
    # TRACE: {"suite": "BRAIN", "case": "0249", "section": "02", "sectionName": "Guardian Loop (Core AI Reasoning)", "subsection": "01", "scenario": "10", "title": "unknown_tool"}
    async def test_unknown_tool(self, tool_executor):
        """Unknown tool name returns error."""
        result = await tool_executor.execute("nonexistent_tool", {})
        assert "error" in result

    @pytest.mark.asyncio
    # TRACE: {"suite": "BRAIN", "case": "0250", "section": "02", "sectionName": "Guardian Loop (Core AI Reasoning)", "subsection": "01", "scenario": "11", "title": "list_personas_failure"}
    async def test_list_personas_failure(self, tool_executor, mock_core_client):
        """Core down → list_personas returns error."""
        mock_core_client.list_personas.side_effect = Exception("core down")
        result = await tool_executor.execute("list_personas", {})
        assert "error" in result
        assert result["personas"] == []

    @pytest.mark.asyncio
    # TRACE: {"suite": "BRAIN", "case": "0251", "section": "02", "sectionName": "Guardian Loop (Core AI Reasoning)", "subsection": "01", "scenario": "12", "title": "was_enriched_tracking"}
    async def test_was_enriched_tracking(self, tool_executor, mock_core_client):
        """was_enriched is True after a search_vault returns results."""
        assert not tool_executor.was_enriched

        mock_core_client.search_vault.return_value = [
            VaultItem(id="item-1", summary="Found something", type="note", source="test"),
        ]
        await tool_executor.execute("search_vault", {
            "persona": "consumer", "query": "chair",
        })
        assert tool_executor.was_enriched

    @pytest.mark.asyncio
    # TRACE: {"suite": "BRAIN", "case": "0252", "section": "02", "sectionName": "Guardian Loop (Core AI Reasoning)", "subsection": "01", "scenario": "13", "title": "tools_called_history"}
    async def test_tools_called_history(self, tool_executor, mock_core_client):
        """tools_called tracks all executed tool calls."""
        await tool_executor.execute("list_personas", {})
        mock_core_client.search_vault.return_value = [
            VaultItem(id="1", summary="test", type="note", source="test"),
        ]
        await tool_executor.execute("search_vault", {
            "persona": "consumer", "query": "chair",
        })
        assert len(tool_executor.tools_called) == 2
        assert tool_executor.tools_called[0]["name"] == "list_personas"
        assert tool_executor.tools_called[1]["name"] == "search_vault"


# =========================================================================
# ReasoningAgent — agentic tool-calling loop
# =========================================================================


class TestReasoningAgent:
    """Tests for the agentic reasoning loop."""

    @pytest.mark.asyncio
    # TRACE: {"suite": "BRAIN", "case": "0253", "section": "02", "sectionName": "Guardian Loop (Core AI Reasoning)", "subsection": "02", "scenario": "01", "title": "simple_response_no_tools"}
    async def test_simple_response_no_tools(self, reasoning_agent, mock_llm_router):
        """LLM responds with text immediately → no tool calls."""
        mock_llm_router.route.return_value = _make_text_response(
            "Here is my answer without needing vault context."
        )
        result = await reasoning_agent.reason("What is 2+2?")
        assert result["content"] == "Here is my answer without needing vault context."
        assert result["vault_context_used"] is False
        assert result["tools_called"] == []

    @pytest.mark.asyncio
    # TRACE: {"suite": "BRAIN", "case": "0254", "section": "02", "sectionName": "Guardian Loop (Core AI Reasoning)", "subsection": "02", "scenario": "02", "title": "agentic_loop_list_then_search"}
    async def test_agentic_loop_list_then_search(
        self, reasoning_agent, mock_llm_router, mock_core_client,
    ):
        """LLM calls list_personas → search_vault → generates answer."""
        mock_core_client.search_vault.return_value = [
            VaultItem(id="item-1", summary="Chronic back pain", type="health", source="test"),
        ]

        # Turn 1: LLM calls list_personas
        # Turn 2: LLM calls search_vault
        # Turn 3: LLM generates text response
        mock_llm_router.route.side_effect = [
            _make_tool_call_response([
                {"name": "list_personas", "args": {}, "id": "call-1"},
            ]),
            _make_tool_call_response([
                {"name": "search_vault", "args": {
                    "persona": "personal", "query": "back pain",
                }, "id": "call-2"},
            ]),
            _make_text_response(
                "Based on your back pain history, I recommend an ergonomic chair."
            ),
        ]

        result = await reasoning_agent.reason("I need a new office chair")
        assert result["vault_context_used"] is True
        assert "ergonomic" in result["content"].lower()
        assert len(result["tools_called"]) == 2
        assert result["tools_called"][0]["name"] == "list_personas"
        assert result["tools_called"][1]["name"] == "search_vault"
        # LLM was called 3 times (2 tool turns + 1 final answer)
        assert mock_llm_router.route.call_count == 3

    @pytest.mark.asyncio
    # TRACE: {"suite": "BRAIN", "case": "0255", "section": "02", "sectionName": "Guardian Loop (Core AI Reasoning)", "subsection": "02", "scenario": "03", "title": "parallel_tool_calls"}
    async def test_parallel_tool_calls(
        self, reasoning_agent, mock_llm_router, mock_core_client,
    ):
        """LLM calls multiple tools in a single turn."""
        mock_core_client.search_vault.return_value = [
            VaultItem(id="item-1", summary="Test data", type="note", source="test"),
        ]

        mock_llm_router.route.side_effect = [
            # Turn 1: list_personas
            _make_tool_call_response([
                {"name": "list_personas", "args": {}, "id": "call-1"},
            ]),
            # Turn 2: parallel search_vault calls
            _make_tool_call_response([
                {"name": "search_vault", "args": {
                    "persona": "consumer", "query": "office chair",
                }, "id": "call-2"},
                {"name": "search_vault", "args": {
                    "persona": "personal", "query": "back pain",
                }, "id": "call-3"},
            ]),
            # Turn 3: final answer
            _make_text_response("Personalized answer."),
        ]

        result = await reasoning_agent.reason("I need a new office chair")
        assert result["vault_context_used"] is True
        assert len(result["tools_called"]) == 3  # 1 list + 2 search
        # LLM was called 3 times
        assert mock_llm_router.route.call_count == 3

    @pytest.mark.asyncio
    # TRACE: {"suite": "BRAIN", "case": "0256", "section": "02", "sectionName": "Guardian Loop (Core AI Reasoning)", "subsection": "02", "scenario": "04", "title": "max_turns_exceeded"}
    async def test_max_turns_exceeded(
        self, reasoning_agent, mock_llm_router, mock_core_client,
    ):
        """Agent stops after _MAX_TOOL_TURNS and forces text response."""
        # LLM always returns tool calls — should cap at max turns
        mock_llm_router.route.side_effect = [
            _make_tool_call_response([
                {"name": "list_personas", "args": {}, "id": f"call-{i}"},
            ])
            for i in range(10)
        ] + [_make_text_response("Forced response")]

        result = await reasoning_agent.reason("infinite loop query")
        # Should have stopped at _MAX_TOOL_TURNS (6) + 1 final call
        assert mock_llm_router.route.call_count <= 7

    @pytest.mark.asyncio
    # TRACE: {"suite": "BRAIN", "case": "0257", "section": "02", "sectionName": "Guardian Loop (Core AI Reasoning)", "subsection": "02", "scenario": "05", "title": "tool_messages_sent_to_llm"}
    async def test_tool_messages_sent_to_llm(
        self, reasoning_agent, mock_llm_router, mock_core_client,
    ):
        """Tool call and response messages are passed back to LLM."""
        mock_llm_router.route.side_effect = [
            _make_tool_call_response([
                {"name": "list_personas", "args": {}, "id": "call-1"},
            ]),
            _make_text_response("Got it."),
        ]

        await reasoning_agent.reason("test query")

        # Second LLM call should have the full conversation history
        second_call = mock_llm_router.route.call_args_list[1]
        messages = second_call.kwargs.get("messages", [])
        # Should have: system, user, tool_call, tool_response
        assert len(messages) == 4
        assert messages[0]["role"] == "system"
        assert messages[1]["role"] == "user"
        assert messages[2]["role"] == "tool_call"
        assert messages[3]["role"] == "tool_response"

    @pytest.mark.asyncio
    # TRACE: {"suite": "BRAIN", "case": "0258", "section": "02", "sectionName": "Guardian Loop (Core AI Reasoning)", "subsection": "02", "scenario": "06", "title": "tools_passed_to_llm"}
    async def test_tools_passed_to_llm(
        self, reasoning_agent, mock_llm_router,
    ):
        """Tool declarations are passed to the LLM router."""
        mock_llm_router.route.return_value = _make_text_response("answer")

        await reasoning_agent.reason("test query")

        call_kwargs = mock_llm_router.route.call_args
        assert call_kwargs.kwargs.get("tools") is not None

    @pytest.mark.asyncio
    # TRACE: {"suite": "BRAIN", "case": "0259", "section": "02", "sectionName": "Guardian Loop (Core AI Reasoning)", "subsection": "02", "scenario": "07", "title": "discovery_first_flow"}
    async def test_discovery_first_flow(
        self, reasoning_agent, mock_llm_router, mock_core_client,
    ):
        """LLM discovers vault contents via browse → then searches with exact terms.

        This is the correct agentic flow: the LLM doesn't guess search terms.
        It browses the vault first, sees 'Chronic lower back pain' in the
        summaries, then uses those exact terms in search_vault.
        """
        # All vault tools now use search_vault — return items that cover both
        # browse (preview) and search (specific) calls.
        mock_core_client.search_vault.return_value = [
            VaultItem(
                id="item-1",
                summary="Chronic lower back pain from office work",
                body_text="User has L4-L5 disc herniation. Needs lumbar support.",
                type="health_context",
                source="test",
            ),
            VaultItem(
                id="item-2",
                summary="Prefers standing desk, WFH setup",
                type="work_context",
                source="test",
            ),
        ]

        mock_llm_router.route.side_effect = [
            # Turn 1: LLM calls list_personas (gets previews)
            _make_tool_call_response([
                {"name": "list_personas", "args": {}, "id": "call-1"},
            ]),
            # Turn 2: LLM sees health data in personal, browses for details
            _make_tool_call_response([
                {"name": "browse_vault", "args": {
                    "persona": "personal",
                }, "id": "call-2"},
            ]),
            # Turn 3: LLM uses EXACT terms from browse results to search
            _make_tool_call_response([
                {"name": "search_vault", "args": {
                    "persona": "personal",
                    "query": "Chronic lower back pain",  # exact terms!
                }, "id": "call-3"},
            ]),
            # Turn 4: LLM generates answer with real context
            _make_text_response(
                "Given your chronic lower back pain and L4-L5 disc herniation, "
                "I recommend an ergonomic chair with strong lumbar support."
            ),
        ]

        result = await reasoning_agent.reason("I need a new office chair")
        assert result["vault_context_used"] is True
        assert "L4-L5" in result["content"] or "lumbar" in result["content"]
        # Verify the discovery flow: list → browse → search → answer
        tools = [tc["name"] for tc in result["tools_called"]]
        assert tools == ["list_personas", "browse_vault", "search_vault"]

    @pytest.mark.asyncio
    # TRACE: {"suite": "BRAIN", "case": "0260", "section": "02", "sectionName": "Guardian Loop (Core AI Reasoning)", "subsection": "02", "scenario": "08", "title": "llm_failure_propagates"}
    async def test_llm_failure_propagates(
        self, reasoning_agent, mock_llm_router,
    ):
        """LLM failure raises exception (guardian handles fallback)."""
        mock_llm_router.route.side_effect = Exception("LLM down")
        with pytest.raises(Exception, match="LLM down"):
            await reasoning_agent.reason("test query")


# =========================================================================
# VaultContextAssembler — backward-compatible wrapper
# =========================================================================


class TestVaultContextAssembler:
    """Tests for the backward-compatible VaultContextAssembler wrapper."""

    @pytest.mark.asyncio
    # TRACE: {"suite": "BRAIN", "case": "0261", "section": "02", "sectionName": "Guardian Loop (Core AI Reasoning)", "subsection": "03", "scenario": "01", "title": "enrich_returns_tuple"}
    async def test_enrich_returns_tuple(self, vault_assembler, mock_llm_router):
        """enrich() returns (content, was_enriched) tuple."""
        mock_llm_router.route.return_value = _make_text_response("enriched answer")
        content, was_enriched = await vault_assembler.enrich("test query")
        assert isinstance(content, str)
        assert isinstance(was_enriched, bool)

    @pytest.mark.asyncio
    # TRACE: {"suite": "BRAIN", "case": "0262", "section": "02", "sectionName": "Guardian Loop (Core AI Reasoning)", "subsection": "03", "scenario": "02", "title": "enrich_with_vault_data"}
    async def test_enrich_with_vault_data(
        self, vault_assembler, mock_llm_router, mock_core_client,
    ):
        """Agent enriches with vault data → was_enriched is True."""
        mock_core_client.search_vault.return_value = [
            VaultItem(id="item-1", summary="Back pain", type="health", source="test"),
        ]
        mock_llm_router.route.side_effect = [
            _make_tool_call_response([
                {"name": "list_personas", "args": {}},
            ]),
            _make_tool_call_response([
                {"name": "search_vault", "args": {
                    "persona": "personal", "query": "health",
                }},
            ]),
            _make_text_response("Based on your health context..."),
        ]
        content, was_enriched = await vault_assembler.enrich(
            "I need a new office chair",
        )
        assert was_enriched
        assert "health" in content.lower()

    @pytest.mark.asyncio
    # TRACE: {"suite": "BRAIN", "case": "0263", "section": "02", "sectionName": "Guardian Loop (Core AI Reasoning)", "subsection": "03", "scenario": "03", "title": "enrich_no_tools_passthrough"}
    async def test_enrich_no_tools_passthrough(
        self, vault_assembler, mock_llm_router,
    ):
        """LLM answers without tools → was_enriched is False."""
        mock_llm_router.route.return_value = _make_text_response(
            "I can help with that."
        )
        content, was_enriched = await vault_assembler.enrich("hello")
        assert not was_enriched

    @pytest.mark.asyncio
    # TRACE: {"suite": "BRAIN", "case": "0264", "section": "02", "sectionName": "Guardian Loop (Core AI Reasoning)", "subsection": "03", "scenario": "04", "title": "reason_returns_full_result"}
    async def test_reason_returns_full_result(
        self, vault_assembler, mock_llm_router,
    ):
        """reason() returns full dict with tools_called and vault_context_used."""
        mock_llm_router.route.return_value = _make_text_response("answer")
        result = await vault_assembler.reason("test query")
        assert "content" in result
        assert "model" in result
        assert "vault_context_used" in result
        assert "tools_called" in result

    @pytest.mark.asyncio
    # TRACE: {"suite": "BRAIN", "case": "0587", "section": "26", "sectionName": "Contact Alias Support", "subsection": "04", "scenario": "04", "title": "reason_injects_alias_hints"}
    async def test_reason_injects_alias_hints_for_mentioned_contact(
        self, mock_core_client, mock_llm_router,
    ):
        """reason() injects alias hints into the system prompt for mentioned contacts."""
        from unittest.mock import MagicMock
        from src.service.vault_context import VaultContextAssembler

        # Mock _request to return contacts with aliases.
        contact_response = MagicMock()
        contact_response.json.return_value = {
            "contacts": [
                {"did": "did:plc:emma", "display_name": "Emma",
                 "aliases": ["my daughter", "my kid"]},
                {"did": "did:plc:sancho", "display_name": "Sancho",
                 "aliases": ["my buddy"]},
            ]
        }
        mock_core_client._request = AsyncMock(return_value=contact_response)

        mock_llm_router.route.return_value = _make_text_response("Emma likes dinosaurs")

        assembler = VaultContextAssembler(
            core=mock_core_client, llm_router=mock_llm_router,
        )
        result = await assembler.reason("What does Emma like?")

        # Verify the LLM was called and the system prompt contains alias hints.
        assert mock_llm_router.route.called
        call_kwargs = mock_llm_router.route.call_args
        messages = call_kwargs.kwargs.get("messages") or call_kwargs[1].get("messages", [])
        system_msg = next((m for m in messages if m.get("role") == "system"), None)
        assert system_msg is not None
        system_text = system_msg["content"]
        # Emma is mentioned → her aliases should be in the system prompt.
        assert "my daughter" in system_text
        assert "my kid" in system_text
        # Sancho is NOT mentioned → his aliases should NOT be in the system prompt.
        assert "my buddy" not in system_text

    @pytest.mark.asyncio
    # TRACE: {"suite": "BRAIN", "case": "0588", "section": "26", "sectionName": "Contact Alias Support", "subsection": "04", "scenario": "05", "title": "reason_no_alias_leak"}
    async def test_reason_no_alias_leak_for_unmentioned_contacts(
        self, mock_core_client, mock_llm_router,
    ):
        """reason() does NOT inject aliases for contacts not in the query."""
        from unittest.mock import MagicMock
        from src.service.vault_context import VaultContextAssembler

        contact_response = MagicMock()
        contact_response.json.return_value = {
            "contacts": [
                {"did": "did:plc:emma", "display_name": "Emma",
                 "aliases": ["my daughter"]},
            ]
        }
        mock_core_client._request = AsyncMock(return_value=contact_response)
        mock_llm_router.route.return_value = _make_text_response("answer")

        assembler = VaultContextAssembler(
            core=mock_core_client, llm_router=mock_llm_router,
        )
        result = await assembler.reason("What is the weather today?")

        call_kwargs = mock_llm_router.route.call_args
        messages = call_kwargs.kwargs.get("messages") or call_kwargs[1].get("messages", [])
        system_msg = next((m for m in messages if m.get("role") == "system"), None)
        assert system_msg is not None
        # No contact mentioned → no alias hints.
        assert "my daughter" not in system_msg["content"]


# =========================================================================
# Tool Declarations
# =========================================================================


class TestToolDeclarations:
    """Tests for tool declaration schemas."""

    # TRACE: {"suite": "BRAIN", "case": "0265", "section": "02", "sectionName": "Guardian Loop (Core AI Reasoning)", "subsection": "04", "scenario": "01", "title": "vault_tools_defined"}
    def test_vault_tools_defined(self):
        """VAULT_TOOLS contains expected tool declarations."""
        from src.service.vault_context import VAULT_TOOLS
        names = {t["name"] for t in VAULT_TOOLS}
        assert "list_personas" in names
        assert "browse_vault" in names
        assert "search_vault" in names

    # TRACE: {"suite": "BRAIN", "case": "0266", "section": "02", "sectionName": "Guardian Loop (Core AI Reasoning)", "subsection": "04", "scenario": "02", "title": "search_vault_has_required_params"}
    def test_search_vault_has_required_params(self):
        """search_vault tool requires persona and query."""
        from src.service.vault_context import VAULT_TOOLS
        search_tool = next(t for t in VAULT_TOOLS if t["name"] == "search_vault")
        assert "persona" in search_tool["parameters"]["properties"]
        assert "query" in search_tool["parameters"]["properties"]
        assert "persona" in search_tool["parameters"]["required"]
        assert "query" in search_tool["parameters"]["required"]

    # TRACE: {"suite": "BRAIN", "case": "0267", "section": "02", "sectionName": "Guardian Loop (Core AI Reasoning)", "subsection": "04", "scenario": "03", "title": "gemini_tools_build"}
    def test_gemini_tools_build(self):
        """_build_gemini_tools creates google.genai Tool objects."""
        from src.service.vault_context import _build_gemini_tools
        tools = _build_gemini_tools()
        # If google-genai is installed, should return non-empty
        if tools:
            assert len(tools) == 1  # One Tool with multiple declarations


# =========================================================================
# User-origin propagation (Telegram full access)
# =========================================================================


class TestUserOriginPropagation:
    """Verify user_origin propagates from ToolExecutor to Core calls."""

    @pytest.mark.asyncio
    # TRACE: {"suite": "BRAIN", "case": "0268", "section": "02", "sectionName": "Guardian Loop (Core AI Reasoning)", "subsection": "05", "scenario": "01", "title": "search_vault_passes_user_origin"}
    async def test_search_vault_passes_user_origin(self, mock_core_client):
        """search_vault forwards user_origin to Core HTTP client."""
        from src.service.vault_context import ToolExecutor
        executor = ToolExecutor(mock_core_client)
        executor.user_origin = "telegram"
        mock_core_client.search_vault.return_value = []

        await executor.execute("search_vault", {"persona": "health", "query": "blood pressure"})

        mock_core_client.search_vault.assert_called_once_with(
            "health", "blood pressure", mode="hybrid", embedding=None,
            agent_did="", session="", user_origin="telegram",
        )

    @pytest.mark.asyncio
    # TRACE: {"suite": "BRAIN", "case": "0269", "section": "02", "sectionName": "Guardian Loop (Core AI Reasoning)", "subsection": "05", "scenario": "02", "title": "get_full_content_passes_user_origin"}
    async def test_get_full_content_passes_user_origin(self, mock_core_client):
        """get_full_content forwards user_origin to Core HTTP client."""
        from src.service.vault_context import ToolExecutor
        executor = ToolExecutor(mock_core_client)
        executor.user_origin = "telegram"
        mock_core_client.get_vault_item.return_value = VaultItem(
            id="item-1", summary="Full content here", type="note", source="test",
            body_text="Full content here",
        )

        await executor.execute("get_full_content", {"persona": "health", "item_id": "item-1"})

        mock_core_client.get_vault_item.assert_called_once_with(
            "health", "item-1", user_origin="telegram",
        )

    @pytest.mark.asyncio
    # TRACE: {"suite": "BRAIN", "case": "0270", "section": "02", "sectionName": "Guardian Loop (Core AI Reasoning)", "subsection": "05", "scenario": "03", "title": "list_personas_passes_user_origin"}
    async def test_list_personas_passes_user_origin(self, mock_core_client):
        """list_personas preview calls pass user_origin to search_vault."""
        from src.service.vault_context import ToolExecutor
        executor = ToolExecutor(mock_core_client)
        executor.user_origin = "admin"
        mock_core_client.list_personas.return_value = ["personal"]
        mock_core_client.search_vault.return_value = []

        await executor.execute("list_personas", {})

        # The preview search for each persona should include user_origin
        mock_core_client.search_vault.assert_called_once()
        call_kwargs = mock_core_client.search_vault.call_args
        assert call_kwargs.kwargs.get("user_origin") == "admin" or \
            (len(call_kwargs) > 1 and "admin" in str(call_kwargs))

    @pytest.mark.asyncio
    # TRACE: {"suite": "BRAIN", "case": "0271", "section": "02", "sectionName": "Guardian Loop (Core AI Reasoning)", "subsection": "05", "scenario": "04", "title": "no_user_origin_sends_empty"}
    async def test_no_user_origin_sends_empty(self, mock_core_client):
        """Without user_origin, empty string is sent (backward compat)."""
        from src.service.vault_context import ToolExecutor
        executor = ToolExecutor(mock_core_client)
        # user_origin defaults to ""
        mock_core_client.search_vault.return_value = []

        await executor.execute("search_vault", {"persona": "personal", "query": "test"})

        mock_core_client.search_vault.assert_called_once_with(
            "personal", "test", mode="hybrid", embedding=None,
            agent_did="", session="", user_origin="",
        )
