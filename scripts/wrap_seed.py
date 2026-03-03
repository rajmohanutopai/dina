#!/usr/bin/env python3
"""Wrap a 256-bit identity seed with Argon2id + AES-256-GCM.

Produces output byte-identical to Go Core's crypto/keywrap.go + crypto/argon2.go:
  - Argon2id: memory=128 MB, time=3, parallelism=4, keyLen=32, saltLen=16
  - AES-256-GCM: nonce(12) || ciphertext(32) || GCM-tag(16) = 60 bytes

Dependencies: argon2-cffi, cryptography (installed in .install-venv/).

Usage:
    python3 scripts/wrap_seed.py <64-char-hex-seed> <passphrase> <output-dir>

Output files (raw binary, permissions 0600):
    <output-dir>/wrapped_seed.bin      — 60 bytes
    <output-dir>/identity_seed.salt    — 16 bytes

Exit codes:
    0 = success
    1 = error
"""

from __future__ import annotations

import os
import sys

# Argon2id parameters — must match core/internal/adapter/crypto/argon2.go
ARGON2_MEMORY_KIB = 128 * 1024   # 131072 KiB = 128 MB
ARGON2_TIME_COST  = 3
ARGON2_PARALLELISM = 4
ARGON2_KEY_LEN    = 32
ARGON2_SALT_LEN   = 16


def wrap_seed(seed_hex: str, passphrase: str, output_dir: str) -> None:
    """Wrap a hex seed and write wrapped_seed.bin + identity_seed.salt."""
    # Lazy imports — only needed if actually wrapping.
    from argon2.low_level import hash_secret_raw, Type
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    seed = bytes.fromhex(seed_hex)
    if len(seed) != 32:
        raise ValueError(f"seed must be 32 bytes, got {len(seed)}")

    if not passphrase:
        raise ValueError("passphrase must not be empty")

    # 1. Generate random salt (16 bytes).
    salt = os.urandom(ARGON2_SALT_LEN)

    # 2. Derive KEK via Argon2id — matches Go's argon2.IDKey().
    kek = hash_secret_raw(
        secret=passphrase.encode("utf-8"),
        salt=salt,
        time_cost=ARGON2_TIME_COST,
        memory_cost=ARGON2_MEMORY_KIB,
        parallelism=ARGON2_PARALLELISM,
        hash_len=ARGON2_KEY_LEN,
        type=Type.ID,
    )

    # 3. AES-256-GCM wrap — matches Go's gcm.Seal(nonce, nonce, dek, nil).
    #    Output: nonce(12) || ciphertext(32) || tag(16) = 60 bytes.
    aesgcm = AESGCM(kek)
    nonce = os.urandom(12)
    ciphertext_and_tag = aesgcm.encrypt(nonce, seed, None)
    wrapped = nonce + ciphertext_and_tag  # 12 + 32 + 16 = 60 bytes

    if len(wrapped) != 60:
        raise RuntimeError(f"unexpected wrapped length: {len(wrapped)} (expected 60)")

    # 4. Write output files.
    os.makedirs(output_dir, exist_ok=True)

    wrapped_path = os.path.join(output_dir, "wrapped_seed.bin")
    salt_path = os.path.join(output_dir, "identity_seed.salt")

    # Write atomically-ish: write then set permissions.
    for path, data in [(wrapped_path, wrapped), (salt_path, salt)]:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            os.write(fd, data)
        finally:
            os.close(fd)


def main() -> None:
    if len(sys.argv) != 4:
        print("Usage: wrap_seed.py <64-char-hex-seed> <passphrase> <output-dir>",
              file=sys.stderr)
        sys.exit(1)

    seed_hex = sys.argv[1].strip()
    passphrase = sys.argv[2]
    output_dir = sys.argv[3]

    if len(seed_hex) != 64:
        print(f"Error: expected 64 hex chars, got {len(seed_hex)}", file=sys.stderr)
        sys.exit(1)

    try:
        wrap_seed(seed_hex, passphrase, output_dir)
        print(f"Wrapped seed written to {output_dir}/wrapped_seed.bin (60 bytes)")
        print(f"Salt written to {output_dir}/identity_seed.salt (16 bytes)")
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
