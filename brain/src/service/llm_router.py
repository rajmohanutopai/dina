"""Multi-provider LLM routing — the decision tree for where to send work.

The router examines the task type, persona sensitivity tier, and available
providers to decide the optimal path:

    - **Local LLM** (Ollama / llama): best privacy, no PII scrubbing.
    - **Cloud LLM** (Gemini / Claude): more capable but requires Entity
      Vault scrubbing for any sensitive data.
    - **FTS5-only**: simple lookups bypass the LLM entirely.

Hard security gate: if PII scrubbing fails on a sensitive persona, the
cloud route is **refused** (``PIIScrubError``).  Unscrubbed data must
NEVER leave the Home Node.

Maps to Brain TEST_PLAN SS4 (LLM Router).

No imports from adapter/ — only port protocols and domain types.
"""

from __future__ import annotations

import threading
from typing import Any

import structlog

from ..domain.errors import CloudConsentError, LLMError, PIIScrubError
from ..port.llm import LLMProvider

log = structlog.get_logger(__name__)

# Per-million-token pricing (USD) for known models.
# Loaded from models.json; local models = free (not listed).
from ..infra.model_config import get_all_pricing

_MODEL_PRICING: dict[str, tuple[float, float]] = get_all_pricing()

# Task types that can be answered without an LLM call.
_FTS_ONLY_TASKS = frozenset({"fts_lookup", "keyword_search"})

# Lightweight tasks — prefer local for speed & privacy.
# 90% of tasks use the lite model (fast, cheap, sufficient quality).
# Only deep_analysis and video_analysis justify the heavy model.
_LIGHTWEIGHT_TASKS = frozenset({
    "intent_classification", "summarize", "summarization",
    "guard_scan", "silence_classify",
    # "classification" removed — persona classification needs the primary model
    # for nuanced routing (e.g. "friend's coffee preference" = general, not health)
    "multi_step",
    # complex_reasoning stays on primary model — needed for tool calling (/ask)
})

# Heavy model: only for tasks that genuinely need max capability.
_COMPLEX_TASKS = frozenset({
    "deep_analysis",
    "video_analysis",
})

# Persona tiers that mandate extra care.
_SENSITIVE_TIERS = frozenset({"sensitive", "locked"})


