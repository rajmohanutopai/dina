"""Unit tests for dina.models — ProductVerdict with v0.3 signature fields."""

from __future__ import annotations

import json

import pytest
from pydantic import ValidationError

from dina.models import ProductVerdict


class TestProductVerdictSignatureFields:
    """Tests for the v0.3 signature_hex and signer_did fields."""

    def test_signature_fields_default_to_none(self):
        """New verdicts have signature_hex=None and signer_did=None by default."""
        v = ProductVerdict(
            product_name="Test",
            verdict="BUY",
            confidence_score=75,
            pros=["good"],
            cons=["bad"],
            expert_source="Source",
        )
        assert v.signature_hex is None
        assert v.signer_did is None

    def test_signature_fields_optional(self):
        """Verdicts can be created without signature fields (backward compat)."""
        v = ProductVerdict(
            product_name="Test",
            verdict="WAIT",
            confidence_score=50,
            pros=["ok"],
            cons=["ok"],
            expert_source="Source",
        )
        # No ValidationError raised
        assert v.product_name == "Test"

    def test_signature_fields_can_be_set(self):
        """Signature fields can be explicitly set."""
        v = ProductVerdict(
            product_name="Test",
            verdict="AVOID",
            confidence_score=10,
            pros=["nothing"],
            cons=["everything"],
            expert_source="Source",
            signature_hex="abcdef01",
            signer_did="did:key:z6MkTest",
        )
        assert v.signature_hex == "abcdef01"
        assert v.signer_did == "did:key:z6MkTest"

    def test_signature_fields_mutable(self):
        """Signature fields can be set after construction."""
        v = ProductVerdict(
            product_name="Test",
            verdict="BUY",
            confidence_score=90,
            pros=["great"],
            cons=["minor"],
            expert_source="Source",
        )
        v.signature_hex = "deadbeef"
        v.signer_did = "did:key:z6MkTest"
        assert v.signature_hex == "deadbeef"
        assert v.signer_did == "did:key:z6MkTest"

    def test_json_includes_signature_when_set(self):
        """JSON output includes signature fields when they're set."""
        v = ProductVerdict(
            product_name="Test",
            verdict="BUY",
            confidence_score=90,
            pros=["great"],
            cons=["minor"],
            expert_source="Source",
            signature_hex="abcd1234",
            signer_did="did:key:z6MkTest",
        )
        data = json.loads(v.model_dump_json())
        assert data["signature_hex"] == "abcd1234"
        assert data["signer_did"] == "did:key:z6MkTest"

    def test_json_includes_null_when_unset(self):
        """JSON output includes null for unset signature fields."""
        v = ProductVerdict(
            product_name="Test",
            verdict="BUY",
            confidence_score=90,
            pros=["great"],
            cons=["minor"],
            expert_source="Source",
        )
        data = json.loads(v.model_dump_json())
        assert data["signature_hex"] is None
        assert data["signer_did"] is None

    def test_model_dump_exclude_signature_fields(self):
        """Signature fields can be excluded via model_dump(exclude=...)."""
        v = ProductVerdict(
            product_name="Test",
            verdict="BUY",
            confidence_score=90,
            pros=["great"],
            cons=["minor"],
            expert_source="Source",
            signature_hex="abcd",
            signer_did="did:key:z6MkTest",
        )
        data = v.model_dump(exclude={"signature_hex", "signer_did"})
        assert "signature_hex" not in data
        assert "signer_did" not in data


