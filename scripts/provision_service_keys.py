#!/usr/bin/env python3
"""Provision Ed25519 service keys for Core/Brain at install time.

Layout:
  <root>/core/core_ed25519_private.pem
  <root>/brain/brain_ed25519_private.pem
  <root>/public/core_ed25519_public.pem
  <root>/public/brain_ed25519_public.pem
"""

from __future__ import annotations

import os
import stat
import sys
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
    PublicFormat,
    load_pem_private_key,
    load_pem_public_key,
)


def _chmod(path: Path, mode: int) -> None:
    os.chmod(path, mode)


def _write_private(path: Path, key: Ed25519PrivateKey) -> None:
    pem = key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption())
    path.write_bytes(pem)
    _chmod(path, stat.S_IRUSR | stat.S_IWUSR)


def _write_public(path: Path, key: Ed25519PrivateKey) -> None:
    pem = key.public_key().public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo)
    path.write_bytes(pem)
    _chmod(path, stat.S_IRUSR | stat.S_IWUSR | stat.S_IRGRP | stat.S_IROTH)


def _load_private(path: Path) -> Ed25519PrivateKey:
    key = load_pem_private_key(path.read_bytes(), password=None)
    if not isinstance(key, Ed25519PrivateKey):
        raise TypeError(f"{path} is not an Ed25519 private key")
    return key


def _verify_public(path: Path, key: Ed25519PrivateKey) -> None:
    if not path.exists():
        _write_public(path, key)
        return
    pub = load_pem_public_key(path.read_bytes())
    if not hasattr(pub, "public_bytes"):
        raise TypeError(f"{path} is not a valid public key")
    expected = key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    actual = pub.public_bytes(Encoding.Raw, PublicFormat.Raw)
    if expected != actual:
        raise ValueError(f"Public key mismatch for {path}")


def ensure_service(root: Path, name: str) -> None:
    priv_dir = root / name
    pub_dir = root / "public"
    priv_dir.mkdir(parents=True, exist_ok=True)
    pub_dir.mkdir(parents=True, exist_ok=True)
    _chmod(priv_dir, 0o700)
    _chmod(pub_dir, 0o755)

    priv_path = priv_dir / f"{name}_ed25519_private.pem"
    pub_path = pub_dir / f"{name}_ed25519_public.pem"

    if priv_path.exists():
        key = _load_private(priv_path)
        _chmod(priv_path, stat.S_IRUSR | stat.S_IWUSR)
        _verify_public(pub_path, key)
        return

    if pub_path.exists():
        raise FileNotFoundError(
            f"{name}: public key exists but private key missing ({priv_path}); "
            "refusing to regenerate silently"
        )

    key = Ed25519PrivateKey.generate()
    _write_private(priv_path, key)
    _write_public(pub_path, key)


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: provision_service_keys.py <service_key_root>", file=sys.stderr)
        return 2
    root = Path(sys.argv[1]).expanduser().resolve()
    ensure_service(root, "core")
    ensure_service(root, "brain")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

