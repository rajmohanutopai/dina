#!/usr/bin/env python3
"""Convert a 24-word BIP-39 mnemonic back to a 256-bit hex seed.

Uses the official Trezor python-mnemonic reference implementation.
Validates word count, wordlist membership, and checksum.

Usage:
    python3 scripts/mnemonic_to_seed.py "word1 word2 ... word24"

Exit codes:
    0 = success (64-char hex seed printed to stdout)
    1 = invalid mnemonic
"""

from __future__ import annotations

import sys

from mnemonic import Mnemonic


def mnemonic_to_entropy(mnemonic_str: str) -> str:
    """BIP-39: 24-word mnemonic -> 256-bit entropy hex string."""
    m = Mnemonic("english")
    words = mnemonic_str.strip()

    if not m.check(words):
        raise ValueError("invalid mnemonic — checksum failed or unknown words")

    word_list = words.split()
    if len(word_list) != 24:
        raise ValueError(f"expected 24 words, got {len(word_list)}")

    entropy = m.to_entropy(words)
    return bytes(entropy).hex()


def main() -> None:
    if len(sys.argv) != 2:
        print('Usage: mnemonic_to_seed.py "word1 word2 ... word24"', file=sys.stderr)
        sys.exit(1)

    try:
        seed_hex = mnemonic_to_entropy(sys.argv[1])
        print(seed_hex)
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
