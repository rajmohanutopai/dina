"""Local LLM adapter via llama.cpp OpenAI-compatible API.

Implements the LLMProvider protocol by calling the OpenAI-compatible
endpoints exposed by llama-server (``/v1/chat/completions`` and
``/v1/embeddings``).

This is the **only** provider where ``is_local == True``, meaning data
never leaves the Home Node and PII scrubbing is unnecessary.

Third-party imports:  httpx, structlog.
"""

from __future__ import annotations

import asyncio
from functools import cached_property
from typing import Any

import httpx
import structlog

from ..domain.errors import LLMError

logger = structlog.get_logger(__name__)

_TIMEOUT_S = 60.0


class LlamaProvider:
    """Implements LLMProvider via OpenAI-compatible API on llama server.

    Properties:
        model_name: Returns ``"llama-local"`` (or the model string reported
                    by the server in its response).
        is_local:   Always ``True`` — data never leaves the Home Node.
    """

    def __init__(
        self,
        base_url: str = "http://llama:8080",
        model_name: str = "llama-local",
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._model_name = model_name
        self._client: httpx.AsyncClient | None = None

    # -- Lifecycle -----------------------------------------------------------

    def _ensure_client(self) -> httpx.AsyncClient:
        """Lazily create the underlying httpx client."""
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                base_url=self._base_url,
                timeout=httpx.Timeout(_TIMEOUT_S),
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
        return self._model_name

    @cached_property
    def is_local(self) -> bool:
        """Llama runs on-device — always True. No PII scrubbing required."""
        return True

    # -- LLMProvider protocol ------------------------------------------------

    async def complete(self, messages: list[dict], **kwargs: Any) -> dict:
        """POST /v1/chat/completions — OpenAI-compatible chat completion.

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
            "messages": messages,
        }

        # Forward supported kwargs
        for key in ("temperature", "max_tokens", "top_p", "stop"):
            if key in kwargs:
                body[key] = kwargs[key]

        try:
            resp = await asyncio.wait_for(
                client.post("/v1/chat/completions", json=body),
                timeout=_TIMEOUT_S,
            )
            resp.raise_for_status()
            data = resp.json()

            # Parse OpenAI-compatible response format
            choices = data.get("choices", [])
            if not choices:
                raise LLMError("Llama returned empty choices array")

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
            model = data.get("model", self._model_name)

            return {
                "content": content,
                "model": model,
                "tokens_in": tokens_in,
                "tokens_out": tokens_out,
                "finish_reason": finish_reason,
            }

        except asyncio.TimeoutError:
            raise LLMError(
                f"Llama request timed out after {_TIMEOUT_S}s"
            )
        except httpx.ConnectError as exc:
            raise LLMError(
                f"Llama server unreachable at {self._base_url}: {exc}"
            ) from exc
        except httpx.HTTPStatusError as exc:
            raise LLMError(
                f"Llama server returned HTTP {exc.response.status_code}"
            ) from exc
        except LLMError:
            raise
        except Exception as exc:
            raise LLMError(f"Llama completion error: {exc}") from exc

    async def embed(self, text: str) -> list[float]:
        """POST /v1/embeddings — generate an embedding vector locally.

        Returns a list of floats (dimensions depend on the loaded model).

        Raises:
            LLMError: On connection failure, timeout, or unexpected response.
        """
        client = self._ensure_client()

        body = {
            "input": text,
        }

        try:
            resp = await asyncio.wait_for(
                client.post("/v1/embeddings", json=body),
                timeout=_TIMEOUT_S,
            )
            resp.raise_for_status()
            data = resp.json()

            embeddings = data.get("data", [])
            if not embeddings:
                raise LLMError("Llama returned empty embeddings array")

            return embeddings[0].get("embedding", [])

        except asyncio.TimeoutError:
            raise LLMError(
                f"Llama embed request timed out after {_TIMEOUT_S}s"
            )
        except httpx.ConnectError as exc:
            raise LLMError(
                f"Llama server unreachable at {self._base_url}: {exc}"
            ) from exc
        except httpx.HTTPStatusError as exc:
            raise LLMError(
                f"Llama embed returned HTTP {exc.response.status_code}: "
                f"{exc.response.text}"
            ) from exc
        except LLMError:
            raise
        except Exception as exc:
            raise LLMError(f"Llama embed error: {exc}") from exc

    async def classify(self, text: str, categories: list[str]) -> str:
        """Classify text using a structured output prompt.

        Uses a single-turn completion to instruct the local model to
        pick exactly one category from the provided list.

        Returns:
            The winning category label as a plain string.

        Raises:
            LLMError: On connection failure, timeout, or unexpected response.
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
            "llama_classify_unexpected",
            label=label,
            categories=categories,
        )
        return label
