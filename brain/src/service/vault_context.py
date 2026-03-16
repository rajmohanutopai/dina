"""Agentic vault context assembly for LLM reasoning.

When a user asks Dina something (e.g. "I need a new office chair"), the
Brain's reasoning agent autonomously decides which persona vaults to query,
what search terms to use, and how to assemble the context — all via LLM
function calling.

Architecture (from ARCHITECTURE.md, "Sancho scenario"):

    User prompt + tool declarations → LLM (thinks)
      → LLM calls list_personas → execute → return results
      → LLM calls search_vault("consumer", "office chair") → execute
      → LLM calls search_vault("personal", "back pain") → execute
      → LLM generates final personalized response

The LLM is the agent.  It decides which tools to call, in what order,
with what arguments.  Python just executes the tool calls and feeds
results back.  No hardcoded keyword matching, no procedural classification.

Tool declarations are provider-agnostic dicts.  The LLM router and
provider adapters translate them into provider-specific formats
(google.genai FunctionDeclaration, OpenAI function schema, etc.).

No imports from adapter/ — only port protocols, domain types, and
sibling services.
"""

from __future__ import annotations

import json
from typing import Any

import structlog

from ..domain.errors import ApprovalRequiredError, PersonaLockedError
from ..port.core_client import CoreClient

log = structlog.get_logger(__name__)

# Maximum tool-calling turns before forcing a text response.
_MAX_TOOL_TURNS = 6

# Maximum items to return per search_vault call.
_MAX_ITEMS_PER_QUERY = 5

# Maximum items to return per browse_vault / list_personas preview.
_BROWSE_LIMIT = 10


# ---------------------------------------------------------------------------
# Tool Declarations — provider-agnostic schema
# ---------------------------------------------------------------------------

VAULT_TOOLS: list[dict[str, Any]] = [
    {
        "name": "list_personas",
        "description": (
            "List the user's available persona vaults with a preview of "
            "what each contains. Returns persona names and recent item "
            "summaries so you know what context is available. "
            "Call this FIRST to discover which vaults to explore further."
        ),
        "parameters": {
            "type": "object",
            "properties": {},
        },
    },
    {
        "name": "browse_vault",
        "description": (
            "Browse the recent contents of a persona vault. Returns the "
            "most recent item summaries WITHOUT requiring a search query. "
            "Use this to discover what data exists in a persona before "
            "searching for specifics. The results show summaries and item "
            "types — use the exact terms from these summaries in "
            "subsequent search_vault calls for precise matches."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "persona": {
                    "type": "string",
                    "description": (
                        "The persona vault to browse. Must be one of the "
                        "personas returned by list_personas."
                    ),
                },
            },
            "required": ["persona"],
        },
    },
    {
        "name": "search_vault",
        "description": (
            "Search a persona vault for items matching a specific query. "
            "The search combines keyword matching AND semantic similarity, "
            "so it can find related concepts even without exact word matches. "
            "For example, searching 'back pain' can find items about "
            "'lumbar disc herniation'. You may call this multiple times "
            "with different personas and queries."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "persona": {
                    "type": "string",
                    "description": (
                        "The persona vault to search. Must be one of the "
                        "personas returned by list_personas."
                    ),
                },
                "query": {
                    "type": "string",
                    "description": (
                        "Search query — natural language describing what "
                        "you're looking for. The search uses both keyword "
                        "matching and semantic similarity, so related "
                        "concepts are found even without exact word matches."
                    ),
                },
            },
            "required": ["persona", "query"],
        },
    },
]


def _build_gemini_tools() -> list[Any]:
    """Build google.genai Tool objects from the provider-agnostic schema."""
    try:
        from google.genai import types
    except ImportError:
        return []

    declarations = []
    for tool_def in VAULT_TOOLS:
        declarations.append(types.FunctionDeclaration(
            name=tool_def["name"],
            description=tool_def["description"],
            parameters=tool_def["parameters"],
        ))

    return [types.Tool(function_declarations=declarations)]


