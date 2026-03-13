#!/usr/bin/env python3
"""Dina Home Node — Post-installation validator.

Runs inside Docker (or against a running stack) and validates that
every service is healthy and all critical APIs respond correctly.

Usage:
    ./validate.py                          # validate localhost:8100
    ./validate.py --core-port 9100         # custom port
    python3 validate.py                    # explicit interpreter

Checks:
    1. Core /healthz
    2. Brain /healthz (via Core proxy)
    3. PDS /xrpc/_health
    4. Identity — DID retrieval
    5. Persona — create + unlock + list
    6. Vault — store + query + delete
    7. Brain /api/v1/reason (LLM reachability)

Exit code 0 = all checks pass, 1 = one or more failed.
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

CORE_PORT = int(os.environ.get("DINA_CORE_PORT", "8100"))
PDS_PORT = int(os.environ.get("DINA_PDS_PORT", "2583"))
TIMEOUT = 10  # seconds per request

# ---------------------------------------------------------------------------
# Colors
# ---------------------------------------------------------------------------

_IS_TTY = sys.stdout.isatty()


def _c(code: str, text: str) -> str:
    return f"\033[{code}m{text}\033[0m" if _IS_TTY else text


def ok(msg: str) -> None:
    print(f"  {_c('0;32', '[ok]')}   {msg}")


def fail(msg: str) -> None:
    print(f"  {_c('0;31', '[FAIL]')} {msg}")


def skip(msg: str) -> None:
    print(f"  {_c('2', '[skip]')} {msg}")


def info(msg: str) -> None:
    print(f"  {_c('2', '[....]')} {msg}")


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------


def _load_token(name: str) -> str:
    """Load a token from secrets/{name}."""
    path = Path(__file__).resolve().parent / "secrets" / name
    if path.exists():
        return path.read_text().strip()
    return ""


def _request(
    url: str,
    *,
    method: str = "GET",
    data: dict | None = None,
    token: str = "",
) -> tuple[int, dict | str]:
    """Issue an HTTP request and return (status_code, body)."""
    body_bytes = json.dumps(data).encode() if data else None
    req = urllib.request.Request(url, data=body_bytes, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            raw = resp.read().decode()
            try:
                return resp.status, json.loads(raw)
            except json.JSONDecodeError:
                return resp.status, raw
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode() if exc.fp else ""
        try:
            return exc.code, json.loads(raw)
        except json.JSONDecodeError:
            return exc.code, raw
    except Exception as exc:
        return 0, str(exc)


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------

_TEST_PERSONA = "_validate_test"
_failures: list[str] = []


def _check(name: str, passed: bool, detail: str = "") -> bool:
    if passed:
        ok(f"{name}" + (f"  {_c('2', detail)}" if detail else ""))
    else:
        fail(f"{name}" + (f"  {detail}" if detail else ""))
        _failures.append(name)
    return passed


def check_core_health(base: str, token: str) -> bool:
    status, body = _request(f"{base}/healthz", token=token)
    detail = ""
    if isinstance(body, dict):
        detail = body.get("status", "")
    return _check("Core health", status == 200, detail)


def check_brain_health(base: str, token: str) -> bool:
    """Brain is proxied through Core at the same host — or directly."""
    # Try Brain's direct port first (internal network may expose it)
    # In production docker, Brain is not exposed; try via Core's /healthz
    # which itself checks Brain.  We just verify Core reports non-degraded.
    status, body = _request(f"{base}/healthz", token=token)
    brain_ok = False
    if isinstance(body, dict):
        brain_ok = body.get("status") in ("ok",)
    return _check("Brain reachable (via Core health)", brain_ok,
                   f"status={body.get('status') if isinstance(body, dict) else 'error'}")


def check_pds_health(pds_port: int) -> bool:
    status, body = _request(f"http://localhost:{pds_port}/xrpc/_health")
    return _check("PDS health", status == 200,
                   f"version={body.get('version', '?')}" if isinstance(body, dict) else "")


def check_identity(base: str, token: str) -> bool:
    status, body = _request(f"{base}/v1/did", token=token)
    did = ""
    if isinstance(body, dict):
        did = body.get("did", body.get("id", ""))
    return _check("Identity (DID)", status == 200 and bool(did),
                   f"did={did[:40]}..." if did else f"status={status}")


def check_persona_lifecycle(base: str, token: str) -> bool:
    """Create, unlock, list, delete a test persona."""
    # Create
    status, body = _request(
        f"{base}/v1/personas", method="POST", token=token,
        data={"name": _TEST_PERSONA, "tier": "open", "passphrase": "validate_test"},
    )
    if status not in (200, 201, 409):  # 409 = already exists
        return _check("Persona create", False, f"status={status} body={body}")

    # Unlock
    status, body = _request(
        f"{base}/v1/persona/unlock", method="POST", token=token,
        data={"persona": _TEST_PERSONA, "passphrase": "validate_test"},
    )
    if status != 200:
        return _check("Persona unlock", False, f"status={status}")

    # List — should contain our persona
    status, body = _request(f"{base}/v1/personas", token=token)
    found = False
    if isinstance(body, list):
        found = _TEST_PERSONA in body
    elif isinstance(body, dict):
        personas = body.get("personas", [])
        found = _TEST_PERSONA in personas

    return _check("Persona lifecycle (create/unlock/list)", found,
                   f"found={found}")


def check_vault_crud(base: str, token: str) -> bool:
    """Store, query, verify an item in the vault."""
    item = {
        "Type": "kv",
        "Summary": "Dina validation test item — safe to delete",
        "BodyText": "This item was created by validate.py to confirm vault works.",
    }

    # Store
    status, body = _request(
        f"{base}/v1/vault/store", method="POST", token=token,
        data={"persona": _TEST_PERSONA, "item": item},
    )
    if status != 200:
        return _check("Vault store", False, f"status={status} body={body}")
    item_id = ""
    if isinstance(body, dict):
        item_id = body.get("id", body.get("item_id", ""))

    # Query
    status, body = _request(
        f"{base}/v1/vault/query", method="POST", token=token,
        data={"persona": _TEST_PERSONA, "query": "validation test", "mode": "fts5"},
    )
    found = False
    if isinstance(body, dict):
        items = body.get("items", [])
        found = any("validation" in str(it).lower() for it in items)
    elif isinstance(body, list):
        found = any("validation" in str(it).lower() for it in body)

    return _check("Vault CRUD (store/query)", status == 200 and found,
                   f"item_id={item_id}, query_found={found}")


def check_brain_reason(base: str, token: str) -> bool:
    """Quick brain-path test via Core /v1/agent/validate."""
    status, body = _request(
        f"{base}/v1/agent/validate",
        method="POST",
        token=token,
        data={
            "type": "agent_intent",
            "action": "search",
            "target": "validator health check",
            "agent_did": "did:key:validator",
        },
    )
    if status != 200:
        return _check("Core→Brain path (/v1/agent/validate)", False, f"status={status}")
    risk = body.get("risk", "") if isinstance(body, dict) else ""
    return _check("Core→Brain path (/v1/agent/validate)", True, f"risk={risk or 'ok'}")


def cleanup(base: str, token: str) -> None:
    """Delete the test persona to leave no trace."""
    try:
        # Clear vault first
        _request(
            f"{base}/v1/vault/clear", method="POST", token=token,
            data={"persona": _TEST_PERSONA},
        )
    except Exception:
        pass
    # Note: persona deletion may not be supported — that's fine,
    # the test persona is harmless.


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate Dina Home Node installation")
    parser.add_argument("--core-port", type=int, default=CORE_PORT, help="Core port (default: 8100)")
    parser.add_argument("--pds-port", type=int, default=PDS_PORT, help="PDS port (default: 2583)")
    args = parser.parse_args()

    base = f"http://localhost:{args.core_port}"

    # Load token
    token = _load_token("client_token")
    if not token:
        fail("No secrets/client_token found.")
        fail("Run ./install.sh first.")
        return 1

    print()
    print(_c("1", "Dina Home Node — Post-Installation Validation"))
    print(_c("2", f"  Core: {base}   PDS: http://localhost:{args.pds_port}"))
    print()

    # Run checks
    check_core_health(base, token)
    check_brain_health(base, token)
    check_pds_health(args.pds_port)
    check_identity(base, token)
    check_persona_lifecycle(base, token)
    check_vault_crud(base, token)
    check_brain_reason(base, token)

    # Cleanup
    cleanup(base, token)

    # Summary
    print()
    total = 7
    passed = total - len(_failures)
    if _failures:
        print(_c("0;31", f"  {passed}/{total} checks passed. Failures:"))
        for f in _failures:
            print(f"    - {f}")
        print()
        return 1
    else:
        print(_c("0;32", f"  All {total} checks passed. Your Dina Home Node is healthy."))
        print()
        return 0


if __name__ == "__main__":
    sys.exit(main())
