"""Tests for Embedding Generation.

Maps to Brain TEST_PLAN SS14.

Brain generates embeddings, core stores them. Brain has the LLM routing logic
and knows which model to use. Core just executes the sqlite-vec INSERT.
"""

from __future__ import annotations

import pytest

from .factories import make_embedding, make_vault_item


# ---------------------------------------------------------------------------
# SS14 Embedding Generation (7 scenarios)
# ---------------------------------------------------------------------------


# TST-BRAIN-327
@pytest.mark.asyncio
async def test_embedding_14_1_via_local_llama(
    mock_embedding_client, mock_core_client,
) -> None:
    """SS14.1: Embedding via local llama.

    Brain ingests new item, llama available. Brain calls llama:8080 for
    EmbeddingGemma -> 768-dim vector returned.
    """
    embedding = make_embedding(dimensions=768, model="embedding-gemma")
    assert len(embedding["vector"]) == 768
    assert embedding["model"] == "embedding-gemma"

    result = await mock_embedding_client.embed()
    assert result["dimensions"] == 768

    pytest.skip("Local llama embedding not yet implemented")
    # Full test: Brain calls llama:8080, receives 768-dim vector


# TST-BRAIN-328
@pytest.mark.asyncio
async def test_embedding_14_2_via_cloud_api(
    mock_embedding_client, mock_core_client,
) -> None:
    """SS14.2: Embedding via cloud API.

    Brain ingests new item, no llama. Brain calls gemini-embedding-001
    (cloud) -> vector returned.
    """
    embedding = make_embedding(model="gemini-embedding-001")
    assert embedding["model"] == "gemini-embedding-001"

    result = await mock_embedding_client.embed()
    assert "vector" in result

    pytest.skip("Cloud embedding API not yet implemented")
    # Full test: No llama available, brain calls cloud embedding API


# TST-BRAIN-329
@pytest.mark.asyncio
async def test_embedding_14_3_stored_in_core(
    mock_embedding_client, mock_core_client,
) -> None:
    """SS14.3: Embedding stored in core.

    Brain receives vector and sends it to core:
    POST core:8100/v1/vault/store {type: "embedding", vector: [...], source_id: "vault_a1b2c3"}.
    """
    embedding = make_embedding(source_id="vault_a1b2c3")
    assert embedding["source_id"] == "vault_a1b2c3"
    assert len(embedding["vector"]) > 0

    pytest.skip("Embedding storage in core not yet implemented")
    # Full test: Brain posts embedding vector to core for sqlite-vec INSERT


# TST-BRAIN-330
@pytest.mark.asyncio
async def test_embedding_14_4_core_stores_sqlite_vec(
    mock_core_client,
) -> None:
    """SS14.4: Core stores in sqlite-vec.

    Embedding received by core. Core executes sqlite-vec INSERT.
    Core doesn't understand embeddings, just stores the vector.
    """
    embedding = make_embedding()
    assert "vector" in embedding

    result = await mock_core_client.store_vault_item()
    assert result is not None

    pytest.skip("Core sqlite-vec storage not yet implemented")
    # Full test: Core receives embedding, executes sqlite-vec INSERT


# TST-BRAIN-331
@pytest.mark.asyncio
async def test_embedding_14_5_fallback_llama_to_cloud(
    mock_embedding_client, mock_core_client,
) -> None:
    """SS14.5: Embedding fallback — llama -> cloud.

    Llama unreachable, brain falls back to cloud embedding API.
    PII scrubbed first before sending to cloud.
    """
    # First call fails (llama down), second succeeds (cloud fallback)
    cloud_embedding = make_embedding(model="gemini-embedding-001")
    assert cloud_embedding["model"] == "gemini-embedding-001"

    pytest.skip("Embedding fallback llama->cloud not yet implemented")
    # Full test: llama unreachable -> brain scrubs PII -> calls cloud API


# TST-BRAIN-332
@pytest.mark.asyncio
async def test_embedding_14_6_no_embedding_available(
    mock_embedding_client_unavailable, mock_core_client,
) -> None:
    """SS14.6: No embedding available — both llama and cloud down.

    Item stored without embedding. Semantic search unavailable for this
    item, but FTS5 full-text search still works.
    """
    assert await mock_embedding_client_unavailable.available() is False

    vault_item = make_vault_item(item_id="no-embed-item")
    assert vault_item["id"] == "no-embed-item"

    pytest.skip("No-embedding fallback not yet implemented")
    # Full test: Both embedding services down -> item stored without vector,
    # semantic search unavailable but FTS5 still works


# TST-BRAIN-333
@pytest.mark.asyncio
async def test_embedding_14_7_dimension_consistent(
    mock_embedding_client,
) -> None:
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

    pytest.skip("Embedding dimension consistency check not yet implemented")
    # Full test: All stored vectors must be 768-dim, dimension mismatch rejected
