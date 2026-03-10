"""Unit tests for dina.did_key — did:key derivation and DID Document production."""

from __future__ import annotations

import json
from pathlib import Path

import base58
import pytest

pytestmark = pytest.mark.legacy

from dina.did_key import (
    _ED25519_MULTICODEC_PREFIX,
    derive_did_key,
    produce_did_document,
)
from dina.identity import DinaIdentity


class TestDeriveDIDKey:
    """Tests for derive_did_key()."""

    def test_starts_with_did_key_z(self, identity: DinaIdentity):
        """did:key identifiers start with 'did:key:z'."""
        did = derive_did_key(identity)
        assert did.startswith("did:key:z")

    def test_multibase_prefix_z_means_base58btc(self, identity: DinaIdentity):
        """The 'z' after did:key: indicates base58-btc encoding."""
        did = derive_did_key(identity)
        z_part = did.split(":")[-1]
        assert z_part[0] == "z"

    def test_encoded_key_decodes_to_correct_prefix(self, identity: DinaIdentity):
        """Decoding the base58 portion should reveal the 0xed01 multicodec prefix."""
        did = derive_did_key(identity)
        encoded_part = did.split(":")[-1][1:]  # strip the 'z' multibase prefix
        decoded = base58.b58decode(encoded_part)
        assert decoded[:2] == _ED25519_MULTICODEC_PREFIX

    def test_encoded_key_contains_public_key(self, identity: DinaIdentity):
        """The decoded payload after the 2-byte prefix should be the raw 32-byte pubkey."""
        did = derive_did_key(identity)
        encoded_part = did.split(":")[-1][1:]
        decoded = base58.b58decode(encoded_part)
        pubkey_from_did = decoded[2:]
        assert pubkey_from_did == identity.public_key_bytes()

    def test_deterministic(self, identity: DinaIdentity):
        """Same identity always produces the same DID."""
        did1 = derive_did_key(identity)
        did2 = derive_did_key(identity)
        assert did1 == did2

    def test_different_identities_produce_different_dids(self, tmp_path: Path):
        """Two different identities produce different DIDs."""
        id1 = DinaIdentity(identity_dir=tmp_path / "a")
        id2 = DinaIdentity(identity_dir=tmp_path / "b")
        assert derive_did_key(id1) != derive_did_key(id2)

    def test_did_key_starts_with_z6Mk(self, identity: DinaIdentity):
        """Ed25519 did:key values conventionally start with z6Mk after the prefix."""
        did = derive_did_key(identity)
        key_part = did.split(":")[-1]
        # z6Mk is the expected prefix for Ed25519 (multicodec 0xed = 0x80+0x6d,
        # base58 encoding of 0xed01 starts with "6Mk")
        assert key_part.startswith("z6Mk")

    def test_reload_identity_same_did(self, tmp_path: Path):
        """DID is stable across identity reloads (key persistence)."""
        dir_ = tmp_path / "stable"
        id1 = DinaIdentity(identity_dir=dir_)
        did1 = derive_did_key(id1)
        id2 = DinaIdentity(identity_dir=dir_)
        did2 = derive_did_key(id2)
        assert did1 == did2


class TestProduceDIDDocument:
    """Tests for produce_did_document()."""

    def test_document_id_matches_did(self, identity: DinaIdentity):
        """The DID Document's 'id' field matches derive_did_key()."""
        doc = produce_did_document(identity)
        expected_did = derive_did_key(identity)
        assert doc.id == expected_did

    def test_has_one_verification_method(self, identity: DinaIdentity):
        """The document contains exactly one verification method."""
        doc = produce_did_document(identity)
        assert len(doc.verification_method) == 1

    def test_verification_method_type(self, identity: DinaIdentity):
        """The verification method type is Ed25519VerificationKey2020."""
        doc = produce_did_document(identity)
        vm = doc.verification_method[0]
        assert vm.type == "Ed25519VerificationKey2020"

    def test_verification_method_controller(self, identity: DinaIdentity):
        """The verification method controller is the DID itself."""
        doc = produce_did_document(identity)
        vm = doc.verification_method[0]
        assert vm.controller == doc.id

    def test_verification_method_id_format(self, identity: DinaIdentity):
        """VM id is did#keyFragment."""
        doc = produce_did_document(identity)
        vm = doc.verification_method[0]
        assert vm.id.startswith(doc.id + "#")

    def test_authentication_references_vm(self, identity: DinaIdentity):
        """The authentication array references the verification method id."""
        doc = produce_did_document(identity)
        vm = doc.verification_method[0]
        assert vm.id in doc.authentication

    def test_assertion_method_references_vm(self, identity: DinaIdentity):
        """The assertionMethod array references the verification method id."""
        doc = produce_did_document(identity)
        vm = doc.verification_method[0]
        assert vm.id in doc.assertion_method

    def test_public_key_multibase_starts_with_z(self, identity: DinaIdentity):
        """publicKeyMultibase starts with 'z' (base58-btc multibase prefix)."""
        doc = produce_did_document(identity)
        vm = doc.verification_method[0]
        assert vm.public_key_multibase.startswith("z")

    def test_public_key_multibase_decodes_to_pubkey(self, identity: DinaIdentity):
        """Decoding publicKeyMultibase yields the multicodec prefix + raw pubkey."""
        doc = produce_did_document(identity)
        vm = doc.verification_method[0]
        decoded = base58.b58decode(vm.public_key_multibase[1:])  # strip 'z'
        assert decoded[:2] == _ED25519_MULTICODEC_PREFIX
        assert decoded[2:] == identity.public_key_bytes()

    def test_context_is_w3c_compliant(self, identity: DinaIdentity):
        """Default @context includes W3C DID v1."""
        doc = produce_did_document(identity)
        assert "https://www.w3.org/ns/did/v1" in doc.context

    def test_json_output_uses_aliases(self, identity: DinaIdentity):
        """JSON serialization uses W3C-standard field names."""
        doc = produce_did_document(identity)
        data = doc.model_dump(by_alias=True)
        assert "@context" in data
        assert "verificationMethod" in data
        assert "assertionMethod" in data
        # Check nested VM
        vm_data = data["verificationMethod"][0]
        assert "publicKeyMultibase" in vm_data

    def test_full_json_is_valid(self, identity: DinaIdentity):
        """The full JSON output is valid JSON and round-trips."""
        doc = produce_did_document(identity)
        json_str = json.dumps(doc.model_dump(by_alias=True))
        parsed = json.loads(json_str)
        assert parsed["id"] == doc.id
