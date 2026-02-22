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


class _GuardianLoop:
    """Stub for GuardianLoop — the brain's main event processing loop.

    Will be implemented in ``service/guardian.py``.

    The guardian accepts events from core and:
    1. Classifies silence priority (fiduciary/solicited/engagement).
    2. Routes agent intents through the safety layer.
    3. Delegates reasoning tasks to the LLM router.
    4. Orchestrates crash recovery via the scratchpad.
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

        Stub implementation delegates to LLM router for reason-type
        events and returns a default action for everything else.
        """
        event_type = event.get("type", "")

        if event_type == "reason":
            prompt = event.get("prompt", "")
            persona_tier = event.get("persona_tier", "open")
            try:
                result = await self._llm_router.route(
                    task_type="reason",
                    prompt=prompt,
                    persona_tier=persona_tier,
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

        # Default: classify and return action
        return {
            "status": "ok",
            "action": "save_for_briefing",
            "classification": "engagement",
        }

    async def classify_silence(self, event: dict) -> str:
        """Classify an event's silence priority.

        Stub implementation defaults to engagement (Silence First).
        """
        return "engagement"


class _SpacyScrubber:
    """Stub for SpacyScrubber — Tier 2 PII scrubbing via spaCy NER.

    Will be implemented in ``adapter/scrubber_spacy.py``.
    Graceful degradation: if spaCy or en_core_web_sm is not installed,
    the scrubber is set to None and cloud LLM calls will use Tier 1 only.
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

    google_key = os.environ.get("GOOGLE_API_KEY", "").strip()
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

    brain_api = create_brain_app(guardian, sync_engine, cfg.brain_token)
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
