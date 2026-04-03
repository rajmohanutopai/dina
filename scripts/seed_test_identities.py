#!/usr/bin/env python3
"""Seed test actor identity state into Docker volumes.

Creates the persisted identity metadata that Core's RestoreDID() expects:
  - /data/vault/identity/did_metadata.json

Core rebuilds the DID document from metadata during RestoreDID().

Run AFTER containers are created but BEFORE Core starts reading identity.
Or run against stopped containers via volume mount.

Usage:
    # After docker compose create (containers exist, not started):
    python scripts/seed_test_identities.py

    # Or after stack is up (will need Core restart to pick up):
    python scripts/seed_test_identities.py
"""

from __future__ import annotations

import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

FIXTURE_PATH = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "test_actors.json"
COMPOSE_FILE = "docker-compose-test-stack.yml"
PROJECT = "dina-test"


def build_metadata(did: str, handle: str, pds_url: str) -> dict:
    """Build did_metadata.json — the only file Core needs for RestoreDID().

    Core rebuilds the DID document from metadata + current runtime config
    during RestoreDID(). We only seed the metadata, not the document.
    """
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {
        "did": did,
        "signing_key_path": "m/9999'/0'/0'",
        "signing_generation": 0,
        "rotation_key_path": "m/9999'/2'/0'",
        "plc_registered": True,
        "pds_url": pds_url,
        "handle": handle,
        "created_at": now,
    }


def _compose(*args) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["docker", "compose", "-p", PROJECT, "-f", COMPOSE_FILE] + list(args),
        capture_output=True, timeout=10,
    )


def read_existing_metadata(actor: str) -> dict | None:
    """Read did_metadata.json from a Docker volume via disposable container."""
    volume = f"{PROJECT}_{actor}-data"
    result = subprocess.run(
        ["docker", "run", "--rm", "-v", f"{volume}:/data",
         "alpine:3.19", "cat", "/data/vault/identity/did_metadata.json"],
        capture_output=True, timeout=10,
    )
    if result.returncode != 0:
        return None
    try:
        return json.loads(result.stdout)
    except (json.JSONDecodeError, ValueError):
        return None


def write_metadata(actor: str, metadata: dict) -> bool:
    """Write did_metadata.json into a Docker volume with correct ownership.

    Uses a disposable alpine container to write into the named volume
    as uid 10001 (dina user). Works regardless of whether the actor's
    Core container is running or stopped.
    """
    content = json.dumps(metadata, indent=2)
    volume = f"{PROJECT}_{actor}-data"

    # Run a one-shot container that mounts the volume and writes the file.
    # Pipe content via stdin to avoid shell quoting issues with JSON.
    # chown the entire /data tree so Core (uid 10001) can create identity.sqlite.
    result = subprocess.run(
        [
            "docker", "run", "--rm", "-i",
            "-v", f"{volume}:/data",
            "alpine:3.19",
            "sh", "-c",
            "mkdir -p /data/vault/identity && "
            "cat > /data/vault/identity/did_metadata.json && "
            "chown -R 10001:10001 /data",
        ],
        input=content.encode(),
        capture_output=True, timeout=15,
    )
    return result.returncode == 0


def main() -> None:
    if not FIXTURE_PATH.exists():
        print(f"ERROR: {FIXTURE_PATH} not found. Run register_test_actors.py first.")
        sys.exit(1)

    fixture = json.loads(FIXTURE_PATH.read_text())
    actors = fixture.get("actors", {})
    pds_url = fixture.get("_pds_url", "")

    print("Seeding test actor identities...")
    failed = False
    for name, actor in actors.items():
        did = actor["did"]
        handle = actor.get("handle", f"{name}.test")

        # Check if existing metadata matches ALL recovery-critical fields
        existing = read_existing_metadata(name)
        expected_meta = build_metadata(did, handle, pds_url)
        if (existing
                and existing.get("did") == expected_meta["did"]
                and existing.get("signing_key_path") == expected_meta["signing_key_path"]
                and existing.get("signing_generation") == expected_meta["signing_generation"]
                and existing.get("rotation_key_path") == expected_meta["rotation_key_path"]
                and existing.get("pds_url") == expected_meta["pds_url"]):
            print(f"  {name}: already correct ✓")
            continue

        if existing and existing.get("did") != did:
            print(f"  {name}: stale DID ({existing.get('did','?')[:20]}...) → replacing")

        # Write only did_metadata.json — Core rebuilds the DID doc during RestoreDID()
        metadata = build_metadata(did, handle, pds_url)
        ok = write_metadata(name, metadata)
        if ok:
            print(f"  {name}: {did[:30]}... seeded ✓")
        else:
            print(f"  {name}: {did[:30]}... FAILED ✗")
            failed = True

    if failed:
        print("ERROR: Some actors failed to seed. Stack may not work correctly.")
        sys.exit(1)


if __name__ == "__main__":
    main()
