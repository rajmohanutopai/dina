#!/usr/bin/env python3
"""Provision deterministic Ed25519 service keys derived from the master seed.

Uses SLIP-0010 (Ed25519 hardened derivation) at:
  Core:  m/9999'/3'/0'
  Brain: m/9999'/3'/1'

This must produce byte-identical keys to Go's keyderiver.DeriveServiceKey().

Layout (matches provision_service_keys.py):
  <root>/core/core_ed25519_private.pem
  <root>/brain/brain_ed25519_private.pem
  <root>/public/core_ed25519_public.pem
  <root>/public/brain_ed25519_public.pem

Dependencies: cryptography (provided by dina-crypto-tools Docker image).

Usage:
    DINA_SEED_HEX=<64hex> python3 scripts/provision_derived_service_keys.py <service_key_root>

Seed is read from DINA_SEED_HEX environment variable (not argv)
to avoid process-list exposure on multi-user hosts.

Exit codes:
    0 = success
    1 = error
"""

from __future__ import annotations

import hashlib
import hmac
import os
import stat
import struct
import sys
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
    PublicFormat,
)

# SLIP-0010 purpose branches (must match keyderiver.go constants).
PURPOSE_SERVICE_AUTH = 3  # m/9999'/3'/...

# Hardened offset per BIP-32.
HARDENED = 0x80000000


def _slip0010_master(seed: bytes) -> tuple[bytes, bytes]:
    """Derive SLIP-0010 master key and chain code from seed."""
    I = hmac.new(b"ed25519 seed", seed, hashlib.sha512).digest()
    return I[:32], I[32:]


def _slip0010_child(
    parent_key: bytes, parent_chain: bytes, index: int
) -> tuple[bytes, bytes]:
    """Derive a hardened SLIP-0010 child key."""
    # Data = 0x00 || parent_key(32) || index(4, big-endian)
    data = b"\x00" + parent_key + struct.pack(">I", index)
    I = hmac.new(parent_chain, data, hashlib.sha512).digest()
    return I[:32], I[32:]


def derive_service_key(seed: bytes, service_index: int) -> Ed25519PrivateKey:
    """Derive Ed25519 service key at m/9999'/3'/<service_index>'."""
    key, chain = _slip0010_master(seed)

    # m/9999'
    key, chain = _slip0010_child(key, chain, 9999 + HARDENED)
    # m/9999'/3'  (PURPOSE_SERVICE_AUTH)
    key, chain = _slip0010_child(key, chain, PURPOSE_SERVICE_AUTH + HARDENED)
    # m/9999'/3'/<service_index>'
    key, chain = _slip0010_child(key, chain, service_index + HARDENED)

    # key is 32-byte Ed25519 seed — create private key from it.
    return Ed25519PrivateKey.from_private_bytes(key)


def _write_keypair(root: Path, name: str, priv_key: Ed25519PrivateKey) -> None:
    """Write private + public PEM files in the same layout as provision_service_keys.py."""
    priv_dir = root / name
    pub_dir = root / "public"
    priv_dir.mkdir(parents=True, exist_ok=True)
    pub_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(priv_dir, 0o700)
    os.chmod(pub_dir, 0o755)

    priv_path = priv_dir / f"{name}_ed25519_private.pem"
    pub_path = pub_dir / f"{name}_ed25519_public.pem"

    # Write private key (owner-only).
    pem_priv = priv_key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption())
    priv_path.write_bytes(pem_priv)
    os.chmod(priv_path, stat.S_IRUSR | stat.S_IWUSR)

    # Write public key (readable by peer).
    pem_pub = priv_key.public_key().public_bytes(
        Encoding.PEM, PublicFormat.SubjectPublicKeyInfo
    )
    pub_path.write_bytes(pem_pub)
    os.chmod(pub_path, stat.S_IRUSR | stat.S_IWUSR | stat.S_IRGRP | stat.S_IROTH)


def main() -> int:
    if len(sys.argv) != 2:
        print(
            "usage: DINA_SEED_HEX=<64hex> provision_derived_service_keys.py <service_key_root>",
            file=sys.stderr,
        )
        return 2

    seed_hex = os.environ.get("DINA_SEED_HEX", "").strip()
    root = Path(sys.argv[1]).expanduser().resolve()

    if not seed_hex:
        print("Error: DINA_SEED_HEX environment variable not set", file=sys.stderr)
        return 1
    if len(seed_hex) != 64:
        print(f"Error: expected 64 hex chars, got {len(seed_hex)}", file=sys.stderr)
        return 1

    seed = bytes.fromhex(seed_hex)

    # Core = service index 0, Brain = service index 1.
    core_key = derive_service_key(seed, 0)
    brain_key = derive_service_key(seed, 1)

    _write_keypair(root, "core", core_key)
    _write_keypair(root, "brain", brain_key)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
