"""Shared fixtures for Dina v0.3 test suite."""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from dina.identity import DinaIdentity
from dina.models import ProductVerdict


@pytest.fixture
def tmp_identity_dir(tmp_path: Path) -> Path:
    """Provide a temporary directory for identity key storage."""
    return tmp_path / "identity"


@pytest.fixture
def identity(tmp_identity_dir: Path) -> DinaIdentity:
    """Provide a freshly-generated DinaIdentity in a temp directory."""
    return DinaIdentity(identity_dir=tmp_identity_dir)


@pytest.fixture
def sample_verdict() -> ProductVerdict:
    """A minimal valid ProductVerdict for testing."""
    return ProductVerdict(
        product_name="Pixel 9 Pro",
        verdict="BUY",
        confidence_score=88,
        pros=["amazing camera", "clean software", "7 years updates"],
        cons=["expensive", "no charger in box"],
        hidden_warnings=["gets warm under load"],
        expert_source="MKBHD",
    )


@pytest.fixture
def signed_verdict(sample_verdict: ProductVerdict, identity: DinaIdentity) -> ProductVerdict:
    """A verdict that has been signed by the test identity."""
    from dina.signing import sign_verdict

    sig_hex, did = sign_verdict(sample_verdict, identity)
    sample_verdict.signature_hex = sig_hex
    sample_verdict.signer_did = did
    return sample_verdict


@pytest.fixture
def unsigned_verdict() -> ProductVerdict:
    """A verdict without signature fields (simulating pre-v0.3 data)."""
    return ProductVerdict(
        product_name="Galaxy S24",
        verdict="WAIT",
        confidence_score=62,
        pros=["great display"],
        cons=["bloatware", "slow updates"],
        hidden_warnings=[],
        expert_source="Dave2D",
    )
