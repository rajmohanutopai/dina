"""Ed25519 keypair management and HTTP request signing for dina-cli."""

from __future__ import annotations

import base64
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

from . import config as _config_mod


def _default_identity_dir() -> Path:
    """Return the current owner-controlled identity directory."""
    return _config_mod.IDENTITY_DIR


_DEFAULT_IDENTITY_DIR = None  # Unused — kept for backward compat
_ED25519_MULTICODEC = b"\xed\x01"
_EMPTY_BODY_HASH = hashlib.sha256(b"").hexdigest()


class CLIIdentity:
    """Manages the CLI device's Ed25519 keypair.

    Keys are stored as PEM files at ``~/.dina/cli/identity/``.
    The private key file has 0600 permissions.
    """

    def __init__(self, identity_dir: Path | None = None) -> None:
        self._dir = identity_dir or _default_identity_dir()
        self._priv_path = self._dir / "ed25519_private.pem"
        self._pub_path = self._dir / "ed25519_public.pem"
        self._private_key: Ed25519PrivateKey | None = None

    @property
    def exists(self) -> bool:
        """True if a private-key path exists, including an unsafe symlink."""
        return os.path.lexists(self._priv_path)

    def generate(self) -> None:
        """Generate and persist a new Ed25519 keypair.

        If the ``DINA_CLI_KEY_PASSPHRASE`` environment variable is set, the
        private key is encrypted at rest using ``BestAvailableEncryption``.
        Otherwise ``NoEncryption`` is used (backward compatible).
        """
        if self.exists:
            raise FileExistsError(f"Identity already exists at {self._priv_path}")
        self._dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        if self._dir.is_symlink():
            raise PermissionError("Dina identity directory must not be a symlink")
        # Enforce permissions even if directory already existed with wrong perms
        os.chmod(self._dir, 0o700)
        self._private_key = Ed25519PrivateKey.generate()

        # Determine encryption scheme based on env var.
        passphrase = os.environ.get("DINA_CLI_KEY_PASSPHRASE", "").strip()
        if passphrase:
            encryption = BestAvailableEncryption(passphrase.encode())
        else:
            # CLI.4: this private key IS the agent's delegated authority. File
            # perms (0600) protect it at rest, but on a daemon / shared /
            # external machine (e.g. running OpenClaw) an encrypted key is
            # strongly preferred. Warn loudly so leaving it unencrypted is a
            # deliberate choice, not an omission.
            import sys

            print(
                "[dina-cli] WARNING: storing the agent private key UNENCRYPTED at "
                f"{self._priv_path} (perms 0600 only). Set DINA_CLI_KEY_PASSPHRASE "
                "to encrypt it at rest — strongly recommended for daemon / "
                "shared-machine deployments.",
                file=sys.stderr,
            )
            encryption = NoEncryption()

        # Write private key (owner read/write only).
        pem_priv = self._private_key.private_bytes(
            Encoding.PEM,
            PrivateFormat.PKCS8,
            encryption,
        )
        self._write_new_file(
            self._priv_path,
            pem_priv,
            stat.S_IRUSR | stat.S_IWUSR,
        )

        # Write public key.
        pem_pub = self._private_key.public_key().public_bytes(
            Encoding.PEM,
            PublicFormat.SubjectPublicKeyInfo,
        )
        self._write_new_file(
            self._pub_path,
            pem_pub,
            stat.S_IRUSR | stat.S_IWUSR,
        )

    def load(self) -> None:
        """Load an existing keypair from disk.

        Tries loading without a password first.  If that fails with a
        decryption-related error, retries using the passphrase from the
        ``DINA_CLI_KEY_PASSPHRASE`` environment variable (if set).
        """
        self._validate_private_key_storage()
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

    @staticmethod
    def _write_new_file(path: Path, payload: bytes, mode: int) -> None:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        fd = os.open(path, flags, mode)
        try:
            view = memoryview(payload)
            while view:
                written = os.write(fd, view)
                if written <= 0:
                    raise OSError(f"short write while creating {path}")
                view = view[written:]
            os.fsync(fd)
        finally:
            os.close(fd)
        os.chmod(path, mode)

    def _validate_private_key_storage(self) -> None:
        """Reject keys outside the current OS user's private storage."""
        try:
            directory = self._dir.lstat()
            private_key = self._priv_path.lstat()
        except FileNotFoundError:
            raise
        if stat.S_ISLNK(directory.st_mode) or not stat.S_ISDIR(directory.st_mode):
            raise PermissionError("Dina identity directory must be a real directory")
        if stat.S_ISLNK(private_key.st_mode) or not stat.S_ISREG(private_key.st_mode):
            raise PermissionError("Dina private key must be a regular file")
        if os.name != "nt":
            expected_uid = os.geteuid()
            if directory.st_uid != expected_uid or private_key.st_uid != expected_uid:
                raise PermissionError(
                    "Dina identity storage must be owned by the current user"
                )
            if stat.S_IMODE(directory.st_mode) & 0o077:
                raise PermissionError(
                    "Dina identity directory permissions must be 0700 or stricter"
                )
            if stat.S_IMODE(private_key.st_mode) & 0o077:
                raise PermissionError(
                    "Dina private key permissions must be 0600 or stricter"
                )

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
            Encoding.Raw,
            PublicFormat.Raw,
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

    def public_key_base64url(self) -> str:
        """Return the raw public key as base64url without padding.

        OpenClaw's device-auth handshake expects raw Ed25519 public-key bytes,
        not a DID or multibase wrapper.
        """
        return (
            base64.urlsafe_b64encode(self._raw_public_key()).decode("ascii").rstrip("=")
        )

    def device_fingerprint(self) -> str:
        """Return the OpenClaw device fingerprint for this keypair.

        OpenClaw derives device IDs as the SHA-256 hex digest of the raw
        Ed25519 public key.
        """
        return hashlib.sha256(self._raw_public_key()).hexdigest()

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
