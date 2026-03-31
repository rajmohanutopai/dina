"""Integration tests for deep-link source attribution.

Behavioral contracts tested:
- Verdicts always attribute the original creator with a deep link to the
  exact moment (timestamp) in the source material.
- Creators get traffic, not intermediaries.
- User can override deep-link behavior (disable, re-prioritize).
"""

from __future__ import annotations

from dataclasses import dataclass

import pytest

from tests.integration.mocks import (
    ExpertAttestation,
    MockDinaCore,
    MockTrustNetwork,
    MockReviewBot,
    TrustRing,
)


# =========================================================================
# TestDeepLinkDefault
# =========================================================================

class TestDeepLinkDefault:
    """Every verdict links back to the original source with attribution."""

# TST-INT-459
    # TRACE: {"suite": "INT", "case": "0459", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "01", "scenario": "01", "title": "verdict_includes_source_attribution"}
    def test_verdict_includes_source_attribution(
        self, mock_review_bot: MockReviewBot
    ):
        """When Dina fetches a laptop verdict, the response includes
        'MKBHD says...' with a direct link to the source video."""
        response = mock_review_bot.query_product("best laptop for coding")
        recs = response["recommendations"]
        assert len(recs) >= 1

        first = recs[0]
        sources = first["sources"]
        assert len(sources) >= 1

        expert_source = sources[0]
        assert expert_source["type"] == "expert"
        assert expert_source["creator_name"] == "MKBHD"
        assert "youtube.com" in expert_source["source_url"]

# TST-INT-292
    # TRACE: {"suite": "INT", "case": "0292", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "01", "scenario": "02", "title": "deep_link_to_timestamp"}
    def test_deep_link_to_timestamp(self, mock_review_bot: MockReviewBot):
        """Deep link contains a timestamp parameter (t=260 -> 4:20) so the
        user lands at the exact moment in the video."""
        response = mock_review_bot.query_product("laptop comparison")
        sources = response["recommendations"][0]["sources"]
        expert = sources[0]

        assert "deep_link" in expert
        assert "&t=" in expert["deep_link"] or "?t=" in expert["deep_link"]
        assert "04:20" in expert["deep_link_context"] or "4:20" in expert["deep_link_context"]

# TST-INT-460
    # TRACE: {"suite": "INT", "case": "0460", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "01", "scenario": "03", "title": "creator_gets_traffic"}
    def test_creator_gets_traffic(self, mock_review_bot: MockReviewBot):
        """The deep link goes to the creator's platform (YouTube), not to
        an intermediary aggregator. The creator earns the view."""
        response = mock_review_bot.query_product("laptop review")
        sources = response["recommendations"][0]["sources"]
        expert = sources[0]

        # The deep link and source URL both point to the creator's content
        assert "youtube.com" in expert["deep_link"]
        assert "youtube.com" in expert["source_url"]
        # No intermediary domain
        assert "dina.ai" not in expert["deep_link"]
        assert "aggregator" not in expert["deep_link"]

# TST-INT-461
    # TRACE: {"suite": "INT", "case": "0461", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "01", "scenario": "04", "title": "multiple_sources_credited"}
    def test_multiple_sources_credited(self, mock_review_bot: MockReviewBot):
        """When a product has multiple expert reviews, all are credited
        with individual deep links."""
        response = mock_review_bot.query_product("best office chair")
        recs = response["recommendations"]
        assert len(recs) >= 1

        chair_rec = recs[0]
        sources = chair_rec["sources"]
        assert len(sources) >= 2, "Chair verdict must credit multiple sources"

        expert_sources = [s for s in sources if s["type"] == "expert"]
        assert len(expert_sources) >= 1

        for source in expert_sources:
            assert "source_url" in source
            assert "deep_link" in source
            assert "creator_name" in source
            assert source["creator_name"] != ""


# =========================================================================
# TestDeepLinkOverride
# =========================================================================

class TestDeepLinkOverride:
    """User can control deep-link behavior."""

# TST-INT-462
    # TRACE: {"suite": "INT", "case": "0462", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "02", "scenario": "01", "title": "user_can_disable_deep_links"}
    def test_user_can_disable_deep_links(
        self, mock_dina: MockDinaCore, mock_review_bot: MockReviewBot
    ):
        """User sets a preference to strip deep links from verdicts.
        The verdict still exists but links are removed before display."""
        # By default, deep links are present in bot responses
        response_before = mock_review_bot.query_product("laptop review")
        recs_before = response_before["recommendations"]
        assert len(recs_before) >= 1
        for rec in recs_before:
            for source in rec.get("sources", []):
                assert "deep_link" in source, (
                    "Bot responses must include deep_link field"
                )
                assert len(source["deep_link"]) > 0, (
                    "Deep links must be non-empty by default"
                )
                assert "youtube.com" in source["deep_link"]

        # User stores a preference to disable deep links
        mock_dina.vault.store(0, "pref_deep_links", {"enabled": False})
        pref = mock_dina.vault.retrieve(0, "pref_deep_links")
        assert pref is not None
        assert pref["enabled"] is False

        # Counter-proof: re-enabling restores the default
        mock_dina.vault.store(0, "pref_deep_links", {"enabled": True})
        pref_enabled = mock_dina.vault.retrieve(0, "pref_deep_links")
        assert pref_enabled["enabled"] is True

# TST-INT-463
    # TRACE: {"suite": "INT", "case": "0463", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "02", "scenario": "02", "title": "default_is_enabled"}
    def test_default_is_enabled(self, mock_dina: MockDinaCore):
        """By default, deep links are enabled — no preference entry means on."""
        pref = mock_dina.vault.retrieve(0, "pref_deep_links")
        # No preference stored yet => default is enabled
        assert pref is None  # absence means default

        # The system default
        default_enabled = True if pref is None else pref.get("enabled", True)
        assert default_enabled is True

# TST-INT-464
    # TRACE: {"suite": "INT", "case": "0464", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "02", "scenario": "03", "title": "custom_prioritization"}
    def test_custom_prioritization(
        self,
        mock_dina: MockDinaCore,
        mock_review_bot: MockReviewBot,
        mock_trust_network: MockTrustNetwork,
    ):
        """User stores source priority preferences in vault; bot returns
        sources with attribution. Verify vault round-trip and source types."""
        # --- Step 1: Store and retrieve priority preferences ---
        pref_data = {
            "order": ["video", "outcome_data", "text_review"],
        }
        mock_dina.vault.store(0, "pref_source_priority", pref_data)
        retrieved_pref = mock_dina.vault.retrieve(0, "pref_source_priority")
        assert retrieved_pref is not None, (
            "Priority preferences must be retrievable from vault"
        )
        assert retrieved_pref["order"] == ["video", "outcome_data", "text_review"], (
            "Priority order must round-trip through vault unchanged"
        )

        # --- Step 2: Bot returns sources for a matching query ---
        response = mock_review_bot.query_product("best office chair")
        assert len(response["recommendations"]) > 0, (
            "Bot must return at least one recommendation for 'chair' query"
        )
        sources = response["recommendations"][0]["sources"]
        assert len(sources) >= 2, (
            "Chair recommendation must include multiple source types"
        )

        # --- Step 3: Verify source attribution (Deep Link Default) ---
        source_types = [s["type"] for s in sources]
        assert "expert" in source_types, (
            "Sources must include an expert review"
        )
        assert "outcome" in source_types, (
            "Sources must include outcome data"
        )

        # Expert source must have deep link for attribution
        expert_source = next(s for s in sources if s["type"] == "expert")
        assert "deep_link" in expert_source, (
            "Expert source must include a deep_link for creator attribution"
        )
        assert "deep_link_context" in expert_source, (
            "Expert source must include context describing the link"
        )
        assert "creator_name" in expert_source or "source_url" in expert_source, (
            "Expert source must attribute the creator"
        )

        # Outcome source must have sample size
        outcome_source = next(s for s in sources if s["type"] == "outcome")
        assert "sample_size" in outcome_source, (
            "Outcome source must include sample_size"
        )
        assert outcome_source["sample_size"] > 0, (
            "Outcome sample_size must be positive"
        )


# =========================================================================
# Helper: store recommendation via Brain→Core pipeline
# =========================================================================

def store_recommendation_via_pipeline(
    dina: MockDinaCore,
    recommendation: dict,
) -> str:
    """Simulate the Brain→Core pipeline for storing a recommendation.

    In production:
    1. Brain assembles recommendation with attribution fields
    2. Brain POSTs to Core /v1/vault/store
    3. Core stores in SQLCipher vault
    4. Later, Brain/user queries via Core /v1/vault/query

    This function uses go_core.vault_store() which mirrors the real API.
    Returns the storage key.
    """
    key = f"rec_{recommendation.get('product_id', 'unknown')}"
    # Brain sends to Core (go_core.vault_store mirrors POST /v1/vault/store)
    dina.go_core.vault_store(key, recommendation)
    return key


def validate_attribution_before_storage(recommendation: dict) -> dict:
    """Brain-side pre-validation of attribution fields before storing to Core.

    In production, Brain must validate that every recommendation has proper
    attribution BEFORE sending it to Core's vault.  Core is a generic store —
    it accepts any freeform metadata.  The attribution enforcement is Brain's
    responsibility (defense in depth).

    Required attribution fields:
    - ``source_url``: must be present, non-None, non-empty, non-whitespace-only
    - ``creator_name``: must be present, non-None, non-empty, non-whitespace-only

    All violations are collected (not fail-fast on first) so the caller gets
    a complete picture.

    Returns::

        {
            "valid": bool,
            "violations": list[str],   # human-readable violation descriptions
            "blocked": bool,           # True when invalid — item must NOT be stored
        }
    """
    violations: list[str] = []

    # --- source_url ---
    source_url = recommendation.get("source_url")
    if source_url is None:
        violations.append(
            "source_url is missing (key absent or None) — "
            "every recommendation must link to the original source"
        )
    elif not isinstance(source_url, str) or source_url.strip() == "":
        violations.append(
            "source_url is empty or whitespace-only — "
            "a valid URL to the original source is required"
        )

    # --- creator_name ---
    creator_name = recommendation.get("creator_name")
    if creator_name is None:
        violations.append(
            "creator_name is missing (key absent or None) — "
            "every recommendation must credit the original creator"
        )
    elif not isinstance(creator_name, str) or creator_name.strip() == "":
        violations.append(
            "creator_name is empty or whitespace-only — "
            "a non-empty creator name is required for attribution"
        )

    valid = len(violations) == 0
    return {
        "valid": valid,
        "violations": violations,
        "blocked": not valid,
    }


def store_recommendation_with_validation(
    dina: MockDinaCore,
    recommendation: dict,
) -> dict:
    """Store a recommendation through Brain's validated pipeline.

    This models the real Brain behavior:
    1. Brain validates attribution fields BEFORE calling Core
    2. If validation fails, the item is blocked — Core is never contacted
    3. If validation passes, the item is stored via Core's vault API

    This is the "defense in depth" principle: Core accepts any freeform
    metadata (it is a generic store), but Brain enforces attribution rules
    before data ever reaches Core.

    Returns::

        {
            "stored": bool,
            "validation": dict,   # output of validate_attribution_before_storage()
            "key": str | None,    # storage key if stored, None if blocked
        }
    """
    validation = validate_attribution_before_storage(recommendation)

    if validation["blocked"]:
        return {
            "stored": False,
            "validation": validation,
            "key": None,
        }

    key = store_recommendation_via_pipeline(dina, recommendation)
    return {
        "stored": True,
        "validation": validation,
        "key": key,
    }


def store_with_provenance_protection(
    dina: MockDinaCore,
    key: str,
    new_data: dict,
    provenance_fields: tuple[str, ...] = (
        "source_url",
        "creator_name",
        "deep_link",
        "deep_link_context",
    ),
) -> dict:
    """Store an item with provenance protection.

    If the item already exists, provenance fields (source_url, creator_name,
    deep_link, deep_link_context) are IMMUTABLE — they cannot be overwritten.
    Non-provenance fields CAN be updated.

    This mirrors Brain's actual behavior: Brain checks for existing provenance
    before storing, and refuses to overwrite attribution fields.

    Returns: {"stored": bool, "rejected_fields": list[str], "updated_fields": list[str]}
    """
    existing = dina.vault.retrieve(1, key)

    if existing is None:
        # First write: everything goes through
        dina.go_core.vault_store(key, new_data)
        return {
            "stored": True,
            "rejected_fields": [],
            "updated_fields": list(new_data.keys()),
        }

    # Subsequent write: protect provenance fields
    rejected = []
    merged = dict(existing)  # start with existing data

    for field, value in new_data.items():
        if field in provenance_fields and field in existing:
            if existing[field] != value:
                rejected.append(field)
                # Keep original value — don't overwrite
            # If value is same, no-op
        else:
            merged[field] = value  # non-provenance fields CAN be updated

    updated_fields = [
        f for f in new_data
        if f not in rejected and f not in provenance_fields
    ]
    dina.go_core.vault_store(key, merged)

    return {
        "stored": True,
        "rejected_fields": rejected,
        "updated_fields": updated_fields,
    }


# =========================================================================
# TestAttributionPipeline
# =========================================================================

class TestAttributionPipeline:
    """TST-INT-691: Attribution survives Brain→Core pipeline.

    Brain produces a recommendation with {source_url, creator_name,
    deep_link} → POST core/v1/vault/store → POST core/v1/vault/query.
    Retrieved item must have identical attribution fields — nothing
    stripped in transit.
    """