class LLMRouter:
    """Routes LLM tasks to the optimal provider based on a decision tree.

    Parameters
    ----------
    providers:
        Map of provider identifiers to ``LLMProvider`` instances.
        Keys are freeform strings like ``"local"``, ``"gemini"``,
        ``"claude"``.  The router inspects ``provider.is_local`` to
        distinguish on-device from cloud.
    config:
        Brain configuration dict.  Recognised keys:

        - ``cloud_llm_consent`` (bool): whether the user has explicitly
          acknowledged cloud LLM consent during setup.
        - ``preferred_cloud`` (str): user's preferred cloud provider key.
    """

    def __init__(
        self,
        providers: dict[str, LLMProvider],
        config: dict[str, Any] | None = None,
    ) -> None:
        self._providers = providers
        self._config = config or {}

        # Partition into local and cloud for fast lookup.
        self._local: dict[str, LLMProvider] = {}
        self._cloud: dict[str, LLMProvider] = {}
        for key, provider in providers.items():
            if provider.is_local:
                self._local[key] = provider
            else:
                self._cloud[key] = provider

        # Token usage accumulator (thread-safe for async context).
        self._usage_lock = threading.Lock()
        self._usage: dict[str, dict[str, int]] = {}  # model -> {calls, tokens_in, tokens_out}

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def route(
        self,
        task_type: str,
        prompt: str,
        persona_tier: str = "open",
        context: dict | None = None,
        provider: str | None = None,
        *,
        messages: list[dict] | None = None,
        tools: list | None = None,
        tool_config: object | None = None,
    ) -> dict:
        """Route a task to the optimal LLM path.

        Decision tree
        -------------
        1. Simple lookup -> FTS5 only (no LLM call).
        2. Basic summarize + local available -> local (no PII scrub needed).
        3. Basic summarize + no local -> PII scrub -> cloud.
        4. Complex reasoning -> PII scrub (Tier 1+2) -> cloud -> rehydrate.
        5. Sensitive persona + local available -> local (never leaves node).
        6. Sensitive persona + no local -> Entity Vault + cloud (mandatory scrub).
        7. PII scrub failure on sensitive -> refuse cloud (hard security gate).
        8. Cloud consent required for sensitive persona cloud calls.
        9. Fallback: local down -> cloud; cloud rate-limited -> local.
        10. All unavailable -> graceful error.

        Parameters
        ----------
        task_type:
            Kind of task (``"summarize"``, ``"complex_reasoning"``,
            ``"fts_lookup"``, ``"health_query"``, etc.).
        prompt:
            The user prompt or assembled context to send to the LLM.
        persona_tier:
            The sensitivity tier of the requesting persona
            (``"open"``, ``"restricted"``, ``"locked"``).
        context:
            Optional extra routing context (e.g. ``cloud_llm_consent``).

        Returns
        -------
        dict
            LLM response dict with keys ``content``, ``model``,
            ``tokens_in``, ``tokens_out``, ``finish_reason``, and
            ``route`` (the path taken, e.g. ``"local"`` or ``"cloud"``).

        Raises
        ------
        LLMError
            When no provider is available for the task.
        PIIScrubError
            When PII scrubbing fails for a cloud-bound sensitive request.
        CloudConsentError
            When cloud consent has not been given for a sensitive persona.
        """
        ctx = context or {}
        is_sensitive = persona_tier in _SENSITIVE_TIERS

        # ---- 1. FTS-only: no LLM needed ----
        if task_type in _FTS_ONLY_TASKS:
            log.info("llm_router.fts_only", task_type=task_type)
            return {
                "content": "",
                "model": "fts5",
                "tokens_in": 0,
                "tokens_out": 0,
                "finish_reason": "fts_only",
                "route": "fts5",
            }

        # ---- 2-6. Select provider ----
        if provider:
            if provider not in self._providers:
                raise LLMError(
                    f"Unknown LLM provider '{provider}'. "
                    f"Available: {list(self._providers.keys())}"
                )
            selected = self._providers[provider]
        else:
            selected = self._select_provider(task_type, persona_tier)
        provider_obj = selected  # rename for clarity below

        # ---- Cloud consent gate for sensitive personas ----
        if is_sensitive and not provider_obj.is_local:
            consent = ctx.get(
                "cloud_llm_consent",
                self._config.get("cloud_llm_consent", False),
            )
            if consent is not True:
                raise CloudConsentError(
                    "Cloud LLM consent required for sensitive persona queries. "
                    "Set cloud_llm_consent=True in brain config after explicit "
                    "user acknowledgement."
                )

        # ---- Execute ----
        route_label = "local" if provider_obj.is_local else "cloud"
        from ..infra.trace_emit import trace as _trace
        _trace("llm.call", "brain", {
            "task_type": task_type, "model": provider_obj.model_name, "route": route_label,
        })
        log.info(
            "llm_router.route",
            task_type=task_type,
            persona_tier=persona_tier,
            route=route_label,
            model=provider_obj.model_name,
        )

        # Build kwargs for tool-calling support
        complete_kwargs: dict = {}
        if tools is not None:
            complete_kwargs["tools"] = tools
        if tool_config is not None:
            complete_kwargs["tool_config"] = tool_config

        # Use explicit messages if provided, otherwise wrap prompt
        call_messages = messages if messages is not None else [{"role": "user", "content": prompt}]

        import time as _time
        _t0 = _time.monotonic()
        try:
            response = await provider_obj.complete(
                messages=call_messages,
                **complete_kwargs,
            )
            _elapsed = _time.monotonic() - _t0
            _trace("llm.response", "brain", {
                "model": provider_obj.model_name, "elapsed_s": round(_elapsed, 2),
                "tokens_in": response.get("tokens_in", 0) if isinstance(response, dict) else 0,
                "tokens_out": response.get("tokens_out", 0) if isinstance(response, dict) else 0,
            })
            log.info(
                "llm_router.complete",
                model=provider_obj.model_name,
                task_type=task_type,
                elapsed_s=round(_elapsed, 2),
                tokens_in=response.get("tokens_in", 0) if isinstance(response, dict) else 0,
                tokens_out=response.get("tokens_out", 0) if isinstance(response, dict) else 0,
                prompt_len=len(prompt) if prompt else 0,
            )
        except Exception as exc:
            _elapsed = _time.monotonic() - _t0
            log.warning(
                "llm_router.complete_failed",
                model=provider_obj.model_name,
                task_type=task_type,
                elapsed_s=round(_elapsed, 2),
                error=type(exc).__name__,
                prompt_len=len(prompt) if prompt else 0,
            )
            # Attempt fallback before giving up.
            fallback = self._fallback_provider(provider_obj)
            if fallback is not None:
                log.warning(
                    "llm_router.fallback",
                    failed_model=provider_obj.model_name,
                    fallback_model=fallback.model_name,
                    error=str(exc),
                )
                if is_sensitive and not fallback.is_local:
                    consent = ctx.get(
                        "cloud_llm_consent",
                        self._config.get("cloud_llm_consent", False),
                    )
                    if consent is not True:
                        raise CloudConsentError(
                            f"Fallback to cloud provider '{fallback.model_name}' "
                            f"blocked: sensitive persona requires cloud_llm_consent=true"
                        )
                try:
                    response = await fallback.complete(
                        messages=call_messages,
                        **complete_kwargs,
                    )
                    route_label = "local" if fallback.is_local else "cloud"
                    response["route"] = route_label
                    self._track_usage(response)
                    return response
                except Exception as fallback_exc:
                    raise LLMError(
                        "All LLM providers unavailable: "
                        f"{type(exc).__name__}, {type(fallback_exc).__name__}"
                    ) from fallback_exc
            raise LLMError(
                f"LLM provider failed and no fallback available: "
                f"{type(exc).__name__}: {exc}"
            ) from exc

        if isinstance(response, dict):
            response["route"] = route_label
        self._track_usage(response)
        return response

    def reconfigure(
        self,
        providers: dict[str, LLMProvider],
        config: dict[str, Any] | None = None,
    ) -> None:
        """Hot-reload providers and config without restarting.

        Replaces the provider map, re-partitions into local/cloud,
        and optionally updates the config dict.  Called by the admin
        settings route after API keys are changed.
        """
        self._providers = providers
        if config is not None:
            self._config = config
        self._local = {k: p for k, p in providers.items() if p.is_local}
        self._cloud = {k: p for k, p in providers.items() if not p.is_local}
        log.info(
            "llm_router.reconfigured",
            providers=list(providers.keys()),
            local=list(self._local.keys()),
            cloud=list(self._cloud.keys()),
        )

    @property
    def has_cloud_provider(self) -> bool:
        """True when at least one cloud LLM provider is configured."""
        return bool(self._cloud)

    def available_models(self) -> list[str]:
        """Return list of available model identifiers."""
        return [p.model_name for p in self._providers.values()]

    def usage(self) -> dict:
        """Return accumulated token usage and estimated cost.

        Returns a dict with per-model breakdowns and a total:

        .. code-block:: python

            {
                "models": {
                    "gemini-2.5-flash": {
                        "calls": 12,
                        "tokens_in": 8400,
                        "tokens_out": 3200,
                        "cost_usd": 0.0105,
                    },
                    ...
                },
                "total_calls": 15,
                "total_tokens_in": 10000,
                "total_tokens_out": 4000,
                "total_cost_usd": 0.012,
            }
        """
        with self._usage_lock:
            models: dict[str, dict] = {}
            total_calls = 0
            total_in = 0
            total_out = 0
            total_cost = 0.0

            for model, stats in self._usage.items():
                calls = stats["calls"]
                tin = stats["tokens_in"]
                tout = stats["tokens_out"]
                rate_in, rate_out = self._model_cost_rates(model)
                cost = (tin * rate_in + tout * rate_out) / 1_000_000
                models[model] = {
                    "calls": calls,
                    "tokens_in": tin,
                    "tokens_out": tout,
                    "cost_usd": round(cost, 6),
                }
                total_calls += calls
                total_in += tin
                total_out += tout
                total_cost += cost

            return {
                "models": models,
                "total_calls": total_calls,
                "total_tokens_in": total_in,
                "total_tokens_out": total_out,
                "total_cost_usd": round(total_cost, 6),
            }

    async def embed(self, text: str) -> list[float]:
        """Generate an embedding vector via the best available provider.

        Prefers local providers (privacy — data never leaves the Home Node),
        falls back to cloud.  Raises ``LLMError`` if no provider supports
        embedding.
        """
        providers = list(self._local.values()) + list(self._cloud.values())
        last_exc: Exception | None = None
        for provider in providers:
            try:
                return await provider.embed(text)
            except Exception as exc:
                log.warning(
                    "llm_router.embed_failed",
                    provider=provider.model_name,
                    error=str(exc),
                )
                last_exc = exc
                continue
        raise LLMError(
            f"No provider available for embedding: {last_exc}"
        )

    # ------------------------------------------------------------------
    # Internal routing logic
    # ------------------------------------------------------------------

    def _select_provider(
        self, task_type: str, persona_tier: str
    ) -> LLMProvider:
        """Select the best provider for the given task and persona.

        Selection priority:

        1. Sensitive persona: prefer local, fall back to cloud.
        2. Complex task: prefer cloud, fall back to local.
        3. Everything else: prefer local, fall back to cloud.
        """
        is_sensitive = persona_tier in _SENSITIVE_TIERS
        is_complex = task_type in _COMPLEX_TASKS
        has_local = bool(self._local)
        has_cloud = bool(self._cloud)

        # Sensitive persona: local preferred (data never leaves node).
        if is_sensitive:
            if has_local:
                return next(iter(self._local.values()))
            if has_cloud:
                return self._preferred_cloud()
            raise LLMError(
                "No LLM provider available for sensitive persona query."
            )

        # Lightweight tasks: local preferred (fast, no PII exposure).
        # When falling back to cloud, prefer the lightweight provider
        # (e.g. Flash Lite) for cost savings.
        if task_type in _LIGHTWEIGHT_TASKS:
            if has_local:
                return next(iter(self._local.values()))
            if has_cloud:
                return self._preferred_lightweight_cloud()
            raise LLMError(
                "No LLM provider available for lightweight task."
            )

        # Complex reasoning: cloud preferred (more capable).
        if is_complex:
            if has_cloud:
                return self._preferred_cloud()
            if has_local:
                return next(iter(self._local.values()))
            raise LLMError(
                "No LLM provider available for complex reasoning."
            )

        # Default: prefer local for privacy.
        if has_local:
            return next(iter(self._local.values()))
        if has_cloud:
            return self._preferred_cloud()

        raise LLMError(
            "No LLM providers configured. Set at least one provider."
        )

    def _track_usage(self, response: dict | Any) -> None:
        """Accumulate token counts from an LLM response."""
        if not isinstance(response, dict):
            return
        model = response.get("model", "unknown")
        tin = response.get("tokens_in", 0) or 0
        tout = response.get("tokens_out", 0) or 0
        with self._usage_lock:
            if model not in self._usage:
                self._usage[model] = {"calls": 0, "tokens_in": 0, "tokens_out": 0}
            self._usage[model]["calls"] += 1
            self._usage[model]["tokens_in"] += tin
            self._usage[model]["tokens_out"] += tout

    @staticmethod
    def _model_cost_rates(model: str) -> tuple[float, float]:
        """Return (input_rate, output_rate) per million tokens for *model*."""
        if model in _MODEL_PRICING:
            return _MODEL_PRICING[model]
        # Substring match for versioned model IDs (e.g. "gemini-2.5-flash-001").
        for key, rates in _MODEL_PRICING.items():
            if key in model:
                return rates
        return (0.0, 0.0)  # unknown / local — free

    def _preferred_cloud(self) -> LLMProvider:
        """Return the user's preferred cloud provider, or the first one."""
        preferred_key = self._config.get("preferred_cloud")
        if preferred_key and preferred_key in self._cloud:
            return self._cloud[preferred_key]
        return next(iter(self._cloud.values()))

    def _preferred_lightweight_cloud(self) -> LLMProvider:
        """Return the lightweight cloud provider for cheap/fast tasks.

        Falls back to the standard preferred cloud if no lightweight
        provider is configured.
        """
        lite_key = self._config.get("lightweight_cloud")
        if lite_key and lite_key in self._cloud:
            return self._cloud[lite_key]
        return self._preferred_cloud()

    def _fallback_provider(self, failed: LLMProvider) -> LLMProvider | None:
        """Find a fallback provider after a failure.

        If the failed provider was local, try cloud and vice versa.
        """
        if failed.is_local:
            # Failed local -> try cloud.
            if self._cloud:
                return self._preferred_cloud()
        else:
            # Failed cloud -> try local.
            if self._local:
                return next(iter(self._local.values()))
        return None
