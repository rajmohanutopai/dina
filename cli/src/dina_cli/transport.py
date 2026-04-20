"""Transport abstraction for CLI ↔ Core communication.

Supports three modes:
  - direct: HTTPS to Core (current, for LAN/Docker)
  - msgbox: WebSocket relay through MsgBox (for remote/NAT)
  - auto:   try direct first, fall back to msgbox
"""

from __future__ import annotations

import base64
import hashlib
import json
import secrets
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Protocol

import httpx
import nacl.public
import nacl.utils
import websockets.sync.client
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from .signing import CLIIdentity


class TransportError(Exception):
    """Raised when transport-level communication fails."""


@dataclass
class TransportResponse:
    """Response from a transport request."""
    status: int
    headers: dict[str, str]
    body: str


class Transport(Protocol):
    """Protocol for CLI transport implementations."""

    def request(
        self, method: str, path: str, headers: dict[str, str],
        body: str | None = None, request_id: str | None = None,
    ) -> TransportResponse:
        ...


class DirectTransport:
    """Direct HTTPS to Core. For local/Docker/LAN use."""

    def __init__(self, core_url: str, timeout: float = 30.0) -> None:
        self._core_url = core_url.rstrip("/")
        self._timeout = timeout

    def request(
        self, method: str, path: str, headers: dict[str, str],
        body: str | None = None, request_id: str | None = None,
    ) -> TransportResponse:
        url = f"{self._core_url}{path}"
        try:
            resp = httpx.request(
                method, url, headers=headers,
                content=body.encode() if body else None,
                timeout=self._timeout,
            )
            return TransportResponse(
                status=resp.status_code,
                headers=dict(resp.headers),
                body=resp.text,
            )
        except httpx.ConnectError as e:
            raise TransportError(f"Core unreachable at {self._core_url}: {e}") from e
        except httpx.TimeoutException as e:
            raise TransportError(f"Core timeout at {self._core_url}: {e}") from e


def _resolve_homenode_x25519_pub(homenode_did: str, plc_url: str = "https://plc.directory") -> bytes | None:
    """Resolve the Home Node's X25519 public key from its PLC document.

    Fetches the PLC doc, extracts #dina_signing Ed25519 key, converts to X25519.
    Returns None if resolution fails (plaintext fallback).
    """
    if not homenode_did.startswith("did:plc:"):
        return None  # did:key doesn't need PLC lookup

    try:
        resp = httpx.get(f"{plc_url}/{homenode_did}", timeout=10)
        if resp.status_code != 200:
            return None
        doc = resp.json()

        # Find #dina_signing or #key-1 verification method.
        # PLC ID format: "did:plc:abc123#dina_signing" — extract the fragment
        # after '#' and match exactly to avoid false positives from substring
        # matching (e.g., "#not_dina_signing" or "#dina_signing_v2").
        for vm in doc.get("verificationMethod", []):
            vm_id = vm.get("id", "")
            fragment = vm_id.rsplit("#", 1)[-1] if "#" in vm_id else vm_id
            if fragment == "dina_signing" or fragment == "key-1":
                multibase = vm.get("publicKeyMultibase", "")
                if not multibase.startswith("z"):
                    continue
                import base58
                raw = base58.b58decode(multibase[1:])
                if len(raw) != 34 or raw[0] != 0xed or raw[1] != 0x01:
                    continue
                ed25519_pub_bytes = bytes(raw[2:])
                # Convert Ed25519 public key to X25519 using cryptography library.
                ed25519_pub = Ed25519PublicKey.from_public_bytes(ed25519_pub_bytes)
                # The cryptography library doesn't expose Ed25519→X25519 directly.
                # Use nacl's crypto_sign_ed25519_pk_to_curve25519.
                import nacl.bindings
                x25519_pub_bytes = nacl.bindings.crypto_sign_ed25519_pk_to_curve25519(ed25519_pub_bytes)
                return x25519_pub_bytes
    except Exception:
        pass
    return None


def _derive_cli_x25519_keys(identity: CLIIdentity) -> tuple[bytes, bytes]:
    """Derive X25519 keypair from CLI's Ed25519 signing key.

    Returns (x25519_private_bytes, x25519_public_bytes).
    Used for decrypting responses encrypted to the CLI's public key.
    """
    identity.ensure_loaded()
    ed25519_priv = identity._private_key
    # Get raw Ed25519 seed (first 32 bytes of private key).
    raw_priv = ed25519_priv.private_bytes_raw()
    # Convert Ed25519 private key to X25519 using NaCl bindings.
    import nacl.bindings
    x25519_priv_bytes = nacl.bindings.crypto_sign_ed25519_sk_to_curve25519(
        raw_priv + identity._raw_public_key()  # NaCl expects 64-byte ed25519 sk
    )
    x25519_pub_bytes = nacl.bindings.crypto_sign_ed25519_pk_to_curve25519(
        identity._raw_public_key()
    )
    return x25519_priv_bytes, x25519_pub_bytes


