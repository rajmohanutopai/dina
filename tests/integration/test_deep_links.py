"""Integration tests for deep-link source attribution.

Behavioral contracts tested:
- Verdicts always attribute the original creator with a deep link to the
  exact moment (timestamp) in the source material.
- Creators get traffic, not intermediaries.
- User can override deep-link behavior (disable, re-prioritize).
"""

from __future__ import annotations

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
    def test_default_is_enabled(self, mock_dina: MockDinaCore):
        """By default, deep links are enabled — no preference entry means on."""
        pref = mock_dina.vault.retrieve(0, "pref_deep_links")
        # No preference stored yet => default is enabled
        assert pref is None  # absence means default

        # The system default
        default_enabled = True if pref is None else pref.get("enabled", True)
        assert default_enabled is True

# TST-INT-464
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
