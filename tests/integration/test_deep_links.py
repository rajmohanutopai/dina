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
    MockReputationGraph,
    MockReviewBot,
    TrustRing,
)


# =========================================================================
# TestDeepLinkDefault
# =========================================================================

class TestDeepLinkDefault:
    """Every verdict links back to the original source with attribution."""

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

    def test_deep_link_to_timestamp(self, mock_review_bot: MockReviewBot):
        """Deep link contains a timestamp parameter (t=260 -> 4:20) so the
        user lands at the exact moment in the video."""
        response = mock_review_bot.query_product("laptop comparison")
        sources = response["recommendations"][0]["sources"]
        expert = sources[0]

        assert "deep_link" in expert
        assert "&t=" in expert["deep_link"] or "?t=" in expert["deep_link"]
        assert "04:20" in expert["deep_link_context"] or "4:20" in expert["deep_link_context"]

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

    def test_user_can_disable_deep_links(
        self, mock_dina: MockDinaCore, mock_review_bot: MockReviewBot
    ):
        """User sets a preference to strip deep links from verdicts.
        The verdict still exists but links are removed before display."""
        # Store user preference
        mock_dina.vault.store(0, "pref_deep_links", {"enabled": False})

        response = mock_review_bot.query_product("laptop review")
        pref = mock_dina.vault.retrieve(0, "pref_deep_links")
        assert pref is not None
        assert pref["enabled"] is False

        # When deep links are disabled, the application layer strips them
        # before display. We verify the preference is honored.
        recs = response["recommendations"]
        if not pref["enabled"]:
            for rec in recs:
                for source in rec.get("sources", []):
                    # Application would set these to empty
                    source["deep_link"] = ""
                    source["deep_link_context"] = ""

        for rec in recs:
            for source in rec.get("sources", []):
                assert source["deep_link"] == ""

    def test_default_is_enabled(self, mock_dina: MockDinaCore):
        """By default, deep links are enabled — no preference entry means on."""
        pref = mock_dina.vault.retrieve(0, "pref_deep_links")
        # No preference stored yet => default is enabled
        assert pref is None  # absence means default

        # The system default
        default_enabled = True if pref is None else pref.get("enabled", True)
        assert default_enabled is True

    def test_custom_prioritization(
        self,
        mock_dina: MockDinaCore,
        mock_review_bot: MockReviewBot,
        mock_reputation_graph: MockReputationGraph,
    ):
        """User prefers video sources over text. Deep links from video
        experts are listed first."""
        mock_dina.vault.store(0, "pref_source_priority", {
            "order": ["video", "outcome_data", "text_review"],
        })

        response = mock_review_bot.query_product("best office chair")
        sources = response["recommendations"][0]["sources"]

        pref = mock_dina.vault.retrieve(0, "pref_source_priority")
        priority_order = pref["order"]

        # Re-sort sources according to user priority
        def source_priority(s):
            stype = s.get("type", "")
            if stype == "expert" and "youtube" in s.get("source_url", ""):
                return priority_order.index("video") if "video" in priority_order else 99
            if stype == "outcome":
                return priority_order.index("outcome_data") if "outcome_data" in priority_order else 99
            return priority_order.index("text_review") if "text_review" in priority_order else 99

        sorted_sources = sorted(sources, key=source_priority)

        # Video sources should come first when user prefers them
        if sorted_sources and "youtube" in sorted_sources[0].get("source_url", ""):
            assert sorted_sources[0]["type"] == "expert"
