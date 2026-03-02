#!/usr/bin/env python3
"""Validate an LLM API key by sending a tiny completion request.

Uses only Python stdlib (urllib) — no pip packages required.  This runs
during install.sh on a fresh machine before any dependencies are installed.

Sends a real 1-token completion so we know the key has actual quota,
not just that it exists.

Usage:
    python3 scripts/validate_key.py GEMINI_API_KEY AIzaSy...
    python3 scripts/validate_key.py OPENAI_API_KEY sk-...
    python3 scripts/validate_key.py ANTHROPIC_API_KEY sk-ant-...
    python3 scripts/validate_key.py OPENROUTER_API_KEY sk-or-...
    python3 scripts/validate_key.py OLLAMA_BASE_URL http://localhost:11434

Exit codes:
    0 = key is valid (completion succeeded)
    1 = key is invalid or provider unreachable
"""

from __future__ import annotations

import json
import sys
import urllib.request
import urllib.error

_TIMEOUT = 15


def _post(url: str, body: dict, headers: dict) -> dict:
    """POST JSON and return parsed response."""
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
        return json.loads(resp.read())


def _get(url: str, headers: dict | None = None) -> int:
    """GET and return HTTP status code."""
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
        return resp.status


def validate(key_name: str, key_value: str) -> bool:
    """Send a real completion request using only stdlib."""
    try:
        if key_name in ("GEMINI_API_KEY", "GOOGLE_API_KEY"):
            # Use gemini-2.5-flash (widely available). A successful HTTP 200
            # with candidates proves the key works, even if content is empty
            # due to maxOutputTokens.
            url = (
                f"https://generativelanguage.googleapis.com/v1beta/"
                f"models/gemini-2.5-flash:generateContent?key={key_value}"
            )
            body = {"contents": [{"parts": [{"text": "Reply: ok"}]}],
                    "generationConfig": {"maxOutputTokens": 4}}
            resp = _post(url, body, {"Content-Type": "application/json"})
            return "candidates" in resp

        elif key_name == "OPENAI_API_KEY":
            url = "https://api.openai.com/v1/chat/completions"
            body = {"model": "gpt-4.1-nano", "messages": [{"role": "user", "content": "Reply: ok"}],
                    "max_tokens": 4}
            resp = _post(url, body, {
                "Content-Type": "application/json",
                "Authorization": f"Bearer {key_value}",
            })
            return len(resp.get("choices", [{}])[0].get("message", {}).get("content", "")) > 0

        elif key_name == "ANTHROPIC_API_KEY":
            url = "https://api.anthropic.com/v1/messages"
            body = {"model": "claude-haiku-4-5-20251001", "max_tokens": 4,
                    "messages": [{"role": "user", "content": "Reply: ok"}]}
            resp = _post(url, body, {
                "Content-Type": "application/json",
                "x-api-key": key_value,
                "anthropic-version": "2023-06-01",
            })
            return len(resp.get("content", [{}])[0].get("text", "")) > 0

        elif key_name == "OPENROUTER_API_KEY":
            url = "https://openrouter.ai/api/v1/chat/completions"
            body = {"model": "google/gemini-2.0-flash-001", "messages": [{"role": "user", "content": "Reply: ok"}],
                    "max_tokens": 4}
            resp = _post(url, body, {
                "Content-Type": "application/json",
                "Authorization": f"Bearer {key_value}",
            })
            return len(resp.get("choices", [{}])[0].get("message", {}).get("content", "")) > 0

        elif key_name == "OLLAMA_BASE_URL":
            return _get(f"{key_value}/api/tags") == 200

        else:
            print(f"Unknown key type: {key_name}", file=sys.stderr)
            return False

    except urllib.error.HTTPError as exc:
        print(f"HTTP {exc.code}: {exc.reason}", file=sys.stderr)
        return False
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return False


def main() -> None:
    if len(sys.argv) != 3:
        print("Usage: validate_key.py KEY_NAME KEY_VALUE", file=sys.stderr)
        sys.exit(1)

    key_name, key_value = sys.argv[1], sys.argv[2]
    ok = validate(key_name, key_value)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
