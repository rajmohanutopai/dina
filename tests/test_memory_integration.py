"""Integration tests for dina.memory — VerdictMemory with v0.3 signature storage.

These tests use ChromaDB's default embedding function (onnxruntime) to avoid
requiring Ollama or Google AI API access.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import chromadb
import pytest

pytestmark = pytest.mark.compat

from dina.identity import DinaIdentity
from dina.models import ProductVerdict
from dina.signing import canonicalize_verdict, sign_verdict, verify_verdict_signature


def _mock_providers():
    """Create a mock providers object with default embedding function."""
    mock = MagicMock()
    mock.make_embedding_function.return_value = (
        chromadb.utils.embedding_functions.DefaultEmbeddingFunction()
    )
    mock.embed_provider = "test"
    return mock


@pytest.fixture
def memory(tmp_path: Path):
    """Create a VerdictMemory backed by a temp directory with default embeddings."""
    with patch("dina.memory.providers", _mock_providers()):
        from dina.memory import VerdictMemory

        return VerdictMemory(persist_dir=tmp_path / "chroma")


@pytest.fixture
def identity(tmp_path: Path) -> DinaIdentity:
    """Provide a fresh identity for signing tests."""
    return DinaIdentity(identity_dir=tmp_path / "identity")


@pytest.mark.compat
class TestStoreUnsignedVerdict:
    """Tests for storing verdicts without signatures (backward compat)."""

    def test_store_and_count(self, memory, unsigned_verdict: ProductVerdict):
        """Storing a verdict increments the count."""
        assert memory.count == 0
        memory.store(unsigned_verdict, "https://youtu.be/abc123", "abc123")
        assert memory.count == 1

    def test_store_unsigned_no_signature_metadata(
        self, memory, unsigned_verdict: ProductVerdict
    ):
        """Unsigned verdicts don't have signature fields in metadata."""
        memory.store(unsigned_verdict, "https://youtu.be/abc123", "abc123")
        item = memory.get_by_video_id("abc123")
        assert item is not None
        assert "signature_hex" not in item["metadata"]
        assert "signer_did" not in item["metadata"]
        assert "verdict_canonical" not in item["metadata"]

    def test_upsert_idempotent(self, memory, unsigned_verdict: ProductVerdict):
        """Re-storing with the same video ID doesn't create duplicates."""
        memory.store(unsigned_verdict, "https://youtu.be/abc123", "abc123")
        memory.store(unsigned_verdict, "https://youtu.be/abc123", "abc123")
        assert memory.count == 1


class TestStoreSignedVerdict:
    """Tests for storing signed verdicts with v0.3 metadata."""

    def test_store_signed_verdict(self, memory, signed_verdict: ProductVerdict):
        """Signed verdict is stored with signature metadata."""
        memory.store(signed_verdict, "https://youtu.be/xyz789", "xyz789")
        item = memory.get_by_video_id("xyz789")
        assert item is not None
        assert "signature_hex" in item["metadata"]
        assert "signer_did" in item["metadata"]
        assert "verdict_canonical" in item["metadata"]

    def test_stored_signature_matches(
        self, memory, signed_verdict: ProductVerdict
    ):
        """The stored signature_hex matches what was set on the verdict."""
        memory.store(signed_verdict, "https://youtu.be/xyz789", "xyz789")
        item = memory.get_by_video_id("xyz789")
        assert item["metadata"]["signature_hex"] == signed_verdict.signature_hex

    def test_stored_did_matches(self, memory, signed_verdict: ProductVerdict):
        """The stored signer_did matches what was set on the verdict."""
        memory.store(signed_verdict, "https://youtu.be/xyz789", "xyz789")
        item = memory.get_by_video_id("xyz789")
        assert item["metadata"]["signer_did"] == signed_verdict.signer_did

    def test_stored_canonical_is_valid_json(self, memory, signed_verdict: ProductVerdict):
        """The stored verdict_canonical is valid JSON."""
        import json

        memory.store(signed_verdict, "https://youtu.be/xyz789", "xyz789")
        item = memory.get_by_video_id("xyz789")
        canonical = item["metadata"]["verdict_canonical"]
        parsed = json.loads(canonical)
        assert "product_name" in parsed

    def test_stored_canonical_excludes_signature(
        self, memory, signed_verdict: ProductVerdict
    ):
        """The stored canonical JSON does not contain signature fields."""
        import json

        memory.store(signed_verdict, "https://youtu.be/xyz789", "xyz789")
        item = memory.get_by_video_id("xyz789")
        canonical = item["metadata"]["verdict_canonical"]
        parsed = json.loads(canonical)
        assert "signature_hex" not in parsed
        assert "signer_did" not in parsed

    def test_signature_verifies_from_stored_data(
        self, memory, signed_verdict: ProductVerdict, identity: DinaIdentity
    ):
        """Full round-trip: store signed verdict, retrieve, verify signature."""
        memory.store(signed_verdict, "https://youtu.be/xyz789", "xyz789")
        item = memory.get_by_video_id("xyz789")
        meta = item["metadata"]
        valid = verify_verdict_signature(
            meta["verdict_canonical"], meta["signature_hex"], identity
        )
        assert valid is True


