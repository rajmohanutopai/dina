"""Unit tests for dina.signing — verdict signing and verification."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

pytestmark = pytest.mark.legacy

from dina.identity import DinaIdentity
from dina.models import ProductVerdict
from dina.signing import canonicalize_verdict, sign_verdict, verify_verdict_signature


class TestCanonicalizeVerdict:
    """Tests for canonicalize_verdict()."""

    def test_returns_json_string(self, sample_verdict: ProductVerdict):
        """canonicalize_verdict returns a JSON string."""
        result = canonicalize_verdict(sample_verdict)
        json.loads(result)  # should not raise

    def test_excludes_signature_hex(self, sample_verdict: ProductVerdict):
        """signature_hex is excluded from canonical form."""
        sample_verdict.signature_hex = "deadbeef"
        result = canonicalize_verdict(sample_verdict)
        parsed = json.loads(result)
        assert "signature_hex" not in parsed

    def test_excludes_signer_did(self, sample_verdict: ProductVerdict):
        """signer_did is excluded from canonical form."""
        sample_verdict.signer_did = "did:key:z6MkTest"
        result = canonicalize_verdict(sample_verdict)
        parsed = json.loads(result)
        assert "signer_did" not in parsed

    def test_keys_are_sorted(self, sample_verdict: ProductVerdict):
        """Canonical JSON has sorted keys for determinism."""
        result = canonicalize_verdict(sample_verdict)
        parsed = json.loads(result)
        keys = list(parsed.keys())
        assert keys == sorted(keys)

    def test_no_whitespace_separators(self, sample_verdict: ProductVerdict):
        """Canonical JSON uses compact separators (no spaces after : or ,)."""
        result = canonicalize_verdict(sample_verdict)
        # No space after colon or comma in compact JSON
        assert ": " not in result
        assert ", " not in result

    def test_deterministic(self, sample_verdict: ProductVerdict):
        """Same verdict always produces the same canonical string."""
        c1 = canonicalize_verdict(sample_verdict)
        c2 = canonicalize_verdict(sample_verdict)
        assert c1 == c2

    def test_includes_all_verdict_fields(self, sample_verdict: ProductVerdict):
        """Canonical JSON includes all verdict fields (except signature ones)."""
        result = canonicalize_verdict(sample_verdict)
        parsed = json.loads(result)
        expected_keys = {
            "product_name",
            "verdict",
            "confidence_score",
            "pros",
            "cons",
            "hidden_warnings",
            "expert_source",
        }
        assert set(parsed.keys()) == expected_keys

    def test_excludes_stream_id(self, sample_verdict: ProductVerdict):
        """stream_id is excluded from canonical form (v0.4)."""
        sample_verdict.stream_id = "kjzl6abc123"
        result = canonicalize_verdict(sample_verdict)
        parsed = json.loads(result)
        assert "stream_id" not in parsed

    def test_different_verdicts_produce_different_canonical(self):
        """Two different verdicts produce different canonical JSON."""
        v1 = ProductVerdict(
            product_name="Product A",
            verdict="BUY",
            confidence_score=90,
            pros=["great"],
            cons=["none"],
            expert_source="Source1",
        )
        v2 = ProductVerdict(
            product_name="Product B",
            verdict="AVOID",
            confidence_score=20,
            pros=["cheap"],
            cons=["terrible"],
            expert_source="Source2",
        )
        assert canonicalize_verdict(v1) != canonicalize_verdict(v2)

    def test_empty_lists_included(self):
        """Empty lists in the verdict are preserved in canonical form."""
        v = ProductVerdict(
            product_name="Test",
            verdict="WAIT",
            confidence_score=50,
            pros=[],
            cons=[],
            hidden_warnings=[],
            expert_source="Test",
        )
        result = canonicalize_verdict(v)
        parsed = json.loads(result)
        assert parsed["pros"] == []
        assert parsed["cons"] == []
        assert parsed["hidden_warnings"] == []


class TestSignVerdict:
    """Tests for sign_verdict()."""

    def test_returns_tuple(self, sample_verdict: ProductVerdict, identity: DinaIdentity):
        """sign_verdict returns a (signature_hex, signer_did) tuple."""
        result = sign_verdict(sample_verdict, identity)
        assert isinstance(result, tuple)
        assert len(result) == 2

    def test_signature_hex_is_hex_string(
        self, sample_verdict: ProductVerdict, identity: DinaIdentity
    ):
        """The signature is a valid hex-encoded string."""
        sig_hex, _ = sign_verdict(sample_verdict, identity)
        bytes.fromhex(sig_hex)  # should not raise

    def test_signature_hex_is_128_chars(
        self, sample_verdict: ProductVerdict, identity: DinaIdentity
    ):
        """64 bytes = 128 hex characters."""
        sig_hex, _ = sign_verdict(sample_verdict, identity)
        assert len(sig_hex) == 128

    def test_signer_did_starts_with_did_key(
        self, sample_verdict: ProductVerdict, identity: DinaIdentity
    ):
        """The signer DID is a did:key identifier."""
        _, did = sign_verdict(sample_verdict, identity)
        assert did.startswith("did:key:z6Mk")

    def test_deterministic(self, sample_verdict: ProductVerdict, identity: DinaIdentity):
        """Same verdict + same identity = same signature."""
        sig1, did1 = sign_verdict(sample_verdict, identity)
        sig2, did2 = sign_verdict(sample_verdict, identity)
        assert sig1 == sig2
        assert did1 == did2

    def test_different_verdict_different_signature(self, identity: DinaIdentity):
        """Different verdicts produce different signatures."""
        v1 = ProductVerdict(
            product_name="A",
            verdict="BUY",
            confidence_score=90,
            pros=["good"],
            cons=["bad"],
            expert_source="S1",
        )
        v2 = ProductVerdict(
            product_name="B",
            verdict="AVOID",
            confidence_score=10,
            pros=["cheap"],
            cons=["awful"],
            expert_source="S2",
        )
        sig1, _ = sign_verdict(v1, identity)
        sig2, _ = sign_verdict(v2, identity)
        assert sig1 != sig2

    def test_different_identity_different_signature(
        self, sample_verdict: ProductVerdict, tmp_path: Path
    ):
        """Same verdict signed by different identities produces different signatures."""
        id1 = DinaIdentity(identity_dir=tmp_path / "signer1")
        id2 = DinaIdentity(identity_dir=tmp_path / "signer2")
        sig1, did1 = sign_verdict(sample_verdict, id1)
        sig2, did2 = sign_verdict(sample_verdict, id2)
        assert sig1 != sig2
        assert did1 != did2


class TestVerifyVerdictSignature:
    """Tests for verify_verdict_signature()."""

    def test_valid_signature(self, sample_verdict: ProductVerdict, identity: DinaIdentity):
        """A correctly signed verdict verifies as True."""
        canonical = canonicalize_verdict(sample_verdict)
        sig_hex, _ = sign_verdict(sample_verdict, identity)
        assert verify_verdict_signature(canonical, sig_hex, identity) is True

    def test_tampered_canonical_json(
        self, sample_verdict: ProductVerdict, identity: DinaIdentity
    ):
        """Verification fails if the canonical JSON has been altered."""
        canonical = canonicalize_verdict(sample_verdict)
        sig_hex, _ = sign_verdict(sample_verdict, identity)
        tampered = canonical.replace("Pixel 9 Pro", "Pixel 9 Fake")
        assert verify_verdict_signature(tampered, sig_hex, identity) is False

    def test_tampered_signature(self, sample_verdict: ProductVerdict, identity: DinaIdentity):
        """Verification fails if the signature hex has been altered."""
        canonical = canonicalize_verdict(sample_verdict)
        sig_hex, _ = sign_verdict(sample_verdict, identity)
        # Flip some bits in the signature
        tampered_sig = "ff" + sig_hex[2:]
        assert verify_verdict_signature(canonical, tampered_sig, identity) is False

    def test_wrong_identity(self, sample_verdict: ProductVerdict, tmp_path: Path):
        """Verification fails when using a different identity's public key."""
        signer = DinaIdentity(identity_dir=tmp_path / "signer")
        verifier = DinaIdentity(identity_dir=tmp_path / "verifier")
        canonical = canonicalize_verdict(sample_verdict)
        sig_hex, _ = sign_verdict(sample_verdict, signer)
        assert verify_verdict_signature(canonical, sig_hex, verifier) is False

    def test_invalid_hex_raises(self, identity: DinaIdentity):
        """Invalid hex string raises ValueError."""
        with pytest.raises(ValueError):
            verify_verdict_signature('{"test": 1}', "not_hex!", identity)

    def test_signature_fields_dont_affect_verification(
        self, sample_verdict: ProductVerdict, identity: DinaIdentity
    ):
        """Signing before vs after setting signature_hex produces same canonical."""
        canonical_before = canonicalize_verdict(sample_verdict)
        sample_verdict.signature_hex = "deadbeef" * 16
        sample_verdict.signer_did = "did:key:z6MkTest"
        canonical_after = canonicalize_verdict(sample_verdict)
        assert canonical_before == canonical_after


