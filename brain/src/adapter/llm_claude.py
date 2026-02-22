"""Anthropic Claude LLM adapter — implements LLMProvider protocol.

Wraps the ``anthropic`` library's async Messages API for chat
completion.  Embedding and classification are **not supported** by
Claude and raise ``NotImplementedError``.

Third-party imports:  anthropic, structlog.
"""

from __future__ import annotations

import asyncio
from functools import cached_property
from typing import Any

import structlog

from ..domain.errors import ConfigError, LLMError

logger = structlog.get_logger(__name__)

_TIMEOUT_S = 60.0
_DEFAULT_MAX_TOKENS = 4096


class ClaudeProvider:
    """Implements LLMProvider via Anthropic Claude Messages API.

    Properties:
        model_name: The Claude model identifier (e.g. ``claude-sonnet-4-20250514``).
        is_local:   Always ``False`` — Claude is a cloud provider.
    """

    def __init__(
        self,
        api_key: str,
        model: str = "claude-sonnet-4-20250514",
    ) -> None:
        if not api_key:
            raise ConfigError(
                "ANTHROPIC_API_KEY is required for ClaudeProvider"
            )
        self._api_key = api_key
        self._model = model
        self._client: Any = None  # lazy import

    # -- Lazy library import -------------------------------------------------

    def _ensure_client(self) -> Any:
        """Import anthropic and create an AsyncAnthropic client on first use."""
        if self._client is None:
            try:
                import anthropic  # type: ignore[import-untyped]
            except ImportError as exc:
                raise ConfigError(
                    "anthropic package not installed. "
                    "Run: pip install anthropic"
                ) from exc
            self._client = anthropic.AsyncAnthropic(
                api_key=self._api_key,
                timeout=_TIMEOUT_S,
            )
        return self._client

    # -- Properties ----------------------------------------------------------

    @cached_property
    def model_name(self) -> str:
        """Human-readable model identifier."""
        return self._model

    @cached_property
    def is_local(self) -> bool:
        """Claude is a cloud provider — always False."""
        return False

    # -- LLMProvider protocol ------------------------------------------------

    async def complete(self, messages: list[dict], **kwargs: Any) -> dict:
        """Send a chat-completion request to Claude Messages API.

        Parameters:
            messages: List of ``{"role": ..., "content": ...}`` dicts.
                      The ``"system"`` role is extracted and passed as the
                      ``system`` parameter.  All other messages use
                      ``"user"`` or ``"assistant"`` roles.
            **kwargs: Forwarded to the API call.  Supports
                      ``temperature``, ``max_tokens``, ``top_p``.

        Returns:
            Dict with ``content``, ``model``, ``tokens_in``,
            ``tokens_out``, ``finish_reason``.

        Raises:
            LLMError: On API error, rate-limit, or timeout.
        """
        client = self._ensure_client()

        # Separate system prompt from conversation messages
        system_parts: list[str] = []
        api_messages: list[dict[str, str]] = []

        for msg in messages:
            role = msg.get("role", "user")
            content = msg.get("content", "")
            if role == "system":
                system_parts.append(content)
            elif role in ("user", "assistant"):
                api_messages.append({"role": role, "content": content})
            else:
                # Map unknown roles to user
                api_messages.append({"role": "user", "content": content})

        if not api_messages:
            raise LLMError("At least one user or assistant message is required")

        # Build request kwargs
        req_kwargs: dict[str, Any] = {
            "model": self._model,
            "messages": api_messages,
            "max_tokens": kwargs.pop("max_tokens", _DEFAULT_MAX_TOKENS),
        }

        if system_parts:
            req_kwargs["system"] = "\n\n".join(system_parts)

        for key in ("temperature", "top_p"):
            if key in kwargs:
                req_kwargs[key] = kwargs[key]

        try:
            response = await asyncio.wait_for(
                client.messages.create(**req_kwargs),
                timeout=_TIMEOUT_S,
            )

            # Extract content from response
            content_text = ""
            if response.content:
                content_text = "".join(
                    block.text
                    for block in response.content
                    if hasattr(block, "text")
                )

            # Token usage
            tokens_in = getattr(response.usage, "input_tokens", 0)
            tokens_out = getattr(response.usage, "output_tokens", 0)

            # Finish reason
            finish_reason = getattr(response, "stop_reason", "stop") or "stop"

            return {
                "content": content_text,
                "model": self._model,
                "tokens_in": tokens_in,
                "tokens_out": tokens_out,
                "finish_reason": finish_reason,
            }

        except asyncio.TimeoutError:
            raise LLMError(
                f"Claude request timed out after {_TIMEOUT_S}s"
            )
        except Exception as exc:
            exc_str = str(exc).lower()
            if "429" in exc_str or "rate_limit" in exc_str:
                raise LLMError(
                    f"Claude rate limited (429): {exc}",
                ) from exc
            if "401" in exc_str or "authentication" in exc_str:
                raise ConfigError(
                    f"Claude authentication failed — check ANTHROPIC_API_KEY: {exc}"
                ) from exc
            raise LLMError(f"Claude API error: {exc}") from exc

    async def embed(self, text: str) -> list[float]:
        """Not supported — Claude does not provide an embedding API.

        Raises:
            NotImplementedError: Always.
        """
        raise NotImplementedError(
            "Claude does not support embeddings. "
            "Use GeminiProvider or LlamaProvider for embedding generation."
        )

    async def classify(self, text: str, categories: list[str]) -> str:
        """Not supported — Claude does not provide a native classification API.

        Raises:
            NotImplementedError: Always.
        """
        raise NotImplementedError(
            "Claude does not support native classification. "
            "Use GeminiProvider or LlamaProvider, or call complete() with "
            "a classification prompt."
        )
