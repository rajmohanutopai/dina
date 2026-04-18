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
import uuid
from typing import Any

import structlog

from ..domain.errors import ApprovalRequiredError, PersonaLockedError
from ..port.core_client import CoreClient
from .capabilities.registry import get_ttl

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
    {
        "name": "get_full_content",
        "description": (
            "Retrieve the full original content (L2) of a specific vault item. "
            "Use this only when you need the complete document — for most "
            "questions the summaries from search_vault are sufficient. "
            "Requires the item ID from a previous search result."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "persona": {
                    "type": "string",
                    "description": "The persona vault containing the item.",
                },
                "item_id": {
                    "type": "string",
                    "description": "The item ID from a previous search result.",
                },
            },
            "required": ["persona", "item_id"],
        },
    },
    {
        "name": "search_trust_network",
        "description": (
            "Search the Dina Trust Network for product reviews, merchant ratings, "
            "and trust evidence from verified peers. Use this when the user asks about "
            "buying a product, evaluating a vendor, or checking if something is trustworthy. "
            "Returns attestations from the decentralised trust network — real reviews "
            "from verified identities, not anonymous ratings. "
            "Results include sentiment (positive/neutral/negative), confidence level, "
            "and the reviewer's identity."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": (
                        "What to search for — product name, merchant, brand, or "
                        "category (e.g., 'ergonomic chair', 'ChairMaker', 'laptop')."
                    ),
                },
                "category": {
                    "type": "string",
                    "description": (
                        "Optional category filter (e.g., 'product-review', 'quality', 'e-commerce')."
                    ),
                },
            },
            "required": ["query"],
        },
    },
    # ----- WS2: Service Discovery Tools -----
    {
        "name": "geocode",
        "description": (
            "Convert an address or place name to geographic coordinates (latitude/longitude). "
            "Privacy note: this sends the address to an external geocoding service. "
            "Use when the user mentions a location by name and you need coordinates for "
            "search_public_services."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "address": {
                    "type": "string",
                    "description": "Address or place name to geocode (e.g. 'Silk Board Junction, Bangalore').",
                },
            },
            "required": ["address"],
        },
    },
    {
        "name": "search_public_services",
        "description": (
            "Search for nearby public services (bus routes, taxi, delivery, etc.) by capability "
            "and location. Returns ranked candidates with operator DIDs that can be queried. "
            "Use after geocoding to find services near the user's location."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "capability": {
                    "type": "string",
                    "description": "Service capability to search for (e.g. 'eta_query').",
                },
                "lat": {"type": "number", "description": "Latitude of the search location."},
                "lng": {"type": "number", "description": "Longitude of the search location."},
                "q": {
                    "type": "string",
                    "description": "Optional text filter (e.g. 'bus 42', 'AC bus').",
                },
            },
            "required": ["capability", "lat", "lng"],
        },
    },
    {
        "name": "query_service",
        "description": (
            "Send a query to a specific public service operator and track the response. "
            "Use after search_public_services to query the best candidate. "
            "The response will be delivered asynchronously via a workflow event."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "operator_did": {
                    "type": "string",
                    "description": "DID of the service operator (from search_public_services results).",
                },
                "capability": {
                    "type": "string",
                    "description": "The capability to query (e.g. 'eta_query').",
                },
                "params": {
                    "type": "object",
                    "description": "Capability-specific parameters (e.g. {\"location\": {\"lat\": 12.9, \"lng\": 77.6}}).",
                },
                "service_name": {
                    "type": "string",
                    "description": "Human-readable service name (for notifications).",
                },
                "schema_hash": {
                    "type": "string",
                    "description": "Schema hash from search_public_services (for version matching).",
                },
                "params_schema": {
                    "type": "object",
                    "description": "JSON Schema for params (from search_public_services). Used for sender-side validation.",
                },
            },
            "required": ["operator_did", "capability", "params"],
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

    def __init__(
        self,
        core: CoreClient,
        llm_router: Any = None,
        appview_client: Any = None,
        mcp_client: Any = None,
    ) -> None:
        self._core = core
        self._llm_router = llm_router
        self._appview = appview_client  # WS2: AppView search for public services
        self._mcp = mcp_client          # WS2: MCP client for geocoding
        self._tools_called: list[dict] = []
        self._approval_required: dict | None = None  # set when a persona needs approval
        # Agent context — set before tool execution to attribute vault access
        # to the originating agent instead of Brain's service key.
        self.agent_did: str = ""
        self.session: str = ""
        # User-origin context — when set, Core auto-unlocks sensitive personas.
        self.user_origin: str = ""

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
            "get_full_content": self._get_full_content,
            "browse_vault": self._browse_vault,
            "search_vault": self._search_vault,
            "search_trust_network": self._search_trust_network,
            # WS2: Service Discovery
            "geocode": self._geocode,
            "search_public_services": self._search_public_services,
            "query_service": self._query_service,
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
                    user_origin=self.user_origin,
                )
                if items:
                    summaries = [
                        (it.summary or "")[:100]
                        for it in items[:_BROWSE_LIMIT]
                        if it.summary
                    ]
                    types_found = list({
                        it.type or "unknown"
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
            except ApprovalRequiredError as exc:
                info["status"] = "approval_required"
                info["message"] = (
                    f"Access to {persona} requires approval. "
                    f"The user should run: dina-admin approvals approve <id>"
                )
                if exc.approval_id:
                    info["approval_id"] = exc.approval_id
                # Record for post-reasoning check by Guardian.
                self._approval_required = {
                    "persona": persona,
                    "approval_id": exc.approval_id,
                    "message": f"Access to {persona} persona requires approval.",
                }
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
                user_origin=self.user_origin,
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
            for attr, key in (
                ("summary", "summary"),
                ("body_text", "body_text"),
                ("type", "type"),
                ("id", "id"),
                ("sender", "sender"),
                ("sender_trust", "sender_trust"),
                ("confidence", "confidence"),
                ("retrieval_policy", "retrieval_policy"),
                ("content_l0", "content_l0"),
                ("content_l1", "content_l1"),
                ("enrichment_status", "enrichment_status"),
            ):
                val = getattr(item, attr, None)
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
                user_origin=self.user_origin,
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
            for attr, key in (
                ("summary", "summary"),
                ("body_text", "body_text"),
                ("type", "type"),
                ("id", "id"),
                ("sender", "sender"),
                ("sender_trust", "sender_trust"),
                ("confidence", "confidence"),
                ("retrieval_policy", "retrieval_policy"),
                ("content_l0", "content_l0"),
                ("content_l1", "content_l1"),
                ("enrichment_status", "enrichment_status"),
            ):
                val = getattr(item, attr, None)
                if val:
                    entry[key] = str(val)[:500]
            if entry:
                simplified.append(entry)

        return {"items": simplified, "persona": persona, "query": query}

    async def _get_full_content(self, args: dict) -> dict:
        """Retrieve full L2 content of a specific vault item."""
        persona = args.get("persona", "")
        item_id = args.get("item_id", "")
        if not persona or not item_id:
            return {"error": "persona and item_id are required"}

        try:
            item = await self._core.get_vault_item(
                persona, item_id, user_origin=self.user_origin,
            )
        except Exception as exc:
            return {"error": str(exc)}

        if item is None:
            return {"error": "item not found"}

        # Return L2 (full body) + metadata for context.
        return {
            "id": item.id or "",
            "body_text": item.body_text or "",
            "summary": item.summary or "",
            "type": item.type or "",
            "sender": item.sender or "",
            "sender_trust": item.sender_trust or "",
            "confidence": item.confidence or "",
        }

    async def _search_trust_network(self, args: dict) -> dict:
        """Search the Trust Network for product/merchant trust attestations."""
        query = args.get("query", "")
        category = args.get("category", "")
        if not query:
            return {"error": "query is required"}

        from ..infra.trace_emit import trace as _trace
        _trace("trust_search.request", "brain", {
            "query": query, "category": category or "product-review",
        })

        result = None
        try:
            # Search with both query text and category for best relevance
            result = await self._core.search_trust_network(
                query=query, category=category or "product-review", subject_type="", limit=10,
            )
            raw_count = len(result.get("results", [])) if result else 0
            _trace("trust_search.appview_response", "brain", {
                "query": query, "result_count": raw_count,
            })
            # If no results with category filter, try text-only search
            if result and not result.get("results"):
                log.info("trust_search.fallback_text_only", extra={"query": query})
                result = await self._core.search_trust_network(
                    query=query, category="", subject_type="", limit=10,
                )
                raw_count = len(result.get("results", [])) if result else 0
                log.info("trust_search.fallback_response", extra={
                    "query": query, "result_count": raw_count,
                })
        except Exception as exc:
            log.warning("trust_search.error", extra={"query": query, "error": str(exc)})
            return {"error": str(exc)}

        if result is None:
            log.info("trust_search.no_result", extra={"query": query})
            return {"items": [], "message": f"Trust Network not available or no data for '{query}'."}

        results = result.get("results", [])
        if not results:
            log.info("trust_search.empty", extra={"query": query})
            return {"items": [], "message": f"No trust attestations found for '{query}'."}

        # Format results for the LLM — include sentiment, text, author, confidence.
        items = []
        for r in results[:10]:
            # Extract product/subject name from subjectRefRaw or searchContent
            subject_ref = r.get("subjectRefRaw", {})
            product_name = ""
            if isinstance(subject_ref, dict):
                product_name = subject_ref.get("name", "")
            items.append({
                "product_name": product_name,
                "sentiment": r.get("sentiment", "unknown"),
                "confidence": r.get("confidence", ""),
                "review_text": r.get("searchContent", r.get("text", ""))[:200],
                "reviewer": r.get("authorDid", "")[:30],
                "category": r.get("category", ""),
            })

        _trace("trust_search.result", "brain", {
            "query": query, "item_count": len(items),
            "products": [i["product_name"] for i in items if i["product_name"]],
        })

        return {
            "items": items,
            "count": len(items),
            "message": f"Found {len(items)} trust attestation(s) for '{query}'.",
        }

    # ------------------------------------------------------------------
    # WS2: Service Discovery Tools
    # ------------------------------------------------------------------

    async def _geocode(self, args: dict) -> dict:
        """Geocode an address via MCP call_tool (external service)."""
        import os
        address = args.get("address", "")
        if not address:
            return {"error": "address is required"}

        if self._mcp is None:
            return {"error": "geocoding service not configured"}

        # MCP server/tool configured via env vars.
        server = os.environ.get("DINA_GEOCODE_MCP_SERVER", "")
        tool = os.environ.get("DINA_GEOCODE_MCP_TOOL", "geocode")
        if not server:
            return {"error": "DINA_GEOCODE_MCP_SERVER not set"}

        try:
            result = await self._mcp.call_tool(server, tool, {"address": address})
            return result
        except Exception as exc:
            log.warning("tool_executor.geocode_failed", address=address, error=str(exc))
            return {"error": f"geocoding failed: {exc}"}

    async def _search_public_services(self, args: dict) -> dict:
        """Search AppView for public services by capability and location."""
        capability = args.get("capability", "")
        lat = args.get("lat")
        lng = args.get("lng")
        q = args.get("q", "")

        if not capability or lat is None or lng is None:
            return {"error": "capability, lat, and lng are required"}

        if self._appview is None:
            return {"error": "service discovery not configured"}

        try:
            candidates = await self._appview.search_services(
                capability=capability, lat=lat, lng=lng, q=q or None,
            )
            if not candidates:
                return {"services": [], "message": "No services found for this query."}

            # Brain-side preference re-ranking (no vault data sent externally).
            ranked = await self._rerank_by_preference(candidates)

            # Return per-capability schema + schema_hash so LLM can fill params.
            # Schema hash is sourced from capabilitySchemas[capability].schema_hash
            # (per-capability), not the top-level record hash — the requested
            # capability is what the provider will validate against.
            services = []
            for c in ranked[:10]:
                cap_schemas = c.get("capabilitySchemas") or c.get("capability_schemas") or {}
                svc = {
                    "operator_did": c.get("operatorDid", ""),
                    "name": c.get("name", ""),
                    "capability": capability,
                    "schema_hash": "",
                }
                if isinstance(cap_schemas, dict) and capability in cap_schemas:
                    schema = cap_schemas[capability]
                    svc["params_schema"] = schema.get("params", {})
                    svc["description"] = schema.get("description", "")
                    svc["schema_hash"] = (
                        schema.get("schema_hash")
                        or schema.get("schemaHash")
                        or ""
                    )
                    # Expose the TTL hint so the LLM-path ttl resolver can pick
                    # it up via _query_service. Lives at the schema root, not
                    # nested inside params_schema.
                    ttl_hint = schema.get("default_ttl_seconds")
                    if isinstance(ttl_hint, int) and ttl_hint > 0:
                        svc["default_ttl_seconds"] = ttl_hint
                services.append(svc)

            return {
                "services": services,
                "count": len(services),
            }
        except Exception as exc:
            log.warning("tool_executor.search_services_failed", error=str(exc))
            return {"error": f"service search failed: {exc}"}

    async def _rerank_by_preference(self, candidates: list[dict]) -> list[dict]:
        """Re-rank service candidates using vault preferences (Brain-side only).

        Privacy: vault data never leaves Brain. AppView only sees {capability, lat, lng, q}.
        Searches consumer vault for preference keywords and boosts matching candidates.
        """
        try:
            prefs = await self._core.search_vault(
                "consumer", query="preference transport bus", mode="fts5",
                agent_did=self.agent_did, session=self.session,
                user_origin=self.user_origin,
            )
            if not prefs:
                return candidates

            # Extract preference keywords from vault items.
            pref_keywords = set()
            for item in prefs[:5]:
                if item.summary:
                    for word in item.summary.lower().split():
                        if len(word) > 3:
                            pref_keywords.add(word)

            if not pref_keywords:
                return candidates

            # Score candidates by keyword overlap.
            def score(candidate: dict) -> float:
                text = json.dumps(candidate).lower()
                return sum(1 for kw in pref_keywords if kw in text)

            return sorted(candidates, key=score, reverse=True)
        except Exception:
            return candidates  # fail-open: return original ranking

    async def _query_service(self, args: dict) -> dict:
        """Send a query to a public service via Core POST /v1/service/query."""
        operator_did = args.get("operator_did", "")
        capability = args.get("capability", "")
        params = args.get("params", {})
        service_name = args.get("service_name", "")
        schema_hash = args.get("schema_hash", "")
        params_schema = args.get("params_schema", {})
        default_ttl_seconds = args.get("default_ttl_seconds")

        if not operator_did or not capability:
            return {"error": "operator_did and capability are required"}
        if params is None:
            params = {}

        # Mandatory sender-side validation when schema is present. A
        # malformed remote schema surfaces as SchemaError rather than
        # letting the exception escape and aborting the LLM flow.
        if params_schema:
            import jsonschema
            try:
                jsonschema.validate(params, params_schema)
            except jsonschema.ValidationError as e:
                return {"error": f"Params validation failed: {e.message}"}
            except jsonschema.SchemaError as e:
                return {"error": f"Provider schema is invalid: {e.message}"}

        query_id = str(uuid.uuid4())
        # Prefer the provider-published schema's TTL hint (if any) over
        # the hardcoded registry so unknown capabilities aren't silently
        # capped at 60s. The hint lives at the schema root, not inside
        # params_schema.
        schema_for_ttl: dict = {}
        if isinstance(default_ttl_seconds, int) and default_ttl_seconds > 0:
            schema_for_ttl["default_ttl_seconds"] = default_ttl_seconds
        ttl_seconds = get_ttl(capability, schema_for_ttl)

        try:
            result = await self._core.send_service_query(
                to_did=operator_did,
                capability=capability,
                params=params,
                query_id=query_id,
                ttl_seconds=ttl_seconds,
                service_name=service_name,
                schema_hash=schema_hash,
            )
            return {
                "task_id": result.get("task_id", ""),
                "query_id": result.get("query_id", query_id),
                "message": f"Query sent to {service_name or operator_did}. Response will arrive via workflow event.",
            }
        except Exception as exc:
            log.warning("tool_executor.query_service_failed", error=str(exc))
            return {"error": f"service query failed: {exc}"}


# ---------------------------------------------------------------------------
# ReasoningAgent — agentic tool-calling loop
# ---------------------------------------------------------------------------

from ..prompts import PROMPT_VAULT_CONTEXT_SYSTEM as _SYSTEM_PROMPT

_SYSTEM_PROMPT_OLD = """\
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

4. If the user mentions buying, purchasing, shopping, or evaluating any product \
or vendor, ALWAYS call search_trust_network immediately — do not ask the user \
for permission or clarification first. Search using the product category or name \
you infer from their vault context. The Trust Network contains verified peer \
reviews from real people. Each conversation is stateless (no follow-ups), so you \
must gather all information and answer in a single response.

5. Synthesize all gathered context with the user's query into a personalized answer. \
Never ask "would you like me to check the Trust Network?" — just check it.

Rules:
- Explore personas whose previews suggest relevant context.
- Use natural, descriptive search queries — the search understands meaning.
- Reference specific vault details in your response.
- Skip locked personas gracefully — do NOT tell the user which personas are locked \
or mention approval commands unless they specifically ask about locked data.
- Never fabricate vault data — only use what the tools return.
- Never recommend products, brands, or vendors from your training data. Only \
recommend what the Trust Network or vault tools actually returned. If the Trust \
Network has no data for a query, say so honestly — do not fill the gap with \
your own knowledge. The user trusts Dina because she only cites verified sources.
- You can search and retrieve data but not store or update. If the user asks you to \
remember or save something, respond briefly: "To save that, use /remember <your text>". \
Do NOT say you are read-only or explain limitations — just point them to the command.
- Keep responses concise. For simple greetings ("hello", "hi"), respond briefly \
without listing vault contents, persona status, or system information.
- Never volunteer internal system state (vault names, lock status, approval IDs, \
tool names) unless the user explicitly asks about their data or system status.

Source trust rules (items carry provenance metadata):
- Items with sender_trust "self" are the user's own notes — highest trust.
- Items with sender_trust "contact_ring1" are from verified contacts — cite them by name.
- Items with confidence "low" or sender_trust "unknown" — caveat with "an unverified source claims..."
- Items with retrieval_policy "caveated" — always note the source is unverified.
- Never present caveated or low-confidence items as established facts.
- Prefer high-confidence items from known sources over unverified claims.

Tiered content loading:
- Items have content_l0 (one-line summary) and content_l1 (paragraph overview).
- Use content_l0 for scanning relevance. Use content_l1 for answering most questions.
- Only call get_full_content(item_id) when you need the complete original document \
(e.g., user asks for specific details, exact numbers, or full text).
- If content_l1 is empty (item not yet enriched), use the summary and body fields.\
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

    def __init__(
        self, core: CoreClient, llm_router: Any, owner_name: str = "",
        appview_client: Any = None, mcp_client: Any = None,
    ) -> None:
        self._core = core
        self._llm = llm_router
        self._owner_name = owner_name
        self._appview = appview_client
        self._mcp = mcp_client

    def _get_tools(self) -> list[dict]:
        """Return provider-agnostic tool declarations.

        Each provider adapter is responsible for converting these dicts
        into its native format (Gemini FunctionDeclaration, OpenAI
        function schema, Claude tool schema, etc.).

        WS2 tools (geocode, search_public_services, query_service) are only
        advertised when their dependencies are available.
        """
        # WS2 tool names that require optional deps.
        _SERVICE_TOOLS = {"geocode", "search_public_services", "query_service"}
        tools = []
        for tool in VAULT_TOOLS:
            name = tool["name"]
            if name == "geocode" and self._mcp is None:
                continue
            if name in ("search_public_services", "query_service") and self._appview is None:
                continue
            tools.append(tool)
        return tools

    async def reason(
        self,
        prompt: str,
        persona_tier: str = "default",
        entity_vault: Any = None,
        provider: str | None = None,
        agent_did: str = "",
        session: str = "",
        user_origin: str = "",
        contact_hints: list[dict] | None = None,
    ) -> dict:
        """Run the agentic reasoning loop.

        Parameters
        ----------
        prompt:
            The user's natural language query.
        persona_tier:
            Privacy tier for LLM routing.
        entity_vault:
            ``EntityVaultService`` for PII scrubbing of tool results
            before they are sent to a cloud LLM.  When provided, every
            tool result is scrubbed and the accumulated vault mapping is
            returned in ``result["_tool_vault"]`` so the caller can
            rehydrate the final response.

            **Safety contract (BS3):** Pass ``None`` ONLY when the LLM
            provider is local (on-device). For cloud providers, entity_vault
            MUST be provided — otherwise raw vault data flows unscrubbed.
        provider:
            Optional explicit provider name to use for LLM routing
            (e.g. ``"gemini"``, ``"openai"``).  When ``None``, the
            router selects a provider based on task type and tier.
        user_origin:
            When set (e.g. ``"telegram"``), Core auto-unlocks sensitive
            persona vaults for user-originated requests.

        Returns
        -------
        dict
            Response with ``content``, ``model``, ``vault_context_used``,
            ``tools_called``, and standard LLM response fields.
        """
        executor = ToolExecutor(
            self._core, llm_router=self._llm,
            appview_client=self._appview, mcp_client=self._mcp,
        )
        # Forward agent context so vault calls are attributed to the agent
        executor.agent_did = agent_did
        executor.session = session
        executor.user_origin = user_origin
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
        system = _SYSTEM_PROMPT
        if self._owner_name:
            system += f"\n\nThe user's name is {self._owner_name}."

        # Inject contact alias hints for recall expansion (Phase A).
        contact_hints = contact_hints or []
        if contact_hints:
            hints_text = "\n\nContact alias mappings (use these when searching the vault — " \
                "the user may store facts using either the name or an alias):\n"
            for h in contact_hints:
                aliases = ", ".join(h.get("aliases", []))
                if aliases:
                    hints_text += f"- {h['name']}: also known as {aliases}\n"
            system += hints_text

        messages: list[dict] = [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ]

        # Agentic loop: send → tool calls → execute → feed back → repeat
        import time as _time
        _agent_t0 = _time.monotonic()
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
                _agent_elapsed = _time.monotonic() - _agent_t0
                log.info(
                    "reasoning_agent.complete",
                    turns=turn + 1,
                    tools_called=len(executor.tools_called),
                    enriched=executor.was_enriched,
                    total_elapsed_s=round(_agent_elapsed, 2),
                )
                result["vault_context_used"] = executor.was_enriched
                result["tools_called"] = executor.tools_called
                if accumulated_vault:
                    result["_tool_vault"] = accumulated_vault
                if executor._approval_required:
                    result["_approval_required"] = executor._approval_required
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
                # BS3: If entity_vault is None, tool results flow unscrubbed.
                # This is safe ONLY for local LLMs. Log a warning as
                # defense-in-depth signal for future callers.
                if entity_vault is not None and tc["name"] != "search_trust_network":
                    # Skip PII scrubbing for Trust Network results — they are
                    # public data (product names, review text), not personal info.
                    # Scrubbing them causes false positives (e.g. "X200" → [US_DRIVER_LICENSE_1]).
                    tool_result, accumulated_vault = await _scrub_tool_result(
                        entity_vault, tool_result, accumulated_vault,
                    )
                elif tool_result and len(str(tool_result)) > 50:
                    log.debug(
                        "vault_context.reason.no_entity_vault",
                        extra={"tool": tc["name"], "result_len": len(str(tool_result))},
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

    def __init__(
        self,
        core: CoreClient,
        llm_router: Any,
        owner_name: str = "",
        appview_client: Any = None,
        mcp_client: Any = None,
    ) -> None:
        self._agent = ReasoningAgent(
            core=core, llm_router=llm_router, owner_name=owner_name,
            appview_client=appview_client, mcp_client=mcp_client,
        )

    async def enrich(
        self,
        prompt: str,
        persona_tier: str = "open",
        entity_vault: Any = None,
        provider: str | None = None,
        contact_hints: list[dict] | None = None,
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
            contact_hints=contact_hints or [],
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
        user_origin: str = "",
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
        user_origin:
            When set (e.g. ``"telegram"``), Core auto-unlocks sensitive
            persona vaults for user-originated requests.
        """
        # Build contact alias hints ONLY for contacts mentioned in the query.
        # This avoids leaking unrelated contact aliases into the prompt.
        contact_hints = []
        try:
            resp = await self._agent._core._request("GET", "/v1/contacts")
            contacts = resp.json().get("contacts", [])
            from .contact_matcher import ContactMatcher
            matcher = ContactMatcher(contacts)
            mentions = matcher.find_mentions(prompt)
            mentioned_dids = {m.did for m in mentions}
            for c in contacts:
                aliases = c.get("aliases", [])
                if not aliases:
                    continue
                did = c.get("did", "")
                if did in mentioned_dids:
                    name = c.get("display_name") or c.get("name", "")
                    contact_hints.append({"name": name, "aliases": aliases})
        except Exception:
            pass  # best-effort — agent works without hints

        # Also resolve person surfaces for recall expansion.
        # Person hints use the same format as contact hints (name + synonyms).
        # Only confirmed surfaces are used. Contact aliases take priority.
        try:
            from .person_resolver import PersonResolver
            resolver = PersonResolver(self._agent._core)
            await resolver.refresh()
            resolved = resolver.resolve(prompt)
            for rp in resolved:
                # Skip if this person is already covered by a contact hint.
                already_covered = any(
                    h["name"].lower() == rp.canonical_name.lower()
                    for h in contact_hints
                )
                if already_covered:
                    continue
                if rp.surfaces:
                    contact_hints.append({
                        "name": rp.canonical_name or rp.surfaces[0],
                        "aliases": [s for s in rp.surfaces if s.lower() != (rp.canonical_name or "").lower()],
                    })
        except Exception:
            pass  # best-effort

        return await self._agent.reason(
            prompt, persona_tier, entity_vault=entity_vault, provider=provider,
            agent_did=agent_did, session=session, user_origin=user_origin,
            contact_hints=contact_hints,
        )