# ---------------------------------------------------------------------------
# Tool Executor — maps tool names to actual async operations
# ---------------------------------------------------------------------------


class ToolExecutor:
    """Executes tool calls against the core client.

    Each tool function receives the call's args dict and returns a
    JSON-serializable result dict.
    """

    def __init__(self, core: CoreClient, llm_router: Any = None) -> None:
        self._core = core
        self._llm_router = llm_router
        self._tools_called: list[dict] = []
        # Agent context — set before tool execution to attribute vault access
        # to the originating agent instead of Brain's service key.
        self.agent_did: str = ""
        self.session: str = ""

    @property
    def tools_called(self) -> list[dict]:
        """History of tool calls executed in this session."""
        return self._tools_called

    @property
    def was_enriched(self) -> bool:
        """True if any vault data tool call returned results."""
        return any(
            tc["name"] in ("search_vault", "browse_vault")
            and tc.get("result_count", 0) > 0
            for tc in self._tools_called
        )

    async def execute(self, name: str, args: dict) -> dict:
        """Execute a tool call and return the result."""
        handler = {
            "list_personas": self._list_personas,
            "browse_vault": self._browse_vault,
            "search_vault": self._search_vault,
        }.get(name)

        if handler is None:
            result = {"error": f"Unknown tool: {name}"}
        else:
            try:
                result = await handler(args)
            except ApprovalRequiredError:
                raise  # propagate — must reach the CLI as an error, not a tool result
            except Exception as exc:
                log.warning("tool_executor.error", tool=name, error=str(exc))
                result = {"error": str(exc)}

        self._tools_called.append({
            "name": name,
            "args": args,
            "result_count": len(result.get("items", result.get("personas", []))),
        })
        return result

    @staticmethod
    def _normalize_persona(name: str) -> str:
        """Strip the 'persona-' prefix that Core adds to persona IDs.

        Core's ``PersonaManager.Create`` stores personas as ``persona-{name}``
        (e.g. ``persona-personal``), and ``List`` returns these prefixed IDs.
        But vault operations (``/v1/vault/query``, ``/v1/vault/store``) expect
        the short name (``personal``).  This helper normalizes both forms to
        the short name so the LLM gets clean names and vault calls succeed.
        """
        if name.startswith("persona-"):
            return name[len("persona-"):]
        return name

    async def _list_personas(self, args: dict) -> dict:
        """List available persona vaults with preview of contents."""
        try:
            raw_personas = await self._core.list_personas()
        except Exception as exc:
            log.warning("tool_executor.list_personas_failed", error=str(exc))
            return {"personas": [], "error": str(exc)}

        # Normalize persona IDs: strip 'persona-' prefix so vault calls work.
        personas = [self._normalize_persona(p) for p in raw_personas]

        # Fetch a brief preview from each persona so the LLM knows
        # what kind of data is stored (without requiring a search term).
        persona_info = []
        for persona in personas:
            info: dict[str, Any] = {"name": persona}
            try:
                # Fetch recent items (empty query = most recent items)
                items = await self._core.search_vault(
                    persona, query="", mode="fts5",
                    agent_did=self.agent_did, session=self.session,
                )
                if items:
                    summaries = [
                        it.get("Summary", it.get("summary", ""))[:100]
                        for it in items[:_BROWSE_LIMIT]
                        if it.get("Summary") or it.get("summary")
                    ]
                    types_found = list({
                        it.get("Type", it.get("type", "unknown"))
                        for it in items
                    })
                    info["item_count"] = len(items)
                    info["types"] = types_found
                    info["recent_summaries"] = summaries[:5]
                else:
                    info["item_count"] = 0
                    info["types"] = []
                    info["recent_summaries"] = []
            except PersonaLockedError:
                info["status"] = "locked"
            except ApprovalRequiredError:
                info["status"] = "approval_required"
            except Exception:
                info["status"] = "browse_failed"

            persona_info.append(info)

        return {"personas": persona_info}

    async def _browse_vault(self, args: dict) -> dict:
        """Browse recent contents of a persona vault (no search query needed)."""
        persona = args.get("persona", "")
        if not persona:
            return {"items": [], "error": "persona is required"}

        try:
            items = await self._core.search_vault(
                persona, query="", mode="fts5",
                agent_did=self.agent_did, session=self.session,
            )
        except PersonaLockedError:
            log.info("tool_executor.persona_locked", persona=persona)
            return {
                "items": [],
                "note": f"Persona '{persona}' is locked. Skip it.",
            }
        except ApprovalRequiredError:
            raise  # propagate — must reach the CLI as an error
        except Exception as exc:
            log.warning(
                "tool_executor.browse_failed",
                persona=persona,
                error=str(exc),
            )
            return {"items": [], "error": str(exc)}

        simplified = []
        for item in items[:_BROWSE_LIMIT]:
            entry: dict[str, str] = {}
            for key in ("Summary", "summary", "BodyText", "body_text",
                        "Type", "type", "id"):
                val = item.get(key, "")
                if val:
                    entry[key] = str(val)[:500]
            if entry:
                simplified.append(entry)

        return {"items": simplified, "persona": persona}

    async def _search_vault(self, args: dict) -> dict:
        """Search a persona vault."""
        persona = args.get("persona", "")
        query = args.get("query", "")

        if not persona or not query:
            return {"items": [], "error": "persona and query are required"}

        # Generate embedding for the search query (enables semantic matching).
        embedding = None
        if self._llm_router is not None:
            try:
                embedding = await self._llm_router.embed(query)
            except Exception as exc:
                log.warning(
                    "tool_executor.embed_failed",
                    query=query[:50],
                    error=str(exc),
                )

        try:
            items = await self._core.search_vault(
                persona, query, mode="hybrid", embedding=embedding,
                agent_did=self.agent_did, session=self.session,
            )
        except PersonaLockedError:
            log.info("tool_executor.persona_locked", persona=persona)
            return {
                "items": [],
                "note": f"Persona '{persona}' is locked. Skip it.",
            }
        except ApprovalRequiredError:
            raise  # propagate — must reach the CLI as an error
        except Exception as exc:
            log.warning(
                "tool_executor.search_failed",
                persona=persona,
                error=str(exc),
            )
            return {"items": [], "error": str(exc)}

        # Cap results and extract relevant fields
        capped = items[:_MAX_ITEMS_PER_QUERY]
        simplified = []
        for item in capped:
            entry: dict[str, str] = {}
            for key in ("Summary", "summary", "BodyText", "body_text",
                        "Type", "type", "id"):
                val = item.get(key, "")
                if val:
                    entry[key] = str(val)[:500]
            if entry:
                simplified.append(entry)

        return {"items": simplified, "persona": persona, "query": query}


