"""Unit tests for dina.providers — multi-provider config, routing, and embedding."""

from __future__ import annotations

from unittest.mock import patch

import pytest

pytestmark = pytest.mark.legacy


def _make_providers(env: dict):
    """Create a fresh DinaProviders with the given env vars.

    Patches ``os.environ`` so only the specified keys are visible to the
    constructor (plus PATH to keep things sane).
    """
    import importlib
    import os

    clean_env = {k: v for k, v in os.environ.items() if k == "PATH"}
    clean_env.update(env)
    with patch.dict(os.environ, clean_env, clear=True):
        # Re-import to force re-evaluation with fresh env
        import dina.providers as mod

        importlib.reload(mod)
        return mod.DinaProviders()


# ── Config parsing ────────────────────────────────────────────────


class TestParseSpec:
    """Tests for _parse_spec helper."""

    def test_valid_ollama_spec(self):
        from dina.providers import _parse_spec

        assert _parse_spec("ollama/gemma3") == ("ollama", "gemma3")

    def test_valid_gemini_spec(self):
        from dina.providers import _parse_spec

        assert _parse_spec("gemini/gemini-2.5-flash") == ("gemini", "gemini-2.5-flash")

    def test_provider_normalized_to_lower(self):
        from dina.providers import _parse_spec

        assert _parse_spec("OLLAMA/gemma3") == ("ollama", "gemma3")

    def test_invalid_no_slash(self):
        from dina.providers import _parse_spec

        with pytest.raises(ValueError, match="Invalid model spec"):
            _parse_spec("just-a-model")

    def test_invalid_empty_provider(self):
        from dina.providers import _parse_spec

        with pytest.raises(ValueError, match="Invalid model spec"):
            _parse_spec("/gemma3")

    def test_invalid_empty_model(self):
        from dina.providers import _parse_spec

        with pytest.raises(ValueError, match="Invalid model spec"):
            _parse_spec("ollama/")

    def test_spec_with_multiple_slashes(self):
        from dina.providers import _parse_spec

        provider, model = _parse_spec("ollama/my/custom/model")
        assert provider == "ollama"
        assert model == "my/custom/model"


# ── No config error ───────────────────────────────────────────────


class TestNoConfig:
    """Tests for error when no provider is configured."""

    def test_raises_when_nothing_configured(self):
        with pytest.raises(RuntimeError, match="No model configured"):
            _make_providers({})


# ── Light-only config ─────────────────────────────────────────────


class TestLightOnly:
    """Tests when only DINA_LIGHT is set."""

    def test_light_model_created(self):
        p = _make_providers({"DINA_LIGHT": "ollama/gemma3"})
        assert p.light_model is not None

    def test_heavy_model_is_none(self):
        p = _make_providers({"DINA_LIGHT": "ollama/gemma3"})
        assert p.heavy_model is None

    def test_verdict_model_falls_back_to_light(self):
        p = _make_providers({"DINA_LIGHT": "ollama/gemma3"})
        assert p.verdict_model is p.light_model

    def test_chat_model_uses_light(self):
        p = _make_providers({"DINA_LIGHT": "ollama/gemma3"})
        assert p.chat_model is p.light_model

    def test_cannot_analyze_video(self):
        p = _make_providers({"DINA_LIGHT": "ollama/gemma3"})
        assert p.can_analyze_video is False

    def test_embed_provider_inferred_from_light(self):
        p = _make_providers({"DINA_LIGHT": "ollama/gemma3"})
        assert p.embed_provider == "ollama"

    def test_status_lines_show_single_model(self):
        p = _make_providers({"DINA_LIGHT": "ollama/gemma3"})
        text = " ".join(p.status_lines)
        assert "used for everything" in text


# ── Heavy-only config ─────────────────────────────────────────────


