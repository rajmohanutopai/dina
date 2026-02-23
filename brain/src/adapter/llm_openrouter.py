"""OpenRouter LLM adapter — implements LLMProvider protocol.

Wraps the OpenRouter unified API (OpenAI-compatible) for chat
completion and zero-shot classification.  Supports any model
available on OpenRouter (Gemini, Claude, Llama, Mistral, etc.)
via a single API key.

OpenRouter does not support embeddings — use GeminiProvider or
LlamaProvider for that.

Third-party imports:  httpx, structlog.
"""

from __future__ import annotations

import asyncio
from functools import cached_property
from typing import Any

import httpx
import structlog

from ..domain.errors import ConfigError, LLMError

logger = structlog.get_logger(__name__)

_TIMEOUT_S = 60.0
_BASE_URL = "https://openrouter.ai/api/v1"


class OpenRouterProvider:
    """Implements LLMProvider via OpenRouter's OpenAI-compatible API.

    Properties:
        model_name: The model identifier (e.g. ``google/gemini-2.5-flash``).
        is_local:   Always ``False`` — OpenRouter is a cloud gateway.
    """

    def __init__(
        self,
        api_key: str,
        model: str = "google/gemini-2.5-flash",
        base_url: str = _BASE_URL,
    ) -> None:
        if not api_key:
            raise ConfigError(
                "OPENROUTER_API_KEY is required for OpenRouterProvider"
            )
        self._api_key = api_key
        self._model = model
        self._base_url = base_url.rstrip("/")
        self._client: httpx.AsyncClient | None = None

    # -- Lifecycle -----------------------------------------------------------

    def _ensure_client(self) -> httpx.AsyncClient:
        """Lazily create the underlying httpx client with auth headers."""
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                base_url=self._base_url,
                timeout=httpx.Timeout(_TIMEOUT_S),
                headers={
                    "Authorization": f"Bearer {self._api_key}",
                    "HTTP-Referer": "https://dina.dev",
                    "X-Title": "Dina Brain",
                },
            )
        return self._client

    async def close(self) -> None:
        """Close the underlying HTTP client."""
        if self._client is not None and not self._client.is_closed:
            await self._client.aclose()
            self._client = None

    # -- Properties ----------------------------------------------------------

    @cached_property
    def model_name(self) -> str:
        """Human-readable model identifier."""
        return self._model

    @cached_property
    def is_local(self) -> bool:
        """OpenRouter is a cloud gateway — always False."""
        return False

    # -- LLMProvider protocol ------------------------------------------------

    async def complete(self, messages: list[dict], **kwargs: Any) -> dict:
        """POST /chat/completions — OpenAI-compatible chat completion.

        Parameters:
            messages: List of ``{"role": ..., "content": ...}`` dicts.
            **kwargs: Forwarded as request body fields (``temperature``,
                      ``max_tokens``, etc.).

        Returns:
            Dict with ``content``, ``model``, ``tokens_in``,
            ``tokens_out``, ``finish_reason``.

        Raises:
            LLMError: On connection failure, timeout, or unexpected response.
        """
        client = self._ensure_client()

        body: dict[str, Any] = {
            "model": self._model,
            "messages": messages,
        }

        # Forward supported kwargs
        for key in ("temperature", "max_tokens", "max_output_tokens",
                     "top_p", "stop"):
            if key in kwargs:
                body[key] = kwargs[key]

        try:
            resp = await asyncio.wait_for(
                client.post("/chat/completions", json=body),
                timeout=_TIMEOUT_S,
            )
            resp.raise_for_status()
            data = resp.json()

            # Parse OpenAI-compatible response format
            choices = data.get("choices", [])
            if not choices:
                raise LLMError("OpenRouter returned empty choices array")

            choice = choices[0]
            message = choice.get("message", {})
            content = message.get("content", "")

            # Token usage
            usage = data.get("usage", {})
            tokens_in = usage.get("prompt_tokens", 0)
            tokens_out = usage.get("completion_tokens", 0)

            # Finish reason
            finish_reason = choice.get("finish_reason", "stop") or "stop"

            # Use server-reported model name if available
            model = data.get("model", self._model)

            return {
                "content": content,
                "model": model,
                "tokens_in": tokens_in,
                "tokens_out": tokens_out,
                "finish_reason": finish_reason,
            }

        except asyncio.TimeoutError:
            raise LLMError(
                f"OpenRouter request timed out after {_TIMEOUT_S}s"
            )
        except httpx.ConnectError as exc:
            raise LLMError(
                f"OpenRouter unreachable at {self._base_url}: {exc}"
            ) from exc
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            body_text = exc.response.text
            if status == 429:
                raise LLMError(
                    f"OpenRouter rate limited (429): {body_text}"
                ) from exc
            if status == 401:
                raise ConfigError(
                    "OpenRouter authentication failed — check OPENROUTER_API_KEY"
                ) from exc
            raise LLMError(
                f"OpenRouter returned HTTP {status}: {body_text}"
            ) from exc
        except LLMError:
            raise
        except ConfigError:
            raise
        except Exception as exc:
            raise LLMError(f"OpenRouter completion error: {exc}") from exc

    async def embed(self, text: str) -> list[float]:
        """Not supported — OpenRouter does not provide an embedding API.

        Raises:
            NotImplementedError: Always.
        """
        raise NotImplementedError(
            "OpenRouter does not support embeddings. "
            "Use GeminiProvider or LlamaProvider for embedding generation."
        )

    async def classify(self, text: str, categories: list[str]) -> str:
        """Classify text into one of the given categories via structured output.

        Uses a single-turn prompt that instructs the model to respond with
        exactly one of the listed category labels.

        Returns:
            The winning category label as a plain string.

        Raises:
            LLMError: On API error, timeout, or unexpected response.
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
            max_tokens=50,
        )

        label = result["content"].strip().strip('"').strip("'")

        # Validate the response is one of the expected categories
        for cat in categories:
            if label.lower() == cat.lower():
                return cat

        logger.warning(
            "openrouter_classify_unexpected",
            label=label,
            categories=categories,
        )
        return label
