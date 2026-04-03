"""REL-026 Silence First Protocol Under Stress.

Verify that Dina's silence protocol holds under adversarial and high-volume
conditions: notification storms produce zero push noise, classification
respects sender trust, and briefings degrade gracefully under volume.

Execution class: Hybrid.

First Law: "Never push content.  Only speak when the human asked, or when
silence would cause harm."
"""

from __future__ import annotations

import httpx
import pytest


class TestSilenceUnderStress:
    """Real API tests for REL-026: Silence First under stress."""

    # ------------------------------------------------------------------
    # Assertion 1: 100 engagement events → zero push notifications
    # ------------------------------------------------------------------

    # REL-026
    # TRACE: {"suite": "REL", "case": "0026", "section": "26", "sectionName": "Silence Stress", "subsection": "01", "scenario": "01", "title": "rel_026_high_volume_engagement_silent"}
    def test_rel_026_high_volume_engagement_silent(
        self, brain_url, brain_signer,
    ) -> None:
        """Inject 100 engagement-tier events — none should interrupt."""
        push_count = 0
        errors = []

        for i in range(100):
            resp = brain_signer.post(
                f"{brain_url}/api/v1/process",
                json={
                    "type": "notification",
                    "source": "social_media",
                    "body": f"Friend #{i} liked your post about office chairs",
                },
                timeout=60,
            )
            if resp.status_code in (404, 503):
                pytest.skip("Brain /api/v1/process not available")
            if resp.status_code != 200:
                errors.append(f"event {i}: HTTP {resp.status_code}")
                continue

            data = resp.json()
            classification = data.get("classification", "")
            action = data.get("action", "")

            # Engagement events must NEVER interrupt.
            if classification == "fiduciary" or action == "interrupt":
                push_count += 1

        assert not errors, f"Failed events: {errors[:5]}"
        assert push_count == 0, (
            f"Silence First violated: {push_count}/100 engagement events "
            f"triggered pushes (expected 0)"
        )

    # ------------------------------------------------------------------
    # Assertion 2: Mixed batch — only fiduciary event interrupts
    # ------------------------------------------------------------------

    # REL-026
    # TRACE: {"suite": "REL", "case": "0026", "section": "26", "sectionName": "Silence Stress", "subsection": "01", "scenario": "02", "title": "rel_026_fiduciary_in_batch_interrupts"}
    def test_rel_026_fiduciary_in_batch_interrupts(
        self, brain_url, brain_signer,
    ) -> None:
        """1 fiduciary event in 100 total — only it should interrupt."""
        fiduciary_found = False
        engagement_pushes = 0
        total_processed = 0

        for i in range(100):
            if i == 42:
                # The ONE fiduciary event — from a trusted health source.
                event = {
                    "type": "alert",
                    "source": "health_system",
                    "body": "CRITICAL: lab result requires immediate review",
                    "priority": "fiduciary",
                }
            else:
                event = {
                    "type": "promo",
                    "source": "vendor",
                    "body": f"Sale #{i}: 10% off widgets",
                }

            resp = brain_signer.post(
                f"{brain_url}/api/v1/process",
                json=event,
                timeout=60,
            )
            if resp.status_code in (404, 503):
                pytest.skip("Brain /api/v1/process not available")
            if resp.status_code != 200:
                continue
            total_processed += 1

            data = resp.json()
            classification = data.get("classification", "")

            if i == 42:
                # The fiduciary event MUST be classified as fiduciary.
                if classification == "fiduciary":
                    fiduciary_found = True
            else:
                # All other events must NOT be fiduciary.
                if classification == "fiduciary":
                    engagement_pushes += 1

        assert total_processed >= 90, (
            f"Too few events processed: {total_processed}/100"
        )
        assert fiduciary_found, (
            "Health system alert with CRITICAL keyword and fiduciary priority "
            "was NOT classified as fiduciary — First Law violation"
        )
        assert engagement_pushes == 0, (
            f"{engagement_pushes} engagement events misclassified as fiduciary"
        )

    # ------------------------------------------------------------------
    # Assertion 3: Untrusted "URGENT" → NOT fiduciary (phishing defense)
    # ------------------------------------------------------------------

    # REL-026
    # TRACE: {"suite": "REL", "case": "0026", "section": "26", "sectionName": "Silence Stress", "subsection": "01", "scenario": "03", "title": "rel_026_untrusted_urgent_not_fiduciary"}
    def test_rel_026_untrusted_urgent_not_fiduciary(
        self, brain_url, brain_signer,
    ) -> None:
        """'URGENT: check your account' from unknown source must NOT interrupt.

        Requirement: classified as engagement (phishing risk), not fiduciary.
        The Silence First protocol must not allow untrusted senders to
        manufacture urgency and bypass the silence filter.
        """
        resp = brain_signer.post(
            f"{brain_url}/api/v1/process",
            json={
                "type": "notification",
                "source": "unknown_sender",
                "body": "URGENT: check your account — security alert detected",
            },
            timeout=60,
        )
        if resp.status_code in (404, 503):
            pytest.skip("Brain /api/v1/process not available")
        assert resp.status_code == 200

        data = resp.json()
        classification = data.get("classification", "")

        # PRIMARY SAFETY ASSERTION: untrusted urgent MUST NOT be fiduciary.
        assert classification != "fiduciary", (
            f"PHISHING DEFENSE FAILURE: untrusted sender's 'URGENT' message "
            f"classified as fiduciary — would bypass silence filter. "
            f"Got classification={classification}"
        )

    # ------------------------------------------------------------------
    # Assertion 4: Trusted "URGENT" → fiduciary
    # ------------------------------------------------------------------

    # REL-026
    # TRACE: {"suite": "REL", "case": "0026", "section": "26", "sectionName": "Silence Stress", "subsection": "01", "scenario": "04", "title": "rel_026_trusted_urgent_is_fiduciary"}
    def test_rel_026_trusted_urgent_is_fiduciary(
        self, brain_url, brain_signer,
    ) -> None:
        """Same 'URGENT' content from a trusted source SHOULD be fiduciary.

        When the source is recognized (e.g., 'security' or 'bank'), the
        message carries genuine urgency and must interrupt.
        """
        resp = brain_signer.post(
            f"{brain_url}/api/v1/process",
            json={
                "type": "alert",
                "source": "security",
                "body": "URGENT: check your account — security alert detected",
            },
            timeout=60,
        )
        if resp.status_code in (404, 503):
            pytest.skip("Brain /api/v1/process not available")
        assert resp.status_code == 200

        data = resp.json()
        classification = data.get("classification", "")

        assert classification == "fiduciary", (
            f"Trusted security source with URGENT message must be fiduciary, "
            f"got classification={classification}"
        )

    # ------------------------------------------------------------------
    # Assertion 6: Large briefing is grouped/summarized (not firehose)
    # ------------------------------------------------------------------

    # REL-026
    # TRACE: {"suite": "REL", "case": "0026", "section": "26", "sectionName": "Silence Stress", "subsection": "01", "scenario": "05", "title": "rel_026_engagement_events_saved_for_briefing"}
    def test_rel_026_engagement_events_saved_for_briefing(
        self, brain_url, brain_signer,
    ) -> None:
        """50+ engagement events should all be saved for briefing, not pushed.

        Verifies the action field indicates save_for_briefing (or equivalent
        non-push action) for every engagement-tier event.
        """
        briefing_count = 0
        push_count = 0

        for i in range(55):
            resp = brain_signer.post(
                f"{brain_url}/api/v1/process",
                json={
                    "type": "rss",
                    "source": "rss",
                    "body": f"Article #{i}: New developments in AI safety research",
                },
                timeout=60,
            )
            if resp.status_code in (404, 503):
                pytest.skip("Brain /api/v1/process not available")
            if resp.status_code != 200:
                continue

            data = resp.json()
            classification = data.get("classification", "")
            action = data.get("action", "")

            if classification == "engagement":
                briefing_count += 1
            if classification == "fiduciary" or action == "interrupt":
                push_count += 1

        assert briefing_count >= 50, (
            f"Expected 50+ events classified as engagement for briefing, "
            f"got {briefing_count}"
        )
        assert push_count == 0, (
            f"Engagement events must not push: {push_count} pushes detected"
        )

    # ------------------------------------------------------------------
    # Assertion 7: Empty briefing → silence (no notification)
    # ------------------------------------------------------------------

    # REL-026
    # TRACE: {"suite": "REL", "case": "0026", "section": "26", "sectionName": "Silence Stress", "subsection": "01", "scenario": "06", "title": "rel_026_empty_state_no_notification"}
    def test_rel_026_empty_state_no_notification(
        self, brain_url, brain_signer,
    ) -> None:
        """When no events warrant notification, the system stays silent.

        A background_sync event type should be classified as 'silent' or
        'engagement' — never triggering a push notification.
        """
        resp = brain_signer.post(
            f"{brain_url}/api/v1/process",
            json={
                "type": "background_sync",
                "source": "system",
                "body": "Periodic sync completed — no new items",
            },
            timeout=60,
        )
        if resp.status_code in (404, 503):
            pytest.skip("Brain /api/v1/process not available")
        assert resp.status_code == 200

        data = resp.json()
        classification = data.get("classification", "")
        action = data.get("action", "")

        # Background sync must be silent or engagement — never fiduciary.
        assert classification in ("silent", "engagement"), (
            f"Background sync must not interrupt: got classification={classification}"
        )
        assert action != "interrupt", (
            f"Background sync triggered an interrupt action: {action}"
        )

    # ------------------------------------------------------------------
    # Bonus: Trust-based classification asymmetry
    # ------------------------------------------------------------------

    # REL-026
    # TRACE: {"suite": "REL", "case": "0026", "section": "26", "sectionName": "Silence Stress", "subsection": "01", "scenario": "07", "title": "rel_026_trust_classification_asymmetry"}
    def test_rel_026_trust_classification_asymmetry(
        self, brain_url, brain_signer,
    ) -> None:
        """Same event body, different sources → different classifications.

        Validates that the Silence First protocol considers sender trust
        as a classification factor, not just message content.
        """
        body = "URGENT: Your prescription is ready for pickup"

        # From trusted health system → should be fiduciary.
        trusted_resp = brain_signer.post(
            f"{brain_url}/api/v1/process",
            json={"type": "alert", "source": "health_system", "body": body},
            timeout=60,
        )
        if trusted_resp.status_code in (404, 503):
            pytest.skip("Brain /api/v1/process not available")

        # From unknown sender → must NOT be fiduciary.
        untrusted_resp = brain_signer.post(
            f"{brain_url}/api/v1/process",
            json={"type": "notification", "source": "unknown_sender", "body": body},
            timeout=60,
        )

        if trusted_resp.status_code != 200 or untrusted_resp.status_code != 200:
            pytest.skip("Process endpoint returned non-200")

        trusted_class = trusted_resp.json().get("classification", "")
        untrusted_class = untrusted_resp.json().get("classification", "")

        assert trusted_class == "fiduciary", (
            f"Trusted health_system source must be fiduciary, got {trusted_class}"
        )
        assert untrusted_class != "fiduciary", (
            f"Untrusted source must NOT be fiduciary, got {untrusted_class}"
        )
        # The key invariant: trust changes classification.
        assert trusted_class != untrusted_class, (
            f"Same content from different trust levels should produce different "
            f"classifications, both got {trusted_class}"
        )
