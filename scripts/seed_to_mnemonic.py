#!/usr/bin/env python3
"""Convert a 256-bit hex seed to a 24-word BIP-39 mnemonic.

Uses only Python stdlib — runs during install.sh before pip packages
are installed.

Usage:
    python3 scripts/seed_to_mnemonic.py <64-char-hex-seed>

Exit codes:
    0 = success (mnemonic printed to stdout)
    1 = invalid input
"""

from __future__ import annotations

import hashlib
import os
import sys


def entropy_to_mnemonic(entropy_hex: str) -> str:
    """BIP-39: 256-bit entropy -> 24-word mnemonic."""
    entropy = bytes.fromhex(entropy_hex)
    if len(entropy) != 32:
        raise ValueError(f"expected 32 bytes, got {len(entropy)}")

    # Load wordlist from file next to this script.
    wordlist_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bip39_english.txt")
    with open(wordlist_path) as f:
        words = [line.strip() for line in f if line.strip()]
    if len(words) != 2048:
        raise ValueError(f"wordlist has {len(words)} words, expected 2048")

    # Checksum: first 8 bits of SHA-256(entropy) for 256-bit entropy.
    checksum = hashlib.sha256(entropy).digest()
    checksum_bits = 8  # 256 / 32 = 8

    # Concatenate entropy bits + checksum bits.
    bits = bin(int.from_bytes(entropy, "big"))[2:].zfill(256)
    bits += bin(checksum[0])[2:].zfill(8)[:checksum_bits]

    # Split into 24 groups of 11 bits.
    mnemonic_words = []
    for i in range(0, len(bits), 11):
        index = int(bits[i:i + 11], 2)
        mnemonic_words.append(words[index])

    return " ".join(mnemonic_words)


def main() -> None:
    if len(sys.argv) != 2:
        print("Usage: seed_to_mnemonic.py <64-char-hex-seed>", file=sys.stderr)
        sys.exit(1)

    seed_hex = sys.argv[1].strip()
    if len(seed_hex) != 64:
        print(f"Error: expected 64 hex chars, got {len(seed_hex)}", file=sys.stderr)
        sys.exit(1)

    try:
        mnemonic = entropy_to_mnemonic(seed_hex)
        print(mnemonic)
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
