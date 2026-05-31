"""OpenAI LLM adapter — implements LLMProvider protocol.

Wraps the ``openai`` library's async Chat Completions API.
Embedding and classification are **not supported** directly and
raise ``NotImplementedError``.

Third-party imports:  openai, structlog.
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


class OpenAIProvider:
    """Implements LLMProvider via OpenAI Chat Completions API.

    Properties:
        model_name: The OpenAI model identifier (e.g. ``gpt-5.2``).
        is_local:   Always ``False`` — OpenAI is a cloud provider.
    """

    def __init__(
        self,
        api_key: str,
        model: str = "gpt-5.4",
        embed_model: str = "text-embedding-3-small",
    ) -> None:
        if not api_key:
            raise ConfigError(
                "OPENAI_API_KEY is required for OpenAIProvider"
            )
        self._api_key = api_key
        self._model = model
        self._embed_model = embed_model
        self._client: Any = None  # lazy import

    # -- Lazy library import -------------------------------------------------

    def _ensure_client(self) -> Any:
        """Import openai and create an AsyncOpenAI client on first use."""
        if self._client is None:
            try:
                import openai  # type: ignore[import-untyped]
            except ImportError as exc:
                raise ConfigError(
                    "openai package not installed. "
                    "Run: pip install openai"
                ) from exc
            self._client = openai.AsyncOpenAI(
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
        """OpenAI is a cloud provider — always False."""
        return False

    # -- LLMProvider protocol ------------------------------------------------

    async def complete(self, messages: list[dict], **kwargs: Any) -> dict:
        """Send a chat-completion request to OpenAI Chat Completions API.

        Parameters:
            messages: List of ``{"role": ..., "content": ...}`` dicts.
                      Roles ``"system"``, ``"user"``, ``"assistant"`` are
                      passed through directly.
            **kwargs: Forwarded to the API call.  Supports
                      ``temperature``, ``max_tokens``, ``top_p``.

        Returns:
            Dict with ``content``, ``model``, ``tokens_in``,
            ``tokens_out``, ``finish_reason``.

        Raises:
            LLMError: On API error, rate-limit, or timeout.
        """
        client = self._ensure_client()

        # Build request kwargs
        max_tokens = kwargs.pop("max_tokens", _DEFAULT_MAX_TOKENS)

        # Convert messages — handle tool_call / tool_response roles
        api_messages: list[dict[str, Any]] = []
        for m in messages:
            role = m.get("role", "user")
            if role == "tool_call":
                # Model requested function calls — reconstruct as assistant
                tool_calls_out = []
                for tc in m.get("tool_calls", []):
                    import json as _json
                    tool_calls_out.append({
                        "id": tc.get("id") or f"call_{tc['name']}",
                        "type": "function",
                        "function": {
                            "name": tc["name"],
                            "arguments": _json.dumps(tc.get("args", {})),
                        },
                    })
                api_messages.append({
                    "role": "assistant",
                    "content": None,
                    "tool_calls": tool_calls_out,
                })
            elif role == "tool_response":
                # Tool execution results — one message per tool response
                for tr in m.get("tool_responses", []):
                    import json as _json
                    api_messages.append({
                        "role": "tool",
                        "tool_call_id": tr.get("id") or f"call_{tr['name']}",
                        "content": _json.dumps(tr.get("response", {})),
                    })
            else:
                api_messages.append({
                    "role": role if role in ("system", "user", "assistant") else "user",
                    "content": m.get("content", ""),
                })

        req_kwargs: dict[str, Any] = {
            "model": self._model,
            "messages": api_messages,
            "max_completion_tokens": max_tokens,
        }

        # Tool declarations
        if "tools" in kwargs:
            req_kwargs["tools"] = self._convert_tools(kwargs["tools"])

        for key in ("temperature", "top_p"):
            if key in kwargs:
                req_kwargs[key] = kwargs[key]

        try:
            response = await asyncio.wait_for(
                client.chat.completions.create(**req_kwargs),
                timeout=_TIMEOUT_S,
            )

            # Extract content and tool calls
            content_text = ""
            tool_calls: list[dict[str, Any]] = []
            if response.choices:
                msg = response.choices[0].message
                content_text = msg.content or ""

                # Check for function calls
                if msg.tool_calls:
                    import json as _json
                    for tc in msg.tool_calls:
                        tool_calls.append({
                            "name": tc.function.name,
                            "args": _json.loads(tc.function.arguments) if tc.function.arguments else {},
                            "id": tc.id,
                        })

            # Token usage
            tokens_in = 0
            tokens_out = 0
            if response.usage:
                tokens_in = response.usage.prompt_tokens or 0
                tokens_out = response.usage.completion_tokens or 0

            # Finish reason
            finish_reason = "stop"
            if response.choices:
                finish_reason = response.choices[0].finish_reason or "stop"

            result: dict[str, Any] = {
                "content": content_text,
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
                f"OpenAI request timed out after {_TIMEOUT_S}s"
            )
        except Exception as exc:
            exc_str = str(exc).lower()
            if "429" in exc_str or "rate_limit" in exc_str:
                raise LLMError(
                    f"OpenAI rate limited (429): {exc}",
                ) from exc
            if "401" in exc_str or "authentication" in exc_str:
                raise ConfigError(
                    f"OpenAI authentication failed — check OPENAI_API_KEY: {exc}"
                ) from exc
            raise LLMError(f"OpenAI API error: {exc}") from exc

    @staticmethod
    def _convert_tools(tools: list) -> list[dict]:
        """Convert provider-agnostic tool dicts to OpenAI function format."""
        result = []
        for tool_def in tools:
            result.append({
                "type": "function",
                "function": {
                    "name": tool_def["name"],
                    "description": tool_def.get("description", ""),
                    "parameters": tool_def.get("parameters", {}),
                },
            })
        return result

    async def embed(self, text: str) -> list[float]:
        """Generate an embedding vector via OpenAI Embeddings API.

        Uses text-embedding-3-small by default (1536 dimensions).

        Raises:
            LLMError: On API error or timeout.
        """
        client = self._ensure_client()
        try:
            resp = await asyncio.wait_for(
                client.embeddings.create(
                    input=text,
                    model=self._embed_model,
                ),
                timeout=_TIMEOUT_S,
            )
            return list(resp.data[0].embedding)
        except asyncio.TimeoutError:
            raise LLMError(
                f"OpenAI embed request timed out after {_TIMEOUT_S}s"
            )
        except Exception as exc:
            raise LLMError(f"OpenAI embed error: {exc}") from exc

    async def classify(self, text: str, categories: list[str]) -> str:
        """Not supported — use complete() with a classification prompt.

        Raises:
            NotImplementedError: Always.
        """
        raise NotImplementedError(
            "OpenAI native classification not supported. "
            "Call complete() with a classification prompt instead."
        )
