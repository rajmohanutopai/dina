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

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI

from .infra.config import BrainConfig, load_brain_config
from .infra.logging import setup_logging

# -- Adapters (only imported here) --
from .adapter.core_http import CoreHTTPClient
from .adapter.signing import ServiceIdentity
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
from .service.guardian import GuardianLoop
from .service.nudge import NudgeAssembler
from .service.sync_engine import SyncEngine
from .service.vault_context import VaultContextAssembler

# -- Sub-apps --
from .dina_brain.app import create_brain_app
from .dina_admin.app import create_admin_app

log = logging.getLogger(__name__)

# SEC-LOW-01: Disable docs/openapi in production
_env = os.environ.get("DINA_ENV", "production").lower()
_is_dev = _env in ("development", "test")
if not _is_dev and os.environ.get("DINA_TEST_MODE", "").lower() == "true":
    _is_dev = True


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

    # 2. Service identity (Ed25519 keypair for service-to-service auth)
    # PEM files are provisioned at install time via provision_derived_service_keys.py
    # (seed-derived at m/9999'/3'/1'). Runtime is load-only, fail-closed.
    from pathlib import Path
    brain_identity = ServiceIdentity(Path(cfg.service_key_dir), service_name="brain")
    try:
        brain_identity.ensure_key()
        log.info("brain.service_key.ready", extra={"did": brain_identity.did()})
    except Exception as exc:
        log.error("brain.service_key.failed", extra={"error": str(exc)})
        raise

    # Lazy loader for Core's public key — resolves on first request, not at startup.
    # This avoids the cold-start race where Brain starts before Core has generated
    # its keypair. The callable caches after first successful load.
    _core_key_cache = [None]  # mutable container for closure

    def _get_core_public_key():
        if _core_key_cache[0] is not None:
            return _core_key_cache[0]
        if brain_identity is None:
            return None
        try:
            _core_key_cache[0] = brain_identity.load_peer_key("core")
            log.info("brain.core_key.loaded_lazy")
        except FileNotFoundError:
            log.debug("brain.core_key.not_yet_available")
        except Exception as exc:
            log.warning("brain.core_key.load_error", extra={"error": str(exc)})
        return _core_key_cache[0]

    # 2b. Construct adapters
    brain_core_client = CoreHTTPClient(
        cfg.core_url,
        service_identity=brain_identity,
    )
    admin_core_client: CoreHTTPClient | None = (
        CoreHTTPClient(cfg.core_url, bearer_token=cfg.client_token)
        if cfg.client_token
        else None
    )

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

    # --- Gemini ---
    google_key = (os.environ.get("GEMINI_API_KEY", "") or os.environ.get("GOOGLE_API_KEY", "")).strip()
    if google_key:
        gemini_model = os.environ.get("GEMINI_MODEL", "gemini-3.1-pro-preview").strip()
        gemini_lite_model = os.environ.get("GEMINI_LITE_MODEL", "gemini-3.1-flash-lite-preview").strip()
        try:
            providers["gemini"] = GeminiProvider(google_key, model=gemini_model)
            log.info("brain.provider.gemini", extra={"model": gemini_model})
        except Exception as exc:
            log.warning("brain.provider.gemini.failed", extra={"error": str(exc)})
        # Lightweight provider for guard_scan and other cheap tasks.
        try:
            providers["gemini-lite"] = GeminiProvider(google_key, model=gemini_lite_model)
            log.info("brain.provider.gemini-lite", extra={"model": gemini_lite_model})
        except Exception as exc:
            log.warning("brain.provider.gemini-lite.failed", extra={"error": str(exc)})

    # --- Claude ---
    anthropic_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if anthropic_key:
        claude_model = os.environ.get("CLAUDE_MODEL", "claude-sonnet-4-6").strip()
        claude_lite_model = os.environ.get("CLAUDE_LITE_MODEL", "claude-haiku-4-5-20251001").strip()
        try:
            providers["claude"] = ClaudeProvider(anthropic_key, model=claude_model)
            log.info("brain.provider.claude", extra={"model": claude_model})
        except Exception as exc:
            log.warning("brain.provider.claude.failed", extra={"error": str(exc)})
        try:
            providers["claude-lite"] = ClaudeProvider(anthropic_key, model=claude_lite_model)
            log.info("brain.provider.claude-lite", extra={"model": claude_lite_model})
        except Exception as exc:
            log.warning("brain.provider.claude-lite.failed", extra={"error": str(exc)})

    # --- OpenAI ---
    openai_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if openai_key:
        openai_model = os.environ.get("OPENAI_MODEL", "gpt-5.4").strip()
        openai_lite_model = os.environ.get("OPENAI_LITE_MODEL", "gpt-5-mini").strip()
        try:
            providers["openai"] = OpenAIProvider(openai_key, model=openai_model)
            log.info("brain.provider.openai", extra={"model": openai_model})
        except Exception as exc:
            log.warning("brain.provider.openai.failed", extra={"error": str(exc)})
        try:
            providers["openai-lite"] = OpenAIProvider(openai_key, model=openai_lite_model)
            log.info("brain.provider.openai-lite", extra={"model": openai_lite_model})
        except Exception as exc:
            log.warning("brain.provider.openai-lite.failed", extra={"error": str(exc)})

    # --- OpenRouter ---
    openrouter_key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if openrouter_key:
        try:
            openrouter_model = os.environ.get(
                "OPENROUTER_MODEL", "google/gemini-3-flash",
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

    mcp_commands: dict[str, list[str]] = {}
    mcp_config_raw = os.environ.get("DINA_MCP_SERVERS", "")
    if mcp_config_raw:
        try:
            mcp_commands = json.loads(mcp_config_raw)
        except json.JSONDecodeError:
            for entry in mcp_config_raw.split(","):
                name, _, cmd = entry.partition("=")
                if name.strip() and cmd.strip():
                    mcp_commands[name.strip()] = cmd.strip().split()
    _MCP_ALLOWED_COMMANDS = {"npx", "uvx", "node", "python3", "deno", "python"}
    for name, cmd_parts in list(mcp_commands.items()):
        if cmd_parts and os.path.basename(cmd_parts[0]) not in _MCP_ALLOWED_COMMANDS:
            log.warning(
                "brain.mcp.blocked_command",
                extra={"server": name, "command": cmd_parts[0]},
            )
            del mcp_commands[name]
    mcp_client = MCPStdioClient(server_commands=mcp_commands)

    # HIGH-03: Track validated MCP server names for sync_engine.register_source()
    _mcp_source_names = list(mcp_commands.keys())

    # PII scrubber — prefer PresidioScrubber, fall back to spaCy, then None.
    scrubber: object | None = None
    scrubber_tier = "none"
    try:
        from .adapter.scrubber_presidio import PresidioScrubber
        scrubber = PresidioScrubber()
        scrubber_tier = "presidio"
        log.info("brain.scrubber.presidio.loaded")
    except Exception:
        try:
            scrubber = _SpacyScrubber()
            scrubber_tier = "spacy"
            log.info("brain.scrubber.spacy.fallback")
        except Exception as exc:
            log.warning(
                "brain.scrubber.unavailable",
                extra={"error": type(exc).__name__},
            )
            scrubber = None
    if scrubber_tier != "presidio":
        log.warning(
            "brain.scrubber.degraded",
            extra={"tier": scrubber_tier},
        )

    # 3. Construct services
    llm_router = LLMRouter(
        providers=providers,
        config={
            "preferred_cloud": cfg.cloud_llm,
            "lightweight_cloud": "gemini-lite" if "gemini-lite" in providers else cfg.cloud_llm,
            "cloud_llm_consent": False,
            "scrubber_tier": scrubber_tier,
        },
    )

    # LLM hot-reload callback — rebuilds providers from KV-stored keys.
    # Called by the admin settings route when API keys are changed.
    async def reload_llm_providers() -> None:
        """Rebuild LLM providers from KV-stored keys + env var fallback."""
        try:
            raw = await brain_core_client.get_kv("user_settings")
            kv = json.loads(raw) if raw else {}
        except Exception:
            kv = {}

        new_providers: dict[str, object] = {}

        # Keep local provider unchanged (no API key needed)
        if "llama" in providers:
            new_providers["llama"] = providers["llama"]

        # Gemini: KV takes priority over env var
        gkey = (kv.get("gemini_api_key") or "").strip() or (
            os.environ.get("GEMINI_API_KEY", "") or os.environ.get("GOOGLE_API_KEY", "")
        ).strip()
        if gkey:
            _gm = os.environ.get("GEMINI_MODEL", "gemini-3.1-pro-preview").strip()
            _gl = os.environ.get("GEMINI_LITE_MODEL", "gemini-3.1-flash-lite-preview").strip()
            try:
                new_providers["gemini"] = GeminiProvider(gkey, model=_gm)
            except Exception as exc:
                log.warning("reload.gemini.failed", extra={"error": str(exc)})
            try:
                new_providers["gemini-lite"] = GeminiProvider(gkey, model=_gl)
            except Exception as exc:
                log.warning("reload.gemini-lite.failed", extra={"error": str(exc)})

        # Claude
        akey = (kv.get("anthropic_api_key") or "").strip() or os.environ.get("ANTHROPIC_API_KEY", "").strip()
        if akey:
            _cm = os.environ.get("CLAUDE_MODEL", "claude-sonnet-4-6").strip()
            _cl = os.environ.get("CLAUDE_LITE_MODEL", "claude-haiku-4-5-20251001").strip()
            try:
                new_providers["claude"] = ClaudeProvider(akey, model=_cm)
            except Exception as exc:
                log.warning("reload.claude.failed", extra={"error": str(exc)})
            try:
                new_providers["claude-lite"] = ClaudeProvider(akey, model=_cl)
            except Exception as exc:
                log.warning("reload.claude-lite.failed", extra={"error": str(exc)})

        # OpenAI
        okey = (kv.get("openai_api_key") or "").strip() or os.environ.get("OPENAI_API_KEY", "").strip()
        if okey:
            omodel = (kv.get("openai_model") or "").strip() or os.environ.get("OPENAI_MODEL", "gpt-5.4").strip()
            _ol = os.environ.get("OPENAI_LITE_MODEL", "gpt-5-mini").strip()
            try:
                new_providers["openai"] = OpenAIProvider(okey, model=omodel)
            except Exception as exc:
                log.warning("reload.openai.failed", extra={"error": str(exc)})
            try:
                new_providers["openai-lite"] = OpenAIProvider(okey, model=_ol)
            except Exception as exc:
                log.warning("reload.openai-lite.failed", extra={"error": str(exc)})

        # OpenRouter
        rkey = (kv.get("openrouter_api_key") or "").strip() or os.environ.get("OPENROUTER_API_KEY", "").strip()
        if rkey:
            try:
                rmodel = (kv.get("openrouter_model") or "").strip() or os.environ.get(
                    "OPENROUTER_MODEL", "google/gemini-3-flash",
                ).strip()
                new_providers["openrouter"] = OpenRouterProvider(rkey, model=rmodel)
            except Exception as exc:
                log.warning("reload.openrouter.failed", extra={"error": str(exc)})

        preferred = (kv.get("preferred_cloud") or "").strip() or cfg.cloud_llm
        llm_router.reconfigure(new_providers, {
            "preferred_cloud": preferred,
            "lightweight_cloud": "gemini-lite" if "gemini-lite" in new_providers else preferred,
            "cloud_llm_consent": kv.get("cloud_consent") is True,
        })
        # Update the local providers dict so healthz sees the new state
        providers.clear()
        providers.update(new_providers)
    entity_vault = EntityVaultService(scrubber=scrubber, core_client=brain_core_client)
    nudge = NudgeAssembler(core=brain_core_client, llm=llm_router, entity_vault=entity_vault)
    scratchpad = ScratchpadService(core=brain_core_client)
    vault_context = VaultContextAssembler(core=brain_core_client, llm_router=llm_router)
    sync_engine = SyncEngine(core=brain_core_client, mcp=mcp_client, llm=llm_router)
    # HIGH-03: Register each validated MCP server as a sync source
    for _src_name in _mcp_source_names:
        sync_engine.register_source(_src_name)
    if _mcp_source_names:
        log.info("sync.sources_registered", extra={"sources": _mcp_source_names})
    guardian = GuardianLoop(
        core=brain_core_client,
        llm_router=llm_router,
        scrubber=scrubber,
        entity_vault=entity_vault,
        nudge_assembler=nudge,
        scratchpad=scratchpad,
        vault_context=vault_context,
    )

    # -- Telegram connector (optional — graceful degradation) --
    telegram_bot = None  # type: ignore[assignment]
    telegram_service = None  # type: ignore[assignment]
    if cfg.telegram_token:
        try:
            from .adapter.telegram_bot import TelegramBotAdapter
            from .service.telegram import TelegramService

            telegram_service = TelegramService(
                guardian=guardian,
                core=brain_core_client,
                allowed_user_ids=set(cfg.telegram_allowed_users),
                allowed_group_ids=set(cfg.telegram_allowed_groups),
            )
            telegram_bot = TelegramBotAdapter(
                bot_token=cfg.telegram_token,
                message_callback=telegram_service.handle_message,
                command_callbacks={"start": telegram_service.handle_start},
            )
            telegram_service.set_bot(telegram_bot)
            log.info("brain.telegram.configured")
        except ImportError:
            log.warning(
                "brain.telegram.missing_dependency",
                extra={"hint": "pip install python-telegram-bot"},
            )
            telegram_bot = None
            telegram_service = None
    else:
        log.info(
            "brain.telegram.disabled",
            extra={"hint": "Set DINA_TELEGRAM_TOKEN to enable"},
        )

    # 4. Build sub-apps
    async def _sync_loop(engine: SyncEngine) -> None:
        """Background loop — runs sync cycles every 5 minutes."""
        while True:
            sources = engine.sources
            if not sources:
                log.warning("sync.no_sources", extra={"hint": "No MCP servers configured"})
            for source in sources:
                try:
                    await engine.run_sync_cycle(source)
                except Exception as exc:
                    log.warning("sync.cycle_failed", extra={"error": type(exc).__name__})
            await asyncio.sleep(300)

    @asynccontextmanager
    async def lifespan(app: FastAPI):  # type: ignore[no-untyped-def]
        sync_task = asyncio.create_task(_sync_loop(sync_engine))

        # Start Telegram polling if configured.
        if telegram_bot and telegram_service:
            try:
                await telegram_service.load_paired_users()
                await telegram_bot.start()
                log.info("brain.telegram.polling_started")
            except Exception as exc:
                log.error(
                    "brain.telegram.start_failed",
                    extra={"error": str(exc)},
                )

        yield

        # Stop Telegram polling.
        if telegram_bot:
            try:
                await telegram_bot.stop()
                log.info("brain.telegram.polling_stopped")
            except Exception as exc:
                log.warning(
                    "brain.telegram.stop_error",
                    extra={"error": str(exc)},
                )

        sync_task.cancel()
        try:
            await sync_task
        except asyncio.CancelledError:
            pass

    master = FastAPI(
        title="Dina Brain",
        description="Sovereign personal AI — the safety layer for autonomous agents.",
        version="0.4.0",
        lifespan=lifespan,
        docs_url="/docs" if _is_dev else None,
        redoc_url="/redoc" if _is_dev else None,
        openapi_url="/openapi.json" if _is_dev else None,
    )

    brain_api = create_brain_app(
        guardian, sync_engine, scrubber=scrubber,
        core_public_key=_get_core_public_key,
    )
    # Resolve dina.html path (architecture visualization)
    # Local dev: project_root/dina.html (3 dirs up from src/main.py)
    # Docker:    /app/dina.html (mounted volume, 2 dirs up)
    _dina_html = None
    _images_dir = None
    for _candidate in [
        os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "dina.html"),
        os.path.join(os.path.dirname(os.path.dirname(__file__)), "dina.html"),
    ]:
        if os.path.isfile(_candidate):
            _dina_html = _candidate
            # Images directory is sibling to dina.html
            _img_candidate = os.path.join(os.path.dirname(_candidate), "images")
            if os.path.isdir(_img_candidate):
                _images_dir = _img_candidate
            break
    master.mount("/api", brain_api)

    if cfg.client_token and admin_core_client:
        admin_ui = create_admin_app(
            admin_core_client, cfg, dina_html_path=_dina_html, images_dir=_images_dir,
            llm_reload_callback=reload_llm_providers,
            llm_router=llm_router,
            guardian=guardian,
        )
        master.mount("/admin", admin_ui)
    else:
        log.info("Admin UI disabled — set DINA_CLIENT_TOKEN to enable")

    # 5. Register unauthenticated endpoints on the master app

    @master.get("/healthz")
    async def healthz() -> dict:
        """Health check -- no auth required."""
        status = "ok"
        try:
            # Keep liveness fast even when Core is unavailable; report degraded
            # instead of blocking until CoreHTTPClient retries are exhausted.
            await asyncio.wait_for(brain_core_client.health(), timeout=0.8)
        except Exception:
            status = "degraded"
        if not providers:
            status = "degraded"
        result: dict = {
            "status": status,
            "telegram": "active" if telegram_bot else "disabled",
        }
        if llm_router:
            result["llm_router"] = "available"
            result["llm_models"] = ", ".join(llm_router.available_models())
            result["llm_usage"] = llm_router.usage()
        return result

    @master.on_event("shutdown")
    async def shutdown_event() -> None:
        """Clean up resources on shutdown."""
        # Log LLM usage before shutdown so cost is visible in Docker logs.
        if llm_router:
            usage = llm_router.usage()
            if usage["total_calls"] > 0:
                log.info(
                    "brain.llm_usage_total",
                    total_calls=usage["total_calls"],
                    total_tokens_in=usage["total_tokens_in"],
                    total_tokens_out=usage["total_tokens_out"],
                    total_cost_usd=usage["total_cost_usd"],
                    models=usage["models"],
                )
        await brain_core_client.close()
        if admin_core_client:
            await admin_core_client.close()
        await mcp_client.disconnect_all()
        log.info("brain.shutdown")

    log.info(
        "brain.ready",
        extra={
            "providers": list(providers.keys()),
            "scrubber": "spacy" if scrubber else "none",
        },
    )

    log.info(
        "brain.startup.session_constraint",
        extra={"detail": "Admin sessions are process-local — deploy with --workers 1 or use sticky sessions"},
    )

    return master


# ---------------------------------------------------------------------------
# Module-level app for uvicorn
# ---------------------------------------------------------------------------
# Usage:  uvicorn src.main:app --host 0.0.0.0 --port 8200
app = create_app()