# Default expiry per operation type (seconds from now).
# Ordered longest-first to prevent substring false matches
# (e.g., "/v1/task" must NOT match "ask" before "task").
_EXPIRY_DEFAULTS = [
    ("remember", 300),   # writes: 5 minutes
    ("task", 300),       # writes: 5 minutes (must be before "ask")
    ("status", 30),      # interactive reads: short
    ("ask", 30),         # interactive reads: short
    ("pair", 300),       # pairing: matches code TTL
]


def _expiry_for_path(path: str) -> int:
    """Return expires_at (unix timestamp) based on the API path."""
    for key, ttl in _EXPIRY_DEFAULTS:
        if key in path:
            return int(time.time()) + ttl
    return int(time.time()) + 300  # default: 5 minutes


class MsgBoxTransport:
    """Request via MsgBox WebSocket relay. For remote/NAT use.

    Each request():
    1. Connects to MsgBox WebSocket + Ed25519 challenge-response auth
    2. Drains any buffered responses
    3. Builds inner request JSON with Ed25519 signature headers
    4. Encrypts with Home Node's X25519 public key (NaCl sealed-box)
    5. Sends as binary-JSON RPC envelope
    6. Waits for response with matching id
    7. Decrypts and returns TransportResponse
    """

    def __init__(
        self, msgbox_url: str, homenode_did: str,
        identity: CLIIdentity | None = None,
        homenode_x25519_pub: bytes | None = None,
        timeout: float = 30.0,
    ) -> None:
        self._msgbox_url = msgbox_url
        self._homenode_did = homenode_did
        self._identity = identity or CLIIdentity()
        self._identity.ensure_loaded()
        self._timeout = timeout
        self._pending: dict[str, dict] = {}  # request_id → response envelope

        # Home Node's X25519 public key for NaCl sealed-box encryption.
        if homenode_x25519_pub is not None:
            self._homenode_x25519_pub = homenode_x25519_pub
        else:
            # Resolve from PLC document.
            self._homenode_x25519_pub = _resolve_homenode_x25519_pub(homenode_did)
            if self._homenode_x25519_pub is None:
                import logging
                logging.warning(
                    "MsgBoxTransport: failed to resolve Home Node X25519 key from PLC doc for %s. "
                    "Requests will be REJECTED (no plaintext fallback).", homenode_did
                )

        # CLI's own X25519 keys for decrypting responses.
        try:
            self._cli_x25519_priv, self._cli_x25519_pub = _derive_cli_x25519_keys(self._identity)
        except Exception as e:
            import logging
            logging.warning("MsgBoxTransport: X25519 key derivation failed: %s. "
                            "Response decryption will fail.", e)
            self._cli_x25519_priv = None
            self._cli_x25519_pub = None

    def request(
        self, method: str, path: str, headers: dict[str, str],
        body: str | None = None, request_id: str | None = None,
    ) -> TransportResponse:
        rid = request_id or uuid.uuid4().hex

        # 1. Connect + authenticate.
        ws = self._connect_and_auth()

        try:
            # 2. Drain buffered responses.
            self._drain_buffered(ws)

            # 3. Check if we already have the response (from drain).
            if rid in self._pending:
                env = self._pending.pop(rid)
                # Validate to_did matches our DID (from_did validated during drain).
                if env.get("to_did") == self._identity.did():
                    return self._parse_response(env)
                # Mismatched to_did — discard (possible injection attempt).

            # 4. Build inner request JSON with signed headers.
            query = ""
            if "?" in path:
                path, query = path.split("?", 1)
            body_bytes = body.encode() if body else b""

            # Pairing requests are NOT Ed25519-signed on the inner request.
            # /v1/pair/complete is in Core's optionalAuthPaths (the pairing
            # code is the auth); if we send X-DID + X-Signature the auth
            # middleware's Ed25519 branch runs first, tries to look up a
            # fresh did:key that isn't registered yet, and returns 401
            # "invalid signature" before the optionalAuthPaths bypass is
            # consulted. The envelope's from_did + body.public_key_multibase
            # give Core the binding it needs via VerifyPairingIdentityBinding.
            # See docs/designs/MSGBOX_TRANSPORT.md §"Pairing over MsgBox".
            is_pairing = path.startswith("/v1/pair/")
            if is_pairing:
                did = self._identity.did()  # still need did for envelope below
                inner_headers = dict(headers)
            else:
                # sign_request signature is (method, path, body, query) —
                # positional. Earlier code passed (method, path, query,
                # body_bytes) which swapped body/query into the wrong slots,
                # breaking signature validation.
                did, ts, nonce, sig = self._identity.sign_request(
                    method, path, body_bytes, query=query,
                )
                inner_headers = {
                    **headers,
                    "X-DID": did,
                    "X-Timestamp": ts,
                    "X-Nonce": nonce,
                    "X-Signature": sig,
                }
            inner = json.dumps({
                "method": method,
                "path": f"{path}?{query}" if query else path,
                "headers": inner_headers,
                "body": body or "",
            })

            # 5. Encrypt inner JSON (NaCl sealed-box).
            ciphertext = self._encrypt(inner.encode())

            # 6. Build outer RPC envelope.
            env_data: dict = {
                "type": "rpc",
                "id": rid,
                "from_did": did,
                "to_did": self._homenode_did,
                "direction": "request",
                "expires_at": _expiry_for_path(path),
                "ciphertext": base64.b64encode(ciphertext).decode(),
            }
            # Emit subtype "pair" for pairing requests (MsgBox IP throttle).
            # Exact prefix match — avoids false positives from paths like /repair.
            if path.startswith("/v1/pair"):
                env_data["subtype"] = "pair"
            envelope = json.dumps(env_data).encode()

            # 7. Send as binary frame.
            try:
                ws.send(envelope)
            except Exception as e:
                raise TransportError(
                    f"MsgBox connection lost (possible auth rejection): {e}"
                ) from e

            # 8. Wait for response with matching id.
            deadline = time.time() + self._timeout
            while time.time() < deadline:
                try:
                    remaining = max(deadline - time.time(), 0.01)
                    ws.socket.settimeout(remaining)
                    data = ws.recv()
                except Exception:
                    break
                if isinstance(data, (bytes, bytearray)):
                    data = data.decode("utf-8", errors="replace")
                try:
                    env = json.loads(data)
                except (json.JSONDecodeError, TypeError):
                    continue
                if (env.get("type") == "rpc"
                        and env.get("direction") == "response"
                        and env.get("id") == rid
                        and env.get("from_did") == self._homenode_did
                        and env.get("to_did") == did):
                    return self._parse_response(env)
                # Not our response — cache for later (with DID validation).
                if (env.get("type") == "rpc"
                        and env.get("direction") == "response"
                        and env.get("from_did") == self._homenode_did
                        and env.get("to_did") == did):
                    self._pending[env["id"]] = env

            # 9. Timeout — send best-effort cancel so Core can abort in-progress work.
            self._send_cancel(ws, rid, did)
            raise TransportError("Home Node did not respond. It may be offline.")
        finally:
            ws.close()

    def _connect_and_auth(self) -> websockets.sync.client.ClientConnection:
        """Connect to MsgBox and perform Ed25519 challenge-response auth."""
        try:
            # compression=None disables permessage-deflate. The MsgBox server
            # (Go coder/websocket) rejects compressed frames with RSV1 set as
            # "protocol error" and closes the socket. Must match server caps.
            ws = websockets.sync.client.connect(
                self._msgbox_url,
                open_timeout=5,
                close_timeout=2,
                compression=None,
            )
        except Exception as e:
            raise TransportError(f"MsgBox unreachable at {self._msgbox_url}: {e}") from e

        # Read challenge.
        try:
            chal_raw = ws.recv(timeout=5)
        except Exception as e:
            ws.close()
            raise TransportError(f"MsgBox auth challenge timeout: {e}") from e

        chal = json.loads(chal_raw)
        if chal.get("type") != "auth_challenge":
            ws.close()
            raise TransportError(f"unexpected auth frame: {chal.get('type')}")

        # Sign challenge.
        payload = f"AUTH_RELAY\n{chal['nonce']}\n{chal['ts']}"
        self._identity.ensure_loaded()
        priv_key = self._identity._private_key
        sig = priv_key.sign(payload.encode())
        pub_raw = self._identity._raw_public_key()

        resp = json.dumps({
            "type": "auth_response",
            "did": self._identity.did(),
            "sig": sig.hex(),
            "pub": pub_raw.hex(),
        })
        ws.send(resp)
        return ws

    def _send_cancel(self, ws, request_id: str, from_did: str) -> None:
        """Send best-effort cancel envelope. Don't block on failure."""
        try:
            cancel = json.dumps({
                "type": "cancel",
                "cancel_of": request_id,
                "from_did": from_did,
                "to_did": self._homenode_did,
            }).encode()
            ws.send(cancel)
        except Exception:
            pass  # best-effort — connection may already be closed

    def _drain_buffered(self, ws) -> None:
        """Consume any buffered envelopes sent immediately on connect."""
        import select
        while True:
            # Non-blocking check for available data.
            ready = select.select([ws.socket], [], [], 0.1)
            if not ready[0]:
                break
            try:
                data = ws.recv(timeout=0.5)
            except Exception:
                break
            if isinstance(data, (bytes, bytearray)):
                data = data.decode("utf-8", errors="replace")
            try:
                env = json.loads(data)
            except (json.JSONDecodeError, TypeError):
                continue
            if (env.get("type") == "rpc"
                    and env.get("direction") == "response"
                    and env.get("from_did") == self._homenode_did
                    and env.get("to_did") == self._identity.did()):
                self._pending[env["id"]] = env

    def _encrypt(self, plaintext: bytes) -> bytes:
        """Encrypt with Home Node's X25519 public key (NaCl sealed-box)."""
        if self._homenode_x25519_pub is None:
            raise TransportError(
                "Cannot send request: Home Node X25519 public key not available. "
                "PLC document lookup may have failed for " + self._homenode_did
            )
        recipient_pub = nacl.public.PublicKey(self._homenode_x25519_pub)
        sealed = nacl.public.SealedBox(recipient_pub).encrypt(plaintext)
        return sealed

    def _parse_response(self, env: dict) -> TransportResponse:
        """Parse a response envelope into TransportResponse."""
        ciphertext_raw = env.get("ciphertext", "{}")

        # Determine if the response is encrypted (base64) or plaintext JSON.
        is_encrypted = ciphertext_raw and not ciphertext_raw.startswith("{")

        inner_json = None
        if is_encrypted:
            # Encrypted response — must decrypt. No plaintext fallback.
            if not self._cli_x25519_priv:
                raise TransportError("Received encrypted response but CLI X25519 key is unavailable")
            try:
                ct_bytes = base64.b64decode(ciphertext_raw)
                priv_key = nacl.public.PrivateKey(self._cli_x25519_priv)
                unseal_box = nacl.public.SealedBox(priv_key)
                plaintext = unseal_box.decrypt(ct_bytes)
                inner_json = json.loads(plaintext)
            except Exception as e:
                raise TransportError(f"Response decryption failed: {e}") from e
        else:
            # Plaintext JSON response (error responses, or Core without encryption).
            try:
                inner_json = json.loads(ciphertext_raw)
            except (json.JSONDecodeError, TypeError):
                raise TransportError(f"Invalid response: not JSON and not encrypted")

        return TransportResponse(
            status=inner_json.get("status", 200),
            headers=inner_json.get("headers", {}),
            body=inner_json.get("body", ""),
        )


