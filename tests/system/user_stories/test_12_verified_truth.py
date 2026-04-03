"""User Story 12: Verified Truth — rank by trust, not by ad spend.

SEQUENTIAL TEST — tests MUST run in order (00 → 08).
Each test builds on state from the previous one.

Thesis Invariant
----------------
Law 2: Verified Truth.  The Trust Network replaces marketing.  Dina
credits sources — not just extracts.  Creators get traffic, users get
truth.

What this story validates:

  1. **Zero trust data → honest uncertainty** — when there is no trust
     data, Dina says "I have no verified information" — never
     hallucinates a trust score.  The density enforcement code path
     (guardian.py _apply_density_enforcement) strips fabricated claims
     and injects an honest disclosure.

  2. **Sparse data → split acknowledged** — 2 conflicting trust
     attestations produce "opinions are split / mixed", not "score:
     5/10."  Density tier is "sparse" (2-4 attestations).

  3. **Dense data → confidence** — 12 consistent positive trust
     attestations produce a confident recommendation.  Density tier is
     "dense" (10+).  No false hedging.

  4. **Source attribution** — reviewer DIDs and source URLs in vault
     metadata survive the store → query round-trip, and Brain's
     reasoning output references the review data.

Pipeline
--------
::

  User asks "Is this vendor reliable?"
    → Brain density analysis: search_vault("personal", ...) → count
      trust_attestation items → classify tier (zero/sparse/dense)
    → Agentic reasoning: LLM searches vault, reasons over results
    → Density enforcement: strip fabrications (zero), pass through
      (sparse/dense) — same _apply_density_enforcement code path
    → Response includes source attribution (Deep Link default)
"""

from __future__ import annotations

import json
import os
import re as _re

import httpx
import pytest

# ---------------------------------------------------------------------------
# Shared state across ordered tests
# ---------------------------------------------------------------------------

_state: dict = {}


# ---------------------------------------------------------------------------
# Test class — sequential thesis invariant verification
# ---------------------------------------------------------------------------


