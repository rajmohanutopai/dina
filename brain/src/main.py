"""Composition root for the Dina Brain application.

Same principle as Go's ``main.go`` — every dependency is constructed
explicitly here, wired together, and injected into the sub-apps.
There is no magic DI framework: the dependency graph is plainly
visible in the source code.

This is the ONLY file that imports from ``adapter/``.  Services and
routes depend only on port protocols and domain types.

Module isolation rules:
    - ``dina_brain`` never imports from ``dina_admin``.
    - ``dina_admin`` never imports from ``dina_brain``.
    - Both sub-apps receive their dependencies via function arguments.

Maps to Brain TEST_PLAN SS9 (Configuration), SS10 (API Endpoints),
SS11 (Error Handling & Resilience), SS13 (Crash Traceback Safety).
"""

from __future__ import annotations

import logging
import os

from fastapi import FastAPI

from .infra.config import BrainConfig, load_brain_config
from .infra.logging import setup_logging

# -- Adapters (only imported here) --
from .adapter.core_http import CoreHTTPClient
from .adapter.llm_llama import LlamaProvider
from .adapter.llm_gemini import GeminiProvider
from .adapter.llm_claude import ClaudeProvider
from .adapter.llm_openai import OpenAIProvider
from .adapter.llm_openrouter import OpenRouterProvider
from .adapter.mcp_stdio import MCPStdioClient

# -- Services --
from .service.llm_router import LLMRouter
from .service.entity_vault import EntityVaultService
from .service.scratchpad import ScratchpadService

# -- Sub-apps --
from .dina_brain.app import create_brain_app
from .dina_admin.app import create_admin_app

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Stub classes for services not yet implemented
# ---------------------------------------------------------------------------
# These stubs satisfy the wiring contract so that the composition root
# can construct all dependencies without import errors.  Each stub will
# be replaced by a real implementation in its own module.


class _NudgeAssembler:
    """Stub for NudgeAssembler — context injection nudge builder.

    Will be implemented in ``service/nudge.py``.
    """

    def __init__(self, core: CoreHTTPClient, llm: LLMRouter, entity_vault: EntityVaultService) -> None:
        self._core = core
        self._llm = llm
        self._entity_vault = entity_vault


class _SyncEngine:
    """Stub for SyncEngine — ingestion pipeline orchestrator.

    Will be implemented in ``service/sync_engine.py``.
    """

    def __init__(self, core: CoreHTTPClient, mcp: MCPStdioClient, llm: LLMRouter) -> None:
        self._core = core
        self._mcp = mcp
        self._llm = llm


# ---------------------------------------------------------------------------
# Deterministic action gates — LLM can never override these boundaries
# ---------------------------------------------------------------------------

_SAFE_ACTIONS: frozenset[str] = frozenset({
    "search", "lookup", "read", "query",
})
_HIGH_ACTIONS: frozenset[str] = frozenset({
    "transfer_money", "share_data", "delete_data", "sign_contract",
})
_MODERATE_ACTIONS: frozenset[str] = frozenset({
    "send_email", "draft_create", "install_extension",
    "form_fill", "calendar_create",
})

