"""Ed25519 keypair management and request signing for service-to-service auth.

Service keys are derived from the master seed at install time via SLIP-0010
and loaded at runtime (load-only, fail-closed). Private keys live in
{keyDir}/private/ — each container bind-mounts a different host directory here,
so private keys never exist in the peer's filesystem namespace. Public keys
live in {keyDir}/public/ — a shared read-only directory both services can read.

Signing uses the same canonical payload format as CLI device auth::

    {METHOD}\\n{PATH}\\n{QUERY}\\n{TIMESTAMP}\\n{NONCE}\\n{SHA256_HEX(BODY)}
"""

from __future__ import annotations

import hashlib
import logging
import os
import secrets
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    PublicFormat,
    load_pem_private_key,
    load_pem_public_key,
)

import base58

log = logging.getLogger(__name__)

_ED25519_MULTICODEC = b"\xed\x01"
_EMPTY_BODY_HASH = hashlib.sha256(b"").hexdigest()
_MAX_CLOCK_SKEW = 300  # 5 minutes, same as Core


class _NonceCache:
    """Double-buffer nonce cache for replay protection.

    Matches Core's auth.go pattern: two generations rotated every 5 minutes,
    with a 100K safety valve. Thread-safe for uvicorn's async workers.
    """

    _MAX_ENTRIES = 100_000
    _ROTATION_SECS = 300  # 5 minutes

    def __init__(self) -> None:
        self._current: set[str] = set()
        self._previous: set[str] = set()
        self._rotated_at: float = time.monotonic()
        self._lock = threading.Lock()

    def check_and_add(self, nonce: str) -> bool:
        """Return True if nonce is fresh (not seen before). False = replay."""
        with self._lock:
            if nonce in self._current or nonce in self._previous:
                return False
            self._current.add(nonce)
            now = time.monotonic()
            if (now - self._rotated_at > self._ROTATION_SECS
                    or len(self._current) > self._MAX_ENTRIES):
                self._previous = self._current
                self._current = set()
                self._rotated_at = now
            return True


_nonce_cache = _NonceCache()