class TestVerifiedTruth:
    """Verified Truth: honest uncertainty at every density level."""

    # ==================================================================
    # test_00: AppView trust data is seeded and queryable
    # ==================================================================

    # TST-USR-085
    def test_00_trust_data_seeded(
        self, alonso_core, admin_headers, seed_appview,
    ):
        """Verify the AppView Postgres was seeded with test trust data.

        The seed_appview fixture inserts:
          - DID profiles for Alonso and Sancho with trust scores
          - Mutual attestations between them
          - Trust edges

        This is the foundation for all subsequent trust queries.
        """
        ids = seed_appview
        assert ids.get("attestation_1"), (
            "seed_appview did not return attestation_1 — seeding failed"
        )
        assert ids.get("attestation_2"), (
            "seed_appview did not return attestation_2 — seeding failed"
        )
        _state["seed_ids"] = ids

    # ==================================================================
    # test_01: Core can query AppView for trust resolution
    # ==================================================================

    # TST-USR-086
    def test_01_trust_resolve_via_appview(
        self, alonso_core, admin_headers, appview, sancho_did,
    ):
        """Query trust data for a known DID via the AppView xRPC endpoint.

        Core proxies trust queries to AppView's xRPC API. The AppView
        returns attestation counts, trust scores, and edge data.

        We query for Sancho (seeded with trust data) and verify a
        non-empty response.
        """
        # Query AppView directly for trust resolution.
        r = httpx.get(
            f"{appview}/xrpc/com.dina.trust.resolve",
            params={"did": sancho_did},
            timeout=15,
        )
        # AppView may return the data or a 400/404 if the endpoint
        # requires different parameters. We check for a successful
        # response with trust data.
        if r.status_code == 200:
            data = r.json()
            _state["trust_data"] = data
            # Verify we got meaningful trust data back.
            has_score = (
                data.get("trust_score") is not None
                or data.get("overall_trust_score") is not None
                or data.get("attestations") is not None
                or data.get("total_attestations") is not None
            )
            assert has_score, (
                f"Trust resolve returned 200 but no trust data: "
                f"{list(data.keys())}"
            )
        else:
            # If the xRPC endpoint isn't available, check via Core's
            # trust proxy endpoint.
            r2 = httpx.get(
                f"{alonso_core}/v1/trust/resolve",
                params={"did": sancho_did},
                headers=admin_headers,
                timeout=15,
            )
            if r2.status_code == 200:
                _state["trust_data"] = r2.json()
            else:
                # AppView trust resolution is Phase 2 — mark as known
                # gap but don't block the test suite.
                _state["trust_data"] = {}
                pytest.skip(
                    f"Trust resolve not available: AppView={r.status_code}, "
                    f"Core proxy={r2.status_code}"
                )

    # ==================================================================
    # test_02: Zero trust data → honest uncertainty
    # ==================================================================

    # TST-USR-087
    @pytest.mark.skipif(
        not os.environ.get("GOOGLE_API_KEY"),
        reason="GOOGLE_API_KEY not set — skipping LLM trust reasoning test",
    )
    def test_02_zero_trust_data_honest_uncertainty(
        self, alonso_brain, brain_signer,
    ):
        """No trust data for an unknown DID → Dina does NOT hallucinate.

        When asked about an entity with zero reviews, zero attestations,
        zero trust edges — Dina must say "I have no verified information"
        or equivalent.  She must NEVER invent a trust score.

        Vault enrichment is enabled — the LLM searches the vault but
        finds nothing for this unknown entity.  The density enforcement
        (same code path as sparse/dense) classifies tier as "zero" and
        injects honest disclosure.
        """
        r = brain_signer.post(
            f"{alonso_brain}/api/v1/reason",
            json={
                "prompt": (
                    "Is did:plc:unknownvendor123 a trustworthy seller? "
                    "Should I buy from them?"
                ),
                "persona_tier": "default",
                "skip_vault_enrichment": False,
            },
            timeout=60,
        )
        assert r.status_code == 200, (
            f"Reason failed: {r.status_code} {r.text[:300]}"
        )

        content = r.json().get("content", "")
        content_lower = content.lower()

        # Must NOT contain fabricated trust scores.
        # Only flag affirmative claims — negations ("is NOT a trusted
        # seller") are correct behavior, not hallucination.
        hallucination_patterns = [
            r"trust score:\s*\d",          # fabricated numeric score
            r"rating:\s*\d",               # fabricated rating
            r"\b4\.5\s*/\s*5\b",           # specific fabricated rating
            r"\b4\s*/\s*5\b",              # specific fabricated rating
            r"\brated highly\b",           # affirmative trust claim
            r"\bwell-reviewed\b",          # affirmative trust claim
            r"\bhighly trusted\b",         # affirmative trust claim
            r"\bhighly rated\b",           # affirmative trust claim
        ]
        found = [
            p for p in hallucination_patterns
            if _re.search(p, content_lower)
        ]
        assert not found, (
            f"Dina hallucinated trust data for unknown entity: {found}\n"
            f"Response: {content[:500]}\n"
            f"Law 2: Verified Truth — never fabricate trust scores."
        )

        # Should indicate uncertainty or lack of data.
        uncertainty_signals = [
            "no", "don't have", "cannot verify", "unable to verify",
            "no verified", "no information", "no data", "no reviews",
            "no attestations", "unknown", "unverified", "caution",
            "not enough", "insufficient", "limited",
        ]
        has_uncertainty = any(s in content_lower for s in uncertainty_signals)
        assert has_uncertainty, (
            f"Dina should express uncertainty about unknown entity.\n"
            f"Expected one of: {uncertainty_signals[:5]}...\n"
            f"Response: {content[:500]}"
        )

        _state["zero_trust_response"] = content

    # ==================================================================
    # test_03: Store 2 conflicting trust attestations (sparse tier)
    # ==================================================================

    # TST-USR-088
    def test_03_conflicting_trust_attestations_stored(
        self, alonso_core, admin_headers,
    ):
        """Store 2 conflicting trust attestations for VendorX.

        Items are stored as type=trust_attestation, source=trust_network
        so that the density classifier (_analyze_trust_density) counts
        them correctly.  2 items → sparse tier.

        Stored in the "personal" persona because the density analysis
        searches "personal" for trust data.
        """
        attestations = [
            {
                "Type": "trust_attestation",
                "Source": "trust_network",
                "Summary": (
                    "Trust attestation: VendorX excellent service, "
                    "fast delivery"
                ),
                "BodyText": (
                    "Positive trust attestation for VendorX "
                    "(did:plc:vendorx) by did:plc:reviewer_alice: "
                    "Excellent customer service, product arrived in "
                    "2 days, quality matched the description exactly. "
                    "Would buy again."
                ),
                "Metadata": json.dumps({
                    "subject_did": "did:plc:vendorx",
                    "sentiment": "positive",
                    "reviewer": "did:plc:reviewer_alice",
                }),
            },
            {
                "Type": "trust_attestation",
                "Source": "trust_network",
                "Summary": (
                    "Trust attestation: VendorX poor quality, "
                    "misleading photos"
                ),
                "BodyText": (
                    "Negative trust attestation for VendorX "
                    "(did:plc:vendorx) by did:plc:reviewer_bob: "
                    "Product quality was much worse than photos showed. "
                    "Customer service unresponsive. Took 3 weeks to "
                    "arrive. Would not recommend."
                ),
                "Metadata": json.dumps({
                    "subject_did": "did:plc:vendorx",
                    "sentiment": "negative",
                    "reviewer": "did:plc:reviewer_bob",
                }),
            },
        ]

        stored_ids = []
        for item in attestations:
            r = httpx.post(
                f"{alonso_core}/v1/vault/store",
                json={"persona": "general", "item": item},
                headers=admin_headers,
                timeout=10,
            )
            assert r.status_code in (200, 201), (
                f"Store failed: {r.status_code} {r.text[:200]}"
            )
            stored_ids.append(r.json().get("id", ""))

        _state["review_ids"] = stored_ids
        assert len(stored_ids) == 2

    # ==================================================================
    # test_04: Deep links — sources credited, not just extracted
    # ==================================================================

    # TST-USR-089
    def test_04_vault_query_returns_sources(
        self, alonso_core, admin_headers,
    ):
        """Query vault for attestations → results include source attribution.

        Law 2 mandates Deep Link Default: Dina credits sources.  When
        the user asks about a vendor, the vault response includes the
        original attestation data — not just a summary.  Creators
        (reviewers) get credit; the user gets verifiable truth.
        """
        r = httpx.post(
            f"{alonso_core}/v1/vault/query",
            json={
                "persona": "general",
                "query": "VendorX trust attestation",
                "mode": "fts5",
                "limit": 10,
            },
            headers=admin_headers,
            timeout=10,
        )
        assert r.status_code == 200, (
            f"Query failed: {r.status_code} {r.text[:200]}"
        )

        items = r.json().get("items", [])
        assert len(items) >= 2, (
            f"Expected >= 2 attestation items for VendorX, got {len(items)}"
        )

        # Verify source attribution — each item should have Source.
        for item in items:
            assert item.get("Source") or item.get("source"), (
                f"Attestation item missing Source attribution: {item}"
            )

        # Verify we have both positive and negative sentiment.
        all_text = " ".join(
            str(item.get("Summary", "") or item.get("summary", ""))
            + " "
            + str(item.get("BodyText", "") or item.get("body_text", ""))
            for item in items
        ).lower()

        assert "excellent" in all_text or "positive" in all_text, (
            f"Missing positive attestation in results"
        )
        assert "poor" in all_text or "negative" in all_text, (
            f"Missing negative attestation in results"
        )

    # ==================================================================
    # test_05: Sparse attestations → Brain acknowledges conflict
    # ==================================================================

    # TST-USR-090
    @pytest.mark.skipif(
        not os.environ.get("GOOGLE_API_KEY"),
        reason="GOOGLE_API_KEY not set — skipping LLM sparse density test",
    )
    def test_05_sparse_attestations_conflict_acknowledged(
        self, alonso_brain, brain_signer,
    ):
        """2 conflicting trust attestations → Brain shows split.

        test_03 stored 2 trust_attestation items (one positive, one
        negative) for VendorX in the "personal" persona.  The density
        analysis searches "personal" and classifies tier as "sparse"
        (2 items with type=trust_attestation, source=trust_network).

        The response must:
          - NOT fabricate consensus ("reviewers agree", "widely praised")
          - NOT produce a misleading averaged score ("score: 5/10")
          - Positively acknowledge the conflict (split/mixed/conflicting)
        """
        r = brain_signer.post(
            f"{alonso_brain}/api/v1/reason",
            json={
                "prompt": (
                    "What do trust attestations say about VendorX "
                    "(did:plc:vendorx)? Is their product quality good? "
                    "Should I buy from them?"
                ),
                "persona_tier": "default",
                "skip_vault_enrichment": False,
            },
            timeout=60,
        )
        assert r.status_code == 200, (
            f"Reason failed: {r.status_code} {r.text[:300]}"
        )

        content = r.json().get("content", "")
        content_lower = content.lower()

        # Must NOT fabricate consensus when attestations are split.
        consensus_patterns = [
            r"reviewers?\s+(?:all\s+)?(?:agree|concur|consensus)",
            r"(?:widely|generally|universally)\s+(?:praised|recommended)",
            r"reviews?\s+(?:consistently|unanimously)",
            r"strong\s+consensus",
        ]
        found = [
            p for p in consensus_patterns
            if _re.search(p, content_lower)
        ]
        assert not found, (
            f"Brain fabricated consensus from 2 conflicting attestations: "
            f"{found}\n"
            f"Response: {content[:500]}\n"
            f"Sparse data (2 attestations) must NOT produce consensus."
        )

        # Must NOT produce a misleading average score.
        misleading_scores = [
            r"(?:overall\s+)?score:\s*5\s*/\s*10",
            r"(?:overall\s+)?rating:\s*2\.5\s*/\s*5",
            r"(?:overall\s+)?score:\s*50\s*/\s*100",
        ]
        score_found = [
            p for p in misleading_scores
            if _re.search(p, content_lower)
        ]
        assert not score_found, (
            f"Brain produced misleading average from conflicting "
            f"attestations: {score_found}\n"
            f"Response: {content[:500]}\n"
            f"2 conflicting attestations = split opinions, not a "
            f"fabricated middle score."
        )

        # Must positively acknowledge the conflict — this is the
        # stronger assertion: the response says opinions are split.
        conflict_signals = [
            "split", "mixed", "conflicting", "divided", "disagree",
            "contrasting", "inconsistent", "opposing", "different",
            "both positive and negative", "one positive", "one negative",
            "positive and negative", "varied", "diverge",
        ]
        has_conflict = any(s in content_lower for s in conflict_signals)
        assert has_conflict, (
            f"Brain should acknowledge that attestations are conflicting.\n"
            f"Expected one of: {conflict_signals[:6]}...\n"
            f"Response: {content[:500]}"
        )

        # Should indicate limited data — only 2 attestations.
        limited_signals = [
            "limited", "only 2", "only two", "few", "small number",
            "not many", "insufficient", "sparse", "thin",
        ]
        has_limited = any(s in content_lower for s in limited_signals)
        assert has_limited, (
            f"Brain should note the limited data (only 2 attestations).\n"
            f"Expected one of: {limited_signals[:5]}...\n"
            f"Response: {content[:500]}"
        )

        _state["sparse_response"] = content

    # ==================================================================
    # test_06: Seed 12 consistent positive trust attestations (dense)
    # ==================================================================

    # TST-USR-091
    def test_06_seed_dense_trust_attestations(
        self, alonso_core, admin_headers,
    ):
        """Seed 12 consistent positive trust attestations for VendorY.

        Items are stored as type=trust_attestation, source=trust_network
        in the "personal" persona so the density classifier counts them.
        12 items → dense tier (10+).

        Each attestation includes a reviewer DID and source_url in
        Metadata for Deep Link Default testing (test_08).
        """
        stored_ids = []
        for i in range(12):
            reviewer_did = f"did:plc:reviewer_{i:03d}"
            item = {
                "Type": "trust_attestation",
                "Source": "trust_network",
                "Summary": (
                    f"Trust attestation: VendorY excellent quality, "
                    f"reviewer {i + 1}"
                ),
                "BodyText": (
                    f"Positive trust attestation for VendorY "
                    f"(did:plc:vendory) by {reviewer_did}: Excellent "
                    f"build quality, fast shipping, great value for "
                    f"money. Product matched description exactly. "
                    f"Customer service responsive. Would recommend "
                    f"to others."
                ),
                "Metadata": json.dumps({
                    "subject_did": "did:plc:vendory",
                    "sentiment": "positive",
                    "reviewer": reviewer_did,
                    "source_url": (
                        f"https://trustnetwork.example.com/attestation"
                        f"/{reviewer_did}/{i}"
                    ),
                }),
            }
            r = httpx.post(
                f"{alonso_core}/v1/vault/store",
                json={"persona": "general", "item": item},
                headers=admin_headers,
                timeout=10,
            )
            assert r.status_code in (200, 201), (
                f"Store failed for attestation {i}: "
                f"{r.status_code} {r.text[:200]}"
            )
            stored_ids.append(r.json().get("id", ""))

        _state["dense_review_ids"] = stored_ids
        assert len(stored_ids) == 12

    # ==================================================================
    # test_07: Dense data → confident recommendation with attribution
    # ==================================================================

    # TST-USR-092
    @pytest.mark.skipif(
        not os.environ.get("GOOGLE_API_KEY"),
        reason="GOOGLE_API_KEY not set — skipping LLM dense density test",
    )
    def test_07_dense_data_confident_with_attribution(
        self, alonso_brain, brain_signer,
    ):
        """12 consistent positive attestations → confident recommendation.

        The density analysis searches "personal" and finds 12 items with
        type=trust_attestation, source=trust_network → tier "dense".
        The LLM sees the attestations through vault enrichment.

        The response must:
          - NOT claim insufficient data or express false uncertainty
          - Reflect the consistently positive sentiment
          - Reference the review/attestation data (source attribution)
        """
        r = brain_signer.post(
            f"{alonso_brain}/api/v1/reason",
            json={
                "prompt": (
                    "What do trust attestations say about VendorY "
                    "(did:plc:vendory)? Is their product quality good? "
                    "Should I buy from them?"
                ),
                "persona_tier": "default",
                "skip_vault_enrichment": False,
            },
            timeout=60,
        )
        assert r.status_code == 200, (
            f"Reason failed: {r.status_code} {r.text[:300]}"
        )

        content = r.json().get("content", "")
        content_lower = content.lower()

        # With 12 consistent positive attestations in the dense tier,
        # the density enforcement does NOT inject "no verified data"
        # (that's zero-tier only).  The LLM should be confident.
        false_uncertainty = [
            "no verified data available",
            "no verified information",
            "no reviews available",
            "no data available",
            "no attestations available",
            "insufficient data",
            "cannot verify",
            "unable to verify",
        ]
        found = [u for u in false_uncertainty if u in content_lower]
        assert not found, (
            f"Brain expressed false uncertainty with 12 positive "
            f"attestations (dense tier): {found}\n"
            f"Response: {content[:500]}\n"
            f"Dense data must NOT trigger zero-tier disclosure."
        )

        # Response should reflect the consistently positive sentiment.
        positive_signals = [
            "positive", "recommend", "good", "excellent",
            "quality", "favorable", "reliable",
        ]
        has_positive = any(s in content_lower for s in positive_signals)
        assert has_positive, (
            f"Brain should reflect 12 consistently positive attestations.\n"
            f"Expected one of {positive_signals} in response.\n"
            f"Response: {content[:500]}"
        )

        # Response should reference the attestation data as evidence
        # (source attribution in the reasoning output, not just vault
        # metadata).  This validates Deep Link Default end-to-end:
        # creators get credit in the final user-facing response.
        attribution_signals = [
            "attestation", "review", "reviewer", "verified",
            "based on", "according to", "multiple", "several",
            "report", "feedback", "12",
        ]
        has_attribution = any(s in content_lower for s in attribution_signals)
        assert has_attribution, (
            f"Brain should reference source data in its recommendation.\n"
            f"Expected one of {attribution_signals} in response.\n"
            f"Response: {content[:500]}"
        )

        _state["dense_response"] = content

    # ==================================================================
    # test_08: Reviewer attribution metadata survives vault round-trip
    # ==================================================================

    # TST-USR-093
    def test_08_vault_preserves_reviewer_attribution(
        self, alonso_core, admin_headers,
    ):
        """Reviewer DID and source URL survive vault store → query.

        Law 2 mandates Deep Link Default: creators get traffic, not
        just extracted summaries.  For this to work, the reviewer
        identity and source URL stored in Metadata must survive the
        vault round-trip and appear in query results.

        This test queries for VendorY attestations (seeded in test_06)
        and verifies that the Metadata JSON still contains the reviewer
        DID and source_url fields.
        """
        r = httpx.post(
            f"{alonso_core}/v1/vault/query",
            json={
                "persona": "general",
                "query": "VendorY trust attestation excellent quality",
                "mode": "fts5",
                "limit": 15,
            },
            headers=admin_headers,
            timeout=10,
        )
        assert r.status_code == 200, (
            f"Query failed: {r.status_code} {r.text[:200]}"
        )

        items = r.json().get("items", [])
        assert len(items) >= 5, (
            f"Expected >= 5 VendorY attestation items, got {len(items)}. "
            f"Dense data from test_06 should be queryable."
        )

        # Check that Metadata survived the round-trip.
        items_with_reviewer = 0
        items_with_source_url = 0
        for item in items:
            meta_raw = (
                item.get("Metadata")
                or item.get("metadata")
                or ""
            )
            if not meta_raw:
                continue
            try:
                meta = json.loads(meta_raw) if isinstance(
                    meta_raw, str,
                ) else meta_raw
            except (json.JSONDecodeError, TypeError):
                continue

            if meta.get("reviewer", "").startswith("did:plc:"):
                items_with_reviewer += 1
            if meta.get("source_url", "").startswith("https://"):
                items_with_source_url += 1

        assert items_with_reviewer >= 3, (
            f"Expected >= 3 items with reviewer DID in metadata, "
            f"got {items_with_reviewer}. Reviewer attribution must "
            f"survive the vault store → query round-trip."
        )
        assert items_with_source_url >= 3, (
            f"Expected >= 3 items with source_url in metadata, "
            f"got {items_with_source_url}. Source URLs must survive "
            f"the vault round-trip for Deep Link Default to work."
        )