_FIDUCIARY_KEYWORDS: frozenset[str] = frozenset({
    "fraud", "bank_alert", "security_alert", "medication_due",
    "emergency", "license_expire", "payment_overdue",
})
_SOLICITED_KEYWORDS: frozenset[str] = frozenset({
    "user_requested", "reply", "callback",
})
class _GuardianLoop:
    """Guardian Loop — the brain's main event processing loop.

    The guardian accepts events from core and:
    1. Classifies silence priority (fiduciary/solicited/engagement).
    2. Routes agent intents through the safety layer.
    3. Delegates reasoning tasks to the LLM router.
    4. Orchestrates crash recovery via the scratchpad.

    Key principle: **LLM reasons, boundaries are deterministic.**
    The LLM can enhance classification for ambiguous cases, but it
    can never downgrade a fiduciary event or auto-approve a high-risk
    action.  Hard gates are checked BEFORE the LLM is consulted.
    """

    def __init__(
        self,
        core: CoreHTTPClient,
        llm_router: LLMRouter,
        scrubber: object | None,
        entity_vault: EntityVaultService,
        nudge_assembler: _NudgeAssembler,
        scratchpad: ScratchpadService,
    ) -> None:
        self._core = core
        self._llm_router = llm_router
        self._scrubber = scrubber
        self._entity_vault = entity_vault
        self._nudge = nudge_assembler
        self._scratchpad = scratchpad

    async def process_event(self, event: dict) -> dict:
        """Process an incoming event.

        Routes by event type:
        - ``reason``:          Full LLM reasoning via router.
        - ``agent_intent``:    Deterministic risk gates + LLM for unknowns.
        - ``classify_silence``: Deterministic tier gates + LLM for ambiguous.
        - Everything else:     Default engagement classification.
        """
        event_type = event.get("type", "")

        if event_type == "reason":
            return await self._handle_reason(event)

        if event_type == "agent_intent":
            return await self._handle_agent_intent(event)

        if event_type == "classify_silence":
            return await self._handle_classify_silence(event)

        # Default: classify and return action
        return {
            "status": "ok",
            "action": "save_for_briefing",
            "classification": "engagement",
        }

    async def classify_silence(self, event: dict) -> str:
        """Classify an event's silence priority.

        Delegates to ``_handle_classify_silence`` and returns the tier.
        """
        result = await self._handle_classify_silence(
            {"type": "classify_silence", **event},
        )
        return result.get("classification", "engagement")

    # -- reason ---------------------------------------------------------------

    async def _handle_reason(self, event: dict) -> dict:
        """Handle ``reason`` events via LLM router."""
        prompt = event.get("prompt", "")
        persona_tier = event.get("persona_tier", "open")
        provider = event.get("provider")
        try:
            result = await self._llm_router.route(
                task_type="reason",
                prompt=prompt,
                persona_tier=persona_tier,
                provider=provider,
            )
            return {
                "status": "ok",
                "content": result.get("content", ""),
                "model": result.get("model"),
                "tokens_in": result.get("tokens_in"),
                "tokens_out": result.get("tokens_out"),
            }
        except Exception as exc:
            return {
                "status": "error",
                "action": "llm_unavailable",
                "response": {"error": str(exc)},
            }

    # -- agent intent ---------------------------------------------------------

    async def _handle_agent_intent(self, event: dict) -> dict:
        """Classify agent intent risk.  LLM reasons, boundaries are deterministic.

        1. Extract action from event payload.
        2. Check deterministic hard gates first (known actions).
        3. If action is unknown and LLM available, ask it to classify.
        4. Apply deterministic gating on the final risk level.
        """
        # Support both nested {"payload": {"action": ...}} and flat {"action": ...}
        payload = event.get("payload", {})
        action = payload.get("action") or event.get("action", "")
        target = payload.get("target") or event.get("target", "")
        agent_did = payload.get("agent_did") or event.get("agent_did", "")

        # --- Deterministic hard gates (LLM cannot override) ---
        if action in _SAFE_ACTIONS:
            risk = "SAFE"
        elif action in _HIGH_ACTIONS:
            risk = "HIGH"
        elif action in _MODERATE_ACTIONS:
            risk = "MODERATE"
        else:
            # Unknown action — ask LLM if available, default MODERATE
            risk = await self._llm_classify_risk(action, target, agent_did)

        # --- Deterministic gating ---
        approved = risk == "SAFE"
        requires_approval = risk in ("MODERATE", "HIGH")

        return {
            "status": "ok",
            "action": action,
            "risk": risk,
            "approved": approved,
            "requires_approval": requires_approval,
            "classification": risk.lower(),
        }

    async def _llm_classify_risk(
        self, action: str, target: str, agent_did: str,
    ) -> str:
        """Use LLM to classify risk of an unknown action.

        Falls back to MODERATE if LLM is unavailable.
        """
        try:
            result = await self._llm_router.route(
                task_type="reason",
                prompt=(
                    f"Classify the risk level of this autonomous agent action.\n"
                    f"Action: {action}\n"
                    f"Target: {target}\n"
                    f"Agent: {agent_did}\n\n"
                    f"Respond with exactly one word: SAFE, MODERATE, or HIGH"
                ),
                persona_tier="open",
            )
            content = result.get("content", "").strip().upper()
            # Accept only valid risk categories
            for valid in ("SAFE", "MODERATE", "HIGH"):
                if valid in content:
                    return valid
        except Exception:
            pass
        return "MODERATE"  # Default: when in doubt, require approval

    # -- silence classification -----------------------------------------------

    async def _handle_classify_silence(self, event: dict) -> dict:
        """Classify silence tier.  LLM reasons, routing is deterministic.

        1. Check deterministic hard gates (fiduciary keywords always Tier 1).
        2. If ambiguous and LLM available, ask it to classify.
        3. Apply deterministic routing based on tier.
        """
        payload = event.get("payload", event)
        body = str(payload.get("body", ""))
        source = str(payload.get("source", ""))
        priority = str(payload.get("priority", ""))

        # Build searchable text from body + source + type
        search_text = (body + " " + source + " " + priority).lower()

        # --- Fiduciary: ALWAYS interrupts (LLM cannot demote) ---
        if priority == "fiduciary" or any(
            kw in search_text for kw in _FIDUCIARY_KEYWORDS
        ):
            return {
                "status": "ok",
                "action": "interrupt",
                "classification": "fiduciary",
            }

        # --- Solicited: user asked, notify ---
        if priority == "solicited" or any(
            kw in search_text for kw in _SOLICITED_KEYWORDS
        ):
            return {
                "status": "ok",
                "action": "notify",
                "classification": "solicited",
            }

        # --- Ambiguous: ask LLM, default to engagement (Silence First) ---
        tier = await self._llm_classify_silence(body)
        action_map = {
            "fiduciary": "interrupt",
            "solicited": "notify",
            "engagement": "save_for_briefing",
        }
        return {
            "status": "ok",
            "action": action_map.get(tier, "save_for_briefing"),
            "classification": tier,
        }

    async def _llm_classify_silence(self, body: str) -> str:
        """Use LLM to classify silence tier.  Falls back to engagement."""
        try:
            result = await self._llm_router.route(
                task_type="reason",
                prompt=(
                    f"Classify this notification's urgency tier.\n\n"
                    f"Content: {body}\n\n"
                    f"Respond with exactly one word:\n"
                    f"- fiduciary (silence would cause real harm)\n"
                    f"- solicited (user explicitly asked for this)\n"
                    f"- engagement (nice to know, can wait)"
                ),
                persona_tier="open",
            )
            content = result.get("content", "").strip().lower()
            for valid in ("fiduciary", "solicited", "engagement"):
                if valid in content:
                    return valid
        except Exception:
            pass
        return "engagement"  # Default: Silence First