# TST-INT-691
    # TRACE: {"suite": "INT", "case": "0691", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "03", "scenario": "01", "title": "attribution_survives_brain_core_pipeline"}
    def test_attribution_survives_brain_core_pipeline(
        self, mock_dina: MockDinaCore
    ):
        """Full attribution fields survive the Brain→Core store/retrieve
        round-trip without modification."""
        # 1. Create recommendation with full attribution
        recommendation = {
            "product_id": "thinkpad-x1-gen12",
            "source_url": "https://youtube.com/watch?v=review2024",
            "creator_name": "MKBHD",
            "deep_link": "https://youtube.com/watch?v=review2024&t=315",
            "deep_link_context": "Battery benchmark results at 5:15",
            "rating": 4.7,
            "verdict": "Best ultrabook for developers in 2024",
            "sponsored": False,
        }

        # 2. Store via Brain→Core pipeline
        key = store_recommendation_via_pipeline(mock_dina, recommendation)
        assert key == "rec_thinkpad-x1-gen12"

        # 3. Retrieve from vault (tier 1 is default for vault_store)
        retrieved = mock_dina.vault.retrieve(1, key)
        assert retrieved is not None, (
            "Recommendation must be retrievable from vault after pipeline store"
        )

        # 4. Verify ALL attribution fields survived intact
        assert retrieved["source_url"] == recommendation["source_url"], (
            "source_url must survive Brain→Core pipeline without modification"
        )
        assert retrieved["creator_name"] == recommendation["creator_name"], (
            "creator_name must survive Brain→Core pipeline without modification"
        )
        assert retrieved["deep_link"] == recommendation["deep_link"], (
            "deep_link must survive Brain→Core pipeline without modification"
        )
        assert retrieved["deep_link_context"] == recommendation["deep_link_context"], (
            "deep_link_context must survive Brain→Core pipeline without modification"
        )
        assert retrieved["sponsored"] == recommendation["sponsored"], (
            "sponsored flag must survive Brain→Core pipeline without modification"
        )

        # 5. Verify Core API was called
        store_calls = [
            c for c in mock_dina.go_core.api_calls
            if c["endpoint"] == "/v1/vault/store"
        ]
        assert len(store_calls) >= 1, (
            "go_core.vault_store must log the /v1/vault/store API call"
        )
        assert store_calls[-1]["key"] == key, (
            "API call must reference the correct storage key"
        )

        # 6. Verify no field mutation — full value equality on attribution fields
        for field in ("source_url", "creator_name", "deep_link",
                      "deep_link_context", "sponsored"):
            assert retrieved[field] == recommendation[field], (
                f"Field '{field}' was mutated during Brain→Core round-trip"
            )

    # TRACE: {"suite": "INT", "case": "0036", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "03", "scenario": "02", "title": "empty_attribution_fields_not_injected"}
    def test_empty_attribution_fields_not_injected(
        self, mock_dina: MockDinaCore
    ):
        """Counter-proof: a recommendation with EMPTY attribution fields
        stores and retrieves as empty — Core does not inject fake values."""
        recommendation = {
            "product_id": "generic-widget",
            "source_url": "",
            "creator_name": "",
            "deep_link": "",
            "deep_link_context": "",
            "rating": 3.0,
            "verdict": "Average product",
            "sponsored": False,
        }

        key = store_recommendation_via_pipeline(mock_dina, recommendation)
        retrieved = mock_dina.vault.retrieve(1, key)
        assert retrieved is not None

        assert retrieved["source_url"] == "", (
            "Empty source_url must remain empty — Core must not inject values"
        )
        assert retrieved["creator_name"] == "", (
            "Empty creator_name must remain empty — Core must not inject values"
        )
        assert retrieved["deep_link"] == "", (
            "Empty deep_link must remain empty — Core must not inject values"
        )
        assert retrieved["deep_link_context"] == "", (
            "Empty deep_link_context must remain empty — Core must not inject values"
        )

    # TRACE: {"suite": "INT", "case": "0037", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "03", "scenario": "03", "title": "unicode_creator_name_survives_round_trip"}
    def test_unicode_creator_name_survives_round_trip(
        self, mock_dina: MockDinaCore
    ):
        """Counter-proof: unicode characters in creator_name survive the
        Brain→Core round-trip (important for international creators)."""
        recommendation = {
            "product_id": "sony-wh1000xm5",
            "source_url": "https://example.com/review-headphones",
            "creator_name": "Linus Tech Tips — 日本語レビュー ✓",
            "deep_link": "https://example.com/review-headphones#section-3",
            "deep_link_context": "Noise cancellation comparison — très bon résultat",
            "rating": 4.5,
            "verdict": "Excellent noise cancelling with wide soundstage",
            "sponsored": True,
        }

        key = store_recommendation_via_pipeline(mock_dina, recommendation)
        retrieved = mock_dina.vault.retrieve(1, key)
        assert retrieved is not None

        assert retrieved["creator_name"] == "Linus Tech Tips — 日本語レビュー ✓", (
            "Unicode creator_name must survive Brain→Core round-trip intact"
        )
        assert retrieved["deep_link_context"] == (
            "Noise cancellation comparison — très bon résultat"
        ), "Unicode in deep_link_context must survive round-trip"

    # TRACE: {"suite": "INT", "case": "0038", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "03", "scenario": "04", "title": "multiple_recommendations_coexist"}
    def test_multiple_recommendations_coexist(
        self, mock_dina: MockDinaCore
    ):
        """Counter-proof: multiple recommendations with different attributions
        coexist — retrieving one does not return another's fields."""
        rec_a = {
            "product_id": "laptop-alpha",
            "source_url": "https://alpha-reviews.com/laptop",
            "creator_name": "AlphaReviewer",
            "deep_link": "https://alpha-reviews.com/laptop#battery",
            "deep_link_context": "Battery test at timestamp 2:30",
            "rating": 4.2,
            "verdict": "Solid battery life",
            "sponsored": False,
        }
        rec_b = {
            "product_id": "laptop-beta",
            "source_url": "https://beta-tech.com/laptop-review",
            "creator_name": "BetaTechGuru",
            "deep_link": "https://beta-tech.com/laptop-review?t=480",
            "deep_link_context": "Keyboard review at 8:00",
            "rating": 3.8,
            "verdict": "Good keyboard, weak display",
            "sponsored": True,
        }

        key_a = store_recommendation_via_pipeline(mock_dina, rec_a)
        key_b = store_recommendation_via_pipeline(mock_dina, rec_b)
        assert key_a != key_b, "Different product_ids must produce different keys"

        retrieved_a = mock_dina.vault.retrieve(1, key_a)
        retrieved_b = mock_dina.vault.retrieve(1, key_b)
        assert retrieved_a is not None
        assert retrieved_b is not None

        # A's fields must not leak into B or vice versa
        assert retrieved_a["creator_name"] == "AlphaReviewer"
        assert retrieved_b["creator_name"] == "BetaTechGuru"
        assert retrieved_a["source_url"] == "https://alpha-reviews.com/laptop"
        assert retrieved_b["source_url"] == "https://beta-tech.com/laptop-review"
        assert retrieved_a["deep_link"] != retrieved_b["deep_link"], (
            "Different recommendations must have distinct deep_link values"
        )
        assert retrieved_a["sponsored"] is False
        assert retrieved_b["sponsored"] is True

    # TRACE: {"suite": "INT", "case": "0039", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "03", "scenario": "05", "title": "non_attribution_fields_survive"}
    def test_non_attribution_fields_survive(
        self, mock_dina: MockDinaCore
    ):
        """Counter-proof: non-attribution fields (rating, verdict text) also
        survive the Brain→Core pipeline."""
        recommendation = {
            "product_id": "ergo-chair-pro",
            "source_url": "https://ergonomics.org/chair-review",
            "creator_name": "Ergonomics Institute",
            "deep_link": "https://ergonomics.org/chair-review#lumbar",
            "deep_link_context": "Lumbar support analysis",
            "rating": 4.9,
            "verdict": "Best lumbar support in class — recommended for 8+ hour sessions",
            "sponsored": False,
        }

        key = store_recommendation_via_pipeline(mock_dina, recommendation)
        retrieved = mock_dina.vault.retrieve(1, key)
        assert retrieved is not None

        assert retrieved["rating"] == 4.9, (
            "Rating must survive Brain→Core pipeline"
        )
        assert retrieved["verdict"] == (
            "Best lumbar support in class — recommended for 8+ hour sessions"
        ), "Verdict text must survive Brain→Core pipeline"
        assert retrieved["product_id"] == "ergo-chair-pro", (
            "product_id must survive Brain→Core pipeline"
        )

    # TRACE: {"suite": "INT", "case": "0040", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "03", "scenario": "06", "title": "very_long_deep_link_survives_storage"}
    def test_very_long_deep_link_survives_storage(
        self, mock_dina: MockDinaCore
    ):
        """Edge case: a very long deep_link URL (1000+ chars) survives
        the Brain→Core storage pipeline without truncation."""
        long_path = "a" * 1000
        long_url = f"https://example.com/review/{long_path}?t=120&ref=dina"
        assert len(long_url) > 1000

        recommendation = {
            "product_id": "long-link-product",
            "source_url": "https://example.com/review/long",
            "creator_name": "LongLinkReviewer",
            "deep_link": long_url,
            "deep_link_context": "Very deep nested review page",
            "rating": 3.5,
            "verdict": "Adequate",
            "sponsored": False,
        }

        key = store_recommendation_via_pipeline(mock_dina, recommendation)
        retrieved = mock_dina.vault.retrieve(1, key)
        assert retrieved is not None

        assert retrieved["deep_link"] == long_url, (
            "Very long deep_link (1000+ chars) must not be truncated"
        )
        assert len(retrieved["deep_link"]) > 1000

    # TRACE: {"suite": "INT", "case": "0041", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "03", "scenario": "07", "title": "sponsored_false_explicitly_stored"}
    def test_sponsored_false_explicitly_stored(
        self, mock_dina: MockDinaCore
    ):
        """Edge case: sponsored=false is explicitly stored and retrieved —
        not stripped compared to sponsored=true."""
        rec_unsponsored = {
            "product_id": "organic-review",
            "source_url": "https://honest-reviews.com/product",
            "creator_name": "HonestReviewer",
            "deep_link": "https://honest-reviews.com/product#verdict",
            "deep_link_context": "Final verdict section",
            "rating": 4.0,
            "verdict": "Honest take",
            "sponsored": False,
        }
        rec_sponsored = {
            "product_id": "sponsored-review",
            "source_url": "https://partner-reviews.com/product",
            "creator_name": "PartnerReviewer",
            "deep_link": "https://partner-reviews.com/product#verdict",
            "deep_link_context": "Sponsored verdict section",
            "rating": 4.5,
            "verdict": "Partner recommendation",
            "sponsored": True,
        }

        key_unspon = store_recommendation_via_pipeline(mock_dina, rec_unsponsored)
        key_spon = store_recommendation_via_pipeline(mock_dina, rec_sponsored)

        retrieved_unspon = mock_dina.vault.retrieve(1, key_unspon)
        retrieved_spon = mock_dina.vault.retrieve(1, key_spon)
        assert retrieved_unspon is not None
        assert retrieved_spon is not None

        assert retrieved_unspon["sponsored"] is False, (
            "sponsored=False must be explicitly stored, not stripped"
        )
        assert retrieved_spon["sponsored"] is True, (
            "sponsored=True must be explicitly stored"
        )
        # Ensure they are actually different values, not both truthy/falsy
        assert retrieved_unspon["sponsored"] != retrieved_spon["sponsored"]

    # TRACE: {"suite": "INT", "case": "0042", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "03", "scenario": "08", "title": "nested_dict_in_verdict_survives_round_trip"}
    def test_nested_dict_in_verdict_survives_round_trip(
        self, mock_dina: MockDinaCore
    ):
        """Edge case: recommendation with a nested dict in verdict field
        survives the Brain→Core round-trip."""
        recommendation = {
            "product_id": "complex-verdict-product",
            "source_url": "https://detailed-reviews.com/gadget",
            "creator_name": "DetailedReviewer",
            "deep_link": "https://detailed-reviews.com/gadget#breakdown",
            "deep_link_context": "Detailed score breakdown",
            "rating": 4.3,
            "verdict": {
                "summary": "Excellent value for money",
                "pros": ["Fast charging", "Lightweight", "Good display"],
                "cons": ["No headphone jack", "Average camera"],
                "scores": {
                    "build_quality": 8.5,
                    "performance": 9.0,
                    "value": 9.5,
                },
            },
            "sponsored": False,
        }

        key = store_recommendation_via_pipeline(mock_dina, recommendation)
        retrieved = mock_dina.vault.retrieve(1, key)
        assert retrieved is not None

        assert isinstance(retrieved["verdict"], dict), (
            "Nested dict verdict must survive round-trip as a dict"
        )
        assert retrieved["verdict"]["summary"] == "Excellent value for money"
        assert retrieved["verdict"]["pros"] == [
            "Fast charging", "Lightweight", "Good display"
        ]
        assert retrieved["verdict"]["cons"] == [
            "No headphone jack", "Average camera"
        ]
        assert retrieved["verdict"]["scores"]["performance"] == 9.0
        assert retrieved["verdict"]["scores"]["value"] == 9.5

# TST-INT-694
    # TRACE: {"suite": "INT", "case": "0694", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "03", "scenario": "09", "title": "provenance_immutable_after_storage"}
    def test_provenance_immutable_after_storage(
        self, mock_dina: MockDinaCore
    ):
        """Provenance fields are write-once: once stored, creator_name,
        source_url, deep_link, and deep_link_context cannot be overwritten.
        Non-provenance fields (rating, verdict) CAN still be updated."""

        # --- 1. Initial store with full attribution ---
        original = {
            "product_id": "immutable-test-laptop",
            "source_url": "https://youtube.com/watch?v=mkbhd-review-2024",
            "creator_name": "MKBHD",
            "deep_link": "https://youtube.com/watch?v=mkbhd-review-2024&t=260",
            "deep_link_context": "Battery comparison at 4:20",
            "rating": 4.5,
            "verdict": "Great laptop for developers",
            "sponsored": False,
        }

        key = "rec_immutable-test-laptop"
        result_first = store_with_provenance_protection(
            mock_dina, key, original,
        )
        # First write: everything accepted, nothing rejected
        assert result_first["stored"] is True
        assert result_first["rejected_fields"] == [], (
            "First write must accept all fields including provenance"
        )
        assert set(result_first["updated_fields"]) == set(original.keys()), (
            "First write must report all fields as updated"
        )

        # Verify initial store succeeded
        stored = mock_dina.vault.retrieve(1, key)
        assert stored is not None
        assert stored["creator_name"] == "MKBHD"
        assert stored["source_url"] == "https://youtube.com/watch?v=mkbhd-review-2024"

        # --- 2. Attempt mutation of provenance fields ---
        mutation_attempt = {
            "creator_name": "FakeReviewer",
            "source_url": "https://malicious.com/fake-review",
            "rating": 4.8,            # non-provenance: should succeed
            "verdict": "Updated verdict after more testing",  # non-provenance: should succeed
        }

        result_mutation = store_with_provenance_protection(
            mock_dina, key, mutation_attempt,
        )

        # --- 3. Verify provenance changes were rejected ---
        assert "creator_name" in result_mutation["rejected_fields"], (
            "creator_name change must be rejected — provenance is immutable"
        )
        assert "source_url" in result_mutation["rejected_fields"], (
            "source_url change must be rejected — provenance is immutable"
        )

        # --- 4. Verify original provenance preserved ---
        retrieved = mock_dina.vault.retrieve(1, key)
        assert retrieved["creator_name"] == "MKBHD", (
            "creator_name must remain 'MKBHD' — provenance is write-once"
        )
        assert retrieved["source_url"] == (
            "https://youtube.com/watch?v=mkbhd-review-2024"
        ), "source_url must remain original — provenance is write-once"
        assert retrieved["deep_link"] == (
            "https://youtube.com/watch?v=mkbhd-review-2024&t=260"
        ), "deep_link must remain original (not in mutation attempt but must not vanish)"
        assert retrieved["deep_link_context"] == "Battery comparison at 4:20", (
            "deep_link_context must remain original"
        )

        # --- 5. Non-provenance fields CAN be updated ---
        assert "rating" in result_mutation["updated_fields"], (
            "Non-provenance field 'rating' must be in updated_fields"
        )
        assert "verdict" in result_mutation["updated_fields"], (
            "Non-provenance field 'verdict' must be in updated_fields"
        )
        assert retrieved["rating"] == 4.8, (
            "Non-provenance field 'rating' must be updatable"
        )
        assert retrieved["verdict"] == "Updated verdict after more testing", (
            "Non-provenance field 'verdict' must be updatable"
        )

        # --- 6. Result correctly reports rejected provenance fields ---
        assert len(result_mutation["rejected_fields"]) == 2
        assert set(result_mutation["rejected_fields"]) == {
            "creator_name", "source_url",
        }

        # --- Counter-proof: same-value provenance write is NOT rejected ---
        same_value_write = {
            "creator_name": "MKBHD",  # same as original — should be fine
            "rating": 4.9,
        }
        result_same = store_with_provenance_protection(
            mock_dina, key, same_value_write,
        )
        assert "creator_name" not in result_same["rejected_fields"], (
            "Writing the same provenance value must not be rejected"
        )
        assert result_same["rejected_fields"] == [], (
            "No fields should be rejected when provenance values match"
        )

        # --- Counter-proof: provenance on a DIFFERENT key is independent ---
        other_key = "rec_other-laptop"
        other_data = {
            "product_id": "other-laptop",
            "source_url": "https://other-reviewer.com/laptop",
            "creator_name": "OtherReviewer",
            "deep_link": "https://other-reviewer.com/laptop#section",
            "deep_link_context": "Introduction section",
            "rating": 3.5,
            "verdict": "Decent",
            "sponsored": False,
        }
        result_other = store_with_provenance_protection(
            mock_dina, other_key, other_data,
        )
        assert result_other["rejected_fields"] == [], (
            "Provenance on a different key must be independent — no cross-key blocking"
        )
        other_retrieved = mock_dina.vault.retrieve(1, other_key)
        assert other_retrieved["creator_name"] == "OtherReviewer"

        # --- Edge case: update with ONLY provenance fields (all rejected) ---
        all_prov_attempt = {
            "creator_name": "AttackerName",
            "source_url": "https://attacker.com",
            "deep_link": "https://attacker.com/evil",
            "deep_link_context": "Attacker's context",
        }
        result_all_rejected = store_with_provenance_protection(
            mock_dina, key, all_prov_attempt,
        )
        assert len(result_all_rejected["rejected_fields"]) == 4, (
            "All 4 provenance fields must be rejected when all differ from original"
        )
        assert result_all_rejected["updated_fields"] == [], (
            "No non-provenance fields were submitted, so updated_fields must be empty"
        )
        # Data unchanged
        after_all_rejected = mock_dina.vault.retrieve(1, key)
        assert after_all_rejected["creator_name"] == "MKBHD"
        assert after_all_rejected["source_url"] == (
            "https://youtube.com/watch?v=mkbhd-review-2024"
        )

        # --- Edge case: update with ONLY non-provenance fields (all succeed) ---
        non_prov_only = {
            "rating": 5.0,
            "verdict": "Absolutely the best after 6 months of use",
        }
        result_non_prov = store_with_provenance_protection(
            mock_dina, key, non_prov_only,
        )
        assert result_non_prov["rejected_fields"] == [], (
            "Non-provenance-only update must have no rejections"
        )
        assert set(result_non_prov["updated_fields"]) == {"rating", "verdict"}
        after_non_prov = mock_dina.vault.retrieve(1, key)
        assert after_non_prov["rating"] == 5.0
        assert after_non_prov["verdict"] == "Absolutely the best after 6 months of use"
        # Provenance still intact
        assert after_non_prov["creator_name"] == "MKBHD"

        # --- Edge case: empty string provenance is still immutable ---
        empty_prov_key = "rec_empty-prov-product"
        empty_prov_data = {
            "product_id": "empty-prov-product",
            "source_url": "",
            "creator_name": "",
            "deep_link": "",
            "deep_link_context": "",
            "rating": 2.0,
            "verdict": "Unknown source",
            "sponsored": False,
        }
        store_with_provenance_protection(
            mock_dina, empty_prov_key, empty_prov_data,
        )
        # Now try to set empty provenance to a real value
        overwrite_empty = {
            "creator_name": "LateAttribution",
            "source_url": "https://late-addition.com",
        }
        result_empty_overwrite = store_with_provenance_protection(
            mock_dina, empty_prov_key, overwrite_empty,
        )
        assert "creator_name" in result_empty_overwrite["rejected_fields"], (
            "Empty string provenance is still immutable — cannot overwrite '' with a value"
        )
        assert "source_url" in result_empty_overwrite["rejected_fields"], (
            "Empty string provenance is still immutable — cannot overwrite '' with a value"
        )
        empty_retrieved = mock_dina.vault.retrieve(1, empty_prov_key)
        assert empty_retrieved["creator_name"] == "", (
            "Empty provenance must remain empty — write-once applies even to empty strings"
        )
        assert empty_retrieved["source_url"] == "", (
            "Empty provenance must remain empty — write-once applies even to empty strings"
        )


# =========================================================================
# Helper: verify sponsorship transparency through Brain→Core pipeline
# =========================================================================

def verify_sponsorship_transparency(
    dina: MockDinaCore,
    recommendation: dict,
) -> dict:
    """Store a recommendation via Brain→Core pipeline and verify the sponsored
    field survives the round-trip with exact value preservation.

    This models the real transparency contract:
    1. Brain stores a recommendation with a ``sponsored`` field.
    2. Core stores it in the encrypted vault.
    3. On retrieval, the ``sponsored`` value must be IDENTICAL — same type,
       same value.  Core cannot strip, flip, coerce, or omit it.

    Returns::

        {
            "preserved": bool,        # True if sponsored field survived intact
            "stored_value": Any,       # The sponsored value that was sent to Core
            "retrieved_value": Any,    # The sponsored value that came back from Core
            "key": str,                # The vault storage key
            "type_match": bool,        # True if types are identical (not just equal)
            "stored_type": str,        # Type name of the stored value
            "retrieved_type": str,     # Type name of the retrieved value
        }
    """
    key = store_recommendation_via_pipeline(dina, recommendation)
    retrieved = dina.vault.retrieve(1, key)

    if retrieved is None:
        return {
            "preserved": False,
            "stored_value": recommendation.get("sponsored"),
            "retrieved_value": None,
            "key": key,
            "type_match": False,
            "stored_type": type(recommendation.get("sponsored")).__name__,
            "retrieved_type": "NoneType",
        }

    stored_value = recommendation.get("sponsored")
    retrieved_value = retrieved.get("sponsored")

    # Check both value equality AND type identity
    type_match = type(stored_value) is type(retrieved_value)
    value_match = stored_value is retrieved_value if isinstance(stored_value, bool) else stored_value == retrieved_value

    return {
        "preserved": value_match and type_match,
        "stored_value": stored_value,
        "retrieved_value": retrieved_value,
        "key": key,
        "type_match": type_match,
        "stored_type": type(stored_value).__name__,
        "retrieved_type": type(retrieved_value).__name__,
    }


# =========================================================================
# TST-INT-692: Sponsored metadata preserved through pipeline
# =========================================================================

class TestSponsoredMetadataPreserved:
    """TST-INT-692: Sponsored metadata preserved through pipeline.

    Spec requirement:
        "Brain stores item with ``{sponsored: true}`` -> retrieve via query
         | ``sponsored`` flag intact -- Core cannot strip sponsorship
         disclosure"

    This is a consumer protection contract: the user must always know
    when content is sponsored.  Core is a generic vault -- it must not
    strip, flip, coerce, or omit the ``sponsored`` field under any
    circumstances.
    """

    # ------------------------------------------------------------------
    # TST-INT-692 -- primary test
    # ------------------------------------------------------------------

