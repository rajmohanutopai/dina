"""Port interface for LLM provider communication.

Matches Brain TEST_PLAN SS4 (LLM Router / LLM Client) and the contract
in ``brain/tests/contracts.py::LLMClient``.

Implementations (e.g. Ollama adapter, Gemini adapter, Claude adapter)
live in ``src/adapter/``.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable


@runtime_checkable
class LLMProvider(Protocol):
    """Async interface for a single LLM provider backend.

    Each concrete adapter wraps one provider (Ollama/Gemini/Claude) and
    exposes a uniform surface for completion, embedding, and classification.

    Properties ``model_name`` and ``is_local`` are used by the LLM router
    to make routing decisions (privacy tier, PII scrubbing requirements).
    """

    async def complete(self, messages: list[dict], **kwargs: object) -> dict:
        """Send a chat-completion request.

        Parameters:
            messages: List of ``{"role": ..., "content": ...}`` dicts.
                      Messages may also contain function call/response parts
                      for multi-turn tool-calling conversations.
            **kwargs: Provider-specific options (temperature, max_tokens, etc.).
                      Tool-calling kwargs (provider support varies):

                      - ``tools``: list of tool/function declarations.
                      - ``tool_config``: tool-calling configuration.

        Returns:
            A dict with at least ``content``, ``model``, ``tokens_in``,
            ``tokens_out``, and ``finish_reason`` keys.

            When the model requests a tool call instead of generating text,
            the dict includes ``tool_calls`` (list of dicts with ``name``
            and ``args`` keys) and ``content`` may be empty.
        """
        ...

    async def embed(self, text: str) -> list[float]:
        """Generate an embedding vector for the given text.

        Returns a list of floats (typically 768 or 1536 dimensions).
        """
        ...

    async def classify(self, text: str, categories: list[str]) -> str:
        """Classify *text* into one of the given *categories*.

        Used by the triage pipeline (Pass 2b) to batch-classify email
        subjects as ``INGEST`` or ``SKIP``.

        Returns the winning category label as a plain string.
        """
        ...

    @property
    def model_name(self) -> str:
        """Human-readable identifier for the underlying model.

        Examples: ``"llama-3.2-3b"``, ``"gemini-2.5-flash"``, ``"claude-sonnet-4"``
        """
        ...

    @property
    def is_local(self) -> bool:
        """``True`` when the model runs on-device (e.g. Ollama).

        Local models never require PII scrubbing because data does not
        leave the Home Node.
        """
        ...
