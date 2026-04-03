#!/usr/bin/env python3
"""One-time registration of test actors on the community PDS + real PLC.

Creates accounts on pds.dinakernel.com, which registers DIDs on
plc.directory. Stores results in tests/fixtures/test_actors.json.

Run ONCE. The fixture is committed to the repo and never changes.

Usage:
    python scripts/register_test_actors.py

Environment:
    PDS_URL     Override PDS (default: https://pds.dinakernel.com)
    PLC_URL     Override PLC (default: https://plc.directory)
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import httpx

PDS_URL = os.environ.get("PDS_URL", "https://pds.dinakernel.com")
PLC_URL = os.environ.get("PLC_URL", "https://plc.directory")
FIXTURE_PATH = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "test_actors.json"

ACTORS = [
    {
        "name": "alonso",
        "seed": "01" * 32,
        "handle": "alonso-test.pds.dinakernel.com",
        "email": "alonso-test@dina.local",
        "password": "dina-test-alonso-2026",
        "display_name": "Don Alonso",
        "core_port": 19100,
        "brain_port": 19200,
    },
    {
        "name": "sancho",
        "seed": "02" * 32,
        "handle": "sancho-test.pds.dinakernel.com",
        "email": "sancho-test@dina.local",
        "password": "dina-test-sancho-2026",
        "display_name": "Sancho",
        "core_port": 19300,
        "brain_port": 19400,
    },
    {
        "name": "chairmaker",
        "seed": "03" * 32,
        "handle": "chairmaker-test.pds.dinakernel.com",
        "email": "chairmaker-test@dina.local",
        "password": "dina-test-chairmaker-2026",
        "display_name": "ChairMaker",
        "core_port": 19500,
        "brain_port": 19600,
    },
    {
        "name": "albert",
        "seed": "04" * 32,
        "handle": "albert-test.pds.dinakernel.com",
        "email": "albert-test@dina.local",
        "password": "dina-test-albert-2026",
        "display_name": "Albert",
        "core_port": 19700,
        "brain_port": 19800,
    },
]


def create_or_login(actor: dict) -> str | None:
    """Create account on PDS or login if already exists. Returns DID."""
    handle = actor["handle"]
    email = actor["email"]
    password = actor["password"]

    # Try create
    r = httpx.post(
        f"{PDS_URL}/xrpc/com.atproto.server.createAccount",
        json={"email": email, "password": password, "handle": handle},
        timeout=30,
    )
    if r.status_code == 200:
        did = r.json().get("did", "")
        print(f"    Created: {did}")
        return did

    # Already exists — try login
    r2 = httpx.post(
        f"{PDS_URL}/xrpc/com.atproto.server.createSession",
        json={"identifier": email, "password": password},
        timeout=30,
    )
    if r2.status_code == 200:
        did = r2.json().get("did", "")
        print(f"    Logged in: {did}")
        return did

    print(f"    Failed: create={r.status_code} {r.text[:100]}")
    print(f"            login={r2.status_code} {r2.text[:100]}")
    return None


def verify_on_plc(did: str) -> bool:
    """Check DID exists on real PLC directory."""
    r = httpx.get(f"{PLC_URL}/{did}", timeout=10)
    return r.status_code == 200


def main() -> None:
    print(f"PDS: {PDS_URL}")
    print(f"PLC: {PLC_URL}")
    print()

    # Check PDS is reachable
    try:
        health = httpx.get(f"{PDS_URL}/xrpc/_health", timeout=10)
        print(f"PDS health: {health.status_code}")
    except Exception as e:
        print(f"ERROR: PDS not reachable: {e}")
        sys.exit(1)

    fixture = {
        "_comment": "Permanent test actor identities on real PLC. Do not edit.",
        "_pds_url": PDS_URL,
        "_plc_url": PLC_URL,
        "actors": {},
    }

    all_ok = True
    for actor in ACTORS:
        name = actor["name"]
        print(f"\n  {name} ({actor['handle']}):")

        did = create_or_login(actor)
        if not did:
            all_ok = False
            continue

        # Verify on real PLC
        if verify_on_plc(did):
            print(f"    PLC verified ✓")
        else:
            print(f"    WARNING: DID not found on PLC (may take a moment)")

        fixture["actors"][name] = {
            "did": did,
            "seed": actor["seed"],
            "handle": actor["handle"],
            "display_name": actor["display_name"],
            "core_port": actor["core_port"],
            "brain_port": actor["brain_port"],
        }

    if not all_ok:
        print("\nSome actors failed. Fix errors and retry.")
        sys.exit(1)

    FIXTURE_PATH.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE_PATH.write_text(json.dumps(fixture, indent=2) + "\n")
    print(f"\nSaved to {FIXTURE_PATH}")
    print("Commit this file — it never changes unless you re-register actors.")


if __name__ == "__main__":
    main()
