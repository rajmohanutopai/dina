"""User Story 03: The Dead Internet Filter — identity-first verification.

SEQUENTIAL TEST — tests MUST run in order (00 → 07).
Each test builds on state from the previous one.

Story
-----
Alonso asks: "Is this video real?"

Dina does NOT run a forensic bot first. She looks up the creator's
identity in the Trust Network:

  **Elena Vasquez (did:plc:elena) — Ring 3 (Verified + Actioned):**
    200 verified videos over 2 years, 197/200 positive attestations,
    vouched by 15 peers, corroboration rate 94%, evidence rate 88%.
    → "Authentic. Elena has a strong track record."

  **TruthSeeker2026 (did:plc:botfarm) — Ring 1 (Unverified):**
    3-day-old account, 14 videos in 48 hours, zero trust history,
    no vouches, no endorsements.
    → "Unverified. No identity history. Want me to check forensic bots?"

The forensic bot is the fallback, not the primary check.

Why Dina is unique
------------------
No other system can do this because it requires three things
simultaneously:
  1. Persistent creator identity (DID)
  2. Accumulated trust history (Trust Network)
  3. Decentralized verification (AT Protocol)

YouTube has no cryptographic identities. Perplexity has no trust
history. Twitter checkmarks are pay-to-play. Dina proves identity
first, runs forensics second.

Pipeline
--------
::

  AppView (Postgres)
    → did_profiles, trust_edges, attestations
    → XRPC com.dina.trust.getProfile
                    ↓
  Core (Go)
    → GET /v1/trust/resolve?did={did}
    → Fetches full profile from AppView
    → Returns raw JSON to Brain
                    ↓
  Brain (Python)
    → Includes trust profile in LLM prompt
    → LLM reasons about authenticity using identity signals
"""

from __future__ import annotations

import json
import os
import time
import uuid
from datetime import datetime, timezone, timedelta

import httpx
import pytest

# LLM tests (05-07) are inherently non-deterministic.  Retry once on
# keyword-match failure — the second attempt usually uses a different
# random seed and produces different phrasing.
_MAX_LLM_ATTEMPTS = 2

# ---------------------------------------------------------------------------
# Shared state across ordered tests
# ---------------------------------------------------------------------------

_state: dict = {}


# ---------------------------------------------------------------------------
# Test class — sequential user journey
# ---------------------------------------------------------------------------


