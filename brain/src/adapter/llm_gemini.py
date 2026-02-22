"""Google Gemini LLM adapter — implements LLMProvider protocol.

Wraps the ``google-generativeai`` library for chat completion,
embedding, and zero-shot classification via structured output.

Third-party imports:  google.generativeai, structlog.
"""

from __future__ import annotations

import asyncio
from functools import cached_property
from typing import Any

import structlog

from ..domain.errors import ConfigError, LLMError

logger = structlog.get_logger(__name__)

_TIMEOUT_S = 60.0
_EMBED_MODEL = "models/text-embedding-004"


class GeminiProvider:
    """Implements LLMProvider via Google Gemini API.

    Properties:
        model_name: The Gemini model identifier (e.g. ``gemini-2.5-flash``).
        is_local:   Always ``False`` — Gemini is a cloud provider.
    """

    def __init__(
        self,
        api_key: str,
        model: str = "gemini-2.5-flash",
        embed_model: str = _EMBED_MODEL,
    ) -> None:
        if not api_key:
            raise ConfigError(
                "GOOGLE_API_KEY is required for GeminiProvider"
            )
        self._api_key = api_key
        self._model = model
        self._embed_model = embed_model
        self._genai: Any = None  # lazy import

    # -- Lazy library import -------------------------------------------------

    def _ensure_genai(self) -> Any:
        """Import and configure google.generativeai on first use."""
        if self._genai is None:
            try:
                import google.generativeai as genai  # type: ignore[import-untyped]
            except ImportError as exc:
                raise ConfigError(
                    "google-generativeai package not installed. "
                    "Run: pip install google-generativeai"
                ) from exc
            genai.configure(api_key=self._api_key)
            self._genai = genai
        return self._genai

    # -- Properties ----------------------------------------------------------

    @cached_property
    def model_name(self) -> str:
        """Human-readable model identifier."""
        return self._model

    @cached_property
    def is_local(self) -> bool:
        """Gemini is a cloud provider — always False."""
        return False

    # -- LLMProvider protocol ------------------------------------------------

    async def complete(self, messages: list[dict], **kwargs: Any) -> dict:
        """Send a chat-completion request to Gemini.

        Parameters:
            messages: List of ``{"role": ..., "content": ...}`` dicts.
                      Roles are mapped: ``"user"`` -> ``"user"``,
                      ``"assistant"`` -> ``"model"``, ``"system"`` ->
                      prepended to first user message.
            **kwargs: Forwarded as generation config (``temperature``,
                      ``max_output_tokens``, etc.).

        Returns:
            Dict with ``content``, ``model``, ``tokens_in``,
            ``tokens_out``, ``finish_reason``.

        Raises:
            LLMError: On API error, rate-limit, or timeout.
        """
        genai = self._ensure_genai()

        # Build Gemini-native message history
        system_parts: list[str] = []
        history: list[dict[str, Any]] = []

        for msg in messages:
            role = msg.get("role", "user")
            content = msg.get("content", "")
            if role == "system":
                system_parts.append(content)
            elif role == "assistant":
                history.append({"role": "model", "parts": [content]})
            else:
                # Prepend accumulated system prompt to first user message
                if system_parts:
                    content = "\n".join(system_parts) + "\n\n" + content
                    system_parts.clear()
                history.append({"role": "user", "parts": [content]})

        if not history:
            raise LLMError("At least one user message is required")

        # Generation config from kwargs
        gen_config = {}
        for key in ("temperature", "max_output_tokens", "top_p", "top_k"):
            if key in kwargs:
                gen_config[key] = kwargs[key]

        try:
            model = genai.GenerativeModel(self._model)

            # Extract the last user message and use remaining as history
            last_msg = history[-1]
            chat_history = history[:-1] if len(history) > 1 else []

            chat = model.start_chat(history=chat_history)

            response = await asyncio.wait_for(
                asyncio.to_thread(
                    chat.send_message,
                    last_msg["parts"][0],
                    generation_config=gen_config if gen_config else None,
                ),
                timeout=_TIMEOUT_S,
            )

            # Extract token counts
            tokens_in = 0
            tokens_out = 0
            if hasattr(response, "usage_metadata"):
                usage = response.usage_metadata
                tokens_in = getattr(usage, "prompt_token_count", 0)
                tokens_out = getattr(usage, "candidates_token_count", 0)

            # Extract finish reason
            finish_reason = "stop"
            if response.candidates:
                candidate = response.candidates[0]
                fr = getattr(candidate, "finish_reason", None)
                if fr is not None:
                    finish_reason = str(fr).lower().replace("finishreason.", "")

            return {
                "content": response.text,
                "model": self._model,
                "tokens_in": tokens_in,
                "tokens_out": tokens_out,
                "finish_reason": finish_reason,
            }

        except asyncio.TimeoutError:
            raise LLMError(
                f"Gemini request timed out after {_TIMEOUT_S}s"
            )
        except Exception as exc:
            exc_str = str(exc).lower()
            if "429" in exc_str or "resource_exhausted" in exc_str:
                raise LLMError(
                    f"Gemini rate limited (429): {exc}",
                ) from exc
            raise LLMError(f"Gemini API error: {exc}") from exc

    async def embed(self, text: str) -> list[float]:
        """Generate an embedding vector via Gemini embedding model.

        Returns a list of floats (typically 768 dimensions).

        Raises:
            LLMError: On API error or timeout.
        """
        genai = self._ensure_genai()

        try:
            result = await asyncio.wait_for(
                asyncio.to_thread(
                    genai.embed_content,
                    model=self._embed_model,
                    content=text,
                    task_type="retrieval_document",
                ),
                timeout=_TIMEOUT_S,
            )
            return result["embedding"]
        except asyncio.TimeoutError:
            raise LLMError(
                f"Gemini embed request timed out after {_TIMEOUT_S}s"
            )
        except Exception as exc:
            raise LLMError(f"Gemini embed error: {exc}") from exc

    async def classify(self, text: str, categories: list[str]) -> str:
        """Classify text into one of the given categories via structured output.

        Uses a single-turn prompt that instructs Gemini to respond with
        exactly one of the listed category labels.

        Returns:
            The winning category label as a plain string.

        Raises:
            LLMError: On API error, timeout, or if response is not a valid category.
        """
        category_list = ", ".join(f'"{c}"' for c in categories)
        prompt = (
            f"Classify the following text into exactly one of these categories: "
            f"{category_list}.\n\n"
            f"Text: {text}\n\n"
            f"Respond with ONLY the category label, nothing else."
        )

        result = await self.complete(
            [{"role": "user", "content": prompt}],
            temperature=0.0,
            max_output_tokens=50,
        )

        label = result["content"].strip().strip('"').strip("'")

        # Validate the response is one of the expected categories
        for cat in categories:
            if label.lower() == cat.lower():
                return cat

        logger.warning(
            "gemini_classify_unexpected",
            label=label,
            categories=categories,
        )
        # Return the raw label — caller decides whether to retry or accept
        return label
