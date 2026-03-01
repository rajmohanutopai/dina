#!/usr/bin/env python3
"""Dina AppView — Post-installation validator.

Validates the AppView Docker stack (Postgres, Jetstream, Ingester, Scorer, Web)
by exercising each API endpoint and verifying database connectivity.

Usage:
    ./validate_appview.py                          # default ports
    ./validate_appview.py --web-port 3000           # custom AppView web port
    ./validate_appview.py --postgres-port 5433      # custom Postgres port

Checks:
    1. Postgres connectivity (pg_isready or TCP)
    2. AppView Web /health
    3. XRPC resolve — com.dina.trust.resolve
    4. XRPC search — com.dina.trust.search
    5. XRPC getProfile — com.dina.trust.getProfile
    6. XRPC getAttestations — com.dina.trust.getAttestations
    7. XRPC getGraph — com.dina.trust.getGraph

Exit code 0 = all checks pass, 1 = one or more failed.
"""

import argparse
import json
import os
import socket
import sys
import urllib.error
import urllib.request
import urllib.parse

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

WEB_PORT = int(os.environ.get("APPVIEW_WEB_PORT", os.environ.get("PORT", "3000")))
POSTGRES_PORT = int(os.environ.get("POSTGRES_HOST_PORT", "5433"))
JETSTREAM_PORT = int(os.environ.get("JETSTREAM_PORT", "6008"))
TIMEOUT = 10

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


def _request(
    url: str,
    *,
    method: str = "GET",
    data: dict | None = None,
) -> tuple[int, dict | str]:
    """Issue an HTTP request and return (status_code, body)."""
    body_bytes = json.dumps(data).encode() if data else None
    req = urllib.request.Request(url, data=body_bytes, method=method)
    req.add_header("Content-Type", "application/json")
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


def _tcp_check(host: str, port: int, timeout: float = 3.0) -> bool:
    """Check if a TCP port is open."""
    try:
        s = socket.create_connection((host, port), timeout=timeout)
        s.close()
        return True
    except (socket.timeout, ConnectionRefusedError, OSError):
        return False


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------

_failures: list[str] = []


def _check(name: str, passed: bool, detail: str = "") -> bool:
    if passed:
        ok(f"{name}" + (f"  {_c('2', detail)}" if detail else ""))
    else:
        fail(f"{name}" + (f"  {detail}" if detail else ""))
        _failures.append(name)
    return passed


def check_postgres(port: int) -> bool:
    reachable = _tcp_check("localhost", port)
    return _check("Postgres connectivity", reachable,
                   f"port={port}" if reachable else f"port={port} — connection refused")


def check_jetstream(port: int) -> bool:
    reachable = _tcp_check("localhost", port)
    return _check("Jetstream connectivity", reachable,
                   f"port={port}" if reachable else f"port={port} — connection refused")


def check_web_health(base: str) -> bool:
    status, body = _request(f"{base}/health")
    detail = ""
    if isinstance(body, dict):
        detail = body.get("status", "")
    return _check("AppView Web /health", status == 200 and detail == "ok", detail)


def check_xrpc_resolve(base: str) -> bool:
    """Test com.dina.trust.resolve with a synthetic DID."""
    subject = json.dumps({"type": "did", "did": "did:plc:test_validate"})
    params = urllib.parse.urlencode({"subject": subject})
    url = f"{base}/xrpc/com.dina.trust.resolve?{params}"
    status, body = _request(url)

    # Valid responses: 200 with trust data, or 200 with low confidence (no data yet)
    # A 400 "InvalidRequest" means the endpoint exists but params were wrong
    # A 404 is a routing error
    if status == 200:
        detail = ""
        if isinstance(body, dict):
            detail = f"trustLevel={body.get('trustLevel', '?')}, confidence={body.get('confidence', '?')}"
        return _check("XRPC resolve", True, detail)
    elif status == 400:
        # Endpoint exists, subject format may differ — still OK
        return _check("XRPC resolve", True, "endpoint reachable (no data for test DID)")
    else:
        return _check("XRPC resolve", False, f"status={status}")