class TestHeavyOnly:
    """Tests when only DINA_HEAVY is set."""

    def test_heavy_model_created(self):
        p = _make_providers({"DINA_HEAVY": "gemini/gemini-2.5-flash"})
        assert p.heavy_model is not None

    def test_light_model_is_none(self):
        p = _make_providers({"DINA_HEAVY": "gemini/gemini-2.5-flash"})
        assert p.light_model is None

    def test_verdict_model_uses_heavy(self):
        p = _make_providers({"DINA_HEAVY": "gemini/gemini-2.5-flash"})
        assert p.verdict_model is p.heavy_model

    def test_chat_model_falls_back_to_heavy(self):
        p = _make_providers({"DINA_HEAVY": "gemini/gemini-2.5-flash"})
        assert p.chat_model is p.heavy_model

    def test_can_analyze_video_gemini(self):
        p = _make_providers({"DINA_HEAVY": "gemini/gemini-2.5-flash"})
        assert p.can_analyze_video is True

    def test_cannot_analyze_video_ollama_heavy(self):
        p = _make_providers({"DINA_HEAVY": "ollama/gemma3"})
        assert p.can_analyze_video is False

    def test_embed_provider_inferred_from_heavy(self):
        p = _make_providers({"DINA_HEAVY": "gemini/gemini-2.5-flash"})
        assert p.embed_provider == "gemini"


# ── Both configured ───────────────────────────────────────────────


class TestBothConfigured:
    """Tests when both DINA_LIGHT and DINA_HEAVY are set."""

    def test_both_models_created(self):
        p = _make_providers({
            "DINA_LIGHT": "ollama/gemma3",
            "DINA_HEAVY": "gemini/gemini-2.5-flash",
        })
        assert p.light_model is not None
        assert p.heavy_model is not None

    def test_verdict_uses_heavy(self):
        p = _make_providers({
            "DINA_LIGHT": "ollama/gemma3",
            "DINA_HEAVY": "gemini/gemini-2.5-flash",
        })
        assert p.verdict_model is p.heavy_model

    def test_chat_uses_light(self):
        p = _make_providers({
            "DINA_LIGHT": "ollama/gemma3",
            "DINA_HEAVY": "gemini/gemini-2.5-flash",
        })
        assert p.chat_model is p.light_model

    def test_can_analyze_video_when_heavy_is_gemini(self):
        p = _make_providers({
            "DINA_LIGHT": "ollama/gemma3",
            "DINA_HEAVY": "gemini/gemini-2.5-flash",
        })
        assert p.can_analyze_video is True

    def test_cannot_analyze_video_when_heavy_is_ollama(self):
        p = _make_providers({
            "DINA_LIGHT": "ollama/gemma3",
            "DINA_HEAVY": "ollama/llama3",
        })
        assert p.can_analyze_video is False

    def test_embed_provider_prefers_light(self):
        p = _make_providers({
            "DINA_LIGHT": "ollama/gemma3",
            "DINA_HEAVY": "gemini/gemini-2.5-flash",
        })
        assert p.embed_provider == "ollama"

    def test_status_lines_show_both(self):
        p = _make_providers({
            "DINA_LIGHT": "ollama/gemma3",
            "DINA_HEAVY": "gemini/gemini-2.5-flash",
        })
        lines = p.status_lines
        text = " ".join(lines)
        assert "Light:" in text
        assert "Heavy:" in text
        assert "video-capable" in text


# ── Explicit DINA_EMBED ──────────────────────────────────────────


class TestExplicitEmbed:
    """Tests when DINA_EMBED is explicitly set."""

    def test_embed_provider_from_explicit(self):
        p = _make_providers({
            "DINA_LIGHT": "ollama/gemma3",
            "DINA_EMBED": "gemini/gemini-embedding-001",
        })
        assert p.embed_provider == "gemini"

    def test_embed_model_from_explicit(self):
        p = _make_providers({
            "DINA_LIGHT": "ollama/gemma3",
            "DINA_EMBED": "ollama/nomic-embed-text",
        })
        assert p._embed_model == "nomic-embed-text"


# ── Model type detection ─────────────────────────────────────────


class TestModelTypes:
    """Tests for correct PydanticAI model types."""

    def test_gemini_creates_google_model(self):
        from pydantic_ai.models.google import GoogleModel

        p = _make_providers({"DINA_HEAVY": "gemini/gemini-2.5-flash"})
        assert isinstance(p.heavy_model, GoogleModel)

    def test_ollama_creates_openai_chat_model(self):
        from pydantic_ai.models.openai import OpenAIChatModel

        p = _make_providers({"DINA_LIGHT": "ollama/gemma3"})
        assert isinstance(p.light_model, OpenAIChatModel)


# ── Unknown provider ─────────────────────────────────────────────


class TestUnknownProvider:
    """Tests for unsupported provider names."""

    def test_unknown_provider_raises(self):
        with pytest.raises(ValueError, match="Unknown provider"):
            _make_providers({"DINA_LIGHT": "openrouter/mistral"})
