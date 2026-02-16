"""Unit tests for dina.identity — Ed25519 keypair management."""

from __future__ import annotations

import os
import stat
from pathlib import Path

import pytest

from dina.identity import DinaIdentity


class TestKeyGeneration:
    """Tests for first-run key generation."""

    def test_generates_keypair_on_first_run(self, tmp_identity_dir: Path):
        """DinaIdentity creates PEM files when none exist."""
        identity = DinaIdentity(identity_dir=tmp_identity_dir)
        assert (tmp_identity_dir / "ed25519_private.pem").exists()
        assert (tmp_identity_dir / "ed25519_public.pem").exists()

    def test_creates_directory_if_missing(self, tmp_path: Path):
        """DinaIdentity creates the identity directory if it doesn't exist."""
        nested = tmp_path / "deep" / "nested" / "identity"
        identity = DinaIdentity(identity_dir=nested)
        assert nested.exists()
        assert (nested / "ed25519_private.pem").exists()

    def test_private_key_permissions(self, tmp_identity_dir: Path):
        """Private key file has restrictive permissions (owner read/write only)."""
        identity = DinaIdentity(identity_dir=tmp_identity_dir)
        private_key_path = tmp_identity_dir / "ed25519_private.pem"
        file_stat = os.stat(private_key_path)
        mode = stat.S_IMODE(file_stat.st_mode)
        assert mode == 0o600, f"Expected 0600, got {oct(mode)}"

    def test_public_key_is_32_bytes(self, identity: DinaIdentity):
        """Raw Ed25519 public key is exactly 32 bytes."""
        raw = identity.public_key_bytes()
        assert len(raw) == 32

    def test_private_key_seed_is_32_bytes(self, identity: DinaIdentity):
        """Raw Ed25519 private key seed is exactly 32 bytes."""
        seed = identity.private_key_seed()
        assert len(seed) == 32

    def test_pem_files_are_valid_pem(self, tmp_identity_dir: Path):
        """Generated PEM files contain valid PEM headers."""
        DinaIdentity(identity_dir=tmp_identity_dir)
        private_pem = (tmp_identity_dir / "ed25519_private.pem").read_text()
        public_pem = (tmp_identity_dir / "ed25519_public.pem").read_text()
        assert private_pem.startswith("-----BEGIN PRIVATE KEY-----")
        assert public_pem.startswith("-----BEGIN PUBLIC KEY-----")


class TestKeyPersistence:
    """Tests for loading existing keys from disk."""

    def test_reload_produces_same_public_key(self, tmp_identity_dir: Path):
        """Loading from existing PEM files returns the same public key."""
        id1 = DinaIdentity(identity_dir=tmp_identity_dir)
        id2 = DinaIdentity(identity_dir=tmp_identity_dir)
        assert id1.public_key_bytes() == id2.public_key_bytes()

    def test_reload_produces_same_private_seed(self, tmp_identity_dir: Path):
        """Loading from existing PEM files returns the same private seed."""
        id1 = DinaIdentity(identity_dir=tmp_identity_dir)
        id2 = DinaIdentity(identity_dir=tmp_identity_dir)
        assert id1.private_key_seed() == id2.private_key_seed()

    def test_two_separate_dirs_produce_different_keys(self, tmp_path: Path):
        """Two identities in different directories have different keys."""
        id1 = DinaIdentity(identity_dir=tmp_path / "a")
        id2 = DinaIdentity(identity_dir=tmp_path / "b")
        assert id1.public_key_bytes() != id2.public_key_bytes()


class TestSignAndVerify:
    """Tests for signing and verification operations."""

    def test_sign_returns_bytes(self, identity: DinaIdentity):
        """sign() returns a bytes object."""
        sig = identity.sign(b"hello world")
        assert isinstance(sig, bytes)

    def test_signature_is_64_bytes(self, identity: DinaIdentity):
        """Ed25519 signatures are 64 bytes."""
        sig = identity.sign(b"test data")
        assert len(sig) == 64

    def test_verify_valid_signature(self, identity: DinaIdentity):
        """verify() returns True for a valid signature."""
        data = b"authentic message"
        sig = identity.sign(data)
        assert identity.verify(sig, data) is True

    def test_verify_tampered_data(self, identity: DinaIdentity):
        """verify() returns False when data has been tampered with."""
        data = b"original message"
        sig = identity.sign(data)
        assert identity.verify(sig, b"tampered message") is False

    def test_verify_tampered_signature(self, identity: DinaIdentity):
        """verify() returns False when signature bytes are altered."""
        data = b"message"
        sig = identity.sign(data)
        tampered_sig = bytes([b ^ 0xFF for b in sig[:4]]) + sig[4:]
        assert identity.verify(tampered_sig, data) is False

    def test_verify_wrong_identity(self, tmp_path: Path):
        """Signature from one identity doesn't verify with another."""
        id1 = DinaIdentity(identity_dir=tmp_path / "signer")
        id2 = DinaIdentity(identity_dir=tmp_path / "verifier")
        data = b"cross-identity test"
        sig = id1.sign(data)
        assert id2.verify(sig, data) is False

    def test_sign_empty_data(self, identity: DinaIdentity):
        """Signing empty data should still work."""
        sig = identity.sign(b"")
        assert len(sig) == 64
        assert identity.verify(sig, b"") is True

    def test_sign_large_data(self, identity: DinaIdentity):
        """Signing large data works (Ed25519 hashes internally)."""
        data = b"x" * 1_000_000
        sig = identity.sign(data)
        assert identity.verify(sig, data) is True

    def test_deterministic_signatures(self, identity: DinaIdentity):
        """Ed25519 signatures are deterministic — same input, same output."""
        data = b"deterministic"
        sig1 = identity.sign(data)
        sig2 = identity.sign(data)
        assert sig1 == sig2

    def test_public_key_property(self, identity: DinaIdentity):
        """public_key property returns an Ed25519PublicKey instance."""
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

        assert isinstance(identity.public_key, Ed25519PublicKey)
