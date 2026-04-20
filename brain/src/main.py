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
from pathlib import Path


def _read_version() -> str:
    """Read version from VERSION file + git hash. Falls back to 'dev'."""
    version = "dev"
    for candidate in [Path("/app/VERSION"), Path(__file__).parent.parent.parent / "VERSION"]:
        if candidate.exists():
            version = candidate.read_text().strip()
            break
    # Append short git hash if available
    try:
        import subprocess
        h = subprocess.check_output(["git", "rev-parse", "--short", "HEAD"],
                                     stderr=subprocess.DEVNULL, timeout=2).decode().strip()
        if h:
            version = f"{version}+{h}"
    except Exception:
        pass
    return version


BRAIN_VERSION = _read_version()

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
from .service.guardian import GuardianLoop, ActionRiskPolicy, ACTION_RISK_POLICY_KV_KEY
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



# No spaCy fallback scrubber. Structured PII scrubbing requires Presidio.
# Without Presidio, Brain's Tier 2 is unavailable — Go Core Tier 1 regex
# (emails, phones, SSN) still runs on the Go side before Brain sees the text.


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

    # --- Model defaults from models.json (env var overrides take precedence) ---
    from .infra.model_config import get_defaults, get_provider_config, split_model_ref

    model_defaults = get_defaults()
    primary_provider = model_defaults.get("primary_provider", "")
    primary_model = model_defaults.get("primary_model", "")
    lite_provider = model_defaults.get("lite_provider", "")
    lite_model = model_defaults.get("lite_model", "")

    # --- Gemini ---
    google_key = (os.environ.get("GEMINI_API_KEY", "") or os.environ.get("GOOGLE_API_KEY", "")).strip()
    if google_key:
        gcfg = get_provider_config("gemini")
        gm = os.environ.get("GEMINI_MODEL", "").strip() or (primary_model if primary_provider == "gemini" else "")
        gm = gm or list(gcfg.get("models", {}).keys())[0] if gcfg.get("models") else "gemini-3.1-pro-preview"
        gemini_embed = gcfg.get("embed_model", "models/gemini-embedding-001")
        try:
            providers["gemini"] = GeminiProvider(google_key, model=gm, embed_model=gemini_embed)
            log.info("brain.provider.gemini", extra={"model": gm, "embed_model": gemini_embed})
        except Exception as exc:
            log.warning("brain.provider.gemini.failed", extra={"error": str(exc)})
        gl = os.environ.get("GEMINI_LITE_MODEL", "").strip() or (lite_model if lite_provider == "gemini" else "")
        if gl:
            try:
                providers["gemini-lite"] = GeminiProvider(google_key, model=gl, embed_model=gemini_embed)
                log.info("brain.provider.gemini-lite", extra={"model": gl})
            except Exception as exc:
                log.warning("brain.provider.gemini-lite.failed", extra={"error": str(exc)})

    # --- Claude ---
    anthropic_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if anthropic_key:
        ccfg = get_provider_config("claude")
        cm = os.environ.get("CLAUDE_MODEL", "").strip() or (primary_model if primary_provider == "claude" else "")
        cm = cm or list(ccfg.get("models", {}).keys())[0] if ccfg.get("models") else "claude-sonnet-4-6"
        try:
            providers["claude"] = ClaudeProvider(anthropic_key, model=cm)
            log.info("brain.provider.claude", extra={"model": cm})
        except Exception as exc:
            log.warning("brain.provider.claude.failed", extra={"error": str(exc)})
        cl = os.environ.get("CLAUDE_LITE_MODEL", "").strip() or (lite_model if lite_provider == "claude" else "")
        if not cl and len(list(ccfg.get("models", {}).keys())) > 1:
            cl = list(ccfg.get("models", {}).keys())[1]
        if cl:
            try:
                providers["claude-lite"] = ClaudeProvider(anthropic_key, model=cl)
                log.info("brain.provider.claude-lite", extra={"model": cl})
            except Exception as exc:
                log.warning("brain.provider.claude-lite.failed", extra={"error": str(exc)})

    # --- OpenAI ---
    openai_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if openai_key:
        ocfg = get_provider_config("openai")
        om = os.environ.get("OPENAI_MODEL", "").strip() or (primary_model if primary_provider == "openai" else "")
        om = om or list(ocfg.get("models", {}).keys())[0] if ocfg.get("models") else "gpt-5.4"
        openai_embed = ocfg.get("embed_model", "text-embedding-3-small")
        try:
            providers["openai"] = OpenAIProvider(openai_key, model=om, embed_model=openai_embed)
            log.info("brain.provider.openai", extra={"model": om, "embed_model": openai_embed})
        except Exception as exc:
            log.warning("brain.provider.openai.failed", extra={"error": str(exc)})
        ol = os.environ.get("OPENAI_LITE_MODEL", "").strip() or (lite_model if lite_provider == "openai" else "")
        if not ol and len(list(ocfg.get("models", {}).keys())) > 1:
            ol = list(ocfg.get("models", {}).keys())[1]
        if ol:
            try:
                providers["openai-lite"] = OpenAIProvider(openai_key, model=ol)
                log.info("brain.provider.openai-lite", extra={"model": ol})
            except Exception as exc:
                log.warning("brain.provider.openai-lite.failed", extra={"error": str(exc)})

    # --- OpenRouter ---
    openrouter_key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if openrouter_key:
        rd = get_provider_config("openrouter")
        try:
            openrouter_model = os.environ.get("OPENROUTER_MODEL", "").strip()
            if not openrouter_model:
                openrouter_model = next(iter(rd.get("models", {})))
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

    # PII scrubber — Presidio only (structured PII: emails, phones, govt IDs).
    # No spaCy fallback — without Presidio, Brain Tier 2 is unavailable.
    # Go Core Tier 1 regex still catches emails/phones on the Go side.
    scrubber: object | None = None
    scrubber_tier = "none"
    try:
        from .adapter.scrubber_presidio import PresidioScrubber
        scrubber = PresidioScrubber()
        scrubber_tier = "presidio"
        log.info("brain.scrubber.presidio.loaded")
    except (ImportError, OSError, RuntimeError) as exc:
        log.warning(
            "brain.scrubber.unavailable",
            extra={"error": type(exc).__name__, "detail": str(exc)},
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

        # Reload uses same models.json defaults as initial registration
        rd = get_defaults()
        gcfg = get_provider_config("gemini")
        ccfg = get_provider_config("claude")
        ocfg = get_provider_config("openai")
        rcfg = get_provider_config("openrouter")
        _gmodels = list(gcfg.get("models", {}).keys())
        _cmodels = list(ccfg.get("models", {}).keys())
        _omodels = list(ocfg.get("models", {}).keys())
        _rmodels = list(rcfg.get("models", {}).keys())

        # Gemini: KV takes priority over env var / models.json
        gkey = (kv.get("gemini_api_key") or "").strip() or (
            os.environ.get("GEMINI_API_KEY", "") or os.environ.get("GOOGLE_API_KEY", "")
        ).strip()
        if gkey and _gmodels:
            try:
                new_providers["gemini"] = GeminiProvider(gkey, model=_gmodels[0])
            except Exception as exc:
                log.warning("reload.gemini.failed", extra={"error": str(exc)})
            if len(_gmodels) > 1:
                try:
                    new_providers["gemini-lite"] = GeminiProvider(gkey, model=_gmodels[1])
                except Exception as exc:
                    log.warning("reload.gemini-lite.failed", extra={"error": str(exc)})

        # Claude
        akey = (kv.get("anthropic_api_key") or "").strip() or os.environ.get("ANTHROPIC_API_KEY", "").strip()
        if akey and _cmodels:
            try:
                new_providers["claude"] = ClaudeProvider(akey, model=_cmodels[0])
            except Exception as exc:
                log.warning("reload.claude.failed", extra={"error": str(exc)})
            if len(_cmodels) > 1:
                try:
                    new_providers["claude-lite"] = ClaudeProvider(akey, model=_cmodels[1])
                except Exception as exc:
                    log.warning("reload.claude-lite.failed", extra={"error": str(exc)})

        # OpenAI
        okey = (kv.get("openai_api_key") or "").strip() or os.environ.get("OPENAI_API_KEY", "").strip()
        if okey and _omodels:
            omodel = (kv.get("openai_model") or "").strip() or _omodels[0]
            try:
                new_providers["openai"] = OpenAIProvider(okey, model=omodel)
            except Exception as exc:
                log.warning("reload.openai.failed", extra={"error": str(exc)})
            if len(_omodels) > 1:
                try:
                    new_providers["openai-lite"] = OpenAIProvider(okey, model=_omodels[1])
                except Exception as exc:
                    log.warning("reload.openai-lite.failed", extra={"error": str(exc)})

        # OpenRouter
        rkey = (kv.get("openrouter_api_key") or "").strip() or os.environ.get("OPENROUTER_API_KEY", "").strip()
        if rkey and _rmodels:
            try:
                rmodel = (kv.get("openrouter_model") or "").strip() or _rmodels[0]
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
    # --- Persona registry + selector ---
    from .service.persona_registry import PersonaRegistry
    from .service.persona_selector import PersonaSelector
    persona_registry = PersonaRegistry()
    persona_selector = PersonaSelector(registry=persona_registry, llm=llm_router)

    entity_vault = EntityVaultService(scrubber=scrubber, core_client=brain_core_client)
    nudge = NudgeAssembler(core=brain_core_client, llm=llm_router, entity_vault=entity_vault)
    scratchpad = ScratchpadService(core=brain_core_client)
    # WS2: appview_client and mcp_client are wired later (after _service_orchestrator setup)
    # if AppView URL is configured. Initial construction without them — tools return
    # "not configured" errors until wired.
    vault_context = VaultContextAssembler(core=brain_core_client, llm_router=llm_router, owner_name=cfg.owner_name)
    from .service.trust_scorer import TrustScorer
    from .service.enrichment import EnrichmentService
    from .service.staging_processor import StagingProcessor
    trust_scorer = TrustScorer()
    enrichment_svc = EnrichmentService(
        core=brain_core_client, llm=llm_router, entity_vault=entity_vault,
    )
    from .service.domain_classifier import DomainClassifier
    domain_clf = DomainClassifier(llm=llm_router, registry=persona_registry)
    from .service.event_extractor import EventExtractor
    from .service.reminder_planner import ReminderPlanner
    from .service.topic_extractor import TopicExtractor
    from .service.preference_extractor import PreferenceExtractor
    event_extractor = EventExtractor(core=brain_core_client)
    reminder_planner = ReminderPlanner(core=brain_core_client, llm=llm_router)
    # Working-memory topic extractor (docs/WORKING_MEMORY_DESIGN.md).
    # Piggybacks on the enrichment LLM; scrubs PII via entity_vault.
    topic_extractor = TopicExtractor(llm=llm_router, entity_vault=entity_vault)
    # Preference extractor — regex-based, no LLM spend. Surfaces
    # "my dentist Dr Carl"-style user assertions and auto-updates the
    # matched contact's preferred_for list.
    preference_extractor = PreferenceExtractor()
    staging_processor = StagingProcessor(
        core=brain_core_client,
        enrichment=enrichment_svc,
        trust_scorer=trust_scorer,
        domain_classifier=lambda item: domain_clf.classify(
            item.get("body", item.get("summary", "")),
            vault_context={"source": item.get("source", ""), "type": item.get("type", "")},
        ).domain,
        event_extractor=event_extractor,
        persona_selector=persona_selector,
        reminder_planner=reminder_planner,
        topic_extractor=topic_extractor,
        preference_extractor=preference_extractor,
        # telegram is wired later (after TelegramService creation)
    )
    sync_engine = SyncEngine(
        core=brain_core_client, mcp=mcp_client, llm=llm_router,
        trust_scorer=trust_scorer, enrichment=enrichment_svc,
    )

    # Load contacts into trust scorer so contact-ring scoring works.
    # Best-effort — if Core isn't ready yet, contacts will be loaded
    # on the first sync cycle via refresh_contacts().
    async def _load_contacts_into_scorer() -> None:
        try:
            contacts = await brain_core_client.list_contacts()
            trust_scorer.update_contacts(contacts)
            log.info("trust_scorer.contacts_loaded", extra={"count": len(contacts)})
        except Exception as exc:
            log.warning("trust_scorer.contacts_load_failed", extra={"error": str(exc)})

    import asyncio
    try:
        loop = asyncio.get_running_loop()
        loop.create_task(_load_contacts_into_scorer())
    except RuntimeError:
        pass  # no event loop yet — contacts will load on first sync
    # HIGH-03: Register each validated MCP server as a sync source
    for _src_name in _mcp_source_names:
        sync_engine.register_source(_src_name)
    if _mcp_source_names:
        log.info("sync.sources_registered", extra={"sources": _mcp_source_names})
    # Working-memory intent classifier (docs/WORKING_MEMORY_DESIGN.md).
    # Runs once per /ask to pick which source(s) to consult, using the
    # ToC read from Core. ToC fetcher is a thin closure so the
    # classifier doesn't need to hold the core client directly.
    from .service.intent_classifier import IntentClassifier
    async def _fetch_toc_for_classifier() -> list[dict]:
        try:
            return await brain_core_client.memory_toc(limit=50)
        except Exception:
            return []
    intent_classifier = IntentClassifier(llm=llm_router, toc_fetcher=_fetch_toc_for_classifier)

    guardian = GuardianLoop(
        core=brain_core_client,
        llm_router=llm_router,
        scrubber=scrubber,
        entity_vault=entity_vault,
        nudge_assembler=nudge,
        scratchpad=scratchpad,
        vault_context=vault_context,
        event_extractor=event_extractor,
        persona_selector=persona_selector,
        persona_registry=persona_registry,
        staging_processor=staging_processor,
        intent_classifier=intent_classifier,
    )

    # -- Wire service discovery components into Guardian (Phase 1) --
    # Provider side: handle inbound service.query messages.
    # Always created — providers don't need AppView to receive queries.
    # Requester side: discover + query + track — requires AppView for discovery.
    appview_url = os.environ.get("DINA_APPVIEW_URL", "")
    _service_orchestrator = None
    _service_handler = None

    # Provider side: ServiceHandler is always created (if Core + MCP exist).
    # Service config is loaded in the lifespan (async); constructed here with
    # empty config, lifespan populates it.
    from .service.service_handler import ServiceHandler

    _service_handler = ServiceHandler(
        core_client=brain_core_client,
        mcp_client=mcp_client,
        service_config={},
    )
    guardian._service_handler = _service_handler
    # WS2: wire operator notifier for review approval prompts.
    async def _service_handler_notifier(text: str) -> None:
        await guardian._push_notification(text, "service_review")
    _service_handler._notifier = _service_handler_notifier
    log.info("brain.service_handler.configured")

    # Requester side: only created if DINA_APPVIEW_URL is set (needs AppView
    # for service discovery).
    if appview_url:
        from .adapter.appview_client import AppViewClient
        from .service.service_query import ServiceQueryOrchestrator

        appview_client = AppViewClient(appview_url)

        async def _service_notifier(text: str) -> None:
            """Forward service notifications through Guardian's push."""
            await guardian._push_notification(text, "service_query")

        _service_orchestrator = ServiceQueryOrchestrator(
            appview_client=appview_client,
            core_client=brain_core_client,
            notifier=_service_notifier,
        )
        guardian._service_query_orchestrator = _service_orchestrator

        # WS2: wire AppView into VaultContextAssembler for LLM tools.
        vault_context._agent._appview = appview_client

        log.info(
            "brain.service_discovery.configured",
            extra={"appview_url": appview_url},
        )
    else:
        log.info(
            "brain.service_discovery.requester_disabled",
            extra={"hint": "Set DINA_APPVIEW_URL to enable service discovery (requester side)"},
        )

    # WS2: wire MCP client into VaultContextAssembler for geocode tool.
    # Independent of AppView — geocoding works even without service discovery.
    vault_context._agent._mcp = mcp_client

    # -- Telegram connector (optional — graceful degradation) --
    telegram_bot = None  # type: ignore[assignment]
    telegram_service = None  # type: ignore[assignment]
    if cfg.telegram_token:
        try:
            from .adapter.telegram_bot import TelegramBotAdapter
            from .service.telegram import TelegramService
            from .service.user_commands import UserCommandService

            user_commands = UserCommandService(core=brain_core_client)

            telegram_service = TelegramService(
                guardian=guardian,
                core=brain_core_client,
                allowed_user_ids=set(cfg.telegram_allowed_users),
                allowed_group_ids=set(cfg.telegram_allowed_groups),
                user_commands=user_commands,
            )
            telegram_bot = TelegramBotAdapter(
                bot_token=cfg.telegram_token,
                message_callback=telegram_service.handle_message,
                command_callbacks={
                    "start": telegram_service.handle_start,
                    "ask": telegram_service.handle_ask,
                    "remember": telegram_service.handle_remember,
                    "edit": telegram_service.handle_edit,
                    "send": telegram_service.handle_send,
                    "vouch": telegram_service.handle_vouch,
                    "review": telegram_service.handle_review,
                    "flag": telegram_service.handle_flag,
                    "trust": telegram_service.handle_trust,
                    "contact": telegram_service.handle_contact,
                    "task": telegram_service.handle_task,
                    "taskstatus": telegram_service.handle_task_status,
                    "status": telegram_service.handle_status,
                    "service_query": telegram_service.handle_service_query,
                    "service_approve": telegram_service.handle_service_approve,
                },
                callback_query_handler=telegram_service.handle_callback_query,
                base_url=cfg.telegram_api_base_url,
            )
            telegram_service.set_bot(telegram_bot)
            guardian._telegram = telegram_service  # wire for approval prompts
            staging_processor._telegram = telegram_service  # wire for reminder push

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

    # Wire PDS publisher for trust commands — independent of Telegram.
    # Works via Telegram (/review, /vouch, /flag), admin CLI, and web UI.
    pds_url = os.environ.get("DINA_PDS_URL", "")
    pds_handle = os.environ.get("DINA_PDS_HANDLE", "")
    pds_password = os.environ.get("DINA_PDS_ADMIN_PASSWORD", "")
    pds_publisher_instance = None
    if pds_url and pds_handle and pds_password:
        from .adapter.pds_publisher import PDSPublisher
        pds_publisher_instance = PDSPublisher(pds_url, pds_handle, pds_password)
        log.info("brain.pds_publisher.configured", extra={"pds_url": pds_url})
        # Wire into UserCommandService if Telegram created it.
        if telegram_service is not None:
            telegram_service._pds_publisher = pds_publisher_instance

    # 3c. Bluesky channel (optional — enabled when DINA_BSKY_HANDLE is set)
    bluesky_bot = None
    bsky_handle = os.environ.get("DINA_BSKY_HANDLE", "")
    bsky_password = os.environ.get("DINA_BSKY_PASSWORD", "")
    bsky_service = os.environ.get("DINA_BSKY_SERVICE", "https://bsky.social")
    if bsky_handle and bsky_password:
        try:
            from .adapter.bluesky_bot import BlueskyBotAdapter, BlueskyClient
            from .service.command_dispatcher import CommandDispatcher
            from .service.user_commands import UserCommandService as _UCS

            # Reuse existing UserCommandService if Telegram created one,
            # otherwise create a new one.
            if telegram_service is not None:
                bsky_user_cmds = telegram_service._cmds
            else:
                bsky_user_cmds = _UCS(core=brain_core_client)
                if pds_publisher_instance:
                    bsky_user_cmds.pds_publisher = pds_publisher_instance

            bsky_dispatcher = CommandDispatcher(
                user_commands=bsky_user_cmds,
                guardian=guardian,
            )
            bsky_client = BlueskyClient(bsky_service, bsky_handle, bsky_password)
            bsky_owner_did = os.environ.get("DINA_BSKY_OWNER_DID", "")
            bluesky_bot = BlueskyBotAdapter(bsky_client, bsky_dispatcher, owner_did=bsky_owner_did)
            guardian._bluesky = bluesky_bot  # wire for D2D notifications
            log.info("brain.bluesky.configured", extra={"handle": bsky_handle})
        except Exception as exc:
            log.warning("brain.bluesky.config_failed", extra={"error": str(exc)})
            bluesky_bot = None
    else:
        log.info(
            "brain.bluesky.disabled",
            extra={"hint": "Set DINA_BSKY_HANDLE and DINA_BSKY_PASSWORD to enable"},
        )

    # 4. Build sub-apps
    async def _sync_loop(engine: SyncEngine) -> None:
        """Background loop — runs sync cycles every 5 minutes."""
        while True:
            # Refresh contacts for trust scoring (best-effort).
            try:
                contacts = await brain_core_client.list_contacts()
                trust_scorer.update_contacts(contacts)
            except Exception:
                pass
            # Refresh persona registry (picks up new/deleted personas).
            try:
                await persona_registry.refresh(brain_core_client)
            except Exception:
                pass
            sources = engine.sources
            if not sources:
                log.warning("sync.no_sources", extra={"hint": "No MCP servers configured"})
            for source in sources:
                try:
                    await engine.run_sync_cycle(source)
                except Exception as exc:
                    log.warning("sync.cycle_failed", extra={"error": type(exc).__name__})
            # Legacy enrichment sweep: drains items stored before the
            # "enrichment before publication" change. New items arrive
            # fully enriched via staging_processor. Becomes a no-op when
            # all legacy items are drained (enrichment_status != pending).
            try:
                for p in persona_registry.all_names():
                    enriched = await enrichment_svc.enrich_pending(p, limit=10)
                    if enriched:
                        log.info("enrichment.sweep", extra={"persona": p, "enriched": enriched})
            except Exception:
                pass  # best-effort
            # Staging processor: classify pending ingested items.
            try:
                staged = await staging_processor.process_pending(limit=20)
                if staged:
                    log.info("staging.processed", extra={"count": staged})
            except Exception:
                pass  # best-effort
            await asyncio.sleep(300)

    @asynccontextmanager
    async def lifespan(app: FastAPI):  # type: ignore[no-untyped-def]
        # Load persona registry before anything else — selector needs it.
        await persona_registry.load(brain_core_client)

        # Load configurable action risk policy from Core KV.
        # If not found (first run), bootstrap with defaults and persist.
        try:
            raw_policy = await brain_core_client.get_kv(ACTION_RISK_POLICY_KV_KEY)
            if raw_policy:
                policy = ActionRiskPolicy.from_dict(json.loads(raw_policy))
                log.info("brain.action_policy.loaded_from_kv")
            else:
                policy = ActionRiskPolicy.defaults()
                policy_json = json.dumps(policy.to_dict())
                await brain_core_client.set_kv(ACTION_RISK_POLICY_KV_KEY, policy_json)
                # Agent-readable copy (admin: prefix blocks device-scoped callers).
                await brain_core_client.set_kv("policy:action_risk", policy_json)
                log.info("brain.action_policy.bootstrapped_defaults")
            guardian._action_policy = policy
        except Exception as exc:
            log.warning(
                "brain.action_policy.load_failed",
                extra={"error": str(exc)},
            )
            # Guardian keeps the default policy set at construction time.

        # Load service config into handler with retry. On compose-stack start
        # Core can be briefly unreachable from Brain's DNS (initial healthcheck
        # race); a single-shot attempt used to leave the provider Brain with
        # an empty config and return "unavailable" for every service.query.
        # Retry in the background until we get it, then refresh periodically
        # so in-place PUT /v1/service/config updates propagate without a Brain
        # restart.
        if _service_handler is not None:
            async def _service_config_loader() -> None:
                # Phase 1: aggressive retry until first successful load.
                backoff = 1.0
                while True:
                    try:
                        cfg = await brain_core_client.get_service_config()
                        if cfg:
                            _service_handler._config = cfg
                            log.info("brain.service_handler.config_loaded")
                            break
                        # Empty config (no service configured yet) — stop
                        # polling; nothing to load. config_updated_at check
                        # below will pick it up when the operator publishes.
                        log.info("brain.service_handler.no_config_yet")
                        break
                    except Exception as exc:
                        log.warning(
                            "brain.service_handler.config_load_retry",
                            extra={"error": str(exc), "backoff_s": backoff},
                        )
                        await asyncio.sleep(backoff)
                        backoff = min(backoff * 2, 30.0)

                # Phase 2: periodic refresh so config updates propagate.
                while True:
                    await asyncio.sleep(60.0)
                    try:
                        cfg = await brain_core_client.get_service_config()
                        if cfg and cfg != _service_handler._config:
                            _service_handler._config = cfg
                            log.info("brain.service_handler.config_refreshed")
                    except Exception:
                        # Transient — try again next tick.
                        pass

            service_config_task = asyncio.create_task(_service_config_loader())
        else:
            service_config_task = None

        sync_task = asyncio.create_task(_sync_loop(sync_engine))

        # WS2: Approval reconciliation loop — recovers stuck approval tasks.
        # Replaces Phase 1 timeout scanner. Runs every 60s.
        async def _approval_reconciliation_loop() -> None:
            # Run first pass immediately on startup, then every 5 minutes.
            # This is a safety net for stuck tasks, not the primary execution path.
            # Normal flow: Core delivers workflow_events → Brain executes.
            first_run = True
            while True:
                if not first_run:
                    await asyncio.sleep(300)
                first_run = False
                try:
                    import json as json_mod

                    # Tier 0: pending_approval tasks with dropped prompts.
                    # Re-send operator notification for any still-pending tasks.
                    pending = await brain_core_client.list_workflow_tasks(
                        status="pending_approval", kind="approval", limit=200, order="oldest",
                    )
                    for t in pending:
                        task_id = t.get("id", "")
                        payload = t.get("payload", {})
                        if isinstance(payload, str):
                            payload = json_mod.loads(payload)
                        capability = payload.get("capability", "")
                        from_did = payload.get("from_did", "")
                        if _service_handler and _service_handler._notifier:
                            try:
                                await _service_handler._notifier(
                                    f"Pending review (reminder):\n"
                                    f"  Capability: {capability}\n"
                                    f"  From: {from_did}\n"
                                    f"  Approve: /service_approve {task_id}"
                                )
                            except Exception:
                                pass  # best-effort reminder

                    # Tier 1: queued approval tasks (event delivery may have failed).
                    queued = await brain_core_client.list_workflow_tasks(
                        status="queued", kind="approval", limit=200, order="oldest",
                    )
                    for t in queued:
                        task_id = t.get("id", "")
                        log.info(
                            "brain.reconciliation.queued_approval",
                            extra={"task_id": task_id},
                        )
                        if _service_handler:
                            try:
                                payload = t.get("payload", {})
                                if isinstance(payload, str):
                                    payload = json_mod.loads(payload)
                                await _service_handler.execute_and_respond(task_id, payload)
                            except Exception as exc:
                                log.warning(
                                    "brain.reconciliation.execute_failed",
                                    extra={"task_id": task_id, "error": str(exc)},
                                )

                    # Tier 2: running approval tasks left over from the old
                    # architecture where the Brain claimed the approval task
                    # itself and sent an (eventually empty) /v1/service/respond.
                    # Under the current model an approved approval task is
                    # cancelled after the execution task is spawned, so
                    # "running approval" is only a legacy stuck state.
                    # Cancel those so the requester can receive an
                    # "unavailable" from the approval-expiry sweeper instead
                    # of staying pinned forever.
                    from src.domain.errors import WorkflowConflictError
                    running = await brain_core_client.list_workflow_tasks(
                        status="running", kind="approval", limit=200, order="oldest",
                    )
                    for t in running:
                        task_id = t.get("id", "")
                        log.info(
                            "brain.reconciliation.stale_running_approval",
                            extra={"task_id": task_id},
                        )
                        try:
                            await brain_core_client.cancel_workflow_task(task_id)
                        except WorkflowConflictError:
                            continue  # already terminal — expected race
                        except Exception as exc:
                            log.warning(
                                "brain.reconciliation.stale_cancel_failed",
                                extra={"task_id": task_id, "error": str(exc)},
                            )

                    # Config reload removed — Core pushes config_changed events
                    # to Brain via brain.Process() on PUT /v1/service/config.
                except Exception as exc:
                    log.warning(
                        "brain.reconciliation.failed",
                        extra={"error": str(exc)},
                    )

        reconciliation_task = asyncio.create_task(_approval_reconciliation_loop())

        # Publish service profile to PDS on startup (if configured).
        # Publishing does NOT require AppView — providers publish to PDS
        # independently; AppView indexes the records for discovery.
        if pds_publisher_instance:
            try:
                from .service.service_publisher import ServicePublisher
                svc_publisher = ServicePublisher(brain_core_client, pds_publisher_instance)
                await svc_publisher.publish()
            except Exception as exc:
                log.warning(
                    "brain.service_publisher.startup_failed",
                    extra={"error": str(exc)},
                )

        # Start Telegram polling if configured.
        # Runs as a background task with retries so that a slow Core
        # startup (common on low-power hardware) doesn't permanently
        # kill the Telegram bot.
        telegram_task: asyncio.Task | None = None
        if telegram_bot and telegram_service:
            async def _start_telegram_with_retry() -> None:
                backoff = 2
                max_backoff = 60
                for attempt in range(1, 31):  # up to 30 attempts (~10 min)
                    try:
                        await telegram_service.load_paired_users()
                        await telegram_bot.start()
                        log.info("brain.telegram.polling_started")
                        return
                    except Exception as exc:
                        log.warning(
                            "brain.telegram.start_retry",
                            extra={
                                "attempt": attempt,
                                "backoff": backoff,
                                "error": str(exc),
                            },
                        )
                        await asyncio.sleep(backoff)
                        backoff = min(backoff * 2, max_backoff)
                log.error("brain.telegram.start_gave_up")

            telegram_task = asyncio.create_task(_start_telegram_with_retry())

        # Start Bluesky polling if configured.
        bluesky_task: asyncio.Task | None = None
        if bluesky_bot:
            async def _start_bluesky_with_retry() -> None:
                backoff = 2
                for attempt in range(1, 16):
                    try:
                        await bluesky_bot.start()
                        log.info("brain.bluesky.polling_started")
                        return
                    except Exception as exc:
                        log.warning("brain.bluesky.start_retry", extra={
                            "attempt": attempt, "error": str(exc),
                        })
                        await asyncio.sleep(backoff)
                        backoff = min(backoff * 2, 60)
                log.error("brain.bluesky.start_gave_up")

            bluesky_task = asyncio.create_task(_start_bluesky_with_retry())

        yield

        # Stop Bluesky polling.
        if bluesky_task and not bluesky_task.done():
            bluesky_task.cancel()
        if bluesky_bot:
            try:
                await bluesky_bot.stop()
                log.info("brain.bluesky.polling_stopped")
            except Exception:
                pass

        # Stop Telegram polling.
        if telegram_task and not telegram_task.done():
            telegram_task.cancel()
        if telegram_bot:
            try:
                await telegram_bot.stop()
                log.info("brain.telegram.polling_stopped")
            except Exception as exc:
                log.warning(
                    "brain.telegram.stop_error",
                    extra={"error": str(exc)},
                )

        # The former service_timeout scanner was removed when WS2 moved service
        # query timeout handling into Core's workflow sweeper. The teardown
        # block still referenced `service_timeout_task` as an undefined name
        # and raised NameError on every shutdown — cleaned up here.

        # Stop the service-config refresh loop (provider-side only).
        if service_config_task is not None and not service_config_task.done():
            service_config_task.cancel()
            try:
                await service_config_task
            except asyncio.CancelledError:
                pass

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
            "version": BRAIN_VERSION,
            "telegram": "active" if telegram_bot else "disabled",
        }
        if llm_router:
            result["llm_router"] = "available"
            result["llm_models"] = {
                "lite": model_defaults.get("lite_model", "?"),
                "primary": model_defaults.get("primary_model", "?"),
                "heavy": model_defaults.get("heavy_model", "?"),
                "available": llm_router.available_models(),
            }
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

    # Log model assignments so operators can see what's routing where.
    _lite = model_defaults.get("lite_model", "?")
    _primary = model_defaults.get("primary_model", "?")
    _heavy = model_defaults.get("heavy_model", "?")
    log.info(
        "brain.ready",
        extra={
            "providers": list(providers.keys()),
            "scrubber": "spacy" if scrubber else "none",
            "models": f"Lite: {_lite}, Primary: {_primary}, Heavy: {_heavy}",
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
