"""Provider Registry — multi-model routing for Dina.

Parses ``DINA_LIGHT``, ``DINA_HEAVY``, and ``DINA_EMBED`` from the
environment (``provider/model`` format) and exposes ready-to-use PydanticAI
Model instances plus a ChromaDB embedding function.

At least one of ``DINA_LIGHT`` or ``DINA_HEAVY`` must be configured.
"""

from __future__ import annotations

import os

from dotenv import load_dotenv
from pydantic_ai.models import Model

load_dotenv()


def _parse_spec(spec: str) -> tuple[str, str]:
    """Split ``"provider/model_name"`` into ``(provider, model_name)``."""
    parts = spec.split("/", maxsplit=1)
    if len(parts) != 2 or not parts[0] or not parts[1]:
        raise ValueError(
            f"Invalid model spec '{spec}' — expected 'provider/model' "
            f"(e.g. 'ollama/gemma3' or 'gemini/gemini-2.5-flash')"
        )
    return parts[0].lower(), parts[1]


def _make_model(spec: str) -> Model:
    """Create a PydanticAI ``Model`` from a ``provider/model_name`` spec."""
    provider, model_name = _parse_spec(spec)

    if provider == "gemini":
        from pydantic_ai.models.google import GoogleModel

        return GoogleModel(model_name)

    if provider == "ollama":
        from pydantic_ai.models.openai import OpenAIChatModel
        from pydantic_ai.providers.ollama import OllamaProvider

        base_url = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
        return OpenAIChatModel(
            model_name=model_name,
            provider=OllamaProvider(base_url=f"{base_url}/v1"),
        )

    raise ValueError(
        f"Unknown provider '{provider}' — supported: ollama, gemini"
    )


class DinaProviders:
    """Central registry for Dina's LLM and embedding providers."""

    def __init__(self) -> None:
        light_spec = os.getenv("DINA_LIGHT")
        heavy_spec = os.getenv("DINA_HEAVY")
        embed_spec = os.getenv("DINA_EMBED")

        if not light_spec and not heavy_spec:
            raise RuntimeError(
                "No model configured — set at least DINA_LIGHT or DINA_HEAVY "
                "in your .env (e.g. DINA_LIGHT=ollama/gemma3)"
            )

        self.light_model: Model | None = _make_model(light_spec) if light_spec else None
        self.heavy_model: Model | None = _make_model(heavy_spec) if heavy_spec else None

        self._light_spec = light_spec
        self._heavy_spec = heavy_spec

        # Heavy provider detection (for VideoUrl capability)
        self._heavy_provider: str | None = None
        if heavy_spec:
            self._heavy_provider, _ = _parse_spec(heavy_spec)

        # Embedding — explicit or inferred from available provider
        if embed_spec:
            self._embed_provider, self._embed_model = _parse_spec(embed_spec)
        elif light_spec:
            p, _ = _parse_spec(light_spec)
            self._embed_provider = p
            self._embed_model = (
                "nomic-embed-text" if p == "ollama" else "gemini-embedding-001"
            )
        else:
            p, _ = _parse_spec(heavy_spec)  # type: ignore[arg-type]
            self._embed_provider = p
            self._embed_model = (
                "nomic-embed-text" if p == "ollama" else "gemini-embedding-001"
            )

    # ── Model routing ─────────────────────────────────────────────

    @property
    def verdict_model(self) -> Model:
        """Model for video/verdict analysis — prefer heavy."""
        model = self.heavy_model or self.light_model
        if model is None:
            raise RuntimeError("No model configured")
        return model

    @property
    def chat_model(self) -> Model:
        """Model for conversational RAG — prefer light."""
        model = self.light_model or self.heavy_model
        if model is None:
            raise RuntimeError("No model configured")
        return model

    @property
    def can_analyze_video(self) -> bool:
        """True if the heavy model is Gemini (supports native YouTube VideoUrl)."""
        return self._heavy_provider == "gemini"

    # ── Embeddings ────────────────────────────────────────────────

    def make_embedding_function(self):
        """Create a ChromaDB embedding function from the configured embed provider."""
        if self._embed_provider == "gemini":
            from chromadb.utils.embedding_functions.google_embedding_function import (
                GoogleGenaiEmbeddingFunction,
            )

            return GoogleGenaiEmbeddingFunction(model_name=self._embed_model)

        # Default: Ollama
        from chromadb.utils.embedding_functions import OllamaEmbeddingFunction

        base_url = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
        return OllamaEmbeddingFunction(
            model_name=self._embed_model,
            url=f"{base_url}/api/embeddings",
        )

    @property
    def embed_provider(self) -> str:
        """Provider name — used for ChromaDB collection naming."""
        return self._embed_provider

    # ── Display ───────────────────────────────────────────────────

    @property
    def status_lines(self) -> list[str]:
        """Human-readable provider status for the REPL banner."""
        lines: list[str] = []
        if self._light_spec:
            lines.append(f"Light: {self._light_spec}")
        if self._heavy_spec:
            tag = " (video-capable)" if self.can_analyze_video else ""
            lines.append(f"Heavy: {self._heavy_spec}{tag}")
        if not self._light_spec:
            lines.append(f"Model: {self._heavy_spec} (used for everything)")
        elif not self._heavy_spec:
            lines.append(f"Model: {self._light_spec} (used for everything)")
        return lines


class _LazyProviders:
    """Lazy proxy — defers ``DinaProviders`` init until first attribute access.

    This lets test code patch ``dina.providers.providers`` (or set env vars)
    before the real constructor runs.
    """

    def __init__(self) -> None:
        self._instance: DinaProviders | None = None

    def _ensure(self) -> DinaProviders:
        if self._instance is None:
            self._instance = DinaProviders()
        return self._instance

    def __getattr__(self, name: str):
        return getattr(self._ensure(), name)


# Singleton — import as ``from dina.providers import providers``
providers: DinaProviders = _LazyProviders()  # type: ignore[assignment]