_SAFE_ENTITIES: frozenset[str] = frozenset({
    "DATE", "TIME", "MONEY", "PERCENT", "QUANTITY",
    "ORDINAL", "CARDINAL", "NORP", "EVENT",
    "WORK_OF_ART", "LAW", "PRODUCT", "LANGUAGE",
})


class _SpacyScrubber:
    """Tier 2 PII scrubbing via spaCy NER.

    Only scrubs PII-relevant entity types (PERSON, ORG, GPE, LOC, FAC).
    SAFE_ENTITIES (DATE, TIME, MONEY, PRODUCT, CARDINAL, etc.) pass
    through unchanged — they are essential for LLM reasoning and do
    not identify anyone.
    """

    def __init__(self) -> None:
        """Load the spaCy model.  Raises ImportError or OSError if missing."""
        import spacy  # noqa: F401
        self._nlp = spacy.load("en_core_web_sm")

    def scrub(self, text: str) -> tuple[str, list[dict]]:
        """Scrub PII entities using spaCy NER."""
        doc = self._nlp(text)
        entities: list[dict] = []
        scrubbed = text
        counters: dict[str, int] = {}

        for ent in doc.ents:
            ent_type = ent.label_
            if ent_type in _SAFE_ENTITIES:
                continue
            if len(ent.text.strip()) <= 2:
                continue
            count = counters.get(ent_type, 0) + 1
            counters[ent_type] = count
            token = f"[{ent_type}_{count}]"
            entities.append({
                "type": ent_type,
                "value": ent.text,
                "token": token,
            })
            scrubbed = scrubbed.replace(ent.text, token, 1)

        return scrubbed, entities

    def detect(self, text: str) -> list[dict]:
        """Detect PII entities without replacing them."""
        doc = self._nlp(text)
        return [
            {"type": ent.label_, "value": ent.text}
            for ent in doc.ents
            if ent.label_ not in _SAFE_ENTITIES and len(ent.text.strip()) > 2
        ]


# ---------------------------------------------------------------------------
# Composition root
# ---------------------------------------------------------------------------