# ---------------------------------------------------------------------------
# ReasoningAgent — agentic tool-calling loop
# ---------------------------------------------------------------------------

_SYSTEM_PROMPT = """\
You are Dina, a sovereign personal AI assistant. You have access to the user's \
encrypted persona vaults containing personal context — health records, purchase \
history, work patterns, family details, financial data, and product reviews.

When the user asks a question, gather relevant vault context before answering:

1. Call list_personas — this returns each persona's name, item types, and \
recent summaries. Read the summaries carefully to understand what data exists.

2. For personas that look relevant, call search_vault with natural language \
queries describing what you're looking for. The search uses both keyword matching \
AND semantic similarity — it can find related concepts even without exact word \
matches (e.g. searching "back pain" finds items about "lumbar disc herniation").

3. If you need a broader view of a persona, call browse_vault to see recent \
items without requiring a specific search term.

4. Synthesize all gathered context with the user's query into a personalized answer.

Rules:
- Explore personas whose previews suggest relevant context.
- Use natural, descriptive search queries — the search understands meaning.
- Reference specific vault details in your response.
- Weigh verified/trusted sources heavily over unverified ones.
- Skip locked personas gracefully.
- Never fabricate vault data — only use what the tools return.\
"""


async def _scrub_tool_result(
    entity_vault: Any,
    tool_result: dict,
    accumulated_vault: dict[str, str],
) -> tuple[dict, dict[str, str]]:
    """Scrub PII from a tool result dict before it enters the LLM messages.

    Serializes the dict to JSON, runs it through the entity vault's
    two-tier scrubber (Go regex + Presidio NER), then parses back.
    New token→original mappings are merged into ``accumulated_vault``.

    Returns
    -------
    tuple[dict, dict[str, str]]
        ``(scrubbed_result, updated_accumulated_vault)``
    """
    raw = json.dumps(tool_result, ensure_ascii=False)
    try:
        scrubbed_text, new_vault = await entity_vault.scrub(raw)
        accumulated_vault = {**accumulated_vault, **new_vault}
        return json.loads(scrubbed_text), accumulated_vault
    except Exception:
        # If scrubbing fails, refuse to send raw data to cloud.
        # Return a safe fallback that tells the LLM scrubbing failed.
        log.warning("reasoning_agent.tool_result_scrub_failed")
        return {"error": "PII scrubbing failed — result redacted"}, accumulated_vault


