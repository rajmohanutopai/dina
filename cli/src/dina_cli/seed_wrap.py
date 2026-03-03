"""Seed wrapping — Argon2id + AES-256-GCM, byte-compatible with Go Core.

Parameters must match core/internal/adapter/crypto/argon2.go + keywrap.go:
  - Argon2id: memory=128 MB, time=3, parallelism=4, keyLen=32, saltLen=16
  - AES-256-GCM: nonce(12) || ciphertext(32) || tag(16) = 60 bytes
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path

from argon2.low_level import Type, hash_secret_raw
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

# Argon2id parameters — must match Go Core.
ARGON2_MEMORY_KIB = 128 * 1024  # 131072 KiB
ARGON2_TIME_COST = 3
ARGON2_PARALLELISM = 4
ARGON2_KEY_LEN = 32
ARGON2_SALT_LEN = 16

# BIP-39 wordlist (lazy-loaded).
_WORDLIST: list[str] | None = None


def _bip39_wordlist() -> list[str]:
    """Load the BIP-39 English wordlist from scripts/."""
    global _WORDLIST
    if _WORDLIST is not None:
        return _WORDLIST
    # Try project-relative path first, then package-relative.
    for candidate in [
        Path(__file__).resolve().parents[3] / "scripts" / "bip39_english.txt",
        Path(__file__).resolve().parents[4] / "scripts" / "bip39_english.txt",
    ]:
        if candidate.exists():
            words = [w.strip() for w in candidate.read_text().splitlines() if w.strip()]
            if len(words) == 2048:
                _WORDLIST = words
                return _WORDLIST
    raise FileNotFoundError("Cannot find bip39_english.txt")


def generate_seed() -> bytes:
    """Generate a cryptographically random 32-byte seed."""
    return os.urandom(32)


def seed_to_mnemonic(seed: bytes) -> list[str]:
    """Convert 32-byte seed to 24-word BIP-39 mnemonic."""
    if len(seed) != 32:
        raise ValueError(f"seed must be 32 bytes, got {len(seed)}")
    words = _bip39_wordlist()
    checksum = hashlib.sha256(seed).digest()
    bits = bin(int.from_bytes(seed, "big"))[2:].zfill(256)
    bits += bin(checksum[0])[2:].zfill(8)
    return [words[int(bits[i : i + 11], 2)] for i in range(0, 264, 11)]


def mnemonic_to_seed(mnemonic: list[str]) -> bytes:
    """Convert 24-word BIP-39 mnemonic back to 32-byte seed."""
    words = _bip39_wordlist()
    word_index = {w: i for i, w in enumerate(words)}
    if len(mnemonic) != 24:
        raise ValueError(f"expected 24 words, got {len(mnemonic)}")
    bits = ""
    for w in mnemonic:
        w = w.lower().strip()
        if w not in word_index:
            raise ValueError(f"unknown word: {w!r}")
        bits += bin(word_index[w])[2:].zfill(11)
    entropy_bits, checksum_bits = bits[:256], bits[256:]
    entropy = int(entropy_bits, 2).to_bytes(32, "big")
    expected = bin(hashlib.sha256(entropy).digest()[0])[2:].zfill(8)
    if checksum_bits != expected:
        raise ValueError("invalid checksum — mnemonic may be corrupted or misspelled")
    return entropy


def derive_kek(passphrase: str, salt: bytes) -> bytes:
    """Derive a 32-byte KEK via Argon2id (matches Go Core)."""
    return hash_secret_raw(
        secret=passphrase.encode("utf-8"),
        salt=salt,
        time_cost=ARGON2_TIME_COST,
        memory_cost=ARGON2_MEMORY_KIB,
        parallelism=ARGON2_PARALLELISM,
        hash_len=ARGON2_KEY_LEN,
        type=Type.ID,
    )


def wrap(seed: bytes, passphrase: str) -> tuple[bytes, bytes]:
    """Wrap a 32-byte seed. Returns (wrapped_blob, salt).

    wrapped_blob = nonce(12) || ciphertext(32) || tag(16) = 60 bytes
    salt = 16 random bytes
    """
    if len(seed) != 32:
        raise ValueError(f"seed must be 32 bytes, got {len(seed)}")
    salt = os.urandom(ARGON2_SALT_LEN)
    kek = derive_kek(passphrase, salt)
    nonce = os.urandom(12)
    ct_and_tag = AESGCM(kek).encrypt(nonce, seed, None)
    wrapped = nonce + ct_and_tag
    assert len(wrapped) == 60, f"unexpected wrapped length: {len(wrapped)}"
    return wrapped, salt


def unwrap(wrapped: bytes, salt: bytes, passphrase: str) -> bytes:
    """Unwrap a 60-byte blob back to the 32-byte seed."""
    if len(wrapped) != 60:
        raise ValueError(f"wrapped blob must be 60 bytes, got {len(wrapped)}")
    if len(salt) != 16:
        raise ValueError(f"salt must be 16 bytes, got {len(salt)}")
    kek = derive_kek(passphrase, salt)
    nonce, ct_and_tag = wrapped[:12], wrapped[12:]
    try:
        return AESGCM(kek).decrypt(nonce, ct_and_tag, None)
    except Exception:
        raise ValueError("decryption failed — wrong passphrase or corrupted data")


def save_wrapped(wrapped: bytes, salt: bytes, directory: Path) -> None:
    """Write wrapped_seed.bin + identity_seed.salt with 0600 permissions."""
    directory.mkdir(parents=True, exist_ok=True)
    os.chmod(directory, 0o700)
    for name, data in [("wrapped_seed.bin", wrapped), ("identity_seed.salt", salt)]:
        path = directory / name
        fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            os.write(fd, data)
        finally:
            os.close(fd)


def load_wrapped(directory: Path) -> tuple[bytes, bytes]:
    """Read wrapped_seed.bin + identity_seed.salt from a directory."""
    wrapped = (directory / "wrapped_seed.bin").read_bytes()
    salt = (directory / "identity_seed.salt").read_bytes()
    return wrapped, salt