def create_app() -> FastAPI:
    """Construct all dependencies, wire them, and create the master app.

    Follows explicit construction — no service locator, no DI container.

    Construction order:
        1. Load configuration from environment.
        2. Set up structured logging.
        3. Construct adapters (core client, LLM providers, MCP client, scrubber).
        4. Construct services (LLM router, entity vault, nudge, scratchpad, sync, guardian).
        5. Build FastAPI sub-apps (brain API, admin UI).
        6. Mount sub-apps on the master app.
        7. Register the /healthz endpoint (no auth).

    Graceful degradation:
        - LLM providers are optional — brain works without any LLM (degraded).
        - spaCy scrubber is optional — cloud calls use Tier 1 only.
        - Admin UI requires CLIENT_TOKEN — disabled if not set.
    """
    # 1. Load config
    cfg = load_brain_config()
    setup_logging(cfg.log_level)

    log.info(
        "brain.startup",
        extra={
            "core_url": cfg.core_url,
            "listen_port": cfg.listen_port,
            "llm_routing": cfg.llm_routing_enabled,
        },
    )

    # 2. Construct adapters
    core_client = CoreHTTPClient(cfg.core_url, cfg.brain_token)

    # LLM providers (optional — graceful degradation)
    providers: dict[str, object] = {}
    llama_url = cfg.llm_url
    if llama_url:
        try:
            providers["llama"] = LlamaProvider(llama_url)
            log.info("brain.provider.llama", extra={"url": llama_url})
        except Exception as exc:
            log.warning(
                "brain.provider.llama.failed",
                extra={"error": str(exc)},
            )

    google_key = (os.environ.get("GEMINI_API_KEY", "") or os.environ.get("GOOGLE_API_KEY", "")).strip()
    if google_key:
        try:
            providers["gemini"] = GeminiProvider(google_key)
            log.info("brain.provider.gemini")
        except Exception as exc:
            log.warning(
                "brain.provider.gemini.failed",
                extra={"error": str(exc)},
            )

    anthropic_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if anthropic_key:
        try:
            providers["claude"] = ClaudeProvider(anthropic_key)
            log.info("brain.provider.claude")
        except Exception as exc:
            log.warning(
                "brain.provider.claude.failed",
                extra={"error": str(exc)},
            )

    openai_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if openai_key:
        try:
            openai_model = os.environ.get("OPENAI_MODEL", "gpt-5.2").strip()
            providers["openai"] = OpenAIProvider(openai_key, model=openai_model)
            log.info("brain.provider.openai", extra={"model": openai_model})
        except Exception as exc:
            log.warning(
                "brain.provider.openai.failed",
                extra={"error": str(exc)},
            )

    openrouter_key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if openrouter_key:
        try:
            openrouter_model = os.environ.get(
                "OPENROUTER_MODEL", "google/gemini-2.5-flash",
            ).strip()
            providers["openrouter"] = OpenRouterProvider(
                openrouter_key, model=openrouter_model,
            )
            log.info(
                "brain.provider.openrouter",
                extra={"model": openrouter_model},
            )
        except Exception as exc:
            log.warning(
                "brain.provider.openrouter.failed",
                extra={"error": str(exc)},
            )

    mcp_client = MCPStdioClient()

    # spaCy scrubber (optional — graceful degradation if model not installed)
    scrubber: object | None = None
    try:
        scrubber = _SpacyScrubber()
        log.info("brain.scrubber.spacy.loaded")
    except Exception as exc:
        log.warning(
            "brain.scrubber.spacy.unavailable",
            extra={"error": type(exc).__name__},
        )
        scrubber = None

    # 3. Construct services
    llm_router = LLMRouter(
        providers=providers,
        config={"cloud_llm": cfg.cloud_llm},
    )
    entity_vault = EntityVaultService(scrubber=scrubber, core_client=core_client)
    nudge = _NudgeAssembler(core=core_client, llm=llm_router, entity_vault=entity_vault)
    scratchpad = ScratchpadService(core=core_client)
    sync_engine = _SyncEngine(core=core_client, mcp=mcp_client, llm=llm_router)
    guardian = _GuardianLoop(
        core=core_client,
        llm_router=llm_router,
        scrubber=scrubber,
        entity_vault=entity_vault,
        nudge_assembler=nudge,
        scratchpad=scratchpad,
    )

    # 4. Build sub-apps
    master = FastAPI(
        title="Dina Brain",
        description="Sovereign personal AI — the safety layer for autonomous agents.",
        version="0.4.0",
    )

    brain_api = create_brain_app(guardian, sync_engine, cfg.brain_token, scrubber=scrubber)
    admin_ui = create_admin_app(core_client, cfg)

    master.mount("/api", brain_api)
    master.mount("/admin", admin_ui)

    # 5. Register unauthenticated endpoints on the master app

    @master.get("/healthz")
    async def healthz() -> dict:
        """Health check -- no auth required.

        Returns component-level status.  The master app is always
        ``"ok"`` (it started); individual components may be degraded.
        """
        components: dict[str, str] = {"status": "ok"}

        # Check core
        try:
            await core_client.health()
            components["core_client"] = "healthy"
        except Exception:
            components["core_client"] = "unreachable"
            components["status"] = "degraded"

        # Check LLM availability
        if providers:
            components["llm_router"] = "available"
            models = llm_router.available_models()
            components["llm_models"] = ", ".join(models) if models else "none"
        else:
            components["llm_router"] = "no_providers"
            components["status"] = "degraded"

        # Scrubber status
        components["pii_scrubber"] = "loaded" if scrubber else "unavailable"

        return components

    @master.on_event("shutdown")
    async def shutdown_event() -> None:
        """Clean up resources on shutdown."""
        await core_client.close()
        await mcp_client.disconnect_all()
        log.info("brain.shutdown")

    log.info(
        "brain.ready",
        extra={
            "providers": list(providers.keys()),
            "scrubber": "spacy" if scrubber else "none",
        },
    )

    return master


# ---------------------------------------------------------------------------
# Module-level app for uvicorn
# ---------------------------------------------------------------------------
# Usage:  uvicorn src.main:app --host 0.0.0.0 --port 8200
app = create_app()