class ReasoningAgent:
    """Agentic reasoning via LLM function calling.

    The LLM autonomously decides which vault tools to call, executes them,
    and generates a personalized response using the gathered context.

    Parameters
    ----------
    core:
        HTTP client for dina-core (vault queries, persona listing).
    llm_router:
        Multi-provider LLM routing service.
    """

    def __init__(self, core: CoreClient, llm_router: Any) -> None:
        self._core = core
        self._llm = llm_router

    def _get_tools(self) -> list[dict]:
        """Return provider-agnostic tool declarations.

        Each provider adapter is responsible for converting these dicts
        into its native format (Gemini FunctionDeclaration, OpenAI
        function schema, Claude tool schema, etc.).
        """
        return VAULT_TOOLS

    async def reason(
        self,
        prompt: str,
        persona_tier: str = "default",
        entity_vault: Any = None,
        provider: str | None = None,
        agent_did: str = "",
        session: str = "",
    ) -> dict:
        """Run the agentic reasoning loop.

        Parameters
        ----------
        prompt:
            The user's natural language query.
        persona_tier:
            Privacy tier for LLM routing.
        entity_vault:
            Optional ``EntityVaultService`` for PII scrubbing of tool
            results before they are sent to a cloud LLM.  When provided,
            every tool result is scrubbed and the accumulated vault
            mapping is returned in ``result["_tool_vault"]`` so the
            caller can rehydrate the final response.
        provider:
            Optional explicit provider name to use for LLM routing
            (e.g. ``"gemini"``, ``"openai"``).  When ``None``, the
            router selects a provider based on task type and tier.

        Returns
        -------
        dict
            Response with ``content``, ``model``, ``vault_context_used``,
            ``tools_called``, and standard LLM response fields.
        """
        executor = ToolExecutor(self._core, llm_router=self._llm)
        # Forward agent context so vault calls are attributed to the agent
        executor.agent_did = agent_did
        executor.session = session
        tools = self._get_tools()

        # Accumulated PII vault from scrubbing tool results.
        accumulated_vault: dict[str, str] = {}

        if not tools:
            # No tool support (google-genai not installed) — pass-through
            log.warning("reasoning_agent.no_tools_available")
            result = await self._llm.route(
                task_type="complex_reasoning",
                prompt=prompt,
                persona_tier=persona_tier,
                provider=provider,
            )
            result["vault_context_used"] = False
            result["tools_called"] = []
            return result

        # Build initial messages
        messages: list[dict] = [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ]

        # Agentic loop: send → tool calls → execute → feed back → repeat
        for turn in range(_MAX_TOOL_TURNS):
            result = await self._llm.route(
                task_type="complex_reasoning",
                prompt=prompt,
                persona_tier=persona_tier,
                messages=messages,
                tools=tools,
                provider=provider,
            )

            tool_calls = result.get("tool_calls")

            if not tool_calls:
                # LLM generated a text response — done
                log.info(
                    "reasoning_agent.complete",
                    turns=turn + 1,
                    tools_called=len(executor.tools_called),
                    enriched=executor.was_enriched,
                )
                result["vault_context_used"] = executor.was_enriched
                result["tools_called"] = executor.tools_called
                if accumulated_vault:
                    result["_tool_vault"] = accumulated_vault
                return result

            # Execute each tool call
            log.info(
                "reasoning_agent.tool_turn",
                turn=turn + 1,
                calls=[tc["name"] for tc in tool_calls],
            )

            # Record the model's tool call in conversation history
            messages.append({
                "role": "tool_call",
                "tool_calls": tool_calls,
            })

            # Execute tools and collect responses
            tool_responses = []
            for tc in tool_calls:
                tool_result = await executor.execute(tc["name"], tc.get("args", {}))

                # Scrub PII from tool results before they enter the
                # message array (which gets sent to the cloud LLM).
                if entity_vault is not None:
                    tool_result, accumulated_vault = await _scrub_tool_result(
                        entity_vault, tool_result, accumulated_vault,
                    )

                tool_responses.append({
                    "name": tc["name"],
                    "response": tool_result,
                    "id": tc.get("id"),
                })

            # Feed tool results back to the LLM
            messages.append({
                "role": "tool_response",
                "tool_responses": tool_responses,
            })

        # Exhausted max turns — make one final call without tools to force text
        log.warning("reasoning_agent.max_turns_reached")
        result = await self._llm.route(
            task_type="complex_reasoning",
            prompt=prompt,
            persona_tier=persona_tier,
            messages=messages,
            provider=provider,
        )
        result["vault_context_used"] = executor.was_enriched
        result["tools_called"] = executor.tools_called
        if accumulated_vault:
            result["_tool_vault"] = accumulated_vault
        return result


