#!/usr/bin/env python3
"""Synchronize self-contained runtime files into each coding-agent plugin."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "cli" / "agent-plugin-runtime"
TARGETS = (
    ROOT / "cli" / "claude-plugin" / "dina" / "bin",
    ROOT / "cli" / "codex-plugin" / "plugins" / "dina" / "bin",
)
FILES = (
    "dina-bootstrap-authorize",
    "dina-cli",
    "dina-setup-bootstrap",
)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()

    stale: list[str] = []
    for target in TARGETS:
        target.mkdir(parents=True, exist_ok=True)
        for name in FILES:
            source = SOURCE / name
            destination = target / name
            payload = source.read_bytes()
            if args.check:
                if not destination.is_file() or destination.read_bytes() != payload:
                    stale.append(str(destination.relative_to(ROOT)))
                continue
            destination.write_bytes(payload)
            os.chmod(destination, 0o755)
    if stale:
        print(
            "Agent plugin runtime copies are stale:\n  " + "\n  ".join(stale),
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
