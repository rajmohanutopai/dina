#!/usr/bin/env python3
"""Convert a 256-bit hex seed to a 24-word BIP-39 mnemonic.

Uses the official Trezor python-mnemonic reference implementation.

Usage:
    python3 scripts/seed_to_mnemonic.py <64-char-hex-seed>

Exit codes:
    0 = success (mnemonic printed to stdout)
    1 = invalid input
"""

from __future__ import annotations

import sys

from mnemonic import Mnemonic


def entropy_to_mnemonic(entropy_hex: str) -> str:
    """BIP-39: 256-bit entropy -> 24-word mnemonic."""
    entropy = bytes.fromhex(entropy_hex)
    if len(entropy) != 32:
        raise ValueError(f"expected 32 bytes, got {len(entropy)}")
    m = Mnemonic("english")
    return m.to_mnemonic(entropy)


def main() -> None:
    if len(sys.argv) != 2:
        print("Usage: seed_to_mnemonic.py <64-char-hex-seed>", file=sys.stderr)
        sys.exit(1)

    seed_hex = sys.argv[1].strip()
    if len(seed_hex) != 64:
        print(f"Error: expected 64 hex chars, got {len(seed_hex)}", file=sys.stderr)
        sys.exit(1)

    try:
        words = entropy_to_mnemonic(seed_hex)
        print(words)
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