def select_transport(
    mode: str,
    core_url: str | None,
    msgbox_url: str | None,
    homenode_did: str | None,
    timeout: float = 30.0,
) -> Transport:
    """Select transport based on mode.

    Args:
        mode: "direct", "msgbox", or "auto"
        core_url: Direct URL to Core (e.g., "http://localhost:18100")
        msgbox_url: MsgBox WebSocket URL (e.g., "wss://mailbox.dinakernel.com")
        homenode_did: Home Node DID for MsgBox addressing
        timeout: Request timeout in seconds

    Returns:
        A Transport instance.

    Raises:
        TransportError: If the selected transport cannot be created.
    """
    if mode == "direct":
        if not core_url:
            raise TransportError("transport=direct requires core_url")
        return DirectTransport(core_url, timeout)

    if mode == "msgbox":
        if not msgbox_url or not homenode_did:
            raise TransportError("transport=msgbox requires msgbox_url and homenode_did")
        return MsgBoxTransport(msgbox_url, homenode_did, timeout=timeout)

    if mode == "auto":
        # Try direct first.
        if core_url:
            try:
                resp = httpx.get(f"{core_url.rstrip('/')}/healthz", timeout=2.0)
                if resp.status_code == 200:
                    return DirectTransport(core_url, timeout)
            except (httpx.ConnectError, httpx.TimeoutException):
                pass

        # Fall back to msgbox.
        if msgbox_url and homenode_did:
            return MsgBoxTransport(msgbox_url, homenode_did, timeout=timeout)

        raise TransportError("Home Node unreachable")

    raise TransportError(f"unknown transport mode: {mode}")
