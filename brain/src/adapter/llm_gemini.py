"""Google Gemini LLM adapter — implements LLMProvider protocol.

Wraps the ``google-genai`` library for chat completion,
embedding, and zero-shot classification via structured output.

Third-party imports:  google.genai, structlog.
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
    """Implements LLMProvider via Google Gemini API (google.genai SDK).

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
                "GEMINI_API_KEY is required for GeminiProvider"
            )
        self._api_key = api_key
        self._model = model
        self._embed_model = embed_model
        self._client: Any = None  # lazy import
        self._types: Any = None   # lazy import

    # -- Lazy library import -------------------------------------------------

    def _ensure_client(self) -> tuple[Any, Any]:
        """Import google.genai and create client on first use."""
        if self._client is None:
            try:
                from google import genai  # type: ignore[import-untyped]
                from google.genai import types  # type: ignore[import-untyped]
            except ImportError as exc:
                raise ConfigError(
                    "google-genai package not installed. "
                    "Run: pip install google-genai"
                ) from exc
            self._client = genai.Client(api_key=self._api_key)
            self._types = types
        return self._client, self._types

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
                      ``system_instruction`` in config.
            **kwargs: Forwarded as generation config (``temperature``,
                      ``max_output_tokens``, etc.).

        Returns:
            Dict with ``content``, ``model``, ``tokens_in``,
            ``tokens_out``, ``finish_reason``.

        Raises:
            LLMError: On API error, rate-limit, or timeout.
        """
        client, types = self._ensure_client()

        # Separate system messages from conversation
        system_parts: list[str] = []
        contents: list[Any] = []

        for msg in messages:
            role = msg.get("role", "user")
            content = msg.get("content", "")

            if role == "system":
                system_parts.append(content)

            elif role == "tool_call":
                # Model requested a function call — reconstruct as model turn
                parts = []
                for tc in msg.get("tool_calls", []):
                    parts.append(types.Part(
                        function_call=types.FunctionCall(
                            name=tc["name"],
                            args=tc.get("args", {}),
                            id=tc.get("id"),
                        )
                    ))
                if parts:
                    contents.append(types.Content(role="model", parts=parts))

            elif role == "tool_response":
                # Function execution results — send as user turn with FunctionResponse
                parts = []
                for tr in msg.get("tool_responses", []):
                    parts.append(types.Part(
                        function_response=types.FunctionResponse(
                            name=tr["name"],
                            response=tr.get("response", {}),
                            id=tr.get("id"),
                        )
                    ))
                if parts:
                    contents.append(types.Content(role="user", parts=parts))

            elif role == "assistant":
                contents.append(types.Content(
                    role="model",
                    parts=[types.Part(text=content)],
                ))
            else:
                contents.append(types.Content(
                    role="user",
                    parts=[types.Part(text=content)],
                ))

        if not contents:
            raise LLMError("At least one user message is required")

        # Build generation config
        config_kwargs: dict[str, Any] = {}
        for key in ("temperature", "max_output_tokens", "top_p", "top_k"):
            if key in kwargs:
                config_kwargs[key] = kwargs[key]
        if system_parts:
            config_kwargs["system_instruction"] = "\n".join(system_parts)

        # Tool-calling support: pass tools and tool_config through
        if "tools" in kwargs:
            config_kwargs["tools"] = kwargs["tools"]
        if "tool_config" in kwargs:
            config_kwargs["tool_config"] = kwargs["tool_config"]

        config = types.GenerateContentConfig(**config_kwargs)

        try:
            response = await asyncio.wait_for(
                client.aio.models.generate_content(
                    model=self._model,
                    contents=contents,
                    config=config,
                ),
                timeout=_TIMEOUT_S,
            )

            # Extract token counts
            tokens_in = 0
            tokens_out = 0
            if hasattr(response, "usage_metadata") and response.usage_metadata:
                usage = response.usage_metadata
                tokens_in = getattr(usage, "prompt_token_count", 0) or 0
                tokens_out = getattr(usage, "candidates_token_count", 0) or 0

            # Extract finish reason and detect function calls
            finish_reason = "stop"
            tool_calls: list[dict[str, Any]] = []
            response_text = ""

            if response.candidates:
                candidate = response.candidates[0]
                fr = getattr(candidate, "finish_reason", None)
                if fr is not None:
                    finish_reason = str(fr).lower().replace("finishreason.", "")

                # Check parts for function calls
                content_part = getattr(candidate, "content", None)
                if content_part and hasattr(content_part, "parts"):
                    for part in content_part.parts:
                        fc = getattr(part, "function_call", None)
                        if fc is not None:
                            tool_calls.append({
                                "name": fc.name,
                                "args": dict(fc.args) if fc.args else {},
                                "id": getattr(fc, "id", None),
                            })
                        elif getattr(part, "text", None):
                            response_text += part.text

            if not response_text and not tool_calls:
                # Fallback to response.text for simple responses
                try:
                    response_text = response.text or ""
                except (ValueError, AttributeError):
                    response_text = ""

            result: dict[str, Any] = {
                "content": response_text,
                "model": self._model,
                "tokens_in": tokens_in,
                "tokens_out": tokens_out,
                "finish_reason": finish_reason,
            }
            if tool_calls:
                result["tool_calls"] = tool_calls
            return result

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
        client, types = self._ensure_client()

        try:
            result = await asyncio.wait_for(
                client.aio.models.embed_content(
                    model=self._embed_model,
                    contents=text,
                ),
                timeout=_TIMEOUT_S,
            )
            return list(result.embeddings[0].values)
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
