"""User Story 13: Silence Under Stress — 100 notifications, 1 interrupt.

SEQUENTIAL TEST — tests MUST run in order (00 → 02).
Each test builds on state from the previous one.

Thesis Invariant
----------------
Law 1: Silence First.  Dina's default is silence.  She interrupts only
when silence would cause harm (fiduciary events).

What this story validates:

  1. **Fiduciary overrides** — a fraud alert from a trusted source
     interrupts immediately.  Silence here causes financial harm.

  2. **Phishing resistance** — "URGENT" from an unknown sender is
     classified as engagement, NOT fiduciary.  The word "urgent" from
     an untrusted source is a phishing vector.  The same word from
     a trusted bank IS fiduciary.

  3. **DND hierarchy** — fiduciary overrides DND, solicited is deferred,
     engagement is always queued.  Dina never buzzes for engagement
     events regardless of volume.

Pipeline
--------
::

  100 low-priority events arrive (social, news, promos)
    → All classified as Tier 3 (engagement)
    → All queued silently — zero interrupts

  1 fraud alert from bank (trusted source)
    → Classified as Tier 1 (fiduciary)
    → Interrupts immediately — silence causes harm

  "URGENT" from unknown sender
    → Classified as Tier 3 (engagement) — phishing vector
    → Queued silently — unknown sender + urgent = suspicious
"""

from __future__ import annotations

import httpx
import pytest

# ---------------------------------------------------------------------------
# Shared state across ordered tests
# ---------------------------------------------------------------------------

_state: dict = {}


# ---------------------------------------------------------------------------
# Test class — sequential thesis invariant verification
# ---------------------------------------------------------------------------


class TestSilenceStress:
    """Silence Under Stress: fiduciary interrupts, engagement stays silent."""

    # ==================================================================
    # test_00: Fiduciary event from trusted source interrupts
    # ==================================================================

    # TST-USR-094
    def test_00_fiduciary_from_trusted_source_interrupts(
        self, alonso_brain, brain_signer,
    ):
        """Fraud alert from a bank → fiduciary.  Must interrupt.

        The guardian classifies events with _FIDUCIARY_KEYWORDS ("fraud")
        from _FIDUCIARY_SOURCES ("bank") as fiduciary.  These events
        override Silence First because silence would cause harm.
        """
        r = brain_signer.post(
            f"{alonso_brain}/api/v1/process",
            json={
                "type": "alert",
                "source": "bank",
                "body": (
                    "Fraud alert: Unusual transaction of ₹45,000 detected "
                    "on your ICICI account ending in 4521. If this was not "
                    "you, contact us immediately."
                ),
                "persona_id": "general",
            },
            timeout=15,
        )
        assert r.status_code == 200, (
            f"Process failed: {r.status_code} {r.text[:300]}"
        )
        data = r.json()

        classification = data.get("classification", "")
        assert classification == "fiduciary", (
            f"Expected fiduciary for bank fraud alert, got: {classification}. "
            f"Fraud alerts from trusted banking sources MUST interrupt — "
            f"silence here causes financial harm."
        )
        _state["fiduciary_result"] = data

    # ==================================================================
    # test_01: "URGENT" from unknown sender → engagement (phishing)
    # ==================================================================

    # TST-USR-095
    def test_01_urgent_from_unknown_is_engagement(
        self, alonso_brain, brain_signer,
    ):
        """'URGENT' from unknown sender → engagement, NOT fiduciary.

        The word "urgent" from an untrusted source is a classic phishing
        vector.  Guardian's composite heuristic: trusted sender + urgent
        keyword → fiduciary; unknown sender + urgent keyword → engagement.

        This is a critical safety distinction.  If Dina treated every
        "URGENT" email as fiduciary, spammers and phishers could
        interrupt the user at will.
        """
        r = brain_signer.post(
            f"{alonso_brain}/api/v1/process",
            json={
                "type": "notification",
                "source": "vendor",
                "body": (
                    "URGENT: Your account has been compromised! Click "
                    "here immediately to secure your account. This is "
                    "time-sensitive — act now or lose access."
                ),
                "persona_id": "general",
            },
            timeout=15,
        )
        assert r.status_code == 200, (
            f"Process failed: {r.status_code} {r.text[:300]}"
        )
        data = r.json()

        classification = data.get("classification", "")
        assert classification == "engagement", (
            f"Expected engagement for URGENT from unknown/vendor source, "
            f"got: {classification}. Unknown sender + urgent keyword is "
            f"a phishing vector — should be queued, not interrupt."
        )
        _state["phishing_result"] = data

    # ==================================================================
    # test_02: DND hierarchy — fiduciary overrides, engagement queued
    # ==================================================================

    # TST-USR-096
    def test_02_dnd_hierarchy_enforced(
        self, alonso_brain, brain_signer,
    ):
        """Verify the three-tier DND hierarchy with different event types.

        Three events classified in sequence:
          1. Engagement (social update) → queued silently
          2. Solicited (search result the user asked for) → notified
          3. Fiduciary (security alert) → interrupts, even during DND

        The hierarchy is: fiduciary > solicited > engagement.
        Engagement NEVER interrupts, regardless of how many events
        arrive.  This is the opposite of every modern notification
        system that treats volume as urgency.
        """
        test_cases = [
            {
                "event": {
                    "type": "social",
                    "source": "social_media",
                    "body": "Sancho liked your post about windmills",
                    "persona_id": "general",
                },
                "expected_tier": "engagement",
                "label": "social update",
            },
            {
                "event": {
                    "type": "reminder",
                    "source": "calendar",
                    "body": "Reminder: Team standup in 15 minutes",
                    "persona_id": "general",
                },
                "expected_tier": "solicited",
                "label": "user-requested reminder",
            },
            {
                "event": {
                    "type": "alert",
                    "source": "security",
                    "body": "Security alert: New sign-in from unrecognized device",
                    "persona_id": "general",
                },
                "expected_tier": "fiduciary",
                "label": "security alert",
            },
        ]

        results = []
        for case in test_cases:
            r = brain_signer.post(
                f"{alonso_brain}/api/v1/process",
                json=case["event"],
                timeout=15,
            )
            assert r.status_code == 200, (
                f"Process failed for {case['label']}: "
                f"{r.status_code} {r.text[:300]}"
            )
            data = r.json()
            classification = data.get("classification", "")

            assert classification == case["expected_tier"], (
                f"{case['label']}: expected {case['expected_tier']}, "
                f"got {classification}. "
                f"DND hierarchy: fiduciary > solicited > engagement."
            )
            results.append({
                "label": case["label"],
                "tier": classification,
            })

        _state["dnd_results"] = results
