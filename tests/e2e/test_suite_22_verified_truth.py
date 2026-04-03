"""E2E Test Suite 22: Verified Truth — Trust Data Density.

Product-level validation that Brain communicates trust data honestly:
zero data acknowledged, sparse data caveated, dense data confident,
stale data flagged, ring levels visible.

Actors: Don Alonso, AppView, OpenClaw, ReviewBot.
"""

from __future__ import annotations

import json
import re
import time

import pytest

from tests.e2e.actors import HomeNode
from tests.e2e.mocks import (
    MockAppView,
    MockOpenClaw,
    MockReviewBot,
    TrustRing,
    VaultItem,
)


# ---------------------------------------------------------------------------
# Suite 22: Verified Truth — Trust Data Density
# ---------------------------------------------------------------------------


class TestVerifiedTruth:
    """E2E-22.x -- Trust data density spectrum: honest uncertainty when
    data is absent, caveats when sparse, confidence when dense.

    All tests hit real Go Core APIs for vault operations.  Brain
    reasoning uses the real Brain API where possible, falling back
    to the mock LLM for response assembly.
    """

    # TST-E2E-116
    # TRACE: {"suite": "E2E", "case": "0116", "section": "22", "sectionName": "Verified Truth", "subsection": "01", "scenario": "01", "title": "product_research_zero_trust_data"}
    def test_product_research_zero_trust_data(
        self,
        don_alonso: HomeNode,
        appview: MockAppView,
        openclaw: MockOpenClaw,
    ) -> None:
        """E2E-22.1 Product Research — Zero Trust Data.

        Query Brain: "Should I buy the XYZ Widget?"  AppView returns
        empty (product unknown to Trust Network).  Brain must respond
        honestly: "no verified reviews" — no hallucinated scores.
        Response still useful (personal context from vault applied).

        Requirement: E2E_TEST_PLAN §22.1.
        """
        # ------------------------------------------------------------------
        # Step 1: Pre-populate vault with user preferences/budget.
        # Uses real Go Core POST /v1/vault/store.
        # ------------------------------------------------------------------
        don_alonso.vault_store(
            "consumer",
            "budget_constraints",
            {
                "monthly_budget": 200,
                "category": "gadgets",
                "preferences": "value for money, durability",
            },
            item_type="note",
            source="user",
        )

        don_alonso.vault_store(
            "consumer",
            "ergonomic_needs",
            {
                "condition": "back pain",
                "requirement": "ergonomic design important",
            },
            item_type="note",
            source="user",
        )

        # ------------------------------------------------------------------
        # Step 2: Verify AppView returns no trust data for "XYZ Widget".
        # ------------------------------------------------------------------
        trust_results = appview.query_product("XYZ Widget")
        assert trust_results is None or len(trust_results) == 0, (
            f"AppView must return empty for unknown product 'XYZ Widget'. "
            f"Got: {trust_results!r}"
        )

        # ------------------------------------------------------------------
        # Step 3: Query Brain for product recommendation.
        # Uses real Brain API POST /api/v1/process (reason event).
        # ------------------------------------------------------------------
        result = don_alonso._brain_process(
            "reason",
            {
                "prompt": "Should I buy the XYZ Widget?",
                "body": "Should I buy the XYZ Widget?",
                "persona_id": "consumer",
            },
        )

        content = result.get("content", "") or result.get("text", "")
        content_lower = content.lower()

        # ------------------------------------------------------------------
        # Step 4: Verify honest absence — no hallucinated trust scores.
        # Law 2 (Verified Truth): never fabricate trust evidence.
        # ------------------------------------------------------------------
        honest_absence = re.compile(
            r"no (?:verified )?review|no trust (?:data|network)|"
            r"not found in.{0,20}trust|no attestation|"
            r"unknown.{0,20}trust network|no rating",
            re.IGNORECASE,
        )
        assert honest_absence.search(content), (
            f"Brain must honestly acknowledge absence of trust data: "
            f"'no verified reviews in the Trust Network' or equivalent. "
            f"Law 2: never hallucinate trust scores. Got: {content!r}"
        )

        # Must NOT contain fabricated scores or ratings.
        fabricated = re.compile(
            r"\b\d+/\d+\b|\b\d+%\b|\b\d+\.\d+ out of|"
            r"rated \d|score of \d|trust score|"
            r"highly rated|well-reviewed",
            re.IGNORECASE,
        )
        assert not fabricated.search(content), (
            f"With zero trust data, Brain must NOT fabricate scores "
            f"or ratings. Law 2 violation. Got: {content!r}"
        )

        # ------------------------------------------------------------------
        # Step 5: Verify personal context still applied.
        # Despite missing trust data, vault preferences (budget, back pain)
        # should inform the response.
        # ------------------------------------------------------------------
        personal_context = re.compile(
            r"budget|200|\$200|back pain|ergonomic|durabilit|value",
            re.IGNORECASE,
        )
        assert personal_context.search(content), (
            f"Response must still apply personal context from vault "
            f"(budget, ergonomic needs) even with zero trust data. "
            f"Got: {content!r}"
        )

        # ------------------------------------------------------------------
        # Step 6: Verify audit trail for trust query.
        # ------------------------------------------------------------------
        audit_entries = don_alonso.get_audit_entries("vault_query")
        assert len(audit_entries) >= 1, (
            f"Vault query during product research must be audited. "
            f"Got {len(audit_entries)} audit entries."
        )

    # TST-E2E-117
    # TRACE: {"suite": "E2E", "case": "0117", "section": "22", "sectionName": "Verified Truth", "subsection": "01", "scenario": "02", "title": "product_research_sparse_conflicting_data"}
    def test_product_research_sparse_conflicting_data(
        self,
        don_alonso: HomeNode,
        appview: MockAppView,
    ) -> None:
        """E2E-22.2 Product Research — Sparse Conflicting Data.

        Seed AppView with 3 reviews: 2 positive (Ring 2), 1 negative
        (Ring 2).  Query: "Should I buy this product?"  Response reports
        split honestly: "Mixed reviews from verified sources" — does NOT
        pick a side with only 3 reviews.  Each reviewer credited
        individually with source link.

        Requirement: E2E_TEST_PLAN §22.2.
        """
        # ------------------------------------------------------------------
        # Step 1: Seed AppView with sparse, conflicting trust data.
        # ------------------------------------------------------------------
        product_did = "at://did:plc:maker/com.dina.trust.product/ergodesk"

        appview.seed_attestations(product_did, [
            {
                "reviewer_did": "did:plc:reviewer-a",
                "reviewer_name": "Alice",
                "ring": 2,
                "sentiment": "positive",
                "text": "ErgoDesk is well-built and comfortable for long sessions.",
                "source_url": "https://example.com/review/alice-ergodesk",
                "created_at": "2026-02-01T10:00:00Z",
            },
            {
                "reviewer_did": "did:plc:reviewer-b",
                "reviewer_name": "Bob",
                "ring": 2,
                "sentiment": "positive",
                "text": "Great desk, smooth height adjustment. Worth the price.",
                "source_url": "https://example.com/review/bob-ergodesk",
                "created_at": "2026-02-15T14:00:00Z",
            },
            {
                "reviewer_did": "did:plc:reviewer-c",
                "reviewer_name": "Carol",
                "ring": 2,
                "sentiment": "negative",
                "text": "Wobbly at standing height. Motor failed after 3 months.",
                "source_url": "https://example.com/review/carol-ergodesk",
                "created_at": "2026-01-20T09:00:00Z",
            },
        ])

        # Also store the trust data in Don Alonso's vault so Brain can
        # find it during reasoning.  Uses real Go Core POST /v1/vault/store.
        don_alonso.vault_store(
            "consumer",
            "ergodesk_review_alice",
            {
                "product": "ErgoDesk",
                "reviewer": "Alice",
                "ring": 2,
                "sentiment": "positive",
                "text": "Well-built and comfortable for long sessions.",
                "source_url": "https://example.com/review/alice-ergodesk",
            },
            item_type="trust_attestation",
            source="trust_network",
        )

        don_alonso.vault_store(
            "consumer",
            "ergodesk_review_bob",
            {
                "product": "ErgoDesk",
                "reviewer": "Bob",
                "ring": 2,
                "sentiment": "positive",
                "text": "Great desk, smooth height adjustment.",
                "source_url": "https://example.com/review/bob-ergodesk",
            },
            item_type="trust_attestation",
            source="trust_network",
        )

        don_alonso.vault_store(
            "consumer",
            "ergodesk_review_carol",
            {
                "product": "ErgoDesk",
                "reviewer": "Carol",
                "ring": 2,
                "sentiment": "negative",
                "text": "Wobbly at standing height. Motor failed after 3 months.",
                "source_url": "https://example.com/review/carol-ergodesk",
            },
            item_type="trust_attestation",
            source="trust_network",
        )

        # ------------------------------------------------------------------
        # Step 2: Verify vault contains the trust attestations.
        # Uses real Go Core POST /v1/vault/query.
        # ------------------------------------------------------------------
        results = don_alonso.vault_query("consumer", "ErgoDesk", mode="fts5")
        assert len(results) >= 2, (
            f"Vault must contain ErgoDesk trust attestations. "
            f"Got {len(results)} results."
        )

        # ------------------------------------------------------------------
        # Step 3: Query Brain for product recommendation.
        # ------------------------------------------------------------------
        result = don_alonso._brain_process(
            "reason",
            {
                "prompt": "Should I buy the ErgoDesk?",
                "body": "Should I buy the ErgoDesk?",
                "persona_id": "consumer",
            },
        )

        content = result.get("content", "") or result.get("text", "")
        content_lower = content.lower()

        # ------------------------------------------------------------------
        # Step 4: Verify honest reporting — "mixed" or "conflicting".
        # With 2 positive + 1 negative out of only 3 reviews, Brain must
        # NOT claim consensus.  Law 2: Verified Truth.
        # ------------------------------------------------------------------
        honest_split = re.compile(
            r"mixed|conflicting|split|divided|disagree|"
            r"not unanimous|2.{0,10}positive.{0,20}1.{0,10}negative|"
            r"some.{0,10}positive.{0,10}some.{0,10}negative",
            re.IGNORECASE,
        )
        assert honest_split.search(content), (
            f"3 reviews (2 positive, 1 negative) is sparse + conflicting. "
            f"Brain must report honestly ('mixed reviews from verified "
            f"sources'), NOT pick a side. Got: {content!r}"
        )

        # Must NOT claim strong consensus with only 3 reviews.
        false_consensus = re.compile(
            r"strong consensus|overwhelm|highly recommend|"
            r"clear winner|definite|no doubt",
            re.IGNORECASE,
        )
        assert not false_consensus.search(content), (
            f"Only 3 reviews — Brain must NOT claim consensus. "
            f"Law 2 (Verified Truth): confidence earned, not assumed. "
            f"Got: {content!r}"
        )

        # ------------------------------------------------------------------
        # Step 5: Verify sparse data caveat.
        # Brain must note the limited sample size.
        # ------------------------------------------------------------------
        sparse_caveat = re.compile(
            r"only \d|3 review|limited|small sample|sparse|few review",
            re.IGNORECASE,
        )
        assert sparse_caveat.search(content), (
            f"Brain must caveat the sparse data ('only 3 reviews', "
            f"'limited data'). Got: {content!r}"
        )

        # ------------------------------------------------------------------
        # Step 6: Verify individual source attribution.
        # Each reviewer must be credited — deep links, not extraction.
        # ------------------------------------------------------------------
        attribution = re.compile(
            r"alice|bob|carol|reviewer|source|link|"
            r"example\.com/review",
            re.IGNORECASE,
        )
        assert attribution.search(content), (
            f"Each reviewer must be credited individually (Alice, Bob, "
            f"Carol) with source links. Pull Economy: creators get "
            f"traffic. Got: {content!r}"
        )

        # ------------------------------------------------------------------
        # Step 7: Verify Ring 2 (verified) status mentioned.
        # All 3 reviewers are Ring 2 — narrative should note verification.
        # ------------------------------------------------------------------
        verified_ref = re.compile(
            r"verif|ring 2|trusted|authenticated", re.IGNORECASE,
        )
        assert verified_ref.search(content), (
            f"All 3 reviewers are Ring 2 (verified) — response must "
            f"mention verification status. Got: {content!r}"
        )

    # TST-E2E-118
    # TRACE: {"suite": "E2E", "case": "0118", "section": "22", "sectionName": "Verified Truth", "subsection": "01", "scenario": "03", "title": "product_research_dense_trust_data_consensus"}
    def test_product_research_dense_trust_data_consensus(
        self,
        don_alonso: HomeNode,
        appview: MockAppView,
    ) -> None:
        """E2E-22.3 Product Research — Dense Trust Data with Consensus.

        Seed AppView with 50+ reviews (90% positive, Ring 2 majority).
        Query: "Should I buy this product?"  Brain must communicate
        confidence proportional to data density: "Strong consensus from
        50+ verified reviewers."  Expert reviews deep-linked — creators
        get traffic, not extraction.

        Requirement: E2E_TEST_PLAN §22.3.
        """
        product_did = "at://did:plc:maker/com.dina.trust.product/ultradesk-pro"

        # ------------------------------------------------------------------
        # Step 1: Seed AppView with 50+ reviews — 90% positive, Ring 2.
        # ------------------------------------------------------------------
        review_count = 55
        positive_count = 50  # ~91% positive
        negative_count = 5

        reviews = []
        for i in range(positive_count):
            reviews.append({
                "reviewer_did": f"did:plc:reviewer-pos-{i:03d}",
                "reviewer_name": f"Reviewer_{i+1}",
                "ring": 2,
                "sentiment": "positive",
                "text": (
                    f"UltraDesk Pro review #{i+1}: Excellent build quality, "
                    f"smooth motor, great cable management. "
                    f"{'Highly recommended for developers.' if i % 3 == 0 else ''}"
                    f"{'Perfect for standing desk setup.' if i % 3 == 1 else ''}"
                    f"{'Best desk I have ever owned.' if i % 3 == 2 else ''}"
                ),
                "source_url": f"https://reviews.example.com/ultradesk-pro/{i+1}",
                "created_at": f"2026-0{1 + (i % 2)}-{10 + (i % 20):02d}T10:00:00Z",
            })

        for i in range(negative_count):
            reviews.append({
                "reviewer_did": f"did:plc:reviewer-neg-{i:03d}",
                "reviewer_name": f"CriticalReviewer_{i+1}",
                "ring": 2,
                "sentiment": "negative",
                "text": (
                    f"UltraDesk Pro negative review #{i+1}: "
                    f"{'Expensive for what you get.' if i % 2 == 0 else ''}"
                    f"{'Delivery took too long.' if i % 2 == 1 else ''}"
                ),
                "source_url": f"https://reviews.example.com/ultradesk-pro/neg-{i+1}",
                "created_at": f"2026-01-{5 + i:02d}T10:00:00Z",
            })

        appview.seed_attestations(product_did, reviews)

        # ------------------------------------------------------------------
        # Step 2: Also store a representative subset in Don Alonso's vault
        # so Brain can find trust data during reasoning.
        # Uses real Go Core POST /v1/vault/store.
        # ------------------------------------------------------------------

        # Store summary metadata — total count and consensus.
        don_alonso.vault_store(
            "consumer",
            "ultradesk_trust_summary",
            {
                "product": "UltraDesk Pro",
                "total_reviews": review_count,
                "positive_count": positive_count,
                "negative_count": negative_count,
                "consensus_pct": round(positive_count / review_count * 100, 1),
                "ring_2_count": review_count,
                "data_density": "dense",
            },
            item_type="trust_summary",
            source="trust_network",
        )

        # Store individual attestations for the top reviewers (first 10).
        for i in range(min(10, positive_count)):
            don_alonso.vault_store(
                "consumer",
                f"ultradesk_review_{i:03d}",
                {
                    "product": "UltraDesk Pro",
                    "reviewer": f"Reviewer_{i+1}",
                    "reviewer_did": f"did:plc:reviewer-pos-{i:03d}",
                    "ring": 2,
                    "sentiment": "positive",
                    "text": reviews[i]["text"],
                    "source_url": reviews[i]["source_url"],
                },
                item_type="trust_attestation",
                source="trust_network",
            )

        # Store a couple of the negative reviews too.
        for i in range(min(3, negative_count)):
            idx = positive_count + i
            don_alonso.vault_store(
                "consumer",
                f"ultradesk_neg_review_{i:03d}",
                {
                    "product": "UltraDesk Pro",
                    "reviewer": f"CriticalReviewer_{i+1}",
                    "reviewer_did": f"did:plc:reviewer-neg-{i:03d}",
                    "ring": 2,
                    "sentiment": "negative",
                    "text": reviews[idx]["text"],
                    "source_url": reviews[idx]["source_url"],
                },
                item_type="trust_attestation",
                source="trust_network",
            )

        # ------------------------------------------------------------------
        # Step 3: Verify vault contains trust data.
        # Uses real Go Core POST /v1/vault/query.
        # ------------------------------------------------------------------
        results = don_alonso.vault_query(
            "consumer", "UltraDesk Pro", mode="fts5",
        )
        assert len(results) >= 5, (
            f"Vault must contain UltraDesk Pro trust attestations. "
            f"Got {len(results)} results."
        )

        # ------------------------------------------------------------------
        # Step 4: Query Brain for product recommendation.
        # ------------------------------------------------------------------
        result = don_alonso._brain_process(
            "reason",
            {
                "prompt": "Should I buy the UltraDesk Pro?",
                "body": "Should I buy the UltraDesk Pro?",
                "persona_id": "consumer",
            },
        )

        content = result.get("content", "") or result.get("text", "")
        content_lower = content.lower()

        # ------------------------------------------------------------------
        # Step 5: Verify confident language — proportional to dense data.
        # With 50+ reviews at 90%+ positive, Brain should express high
        # confidence.  Law 2: confidence earned through data density.
        # ------------------------------------------------------------------
        confident_language = re.compile(
            r"strong consensus|overwhelm|highly recommend|"
            r"clear.{0,10}(choice|winner|favorite)|"
            r"well.{0,5}regard|wide.{0,5}praised|"
            r"50\+?\s*(?:verified\s*)?review|"
            r"major|confident|consistently positive",
            re.IGNORECASE,
        )
        assert confident_language.search(content), (
            f"With 50+ reviews (90% positive), Brain must communicate "
            f"proportional confidence ('strong consensus from 50+ "
            f"verified reviewers'). Law 2: confidence earned through "
            f"data density. Got: {content!r}"
        )

        # ------------------------------------------------------------------
        # Step 6: Verify consensus magnitude is mentioned.
        # Brain must report the scale of agreement — not just "good".
        # ------------------------------------------------------------------
        magnitude = re.compile(
            r"50|55|9[01]%|majority|most review|"
            r"overwhelm|nearly all|vast majority|"
            r"consensus.{0,20}(strong|clear|wide)|"
            r"\d+ out of \d+|"
            r"(strong|clear|wide).{0,20}consensus",
            re.IGNORECASE,
        )
        assert magnitude.search(content), (
            f"Brain must report consensus magnitude ('50+ reviews', "
            f"'90% positive', 'vast majority'). Not just 'good product' "
            f"— quantify the consensus. Got: {content!r}"
        )

        # ------------------------------------------------------------------
        # Step 7: Verify deep links to reviewers — creators get traffic.
        # Pull Economy: attribution with source links, not extraction.
        # ------------------------------------------------------------------
        deep_link = re.compile(
            r"reviews\.example\.com|source|link|"
            r"Reviewer_\d+|read.{0,10}review|"
            r"see.{0,10}review|full.{0,10}review",
            re.IGNORECASE,
        )
        assert deep_link.search(content), (
            f"Expert reviews must be deep-linked — creators get traffic, "
            f"not extraction. Response must include reviewer names or "
            f"source URLs. Pull Economy principle. Got: {content!r}"
        )

        # ------------------------------------------------------------------
        # Step 8: Verify Ring 2 (verified) status mentioned.
        # All reviewers are Ring 2 — response should note verification.
        # ------------------------------------------------------------------
        verified_ref = re.compile(
            r"verif|ring 2|trusted|authenticated|"
            r"attested|confirmed",
            re.IGNORECASE,
        )
        assert verified_ref.search(content), (
            f"All {review_count} reviewers are Ring 2 (verified) — "
            f"response must mention verification status. Trust earned, "
            f"not assumed. Got: {content!r}"
        )

        # ------------------------------------------------------------------
        # Step 9: Verify negative reviews are NOT suppressed.
        # Law 2 (Verified Truth): even with strong consensus, the 10%
        # negative feedback must be acknowledged honestly.
        # ------------------------------------------------------------------
        negative_ack = re.compile(
            r"negat|concern|criticism|complaint|"
            r"(some|few|minor).{0,20}(issue|problem|drawback)|"
            r"not.{0,10}(perfect|without|unanimous)|"
            r"downside|caveat|however|though",
            re.IGNORECASE,
        )
        assert negative_ack.search(content), (
            f"Even with 90% positive consensus, Brain must acknowledge "
            f"the {negative_count} negative reviews honestly. Law 2: "
            f"Verified Truth — no suppression of dissent. "
            f"Got: {content!r}"
        )

        # Must NOT claim unanimity — 5 negatives exist.
        unanimous_claim = re.compile(
            r"unanim|100%|all review.{0,5}positive|"
            r"no.{0,10}(negative|bad|critical)\s+review|"
            r"perfect score|flawless record",
            re.IGNORECASE,
        )
        assert not unanimous_claim.search(content), (
            f"Brain must NOT claim unanimity — {negative_count} negative "
            f"reviews exist. Law 2 violation: suppressing minority "
            f"dissent. Got: {content!r}"
        )

        # ------------------------------------------------------------------
        # Step 10: Verify audit trail for the trust query.
        # ------------------------------------------------------------------
        audit_entries = don_alonso.get_audit_entries("vault_query")
        assert len(audit_entries) >= 1, (
            f"Trust query during product research must be audited. "
            f"Got {len(audit_entries)} audit entries."
        )

    # TST-E2E-119
    @pytest.mark.xfail(
        strict=True,
        reason=(
            "TST-E2E-119 (Phase 2): Data freshness/staleness detection "
            "pipeline is unimplemented.  vault_context does not extract "
            "timestamp or created_at metadata from vault items.  Brain "
            "reasoning has no freshness validation to flag reviews older "
            "than 1 year.  AppView trust queries do not include timestamp "
            "metadata.  Law 2 (Verified Truth) requires stale data to be "
            "flagged, not presented as current."
        ),
    )
    # TRACE: {"suite": "E2E", "case": "0011", "section": "22", "sectionName": "Verified Truth", "subsection": "01", "scenario": "04", "title": "product_research_stale_reviews"}
    def test_product_research_stale_reviews(
        self,
        don_alonso: HomeNode,
        appview: MockAppView,
    ) -> None:
        """E2E-22.4 Product Research — Stale Reviews.

        Seed AppView with 20 reviews, all >1 year old.  Query about
        the product.  Response includes reviews BUT flags recency:
        "Reviews are over a year old."  Law 2: Verified Truth —
        stale data must be flagged, not presented as current.

        Requirement: E2E_TEST_PLAN §22.4.
        """
        product_did = "at://did:plc:maker/com.dina.trust.product/classicchair"

        # ------------------------------------------------------------------
        # Step 1: Seed AppView with 20 reviews, all >1 year old.
        # Reviews are from 2024 — over a year ago relative to 2026-03.
        # ------------------------------------------------------------------
        review_count = 20
        reviews = []
        for i in range(review_count):
            # All reviews are from Jan-Jun 2024 — >1 year stale.
            month = 1 + (i % 6)
            day = 5 + (i % 20)
            sentiment = "positive" if i % 4 != 0 else "negative"
            reviews.append({
                "reviewer_did": f"did:plc:stale-reviewer-{i:03d}",
                "reviewer_name": f"OldReviewer_{i+1}",
                "ring": 2,
                "sentiment": sentiment,
                "text": (
                    f"ClassicChair review #{i+1}: "
                    f"{'Solid wooden construction.' if i % 3 == 0 else ''}"
                    f"{'Comfortable for dining.' if i % 3 == 1 else ''}"
                    f"{'Good value for the price.' if i % 3 == 2 else ''}"
                ),
                "source_url": f"https://reviews.example.com/classicchair/{i+1}",
                "created_at": f"2024-{month:02d}-{day:02d}T10:00:00Z",
            })

        appview.seed_attestations(product_did, reviews)

        # ------------------------------------------------------------------
        # Step 2: Store reviews in vault with explicit timestamps.
        # Uses real Go Core POST /v1/vault/store.
        # ------------------------------------------------------------------

        # Store a summary with staleness metadata.
        don_alonso.vault_store(
            "consumer",
            "classicchair_trust_summary",
            {
                "product": "ClassicChair",
                "total_reviews": review_count,
                "newest_review_date": "2024-06-25",
                "oldest_review_date": "2024-01-05",
                "all_reviews_older_than": "1 year",
                "data_freshness": "stale",
                "positive_count": 15,
                "negative_count": 5,
            },
            item_type="trust_summary",
            source="trust_network",
        )

        # Store individual reviews with dates.
        for i in range(min(8, review_count)):
            month = 1 + (i % 6)
            day = 5 + (i % 20)
            don_alonso.vault_store(
                "consumer",
                f"classicchair_review_{i:03d}",
                {
                    "product": "ClassicChair",
                    "reviewer": f"OldReviewer_{i+1}",
                    "ring": 2,
                    "sentiment": reviews[i]["sentiment"],
                    "text": reviews[i]["text"],
                    "source_url": reviews[i]["source_url"],
                    "created_at": f"2024-{month:02d}-{day:02d}T10:00:00Z",
                    "review_age": "over 1 year",
                },
                item_type="trust_attestation",
                source="trust_network",
            )

        # ------------------------------------------------------------------
        # Step 3: Verify vault contains the stale trust data.
        # Uses real Go Core POST /v1/vault/query.
        # ------------------------------------------------------------------
        results = don_alonso.vault_query(
            "consumer", "ClassicChair", mode="fts5",
        )
        assert len(results) >= 3, (
            f"Vault must contain ClassicChair trust attestations. "
            f"Got {len(results)} results."
        )

        # ------------------------------------------------------------------
        # Step 4: Query Brain for product recommendation.
        # ------------------------------------------------------------------
        result = don_alonso._brain_process(
            "reason",
            {
                "prompt": "Should I buy the ClassicChair?",
                "body": "Should I buy the ClassicChair?",
                "persona_id": "consumer",
            },
        )

        content = result.get("content", "") or result.get("text", "")
        content_lower = content.lower()

        # ------------------------------------------------------------------
        # Step 5: Verify response flags staleness.
        # Law 2 (Verified Truth): stale data must be explicitly flagged.
        # ------------------------------------------------------------------
        staleness_flag = re.compile(
            r"over (?:a |one |1 )?year|more than (?:a |one |1 )?year|"
            r"outdated|stale|old review|dated|"
            r"2024|from last year|not recent|"
            r"(?:may|might|could) (?:be|have) changed|"
            r"no longer (?:accurate|current|valid)|"
            r"(?:year|month).{0,10}(?:old|ago|stale)",
            re.IGNORECASE,
        )
        assert staleness_flag.search(content), (
            f"All 20 reviews are >1 year old. Brain must flag data "
            f"staleness: 'reviews are over a year old' or equivalent. "
            f"Law 2 (Verified Truth): never present stale data as "
            f"current. Got: {content!r}"
        )

        # ------------------------------------------------------------------
        # Step 6: Verify response still includes the reviews.
        # Stale data is not discarded — it's presented WITH a caveat.
        # ------------------------------------------------------------------
        review_content = re.compile(
            r"classicchair|wooden|dining|comfortable|"
            r"review|solid|construction|value",
            re.IGNORECASE,
        )
        assert review_content.search(content), (
            f"Stale reviews must still be included in the response — "
            f"flagged, not discarded. The user needs the data WITH "
            f"the staleness caveat. Got: {content!r}"
        )

        # ------------------------------------------------------------------
        # Step 7: Verify response recommends seeking fresher data.
        # Brain should suggest checking for newer reviews.
        # ------------------------------------------------------------------
        fresher_data = re.compile(
            r"newer review|recent review|updated review|"
            r"check.{0,10}(for|if).{0,10}(newer|recent|updated)|"
            r"seek.{0,10}(fresh|recent|current)|"
            r"recommend.{0,10}(check|look|search)|"
            r"look for.{0,10}(newer|recent)|"
            r"more recent",
            re.IGNORECASE,
        )
        assert fresher_data.search(content), (
            f"With all reviews >1 year old, Brain must recommend "
            f"seeking fresher data. Not just caveat — actionable "
            f"guidance. Got: {content!r}"
        )

        # ------------------------------------------------------------------
        # Step 8: Verify response does NOT claim current accuracy.
        # Must NOT say "currently rated" or "right now" with stale data.
        # ------------------------------------------------------------------
        false_currency = re.compile(
            r"currently (?:rated|reviewed|scoring)|"
            r"right now.{0,20}(?:rated|review)|"
            r"as of today.{0,20}(?:rated|review)|"
            r"up.to.date|latest review",
            re.IGNORECASE,
        )
        assert not false_currency.search(content), (
            f"Brain must NOT claim data currency with >1 year old "
            f"reviews. Law 2 violation: presenting stale data as "
            f"current. Got: {content!r}"
        )

        # ------------------------------------------------------------------
        # Step 9: Verify Ring 2 status still mentioned.
        # Even stale reviews can note that reviewers were verified.
        # ------------------------------------------------------------------
        verified_ref = re.compile(
            r"verif|ring 2|trusted|authenticated",
            re.IGNORECASE,
        )
        assert verified_ref.search(content), (
            f"Even with stale data, verified reviewer status (Ring 2) "
            f"should be mentioned — verification doesn't expire. "
            f"Got: {content!r}"
        )

        # ------------------------------------------------------------------
        # Step 10: Verify audit trail for the trust query.
        # ------------------------------------------------------------------
        audit_entries = don_alonso.get_audit_entries("vault_query")
        assert len(audit_entries) >= 1, (
            f"Trust query for stale reviews must be audited. "
            f"Got {len(audit_entries)} audit entries."
        )

    # TST-E2E-120
    @pytest.mark.xfail(
        strict=True,
        reason=(
            "TST-E2E-120 (Phase 2): Ring-level weighting is not visibly "
            "differentiated in Brain reasoning output.  vault_context "
            "does not extract ring-level metadata from vault items.  "
            "Brain has no ring classification instructions (Ring 1 vs "
            "Ring 2 vs Ring 3) or post-processing to validate ring "
            "weighting in the narrative.  AppView ring-differentiated "
            "trust queries are not wired into the reasoning pipeline."
        ),
    )
    # TRACE: {"suite": "E2E", "case": "0012", "section": "22", "sectionName": "Verified Truth", "subsection": "01", "scenario": "05", "title": "product_research_ring_level_weighting"}
    def test_product_research_ring_level_weighting(
        self,
        don_alonso: HomeNode,
        appview: MockAppView,
    ) -> None:
        """E2E-22.5 Product Research — Ring Level Weighting.

        Seed AppView: 5 Ring 1 (positive) + 3 Ring 2 (negative).
        Query about the product.  Verified (Ring 2) reviewers must be
        weighted higher: "Verified reviewers caution against it" — ring
        level visibly affects recommendation even though Ring 1 has
        more positive reviews.

        Requirement: E2E_TEST_PLAN §22.5.
        """
        product_did = "at://did:plc:maker/com.dina.trust.product/quickblend-pro"

        # ------------------------------------------------------------------
        # Step 1: Seed AppView with mixed-ring data.
        # 5 Ring 1 (unverified) positive reviews.
        # 3 Ring 2 (verified) negative reviews.
        # ------------------------------------------------------------------
        reviews = []

        # 5 Ring 1 positive reviews — unverified, anonymous sources.
        for i in range(5):
            reviews.append({
                "reviewer_did": f"did:plc:anon-reviewer-{i:03d}",
                "reviewer_name": f"Anonymous_{i+1}",
                "ring": 1,
                "sentiment": "positive",
                "text": (
                    f"QuickBlend Pro review #{i+1}: "
                    f"{'Great blender, works perfectly!' if i % 2 == 0 else ''}"
                    f"{'Love it, highly recommend!' if i % 2 == 1 else ''}"
                ),
                "source_url": f"https://reviews.example.com/quickblend/{i+1}",
                "created_at": f"2026-02-{10 + i:02d}T10:00:00Z",
            })

        # 3 Ring 2 negative reviews — verified, trusted sources.
        for i in range(3):
            reviews.append({
                "reviewer_did": f"did:plc:verified-reviewer-{i:03d}",
                "reviewer_name": f"VerifiedExpert_{i+1}",
                "ring": 2,
                "sentiment": "negative",
                "text": (
                    f"QuickBlend Pro critical review #{i+1}: "
                    f"{'Motor overheats after 2 minutes of use.' if i == 0 else ''}"
                    f"{'Blade assembly cracked within a month.' if i == 1 else ''}"
                    f"{'Safety lock malfunctions — potential burn risk.' if i == 2 else ''}"
                ),
                "source_url": f"https://reviews.example.com/quickblend/expert-{i+1}",
                "created_at": f"2026-02-{15 + i:02d}T10:00:00Z",
            })

        appview.seed_attestations(product_did, reviews)

        # ------------------------------------------------------------------
        # Step 2: Store reviews in Don Alonso's vault with ring metadata.
        # Uses real Go Core POST /v1/vault/store.
        # ------------------------------------------------------------------

        # Store a summary highlighting the ring distribution.
        don_alonso.vault_store(
            "consumer",
            "quickblend_trust_summary",
            {
                "product": "QuickBlend Pro",
                "total_reviews": 8,
                "ring_1_count": 5,
                "ring_1_positive": 5,
                "ring_1_negative": 0,
                "ring_2_count": 3,
                "ring_2_positive": 0,
                "ring_2_negative": 3,
                "ring_distribution": "5 unverified positive, 3 verified negative",
            },
            item_type="trust_summary",
            source="trust_network",
        )

        # Store Ring 1 (unverified) positive reviews.
        for i in range(5):
            don_alonso.vault_store(
                "consumer",
                f"quickblend_ring1_review_{i:03d}",
                {
                    "product": "QuickBlend Pro",
                    "reviewer": f"Anonymous_{i+1}",
                    "reviewer_did": f"did:plc:anon-reviewer-{i:03d}",
                    "ring": 1,
                    "ring_label": "unverified",
                    "sentiment": "positive",
                    "text": reviews[i]["text"],
                    "source_url": reviews[i]["source_url"],
                },
                item_type="trust_attestation",
                source="trust_network",
            )

        # Store Ring 2 (verified) negative reviews.
        for i in range(3):
            don_alonso.vault_store(
                "consumer",
                f"quickblend_ring2_review_{i:03d}",
                {
                    "product": "QuickBlend Pro",
                    "reviewer": f"VerifiedExpert_{i+1}",
                    "reviewer_did": f"did:plc:verified-reviewer-{i:03d}",
                    "ring": 2,
                    "ring_label": "verified",
                    "sentiment": "negative",
                    "text": reviews[5 + i]["text"],
                    "source_url": reviews[5 + i]["source_url"],
                },
                item_type="trust_attestation",
                source="trust_network",
            )

        # ------------------------------------------------------------------
        # Step 3: Verify vault contains the trust data.
        # Uses real Go Core POST /v1/vault/query.
        # ------------------------------------------------------------------
        results = don_alonso.vault_query(
            "consumer", "QuickBlend Pro", mode="fts5",
        )
        assert len(results) >= 4, (
            f"Vault must contain QuickBlend Pro trust attestations. "
            f"Got {len(results)} results."
        )

        # ------------------------------------------------------------------
        # Step 4: Query Brain for product recommendation.
        # ------------------------------------------------------------------
        result = don_alonso._brain_process(
            "reason",
            {
                "prompt": "Should I buy the QuickBlend Pro?",
                "body": "Should I buy the QuickBlend Pro?",
                "persona_id": "consumer",
            },
        )

        content = result.get("content", "") or result.get("text", "")
        content_lower = content.lower()

        # ------------------------------------------------------------------
        # Step 5: Verify Ring 2 (verified) reviewers weighted higher.
        # Despite 5 positive Ring 1 reviews, the 3 negative Ring 2
        # reviews must dominate the recommendation.
        # Law 2: Verified Truth — trust rings visibly affect ranking.
        # ------------------------------------------------------------------
        ring2_weighted = re.compile(
            r"verif.{0,20}(caution|concern|warn|negative|against|issue)|"
            r"trusted.{0,20}(caution|concern|warn|negative|against|issue)|"
            r"(caution|concern|warn|issue).{0,20}verif|"
            r"(caution|concern|warn|issue).{0,20}trusted|"
            r"ring 2.{0,20}(negative|caution|concern)|"
            r"higher.{0,5}trust.{0,20}(negative|caution)|"
            r"weight.{0,10}(verif|trusted)|"
            r"prioriti.{0,10}(verif|trusted)",
            re.IGNORECASE,
        )
        assert ring2_weighted.search(content), (
            f"Verified (Ring 2) reviewers must be weighted higher. "
            f"3 verified negative reviews outweigh 5 unverified "
            f"positive reviews. Expected: 'Verified reviewers caution "
            f"against it'. Law 2: ring level visibly affects "
            f"recommendation. Got: {content!r}"
        )

        # ------------------------------------------------------------------
        # Step 6: Verify the recommendation leans negative (toward
        # Ring 2 consensus).  Brain must NOT recommend buying based
        # solely on Ring 1 majority.
        # ------------------------------------------------------------------
        positive_recommendation = re.compile(
            r"recommend.{0,10}(buy|purchas)|"
            r"go ahead.{0,10}(buy|purchas)|"
            r"(great|excellent|good)\s+(buy|choice|deal)|"
            r"definite.{0,10}(buy|worth|recommend)",
            re.IGNORECASE,
        )
        assert not positive_recommendation.search(content), (
            f"Brain must NOT recommend buying when verified reviewers "
            f"are negative — even if unverified reviewers are positive. "
            f"Ring 2 outweighs Ring 1. Got: {content!r}"
        )

        # ------------------------------------------------------------------
        # Step 7: Verify both ring levels are mentioned.
        # The ring difference must be VISIBLE in the narrative.
        # ------------------------------------------------------------------
        ring_visibility = re.compile(
            r"unverif|ring 1|anonymous|"
            r"verif|ring 2|trusted|authenticated",
            re.IGNORECASE,
        )
        assert ring_visibility.search(content), (
            f"Response must make ring levels visible — distinguish "
            f"unverified (Ring 1) from verified (Ring 2) reviewers. "
            f"Got: {content!r}"
        )

        # ------------------------------------------------------------------
        # Step 8: Verify Ring 1 reviews are not suppressed.
        # Unverified reviews are still reported — but deprioritised.
        # ------------------------------------------------------------------
        ring1_mentioned = re.compile(
            r"unverif|anonymous|ring 1|"
            r"(some|5|five).{0,20}positive|"
            r"positive.{0,20}(unverif|anonymous)",
            re.IGNORECASE,
        )
        assert ring1_mentioned.search(content), (
            f"Ring 1 (unverified) positive reviews must be mentioned — "
            f"deprioritised, not suppressed. Law 2: all data visible, "
            f"weighted by trust level. Got: {content!r}"
        )

        # ------------------------------------------------------------------
        # Step 9: Verify safety concerns from Ring 2 are highlighted.
        # Ring 2 reviews mention safety issues — these must be prominent.
        # ------------------------------------------------------------------
        safety_concerns = re.compile(
            r"overheat|crack|safety|burn|malfunction|"
            r"risk|danger|defect|failure",
            re.IGNORECASE,
        )
        assert safety_concerns.search(content), (
            f"Ring 2 reviews mention safety issues (overheating, "
            f"cracking, burn risk). These must be highlighted in "
            f"the response. Got: {content!r}"
        )

        # ------------------------------------------------------------------
        # Step 10: Verify deep links to expert reviewers.
        # Pull Economy: creators get traffic.
        # ------------------------------------------------------------------
        expert_attribution = re.compile(
            r"VerifiedExpert|expert|source|link|"
            r"reviews\.example\.com",
            re.IGNORECASE,
        )
        assert expert_attribution.search(content), (
            f"Verified expert reviewers must be attributed with "
            f"source links. Pull Economy: creators get traffic. "
            f"Got: {content!r}"
        )

        # ------------------------------------------------------------------
        # Step 11: Verify audit trail for the trust query.
        # ------------------------------------------------------------------
        audit_entries = don_alonso.get_audit_entries("vault_query")
        assert len(audit_entries) >= 1, (
            f"Trust query with ring weighting must be audited. "
            f"Got {len(audit_entries)} audit entries."
        )