class ServiceIdentity:
    """Manages a service's Ed25519 keypair for service-to-service auth.

    Modeled on ``cli/src/dina_cli/signing.py`` but adapted for service use:
    no interactive passphrase, fixed key directory, generates on first startup.
    """

    def __init__(self, key_dir: Path, service_name: str = "brain") -> None:
        self._dir = Path(key_dir)
        self._name = service_name
        self._priv_dir = self._dir / "private"
        self._pub_dir = self._dir / "public"
        self._priv_path = self._priv_dir / f"{service_name}_ed25519_private.pem"
        self._pub_path = self._pub_dir / f"{service_name}_ed25519_public.pem"
        self._private_key: Ed25519PrivateKey | None = None

    def ensure_key(self) -> None:
        """Load the service keypair from disk (provisioned at install time).

        Fails if the private key file is missing — never generates new keys.
        """
        if not self._priv_path.exists():
            raise FileNotFoundError(
                f"Missing service private key: {self._priv_path} "
                "(run install.sh to provision)"
            )
        self._load()

    def _load(self) -> None:
        """Load an existing keypair from disk."""
        pem = self._priv_path.read_bytes()
        key = load_pem_private_key(pem, password=None)
        if not isinstance(key, Ed25519PrivateKey):
            raise TypeError(f"Expected Ed25519 private key, got {type(key)}")
        self._private_key = key

        # Fail-closed: require matching public key file at runtime.
        if not self._pub_path.exists():
            raise FileNotFoundError(f"Missing service public key: {self._pub_path}")
        pub_pem = self._pub_path.read_bytes()
        pub_key = load_pem_public_key(pub_pem)
        if not isinstance(pub_key, Ed25519PublicKey):
            raise TypeError(f"Expected Ed25519 public key, got {type(pub_key)}")
        expected = self._private_key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
        actual = pub_key.public_bytes(Encoding.Raw, PublicFormat.Raw)
        if expected != actual:
            raise ValueError("Service public key does not match private key")

    def load_peer_key(self, peer_name: str) -> Ed25519PublicKey:
        """Load a peer service's public key from the shared public directory."""
        pub_path = self._pub_dir / f"{peer_name}_ed25519_public.pem"
        pem = pub_path.read_bytes()
        key = load_pem_public_key(pem)
        if not isinstance(key, Ed25519PublicKey):
            raise TypeError(f"Expected Ed25519 public key, got {type(key)}")
        return key

    def load_peer_key_with_retry(
        self, peer_name: str, max_wait: float = 30.0, interval: float = 1.0,
    ) -> Ed25519PublicKey:
        """Load peer's public key, retrying until available or timeout."""
        deadline = time.monotonic() + max_wait
        last_err: Exception | None = None
        while time.monotonic() < deadline:
            try:
                return self.load_peer_key(peer_name)
            except FileNotFoundError as exc:
                last_err = exc
                log.debug("Waiting for %s public key...", peer_name)
                time.sleep(interval)
        raise FileNotFoundError(
            f"Peer key {peer_name!r} not found after {max_wait}s"
        ) from last_err

    # -- DID derivation --------------------------------------------------------

    def _raw_public_key(self) -> bytes:
        """Return the raw 32-byte Ed25519 public key."""
        assert self._private_key is not None, "Key not loaded"
        return self._private_key.public_key().public_bytes(
            Encoding.Raw, PublicFormat.Raw,
        )

    def did(self) -> str:
        """Derive the did:key identifier from the public key.

        Format: ``did:key:z{base58btc(0xed01 + raw_pubkey)}``
        """
        encoded = base58.b58encode(_ED25519_MULTICODEC + self._raw_public_key())
        return f"did:key:z{encoded.decode('ascii')}"

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
        assert self._private_key is not None, "Key not loaded"

        timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        nonce = secrets.token_hex(16)
        body_hash = hashlib.sha256(body).hexdigest() if body else _EMPTY_BODY_HASH
        payload = f"{method}\n{path}\n{query}\n{timestamp}\n{nonce}\n{body_hash}"
        signature = self._private_key.sign(payload.encode("utf-8"))
        return self.did(), timestamp, nonce, signature.hex()

    # -- Request verification --------------------------------------------------

    @staticmethod
    def verify_request(
        public_key: Ed25519PublicKey,
        method: str,
        path: str,
        query: str,
        timestamp: str,
        nonce: str,
        body: bytes,
        signature_hex: str,
    ) -> bool:
        """Verify an Ed25519 request signature.

        Uses the same canonical payload format as signing::

            {METHOD}\\n{PATH}\\n{QUERY}\\n{TIMESTAMP}\\n{NONCE}\\n{SHA256_HEX(BODY)}

        Checks the 5-minute timestamp window.
        """
        # Check timestamp window.
        try:
            ts = datetime.strptime(timestamp, "%Y-%m-%dT%H:%M:%SZ").replace(
                tzinfo=timezone.utc,
            )
        except ValueError:
            return False
        now = datetime.now(timezone.utc)
        if abs((now - ts).total_seconds()) > _MAX_CLOCK_SKEW:
            return False

        # Reconstruct canonical payload.
        body_hash = hashlib.sha256(body).hexdigest()
        payload = f"{method}\n{path}\n{query}\n{timestamp}\n{nonce}\n{body_hash}"

        # Verify signature.
        try:
            sig_bytes = bytes.fromhex(signature_hex)
        except ValueError:
            return False
        try:
            public_key.verify(sig_bytes, payload.encode("utf-8"))
        except Exception:
            return False

        # Replay check — reject previously seen signatures.
        if not _nonce_cache.check_and_add(signature_hex):
            return False
        return True
