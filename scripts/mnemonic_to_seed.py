#!/usr/bin/env python3
"""Convert a 24-word BIP-39 mnemonic back to a 256-bit hex seed.

Uses only Python stdlib — runs during install.sh before pip packages
are installed.  Validates word count, wordlist membership, and checksum.

Usage:
    python3 scripts/mnemonic_to_seed.py "word1 word2 ... word24"

Exit codes:
    0 = success (64-char hex seed printed to stdout)
    1 = invalid mnemonic
"""

from __future__ import annotations

import hashlib
import os
import sys


def _load_wordlist() -> list[str]:
    """Load the BIP-39 English wordlist."""
    wordlist_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bip39_english.txt")
    with open(wordlist_path) as f:
        words = [line.strip() for line in f if line.strip()]
    if len(words) != 2048:
        raise ValueError(f"wordlist has {len(words)} words, expected 2048")
    return words


def mnemonic_to_entropy(mnemonic: str) -> str:
    """BIP-39: 24-word mnemonic -> 256-bit entropy hex string."""
    wordlist = _load_wordlist()
    word_index = {w: i for i, w in enumerate(wordlist)}

    words = mnemonic.strip().lower().split()
    if len(words) != 24:
        raise ValueError(f"expected 24 words, got {len(words)}")

    # Look up each word's 11-bit index.
    bits = ""
    for w in words:
        if w not in word_index:
            raise ValueError(f"unknown word: {w!r}")
        bits += bin(word_index[w])[2:].zfill(11)

    # 24 words × 11 bits = 264 bits = 256 entropy + 8 checksum.
    entropy_bits = bits[:256]
    checksum_bits = bits[256:]

    # Convert entropy bits back to bytes.
    entropy = int(entropy_bits, 2).to_bytes(32, "big")

    # Verify checksum: first 8 bits of SHA-256(entropy).
    expected_checksum = bin(hashlib.sha256(entropy).digest()[0])[2:].zfill(8)
    if checksum_bits != expected_checksum:
        raise ValueError("invalid checksum — mnemonic may be corrupted or misspelled")

    return entropy.hex()


def main() -> None:
    if len(sys.argv) != 2:
        print("Usage: mnemonic_to_seed.py \"word1 word2 ... word24\"", file=sys.stderr)
        sys.exit(1)

    try:
        seed_hex = mnemonic_to_entropy(sys.argv[1])
        print(seed_hex)
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
