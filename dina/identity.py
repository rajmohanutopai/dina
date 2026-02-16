"""The Identity — Dina's Ed25519 keypair for signing verdicts."""

from __future__ import annotations

import os
import stat
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
    PublicFormat,
    load_pem_private_key,
    load_pem_public_key,
)

_DEFAULT_IDENTITY_DIR = Path.home() / ".dina" / "identity"


class DinaIdentity:
    """Manages Dina's Ed25519 keypair.

    On first run, generates a new keypair and persists it as PEM files
    at ``~/.dina/identity/``.  On subsequent runs, loads the existing keys.
    """

    def __init__(self, identity_dir: Path | None = None) -> None:
        self._dir = identity_dir or _DEFAULT_IDENTITY_DIR
        self._private_key_path = self._dir / "ed25519_private.pem"
        self._public_key_path = self._dir / "ed25519_public.pem"

        if self._private_key_path.exists():
            self._load()
        else:
            self._generate()

    def _generate(self) -> None:
        """Generate a fresh Ed25519 keypair and save to disk."""
        self._dir.mkdir(parents=True, exist_ok=True)

        self._private_key = Ed25519PrivateKey.generate()
        self._public_key = self._private_key.public_key()

        # Write private key (restricted permissions)
        pem_private = self._private_key.private_bytes(
            Encoding.PEM, PrivateFormat.PKCS8, NoEncryption()
        )
        self._private_key_path.write_bytes(pem_private)
        os.chmod(self._private_key_path, stat.S_IRUSR | stat.S_IWUSR)  # 0600

        # Write public key
        pem_public = self._public_key.public_bytes(
            Encoding.PEM, PublicFormat.SubjectPublicKeyInfo
        )
        self._public_key_path.write_bytes(pem_public)

    def _load(self) -> None:
        """Load an existing keypair from PEM files."""
        private_pem = self._private_key_path.read_bytes()
        self._private_key = load_pem_private_key(private_pem, password=None)  # type: ignore[assignment]

        public_pem = self._public_key_path.read_bytes()
        self._public_key = load_pem_public_key(public_pem)  # type: ignore[assignment]

    def public_key_bytes(self) -> bytes:
        """Return the raw 32-byte Ed25519 public key."""
        return self._public_key.public_bytes(Encoding.Raw, PublicFormat.Raw)

    def private_key_seed(self) -> bytes:
        """Return the raw 32-byte Ed25519 private key seed (for Rust interop)."""
        raw = self._private_key.private_bytes(
            Encoding.Raw, PrivateFormat.Raw, NoEncryption()
        )
        return raw

    def sign(self, data: bytes) -> bytes:
        """Sign data with the Ed25519 private key."""
        return self._private_key.sign(data)

    def verify(self, signature: bytes, data: bytes) -> bool:
        """Verify a signature against data using the public key."""
        try:
            self._public_key.verify(signature, data)
            return True
        except Exception:
            return False

    @property
    def public_key(self) -> Ed25519PublicKey:
        return self._public_key
