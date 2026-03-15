"""Load centralized model defaults from models.json.

models.json lives at the repo root and is bind-mounted into the Brain
container at /app/models.json.  Every consumer reads from the same file.

Model references use ``provider/model`` format (e.g. ``gemini/gemini-3.1-pro-preview``).
The first segment identifies the provider, the rest is the model ID passed to the SDK.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

_MODELS_JSON_PATHS = [
    Path("/app/models.json"),                             # Docker container
    Path(__file__).resolve().parents[4] / "models.json",  # Local dev
]

_cache: dict[str, Any] | None = None


def load_models_config() -> dict[str, Any]:
    """Load and cache models.json. Returns empty dict if not found."""
    global _cache
    if _cache is not None:
        return _cache

    override = os.environ.get("DINA_MODELS_JSON", "").strip()
    if override:
        _MODELS_JSON_PATHS.insert(0, Path(override))

    for path in _MODELS_JSON_PATHS:
        if path.is_file():
            _cache = json.loads(path.read_text())
            return _cache

    _cache = {}
    return _cache


def split_model_ref(ref: str) -> tuple[str, str]:
    """Split ``provider/model`` into (provider, model_id).

    For OpenRouter-style refs like ``openrouter/google/gemini-3-flash``,
    the provider is the first segment and the model_id is everything after.
    """
    parts = ref.split("/", 1)
    if len(parts) == 2:
        return parts[0], parts[1]
    return "", ref


def get_defaults() -> dict[str, str]:
    """Return the top-level defaults (primary, lite, fallbacks).

    Returns dict with keys: primary_provider, primary_model,
    lite_provider, lite_model, fallbacks (list of provider/model strings).
    """
    cfg = load_models_config()
    defaults = cfg.get("defaults", {})
    result: dict[str, Any] = {}

    primary = defaults.get("primary", "")
    p_prov, p_model = split_model_ref(primary)
    result["primary_provider"] = p_prov
    result["primary_model"] = p_model

    lite = defaults.get("lite", "")
    l_prov, l_model = split_model_ref(lite)
    result["lite_provider"] = l_prov
    result["lite_model"] = l_model

    result["fallbacks"] = defaults.get("fallbacks", [])
    return result


def get_provider_config(provider: str) -> dict[str, Any]:
    """Return the full provider config block from models.json."""
    cfg = load_models_config()
    return cfg.get("providers", {}).get(provider, {})


def get_provider_models(provider: str) -> list[str]:
    """Return list of model IDs available for a provider."""
    prov = get_provider_config(provider)
    return list(prov.get("models", {}).keys())


def get_all_pricing() -> dict[str, tuple[float, float]]:
    """Merge all provider pricing into a flat dict for LLMRouter.

    Keys use ``provider/model`` format.
    """
    cfg = load_models_config()
    pricing: dict[str, tuple[float, float]] = {}
    for prov_name, prov in cfg.get("providers", {}).items():
        for model_id, model_info in prov.get("models", {}).items():
            rates = model_info.get("pricing", [])
            if isinstance(rates, list) and len(rates) == 2:
                # Store both with and without provider prefix for flexible lookup
                pricing[f"{prov_name}/{model_id}"] = (rates[0], rates[1])
                pricing[model_id] = (rates[0], rates[1])
    return pricing