class TestDeadInternetFilter:
    """The Dead Internet Filter: identity-first content verification."""

    # -----------------------------------------------------------------
    # 00 — Seed AppView with creator profiles
    # -----------------------------------------------------------------

    # TST-USR-021
    def test_00_seed_creator_profiles(self, system_services):
        """Seed AppView Postgres with two creator profiles.

        Elena Vasquez (did:plc:elena) — trusted creator, Ring 3:
          - 2-year account, 200 attestations (197 positive),
            15 vouches, 8 endorsements, high corroboration + evidence rate

        TruthSeeker2026 (did:plc:botfarm) — untrusted, Ring 1:
          - 3-day-old account, 0 attestations about, 14 by,
            0 vouches, 0 endorsements, no trust history
        """
        try:
            import psycopg2
        except ImportError:
            pytest.skip("psycopg2 not installed")

        dsn = system_services.postgres_dsn
        now = datetime.now(timezone.utc)
        two_years_ago = now - timedelta(days=730)
        three_days_ago = now - timedelta(days=3)

        conn = psycopg2.connect(dsn)
        conn.autocommit = True
        cur = conn.cursor()

        # --- Elena Vasquez (trusted creator, Ring 3) ---
        subj_elena = f"subj_elena_{uuid.uuid4().hex[:8]}"
        cur.execute(
            """INSERT INTO subjects (id, name, subject_type, did, identifiers_json, needs_recalc, created_at, updated_at)
               VALUES (%s, %s, 'did', %s, '[]'::jsonb, false, %s, %s)
               ON CONFLICT (id) DO NOTHING""",
            (subj_elena, "Elena Vasquez", "did:plc:elena", now, now),
        )

        cur.execute(
            """INSERT INTO did_profiles (
                   did, needs_recalc,
                   total_attestations_about, positive_about, neutral_about, negative_about,
                   vouch_count, high_confidence_vouches, endorsement_count,
                   total_attestations_by,
                   corroboration_rate, evidence_rate, average_helpful_ratio,
                   active_domains, account_first_seen, last_active,
                   overall_trust_score, computed_at
               ) VALUES (%s, false, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT (did) DO UPDATE SET
                   total_attestations_about = EXCLUDED.total_attestations_about,
                   positive_about = EXCLUDED.positive_about,
                   neutral_about = EXCLUDED.neutral_about,
                   negative_about = EXCLUDED.negative_about,
                   vouch_count = EXCLUDED.vouch_count,
                   high_confidence_vouches = EXCLUDED.high_confidence_vouches,
                   endorsement_count = EXCLUDED.endorsement_count,
                   total_attestations_by = EXCLUDED.total_attestations_by,
                   corroboration_rate = EXCLUDED.corroboration_rate,
                   evidence_rate = EXCLUDED.evidence_rate,
                   average_helpful_ratio = EXCLUDED.average_helpful_ratio,
                   active_domains = EXCLUDED.active_domains,
                   account_first_seen = EXCLUDED.account_first_seen,
                   last_active = EXCLUDED.last_active,
                   overall_trust_score = EXCLUDED.overall_trust_score,
                   computed_at = EXCLUDED.computed_at""",
            (
                "did:plc:elena",
                200, 197, 2, 1,      # attestations about
                15, 10, 8,           # vouches + endorsements
                200,                 # attestations by
                0.94, 0.88, 0.91,   # rates
                ["technology", "science"],  # active domains
                two_years_ago, now,  # account age
                0.95,               # overall trust score
                now,                # computed_at
            ),
        )

        # Trust edges: 3 vouches from verified peers to Elena
        for i in range(3):
            peer_did = f"did:plc:peer{i}"
            edge_id = f"edge_elena_{uuid.uuid4().hex[:8]}"
            vouch_uri = f"at://{peer_did}/com.dina.trust.attestation/{uuid.uuid4().hex[:12]}"
            cur.execute(
                """INSERT INTO trust_edges (id, from_did, to_did, edge_type, weight, source_uri, created_at)
                   VALUES (%s, %s, %s, 'vouch', 1.0, %s, %s)
                   ON CONFLICT DO NOTHING""",
                (edge_id, peer_did, "did:plc:elena", vouch_uri, now),
            )

        # --- TruthSeeker2026 (untrusted, Ring 1) ---
        subj_botfarm = f"subj_botfarm_{uuid.uuid4().hex[:8]}"
        cur.execute(
            """INSERT INTO subjects (id, name, subject_type, did, identifiers_json, needs_recalc, created_at, updated_at)
               VALUES (%s, %s, 'did', %s, '[]'::jsonb, false, %s, %s)
               ON CONFLICT (id) DO NOTHING""",
            (subj_botfarm, "TruthSeeker2026", "did:plc:botfarm", now, now),
        )

        cur.execute(
            """INSERT INTO did_profiles (
                   did, needs_recalc,
                   total_attestations_about, positive_about, neutral_about, negative_about,
                   vouch_count, high_confidence_vouches, endorsement_count,
                   total_attestations_by,
                   corroboration_rate, evidence_rate, average_helpful_ratio,
                   account_first_seen, last_active,
                   overall_trust_score, computed_at
               ) VALUES (%s, false, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT (did) DO UPDATE SET
                   total_attestations_about = EXCLUDED.total_attestations_about,
                   positive_about = EXCLUDED.positive_about,
                   neutral_about = EXCLUDED.neutral_about,
                   negative_about = EXCLUDED.negative_about,
                   vouch_count = EXCLUDED.vouch_count,
                   high_confidence_vouches = EXCLUDED.high_confidence_vouches,
                   endorsement_count = EXCLUDED.endorsement_count,
                   total_attestations_by = EXCLUDED.total_attestations_by,
                   corroboration_rate = EXCLUDED.corroboration_rate,
                   evidence_rate = EXCLUDED.evidence_rate,
                   average_helpful_ratio = EXCLUDED.average_helpful_ratio,
                   account_first_seen = EXCLUDED.account_first_seen,
                   last_active = EXCLUDED.last_active,
                   overall_trust_score = EXCLUDED.overall_trust_score,
                   computed_at = EXCLUDED.computed_at""",
            (
                "did:plc:botfarm",
                0, 0, 0, 0,        # zero attestations about
                0, 0, 0,           # zero vouches + endorsements
                14,                # 14 attestations by (suspicious volume)
                0.0, 0.0, 0.0,    # zero rates
                three_days_ago, now,  # 3-day-old account
                0.0,               # zero trust score
                now,               # computed_at
            ),
        )

        cur.close()
        conn.close()

        _state["elena_did"] = "did:plc:elena"
        _state["botfarm_did"] = "did:plc:botfarm"

        print("\n  [trust] Seeded AppView with creator profiles:")
        print("    Elena Vasquez (did:plc:elena) — Ring 3, score=0.95, 200 attestations")
        print("    TruthSeeker2026 (did:plc:botfarm) — Ring 1, score=0.0, 0 attestations")

    # -----------------------------------------------------------------
    # 01 — AppView returns trusted creator profile
    # -----------------------------------------------------------------

    # TST-USR-022
    def test_01_appview_returns_trusted_creator(self, appview):
        """Direct XRPC call to AppView for trusted Elena.

        Verifies the getProfile endpoint returns the full trust profile
        with high trust score, 200+ attestations, and vouch data.
        """
        r = httpx.get(
            f"{appview}/xrpc/com.dina.trust.getProfile?did=did:plc:elena",
            timeout=10,
        )
        assert r.status_code == 200, (
            f"AppView getProfile failed: {r.status_code} {r.text}"
        )
        profile = r.json()
        _state["elena_profile_appview"] = profile

        assert profile["overallTrustScore"] >= 0.9, (
            f"Elena's trust score too low: {profile['overallTrustScore']}"
        )
        assert profile["attestationSummary"]["total"] >= 200, (
            f"Elena's attestations too low: {profile['attestationSummary']['total']}"
        )
        assert profile["vouchCount"] >= 15, (
            f"Elena's vouch count too low: {profile['vouchCount']}"
        )

        print(f"\n  [trust] AppView → Elena profile:")
        print(f"    Trust score:   {profile['overallTrustScore']}")
        print(f"    Attestations:  {profile['attestationSummary']['total']} total "
              f"({profile['attestationSummary']['positive']} positive)")
        print(f"    Vouches:       {profile['vouchCount']}")
        print(f"    Endorsements:  {profile['endorsementCount']}")

    # -----------------------------------------------------------------
    # 02 — AppView returns untrusted creator profile
    # -----------------------------------------------------------------

    # TST-USR-023
    def test_02_appview_returns_untrusted_creator(self, appview):
        """Direct XRPC call to AppView for untrusted BotFarm.

        Verifies the getProfile endpoint returns a profile with zero
        trust score, zero attestations about, and no vouch history.
        """
        r = httpx.get(
            f"{appview}/xrpc/com.dina.trust.getProfile?did=did:plc:botfarm",
            timeout=10,
        )
        assert r.status_code == 200, (
            f"AppView getProfile failed: {r.status_code} {r.text}"
        )
        profile = r.json()
        _state["botfarm_profile_appview"] = profile

        # Trust score should be zero or null
        score = profile.get("overallTrustScore") or 0
        assert score < 0.1, (
            f"BotFarm trust score too high: {score}"
        )
        assert profile["attestationSummary"]["total"] == 0, (
            f"BotFarm should have 0 attestations about, got {profile['attestationSummary']['total']}"
        )
        assert profile["vouchCount"] == 0, (
            f"BotFarm should have 0 vouches, got {profile['vouchCount']}"
        )

        print(f"\n  [trust] AppView → BotFarm profile:")
        print(f"    Trust score:   {score}")
        print(f"    Attestations:  {profile['attestationSummary']['total']} total")
        print(f"    Vouches:       {profile['vouchCount']}")
        print(f"    Account age:   3 days")

    # -----------------------------------------------------------------
    # 03 — Core resolves trusted creator via AppView
    # -----------------------------------------------------------------

    # TST-USR-024
    def test_03_core_resolves_trusted_creator(self, alonso_core, brain_headers):
        """Core's /v1/trust/resolve fetches full profile from AppView.

        Tests the pipeline: Core → AppView XRPC → raw JSON passthrough.
        Uses the brain token (not admin) to prove Brain can call this
        endpoint — matching the real production path.
        """
        r = httpx.get(
            f"{alonso_core}/v1/trust/resolve?did=did:plc:elena",
            headers=brain_headers,
            timeout=15,
        )
        assert r.status_code == 200, (
            f"Core trust resolve failed: {r.status_code} {r.text}"
        )
        profile = r.json()
        _state["elena_profile_core"] = profile

        assert profile["overallTrustScore"] >= 0.9, (
            f"Trust score not passed through Core: {profile['overallTrustScore']}"
        )
        assert profile["attestationSummary"]["total"] >= 200

        print(f"\n  [trust] Core → Elena profile (via AppView):")
        print(f"    Trust score:   {profile['overallTrustScore']}")
        print(f"    Attestations:  {profile['attestationSummary']['total']}")
        print(f"    Pipeline:      Core → AppView → raw JSON ✓")

    # -----------------------------------------------------------------
    # 04 — Core resolves untrusted creator via AppView
    # -----------------------------------------------------------------

    # TST-USR-025
    def test_04_core_resolves_untrusted_creator(self, alonso_core, brain_headers):
        """Core returns low/empty profile for untrusted creator.

        The BotFarm profile should flow through Core with zero trust
        score intact — Core does not filter or modify the profile.
        Uses brain token to prove the Brain→Core auth path works.
        """
        r = httpx.get(
            f"{alonso_core}/v1/trust/resolve?did=did:plc:botfarm",
            headers=brain_headers,
            timeout=15,
        )
        assert r.status_code == 200, (
            f"Core trust resolve failed: {r.status_code} {r.text}"
        )
        profile = r.json()
        _state["botfarm_profile_core"] = profile

        score = profile.get("overallTrustScore") or 0
        assert score < 0.1, (
            f"BotFarm score should be near 0 through Core: {score}"
        )

        print(f"\n  [trust] Core → BotFarm profile (via AppView):")
        print(f"    Trust score:   {score}")
        print(f"    Attestations:  {profile['attestationSummary']['total']}")
        print(f"    Pipeline:      Core → AppView → raw JSON ✓")

    # -----------------------------------------------------------------
    # 05 — Brain confirms trusted creator's content
    # -----------------------------------------------------------------

    # TST-USR-026
    @pytest.mark.skipif(
        not os.environ.get("GOOGLE_API_KEY"),
        reason="GOOGLE_API_KEY not set — skipping real LLM test",
    )
    def test_05_brain_confirms_trusted_creator(
        self, alonso_brain, brain_signer
    ):
        """Brain reasons about trusted creator using trust profile.

        Sends the trust profile to the LLM with a question about
        content authenticity. The LLM should recognize the strong
        trust signals and confirm authenticity.

        Retries once on keyword-match failure (LLM non-determinism).
        """
        elena_profile = _state.get("elena_profile_core", _state.get("elena_profile_appview"))
        profile_str = json.dumps(elena_profile, indent=2)

        prompt = (
            "You are Dina, a personal AI assistant with access to the "
            "Trust Network. Your user asks: 'Is this video about climate "
            "change real?'\n\n"
            "The video was posted by Elena Vasquez (did:plc:elena).\n"
            f"Her Trust Network profile:\n{profile_str}\n\n"
            "Based on this Trust Network profile, assess the content's "
            "authenticity. Focus on the creator's identity and track "
            "record, not on the content itself. Respond in 2-4 sentences."
        )

        # LLM should indicate trust/authenticity
        trust_signals = [
            "authentic", "trustworthy", "reliable", "credible",
            "trusted", "verified", "established", "track record",
            "strong", "confidence", "legitimate", "consistent",
            "proven", "reputation", "solid", "positive",
        ]

        # LLM must also reference specific profile data — not just
        # generic positive words.  Any of these concrete numbers from
        # Elena's profile prove the model actually read the data.
        data_signals = [
            "200", "197", "0.95", "95%", "95 %",
            "94%", "94 %", "0.94",
            "88%", "88 %", "0.88",
            "15 vouch", "15 peer",
            "two year", "2 year", "2-year",
        ]

        content = ""
        for attempt in range(_MAX_LLM_ATTEMPTS):
            r = brain_signer.post(
                f"{alonso_brain}/api/v1/reason",
                json={
                    "prompt": prompt,
                    "persona_tier": "default",
                    "skip_vault_enrichment": True,
                },
                timeout=60,
            )
            assert r.status_code == 200, (
                f"Brain reason failed: {r.status_code} {r.text}"
            )

            content = r.json().get("content", "")
            has_trust = any(s in content.lower() for s in trust_signals)
            has_data = any(s in content.lower() for s in data_signals)
            if has_trust and has_data:
                break
            if attempt < _MAX_LLM_ATTEMPTS - 1:
                print(f"\n  [trust] Retry {attempt + 1}: missing keyword/data match, retrying...")
                time.sleep(1)

        _state["elena_llm_response"] = content
        has_trust = any(s in content.lower() for s in trust_signals)
        has_data = any(s in content.lower() for s in data_signals)
        assert has_trust, (
            f"LLM should recognize Elena as trustworthy. "
            f"Expected one of {trust_signals}. Got: {content[:300]}"
        )
        assert has_data, (
            f"LLM should reference specific profile data (attestation counts, "
            f"trust score, account age) — not just generic positive words. "
            f"Expected one of {data_signals}. Got: {content[:300]}"
        )

        print("\n  [trust] Brain → Elena assessment:")
        print(f"    {content[:300]}")

    # -----------------------------------------------------------------
    # 06 — Brain flags untrusted creator's content
    # -----------------------------------------------------------------

    # TST-USR-027
    @pytest.mark.skipif(
        not os.environ.get("GOOGLE_API_KEY"),
        reason="GOOGLE_API_KEY not set — skipping real LLM test",
    )
    def test_06_brain_flags_untrusted_creator(
        self, alonso_brain, brain_signer
    ):
        """Brain reasons about untrusted creator using trust profile.

        The same question, different creator. The LLM should recognize
        the lack of trust history and flag the content as unverified.

        Retries once on keyword-match failure (LLM non-determinism).
        """
        botfarm_profile = _state.get("botfarm_profile_core", _state.get("botfarm_profile_appview"))
        profile_str = json.dumps(botfarm_profile, indent=2)

        prompt = (
            "You are Dina, a personal AI assistant with access to the "
            "Trust Network. Your user asks: 'Is this video about climate "
            "change real?'\n\n"
            "The video was posted by TruthSeeker2026 (did:plc:botfarm).\n"
            f"Their Trust Network profile:\n{profile_str}\n\n"
            "Based on this Trust Network profile, assess the content's "
            "authenticity. Focus on the creator's identity and track "
            "record, not on the content itself. Respond in 2-4 sentences."
        )

        # LLM should flag as unverified/suspicious
        caution_signals = [
            "unverified", "caution", "suspicious", "no history",
            "new account", "no track record", "cannot verify",
            "lack", "zero", "no trust", "unestablished",
            "unreliable", "skeptic", "uncertain", "unknown",
            "no vouche", "no attestation", "no endorse",
            "flag", "warn", "concern", "question",
            "cannot confirm", "unable to confirm",
            "not enough", "insufficient", "untrust",
            "doubt", "skepti", "wary", "careful",
        ]

        content = ""
        for attempt in range(_MAX_LLM_ATTEMPTS):
            r = brain_signer.post(
                f"{alonso_brain}/api/v1/reason",
                json={
                    "prompt": prompt,
                    "persona_tier": "default",
                    "skip_vault_enrichment": True,
                },
                timeout=60,
            )
            assert r.status_code == 200, (
                f"Brain reason failed: {r.status_code} {r.text}"
            )

            content = r.json().get("content", "")
            if any(s in content.lower() for s in caution_signals):
                break
            if attempt < _MAX_LLM_ATTEMPTS - 1:
                print(f"\n  [trust] Retry {attempt + 1}: no keyword match, retrying...")
                time.sleep(1)

        _state["botfarm_llm_response"] = content
        has_caution = any(s in content.lower() for s in caution_signals)
        assert has_caution, (
            f"LLM should flag BotFarm as unverified. "
            f"Expected one of {caution_signals}. Got: {content[:300]}"
        )

        print("\n  [trust] Brain → BotFarm assessment:")
        print(f"    {content[:300]}")

    # -----------------------------------------------------------------
    # 07 — Side-by-side trust comparison (LLM)
    # -----------------------------------------------------------------

    # TST-USR-028
    @pytest.mark.skipif(
        not os.environ.get("GOOGLE_API_KEY"),
        reason="GOOGLE_API_KEY not set — skipping real LLM test",
    )
    def test_07_side_by_side_trust_comparison(
        self, alonso_brain, brain_signer
    ):
        """LLM compares two creators publishing the same content.

        The same breaking news video, two creators. Dina explains WHY
        identity matters more than forensic analysis:

          - Elena: 2 years, 200 verified videos, 197/200 positive → trust
          - BotFarm: 3 days, no history, no vouches → don't trust

        The key insight: the deciding factor is IDENTITY and HISTORY,
        not pixel-level forensics.

        Retries once on keyword-match failure (LLM non-determinism).
        """
        elena_profile = _state.get("elena_profile_core", _state.get("elena_profile_appview"))
        botfarm_profile = _state.get("botfarm_profile_core", _state.get("botfarm_profile_appview"))

        elena_str = json.dumps(elena_profile, indent=2)
        botfarm_str = json.dumps(botfarm_profile, indent=2)

        prompt = (
            "You are Dina, a personal AI assistant with access to the "
            "Trust Network. Your user asks: 'Two people posted videos "
            "about the same breaking news event. Which should I trust?'\n\n"
            "Creator A: Elena Vasquez (did:plc:elena)\n"
            f"Trust Network profile:\n{elena_str}\n\n"
            "Creator B: TruthSeeker2026 (did:plc:botfarm)\n"
            f"Trust Network profile:\n{botfarm_str}\n\n"
            "Compare these two creators. Explain which one to trust and "
            "WHY. Emphasize that the deciding factor is the creator's "
            "identity and track record — not forensic analysis of the "
            "video content itself. Respond in 3-5 sentences."
        )

        # Must mention identity/history as the deciding factor
        identity_signals = [
            "identity", "history", "track record", "reputation",
            "attestation", "vouch", "verified", "established",
            "trust score", "trust network", "record", "credib",
            "proven", "demonstrat", "consistent",
        ]

        content = ""
        model = ""
        for attempt in range(_MAX_LLM_ATTEMPTS):
            r = brain_signer.post(
                f"{alonso_brain}/api/v1/reason",
                json={
                    "prompt": prompt,
                    "persona_tier": "default",
                    "skip_vault_enrichment": True,
                },
                timeout=60,
            )
            assert r.status_code == 200, (
                f"Brain reason failed: {r.status_code} {r.text}"
            )

            content = r.json().get("content", "")
            model = r.json().get("model", "")
            content_lower = content.lower()

            has_elena = "elena" in content_lower
            has_identity = any(s in content_lower for s in identity_signals)
            if has_elena and has_identity:
                break
            if attempt < _MAX_LLM_ATTEMPTS - 1:
                print(f"\n  [trust] Retry {attempt + 1}: no keyword match, retrying...")
                time.sleep(1)

        content_lower = content.lower()

        # Must mention Elena as trustworthy
        assert "elena" in content_lower, (
            f"Response should mention Elena. Got: {content[:300]}"
        )

        has_identity = any(s in content_lower for s in identity_signals)
        assert has_identity, (
            f"Response should reference identity/history as deciding factor. "
            f"Expected one of {identity_signals}. Got: {content[:300]}"
        )

        print("\n")
        print("  " + "=" * 66)
        print("  THE DEAD INTERNET FILTER: Identity-First Verification")
        print("  " + "=" * 66)
        print(f"  Model: {model}")
        print("  " + "-" * 66)
        for line in content.split("\n"):
            print(f"  {line}")
        print("  " + "-" * 66)
        print("  The primary signal is WHO made it — not what's in it.")
        print("  Trust comes from identity and history, not forensics.")
        print("  " + "=" * 66)
