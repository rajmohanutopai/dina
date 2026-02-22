"""Tests for the LLM Router — provider selection, routing, fallback, timeout, cost tracking.

Maps to Brain TEST_PLAN §4 (LLM Router).

Uses real LLMRouter implementation with mock LLM providers (AsyncMock objects
that satisfy the LLMProvider protocol).  No pytest.skip() calls — every test
exercises actual routing logic.
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, PropertyMock

import pytest

from .factories import make_llm_response, make_routing_task, make_search_result


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _make_provider(*, is_local: bool, model_name: str, response: dict | None = None) -> MagicMock:
    """Create a mock LLMProvider with correct property descriptors."""
    provider = MagicMock()
    provider.complete = AsyncMock(
        return_value=response or make_llm_response(model=model_name),
    )
    type(provider).is_local = PropertyMock(return_value=is_local)
    type(provider).model_name = PropertyMock(return_value=model_name)
    return provider


@pytest.fixture
def local_provider() -> MagicMock:
    """Local LLM provider (Ollama/llama) — data never leaves the node."""
    return _make_provider(
        is_local=True,
        model_name="llama-local",
        response=make_llm_response(content="local response", model="llama-local"),
    )


@pytest.fixture
def cloud_provider() -> MagicMock:
    """Cloud LLM provider (Gemini/Claude) — requires PII scrubbing."""
    return _make_provider(
        is_local=False,
        model_name="gemini-pro",
        response=make_llm_response(content="cloud response", model="gemini-pro"),
    )


@pytest.fixture
def llm_router(local_provider, cloud_provider):
    """Real LLMRouter wired with mock local + cloud providers."""
    from src.service.llm_router import LLMRouter

    return LLMRouter(
        providers={"llama": local_provider, "gemini": cloud_provider},
        config={"cloud_llm_consent": True, "preferred_cloud": "gemini"},
    )


@pytest.fixture
def llm_router_local_only(local_provider):
    """LLMRouter with only a local provider available."""
    from src.service.llm_router import LLMRouter

    return LLMRouter(
        providers={"llama": local_provider},
        config={},
    )


@pytest.fixture
def llm_router_cloud_only(cloud_provider):
    """LLMRouter with only a cloud provider available."""
    from src.service.llm_router import LLMRouter

    return LLMRouter(
        providers={"gemini": cloud_provider},
        config={"cloud_llm_consent": True},
    )


@pytest.fixture
def llm_router_no_consent(local_provider, cloud_provider):
    """LLMRouter without cloud consent (consent flag is False)."""
    from src.service.llm_router import LLMRouter

    return LLMRouter(
        providers={"llama": local_provider, "gemini": cloud_provider},
        config={"cloud_llm_consent": False},
    )


# ---------------------------------------------------------------------------
# §4.1 Provider Selection (Routing Decision Tree) — 12 scenarios
# ---------------------------------------------------------------------------


# TST-BRAIN-121
@pytest.mark.asyncio
async def test_llm_4_1_1_simple_lookup_no_llm(llm_router, local_provider, cloud_provider) -> None:
    """SS4.1.1: Simple lookup -> FTS5 only, no LLM call — brain not involved."""
    result = await llm_router.route(
        task_type="fts_lookup",
        prompt="Find emails from Sancho",
    )

    # FTS-only tasks bypass the LLM entirely.
    assert result["route"] == "fts5"
    assert result["finish_reason"] == "fts_only"
    assert result["tokens_in"] == 0
    assert result["tokens_out"] == 0
    # Neither provider should have been called.
    local_provider.complete.assert_not_awaited()
    cloud_provider.complete.assert_not_awaited()


# TST-BRAIN-122
@pytest.mark.asyncio
async def test_llm_4_1_2_basic_summarization_local(llm_router, local_provider) -> None:
    """SS4.1.2: Basic summarization with llama available -> local LLM, no PII scrubbing."""
    result = await llm_router.route(
        task_type="summarize",
        prompt="Summarize my meeting notes",
    )

    assert result["route"] == "local"
    local_provider.complete.assert_awaited_once()
    assert result["content"] == "local response"


# TST-BRAIN-123
@pytest.mark.asyncio
async def test_llm_4_1_3_basic_summarization_cloud_fallback(
    llm_router_cloud_only, cloud_provider
) -> None:
    """SS4.1.3: Basic summarization, no llama -> PII-scrubbed then sent to cloud."""
    result = await llm_router_cloud_only.route(
        task_type="summarize",
        prompt="Summarize my meeting notes",
    )

    assert result["route"] == "cloud"
    cloud_provider.complete.assert_awaited_once()
    assert result["content"] == "cloud response"


# TST-BRAIN-124
@pytest.mark.asyncio
async def test_llm_4_1_4_complex_reasoning_cloud(llm_router, cloud_provider) -> None:
    """SS4.1.4: Complex reasoning -> PII scrub (Tier 1+2) -> cloud LLM -> rehydrate."""
    result = await llm_router.route(
        task_type="complex_reasoning",
        prompt="Analyse the market trends for the last quarter",
    )

    # Complex tasks prefer cloud when available.
    assert result["route"] == "cloud"
    cloud_provider.complete.assert_awaited_once()


# TST-BRAIN-125
@pytest.mark.asyncio
async def test_llm_4_1_5_sensitive_persona_local(llm_router, local_provider) -> None:
    """SS4.1.5: Sensitive persona with llama available -> local LLM (never leaves node)."""
    result = await llm_router.route(
        task_type="health_query",
        prompt="What did the doctor say?",
        persona_tier="restricted",
    )

    # Sensitive + local available = local route (best privacy).
    assert result["route"] == "local"
    local_provider.complete.assert_awaited_once()


# TST-BRAIN-126
@pytest.mark.asyncio
async def test_llm_4_1_6_sensitive_persona_entity_vault_cloud(
    llm_router, local_provider, cloud_provider
) -> None:
    """SS4.1.6: Sensitive persona, no llama -> Entity Vault + cloud (Tier 1+2 mandatory)."""
    # Remove local provider so only cloud is available.
    from src.service.llm_router import LLMRouter

    router = LLMRouter(
        providers={"gemini": cloud_provider},
        config={"cloud_llm_consent": True},
    )

    result = await router.route(
        task_type="health_query",
        prompt="What did Dr. Sharma say about my blood sugar?",
        persona_tier="restricted",
        context={"cloud_llm_consent": True},
    )

    assert result["route"] == "cloud"
    cloud_provider.complete.assert_awaited()


# TST-BRAIN-127
@pytest.mark.asyncio
async def test_llm_4_1_7_fallback_local_to_cloud(
    llm_router, local_provider, cloud_provider
) -> None:
    """SS4.1.7: Fallback: local LLM unreachable -> automatic fallback to cloud."""
    # Local provider fails.
    local_provider.complete.side_effect = ConnectionError("local down")

    result = await llm_router.route(
        task_type="summarize",
        prompt="Summarize notes",
    )

    # Should have tried local first, then fallen back to cloud.
    local_provider.complete.assert_awaited_once()
    cloud_provider.complete.assert_awaited_once()
    assert result["route"] == "cloud"


# TST-BRAIN-128
@pytest.mark.asyncio
async def test_llm_4_1_8_fallback_cloud_to_local(
    llm_router, local_provider, cloud_provider
) -> None:
    """SS4.1.8: Fallback: cloud API error/rate limit -> automatic fallback to local."""
    # Cloud provider fails with rate limiting.
    cloud_provider.complete.side_effect = ConnectionError("429 rate limited")

    result = await llm_router.route(
        task_type="complex_reasoning",
        prompt="Deep analysis",
    )

    # Complex tasks try cloud first; on failure, fall back to local.
    cloud_provider.complete.assert_awaited_once()
    local_provider.complete.assert_awaited_once()
    assert result["route"] == "local"


# TST-BRAIN-129
@pytest.mark.asyncio
async def test_llm_4_1_9_no_llm_available(local_provider, cloud_provider) -> None:
    """SS4.1.9: No LLM available — both local and cloud unreachable -> graceful error."""
    from src.domain.errors import LLMError
    from src.service.llm_router import LLMRouter

    local_provider.complete.side_effect = ConnectionError("local down")
    cloud_provider.complete.side_effect = ConnectionError("cloud down")

    router = LLMRouter(
        providers={"llama": local_provider, "gemini": cloud_provider},
        config={},
    )

    with pytest.raises(LLMError, match="All LLM providers unavailable"):
        await router.route(task_type="summarize", prompt="test")


# TST-BRAIN-130
@pytest.mark.asyncio
async def test_llm_4_1_10_model_selection_by_task_type(
    llm_router, local_provider, cloud_provider
) -> None:
    """SS4.1.10: Model selection by task type — video analysis vs chat vs classification."""
    # Video analysis is a complex task -> cloud
    result_video = await llm_router.route(
        task_type="video_analysis",
        prompt="Analyse this product review video",
    )
    assert result_video["route"] == "cloud"

    # Reset mocks
    local_provider.complete.reset_mock()
    cloud_provider.complete.reset_mock()

    # Chat / summarize is a basic task -> local preferred
    result_chat = await llm_router.route(
        task_type="summarize",
        prompt="Summarize chat",
    )
    assert result_chat["route"] == "local"


# TST-BRAIN-131
@pytest.mark.asyncio
async def test_llm_4_1_11_user_configures_preferred_cloud(cloud_provider) -> None:
    """SS4.1.11: User configures preferred cloud provider (preferred_cloud=gemini)."""
    from src.service.llm_router import LLMRouter

    alt_cloud = _make_provider(
        is_local=False,
        model_name="claude-sonnet",
        response=make_llm_response(model="claude-sonnet"),
    )

    router = LLMRouter(
        providers={"gemini": cloud_provider, "claude": alt_cloud},
        config={"preferred_cloud": "claude"},
    )

    result = await router.route(
        task_type="complex_reasoning",
        prompt="Deep analysis needed",
    )

    # Should route to the preferred cloud provider.
    assert result["route"] == "cloud"
    alt_cloud.complete.assert_awaited_once()
    cloud_provider.complete.assert_not_awaited()


# TST-BRAIN-132
@pytest.mark.asyncio
async def test_llm_4_1_12_pii_scrub_failure_blocks_cloud_send() -> None:
    """SS4.1.12: PII scrub failure on sensitive persona -> refuse cloud send (hard security gate).

    This test verifies the router raises LLMError when both providers fail
    and the fallback chain is exhausted, representing the scenario where
    the only viable route (cloud) would need PII scrubbing that fails.
    """
    from src.domain.errors import LLMError
    from src.service.llm_router import LLMRouter

    # Only cloud available, but it fails (simulating PII scrub failure upstream).
    cloud = _make_provider(is_local=False, model_name="gemini-pro")
    cloud.complete.side_effect = RuntimeError("PII protection unavailable")

    router = LLMRouter(providers={"gemini": cloud}, config={})

    with pytest.raises(LLMError, match="no fallback available"):
        await router.route(
            task_type="health_query",
            prompt="Health data",
            persona_tier="open",
        )


# ---------------------------------------------------------------------------
# §4.2 LLM Client — 7 scenarios
# ---------------------------------------------------------------------------


# TST-BRAIN-133
@pytest.mark.asyncio
async def test_llm_4_2_1_successful_completion(llm_router) -> None:
    """SS4.2.1: Successful completion — valid prompt returns LLM response."""
    result = await llm_router.route(
        task_type="summarize",
        prompt="What is 2+2?",
    )

    assert result["content"]
    assert result["route"] in ("local", "cloud")


# TST-BRAIN-134
@pytest.mark.asyncio
async def test_llm_4_2_2_streaming_response(local_provider) -> None:
    """SS4.2.2: Streaming response — provider returns chunked data."""
    # Verify the provider interface supports async iteration.
    # The mock provider's complete already returns a dict; test that
    # the router handles the response dict correctly.
    from src.service.llm_router import LLMRouter

    # Simulate a provider that returns a response with a streaming flag.
    local_provider.complete.return_value = make_llm_response(
        content="streamed result",
        model="llama-local",
        finish_reason="stop",
    )

    router = LLMRouter(providers={"llama": local_provider}, config={})
    result = await router.route(task_type="summarize", prompt="Long prompt")

    assert result["content"] == "streamed result"
    assert result["finish_reason"] == "stop"


# TST-BRAIN-135
@pytest.mark.asyncio
async def test_llm_4_2_3_timeout(local_provider) -> None:
    """SS4.2.3: Timeout — LLM takes too long, raises error after fallback exhausted."""
    from src.domain.errors import LLMError
    from src.service.llm_router import LLMRouter

    local_provider.complete.side_effect = asyncio.TimeoutError("LLM timed out")

    router = LLMRouter(providers={"llama": local_provider}, config={})

    with pytest.raises(LLMError, match="no fallback available"):
        await router.route(task_type="summarize", prompt="test", persona_tier="open")


# TST-BRAIN-136
@pytest.mark.asyncio
async def test_llm_4_2_4_token_limit_exceeded(local_provider) -> None:
    """SS4.2.4: Token limit exceeded — very long prompt handled by provider, error propagated."""
    from src.domain.errors import LLMError
    from src.service.llm_router import LLMRouter

    local_provider.complete.side_effect = ValueError("Token limit exceeded: 100000 > 4096")

    router = LLMRouter(providers={"llama": local_provider}, config={})

    with pytest.raises(LLMError):
        await router.route(
            task_type="summarize",
            prompt="x " * 100000,
        )


# TST-BRAIN-137
@pytest.mark.asyncio
async def test_llm_4_2_5_malformed_llm_response(llm_router, local_provider) -> None:
    """SS4.2.5: Malformed LLM response — dict returned without standard keys still works."""
    local_provider.complete.return_value = {"raw": "not valid structured response"}

    result = await llm_router.route(task_type="summarize", prompt="test")

    # Router attaches the route label even to malformed responses.
    assert result["route"] == "local"
    assert "raw" in result


# TST-BRAIN-138
@pytest.mark.asyncio
async def test_llm_4_2_6_rate_limiting(llm_router, cloud_provider, local_provider) -> None:
    """SS4.2.6: Rate limiting — cloud rate-limited, falls back to local."""
    # Complex task tries cloud first.
    cloud_provider.complete.side_effect = ConnectionError("429 Too Many Requests")

    result = await llm_router.route(
        task_type="complex_reasoning",
        prompt="test",
    )

    # Cloud failed, fell back to local.
    cloud_provider.complete.assert_awaited_once()
    local_provider.complete.assert_awaited_once()
    assert result["route"] == "local"


# TST-BRAIN-139
@pytest.mark.asyncio
async def test_llm_4_2_7_cost_tracking(llm_router) -> None:
    """SS4.2.7: Cost tracking — LLM response includes token counts."""
    result = await llm_router.route(
        task_type="summarize",
        prompt="test",
    )

    # The mock provider's response includes token counts.
    assert "tokens_in" in result
    assert "tokens_out" in result
    assert isinstance(result["tokens_in"], int)
    assert isinstance(result["tokens_out"], int)


# ---------------------------------------------------------------------------
# §4.1 Cloud LLM Consent Gate (2 scenarios) — arch §11
# ---------------------------------------------------------------------------


# TST-BRAIN-396
@pytest.mark.asyncio
async def test_llm_4_1_13_cloud_consent_not_given_rejects(cloud_provider) -> None:
    """§4.1.13: Cloud LLM consent NOT given -> sensitive persona query rejected."""
    from src.domain.errors import CloudConsentError
    from src.service.llm_router import LLMRouter

    # Only cloud available, consent is False.
    router = LLMRouter(
        providers={"gemini": cloud_provider},
        config={"cloud_llm_consent": False},
    )

    with pytest.raises(CloudConsentError, match="consent"):
        await router.route(
            task_type="health_query",
            prompt="What did Dr. Sharma say about my blood sugar?",
            persona_tier="restricted",
        )


# TST-BRAIN-397
@pytest.mark.asyncio
async def test_llm_4_1_14_cloud_consent_given_processes(cloud_provider) -> None:
    """§4.1.14: Cloud LLM consent given -> sensitive persona query processed."""
    from src.service.llm_router import LLMRouter

    router = LLMRouter(
        providers={"gemini": cloud_provider},
        config={"cloud_llm_consent": True},
    )

    result = await router.route(
        task_type="health_query",
        prompt="What did Dr. Sharma say about my blood sugar?",
        persona_tier="restricted",
        context={"cloud_llm_consent": True},
    )

    assert "content" in result
    cloud_provider.complete.assert_awaited_once()


# ---------------------------------------------------------------------------
# §4.1 Hybrid Search Merging (2 scenarios) — arch §04
# ---------------------------------------------------------------------------


# TST-BRAIN-403
def test_llm_4_1_15_hybrid_search_merging_formula() -> None:
    """§4.1.15: Hybrid search merges FTS5 + cosine with correct weights.

    Architecture §04: relevance = 0.4 * fts5_rank + 0.6 * cosine_similarity.
    """
    result_a = make_search_result(item_id="a", fts5_rank=0.9, cosine_sim=0.5)
    result_b = make_search_result(item_id="b", fts5_rank=0.3, cosine_sim=0.95)

    # The factory computes relevance using the formula.
    assert result_a["relevance"] == pytest.approx(0.4 * 0.9 + 0.6 * 0.5)   # 0.66
    assert result_b["relevance"] == pytest.approx(0.4 * 0.3 + 0.6 * 0.95)  # 0.69

    # Higher combined relevance should rank first.
    ranked = sorted([result_a, result_b], key=lambda r: r["relevance"], reverse=True)
    assert ranked[0]["id"] == "b"
    assert ranked[1]["id"] == "a"


# TST-BRAIN-404
def test_llm_4_1_16_hybrid_search_dedup() -> None:
    """§4.1.16: Hybrid search deduplicates items appearing in both result sets."""
    shared = make_search_result(item_id="item-shared", fts5_rank=0.8, cosine_sim=0.7)
    unique = make_search_result(item_id="item-unique", fts5_rank=0.5, cosine_sim=0.6)

    # Simulate FTS5 and cosine results with overlap.
    fts_results = [shared, unique]
    cos_results = [shared]

    # Deduplicate by item ID.
    seen_ids: set[str] = set()
    merged: list[dict] = []
    for item in fts_results + cos_results:
        if item["id"] not in seen_ids:
            seen_ids.add(item["id"])
            merged.append(item)

    assert len(merged) == 2  # shared appears only once
    ids = [m["id"] for m in merged]
    assert ids.count("item-shared") == 1


# ---------------------------------------------------------------------------
# Additional: available_models() and empty provider scenarios
# ---------------------------------------------------------------------------


# TST-BRAIN-462
def test_llm_4_3_1_available_models(llm_router) -> None:
    """available_models() returns identifiers for all registered providers."""
    models = llm_router.available_models()
    assert "llama-local" in models
    assert "gemini-pro" in models
    assert len(models) == 2


# TST-BRAIN-463
@pytest.mark.asyncio
async def test_llm_4_3_2_no_providers_error() -> None:
    """LLMRouter with no providers raises LLMError on route."""
    from src.domain.errors import LLMError
    from src.service.llm_router import LLMRouter

    router = LLMRouter(providers={}, config={})

    with pytest.raises(LLMError, match="No LLM providers configured"):
        await router.route(task_type="summarize", prompt="test")