class TestProductVerdictStreamIdField:
    """Tests for the v0.4 stream_id field."""

    def test_stream_id_defaults_to_none(self):
        """New verdicts have stream_id=None by default."""
        v = ProductVerdict(
            product_name="Test",
            verdict="BUY",
            confidence_score=75,
            pros=["good"],
            cons=["bad"],
            expert_source="Source",
        )
        assert v.stream_id is None

    def test_stream_id_can_be_set(self):
        """stream_id can be explicitly set at construction."""
        v = ProductVerdict(
            product_name="Test",
            verdict="BUY",
            confidence_score=75,
            pros=["good"],
            cons=["bad"],
            expert_source="Source",
            stream_id="kjzl6abc123",
        )
        assert v.stream_id == "kjzl6abc123"

    def test_stream_id_mutable(self):
        """stream_id can be set after construction."""
        v = ProductVerdict(
            product_name="Test",
            verdict="BUY",
            confidence_score=90,
            pros=["great"],
            cons=["minor"],
            expert_source="Source",
        )
        v.stream_id = "kjzl6xyz789"
        assert v.stream_id == "kjzl6xyz789"

    def test_json_includes_stream_id_when_set(self):
        """JSON output includes stream_id when it's set."""
        v = ProductVerdict(
            product_name="Test",
            verdict="BUY",
            confidence_score=90,
            pros=["great"],
            cons=["minor"],
            expert_source="Source",
            stream_id="kjzl6abc123",
        )
        data = json.loads(v.model_dump_json())
        assert data["stream_id"] == "kjzl6abc123"


class TestProductVerdictCoreValidation:
    """Tests for existing ProductVerdict validation (ensure v0.3 didn't break anything)."""

    def test_valid_buy_verdict(self):
        """A valid BUY verdict passes validation."""
        v = ProductVerdict(
            product_name="iPhone 16",
            verdict="BUY",
            confidence_score=92,
            pros=["great camera", "fast chip"],
            cons=["expensive"],
            expert_source="MKBHD",
        )
        assert v.verdict == "BUY"

    def test_valid_wait_verdict(self):
        """A valid WAIT verdict passes validation."""
        v = ProductVerdict(
            product_name="MacBook Pro",
            verdict="WAIT",
            confidence_score=55,
            pros=["M4 chip"],
            cons=["no redesign"],
            expert_source="LTT",
        )
        assert v.verdict == "WAIT"

    def test_valid_avoid_verdict(self):
        """A valid AVOID verdict passes validation."""
        v = ProductVerdict(
            product_name="Cheap Earbuds",
            verdict="AVOID",
            confidence_score=15,
            pros=["cheap"],
            cons=["terrible sound", "breaks easily"],
            expert_source="DankPods",
        )
        assert v.verdict == "AVOID"

    def test_invalid_verdict_value(self):
        """Invalid verdict literal raises ValidationError."""
        with pytest.raises(ValidationError):
            ProductVerdict(
                product_name="Test",
                verdict="MAYBE",
                confidence_score=50,
                pros=["ok"],
                cons=["ok"],
                expert_source="Source",
            )

    def test_confidence_score_range(self):
        """confidence_score must be 0-100."""
        with pytest.raises(ValidationError):
            ProductVerdict(
                product_name="Test",
                verdict="BUY",
                confidence_score=101,
                pros=["ok"],
                cons=["ok"],
                expert_source="Source",
            )

    def test_confidence_score_negative(self):
        """Negative confidence_score raises ValidationError."""
        with pytest.raises(ValidationError):
            ProductVerdict(
                product_name="Test",
                verdict="BUY",
                confidence_score=-1,
                pros=["ok"],
                cons=["ok"],
                expert_source="Source",
            )

    def test_hidden_warnings_default_empty(self):
        """hidden_warnings defaults to an empty list."""
        v = ProductVerdict(
            product_name="Test",
            verdict="BUY",
            confidence_score=90,
            pros=["great"],
            cons=["minor"],
            expert_source="Source",
        )
        assert v.hidden_warnings == []

    def test_json_roundtrip(self, sample_verdict: ProductVerdict):
        """ProductVerdict survives JSON serialization and deserialization."""
        json_str = sample_verdict.model_dump_json()
        loaded = ProductVerdict.model_validate_json(json_str)
        assert loaded.product_name == sample_verdict.product_name
        assert loaded.verdict == sample_verdict.verdict
        assert loaded.confidence_score == sample_verdict.confidence_score