class TestEndToEndSigning:
    """End-to-end signing workflow tests."""

    def test_sign_then_verify(self, sample_verdict: ProductVerdict, identity: DinaIdentity):
        """Full workflow: canonicalize → sign → verify."""
        sig_hex, did = sign_verdict(sample_verdict, identity)
        canonical = canonicalize_verdict(sample_verdict)
        assert verify_verdict_signature(canonical, sig_hex, identity) is True

    def test_sign_set_fields_then_verify(
        self, sample_verdict: ProductVerdict, identity: DinaIdentity
    ):
        """Workflow mirrors chat.py: sign, set fields on verdict, then verify."""
        sig_hex, did = sign_verdict(sample_verdict, identity)
        sample_verdict.signature_hex = sig_hex
        sample_verdict.signer_did = did
        # Now canonicalize — should still exclude sig fields
        canonical = canonicalize_verdict(sample_verdict)
        assert verify_verdict_signature(canonical, sig_hex, identity) is True

    def test_roundtrip_through_json(
        self, sample_verdict: ProductVerdict, identity: DinaIdentity
    ):
        """Sign → serialize verdict to JSON → deserialize → verify."""
        sig_hex, did = sign_verdict(sample_verdict, identity)
        sample_verdict.signature_hex = sig_hex
        sample_verdict.signer_did = did

        json_str = sample_verdict.model_dump_json()
        loaded = ProductVerdict.model_validate_json(json_str)

        canonical = canonicalize_verdict(loaded)
        assert verify_verdict_signature(canonical, loaded.signature_hex, identity) is True
