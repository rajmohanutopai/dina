#!/usr/bin/env python3
"""Unwrap an AES-256-GCM + Argon2id wrapped master seed.

Verification / debugging tool — reads wrapped_seed.bin + master_seed.salt,
derives the KEK from the passphrase, and prints the original 256-bit hex seed.

Compatible with Go Core's crypto/keywrap.go + crypto/argon2.go.

Usage:
    python3 scripts/unwrap_seed.py <passphrase> <secrets-dir>

Reads:
    <secrets-dir>/wrapped_seed.bin      — 60 bytes (nonce || ciphertext || tag)
    <secrets-dir>/master_seed.salt    — 16 bytes

Output: 64-char hex seed to stdout.

Exit codes:
    0 = success
    1 = wrong passphrase, corrupted files, or missing files
"""

from __future__ import annotations

import os
import sys

# Argon2id parameters — must match core/internal/adapter/crypto/argon2.go
ARGON2_MEMORY_KIB = 128 * 1024
ARGON2_TIME_COST  = 3
ARGON2_PARALLELISM = 4
ARGON2_KEY_LEN    = 32


def unwrap_seed(passphrase: str, secrets_dir: str) -> str:
    """Read wrapped files, derive KEK, decrypt, return hex seed."""
    from argon2.low_level import hash_secret_raw, Type
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    wrapped_path = os.path.join(secrets_dir, "wrapped_seed.bin")
    salt_path = os.path.join(secrets_dir, "master_seed.salt")

    with open(wrapped_path, "rb") as f:
        wrapped = f.read()
    with open(salt_path, "rb") as f:
        salt = f.read()

    if len(wrapped) != 60:
        raise ValueError(f"wrapped_seed.bin must be 60 bytes, got {len(wrapped)}")
    if len(salt) != 16:
        raise ValueError(f"master_seed.salt must be 16 bytes, got {len(salt)}")

    # Derive KEK via Argon2id.
    kek = hash_secret_raw(
        secret=passphrase.encode("utf-8"),
        salt=salt,
        time_cost=ARGON2_TIME_COST,
        memory_cost=ARGON2_MEMORY_KIB,
        parallelism=ARGON2_PARALLELISM,
        hash_len=ARGON2_KEY_LEN,
        type=Type.ID,
    )

    # AES-256-GCM unwrap: nonce(12) || ciphertext+tag(48).
    nonce = wrapped[:12]
    ciphertext_and_tag = wrapped[12:]

    aesgcm = AESGCM(kek)
    try:
        seed = aesgcm.decrypt(nonce, ciphertext_and_tag, None)
    except Exception:
        raise ValueError("decryption failed — wrong passphrase or corrupted data")

    if len(seed) != 32:
        raise ValueError(f"decrypted seed must be 32 bytes, got {len(seed)}")

    return seed.hex()


def main() -> None:
    if len(sys.argv) != 3:
        print("Usage: unwrap_seed.py <passphrase> <secrets-dir>", file=sys.stderr)
        sys.exit(1)

    passphrase = sys.argv[1]
    secrets_dir = sys.argv[2]

    try:
        seed_hex = unwrap_seed(passphrase, secrets_dir)
        print(seed_hex)
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
