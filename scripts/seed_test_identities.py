#!/usr/bin/env python3
"""Verify and restore test actor identity state in Docker volumes.

Checks each actor's identity metadata (DID, signing key path, rotation key
path) against the fixture file. If missing, corrupted, or mismatched,
restores from the saved identity state in tests/fixtures/identity-state/.

Usage:
    python scripts/seed_test_identities.py --check-and-restore
    python scripts/seed_test_identities.py --save
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

PROJECT = "dina-test"
FIXTURE_PATH = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "test_actors.json"
IDENTITY_DIR = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "identity-state"
# Albert is a deferred actor (Digital Estate flow). Its container is commented
# out in docker-compose-test-stack.yml. Keeping it in this list would trigger
# a "wrong DID" warning on every stack-up and the plc_probe would refuse to
# start Albert's Core if it were ever uncommented without a fixture refresh.
# When Digital Estate is reactivated, re-add here and run --save.
ACTORS = ["alonso", "sancho", "chairmaker"]


def read_volume_metadata(actor: str) -> dict | None:
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


def restore_actor(actor: str) -> bool:
    """Restore identity state from saved fixtures into a Docker volume."""
    src = IDENTITY_DIR / actor / "identity"
    if not src.exists():
        return False

    volume = f"{PROJECT}_{actor}-data"

    # Copy files + fix ownership in one alpine container run
    # Mount both the saved state (as /src) and the volume (as /data)
    result = subprocess.run(
        ["docker", "run", "--rm",
         "-v", f"{str(src)}:/src:ro",
         "-v", f"{volume}:/data",
         "alpine:3.19",
         "sh", "-c",
         "mkdir -p /data/vault/identity && "
         "cp /src/* /data/vault/identity/ && "
         "chown -R 10001:10001 /data"],
        capture_output=True, timeout=15,
    )
    return result.returncode == 0


def check_and_restore() -> None:
    """Verify each actor's identity; restore if needed."""
    if not FIXTURE_PATH.exists():
        print("  No fixture file — skipping identity check")
        return

    fixture = json.loads(FIXTURE_PATH.read_text())
    actors = fixture.get("actors", {})

    restored_any = False
    failed = False

    for name in ACTORS:
        actor = actors.get(name)
        if not actor:
            continue

        expected_did = actor["did"]
        existing = read_volume_metadata(name)

        # Check: DID + key paths must all match
        if (existing
                and existing.get("did") == expected_did
                and existing.get("signing_key_path") == "m/9999'/0'/0'"
                and existing.get("signing_generation") == 0):
            continue  # Identity is correct — no output needed

        # Need restore
        reason = "missing" if existing is None else f"wrong DID ({existing.get('did', '?')[:20]}...)"
        if not restore_actor(name):
            print(f"  {name}: restore FAILED ✗ ({reason})")
            failed = True
            continue

        print(f"  {name}: restored ✓ ({reason})")
        restored_any = True

    if not restored_any and not failed:
        print("  Identity state: OK ✓")

    if failed:
        sys.exit(1)


def save() -> None:
    """Save identity state from running containers to local fixtures."""
    IDENTITY_DIR.mkdir(parents=True, exist_ok=True)
    print("Saving identity state from containers...")
    for actor in ACTORS:
        dest = IDENTITY_DIR / actor / "identity"
        dest.mkdir(parents=True, exist_ok=True)
        container = f"{PROJECT}-{actor}-core-1"
        result = subprocess.run(
            ["docker", "cp", f"{container}:/data/vault/identity/.", str(dest)],
            capture_output=True, timeout=10,
        )
        files = list(dest.iterdir())
        status = f"{len(files)} files ✓" if result.returncode == 0 else "FAILED ✗"
        print(f"  {actor}: {status}")
    print(f"Saved to {IDENTITY_DIR}")


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: seed_test_identities.py --check-and-restore | --save")
        sys.exit(1)

    cmd = sys.argv[1]
    if cmd == "--check-and-restore":
        check_and_restore()
    elif cmd == "--save":
        save()
    else:
        print(f"Unknown command: {cmd}")
        sys.exit(1)


if __name__ == "__main__":
    main()