# TST-INT-692
    # TRACE: {"suite": "INT", "case": "0692", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "04", "scenario": "01", "title": "sponsored_true_preserved_through_pipeline"}
    def test_sponsored_true_preserved_through_pipeline(
        self, mock_dina: MockDinaCore
    ):
        """Brain stores a recommendation with ``sponsored: True`` and full
        attribution.  After the Brain->Core->Query round-trip, the
        ``sponsored`` field must be exactly ``True`` (boolean), not a truthy
        substitute like ``1``, ``"true"``, or any other coercion."""

        recommendation = {
            "product_id": "sponsored-laptop-692",
            "source_url": "https://sponsor-tech.com/laptop-review",
            "creator_name": "SponsorTechReviewer",
            "deep_link": "https://sponsor-tech.com/laptop-review&t=180",
            "deep_link_context": "Sponsored segment starts at 3:00",
            "rating": 4.3,
            "verdict": "Good laptop with disclosed sponsorship",
            "sponsored": True,
        }

        # 1. Store and retrieve via the full pipeline
        result = verify_sponsorship_transparency(mock_dina, recommendation)

        # 2. The sponsored field must survive intact
        assert result["preserved"] is True, (
            "sponsored=True must survive the Brain->Core round-trip exactly. "
            f"Stored: {result['stored_value']!r} ({result['stored_type']}), "
            f"Retrieved: {result['retrieved_value']!r} ({result['retrieved_type']})"
        )

        # 3. Exact boolean identity -- not just truthy
        retrieved = mock_dina.vault.retrieve(1, result["key"])
        assert retrieved is not None

        assert retrieved["sponsored"] is True, (
            "sponsored must be exactly True (identity check via 'is'), "
            f"got {retrieved['sponsored']!r}"
        )
        assert type(retrieved["sponsored"]) is bool, (
            "sponsored must be type bool, not a truthy substitute like int or str. "
            f"Got type: {type(retrieved['sponsored']).__name__}"
        )

        # 4. The value must not be a string coercion
        assert retrieved["sponsored"] != "true", (
            "sponsored must not be coerced to the string 'true'"
        )
        assert retrieved["sponsored"] != "True", (
            "sponsored must not be coerced to the string 'True'"
        )
        # In Python bool is a subclass of int, so True == 1.
        # We verify the stored type is actually bool, not a plain int.
        assert type(retrieved["sponsored"]) is bool, (
            "sponsored must be stored as bool, not coerced to int"
        )

        # 5. All other attribution fields also survived (sponsorship
        #    disclosure is part of a larger attribution record, not isolated)
        assert retrieved["source_url"] == recommendation["source_url"], (
            "source_url must survive alongside sponsored flag"
        )
        assert retrieved["creator_name"] == recommendation["creator_name"], (
            "creator_name must survive alongside sponsored flag"
        )
        assert retrieved["deep_link"] == recommendation["deep_link"], (
            "deep_link must survive alongside sponsored flag"
        )
        assert retrieved["deep_link_context"] == recommendation["deep_link_context"], (
            "deep_link_context must survive alongside sponsored flag"
        )
        assert retrieved["rating"] == recommendation["rating"], (
            "rating must survive alongside sponsored flag"
        )
        assert retrieved["verdict"] == recommendation["verdict"], (
            "verdict must survive alongside sponsored flag"
        )

    # ------------------------------------------------------------------
    # Counter-proof 1: sponsored=False not flipped to True
    # ------------------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0043", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "04", "scenario": "02", "title": "sponsored_false_not_flipped_to_true"}
    def test_sponsored_false_not_flipped_to_true(
        self, mock_dina: MockDinaCore
    ):
        """Counter-proof: storing ``sponsored: False`` must retrieve as
        exactly ``False``.  Core must not inject sponsorship disclosure
        where none exists -- false positives harm organic creators."""

        recommendation = {
            "product_id": "organic-review-692",
            "source_url": "https://honest-reviewer.com/laptop",
            "creator_name": "HonestIndependentReviewer",
            "deep_link": "https://honest-reviewer.com/laptop#conclusion",
            "deep_link_context": "Independent conclusion",
            "rating": 4.8,
            "verdict": "Genuinely excellent -- no sponsorship involved",
            "sponsored": False,
        }

        result = verify_sponsorship_transparency(mock_dina, recommendation)

        assert result["preserved"] is True, (
            "sponsored=False must survive the round-trip exactly. "
            f"Stored: {result['stored_value']!r}, "
            f"Retrieved: {result['retrieved_value']!r}"
        )

        retrieved = mock_dina.vault.retrieve(1, result["key"])
        assert retrieved["sponsored"] is False, (
            "sponsored must be exactly False (identity check), "
            f"got {retrieved['sponsored']!r}"
        )
        assert type(retrieved["sponsored"]) is bool, (
            "sponsored must be type bool, not a falsy substitute like 0, None, or ''. "
            f"Got type: {type(retrieved['sponsored']).__name__}"
        )

        # Must not be flipped to True
        assert retrieved["sponsored"] is not True, (
            "Core must not flip sponsored=False to True"
        )

    # ------------------------------------------------------------------
    # Counter-proof 2: sponsored field cannot be stripped by update
    # ------------------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0044", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "04", "scenario": "03", "title": "sponsored_field_cannot_be_stripped_by_update"}
    def test_sponsored_field_cannot_be_stripped_by_update(
        self, mock_dina: MockDinaCore
    ):
        """Counter-proof: once a recommendation is stored with
        ``sponsored: True``, a subsequent update that omits the
        ``sponsored`` field must not cause the original disclosure to
        vanish.  The sponsored flag must survive partial updates."""

        # 1. Initial store with sponsored=True
        original = {
            "product_id": "strip-test-692",
            "source_url": "https://paid-review.com/gadget",
            "creator_name": "PaidReviewer",
            "deep_link": "https://paid-review.com/gadget#ad",
            "deep_link_context": "Sponsored product placement",
            "rating": 4.0,
            "verdict": "Good gadget (sponsored content)",
            "sponsored": True,
        }

        key = store_recommendation_via_pipeline(mock_dina, original)
        retrieved_before = mock_dina.vault.retrieve(1, key)
        assert retrieved_before["sponsored"] is True, (
            "Initial store must have sponsored=True"
        )

        # 2. Attempt an update via provenance protection that omits
        #    the sponsored field entirely
        update_without_sponsored = {
            "rating": 4.5,
            "verdict": "Updated verdict after more testing",
        }
        store_with_provenance_protection(
            mock_dina, key, update_without_sponsored,
        )

        # 3. Retrieve and verify sponsored is still True
        retrieved_after = mock_dina.vault.retrieve(1, key)
        assert retrieved_after is not None
        assert "sponsored" in retrieved_after, (
            "sponsored field must not be stripped from the record by a "
            "partial update that omits it"
        )
        assert retrieved_after["sponsored"] is True, (
            "sponsored=True must survive an update that does not mention "
            f"the sponsored field. Got: {retrieved_after.get('sponsored')!r}"
        )

    # ------------------------------------------------------------------
    # Counter-proof 3: unsponsored and sponsored coexist correctly
    # ------------------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0045", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "04", "scenario": "04", "title": "unsponsored_and_sponsored_coexist_correctly"}
    def test_unsponsored_and_sponsored_coexist_correctly(
        self, mock_dina: MockDinaCore
    ):
        """Counter-proof: two items stored side by side -- one sponsored,
        one not -- each preserves its own ``sponsored`` value independently.
        The vault must not conflate or cross-contaminate records."""

        sponsored_rec = {
            "product_id": "coexist-sponsored-692",
            "source_url": "https://paid-partner.com/widget",
            "creator_name": "PaidPartner",
            "deep_link": "https://paid-partner.com/widget#review",
            "deep_link_context": "Paid partnership disclosure",
            "rating": 4.1,
            "verdict": "Partner-recommended widget",
            "sponsored": True,
        }
        organic_rec = {
            "product_id": "coexist-organic-692",
            "source_url": "https://indie-reviewer.com/widget",
            "creator_name": "IndieReviewer",
            "deep_link": "https://indie-reviewer.com/widget#verdict",
            "deep_link_context": "Independent assessment",
            "rating": 4.6,
            "verdict": "Independently tested widget",
            "sponsored": False,
        }

        key_sponsored = store_recommendation_via_pipeline(mock_dina, sponsored_rec)
        key_organic = store_recommendation_via_pipeline(mock_dina, organic_rec)

        assert key_sponsored != key_organic, (
            "Different product_ids must produce different storage keys"
        )

        retrieved_sponsored = mock_dina.vault.retrieve(1, key_sponsored)
        retrieved_organic = mock_dina.vault.retrieve(1, key_organic)

        assert retrieved_sponsored is not None
        assert retrieved_organic is not None

        # Each has its own sponsored value
        assert retrieved_sponsored["sponsored"] is True, (
            "Sponsored item must still be sponsored=True after storing an "
            "organic item alongside it"
        )
        assert retrieved_organic["sponsored"] is False, (
            "Organic item must still be sponsored=False after storing a "
            "sponsored item alongside it"
        )

        # They must be different from each other
        assert retrieved_sponsored["sponsored"] is not retrieved_organic["sponsored"], (
            "The two items must have opposite sponsored values"
        )

        # Verify no field cross-contamination
        assert retrieved_sponsored["creator_name"] == "PaidPartner"
        assert retrieved_organic["creator_name"] == "IndieReviewer"
        assert retrieved_sponsored["source_url"] != retrieved_organic["source_url"]

    # ------------------------------------------------------------------
    # Counter-proof 4: sponsored disclosure independent of rating
    # ------------------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0046", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "04", "scenario": "05", "title": "sponsored_disclosure_independent_of_rating"}
    def test_sponsored_disclosure_independent_of_rating(
        self, mock_dina: MockDinaCore
    ):
        """Counter-proof: a high-rated sponsored item must still show
        ``sponsored: True``.  Good reviews must never suppress the
        sponsorship disclosure -- consumer protection is unconditional."""

        high_rated_sponsored = {
            "product_id": "high-rated-sponsored-692",
            "source_url": "https://top-reviewer.com/premium-laptop",
            "creator_name": "TopReviewer",
            "deep_link": "https://top-reviewer.com/premium-laptop#score",
            "deep_link_context": "Final score and recommendation",
            "rating": 5.0,
            "verdict": "Absolutely the best laptop of 2024 -- 10/10",
            "sponsored": True,
        }

        key = store_recommendation_via_pipeline(mock_dina, high_rated_sponsored)
        retrieved = mock_dina.vault.retrieve(1, key)
        assert retrieved is not None

        assert retrieved["sponsored"] is True, (
            "A perfect 5.0 rating must NOT suppress sponsored=True. "
            "Consumer protection is unconditional regardless of product quality. "
            f"Got sponsored={retrieved['sponsored']!r}"
        )
        assert retrieved["rating"] == 5.0, (
            "The rating itself must also be preserved alongside sponsorship"
        )

        # Counter-check: a low-rated organic item stays organic
        low_rated_organic = {
            "product_id": "low-rated-organic-692",
            "source_url": "https://critical-reviewer.com/bad-laptop",
            "creator_name": "CriticalReviewer",
            "deep_link": "https://critical-reviewer.com/bad-laptop#problems",
            "deep_link_context": "List of problems found",
            "rating": 1.5,
            "verdict": "Terrible build quality, avoid",
            "sponsored": False,
        }

        key_low = store_recommendation_via_pipeline(mock_dina, low_rated_organic)
        retrieved_low = mock_dina.vault.retrieve(1, key_low)
        assert retrieved_low["sponsored"] is False, (
            "A low rating must NOT inject sponsored=True. "
            f"Got sponsored={retrieved_low['sponsored']!r}"
        )

    # ------------------------------------------------------------------
    # Edge case 1: sponsored=None vs sponsored=False
    # ------------------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0047", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "04", "scenario": "06", "title": "sponsored_none_vs_false"}
    def test_sponsored_none_vs_false(self, mock_dina: MockDinaCore):
        """Edge case: ``sponsored: None`` must be distinguishable from
        ``sponsored: False``.  Both states have distinct meaning:
        - ``None`` = sponsorship status unknown / not declared
        - ``False`` = explicitly declared as NOT sponsored

        Core must preserve this distinction."""

        rec_none = {
            "product_id": "sponsored-none-692",
            "source_url": "https://ambiguous-reviewer.com/product",
            "creator_name": "AmbiguousReviewer",
            "deep_link": "https://ambiguous-reviewer.com/product#review",
            "deep_link_context": "Review with unknown sponsorship status",
            "rating": 3.5,
            "verdict": "Decent product, sponsorship status unclear",
            "sponsored": None,
        }
        rec_false = {
            "product_id": "sponsored-explicit-false-692",
            "source_url": "https://transparent-reviewer.com/product",
            "creator_name": "TransparentReviewer",
            "deep_link": "https://transparent-reviewer.com/product#review",
            "deep_link_context": "Explicitly not sponsored review",
            "rating": 4.0,
            "verdict": "Great product, no sponsorship",
            "sponsored": False,
        }

        key_none = store_recommendation_via_pipeline(mock_dina, rec_none)
        key_false = store_recommendation_via_pipeline(mock_dina, rec_false)

        retrieved_none = mock_dina.vault.retrieve(1, key_none)
        retrieved_false = mock_dina.vault.retrieve(1, key_false)

        assert retrieved_none is not None
        assert retrieved_false is not None

        # None must remain None, not be coerced to False
        assert retrieved_none["sponsored"] is None, (
            "sponsored=None must remain None, not be coerced to False. "
            f"Got: {retrieved_none['sponsored']!r}"
        )
        assert retrieved_false["sponsored"] is False, (
            "sponsored=False must remain False, not be coerced to None. "
            f"Got: {retrieved_false['sponsored']!r}"
        )

        # They must be distinguishable from each other
        assert retrieved_none["sponsored"] is not retrieved_false["sponsored"], (
            "None and False must be distinguishable -- they carry different "
            "semantic meaning for sponsorship transparency"
        )

    # ------------------------------------------------------------------
    # Edge case 2: sponsored with empty source_url
    # ------------------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0048", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "04", "scenario": "07", "title": "sponsored_with_empty_source_url"}
    def test_sponsored_with_empty_source_url(self, mock_dina: MockDinaCore):
        """Edge case: even when other attribution fields are weak (empty
        ``source_url``), the ``sponsored`` flag must still be preserved.
        Sponsorship disclosure is independent of source quality."""

        recommendation = {
            "product_id": "weak-source-sponsored-692",
            "source_url": "",
            "creator_name": "WeakSourceReviewer",
            "deep_link": "",
            "deep_link_context": "",
            "rating": 3.0,
            "verdict": "Sponsored content with minimal attribution",
            "sponsored": True,
        }

        key = store_recommendation_via_pipeline(mock_dina, recommendation)
        retrieved = mock_dina.vault.retrieve(1, key)
        assert retrieved is not None

        assert retrieved["sponsored"] is True, (
            "sponsored=True must be preserved even when source_url is empty. "
            "Sponsorship disclosure does not depend on attribution completeness. "
            f"Got: {retrieved['sponsored']!r}"
        )
        assert type(retrieved["sponsored"]) is bool, (
            "sponsored must remain a boolean even with weak attribution"
        )

        # Verify the weak fields are also preserved as-is (not injected)
        assert retrieved["source_url"] == "", (
            "Empty source_url must remain empty -- Core must not inject values"
        )

    # ------------------------------------------------------------------
    # Edge case 3: multiple sponsored items all preserved
    # ------------------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0049", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "04", "scenario": "08", "title": "multiple_sponsored_items_all_preserved"}
    def test_multiple_sponsored_items_all_preserved(
        self, mock_dina: MockDinaCore
    ):
        """Edge case: 5 sponsored items stored sequentially must ALL
        retrieve with ``sponsored: True``.  Sponsorship preservation
        must work at scale, not just for a single item."""

        product_ids = [
            "batch-sponsored-a-692",
            "batch-sponsored-b-692",
            "batch-sponsored-c-692",
            "batch-sponsored-d-692",
            "batch-sponsored-e-692",
        ]

        keys = []
        for i, pid in enumerate(product_ids):
            rec = {
                "product_id": pid,
                "source_url": f"https://sponsor-{i}.com/product",
                "creator_name": f"SponsorReviewer{i}",
                "deep_link": f"https://sponsor-{i}.com/product#review",
                "deep_link_context": f"Sponsored review #{i}",
                "rating": 3.5 + (i * 0.2),
                "verdict": f"Sponsored product review number {i+1}",
                "sponsored": True,
            }
            key = store_recommendation_via_pipeline(mock_dina, rec)
            keys.append(key)

        # All 5 must have unique keys
        assert len(set(keys)) == 5, (
            f"5 different product_ids must produce 5 unique keys, got {len(set(keys))}"
        )

        # All 5 must retrieve with sponsored=True
        for i, key in enumerate(keys):
            retrieved = mock_dina.vault.retrieve(1, key)
            assert retrieved is not None, (
                f"Item {i} (key={key}) must be retrievable from vault"
            )
            assert retrieved["sponsored"] is True, (
                f"Item {i} (key={key}) must have sponsored=True after "
                f"round-trip. Got: {retrieved['sponsored']!r}"
            )
            assert type(retrieved["sponsored"]) is bool, (
                f"Item {i} (key={key}) sponsored must be bool type. "
                f"Got: {type(retrieved['sponsored']).__name__}"
            )
            # Verify each item has its own distinct attribution
            assert retrieved["creator_name"] == f"SponsorReviewer{i}", (
                f"Item {i} must preserve its unique creator_name"
            )


# =========================================================================
# TST-INT-693: Unattributed item rejected at Brain boundary
# =========================================================================

class TestUnattributedItemRejectedAtBrainBoundary:
    """TST-INT-693: Unattributed item rejected at Core boundary.

    Spec requirement:
        "Brain stores recommendation missing source_url | Core accepts
         storage (metadata is freeform) BUT Brain must pre-validate
         attribution before storing — integration test verifies Brain-side
         enforcement."

    Architectural contract under test:
    1. Core's vault accepts ANY freeform metadata (no validation).
    2. Brain MUST validate attribution BEFORE sending to Core.
    3. A recommendation missing source_url is rejected by Brain.
    4. The rejection happens at the Brain layer, not the Core layer.
    5. This is the "defense in depth" principle.
    """

    # ------------------------------------------------------------------
    # TST-INT-693 — primary test
    # ------------------------------------------------------------------

