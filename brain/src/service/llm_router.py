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

from typing import Any

import structlog

from ..domain.errors import CloudConsentError, LLMError, PIIScrubError
from ..port.llm import LLMProvider

log = structlog.get_logger(__name__)

# Task types that can be answered without an LLM call.
_FTS_ONLY_TASKS = frozenset({"fts_lookup", "keyword_search"})

# Task types considered "complex" that benefit from cloud models.
_COMPLEX_TASKS = frozenset({
    "complex_reasoning",
    "video_analysis",
    "multi_step",
    "deep_analysis",
})

# Persona tiers that mandate extra care.
_SENSITIVE_TIERS = frozenset({"restricted", "locked"})


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
        if provider and provider in self._providers:
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
            if not consent:
                raise CloudConsentError(
                    "Cloud LLM consent required for sensitive persona queries. "
                    "Set cloud_llm_consent=True in brain config after explicit "
                    "user acknowledgement."
                )

        # ---- Execute ----
        route_label = "local" if provider_obj.is_local else "cloud"
        log.info(
            "llm_router.route",
            task_type=task_type,
            persona_tier=persona_tier,
            route=route_label,
            model=provider_obj.model_name,
        )

        try:
            response = await provider_obj.complete(
                messages=[{"role": "user", "content": prompt}],
            )
        except Exception as exc:
            # Attempt fallback before giving up.
            fallback = self._fallback_provider(provider_obj)
            if fallback is not None:
                log.warning(
                    "llm_router.fallback",
                    failed_model=provider_obj.model_name,
                    fallback_model=fallback.model_name,
                    error=str(exc),
                )
                try:
                    response = await fallback.complete(
                        messages=[{"role": "user", "content": prompt}],
                    )
                    route_label = "local" if fallback.is_local else "cloud"
                    response["route"] = route_label
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
        return response

    def available_models(self) -> list[str]:
        """Return list of available model identifiers."""
        return [p.model_name for p in self._providers.values()]

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

    def _preferred_cloud(self) -> LLMProvider:
        """Return the user's preferred cloud provider, or the first one."""
        preferred_key = self._config.get("preferred_cloud")
        if preferred_key and preferred_key in self._cloud:
            return self._cloud[preferred_key]
        return next(iter(self._cloud.values()))

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