def check_xrpc_search(base: str) -> bool:
    """Test com.dina.trust.search with an empty query."""
    params = urllib.parse.urlencode({"limit": "5"})
    url = f"{base}/xrpc/com.dina.trust.search?{params}"
    status, body = _request(url)

    if status == 200:
        result_count = 0
        if isinstance(body, dict):
            result_count = len(body.get("results", []))
        return _check("XRPC search", True, f"results={result_count}")
    else:
        return _check("XRPC search", False, f"status={status}")


def check_xrpc_get_profile(base: str) -> bool:
    """Test com.dina.trust.getProfile with a synthetic DID."""
    params = urllib.parse.urlencode({"did": "did:plc:test_validate"})
    url = f"{base}/xrpc/com.dina.trust.getProfile?{params}"
    status, body = _request(url)

    if status in (200, 404):
        # 200 = found, 404 = no data for this DID (both mean endpoint works)
        detail = "found" if status == 200 else "no data (expected for test DID)"
        return _check("XRPC getProfile", True, detail)
    else:
        return _check("XRPC getProfile", False, f"status={status}")


def check_xrpc_get_attestations(base: str) -> bool:
    """Test com.dina.trust.getAttestations."""
    params = urllib.parse.urlencode({"limit": "5"})
    url = f"{base}/xrpc/com.dina.trust.getAttestations?{params}"
    status, body = _request(url)

    if status == 200:
        count = 0
        if isinstance(body, dict):
            count = len(body.get("attestations", []))
        return _check("XRPC getAttestations", True, f"attestations={count}")
    else:
        return _check("XRPC getAttestations", False, f"status={status}")


def check_xrpc_get_graph(base: str) -> bool:
    """Test com.dina.trust.getGraph with a synthetic DID."""
    params = urllib.parse.urlencode({"did": "did:plc:test_validate", "maxDepth": "1"})
    url = f"{base}/xrpc/com.dina.trust.getGraph?{params}"
    status, body = _request(url)

    if status == 200:
        nodes = edges = 0
        if isinstance(body, dict):
            nodes = len(body.get("nodes", []))
            edges = len(body.get("edges", []))
        return _check("XRPC getGraph", True, f"nodes={nodes}, edges={edges}")
    elif status in (400, 404):
        # Endpoint works, just no data
        return _check("XRPC getGraph", True, "endpoint reachable (no data for test DID)")
    else:
        return _check("XRPC getGraph", False, f"status={status}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate Dina AppView installation")
    parser.add_argument("--web-port", type=int, default=WEB_PORT, help="AppView web port (default: 3000)")
    parser.add_argument("--postgres-port", type=int, default=POSTGRES_PORT, help="Postgres port (default: 5433)")
    parser.add_argument("--jetstream-port", type=int, default=JETSTREAM_PORT, help="Jetstream port (default: 6008)")
    args = parser.parse_args()

    base = f"http://localhost:{args.web_port}"

    print()
    print(_c("1", "Dina AppView — Post-Installation Validation"))
    print(_c("2", f"  Web: {base}   Postgres: localhost:{args.postgres_port}   Jetstream: localhost:{args.jetstream_port}"))
    print()

    # Infrastructure
    check_postgres(args.postgres_port)
    check_jetstream(args.jetstream_port)
    check_web_health(base)

    # XRPC endpoints
    check_xrpc_resolve(base)
    check_xrpc_search(base)
    check_xrpc_get_profile(base)
    check_xrpc_get_attestations(base)
    check_xrpc_get_graph(base)

    # Summary
    print()
    total = 8
    passed = total - len(_failures)
    if _failures:
        print(_c("0;31", f"  {passed}/{total} checks passed. Failures:"))
        for f in _failures:
            print(f"    - {f}")
        print()
        return 1
    else:
        print(_c("0;32", f"  All {total} checks passed. Your AppView is healthy."))
        print()
        return 0


if __name__ == "__main__":
    sys.exit(main())