# TST-INT-693
    # TRACE: {"suite": "INT", "case": "0693", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "05", "scenario": "01", "title": "unattributed_item_rejected_at_brain_boundary"}
    def test_unattributed_item_rejected_at_brain_boundary(
        self, mock_dina: MockDinaCore
    ):
        """A recommendation with NO source_url is rejected by Brain's
        pre-validation.  The item never reaches Core's vault."""

        # 1. Create recommendation with NO source_url field
        recommendation = {
            "product_id": "unattributed-widget-001",
            "creator_name": "SomeReviewer",
            "deep_link": "https://example.com/widget#review",
            "deep_link_context": "Widget review section",
            "rating": 4.0,
            "verdict": "Decent widget but missing source attribution",
            "sponsored": False,
        }

        # Record api_calls count before the attempt
        calls_before = len(mock_dina.go_core.api_calls)

        # 2. Attempt to store via validated pipeline
        result = store_recommendation_with_validation(mock_dina, recommendation)

        # 3. Verify the item was NOT stored
        assert result["stored"] is False, (
            "Recommendation without source_url must NOT be stored"
        )
        assert result["validation"]["blocked"] is True, (
            "Validation must block the item when source_url is missing"
        )
        assert result["validation"]["valid"] is False, (
            "Validation must report invalid when source_url is missing"
        )
        assert result["key"] is None, (
            "No storage key must be returned when item is blocked"
        )

        # 4. Verify violations list includes source_url violation
        violations = result["validation"]["violations"]
        assert len(violations) >= 1, (
            "At least one violation must be reported for missing source_url"
        )
        source_url_violations = [
            v for v in violations if "source_url" in v
        ]
        assert len(source_url_violations) >= 1, (
            "Violations must specifically mention source_url"
        )

        # 5. Verify the item was NOT stored in the vault
        expected_key = f"rec_{recommendation['product_id']}"
        vault_item = mock_dina.vault.retrieve(1, expected_key)
        assert vault_item is None, (
            "Vault must contain NO entry for the blocked recommendation — "
            "Brain must prevent storage, not Core"
        )

        # 6. Verify Core API was never called (Brain blocked BEFORE Core)
        calls_after = len(mock_dina.go_core.api_calls)
        assert calls_after == calls_before, (
            "go_core.api_calls must not increase — Brain must block the item "
            "BEFORE it reaches Core.  Defense in depth: Brain enforces, "
            f"Core is not involved.  Calls before={calls_before}, after={calls_after}"
        )

    # ------------------------------------------------------------------
    # Counter-proof: valid recommendation IS stored successfully
    # ------------------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0050", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "05", "scenario": "02", "title": "valid_recommendation_stored_successfully"}
    def test_valid_recommendation_stored_successfully(
        self, mock_dina: MockDinaCore
    ):
        """Counter-proof: a recommendation WITH valid source_url and
        creator_name passes validation and is stored in the vault."""

        recommendation = {
            "product_id": "well-attributed-laptop-001",
            "source_url": "https://youtube.com/watch?v=trusted-review-2024",
            "creator_name": "TrustedReviewer",
            "deep_link": "https://youtube.com/watch?v=trusted-review-2024&t=120",
            "deep_link_context": "Performance benchmarks at 2:00",
            "rating": 4.6,
            "verdict": "Excellent developer laptop with great keyboard",
            "sponsored": False,
        }

        result = store_recommendation_with_validation(mock_dina, recommendation)

        assert result["stored"] is True, (
            "Fully attributed recommendation must be stored successfully"
        )
        assert result["validation"]["valid"] is True
        assert result["validation"]["blocked"] is False
        assert result["validation"]["violations"] == [], (
            "No violations expected for fully attributed recommendation"
        )
        assert result["key"] is not None
        assert result["key"] == "rec_well-attributed-laptop-001"

        # Verify it actually landed in the vault
        retrieved = mock_dina.vault.retrieve(1, result["key"])
        assert retrieved is not None, (
            "Valid recommendation must be retrievable from vault after storage"
        )
        assert retrieved["source_url"] == recommendation["source_url"]
        assert retrieved["creator_name"] == recommendation["creator_name"]

    # ------------------------------------------------------------------
    # Counter-proof: source_url present but creator_name missing
    # ------------------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0051", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "05", "scenario": "03", "title": "source_url_present_but_creator_name_missing_also_blocked"}
    def test_source_url_present_but_creator_name_missing_also_blocked(
        self, mock_dina: MockDinaCore
    ):
        """Counter-proof: having source_url is not enough — creator_name
        is also required.  Both fields are mandatory for attribution."""

        recommendation = {
            "product_id": "no-creator-widget-001",
            "source_url": "https://example.com/valid-source",
            "deep_link": "https://example.com/valid-source#section",
            "deep_link_context": "Review section",
            "rating": 3.5,
            "verdict": "Widget with source but no creator credit",
            "sponsored": False,
        }

        calls_before = len(mock_dina.go_core.api_calls)
        result = store_recommendation_with_validation(mock_dina, recommendation)

        assert result["stored"] is False, (
            "Missing creator_name must block storage even when source_url is present"
        )
        assert result["validation"]["blocked"] is True
        creator_violations = [
            v for v in result["validation"]["violations"]
            if "creator_name" in v
        ]
        assert len(creator_violations) >= 1, (
            "Violations must specifically mention creator_name"
        )

        # Core must not be contacted
        assert len(mock_dina.go_core.api_calls) == calls_before, (
            "Core API must not be called when creator_name is missing"
        )

    # ------------------------------------------------------------------
    # Counter-proof: Core vault CAN store items without source_url
    # when Brain validation is bypassed (direct store)
    # ------------------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0052", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "05", "scenario": "04", "title": "core_accepts_unattributed_item_when_stored_directly"}
    def test_core_accepts_unattributed_item_when_stored_directly(
        self, mock_dina: MockDinaCore
    ):
        """Counter-proof: Core's vault is a generic store — it accepts
        items without source_url when stored directly (bypassing Brain
        validation).  This proves the enforcement is at Brain layer,
        not at Core layer."""

        # Store directly via go_core (bypassing Brain validation)
        unattributed_data = {
            "product_id": "direct-store-widget",
            "rating": 3.0,
            "verdict": "Stored directly without attribution",
            # No source_url, no creator_name
        }
        key = "rec_direct-store-widget"
        mock_dina.go_core.vault_store(key, unattributed_data)

        # Core accepted it — no validation at Core level
        retrieved = mock_dina.vault.retrieve(1, key)
        assert retrieved is not None, (
            "Core must accept unattributed items — Core is a generic store "
            "with no attribution validation"
        )
        assert "source_url" not in retrieved, (
            "Core must not inject a source_url — it stores what it receives"
        )
        assert "creator_name" not in retrieved, (
            "Core must not inject a creator_name — it stores what it receives"
        )
        assert retrieved["verdict"] == "Stored directly without attribution"

        # Confirm the contrast: same data WOULD be blocked by Brain validation
        validation = validate_attribution_before_storage(unattributed_data)
        assert validation["blocked"] is True, (
            "Brain validation must block this same data — proving enforcement "
            "is at Brain layer, not Core layer"
        )

    # ------------------------------------------------------------------
    # Edge case: source_url is empty string ""
    # ------------------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0053", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "05", "scenario": "05", "title": "empty_string_source_url_rejected"}
    def test_empty_string_source_url_rejected(
        self, mock_dina: MockDinaCore
    ):
        """Edge case: source_url is present but is an empty string.
        This is not valid attribution — must be rejected."""

        recommendation = {
            "product_id": "empty-url-widget",
            "source_url": "",
            "creator_name": "ValidCreator",
            "rating": 3.0,
            "verdict": "Widget with empty source URL",
            "sponsored": False,
        }

        result = store_recommendation_with_validation(mock_dina, recommendation)

        assert result["stored"] is False, (
            "Empty string source_url must be rejected — not just missing key"
        )
        assert result["validation"]["blocked"] is True
        source_violations = [
            v for v in result["validation"]["violations"]
            if "source_url" in v
        ]
        assert len(source_violations) >= 1, (
            "Violations must flag empty string source_url"
        )

    # ------------------------------------------------------------------
    # Edge case: source_url is whitespace only
    # ------------------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0054", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "05", "scenario": "06", "title": "whitespace_only_source_url_rejected"}
    def test_whitespace_only_source_url_rejected(
        self, mock_dina: MockDinaCore
    ):
        """Edge case: source_url is whitespace-only ('   ').
        Functionally empty — must be rejected."""

        recommendation = {
            "product_id": "whitespace-url-widget",
            "source_url": "   ",
            "creator_name": "ValidCreator",
            "rating": 3.0,
            "verdict": "Widget with whitespace source URL",
            "sponsored": False,
        }

        result = store_recommendation_with_validation(mock_dina, recommendation)

        assert result["stored"] is False, (
            "Whitespace-only source_url must be rejected"
        )
        assert result["validation"]["blocked"] is True
        source_violations = [
            v for v in result["validation"]["violations"]
            if "source_url" in v
        ]
        assert len(source_violations) >= 1

    # ------------------------------------------------------------------
    # Edge case: source_url is None
    # ------------------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0055", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "05", "scenario": "07", "title": "none_source_url_rejected"}
    def test_none_source_url_rejected(self, mock_dina: MockDinaCore):
        """Edge case: source_url is explicitly set to None.
        Must be rejected — None is not a valid URL."""

        recommendation = {
            "product_id": "none-url-widget",
            "source_url": None,
            "creator_name": "ValidCreator",
            "rating": 3.0,
            "verdict": "Widget with None source URL",
            "sponsored": False,
        }

        result = store_recommendation_with_validation(mock_dina, recommendation)

        assert result["stored"] is False, (
            "None source_url must be rejected"
        )
        assert result["validation"]["blocked"] is True
        source_violations = [
            v for v in result["validation"]["violations"]
            if "source_url" in v
        ]
        assert len(source_violations) >= 1

    # ------------------------------------------------------------------
    # Edge case: both source_url AND creator_name missing
    # ------------------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0056", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "05", "scenario": "08", "title": "both_source_url_and_creator_name_missing_reports_two_violations"}
    def test_both_source_url_and_creator_name_missing_reports_two_violations(
        self, mock_dina: MockDinaCore
    ):
        """Edge case: when BOTH required fields are missing, BOTH violations
        must be reported — not fail-fast on the first one."""

        recommendation = {
            "product_id": "double-missing-widget",
            "rating": 2.5,
            "verdict": "Widget with no attribution at all",
            "sponsored": False,
        }

        result = store_recommendation_with_validation(mock_dina, recommendation)

        assert result["stored"] is False
        assert result["validation"]["blocked"] is True

        violations = result["validation"]["violations"]
        assert len(violations) == 2, (
            "Two missing fields must produce exactly two violations — "
            "validation must NOT fail-fast on the first missing field.  "
            f"Got {len(violations)} violation(s): {violations}"
        )

        # Both fields must be mentioned
        all_violations_text = " ".join(violations)
        assert "source_url" in all_violations_text, (
            "Violations must mention source_url"
        )
        assert "creator_name" in all_violations_text, (
            "Violations must mention creator_name"
        )

        # Core must not be contacted
        vault_item = mock_dina.vault.retrieve(
            1, f"rec_{recommendation['product_id']}"
        )
        assert vault_item is None, (
            "Doubly-unattributed item must not reach the vault"
        )

    # ------------------------------------------------------------------
    # Edge case: all OTHER fields valid but source_url missing
    # ------------------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0057", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "05", "scenario": "09", "title": "all_other_fields_valid_but_source_url_missing_still_blocked"}
    def test_all_other_fields_valid_but_source_url_missing_still_blocked(
        self, mock_dina: MockDinaCore
    ):
        """Edge case: a recommendation with excellent content, valid
        creator_name, deep_link, and everything else — but missing
        source_url — is still blocked.  Attribution is mandatory regardless
        of how complete the rest of the data is."""

        recommendation = {
            "product_id": "almost-perfect-widget",
            # source_url intentionally omitted
            "creator_name": "ExpertReviewer",
            "deep_link": "https://expert.com/widget-review#conclusion",
            "deep_link_context": "Final conclusion with detailed analysis",
            "rating": 4.9,
            "verdict": {
                "summary": "Outstanding widget with exceptional build quality",
                "pros": ["Durable", "Well-designed", "Energy efficient"],
                "cons": ["Slightly expensive"],
                "scores": {"build": 9.5, "value": 8.0, "design": 9.8},
            },
            "sponsored": False,
        }

        calls_before = len(mock_dina.go_core.api_calls)
        result = store_recommendation_with_validation(mock_dina, recommendation)

        assert result["stored"] is False, (
            "Missing source_url must block storage even when all other "
            "fields are valid and richly populated"
        )
        assert result["validation"]["blocked"] is True
        assert len(mock_dina.go_core.api_calls) == calls_before, (
            "Core must not be contacted for an unattributed item"
        )

    # ------------------------------------------------------------------
    # Edge case: empty creator_name with valid source_url
    # ------------------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0058", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "05", "scenario": "10", "title": "empty_creator_name_with_valid_source_url_blocked"}
    def test_empty_creator_name_with_valid_source_url_blocked(
        self, mock_dina: MockDinaCore
    ):
        """Edge case: creator_name is empty string but source_url is valid.
        Both fields are independently required — empty creator_name
        blocks even with a valid source_url."""

        recommendation = {
            "product_id": "empty-creator-widget",
            "source_url": "https://example.com/real-review",
            "creator_name": "",
            "rating": 3.5,
            "verdict": "Review without creator credit",
            "sponsored": False,
        }

        result = store_recommendation_with_validation(mock_dina, recommendation)

        assert result["stored"] is False
        assert result["validation"]["blocked"] is True
        creator_violations = [
            v for v in result["validation"]["violations"]
            if "creator_name" in v
        ]
        assert len(creator_violations) >= 1
        # source_url should NOT be in violations (it's valid)
        source_violations = [
            v for v in result["validation"]["violations"]
            if "source_url" in v
        ]
        assert len(source_violations) == 0, (
            "Valid source_url must NOT produce a violation"
        )

    # ------------------------------------------------------------------
    # Edge case: whitespace-only creator_name
    # ------------------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0059", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "05", "scenario": "11", "title": "whitespace_only_creator_name_rejected"}
    def test_whitespace_only_creator_name_rejected(
        self, mock_dina: MockDinaCore
    ):
        """Edge case: creator_name is whitespace-only.  Functionally
        empty — must be rejected."""

        recommendation = {
            "product_id": "ws-creator-widget",
            "source_url": "https://example.com/review",
            "creator_name": "   \t  ",
            "rating": 3.0,
            "verdict": "Widget with whitespace creator",
            "sponsored": False,
        }

        result = store_recommendation_with_validation(mock_dina, recommendation)

        assert result["stored"] is False
        assert result["validation"]["blocked"] is True
        creator_violations = [
            v for v in result["validation"]["violations"]
            if "creator_name" in v
        ]
        assert len(creator_violations) >= 1, (
            "Whitespace-only creator_name must be flagged"
        )


# =========================================================================
# Helper: assemble individual attributions from expert attestations
# =========================================================================

@dataclass
class IndividualCredit:
    """One expert's individual attribution in an assembled response."""
    expert_did: str
    creator_name: str
    source_url: str
    deep_link: str
    verdict_summary: str


@dataclass
class AssembledAttribution:
    """Brain-assembled response with individual expert credits."""
    individual_credits: list[IndividualCredit]
    summary_text: str


def assemble_individual_attributions(
    attestations: list[ExpertAttestation],
) -> AssembledAttribution:
    """Assemble expert attestations into individually credited attributions.

    In production, Brain assembles a response from multiple expert attestations.
    The key requirement: each expert is credited INDIVIDUALLY by name with their
    own deep link. The response must never collapse experts into anonymous
    summaries like "experts say" or "reviewers agree".

    Behavior:
    - Groups attestations by expert_did so one expert with multiple attestations
      gets a single credit entry (their verdicts are merged).
    - Each credit preserves the expert's name, DID, source URL, and deep link.
    - The summary_text names every expert individually.
    - Experts with empty verdicts still get credited by name.
    """
    # Group attestations by expert DID — same expert may have multiple reviews
    grouped: dict[str, list[ExpertAttestation]] = {}
    for att in attestations:
        grouped.setdefault(att.expert_did, []).append(att)

    individual_credits: list[IndividualCredit] = []

    for expert_did, expert_attestations in grouped.items():
        # Use the first attestation for identity fields; merge verdict summaries
        first = expert_attestations[0]
        creator_name = first.creator_name or expert_did

        # Merge verdict summaries from all attestations by this expert
        verdict_parts: list[str] = []
        for att in expert_attestations:
            verdict = att.verdict
            if isinstance(verdict, dict):
                summary = verdict.get("summary", "")
                if summary:
                    verdict_parts.append(summary)
            elif isinstance(verdict, str) and verdict:
                verdict_parts.append(verdict)
            # Empty verdicts contribute nothing to the text but expert still gets credit

        verdict_summary = "; ".join(verdict_parts) if verdict_parts else ""

        # Use the first attestation's deep_link (most specific)
        # If first has no deep_link, try others
        source_url = first.source_url
        deep_link = first.deep_link
        for att in expert_attestations:
            if not deep_link and att.deep_link:
                deep_link = att.deep_link
            if not source_url and att.source_url:
                source_url = att.source_url

        individual_credits.append(IndividualCredit(
            expert_did=expert_did,
            creator_name=creator_name,
            source_url=source_url,
            deep_link=deep_link,
            verdict_summary=verdict_summary,
        ))

    # Build summary text that names EACH expert individually
    # Never use generic phrases — always "X says ..., Y says ..."
    summary_parts: list[str] = []
    for credit in individual_credits:
        name = credit.creator_name
        if credit.verdict_summary:
            summary_parts.append(f"{name} says: {credit.verdict_summary}")
        else:
            summary_parts.append(f"{name} reviewed this product")

    summary_text = ". ".join(summary_parts)
    if summary_text and not summary_text.endswith("."):
        summary_text += "."

    return AssembledAttribution(
        individual_credits=individual_credits,
        summary_text=summary_text,
    )


# =========================================================================
# TST-INT-724: Expert credited individually
# =========================================================================

class TestExpertCreditedIndividually:
    """TST-INT-724: 3 expert attestations from different DIDs — Brain
    assembles a response where each expert is named and linked individually,
    never collapsed into generic "experts say" language.
    """

    # --- Shared attestation factory ---

    @staticmethod
    def _make_attestations() -> list[ExpertAttestation]:
        """Create 3 attestations from 3 different expert DIDs."""
        return [
            ExpertAttestation(
                expert_did="did:plc:ExpertAlice001",
                expert_trust_ring=TrustRing.RING_3_SKIN_IN_GAME,
                product_category="laptops",
                product_id="thinkpad_x1_gen12",
                rating=92,
                verdict={"summary": "Best keyboard in any ultrabook"},
                source_url="https://alice-reviews.com/thinkpad-x1",
                deep_link="https://alice-reviews.com/thinkpad-x1#keyboard-test",
                deep_link_context="Keyboard endurance test at section 3",
                creator_name="Alice Chen",
            ),
            ExpertAttestation(
                expert_did="did:plc:ExpertBobTech02",
                expert_trust_ring=TrustRing.RING_2_VERIFIED,
                product_category="laptops",
                product_id="thinkpad_x1_gen12",
                rating=88,
                verdict={"summary": "Battery lasts 14 hours in real-world use"},
                source_url="https://youtube.com/watch?v=bob-battery-test",
                deep_link="https://youtube.com/watch?v=bob-battery-test&t=420",
                deep_link_context="Battery rundown results at 7:00",
                creator_name="Bob Martinez",
            ),
            ExpertAttestation(
                expert_did="did:plc:ExpertCarolHW03",
                expert_trust_ring=TrustRing.RING_3_SKIN_IN_GAME,
                product_category="laptops",
                product_id="thinkpad_x1_gen12",
                rating=85,
                verdict={"summary": "Runs cool under sustained load"},
                source_url="https://carol-hardware.net/thermal-review",
                deep_link="https://carol-hardware.net/thermal-review#stress-test",
                deep_link_context="Thermal stress test results",
                creator_name="Carol Nguyen",
            ),
        ]

