"""Ed25519 keypair management and HTTP request signing for dina-cli."""

from __future__ import annotations

import hashlib
import os
import secrets
import stat
from datetime import datetime, timezone
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import (
    BestAvailableEncryption,
    Encoding,
    NoEncryption,
    PrivateFormat,
    PublicFormat,
    load_pem_private_key,
)

import base58

_DEFAULT_IDENTITY_DIR = Path.home() / ".dina" / "cli" / "identity"
_ED25519_MULTICODEC = b"\xed\x01"
_EMPTY_BODY_HASH = hashlib.sha256(b"").hexdigest()


class CLIIdentity:
    """Manages the CLI device's Ed25519 keypair.

    Keys are stored as PEM files at ``~/.dina/cli/identity/``.
    The private key file has 0600 permissions.
    """

    def __init__(self, identity_dir: Path | None = None) -> None:
        self._dir = identity_dir or _DEFAULT_IDENTITY_DIR
        self._priv_path = self._dir / "ed25519_private.pem"
        self._pub_path = self._dir / "ed25519_public.pem"
        self._private_key: Ed25519PrivateKey | None = None

    @property
    def exists(self) -> bool:
        """True if a keypair has already been generated."""
        return self._priv_path.exists()

    def generate(self) -> None:
        """Generate and persist a new Ed25519 keypair.

        If the ``DINA_CLI_KEY_PASSPHRASE`` environment variable is set, the
        private key is encrypted at rest using ``BestAvailableEncryption``.
        Otherwise ``NoEncryption`` is used (backward compatible).
        """
        self._dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        # Enforce permissions even if directory already existed with wrong perms
        os.chmod(self._dir, 0o700)
        self._private_key = Ed25519PrivateKey.generate()

        # Determine encryption scheme based on env var.
        passphrase = os.environ.get("DINA_CLI_KEY_PASSPHRASE", "").strip()
        encryption = (
            BestAvailableEncryption(passphrase.encode())
            if passphrase
            else NoEncryption()
        )

        # Write private key (owner read/write only).
        pem_priv = self._private_key.private_bytes(
            Encoding.PEM, PrivateFormat.PKCS8, encryption,
        )
        self._priv_path.write_bytes(pem_priv)
        os.chmod(self._priv_path, stat.S_IRUSR | stat.S_IWUSR)

        # Write public key.
        pem_pub = self._private_key.public_key().public_bytes(
            Encoding.PEM, PublicFormat.SubjectPublicKeyInfo,
        )
        self._pub_path.write_bytes(pem_pub)

    def load(self) -> None:
        """Load an existing keypair from disk.

        Tries loading without a password first.  If that fails with a
        decryption-related error, retries using the passphrase from the
        ``DINA_CLI_KEY_PASSPHRASE`` environment variable (if set).
        """
        pem = self._priv_path.read_bytes()
        try:
            key = load_pem_private_key(pem, password=None)
        except (TypeError, ValueError):
            # PEM is encrypted — try env-var passphrase.
            passphrase = os.environ.get("DINA_CLI_KEY_PASSPHRASE", "").strip()
            if not passphrase:
                raise
            key = load_pem_private_key(pem, password=passphrase.encode())
        if not isinstance(key, Ed25519PrivateKey):
            raise TypeError("Expected Ed25519 private key")
        self._private_key = key

    def ensure_loaded(self) -> None:
        """Load keypair if not already in memory. Raises if no keypair exists."""
        if self._private_key is not None:
            return
        if self.exists:
            self.load()
        else:
            raise FileNotFoundError(
                "No keypair found. Run 'dina configure' to set up Ed25519 signing."
            )

    # -- DID derivation --------------------------------------------------------

    def _raw_public_key(self) -> bytes:
        """Return the raw 32-byte Ed25519 public key."""
        self.ensure_loaded()
        assert self._private_key is not None
        return self._private_key.public_key().public_bytes(
            Encoding.Raw, PublicFormat.Raw,
        )

    def did(self) -> str:
        """Derive the did:key identifier from the public key.

        Format: ``did:key:z{base58btc(0xed01 + raw_pubkey)}``
        """
        encoded = base58.b58encode(_ED25519_MULTICODEC + self._raw_public_key())
        return f"did:key:z{encoded.decode('ascii')}"

    def public_key_multibase(self) -> str:
        """Return the multibase-encoded public key for device registration.

        Format: ``z{base58btc(0xed01 + raw_pubkey)}``
        """
        encoded = base58.b58encode(_ED25519_MULTICODEC + self._raw_public_key())
        return f"z{encoded.decode('ascii')}"

    # -- Data signing ----------------------------------------------------------

    def sign_data(self, data: bytes) -> str:
        """Sign arbitrary data and return the hex-encoded signature."""
        self.ensure_loaded()
        assert self._private_key is not None
        return self._private_key.sign(data).hex()

    # -- Request signing -------------------------------------------------------

    def sign_request(
        self,
        method: str,
        path: str,
        body: bytes | None = None,
        query: str = "",
    ) -> tuple[str, str, str, str]:
        """Sign an HTTP request.

        Returns ``(did, timestamp, nonce, signature_hex)``.

        The canonical signing payload is::

            {METHOD}\\n{PATH}\\n{QUERY}\\n{TIMESTAMP}\\n{NONCE}\\n{SHA256_HEX(BODY)}
        """
        self.ensure_loaded()
        assert self._private_key is not None

        timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        nonce = secrets.token_hex(16)
        body_hash = hashlib.sha256(body).hexdigest() if body else _EMPTY_BODY_HASH
        payload = f"{method}\n{path}\n{query}\n{timestamp}\n{nonce}\n{body_hash}"
        signature = self._private_key.sign(payload.encode("utf-8"))
        return self.did(), timestamp, nonce, signature.hex()
