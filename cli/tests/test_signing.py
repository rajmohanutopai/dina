"""Tests for the Ed25519 signing module."""

from __future__ import annotations

import hashlib
import os
import stat

import base58
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

import pytest

from dina_cli.signing import CLIIdentity, _ED25519_MULTICODEC


# -- Keypair generation & persistence -----------------------------------------


# TST-CLI-001
def test_generate_creates_files(tmp_path):
    identity = CLIIdentity(identity_dir=tmp_path)
    assert not identity.exists
    identity.generate()
    assert identity.exists
    assert (tmp_path / "ed25519_private.pem").exists()
    assert (tmp_path / "ed25519_public.pem").exists()


# TST-CLI-002
def test_private_key_permissions(tmp_path):
    identity = CLIIdentity(identity_dir=tmp_path)
    identity.generate()
    mode = os.stat(tmp_path / "ed25519_private.pem").st_mode
    assert mode & 0o777 == stat.S_IRUSR | stat.S_IWUSR  # 0600


# TST-CLI-003
def test_load_existing_keypair(tmp_path):
    # Generate, then load in a fresh instance.
    CLIIdentity(identity_dir=tmp_path).generate()
    loaded = CLIIdentity(identity_dir=tmp_path)
    loaded.load()
    assert loaded.did().startswith("did:key:z")


# TST-CLI-004
def test_ensure_loaded_auto_loads(tmp_path):
    CLIIdentity(identity_dir=tmp_path).generate()
    identity = CLIIdentity(identity_dir=tmp_path)
    identity.ensure_loaded()
    assert identity.did().startswith("did:key:z")


# TST-CLI-005
def test_ensure_loaded_raises_when_missing(tmp_path):
    identity = CLIIdentity(identity_dir=tmp_path)
    with pytest.raises(FileNotFoundError, match="No keypair found"):
        identity.ensure_loaded()


# -- DID derivation ------------------------------------------------------------


# TST-CLI-006
def test_did_format(tmp_path):
    identity = CLIIdentity(identity_dir=tmp_path)
    identity.generate()
    did = identity.did()
    assert did.startswith("did:key:z6Mk"), f"Ed25519 did:key should start with z6Mk, got {did}"


# TST-CLI-007
def test_did_deterministic(tmp_path):
    identity = CLIIdentity(identity_dir=tmp_path)
    identity.generate()
    assert identity.did() == identity.did()


# TST-CLI-008
def test_did_different_keys(tmp_path):
    id1 = CLIIdentity(identity_dir=tmp_path / "a")
    id1.generate()
    id2 = CLIIdentity(identity_dir=tmp_path / "b")
    id2.generate()
    assert id1.did() != id2.did()


# -- public_key_multibase -----------------------------------------------------


# TST-CLI-009
def test_public_key_multibase_format(tmp_path):
    identity = CLIIdentity(identity_dir=tmp_path)
    identity.generate()
    mb = identity.public_key_multibase()
    assert mb.startswith("z"), "Multibase should start with 'z' (base58btc)"

    # Decode and verify multicodec prefix.
    raw = base58.b58decode(mb[1:])
    assert raw[:2] == _ED25519_MULTICODEC
    assert len(raw) == 34  # 2 bytes multicodec + 32 bytes pubkey


# TST-CLI-010
def test_public_key_multibase_roundtrip(tmp_path):
    """Verify the multibase encodes the correct public key."""
    identity = CLIIdentity(identity_dir=tmp_path)
    identity.generate()
    mb = identity.public_key_multibase()
    raw = base58.b58decode(mb[1:])
    pubkey_bytes = raw[2:]  # strip multicodec

    # Compare with the actual public key.
    actual = identity._raw_public_key()
    assert pubkey_bytes == actual


# -- Request signing -----------------------------------------------------------


# TST-CLI-011
def test_sign_request_returns_three_parts(tmp_path):
    identity = CLIIdentity(identity_dir=tmp_path)
    identity.generate()
    did, ts, sig = identity.sign_request("POST", "/v1/vault/query", b'{"test":1}')
    assert did.startswith("did:key:z")
    assert "T" in ts and ts.endswith("Z")  # ISO 8601 UTC
    assert len(sig) == 128  # 64 bytes hex-encoded


# TST-CLI-012
def test_sign_request_verifiable(tmp_path):
    """Verify the signature matches the canonical payload."""
    identity = CLIIdentity(identity_dir=tmp_path)
    identity.generate()
    body = b'{"action":"test"}'
    did, ts, sig_hex = identity.sign_request("GET", "/v1/did", body)

    # Reconstruct the canonical payload (5-part: method, path, query, timestamp, body_hash).
    body_hash = hashlib.sha256(body).hexdigest()
    payload = f"GET\n/v1/did\n\n{ts}\n{body_hash}"

    # Verify with the public key.
    pubkey = identity._private_key.public_key()
    sig_bytes = bytes.fromhex(sig_hex)
    pubkey.verify(sig_bytes, payload.encode("utf-8"))  # raises on failure


# TST-CLI-013
def test_sign_request_empty_body(tmp_path):
    """GET requests with no body use SHA-256 of empty string."""
    identity = CLIIdentity(identity_dir=tmp_path)
    identity.generate()
    did, ts, sig_hex = identity.sign_request("GET", "/healthz")

    empty_hash = hashlib.sha256(b"").hexdigest()
    payload = f"GET\n/healthz\n\n{ts}\n{empty_hash}"

    pubkey = identity._private_key.public_key()
    pubkey.verify(bytes.fromhex(sig_hex), payload.encode("utf-8"))


# TST-CLI-014
def test_sign_request_different_payloads_differ(tmp_path):
    identity = CLIIdentity(identity_dir=tmp_path)
    identity.generate()
    _, _, sig1 = identity.sign_request("POST", "/a", b"body1")
    _, _, sig2 = identity.sign_request("POST", "/b", b"body2")
    assert sig1 != sig2