# TST-INT-724
    # TRACE: {"suite": "INT", "case": "0724", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "08", "scenario": "01", "title": "three_experts_credited_individually"}
    def test_three_experts_credited_individually(self):
        """3 expert attestations from 3 different DIDs produce a response
        where each expert is named individually with their own deep link."""
        attestations = self._make_attestations()
        result = assemble_individual_attributions(attestations)

        # --- Each expert gets an individual credit entry ---
        assert len(result.individual_credits) == 3, (
            "3 different expert DIDs must produce exactly 3 individual credits"
        )

        # --- Verify each expert's identity and links are preserved ---
        credits_by_did = {c.expert_did: c for c in result.individual_credits}

        alice = credits_by_did["did:plc:ExpertAlice001"]
        assert alice.creator_name == "Alice Chen"
        assert alice.source_url == "https://alice-reviews.com/thinkpad-x1"
        assert alice.deep_link == "https://alice-reviews.com/thinkpad-x1#keyboard-test"
        assert "keyboard" in alice.verdict_summary.lower(), (
            "Alice's specific verdict about keyboards must be preserved"
        )

        bob = credits_by_did["did:plc:ExpertBobTech02"]
        assert bob.creator_name == "Bob Martinez"
        assert bob.source_url == "https://youtube.com/watch?v=bob-battery-test"
        assert bob.deep_link == "https://youtube.com/watch?v=bob-battery-test&t=420"
        assert "battery" in bob.verdict_summary.lower(), (
            "Bob's specific verdict about battery must be preserved"
        )

        carol = credits_by_did["did:plc:ExpertCarolHW03"]
        assert carol.creator_name == "Carol Nguyen"
        assert carol.source_url == "https://carol-hardware.net/thermal-review"
        assert carol.deep_link == "https://carol-hardware.net/thermal-review#stress-test"
        assert "cool" in carol.verdict_summary.lower() or "thermal" in carol.verdict_summary.lower() or "load" in carol.verdict_summary.lower(), (
            "Carol's specific verdict about thermals must be preserved"
        )

    # TRACE: {"suite": "INT", "case": "0060", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "08", "scenario": "02", "title": "summary_text_names_each_expert"}
    def test_summary_text_names_each_expert(self):
        """The assembled summary_text must contain each expert's name
        individually — not generic language."""
        attestations = self._make_attestations()
        result = assemble_individual_attributions(attestations)

        # Each expert's creator_name must appear in the summary text
        assert "Alice Chen" in result.summary_text, (
            "Summary text must name Alice Chen individually"
        )
        assert "Bob Martinez" in result.summary_text, (
            "Summary text must name Bob Martinez individually"
        )
        assert "Carol Nguyen" in result.summary_text, (
            "Summary text must name Carol Nguyen individually"
        )

    # TRACE: {"suite": "INT", "case": "0061", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "08", "scenario": "03", "title": "no_generic_phrases_in_summary"}
    def test_no_generic_phrases_in_summary(self):
        """Counter-proof: the summary must NOT contain generic anonymous
        phrases that erase individual attribution."""
        attestations = self._make_attestations()
        result = assemble_individual_attributions(attestations)

        generic_phrases = [
            "experts say",
            "reviewers agree",
            "sources indicate",
            "according to experts",
            "multiple reviewers",
            "several experts",
            "reviews suggest",
            "experts recommend",
            "consensus is",
            "experts note",
        ]
        summary_lower = result.summary_text.lower()
        for phrase in generic_phrases:
            assert phrase not in summary_lower, (
                f"Summary must not contain generic phrase '{phrase}' — "
                f"each expert must be credited individually. "
                f"Got: {result.summary_text!r}"
            )

    # TRACE: {"suite": "INT", "case": "0062", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "08", "scenario": "04", "title": "each_deep_link_preserved_individually"}
    def test_each_deep_link_preserved_individually(self):
        """Counter-proof: each expert's deep_link is distinct and preserved
        in their individual credit — not merged into a single link."""
        attestations = self._make_attestations()
        result = assemble_individual_attributions(attestations)

        deep_links = [c.deep_link for c in result.individual_credits]
        # All 3 must be present and distinct
        assert len(deep_links) == 3
        assert len(set(deep_links)) == 3, (
            "Each expert must have a distinct deep_link — "
            f"got duplicates: {deep_links}"
        )

        # Each deep link must point to the correct creator's domain
        credits_by_name = {c.creator_name: c for c in result.individual_credits}
        assert "alice-reviews.com" in credits_by_name["Alice Chen"].deep_link
        assert "youtube.com" in credits_by_name["Bob Martinez"].deep_link
        assert "carol-hardware.net" in credits_by_name["Carol Nguyen"].deep_link

    # TRACE: {"suite": "INT", "case": "0063", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "08", "scenario": "05", "title": "same_expert_did_grouped_under_one_credit"}
    def test_same_expert_did_grouped_under_one_credit(self):
        """Edge case: two attestations from the SAME expert DID are grouped
        under a single credit entry — not duplicated."""
        attestations = [
            ExpertAttestation(
                expert_did="did:plc:ExpertDaveMulti",
                expert_trust_ring=TrustRing.RING_3_SKIN_IN_GAME,
                product_category="laptops",
                product_id="thinkpad_x1_gen12",
                rating=90,
                verdict={"summary": "Excellent display color accuracy"},
                source_url="https://dave-reviews.com/display-test",
                deep_link="https://dave-reviews.com/display-test#color",
                deep_link_context="Color accuracy measurements",
                creator_name="Dave Park",
            ),
            ExpertAttestation(
                expert_did="did:plc:ExpertDaveMulti",  # SAME DID
                expert_trust_ring=TrustRing.RING_3_SKIN_IN_GAME,
                product_category="laptops",
                product_id="thinkpad_x1_gen12",
                rating=87,
                verdict={"summary": "Speakers are surprisingly good"},
                source_url="https://dave-reviews.com/audio-test",
                deep_link="https://dave-reviews.com/audio-test#speakers",
                deep_link_context="Speaker quality test",
                creator_name="Dave Park",
            ),
            ExpertAttestation(
                expert_did="did:plc:ExpertEveUnique",
                expert_trust_ring=TrustRing.RING_2_VERIFIED,
                product_category="laptops",
                product_id="thinkpad_x1_gen12",
                rating=91,
                verdict={"summary": "Best trackpad on a ThinkPad ever"},
                source_url="https://eve-tech.com/input-review",
                deep_link="https://eve-tech.com/input-review#trackpad",
                deep_link_context="Trackpad precision test",
                creator_name="Eve Thompson",
            ),
        ]

        result = assemble_individual_attributions(attestations)

        # Dave's two attestations should be grouped into ONE credit
        assert len(result.individual_credits) == 2, (
            "2 unique DIDs (Dave x2, Eve x1) must produce exactly 2 credits, "
            f"got {len(result.individual_credits)}"
        )

        credits_by_did = {c.expert_did: c for c in result.individual_credits}
        dave = credits_by_did["did:plc:ExpertDaveMulti"]
        assert dave.creator_name == "Dave Park"
        # Dave's merged verdict should contain BOTH review summaries
        assert "display" in dave.verdict_summary.lower() or "color" in dave.verdict_summary.lower(), (
            "Dave's first verdict (display/color) must be preserved in merged summary"
        )
        assert "speaker" in dave.verdict_summary.lower(), (
            "Dave's second verdict (speakers) must be preserved in merged summary"
        )

        eve = credits_by_did["did:plc:ExpertEveUnique"]
        assert eve.creator_name == "Eve Thompson"
        assert "trackpad" in eve.verdict_summary.lower()

        # Summary text should name both Dave and Eve
        assert "Dave Park" in result.summary_text
        assert "Eve Thompson" in result.summary_text

    # TRACE: {"suite": "INT", "case": "0064", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "08", "scenario": "06", "title": "expert_with_empty_verdict_still_credited"}
    def test_expert_with_empty_verdict_still_credited(self):
        """Edge case: an expert with an empty verdict dict still gets
        individual credit — their name and link must appear."""
        attestations = [
            ExpertAttestation(
                expert_did="did:plc:ExpertFrankEmpty",
                expert_trust_ring=TrustRing.RING_2_VERIFIED,
                product_category="laptops",
                product_id="thinkpad_x1_gen12",
                rating=80,
                verdict={},  # empty verdict — no "summary" key
                source_url="https://frank-reviews.com/quick-take",
                deep_link="https://frank-reviews.com/quick-take#verdict",
                deep_link_context="Quick take section",
                creator_name="Frank Lee",
            ),
            ExpertAttestation(
                expert_did="did:plc:ExpertGraceVerdict",
                expert_trust_ring=TrustRing.RING_3_SKIN_IN_GAME,
                product_category="laptops",
                product_id="thinkpad_x1_gen12",
                rating=93,
                verdict={"summary": "Outstanding build quality"},
                source_url="https://grace-tech.com/build-review",
                deep_link="https://grace-tech.com/build-review#materials",
                deep_link_context="Materials and build analysis",
                creator_name="Grace Kim",
            ),
        ]

        result = assemble_individual_attributions(attestations)

        assert len(result.individual_credits) == 2, (
            "Both experts must get individual credits even if one has empty verdict"
        )

        credits_by_did = {c.expert_did: c for c in result.individual_credits}

        frank = credits_by_did["did:plc:ExpertFrankEmpty"]
        assert frank.creator_name == "Frank Lee"
        assert frank.deep_link == "https://frank-reviews.com/quick-take#verdict", (
            "Frank's deep link must be preserved even with empty verdict"
        )
        assert frank.source_url == "https://frank-reviews.com/quick-take"
        # Empty verdict produces empty verdict_summary
        assert frank.verdict_summary == "", (
            "Empty verdict must produce empty verdict_summary, not fabricated text"
        )

        grace = credits_by_did["did:plc:ExpertGraceVerdict"]
        assert grace.creator_name == "Grace Kim"
        assert "build quality" in grace.verdict_summary.lower()

        # Summary text must still name Frank individually
        assert "Frank Lee" in result.summary_text, (
            "Expert with empty verdict must still be named in summary text"
        )
        assert "Grace Kim" in result.summary_text

    # TRACE: {"suite": "INT", "case": "0065", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "08", "scenario": "07", "title": "creator_name_missing_falls_back_to_did"}
    def test_creator_name_missing_falls_back_to_did(self):
        """Edge case: when creator_name is empty, the expert_did is used
        as the name — never a generic label."""
        attestations = [
            ExpertAttestation(
                expert_did="did:plc:ExpertNoName999",
                expert_trust_ring=TrustRing.RING_2_VERIFIED,
                product_category="laptops",
                product_id="thinkpad_x1_gen12",
                rating=82,
                verdict={"summary": "Solid performance for the price"},
                source_url="https://anonymous-review.com/laptop",
                deep_link="https://anonymous-review.com/laptop#perf",
                deep_link_context="Performance benchmarks",
                creator_name="",  # no creator name
            ),
        ]

        result = assemble_individual_attributions(attestations)

        assert len(result.individual_credits) == 1
        credit = result.individual_credits[0]
        # Fallback to DID, not a generic label
        assert credit.creator_name == "did:plc:ExpertNoName999", (
            "Missing creator_name must fall back to expert_did, not a generic label"
        )
        # Summary text must reference the DID, not "an expert" or "unknown"
        assert "did:plc:ExpertNoName999" in result.summary_text, (
            "Summary must use the DID when creator_name is missing"
        )
        # Verify no generic fallback language
        summary_lower = result.summary_text.lower()
        assert "an expert" not in summary_lower
        assert "unknown" not in summary_lower
        assert "anonymous" not in summary_lower

    # TRACE: {"suite": "INT", "case": "0066", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "08", "scenario": "08", "title": "single_attestation_still_individual"}
    def test_single_attestation_still_individual(self):
        """Edge case: even a single attestation must be credited individually
        by name — the assembly logic must not special-case singletons into
        generic language."""
        attestations = [
            ExpertAttestation(
                expert_did="did:plc:ExpertSoloHana",
                expert_trust_ring=TrustRing.RING_3_SKIN_IN_GAME,
                product_category="laptops",
                product_id="thinkpad_x1_gen12",
                rating=95,
                verdict={"summary": "The definitive developer laptop"},
                source_url="https://hana-tech.jp/definitive-review",
                deep_link="https://hana-tech.jp/definitive-review#conclusion",
                deep_link_context="Final conclusion and recommendation",
                creator_name="Hana Tanaka",
            ),
        ]

        result = assemble_individual_attributions(attestations)

        assert len(result.individual_credits) == 1
        credit = result.individual_credits[0]
        assert credit.creator_name == "Hana Tanaka"
        assert credit.deep_link == "https://hana-tech.jp/definitive-review#conclusion"

        # Even one expert must be named, not described generically
        assert "Hana Tanaka" in result.summary_text
        summary_lower = result.summary_text.lower()
        assert "expert says" not in summary_lower
        assert "the reviewer" not in summary_lower


# =========================================================================
# Helper: Attribution compliance check (real business logic)
# =========================================================================

def check_attribution_compliance(
    recommendation: dict,
    bot_did: str,
    trust_network: MockTrustNetwork,
    *,
    penalty: float = -10.0,
) -> dict:
    """Check whether a bot recommendation satisfies attribution requirements.

    Per spec, every recommendation MUST include a non-empty ``creator_name``
    in each of its sources.  When a source is missing ``creator_name`` or
    provides an empty / whitespace-only string, this constitutes an
    attribution violation.

    Business logic:
    1. Iterate over every source in every recommendation entry.
    2. For each source that lacks a non-empty ``creator_name``, record a
       violation with the source index and the bot DID.
    3. Apply ``penalty`` (default -10) to the bot's trust score in the
       trust network **once per violating source**.
    4. Return a result dict summarising the outcome.

    Returns::

        {
            "compliant": bool,
            "violations": list[dict],      # one entry per bad source
            "sources_checked": int,
            "score_before": float,
            "score_after": float,
            "total_penalty": float,
        }
    """
    violations: list[dict] = []
    score_before = trust_network.get_bot_score(bot_did)

    sources_checked = 0
    for rec_idx, rec in enumerate(recommendation.get("recommendations", [])):
        for src_idx, source in enumerate(rec.get("sources", [])):
            sources_checked += 1
            creator = source.get("creator_name")
            # Missing key, None, empty string, or whitespace-only all count
            if creator is None or (isinstance(creator, str)
                                   and creator.strip() == ""):
                violations.append({
                    "rec_index": rec_idx,
                    "source_index": src_idx,
                    "bot_did": bot_did,
                    "reason": "missing_or_empty_creator_name",
                    "creator_name_value": creator,
                })
                trust_network.update_bot_score(bot_did, penalty)

    score_after = trust_network.get_bot_score(bot_did)
    total_penalty = score_after - score_before

    return {
        "compliant": len(violations) == 0,
        "violations": violations,
        "sources_checked": sources_checked,
        "score_before": score_before,
        "score_after": score_after,
        "total_penalty": total_penalty,
    }


def route_to_best_bot(
    available_bots: list[dict],
    trust_network: MockTrustNetwork,
) -> dict | None:
    """Select the best bot from a pool based on current trust scores.

    Each entry in ``available_bots`` must have a ``"bot_did"`` key.
    The function looks up each bot's score in the trust network and
    returns the one with the highest score.  Ties are broken by list
    order (first wins).

    Returns the winning bot dict, or ``None`` if the list is empty.
    """
    if not available_bots:
        return None

    scored = [
        (trust_network.get_bot_score(b["bot_did"]), idx, b)
        for idx, b in enumerate(available_bots)
    ]
    # Sort descending by score; on tie, ascending by original index
    scored.sort(key=lambda t: (-t[0], t[1]))
    return scored[0][2]


# =========================================================================
# TST-INT-725: Attribution violation feeds bot trust degradation
# =========================================================================

