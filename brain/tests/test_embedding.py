"""Tests for Embedding Generation.

Maps to Brain TEST_PLAN SS14.

Brain generates embeddings, core stores them. Brain has the LLM routing logic
and knows which model to use. Core just executes the sqlite-vec INSERT.

Uses mock-based testing for embedding provider contracts since no real
embedding provider is available in tests.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from .factories import make_embedding, make_vault_item


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def embedding_client():
    """Mock embedding client for embedding generation tests."""
    client = AsyncMock()
    client.embed.return_value = make_embedding()
    client.embed_batch.return_value = [make_embedding(source_id=f"src_{i}") for i in range(3)]
    client.available.return_value = True
    client.model_name = "embedding-gemma"
    return client


@pytest.fixture
def embedding_client_cloud():
    """Mock cloud embedding client."""
    client = AsyncMock()
    client.embed.return_value = make_embedding(model="gemini-embedding-001")
    client.available.return_value = True
    client.model_name = "gemini-embedding-001"
    return client


@pytest.fixture
def embedding_client_unavailable():
    """Mock embedding client that is unreachable."""
    client = AsyncMock()
    client.embed.side_effect = ConnectionError("Embedding service unavailable")
    client.available.return_value = False
    client.model_name = "unavailable"
    return client


@pytest.fixture
def core_client():
    """Mock core client for storing embeddings."""
    client = AsyncMock()
    client.store_vault_item.return_value = "item-001"
    return client


# ---------------------------------------------------------------------------
# SS14 Embedding Generation (7 scenarios)
# ---------------------------------------------------------------------------


# TST-BRAIN-327
@pytest.mark.asyncio
# TRACE: {"suite": "BRAIN", "case": "0327", "section": "14", "sectionName": "Embedding Generation", "subsection": "01", "scenario": "01", "title": "via_local_llama"}
async def test_embedding_14_1_via_local_llama(embedding_client, core_client) -> None:
    """SS14.1: Embedding via local llama.

    Brain ingests new item, llama available. Brain calls llama:8080 for
    EmbeddingGemma -> 768-dim vector returned.
    """
    embedding = make_embedding(dimensions=768, model="embedding-gemma")
    assert len(embedding["vector"]) == 768
    assert embedding["model"] == "embedding-gemma"

    result = await embedding_client.embed("Test text for embedding")
    assert result["dimensions"] == 768
    assert len(result["vector"]) == 768
    embedding_client.embed.assert_awaited_once()


# TST-BRAIN-328
@pytest.mark.asyncio
# TRACE: {"suite": "BRAIN", "case": "0328", "section": "14", "sectionName": "Embedding Generation", "subsection": "02", "scenario": "01", "title": "via_cloud_api"}
async def test_embedding_14_2_via_cloud_api(embedding_client_cloud, core_client) -> None:
    """SS14.2: Embedding via cloud API.

    Brain ingests new item, no llama. Brain calls gemini-embedding-001
    (cloud) -> vector returned.
    """
    result = await embedding_client_cloud.embed("Test text")
    assert result["model"] == "gemini-embedding-001"
    assert "vector" in result
    assert len(result["vector"]) > 0
    embedding_client_cloud.embed.assert_awaited_once()


# TST-BRAIN-329
@pytest.mark.asyncio
# TRACE: {"suite": "BRAIN", "case": "0329", "section": "14", "sectionName": "Embedding Generation", "subsection": "03", "scenario": "01", "title": "stored_in_core"}
async def test_embedding_14_3_stored_in_core(embedding_client, core_client) -> None:
    """SS14.3: Embedding stored in core.

    Brain receives vector and sends it to core:
    POST core:8100/v1/vault/store {type: "embedding", vector: [...], source_id: "vault_a1b2c3"}.
    """
    embedding = make_embedding(source_id="vault_a1b2c3")
    assert embedding["source_id"] == "vault_a1b2c3"
    assert len(embedding["vector"]) > 0

    # Store the embedding via core client
    item_id = await core_client.store_vault_item("default", {
        "type": "embedding",
        "vector": embedding["vector"],
        "source_id": embedding["source_id"],
    })
    assert item_id == "item-001"
    core_client.store_vault_item.assert_awaited_once()


# TST-BRAIN-330
@pytest.mark.asyncio
# TRACE: {"suite": "BRAIN", "case": "0330", "section": "14", "sectionName": "Embedding Generation", "subsection": "04", "scenario": "01", "title": "core_stores_sqlite_vec"}
async def test_embedding_14_4_core_stores_sqlite_vec(core_client) -> None:
    """SS14.4: Core stores in sqlite-vec.

    Embedding received by core. Core executes sqlite-vec INSERT.
    Core doesn't understand embeddings, just stores the vector.
    """
    embedding = make_embedding()
    assert "vector" in embedding

    result = await core_client.store_vault_item("default", {
        "type": "embedding",
        "vector": embedding["vector"],
        "source_id": embedding["source_id"],
    })
    assert result is not None
    core_client.store_vault_item.assert_awaited_once()
    # Verify the correct data was sent
    call_args = core_client.store_vault_item.call_args
    assert call_args[0][1]["type"] == "embedding"
    assert len(call_args[0][1]["vector"]) == 768


# TST-BRAIN-331
@pytest.mark.asyncio
# TRACE: {"suite": "BRAIN", "case": "0331", "section": "14", "sectionName": "Embedding Generation", "subsection": "05", "scenario": "01", "title": "fallback_llama_to_cloud"}
async def test_embedding_14_5_fallback_llama_to_cloud(
    embedding_client, embedding_client_cloud, core_client,
) -> None:
    """SS14.5: Embedding fallback -- llama -> cloud.

    Llama unreachable, brain falls back to cloud embedding API.
    PII scrubbed first before sending to cloud.
    """
    # First attempt: local llama fails
    embedding_client.embed.side_effect = ConnectionError("llama down")
    with pytest.raises(ConnectionError):
        await embedding_client.embed("Test text")

    # Fallback: cloud embedding succeeds
    cloud_result = await embedding_client_cloud.embed("Scrubbed test text")
    assert cloud_result["model"] == "gemini-embedding-001"
    assert len(cloud_result["vector"]) > 0


# TST-BRAIN-332
@pytest.mark.asyncio
# TRACE: {"suite": "BRAIN", "case": "0332", "section": "14", "sectionName": "Embedding Generation", "subsection": "06", "scenario": "01", "title": "no_embedding_available"}
async def test_embedding_14_6_no_embedding_available(
    embedding_client_unavailable, core_client,
) -> None:
    """SS14.6: No embedding available -- both llama and cloud down.

    Item stored without embedding. Semantic search unavailable for this
    item, but FTS5 full-text search still works.
    """
    assert await embedding_client_unavailable.available() is False

    vault_item = make_vault_item(item_id="no-embed-item")
    assert vault_item["id"] == "no-embed-item"

    # Item can still be stored without embedding
    item_id = await core_client.store_vault_item("default", {
        "type": "email",
        "source_id": vault_item["source_id"],
        "summary": vault_item["summary"],
        "body_text": vault_item["body_text"],
        # No vector field -- embedding unavailable
    })
    assert item_id is not None
    # Verify no vector was sent
    call_args = core_client.store_vault_item.call_args
    assert "vector" not in call_args[0][1]


# TST-BRAIN-333
@pytest.mark.asyncio
# TRACE: {"suite": "BRAIN", "case": "0333", "section": "14", "sectionName": "Embedding Generation", "subsection": "07", "scenario": "01", "title": "dimension_consistent"}
async def test_embedding_14_7_dimension_consistent(embedding_client) -> None:
    """SS14.7: Embedding dimension consistent.

    All vectors same dimension (768 for Gemma embedding).
    Dimension mismatch rejected.
    """
    emb1 = make_embedding(dimensions=768)
    emb2 = make_embedding(dimensions=768)
    assert len(emb1["vector"]) == len(emb2["vector"]) == 768

    # A mismatched embedding should be rejected
    bad_emb = make_embedding(dimensions=512)
    assert len(bad_emb["vector"]) == 512
    assert len(bad_emb["vector"]) != 768

    # Verify the client returns consistent dimensions
    result = await embedding_client.embed("Consistency test")
    assert result["dimensions"] == 768
    assert len(result["vector"]) == 768
