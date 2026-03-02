#!/usr/bin/env python3
"""Validate an LLM API key by sending a tiny completion request.

Uses the same Brain provider classes that the application uses at runtime.
If this works, the key will work in production.  If this fails, it would
have failed in production too.

Usage:
    python scripts/validate_key.py GEMINI_API_KEY AIzaSy...
    python scripts/validate_key.py OPENAI_API_KEY sk-...
    python scripts/validate_key.py ANTHROPIC_API_KEY sk-ant-...
    python scripts/validate_key.py OPENROUTER_API_KEY sk-or-...
    python scripts/validate_key.py OLLAMA_BASE_URL http://localhost:11434

Exit codes:
    0 = key is valid (completion succeeded)
    1 = key is invalid or provider unreachable
"""

from __future__ import annotations

import asyncio
import os
import sys

# Ensure the project root is on the import path so `brain.src.*` resolves.
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)


async def validate(key_name: str, key_value: str) -> bool:
    """Fire a 1-token completion through the real provider class."""
    messages = [{"role": "user", "content": "Reply with just the word: ok"}]
    kwargs = {"max_tokens": 4, "temperature": 0}

    try:
        if key_name in ("GEMINI_API_KEY", "GOOGLE_API_KEY"):
            from brain.src.adapter.llm_gemini import GeminiProvider
            provider = GeminiProvider(key_value)
        elif key_name == "OPENAI_API_KEY":
            from brain.src.adapter.llm_openai import OpenAIProvider
            provider = OpenAIProvider(key_value)
        elif key_name == "ANTHROPIC_API_KEY":
            from brain.src.adapter.llm_claude import ClaudeProvider
            provider = ClaudeProvider(key_value)
        elif key_name == "OPENROUTER_API_KEY":
            from brain.src.adapter.llm_openrouter import OpenRouterProvider
            provider = OpenRouterProvider(key_value)
        elif key_name == "OLLAMA_BASE_URL":
            from brain.src.adapter.llm_llama import LlamaProvider
            provider = LlamaProvider(key_value)
        else:
            print(f"Unknown key type: {key_name}", file=sys.stderr)
            return False

        result = await provider.complete(messages, **kwargs)
        content = result.get("content", "")
        return len(content) > 0

    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return False


def main() -> None:
    if len(sys.argv) != 3:
        print("Usage: validate_key.py KEY_NAME KEY_VALUE", file=sys.stderr)
        sys.exit(1)

    key_name, key_value = sys.argv[1], sys.argv[2]
    ok = asyncio.run(validate(key_name, key_value))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