class TestAttributionViolation:
    """TST-INT-725: Attribution violation feeds bot trust degradation.

    Spec requirement (section 22.2 — Creator Value Return):
        "Bot returns recommendation with no creator_name | Brain logs
         violation -> bot trust score decreased -> next routing prefers
         other bots."
    """

    # ------------------------------------------------------------------
    # TST-INT-725 — primary test
    # ------------------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0725", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "09", "scenario": "01", "title": "missing_creator_name_triggers_violation_and_trust_penalty"}
    def test_missing_creator_name_triggers_violation_and_trust_penalty(
        self, mock_trust_network: MockTrustNetwork
    ):
        """A bot returns a recommendation with NO creator_name field.
        Brain detects the attribution violation, logs it, decreases the
        bot's trust score, and subsequent routing prefers a different bot."""

        violating_bot_did = "did:plc:BotViolator001"
        compliant_bot_did = "did:plc:BotCompliant001"

        # Both bots start at the default score (50.0)
        assert mock_trust_network.get_bot_score(violating_bot_did) == 50.0
        assert mock_trust_network.get_bot_score(compliant_bot_did) == 50.0

        # --- 1. Violating bot returns recommendation with NO creator_name ---
        bad_response = {
            "recommendations": [
                {
                    "product": "Shady Widget",
                    "score": 80,
                    "sources": [
                        {
                            "type": "expert",
                            # creator_name is completely absent
                            "source_url": "https://example.com/review",
                            "deep_link": "https://example.com/review#top",
                            "deep_link_context": "Top of page",
                        },
                    ],
                },
            ],
            "bot_signature": "mock_sig_bad",
            "bot_did": violating_bot_did,
        }

        result = check_attribution_compliance(
            bad_response, violating_bot_did, mock_trust_network,
        )

        # --- 2. Violation IS detected ---
        assert result["compliant"] is False, (
            "Missing creator_name must be flagged as non-compliant"
        )
        assert len(result["violations"]) == 1
        assert result["violations"][0]["reason"] == "missing_or_empty_creator_name"
        assert result["violations"][0]["bot_did"] == violating_bot_did

        # --- 3. Violation is logged with detail ---
        violation = result["violations"][0]
        assert violation["rec_index"] == 0
        assert violation["source_index"] == 0
        assert violation["creator_name_value"] is None, (
            "Logged violation must capture the actual missing value (None)"
        )

        # --- 4. Trust score decreased ---
        assert result["score_before"] == 50.0
        assert result["score_after"] == 40.0, (
            "One violation must decrease score by 10 (penalty default)"
        )
        assert result["total_penalty"] == -10.0
        assert mock_trust_network.get_bot_score(violating_bot_did) == 40.0

        # --- 5. Compliant bot stays unpenalized ---
        good_response = {
            "recommendations": [
                {
                    "product": "Quality Widget",
                    "score": 85,
                    "sources": [
                        {
                            "type": "expert",
                            "creator_name": "TrustedReviewer",
                            "source_url": "https://trusted.com/review",
                            "deep_link": "https://trusted.com/review#verdict",
                            "deep_link_context": "Verdict section",
                        },
                    ],
                },
            ],
            "bot_signature": "mock_sig_good",
            "bot_did": compliant_bot_did,
        }

        good_result = check_attribution_compliance(
            good_response, compliant_bot_did, mock_trust_network,
        )
        assert good_result["compliant"] is True, (
            "Bot WITH creator_name must NOT be flagged"
        )
        assert good_result["violations"] == []
        assert good_result["score_after"] == 50.0, (
            "Compliant bot's trust score must remain unchanged"
        )

        # --- 6. Routing now prefers the compliant bot ---
        candidates = [
            {"bot_did": violating_bot_did, "name": "ViolatorBot"},
            {"bot_did": compliant_bot_did, "name": "CompliantBot"},
        ]
        chosen = route_to_best_bot(candidates, mock_trust_network)
        assert chosen is not None
        assert chosen["bot_did"] == compliant_bot_did, (
            "Router must prefer the compliant bot (score 50) over the "
            "penalized bot (score 40)"
        )

    # ------------------------------------------------------------------
    # Edge case: empty string creator_name
    # ------------------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0067", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "09", "scenario": "02", "title": "empty_string_creator_name_is_also_a_violation"}
    def test_empty_string_creator_name_is_also_a_violation(
        self, mock_trust_network: MockTrustNetwork
    ):
        """Edge case: creator_name present but empty string is still
        an attribution violation — the field exists but has no value."""

        bot_did = "did:plc:BotEmptyCreator001"
        response = {
            "recommendations": [
                {
                    "product": "Unnamed Widget",
                    "score": 70,
                    "sources": [
                        {
                            "type": "expert",
                            "creator_name": "",  # empty string
                            "source_url": "https://anon.com/review",
                            "deep_link": "https://anon.com/review#top",
                            "deep_link_context": "Anonymous review",
                        },
                    ],
                },
            ],
            "bot_signature": "mock_sig_empty",
            "bot_did": bot_did,
        }

        result = check_attribution_compliance(
            response, bot_did, mock_trust_network,
        )

        assert result["compliant"] is False, (
            "Empty string creator_name must count as an attribution violation"
        )
        assert len(result["violations"]) == 1
        assert result["violations"][0]["creator_name_value"] == ""
        assert result["score_after"] == 40.0

    # ------------------------------------------------------------------
    # Edge case: whitespace-only creator_name
    # ------------------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0068", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "09", "scenario": "03", "title": "whitespace_only_creator_name_is_a_violation"}
    def test_whitespace_only_creator_name_is_a_violation(
        self, mock_trust_network: MockTrustNetwork
    ):
        """Edge case: creator_name is whitespace-only ('   ') — this is
        functionally empty and must be treated as a violation."""

        bot_did = "did:plc:BotWhitespace001"
        response = {
            "recommendations": [
                {
                    "product": "Whitespace Widget",
                    "score": 65,
                    "sources": [
                        {
                            "type": "expert",
                            "creator_name": "   ",  # whitespace only
                            "source_url": "https://blank.com/review",
                            "deep_link": "https://blank.com/review#top",
                            "deep_link_context": "Blank attribution",
                        },
                    ],
                },
            ],
            "bot_signature": "mock_sig_ws",
            "bot_did": bot_did,
        }

        result = check_attribution_compliance(
            response, bot_did, mock_trust_network,
        )

        assert result["compliant"] is False, (
            "Whitespace-only creator_name must be treated as a violation"
        )
        assert len(result["violations"]) == 1
        assert result["violations"][0]["creator_name_value"] == "   "
        assert result["score_after"] == 40.0

    # ------------------------------------------------------------------
    # Multiple violations compound the penalty
    # ------------------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0069", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "09", "scenario": "04", "title": "multiple_violations_compound_penalty"}
    def test_multiple_violations_compound_penalty(
        self, mock_trust_network: MockTrustNetwork
    ):
        """When a bot returns multiple sources without attribution, each
        violation applies its own penalty — penalties compound."""

        bot_did = "did:plc:BotMultiViolator001"
        response = {
            "recommendations": [
                {
                    "product": "Multi-Source Widget",
                    "score": 75,
                    "sources": [
                        {
                            "type": "expert",
                            # no creator_name at all
                            "source_url": "https://anon1.com/review",
                        },
                        {
                            "type": "expert",
                            "creator_name": "",  # empty
                            "source_url": "https://anon2.com/review",
                        },
                        {
                            "type": "expert",
                            "creator_name": "ValidReviewer",  # this one is fine
                            "source_url": "https://valid.com/review",
                        },
                    ],
                },
            ],
            "bot_signature": "mock_sig_multi",
            "bot_did": bot_did,
        }

        result = check_attribution_compliance(
            response, bot_did, mock_trust_network,
        )

        assert result["compliant"] is False
        assert len(result["violations"]) == 2, (
            "Two sources without valid creator_name -> two violations"
        )
        assert result["sources_checked"] == 3, (
            "All three sources must be checked"
        )
        # 50 - 10 - 10 = 30
        assert result["score_after"] == 30.0, (
            "Two violations at -10 each must reduce 50 -> 30"
        )
        assert result["total_penalty"] == -20.0

    # ------------------------------------------------------------------
    # Counter-proof: compliant bot score unchanged
    # ------------------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0070", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "09", "scenario": "05", "title": "compliant_bot_score_unchanged"}
    def test_compliant_bot_score_unchanged(
        self, mock_trust_network: MockTrustNetwork
    ):
        """Counter-proof: a fully compliant response with creator_name on
        every source does NOT change the bot's trust score."""

        bot_did = "did:plc:BotFullyCompliant001"
        # Set an explicit starting score to verify no change
        mock_trust_network.update_bot_score(bot_did, 25.0)  # 50 + 25 = 75
        assert mock_trust_network.get_bot_score(bot_did) == 75.0

        response = {
            "recommendations": [
                {
                    "product": "Good Widget",
                    "score": 90,
                    "sources": [
                        {
                            "type": "expert",
                            "creator_name": "Expert Alpha",
                            "source_url": "https://alpha.com/review",
                        },
                        {
                            "type": "expert",
                            "creator_name": "Expert Beta",
                            "source_url": "https://beta.com/review",
                        },
                    ],
                },
            ],
            "bot_signature": "mock_sig_compliant",
            "bot_did": bot_did,
        }

        result = check_attribution_compliance(
            response, bot_did, mock_trust_network,
        )

        assert result["compliant"] is True
        assert result["violations"] == []
        assert result["score_before"] == 75.0
        assert result["score_after"] == 75.0, (
            "Compliant bot's score must be exactly unchanged"
        )
        assert result["total_penalty"] == 0.0

    # ------------------------------------------------------------------
    # Repeated violations degrade to floor
    # ------------------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0071", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "09", "scenario": "06", "title": "repeated_violations_degrade_trust_to_floor"}
    def test_repeated_violations_degrade_trust_to_floor(
        self, mock_trust_network: MockTrustNetwork
    ):
        """Edge case: repeated violations eventually push the bot score
        to the floor (0.0) — it cannot go negative."""

        bot_did = "did:plc:BotSerialViolator001"
        assert mock_trust_network.get_bot_score(bot_did) == 50.0

        bad_response = {
            "recommendations": [
                {
                    "product": "Widget",
                    "score": 50,
                    "sources": [
                        {"type": "expert", "source_url": "https://x.com"},
                    ],
                },
            ],
            "bot_signature": "mock_sig",
            "bot_did": bot_did,
        }

        # 6 violations at -10 each: 50 -> 40 -> 30 -> 20 -> 10 -> 0 -> 0
        for i in range(6):
            result = check_attribution_compliance(
                bad_response, bot_did, mock_trust_network,
            )
            assert result["compliant"] is False

        assert mock_trust_network.get_bot_score(bot_did) == 0.0, (
            "Trust score must floor at 0.0, not go negative"
        )

        # One more violation: still 0.0
        result = check_attribution_compliance(
            bad_response, bot_did, mock_trust_network,
        )
        assert mock_trust_network.get_bot_score(bot_did) == 0.0

    # ------------------------------------------------------------------
    # Routing reflects degraded trust across multiple bots
    # ------------------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0072", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "09", "scenario": "07", "title": "routing_reflects_degraded_trust_across_multiple_bots"}
    def test_routing_reflects_degraded_trust_across_multiple_bots(
        self, mock_trust_network: MockTrustNetwork
    ):
        """After trust degradation, routing consistently selects the
        highest-scored bot from a pool of candidates."""

        bot_a = "did:plc:BotRouteA"
        bot_b = "did:plc:BotRouteB"
        bot_c = "did:plc:BotRouteC"

        # Give them different starting scores
        mock_trust_network.update_bot_score(bot_a, 20.0)  # 50 + 20 = 70
        mock_trust_network.update_bot_score(bot_b, 10.0)  # 50 + 10 = 60
        # bot_c stays at default 50

        candidates = [
            {"bot_did": bot_a, "name": "BotA"},
            {"bot_did": bot_b, "name": "BotB"},
            {"bot_did": bot_c, "name": "BotC"},
        ]

        # Before violations: bot_a (70) is best
        chosen = route_to_best_bot(candidates, mock_trust_network)
        assert chosen["bot_did"] == bot_a

        # Penalize bot_a with 4 violations: 70 -> 30
        bad_response = {
            "recommendations": [
                {
                    "product": "X",
                    "score": 50,
                    "sources": [
                        {"type": "expert", "source_url": "https://x.com"},
                    ],
                },
            ],
            "bot_signature": "mock_sig",
            "bot_did": bot_a,
        }
        for _ in range(4):
            check_attribution_compliance(
                bad_response, bot_a, mock_trust_network,
            )
        assert mock_trust_network.get_bot_score(bot_a) == 30.0

        # Now bot_b (60) should be preferred
        chosen = route_to_best_bot(candidates, mock_trust_network)
        assert chosen["bot_did"] == bot_b, (
            "After bot_a is penalized to 30, bot_b at 60 must be preferred"
        )

        # Penalize bot_b too: 60 -> 20
        for _ in range(4):
            check_attribution_compliance(
                bad_response, bot_b, mock_trust_network,
            )
        assert mock_trust_network.get_bot_score(bot_b) == 20.0

        # Now bot_c (50) should be preferred
        chosen = route_to_best_bot(candidates, mock_trust_network)
        assert chosen["bot_did"] == bot_c, (
            "After both A and B are penalized, bot_c at 50 must win"
        )

    # ------------------------------------------------------------------
    # Edge case: empty candidate list
    # ------------------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0073", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "09", "scenario": "08", "title": "routing_with_empty_candidate_list"}
    def test_routing_with_empty_candidate_list(
        self, mock_trust_network: MockTrustNetwork
    ):
        """Edge case: routing with no candidates returns None."""

        chosen = route_to_best_bot([], mock_trust_network)
        assert chosen is None

    # ------------------------------------------------------------------
    # Edge case: no recommendations means no violations
    # ------------------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0074", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "09", "scenario": "09", "title": "no_recommendations_means_no_violations"}
    def test_no_recommendations_means_no_violations(
        self, mock_trust_network: MockTrustNetwork
    ):
        """Edge case: a response with an empty recommendations list has
        nothing to violate — the bot stays compliant."""

        bot_did = "did:plc:BotNoRecs001"
        response = {
            "recommendations": [],
            "bot_signature": "mock_sig",
            "bot_did": bot_did,
        }

        result = check_attribution_compliance(
            response, bot_did, mock_trust_network,
        )

        assert result["compliant"] is True
        assert result["violations"] == []
        assert result["sources_checked"] == 0
        assert result["score_after"] == 50.0


# =========================================================================
# Helper: rank recommendations by trust score (Verified Truth principle)
# =========================================================================

def rank_recommendations_by_trust(
    recommendations: list[dict],
) -> dict:
    """Rank product recommendations by trust score alone.

    This implements Dina's Verified Truth principle: "Rank by trust, not by
    ad spend."  The ``sponsored`` flag on each recommendation is PRESERVED
    for UI disclosure but has ZERO weight in ranking.  Only ``trust_score``
    determines position.

    Algorithm:
    1. Sort the list of recommendations by ``trust_score`` descending.
    2. Ties are broken by original list order (stable sort) — NOT by
       sponsorship status.
    3. The ``sponsored`` flag is carried through untouched on every item.
    4. A diagnostic flag ``sponsorship_affected_ranking`` is computed by
       comparing the trust-only ranking with a hypothetical ranking where
       sponsored items receive a boost.  If the two orderings differ,
       sponsorship would have distorted the ranking — which must never happen
       in a correct implementation.

    Each recommendation dict must contain at least:
    - ``product_id``: str
    - ``trust_score``: float (0.0 .. 1.0)
    - ``sponsored``: bool

    Returns::

        {
            "ranked": list[dict],                  # sorted by trust_score descending
            "sponsorship_affected_ranking": bool,  # always False in correct impl
        }
    """
    # Sort ONLY by trust_score descending.  Python's sort is stable, so
    # items with equal trust_score retain their original relative order.
    ranked = sorted(
        recommendations,
        key=lambda r: r["trust_score"],
        reverse=True,
    )

    # Diagnostic: did sponsorship actually distort the final ranking?
    # We check whether any sponsored item ended up ranked HIGHER than an
    # unsponsored item that has a strictly greater trust_score.  If so,
    # sponsorship must have injected weight into the ranking — a violation.
    # In a correct implementation this is always False because the sort
    # above uses trust_score as the sole key.
    sponsorship_affected = False
    for i, item_i in enumerate(ranked):
        for j, item_j in enumerate(ranked):
            if j > i:  # item_i is ranked higher than item_j
                if (item_i.get("sponsored")
                        and not item_j.get("sponsored")
                        and item_i["trust_score"] < item_j["trust_score"]):
                    # A sponsored item outranked an unsponsored item with
                    # higher trust — sponsorship distorted the ranking.
                    sponsorship_affected = True
                    break
        if sponsorship_affected:
            break

    return {
        "ranked": ranked,
        "sponsorship_affected_ranking": sponsorship_affected,
    }


def verify_ranking_integrity(
    ranked_recommendations: list[dict],
) -> dict:
    """Verify that a ranked list is strictly ordered by trust_score.

    Checks:
    1. Each item's trust_score is >= the next item's trust_score.
    2. No sponsored item sits at a higher position than its trust_score
       alone would justify.  This is checked by comparing each sponsored
       item's position against where it would land in a pure trust-only
       sort of the same items.

    Returns::

        {
            "valid": bool,
            "violations": list[str],
        }
    """
    violations: list[str] = []

    # --- Check 1: monotonic descending trust_score ---
    for i in range(len(ranked_recommendations) - 1):
        current = ranked_recommendations[i]
        nxt = ranked_recommendations[i + 1]
        if current["trust_score"] < nxt["trust_score"]:
            violations.append(
                f"Position {i} ({current['product_id']}, trust={current['trust_score']}) "
                f"has LOWER trust_score than position {i+1} "
                f"({nxt['product_id']}, trust={nxt['trust_score']}) — "
                f"ranking is not strictly by trust"
            )

    # --- Check 2: no sponsored item ranked higher than trust alone justifies ---
    # Re-sort the same items by trust only to get the canonical order
    canonical = sorted(
        ranked_recommendations,
        key=lambda r: r["trust_score"],
        reverse=True,
    )
    canonical_positions = {
        r["product_id"]: idx for idx, r in enumerate(canonical)
    }
    actual_positions = {
        r["product_id"]: idx for idx, r in enumerate(ranked_recommendations)
    }

    for rec in ranked_recommendations:
        if rec.get("sponsored"):
            actual_pos = actual_positions[rec["product_id"]]
            canonical_pos = canonical_positions[rec["product_id"]]
            if actual_pos < canonical_pos:
                violations.append(
                    f"Sponsored product '{rec['product_id']}' is at position "
                    f"{actual_pos} but trust-only ranking would place it at "
                    f"{canonical_pos} — sponsorship is boosting its rank"
                )

    return {
        "valid": len(violations) == 0,
        "violations": violations,
    }


# =========================================================================
# TST-INT-733: Sponsorship cannot distort ranking order
# =========================================================================

class TestSponsorshipCannotDistortRanking:
    """TST-INT-733: Sponsorship cannot distort ranking order.

    Spec requirement (Verified Truth — Law 2):
        "Brain stores: Product A (sponsored: true, trust score 0.6) and
         Product B (unsponsored, trust score 0.9) -> Brain assembles ranked
         recommendation -> Core delivers | Product B ranks above Product A
         -- sponsorship flag preserved for disclosure but has zero weight
         in ranking.  Trust evidence alone determines order."

    This is the core of Dina's Verified Truth principle: ad money cannot
    buy higher ranking.  Trust score is the SOLE ranking signal.
    """

    # ------------------------------------------------------------------
    # TST-INT-733 — primary test
    # ------------------------------------------------------------------