# ---------------------------------------------------------------------------
# VaultContextAssembler — backward-compatible wrapper
# ---------------------------------------------------------------------------


class VaultContextAssembler:
    """Agentic vault context assembly for LLM reasoning.

    Wraps ``ReasoningAgent`` with the same ``enrich()`` API used by
    ``GuardianLoop._handle_reason()``.  The LLM autonomously decides
    which tools to call via function calling — no hardcoded classification.

    Parameters
    ----------
    core:
        HTTP client for dina-core (vault queries, persona listing).
    llm_router:
        Multi-provider LLM routing service.
    """

    def __init__(self, core: CoreClient, llm_router: Any) -> None:
        self._agent = ReasoningAgent(core=core, llm_router=llm_router)

    async def enrich(
        self,
        prompt: str,
        persona_tier: str = "open",
        entity_vault: Any = None,
        provider: str | None = None,
    ) -> tuple[str, bool]:
        """Enrich a prompt with vault context via agentic reasoning.

        Parameters
        ----------
        prompt:
            The user's original query.
        persona_tier:
            Privacy tier of the requesting persona.
        entity_vault:
            Optional PII scrubber for tool results sent to cloud LLMs.
        provider:
            Optional explicit provider name for LLM routing.

        Returns
        -------
        tuple[str, bool]
            (enriched_response, was_enriched).
        """
        result = await self._agent.reason(
            prompt, persona_tier, entity_vault=entity_vault, provider=provider,
        )
        content = result.get("content", prompt)
        was_enriched = result.get("vault_context_used", False)
        return content, was_enriched

    async def reason(
        self,
        prompt: str,
        persona_tier: str = "default",
        entity_vault: Any = None,
        provider: str | None = None,
        agent_did: str = "",
        session: str = "",
    ) -> dict:
        """Run full agentic reasoning and return the complete result.

        Unlike ``enrich()`` which returns just (content, bool), this
        returns the full LLM response dict including model info, token
        counts, and tool call history.

        Parameters
        ----------
        entity_vault:
            Optional PII scrubber for tool results sent to cloud LLMs.
        provider:
            Optional explicit provider name for LLM routing.
        """
        return await self._agent.reason(
            prompt, persona_tier, entity_vault=entity_vault, provider=provider,
            agent_did=agent_did, session=session,
        )
