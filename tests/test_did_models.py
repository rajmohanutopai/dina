"""Unit tests for dina.did_models — W3C DID Document Pydantic schemas."""

from __future__ import annotations

import json

import pytest

pytestmark = pytest.mark.legacy

from dina.did_models import DIDDocument, VerificationMethod


class TestVerificationMethod:
    """Tests for the VerificationMethod model."""

    def test_create_with_alias(self):
        """publicKeyMultibase alias populates the field."""
        vm = VerificationMethod(
            id="did:key:z6Mk...#z6Mk...",
            type="Ed25519VerificationKey2020",
            controller="did:key:z6Mk...",
            publicKeyMultibase="z6Mk...",
        )
        assert vm.public_key_multibase == "z6Mk..."

    def test_create_with_field_name(self):
        """populate_by_name allows using the Python field name directly."""
        vm = VerificationMethod(
            id="did:key:z6Mk...#z6Mk...",
            type="Ed25519VerificationKey2020",
            controller="did:key:z6Mk...",
            public_key_multibase="z6Mk...",
        )
        assert vm.public_key_multibase == "z6Mk..."

    def test_serialize_uses_alias(self):
        """JSON output uses publicKeyMultibase (camelCase), not the Python name."""
        vm = VerificationMethod(
            id="did:key:z6Mk...#z6Mk...",
            type="Ed25519VerificationKey2020",
            controller="did:key:z6Mk...",
            publicKeyMultibase="z6MkTestKey",
        )
        data = vm.model_dump(by_alias=True)
        assert "publicKeyMultibase" in data
        assert data["publicKeyMultibase"] == "z6MkTestKey"

    def test_serialize_without_alias(self):
        """model_dump without by_alias uses Python field names."""
        vm = VerificationMethod(
            id="did:key:z6Mk...#z6Mk...",
            type="Ed25519VerificationKey2020",
            controller="did:key:z6Mk...",
            publicKeyMultibase="z6MkTestKey",
        )
        data = vm.model_dump()
        assert "public_key_multibase" in data


class TestDIDDocument:
    """Tests for the DIDDocument model."""

    def _make_doc(self) -> DIDDocument:
        vm = VerificationMethod(
            id="did:key:z6MkTest#z6MkTest",
            type="Ed25519VerificationKey2020",
            controller="did:key:z6MkTest",
            publicKeyMultibase="z6MkTest",
        )
        return DIDDocument(
            id="did:key:z6MkTest",
            verificationMethod=[vm],
            authentication=["did:key:z6MkTest#z6MkTest"],
            assertionMethod=["did:key:z6MkTest#z6MkTest"],
        )

    def test_default_context(self):
        """@context defaults to W3C DID v1 and Ed25519-2020 suite."""
        doc = self._make_doc()
        assert len(doc.context) == 2
        assert "https://www.w3.org/ns/did/v1" in doc.context
        assert "https://w3id.org/security/suites/ed25519-2020/v1" in doc.context

    def test_serialize_with_at_context(self):
        """JSON output uses @context (not 'context') when by_alias=True."""
        doc = self._make_doc()
        data = doc.model_dump(by_alias=True)
        assert "@context" in data
        assert "context" not in data

    def test_serialize_verification_method_alias(self):
        """JSON output uses verificationMethod (camelCase)."""
        doc = self._make_doc()
        data = doc.model_dump(by_alias=True)
        assert "verificationMethod" in data
        assert "assertionMethod" in data

    def test_json_roundtrip(self):
        """DIDDocument survives JSON serialization and deserialization."""
        doc = self._make_doc()
        json_str = json.dumps(doc.model_dump(by_alias=True))
        parsed = json.loads(json_str)
        assert parsed["id"] == "did:key:z6MkTest"
        assert len(parsed["verificationMethod"]) == 1
        assert parsed["verificationMethod"][0]["type"] == "Ed25519VerificationKey2020"

    def test_multiple_verification_methods(self):
        """DIDDocument supports multiple verification methods."""
        vm1 = VerificationMethod(
            id="did:key:z6MkA#z6MkA",
            type="Ed25519VerificationKey2020",
            controller="did:key:z6MkA",
            publicKeyMultibase="z6MkA",
        )
        vm2 = VerificationMethod(
            id="did:key:z6MkA#z6MkB",
            type="Ed25519VerificationKey2020",
            controller="did:key:z6MkA",
            publicKeyMultibase="z6MkB",
        )
        doc = DIDDocument(
            id="did:key:z6MkA",
            verificationMethod=[vm1, vm2],
            authentication=["did:key:z6MkA#z6MkA"],
            assertionMethod=["did:key:z6MkA#z6MkA"],
        )
        assert len(doc.verification_method) == 2