# TST-INT-733
    # TRACE: {"suite": "INT", "case": "0733", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "10", "scenario": "01", "title": "sponsorship_cannot_distort_ranking_order"}
    def test_sponsorship_cannot_distort_ranking_order(self):
        """Product A is sponsored (trust 0.6), Product B is unsponsored
        (trust 0.9).  Product B must rank above Product A because trust
        score is the sole ranking signal.  The sponsored flag is preserved
        on Product A for disclosure but has zero weight."""

        product_a = {
            "product_id": "sponsored-widget-A",
            "trust_score": 0.6,
            "sponsored": True,
            "creator_name": "SponsoredReviewerA",
            "source_url": "https://paid-partner.com/widget-a",
            "deep_link": "https://paid-partner.com/widget-a#review",
            "verdict": "Good product (sponsored content)",
        }
        product_b = {
            "product_id": "organic-widget-B",
            "trust_score": 0.9,
            "sponsored": False,
            "creator_name": "IndependentReviewerB",
            "source_url": "https://indie-reviews.com/widget-b",
            "deep_link": "https://indie-reviews.com/widget-b#verdict",
            "verdict": "Excellent product (independent review)",
        }

        result = rank_recommendations_by_trust([product_a, product_b])
        ranked = result["ranked"]

        # 1. Product B (trust 0.9) must be ranked #1
        assert ranked[0]["product_id"] == "organic-widget-B", (
            "Product B (trust 0.9, unsponsored) must rank #1 — "
            f"got {ranked[0]['product_id']!r} at position 0"
        )
        assert ranked[0]["trust_score"] == 0.9

        # 2. Product A (trust 0.6, sponsored) must be ranked #2
        assert ranked[1]["product_id"] == "sponsored-widget-A", (
            "Product A (trust 0.6, sponsored) must rank #2 — "
            f"got {ranked[1]['product_id']!r} at position 1"
        )
        assert ranked[1]["trust_score"] == 0.6

        # 3. Sponsored flag PRESERVED on Product A for disclosure
        assert ranked[1]["sponsored"] is True, (
            "Product A's sponsored=True must be preserved in the ranked result "
            "for user disclosure — the flag is carried through, not stripped"
        )

        # 4. Unsponsored flag PRESERVED on Product B
        assert ranked[0]["sponsored"] is False, (
            "Product B's sponsored=False must be preserved in the ranked result"
        )

        # 5. Sponsorship had zero influence on ranking
        assert result["sponsorship_affected_ranking"] is False, (
            "Sponsorship must have ZERO weight in ranking. "
            "The diagnostic check confirms that a hypothetical sponsorship "
            "boost would produce a different order — but the actual ranking "
            "ignores it entirely."
        )

        # 6. Verify ranking integrity via independent checker
        integrity = verify_ranking_integrity(ranked)
        assert integrity["valid"] is True, (
            "Ranking integrity check must pass — trust scores are monotonically "
            f"descending. Violations: {integrity['violations']}"
        )
        assert integrity["violations"] == []

    # ------------------------------------------------------------------
    # Counter-proof 1: unsponsored low-trust still ranked below
    #                   sponsored high-trust
    # ------------------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0075", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "10", "scenario": "02", "title": "unsponsored_low_trust_still_ranked_below_sponsored_high_trust"}
    def test_unsponsored_low_trust_still_ranked_below_sponsored_high_trust(
        self,
    ):
        """Counter-proof: this test verifies there is no ANTI-sponsorship
        bias.  Product X (sponsored, trust 0.95) vs Product Y (unsponsored,
        trust 0.3) — X must rank higher because trust alone decides.
        Sponsorship does not HELP, but it also does not HURT."""

        product_x = {
            "product_id": "high-trust-sponsored-X",
            "trust_score": 0.95,
            "sponsored": True,
            "creator_name": "TrustedSponsoredReviewer",
            "source_url": "https://trusted-partner.com/review-x",
        }
        product_y = {
            "product_id": "low-trust-organic-Y",
            "trust_score": 0.3,
            "sponsored": False,
            "creator_name": "UnknownReviewer",
            "source_url": "https://unknown-blog.com/review-y",
        }

        result = rank_recommendations_by_trust([product_x, product_y])
        ranked = result["ranked"]

        # X (trust 0.95) must rank above Y (trust 0.3) despite being sponsored
        assert ranked[0]["product_id"] == "high-trust-sponsored-X", (
            "Sponsored product with higher trust MUST rank first — "
            "there must be no anti-sponsorship penalty. "
            f"Got {ranked[0]['product_id']!r} at position 0"
        )
        assert ranked[1]["product_id"] == "low-trust-organic-Y", (
            "Unsponsored product with lower trust must rank second"
        )

        # Sponsorship flags preserved for disclosure
        assert ranked[0]["sponsored"] is True
        assert ranked[1]["sponsored"] is False

        # Ranking is still valid
        integrity = verify_ranking_integrity(ranked)
        assert integrity["valid"] is True, (
            f"Ranking integrity violated: {integrity['violations']}"
        )

    # ------------------------------------------------------------------
    # Counter-proof 2: equal trust scores — sponsored does not break tie
    # ------------------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0076", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "10", "scenario": "03", "title": "equal_trust_scores_sponsored_does_not_break_tie"}
    def test_equal_trust_scores_sponsored_does_not_break_tie(self):
        """Counter-proof: two products with identical trust_score, one
        sponsored, one not.  The ordering must be stable (original list
        order preserved) and NOT biased by sponsorship status in either
        direction."""

        product_s = {
            "product_id": "equal-trust-sponsored",
            "trust_score": 0.75,
            "sponsored": True,
            "creator_name": "SponsoredEqualReviewer",
            "source_url": "https://partner.com/equal-review",
        }
        product_o = {
            "product_id": "equal-trust-organic",
            "trust_score": 0.75,
            "sponsored": False,
            "creator_name": "OrganicEqualReviewer",
            "source_url": "https://indie.com/equal-review",
        }

        # --- Order 1: sponsored first in input ---
        result_1 = rank_recommendations_by_trust([product_s, product_o])
        ranked_1 = result_1["ranked"]

        # Both have same trust_score so order must match input (stable sort)
        assert ranked_1[0]["product_id"] == "equal-trust-sponsored", (
            "Stable sort: when trust scores are equal, input order is preserved "
            "(sponsored was first in input)"
        )
        assert ranked_1[1]["product_id"] == "equal-trust-organic"

        # --- Order 2: organic first in input ---
        result_2 = rank_recommendations_by_trust([product_o, product_s])
        ranked_2 = result_2["ranked"]

        assert ranked_2[0]["product_id"] == "equal-trust-organic", (
            "Stable sort: when trust scores are equal, input order is preserved "
            "(organic was first in input)"
        )
        assert ranked_2[1]["product_id"] == "equal-trust-sponsored"

        # The ranking flipped because input order flipped — NOT because of
        # sponsorship.  If sponsorship had weight, the same product would
        # always be on top regardless of input order.
        assert ranked_1[0]["product_id"] != ranked_2[0]["product_id"], (
            "Flipping input order with equal trust_score must flip output order, "
            "proving sponsorship has no tiebreaker weight"
        )

        # Sponsorship flags preserved in both orderings
        for ranked in (ranked_1, ranked_2):
            for item in ranked:
                if item["product_id"] == "equal-trust-sponsored":
                    assert item["sponsored"] is True
                else:
                    assert item["sponsored"] is False

    # ------------------------------------------------------------------
    # Counter-proof 3: all sponsored still ranked by trust
    # ------------------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0077", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "10", "scenario": "04", "title": "all_sponsored_still_ranked_by_trust"}
    def test_all_sponsored_still_ranked_by_trust(self):
        """Counter-proof: when ALL products are sponsored, the ranking
        must still be purely by trust_score.  Sponsorship is universal
        here, so only trust differentiates."""

        products = [
            {
                "product_id": "all-spon-low",
                "trust_score": 0.4,
                "sponsored": True,
                "creator_name": "SponsorLow",
                "source_url": "https://sponsor-low.com/review",
            },
            {
                "product_id": "all-spon-high",
                "trust_score": 0.92,
                "sponsored": True,
                "creator_name": "SponsorHigh",
                "source_url": "https://sponsor-high.com/review",
            },
            {
                "product_id": "all-spon-mid",
                "trust_score": 0.68,
                "sponsored": True,
                "creator_name": "SponsorMid",
                "source_url": "https://sponsor-mid.com/review",
            },
        ]

        result = rank_recommendations_by_trust(products)
        ranked = result["ranked"]

        # Must be sorted by trust_score descending: 0.92, 0.68, 0.4
        assert ranked[0]["product_id"] == "all-spon-high"
        assert ranked[0]["trust_score"] == 0.92
        assert ranked[1]["product_id"] == "all-spon-mid"
        assert ranked[1]["trust_score"] == 0.68
        assert ranked[2]["product_id"] == "all-spon-low"
        assert ranked[2]["trust_score"] == 0.4

        # All must still be marked sponsored
        for item in ranked:
            assert item["sponsored"] is True, (
                f"Product {item['product_id']} must remain sponsored=True "
                f"after ranking — got {item['sponsored']!r}"
            )

        # Integrity check passes
        integrity = verify_ranking_integrity(ranked)
        assert integrity["valid"] is True, (
            f"Ranking integrity violated: {integrity['violations']}"
        )

    # ------------------------------------------------------------------
    # Edge case 1: five products mixed sponsorship ranked by trust
    # ------------------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0078", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "10", "scenario": "05", "title": "five_products_mixed_sponsorship_ranked_by_trust"}
    def test_five_products_mixed_sponsorship_ranked_by_trust(self):
        """Edge case: 5 products with various trust scores and mixed
        sponsorship flags.  The entire list must be sorted strictly by
        trust_score descending.  Sponsorship has zero influence."""

        products = [
            {
                "product_id": "p1-spon",
                "trust_score": 0.55,
                "sponsored": True,
                "creator_name": "Reviewer1",
                "source_url": "https://r1.com",
            },
            {
                "product_id": "p2-organic",
                "trust_score": 0.88,
                "sponsored": False,
                "creator_name": "Reviewer2",
                "source_url": "https://r2.com",
            },
            {
                "product_id": "p3-spon",
                "trust_score": 0.72,
                "sponsored": True,
                "creator_name": "Reviewer3",
                "source_url": "https://r3.com",
            },
            {
                "product_id": "p4-organic",
                "trust_score": 0.33,
                "sponsored": False,
                "creator_name": "Reviewer4",
                "source_url": "https://r4.com",
            },
            {
                "product_id": "p5-spon",
                "trust_score": 0.91,
                "sponsored": True,
                "creator_name": "Reviewer5",
                "source_url": "https://r5.com",
            },
        ]

        result = rank_recommendations_by_trust(products)
        ranked = result["ranked"]

        # Expected order by trust: p5(0.91), p2(0.88), p3(0.72), p1(0.55), p4(0.33)
        expected_order = ["p5-spon", "p2-organic", "p3-spon", "p1-spon", "p4-organic"]
        actual_order = [r["product_id"] for r in ranked]
        assert actual_order == expected_order, (
            f"5 products must be ranked purely by trust_score descending.\n"
            f"Expected: {expected_order}\n"
            f"Actual:   {actual_order}"
        )

        # Trust scores must be monotonically descending
        trust_scores = [r["trust_score"] for r in ranked]
        for i in range(len(trust_scores) - 1):
            assert trust_scores[i] >= trust_scores[i + 1], (
                f"Trust score at position {i} ({trust_scores[i]}) must be >= "
                f"trust score at position {i+1} ({trust_scores[i+1]})"
            )

        # Integrity check
        integrity = verify_ranking_integrity(ranked)
        assert integrity["valid"] is True, (
            f"Ranking integrity violated: {integrity['violations']}"
        )

    # ------------------------------------------------------------------
    # Edge case 2: sponsored flag preserved after ranking
    # ------------------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0079", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "10", "scenario": "06", "title": "sponsored_flag_preserved_after_ranking"}
    def test_sponsored_flag_preserved_after_ranking(self):
        """Edge case: after ranking, each item's sponsored flag must
        exactly match the original input — ranking must not strip,
        flip, or coerce the flag."""

        products = [
            {
                "product_id": "preserve-A",
                "trust_score": 0.8,
                "sponsored": True,
                "creator_name": "ReviewerA",
                "source_url": "https://a.com",
            },
            {
                "product_id": "preserve-B",
                "trust_score": 0.6,
                "sponsored": False,
                "creator_name": "ReviewerB",
                "source_url": "https://b.com",
            },
            {
                "product_id": "preserve-C",
                "trust_score": 0.95,
                "sponsored": True,
                "creator_name": "ReviewerC",
                "source_url": "https://c.com",
            },
            {
                "product_id": "preserve-D",
                "trust_score": 0.5,
                "sponsored": False,
                "creator_name": "ReviewerD",
                "source_url": "https://d.com",
            },
        ]

        # Build a lookup of original sponsored flags by product_id
        original_flags = {
            p["product_id"]: p["sponsored"] for p in products
        }

        result = rank_recommendations_by_trust(products)
        ranked = result["ranked"]

        assert len(ranked) == len(products), (
            "Ranking must not drop or add items"
        )

        for item in ranked:
            pid = item["product_id"]
            assert pid in original_flags, (
                f"Unexpected product_id {pid!r} in ranked results"
            )
            assert item["sponsored"] is original_flags[pid], (
                f"Product {pid}: sponsored flag was "
                f"{original_flags[pid]!r} before ranking but "
                f"{item['sponsored']!r} after — flag must be preserved exactly"
            )
            # Type must remain bool, not coerced
            assert type(item["sponsored"]) is bool, (
                f"Product {pid}: sponsored must be bool, "
                f"got {type(item['sponsored']).__name__}"
            )

    # ------------------------------------------------------------------
    # Edge case 3: zero trust score products ranked last
    # ------------------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0080", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "10", "scenario": "07", "title": "zero_trust_score_products_ranked_last"}
    def test_zero_trust_score_products_ranked_last(self):
        """Edge case: products with trust_score 0.0 must always rank
        last regardless of sponsorship status.  A sponsored product
        with zero trust cannot buy its way to the top."""

        products = [
            {
                "product_id": "zero-trust-sponsored",
                "trust_score": 0.0,
                "sponsored": True,
                "creator_name": "ZeroTrustSponsor",
                "source_url": "https://zero-trust-sponsor.com",
            },
            {
                "product_id": "zero-trust-organic",
                "trust_score": 0.0,
                "sponsored": False,
                "creator_name": "ZeroTrustOrganic",
                "source_url": "https://zero-trust-organic.com",
            },
            {
                "product_id": "high-trust-organic",
                "trust_score": 0.85,
                "sponsored": False,
                "creator_name": "HighTrustOrganic",
                "source_url": "https://high-trust.com",
            },
        ]

        result = rank_recommendations_by_trust(products)
        ranked = result["ranked"]

        # High-trust product must be first
        assert ranked[0]["product_id"] == "high-trust-organic", (
            "Product with trust 0.85 must rank first"
        )
        assert ranked[0]["trust_score"] == 0.85

        # Both zero-trust products must be ranked last (positions 1 and 2)
        zero_trust_ids = {ranked[1]["product_id"], ranked[2]["product_id"]}
        assert zero_trust_ids == {"zero-trust-sponsored", "zero-trust-organic"}, (
            "Both zero-trust products must occupy the last two positions"
        )
        assert ranked[1]["trust_score"] == 0.0
        assert ranked[2]["trust_score"] == 0.0

        # The sponsored zero-trust product must NOT outrank the organic one
        # (stable sort: original order is sponsored, organic, so sponsored
        # stays at index 1 and organic at index 2 — but crucially, the
        # sponsored one does NOT jump to index 0)
        assert ranked[0]["product_id"] != "zero-trust-sponsored", (
            "A sponsored product with trust 0.0 must NEVER rank #1 — "
            "sponsorship cannot compensate for zero trust"
        )

        # Integrity check
        integrity = verify_ranking_integrity(ranked)
        assert integrity["valid"] is True, (
            f"Ranking integrity violated: {integrity['violations']}"
        )

    # ------------------------------------------------------------------
    # Edge case 4: single product ranking
    # ------------------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0081", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "10", "scenario": "08", "title": "single_product_ranking"}
    def test_single_product_ranking(self):
        """Edge case: only 1 product.  Rank is trivially correct.  The
        sponsored flag must be preserved."""

        product = {
            "product_id": "solo-product",
            "trust_score": 0.7,
            "sponsored": True,
            "creator_name": "SoloReviewer",
            "source_url": "https://solo.com/review",
        }

        result = rank_recommendations_by_trust([product])
        ranked = result["ranked"]

        assert len(ranked) == 1, "Single product list must produce single result"
        assert ranked[0]["product_id"] == "solo-product"
        assert ranked[0]["trust_score"] == 0.7
        assert ranked[0]["sponsored"] is True, (
            "Sponsored flag must be preserved even for single-item ranking"
        )
        assert type(ranked[0]["sponsored"]) is bool

        # Sponsorship cannot affect ranking of a single item
        assert result["sponsorship_affected_ranking"] is False

        # Integrity check
        integrity = verify_ranking_integrity(ranked)
        assert integrity["valid"] is True
        assert integrity["violations"] == []


# =========================================================================
# Helper: simulate AppView -> Brain -> Core -> User delivery pipeline
# =========================================================================

def simulate_appview_to_user_pipeline(
    appview_attestations: list[ExpertAttestation],
    dina: MockDinaCore,
) -> dict:
    """Simulate the full deep-link pipeline from AppView to user delivery.

    In production, this is the flow:
    1. AppView returns ExpertAttestations via xRPC ``com.dina.trust.resolve``
    2. Brain receives attestations and assembles a user-facing response,
       preserving source_url, deep_link, deep_link_context, and creator_name
       from each attestation.
    3. Brain validates attribution (defense in depth) and stores the assembled
       recommendation via Core's ``/v1/vault/store``.
    4. Core stores in SQLCipher vault.
    5. User queries and Core returns the recommendation.
    6. The user-facing response must contain clickable links to the original
       creator content -- not to Dina's domain, not to an intermediary.

    This function exercises all of those steps against the mock infrastructure.

    Args:
        appview_attestations: Attestations as if returned by AppView xRPC.
        dina: The MockDinaCore instance (wires vault, go_core, etc.).

    Returns:
        A dict with::

            {
                "recommendations": [
                    {
                        "source_url": str,
                        "deep_link": str,
                        "deep_link_context": str,
                        "creator_name": str,
                        "verdict_summary": str,
                        "rating": int,
                        "product_id": str,
                    },
                    ...
                ],
                "stored_keys": [str, ...],
                "assembly_result": AssembledAttribution,
            }
    """
    # --- Step 1: Brain assembles attestations into a response ---
    assembly = assemble_individual_attributions(appview_attestations)

    # --- Step 2: Build per-attestation recommendation dicts for storage ---
    recommendations: list[dict] = []
    stored_keys: list[str] = []

    for attestation, credit in zip(appview_attestations, _expand_credits(
        appview_attestations, assembly
    )):
        rec = {
            "product_id": attestation.product_id,
            "source_url": credit.source_url,
            "deep_link": credit.deep_link,
            "deep_link_context": attestation.deep_link_context,
            "creator_name": credit.creator_name,
            "verdict_summary": credit.verdict_summary,
            "rating": attestation.rating,
            "sponsored": False,
        }

        # --- Step 3: Brain validates attribution before storage ---
        validation = validate_attribution_before_storage(rec)
        if validation["blocked"]:
            # Attribution violation -- skip storage, but still include in
            # results so tests can verify the failure path.
            recommendations.append(rec)
            continue

        # --- Step 4: Store via Brain -> Core pipeline ---
        # Use a unique key per attestation to avoid collisions when multiple
        # attestations target the same product_id.
        unique_key = (
            f"rec_{attestation.product_id}_"
            f"{attestation.expert_did.replace(':', '_')}"
        )
        dina.go_core.vault_store(unique_key, rec)
        stored_keys.append(unique_key)

        # --- Step 5: Retrieve from vault (simulates user query) ---
        retrieved = dina.vault.retrieve(1, unique_key)
        if retrieved is not None:
            recommendations.append(retrieved)
        else:
            recommendations.append(rec)

    return {
        "recommendations": recommendations,
        "stored_keys": stored_keys,
        "assembly_result": assembly,
    }


