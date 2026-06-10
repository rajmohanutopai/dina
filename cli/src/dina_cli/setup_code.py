"""Agent setup code — parse the one-paste `dina1:` pairing payload.

The Dina app (Settings → Agents) bundles everything `dina configure`
used to prompt for into one shareable string:

    dina1:<base64url(JSON, no padding)>

    {
      "v": 1,
      "msgbox_url":  "wss://.../ws",
      "homenode_did": "did:plc:...",
      "transport":   "msgbox",
      "device_name": "my-agent",
      "code":        "ABCDEFGH"      # pairing code — the only secret
    }

The TypeScript builder lives in
``apps/mobile/src/services/agent_setup_code.ts``; both sides pin the same
cross-language test vector. The embedded pairing code keeps the ceremony's
protections (5-min TTL, single-use, burn-after-3-failures), so a stale
pasted string fails loudly at the pairing step rather than silently.
"""

from __future__ import annotations

import base64
import binascii
import json
from dataclasses import dataclass

SETUP_CODE_PREFIX = "dina1:"

_VALID_TRANSPORTS = ("direct", "msgbox", "auto")


class SetupCodeError(ValueError):
    """Raised when a pasted setup code is malformed or incomplete."""


@dataclass(frozen=True)
class SetupCode:
    msgbox_url: str
    homenode_did: str
    code: str
    device_name: str
    transport: str


def looks_like_setup_code(raw: str) -> bool:
    """Cheap sniff so the interactive prompt can tell a pasted setup code
    from a manually-typed value without attempting a full parse."""
    return raw.strip().startswith(SETUP_CODE_PREFIX)


def parse_setup_code(raw: str) -> SetupCode:
    """Decode + validate a `dina1:` setup string.

    Raises :class:`SetupCodeError` with a user-readable message on any
    malformation — the caller surfaces it and falls back to manual entry.
    """
    stripped = raw.strip()
    if not stripped.startswith(SETUP_CODE_PREFIX):
        raise SetupCodeError("not a setup code (expected it to start with 'dina1:')")
    b64 = stripped[len(SETUP_CODE_PREFIX):].strip()
    if b64 == "":
        raise SetupCodeError("setup code is empty after the 'dina1:' prefix")

    # base64url without padding — restore padding for the stdlib decoder.
    pad = "=" * (-len(b64) % 4)
    try:
        decoded = base64.urlsafe_b64decode(b64 + pad)
    except (binascii.Error, ValueError) as exc:
        raise SetupCodeError(f"setup code is not valid base64url: {exc}") from exc

    try:
        payload = json.loads(decoded.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SetupCodeError("setup code payload is not valid JSON") from exc
    if not isinstance(payload, dict):
        raise SetupCodeError("setup code payload must be a JSON object")

    version = payload.get("v")
    if version != 1:
        raise SetupCodeError(
            f"unsupported setup code version {version!r} — "
            "update dina-agent (pip install -U dina-agent) and retry"
        )

    msgbox_url = _required_str(payload, "msgbox_url")
    if not msgbox_url.startswith(("ws://", "wss://")):
        raise SetupCodeError("msgbox_url must be a ws:// or wss:// URL")
    homenode_did = _required_str(payload, "homenode_did")
    if not homenode_did.startswith("did:"):
        raise SetupCodeError("homenode_did must be a DID (did:...)")
    code = _required_str(payload, "code")

    device_name = payload.get("device_name")
    device_name = device_name.strip() if isinstance(device_name, str) else ""

    transport = payload.get("transport")
    transport = transport.strip() if isinstance(transport, str) else ""
    if transport == "":
        transport = "msgbox"
    if transport not in _VALID_TRANSPORTS:
        raise SetupCodeError(
            f"unknown transport {transport!r} (expected one of {', '.join(_VALID_TRANSPORTS)})"
        )

    return SetupCode(
        msgbox_url=msgbox_url,
        homenode_did=homenode_did,
        code=code,
        device_name=device_name,
        transport=transport,
    )


def _required_str(payload: dict, key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or value.strip() == "":
        raise SetupCodeError(f"setup code is missing '{key}'")
    return value.strip()