class TestGetByVideoId:
    """Tests for the get_by_video_id() method."""

    def test_returns_none_for_missing_id(self, memory):
        """get_by_video_id returns None for a non-existent video ID."""
        assert memory.get_by_video_id("nonexistent") is None

    def test_returns_correct_verdict(self, memory, sample_verdict: ProductVerdict):
        """get_by_video_id returns the correct verdict data."""
        memory.store(sample_verdict, "https://youtu.be/test123", "test123")
        item = memory.get_by_video_id("test123")
        assert item is not None
        assert item["id"] == "test123"
        assert item["metadata"]["product_name"] == "Pixel 9 Pro"
        assert item["metadata"]["youtube_url"] == "https://youtu.be/test123"

    def test_returns_document_text(self, memory, sample_verdict: ProductVerdict):
        """get_by_video_id returns the full document text."""
        memory.store(sample_verdict, "https://youtu.be/test123", "test123")
        item = memory.get_by_video_id("test123")
        assert "Pixel 9 Pro" in item["document"]
        assert "BUY" in item["document"]

    def test_multiple_verdicts_correct_retrieval(self, memory):
        """get_by_video_id retrieves the correct verdict among multiple."""
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
        memory.store(v1, "https://youtu.be/aaa", "aaa")
        memory.store(v2, "https://youtu.be/bbb", "bbb")

        item_a = memory.get_by_video_id("aaa")
        item_b = memory.get_by_video_id("bbb")
        assert item_a["metadata"]["product_name"] == "Product A"
        assert item_b["metadata"]["product_name"] == "Product B"


class TestMixedSignedUnsigned:
    """Tests for mixed signed and unsigned verdicts in the same store."""

    def test_mixed_storage(self, memory, signed_verdict, unsigned_verdict):
        """Both signed and unsigned verdicts can coexist."""
        memory.store(signed_verdict, "https://youtu.be/signed1", "signed1")
        memory.store(unsigned_verdict, "https://youtu.be/unsigned1", "unsigned1")
        assert memory.count == 2

    def test_signed_has_metadata(self, memory, signed_verdict, unsigned_verdict):
        """Only signed verdicts have signature metadata."""
        memory.store(signed_verdict, "https://youtu.be/signed1", "signed1")
        memory.store(unsigned_verdict, "https://youtu.be/unsigned1", "unsigned1")

        signed_item = memory.get_by_video_id("signed1")
        unsigned_item = memory.get_by_video_id("unsigned1")

        assert "signature_hex" in signed_item["metadata"]
        assert "signature_hex" not in unsigned_item["metadata"]

    def test_list_recent_works_with_mixed(self, memory, signed_verdict, unsigned_verdict):
        """list_recent returns both signed and unsigned verdicts."""
        memory.store(signed_verdict, "https://youtu.be/signed1", "signed1")
        memory.store(unsigned_verdict, "https://youtu.be/unsigned1", "unsigned1")

        recent = memory.list_recent(10)
        assert len(recent) == 2

    def test_search_works_with_mixed(self, memory, signed_verdict, unsigned_verdict):
        """Semantic search works across both signed and unsigned verdicts."""
        memory.store(signed_verdict, "https://youtu.be/signed1", "signed1")
        memory.store(unsigned_verdict, "https://youtu.be/unsigned1", "unsigned1")

        results = memory.search("phone camera", n_results=5)
        assert len(results) >= 1


class TestListRecent:
    """Tests for list_recent with signature metadata."""

    def test_empty_store(self, memory):
        """list_recent returns empty list for empty store."""
        assert memory.list_recent(10) == []

    def test_returns_metadata_with_signature(self, memory, signed_verdict):
        """list_recent includes signature metadata for signed verdicts."""
        memory.store(signed_verdict, "https://youtu.be/vid1", "vid1")
        items = memory.list_recent(10)
        assert len(items) == 1
        assert "signature_hex" in items[0]["metadata"]


class TestSearch:
    """Tests for search with signature metadata."""

    def test_empty_store(self, memory):
        """search returns empty list for empty store."""
        assert memory.search("anything") == []

    def test_returns_results(self, memory, sample_verdict):
        """search finds stored verdicts."""
        memory.store(sample_verdict, "https://youtu.be/vid1", "vid1")
        results = memory.search("Pixel camera", n_results=5)
        assert len(results) >= 1
        assert results[0]["metadata"]["product_name"] == "Pixel 9 Pro"