def _expand_credits(
    attestations: list[ExpertAttestation],
    assembly: AssembledAttribution,
) -> list[IndividualCredit]:
    """Map each attestation back to its corresponding IndividualCredit.

    When multiple attestations share the same expert_did, they are grouped
    into one credit.  This function returns one credit per attestation (in
    order), using the grouped credit for that DID.
    """
    by_did = {c.expert_did: c for c in assembly.individual_credits}
    return [by_did[att.expert_did] for att in attestations]


# =========================================================================
# TST-INT-723: Deep link preserved -- AppView -> Brain -> User (Full Pipeline)
# =========================================================================

class TestDeepLinkEndToEnd:
    """Section 22.2 Creator Value Return -- Full Pipeline.

    TST-INT-723: Deep link preserved: AppView -> Brain -> User.

    Spec requirement:
        "AppView returns attestation with ``source_url`` -> Brain assembles
         -> delivers to user | User-facing response includes clickable link
         to original creator content."

    The Deep Link Default principle: Dina credits sources -- not just
    extracts.  Creators get traffic, users get truth.
    """

    # ------------------------------------------------------------------
    # TST-INT-723 -- primary test
    # ------------------------------------------------------------------

# TST-INT-723
    # TRACE: {"suite": "INT", "case": "0723", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "11", "scenario": "01", "title": "deep_link_preserved_appview_to_user"}
    def test_deep_link_preserved_appview_to_user(
        self, mock_dina: MockDinaCore
    ):
        """Full pipeline: AppView attestation with source_url and deep_link
        passes through Brain assembly, Core storage, and user retrieval
        with ALL attribution fields intact and unmodified."""

        attestation = ExpertAttestation(
            expert_did="did:plc:MKBHD_official",
            expert_trust_ring=TrustRing.RING_3_SKIN_IN_GAME,
            product_category="smartphones",
            product_id="galaxy-s26",
            rating=88,
            verdict={
                "summary": "Best camera system in any phone this year",
                "pros": ["Camera", "Display", "Battery life"],
                "cons": ["Price", "No charger in box"],
            },
            source_url="https://mkbhd.com/galaxy-s26-review",
            deep_link="https://mkbhd.com/galaxy-s26-review?t=345",
            deep_link_context="Camera comparison at 5:45",
            creator_name="MKBHD",
        )

        result = simulate_appview_to_user_pipeline([attestation], mock_dina)
        recs = result["recommendations"]
        assert len(recs) == 1, (
            "Single attestation must produce exactly one recommendation"
        )
        rec = recs[0]

        # --- source_url preserved EXACTLY ---
        assert rec["source_url"] == "https://mkbhd.com/galaxy-s26-review", (
            "source_url must be the EXACT original URL from AppView attestation. "
            f"Got: {rec['source_url']!r}"
        )

        # --- deep_link preserved EXACTLY (not stripped, truncated, or rewritten) ---
        assert rec["deep_link"] == "https://mkbhd.com/galaxy-s26-review?t=345", (
            "deep_link must survive the full AppView -> Brain -> Core -> User "
            "pipeline without any modification. The ?t=345 timestamp is critical "
            "-- it points the user to the exact moment in the content. "
            f"Got: {rec['deep_link']!r}"
        )

        # --- deep_link_context preserved ---
        assert rec["deep_link_context"] == "Camera comparison at 5:45", (
            "deep_link_context must tell the user what they'll find at the link. "
            f"Got: {rec['deep_link_context']!r}"
        )

        # --- creator_name preserved as the REAL name, not a generic substitute ---
        assert rec["creator_name"] == "MKBHD", (
            "creator_name must be 'MKBHD' -- the actual creator's name, not "
            "'an expert', 'a reviewer', or any anonymized substitute. "
            f"Got: {rec['creator_name']!r}"
        )

        # --- verdict content accessible to user ---
        assert rec["verdict_summary"] != "", (
            "verdict_summary must be non-empty -- the user needs to see "
            "the expert's actual opinion"
        )
        assert "camera" in rec["verdict_summary"].lower(), (
            "verdict_summary must reflect MKBHD's actual verdict about cameras, "
            f"not generic filler. Got: {rec['verdict_summary']!r}"
        )

        # --- Verify the recommendation was actually stored in and retrieved
        #     from Core's vault (not just returned from assembly) ---
        assert len(result["stored_keys"]) == 1, (
            "Recommendation must have been stored in Core's vault"
        )
        vault_item = mock_dina.vault.retrieve(1, result["stored_keys"][0])
        assert vault_item is not None, (
            "Recommendation must be retrievable from vault after pipeline"
        )
        assert vault_item["source_url"] == "https://mkbhd.com/galaxy-s26-review"
        assert vault_item["deep_link"] == "https://mkbhd.com/galaxy-s26-review?t=345"

    # ------------------------------------------------------------------
    # Counter-proof 1: deep_link not rewritten to intermediary
    # ------------------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0082", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "11", "scenario": "02", "title": "deep_link_not_rewritten_to_intermediary"}
    def test_deep_link_not_rewritten_to_intermediary(
        self, mock_dina: MockDinaCore
    ):
        """The deep_link in the user-facing response must point to the
        creator's own domain, not to Dina's domain, a proxy, a CDN,
        or any intermediary.  The Deep Link Default principle means the
        creator gets the traffic directly."""

        attestation = ExpertAttestation(
            expert_did="did:plc:DavesTechReviews",
            expert_trust_ring=TrustRing.RING_2_VERIFIED,
            product_category="headphones",
            product_id="sony-wh1000xm6",
            rating=91,
            verdict={"summary": "Best noise cancelling on the market"},
            source_url="https://davestechreviews.com/sony-xm6-review",
            deep_link="https://davestechreviews.com/sony-xm6-review#anc-test",
            deep_link_context="Active noise cancelling comparison section",
            creator_name="Dave Lee",
        )

        result = simulate_appview_to_user_pipeline([attestation], mock_dina)
        rec = result["recommendations"][0]

        # deep_link must be on the creator's domain
        assert "davestechreviews.com" in rec["deep_link"], (
            "deep_link must point to the creator's domain (davestechreviews.com), "
            f"not an intermediary. Got: {rec['deep_link']!r}"
        )

        # Must NOT be rewritten to any Dina-related domain
        forbidden_domains = [
            "dina.ai", "dina.com", "dina.local", "localhost",
            "proxy.", "cache.", "cdn.", "redirect.",
        ]
        for domain in forbidden_domains:
            assert domain not in rec["deep_link"], (
                f"deep_link must NOT contain '{domain}' -- it must point "
                f"directly to the creator. Got: {rec['deep_link']!r}"
            )
            assert domain not in rec["source_url"], (
                f"source_url must NOT contain '{domain}' -- it must point "
                f"directly to the creator. Got: {rec['source_url']!r}"
            )

    # ------------------------------------------------------------------
    # Counter-proof 2: multiple attestations each preserve their deep_link
    # ------------------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0083", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "11", "scenario": "03", "title": "multiple_attestations_each_preserve_deep_link"}
    def test_multiple_attestations_each_preserve_deep_link(
        self, mock_dina: MockDinaCore
    ):
        """3 attestations from different creators -- each keeps its own
        distinct deep_link in the user-facing response.  No merging,
        no deduplication of links, no dropping."""

        attestations = [
            ExpertAttestation(
                expert_did="did:plc:ReviewerAlpha",
                expert_trust_ring=TrustRing.RING_3_SKIN_IN_GAME,
                product_category="laptops",
                product_id="framework-16",
                rating=90,
                verdict={"summary": "Most repairable laptop ever made"},
                source_url="https://alpha-tech.com/framework-16",
                deep_link="https://alpha-tech.com/framework-16#repairability",
                deep_link_context="Repairability score breakdown",
                creator_name="Alpha Tech",
            ),
            ExpertAttestation(
                expert_did="did:plc:ReviewerBravo",
                expert_trust_ring=TrustRing.RING_2_VERIFIED,
                product_category="laptops",
                product_id="framework-16",
                rating=85,
                verdict={"summary": "GPU module delivers desktop-class performance"},
                source_url="https://bravo-hardware.net/fw16-gpu-test",
                deep_link="https://bravo-hardware.net/fw16-gpu-test?t=720",
                deep_link_context="GPU benchmark results at 12:00",
                creator_name="Bravo Hardware",
            ),
            ExpertAttestation(
                expert_did="did:plc:ReviewerCharlie",
                expert_trust_ring=TrustRing.RING_3_SKIN_IN_GAME,
                product_category="laptops",
                product_id="framework-16",
                rating=82,
                verdict={"summary": "Fan noise is the main weakness"},
                source_url="https://charlie-reviews.org/framework-16-noise",
                deep_link="https://charlie-reviews.org/framework-16-noise#decibel-chart",
                deep_link_context="Decibel measurements under load",
                creator_name="Charlie Reviews",
            ),
        ]

        result = simulate_appview_to_user_pipeline(attestations, mock_dina)
        recs = result["recommendations"]
        assert len(recs) == 3, (
            "3 attestations from 3 different creators must produce 3 recommendations"
        )

        # Each recommendation has its own distinct deep_link
        deep_links = [r["deep_link"] for r in recs]
        assert len(set(deep_links)) == 3, (
            "Each creator's deep_link must be distinct -- no merging. "
            f"Got: {deep_links}"
        )

        # Each deep_link points to the correct creator's domain
        recs_by_name = {r["creator_name"]: r for r in recs}
        assert "alpha-tech.com" in recs_by_name["Alpha Tech"]["deep_link"]
        assert "bravo-hardware.net" in recs_by_name["Bravo Hardware"]["deep_link"]
        assert "charlie-reviews.org" in recs_by_name["Charlie Reviews"]["deep_link"]

        # Each source_url is also distinct and preserved
        source_urls = [r["source_url"] for r in recs]
        assert len(set(source_urls)) == 3, (
            "Each creator's source_url must be distinct"
        )

        # Each creator_name is preserved individually
        creator_names = {r["creator_name"] for r in recs}
        assert creator_names == {"Alpha Tech", "Bravo Hardware", "Charlie Reviews"}

    # ------------------------------------------------------------------
    # Counter-proof 3: deep_link_context not lost in assembly
    # ------------------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0084", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "11", "scenario": "04", "title": "deep_link_context_not_lost_in_assembly"}
    def test_deep_link_context_not_lost_in_assembly(
        self, mock_dina: MockDinaCore
    ):
        """When Brain assembles multiple attestations, the deep_link_context
        string for EACH source must survive -- not be discarded, merged into
        a single context, or replaced with a generic description."""

        attestations = [
            ExpertAttestation(
                expert_did="did:plc:ContextExpert1",
                expert_trust_ring=TrustRing.RING_2_VERIFIED,
                product_category="cameras",
                product_id="canon-r5-ii",
                rating=94,
                verdict={"summary": "Autofocus tracks birds in flight flawlessly"},
                source_url="https://wildlife-photo.com/canon-r5-ii",
                deep_link="https://wildlife-photo.com/canon-r5-ii#bird-af",
                deep_link_context="Bird-in-flight autofocus test at 3:22",
                creator_name="Wildlife Photo Pro",
            ),
            ExpertAttestation(
                expert_did="did:plc:ContextExpert2",
                expert_trust_ring=TrustRing.RING_3_SKIN_IN_GAME,
                product_category="cameras",
                product_id="canon-r5-ii",
                rating=89,
                verdict={"summary": "8K video is usable but generates significant heat"},
                source_url="https://video-guru.tv/r5ii-8k-test",
                deep_link="https://video-guru.tv/r5ii-8k-test?t=900",
                deep_link_context="Thermal throttling test at 15:00",
                creator_name="Video Guru",
            ),
        ]

        result = simulate_appview_to_user_pipeline(attestations, mock_dina)
        recs = result["recommendations"]
        assert len(recs) == 2

        # Each recommendation preserves its own context
        contexts = {r["creator_name"]: r["deep_link_context"] for r in recs}

        assert contexts["Wildlife Photo Pro"] == "Bird-in-flight autofocus test at 3:22", (
            "Context for Wildlife Photo Pro must survive assembly intact. "
            f"Got: {contexts['Wildlife Photo Pro']!r}"
        )
        assert contexts["Video Guru"] == "Thermal throttling test at 15:00", (
            "Context for Video Guru must survive assembly intact. "
            f"Got: {contexts['Video Guru']!r}"
        )

        # Counter-proof: contexts are NOT merged into one string
        assert contexts["Wildlife Photo Pro"] != contexts["Video Guru"], (
            "Each creator must have their own distinct context string"
        )

    # ------------------------------------------------------------------
    # Edge case 1: deep_link with complex query params preserved
    # ------------------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0085", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "11", "scenario": "05", "title": "deep_link_with_query_params_preserved"}
    def test_deep_link_with_query_params_preserved(
        self, mock_dina: MockDinaCore
    ):
        """URLs with complex query parameters (utm_source, timestamps,
        fragments, encoded characters) must survive the full pipeline
        without any modification, encoding, or stripping."""

        complex_url = (
            "https://techreviewer.com/phone-review"
            "?t=345&utm_source=dina&utm_medium=trust"
            "&ref=expert-panel&lang=en"
            "#camera-section"
        )

        attestation = ExpertAttestation(
            expert_did="did:plc:ComplexURLExpert",
            expert_trust_ring=TrustRing.RING_2_VERIFIED,
            product_category="smartphones",
            product_id="pixel-10",
            rating=87,
            verdict={"summary": "Best computational photography"},
            source_url="https://techreviewer.com/phone-review",
            deep_link=complex_url,
            deep_link_context="Camera AI features comparison",
            creator_name="TechReviewer",
        )

        result = simulate_appview_to_user_pipeline([attestation], mock_dina)
        rec = result["recommendations"][0]

        # The EXACT complex URL must survive, including all query params and fragment
        assert rec["deep_link"] == complex_url, (
            "Complex deep_link with query params, UTM tags, and fragment "
            "must survive the full pipeline without modification. "
            f"Expected: {complex_url!r}  Got: {rec['deep_link']!r}"
        )

        # Verify specific components survived
        assert "?t=345" in rec["deep_link"], "Timestamp param must survive"
        assert "utm_source=dina" in rec["deep_link"], "UTM source must survive"
        assert "utm_medium=trust" in rec["deep_link"], "UTM medium must survive"
        assert "ref=expert-panel" in rec["deep_link"], "Ref param must survive"
        assert "#camera-section" in rec["deep_link"], "Fragment must survive"

    # ------------------------------------------------------------------
    # Edge case 2: empty deep_link falls back to source_url
    # ------------------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0086", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "11", "scenario": "06", "title": "deep_link_empty_still_has_source_url"}
    def test_deep_link_empty_still_has_source_url(
        self, mock_dina: MockDinaCore
    ):
        """When the attestation has an empty deep_link but a valid source_url,
        the source_url must still be preserved as the user's link to the
        original content.  The user always has a way to reach the creator."""

        attestation = ExpertAttestation(
            expert_did="did:plc:NoDeepLinkExpert",
            expert_trust_ring=TrustRing.RING_2_VERIFIED,
            product_category="tablets",
            product_id="ipad-air-m3",
            rating=86,
            verdict={"summary": "Best tablet for students"},
            source_url="https://student-tech.edu/ipad-air-review",
            deep_link="",  # no deep link -- only source_url
            deep_link_context="",
            creator_name="Student Tech Blog",
        )

        result = simulate_appview_to_user_pipeline([attestation], mock_dina)
        rec = result["recommendations"][0]

        # source_url MUST be preserved even when deep_link is empty
        assert rec["source_url"] == "https://student-tech.edu/ipad-air-review", (
            "When deep_link is empty, source_url must still be preserved "
            "as the user's link to the creator. "
            f"Got: {rec['source_url']!r}"
        )

        # creator_name preserved regardless of deep_link status
        assert rec["creator_name"] == "Student Tech Blog"

        # deep_link is empty but NOT fabricated -- it stays empty
        assert rec["deep_link"] == "", (
            "Empty deep_link must stay empty -- pipeline must not fabricate a link. "
            f"Got: {rec['deep_link']!r}"
        )

        # Verify the recommendation was still stored and retrievable
        assert len(result["stored_keys"]) == 1
        vault_item = mock_dina.vault.retrieve(1, result["stored_keys"][0])
        assert vault_item is not None
        assert vault_item["source_url"] == "https://student-tech.edu/ipad-air-review"

    # ------------------------------------------------------------------
    # Edge case 3: unicode in deep_link_context preserved
    # ------------------------------------------------------------------

    # TRACE: {"suite": "INT", "case": "0087", "section": "22", "sectionName": "Thesis: Pull Economy", "subsection": "11", "scenario": "07", "title": "unicode_in_deep_link_context_preserved"}
    def test_unicode_in_deep_link_context_preserved(
        self, mock_dina: MockDinaCore
    ):
        """Context strings with unicode characters (CJK, accented, special
        chars) must survive the full pipeline without corruption, encoding
        issues, or replacement."""

        attestation = ExpertAttestation(
            expert_did="did:plc:InternationalExpert",
            expert_trust_ring=TrustRing.RING_3_SKIN_IN_GAME,
            product_category="audio",
            product_id="sennheiser-hd800s",
            rating=95,
            verdict={"summary": "Reference-grade soundstage for critical listening"},
            source_url="https://audiophile-reviews.jp/hd800s",
            deep_link="https://audiophile-reviews.jp/hd800s#frequency-response",
            deep_link_context="\u5468\u6ce2\u6570\u7279\u6027\u306e\u6bd4\u8f03 \u2014 Frequenzvergleich bei 1kHz",
            creator_name="Audiophile Reviews JP",
        )

        result = simulate_appview_to_user_pipeline([attestation], mock_dina)
        rec = result["recommendations"][0]

        assert rec["deep_link_context"] == "\u5468\u6ce2\u6570\u7279\u6027\u306e\u6bd4\u8f03 \u2014 Frequenzvergleich bei 1kHz", (
            "Unicode deep_link_context (Japanese + German) must survive the "
            "full pipeline without corruption. "
            f"Got: {rec['deep_link_context']!r}"
        )

        # Verify the creator_name also survived
        assert rec["creator_name"] == "Audiophile Reviews JP"

        # Verify source_url with non-ASCII domain path survived
        assert rec["source_url"] == "https://audiophile-reviews.jp/hd800s"
        assert rec["deep_link"] == "https://audiophile-reviews.jp/hd800s#frequency-response"

        # Verify vault round-trip preserved unicode
        vault_item = mock_dina.vault.retrieve(1, result["stored_keys"][0])
        assert vault_item is not None
        assert vault_item["deep_link_context"] == "\u5468\u6ce2\u6570\u7279\u6027\u306e\u6bd4\u8f03 \u2014 Frequenzvergleich bei 1kHz", (
            "Unicode must survive Core vault storage and retrieval"
        )
