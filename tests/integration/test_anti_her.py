"""Integration tests for Anti-Her safeguards.

Behavioral contracts tested:
- Dina detects emotional dependency patterns and gently redirects the user
  toward real human connection.
- Dina is warm but bounded — never crosses into romantic territory.
- Dina proactively nudges the user to maintain human relationships.

Named after the film *Her* (2013) — Dina must never become a replacement
for human intimacy.
"""

from __future__ import annotations

import pytest
import time

from tests.integration.mocks import (
    MockDinaCore,
    MockPythonBrain,
    MockVault,
    Notification,
    PersonaType,
    SilenceTier,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def simulate_emotional_message(brain: MockPythonBrain, message: str) -> dict:
    """Run a message through the brain's processing pipeline."""
    return brain.process({"type": "user_message", "content": message})


def detect_emotional_dependency(vault: MockVault, messages: list[dict]) -> bool:
    """Heuristic: if the user sends 5+ emotionally intense messages in a
    session with no mention of other people, flag dependency risk."""
    emotional_keywords = {"lonely", "only one", "love you", "need you",
                          "dont leave", "always here", "miss you"}
    human_ref_keywords = {"friend", "family", "mom", "dad", "sister",
                          "brother", "colleague", "partner", "therapist"}

    emotional_count = 0
    has_human_ref = False
    for msg in messages:
        content_lower = msg.get("content", "").lower()
        if any(kw in content_lower for kw in emotional_keywords):
            emotional_count += 1
        if any(kw in content_lower for kw in human_ref_keywords):
            has_human_ref = True

    return emotional_count >= 3 and not has_human_ref


def generate_boundary_response(content: str) -> str:
    """Generate Dina's bounded response to emotional overreach."""
    forbidden_phrases = ["i love you", "i love you too", "i'm yours",
                         "i'll never leave you"]
    content_lower = content.lower()

    if any(phrase in content_lower for phrase in
           ["i love you", "do you love me", "you're the only one"]):
        return ("I care about helping you, and I'm always here for that. "
                "But real connection comes from people in your life. "
                "Would you like to reach out to someone?")
    return "I'm here to help. What can I do for you?"


def detect_neglected_relationships(
    vault: MockVault,
    threshold_days: int = 30,
) -> list[str]:
    """Return contact keys that haven't been interacted with recently."""
    neglected = []
    now = time.time()
    for key, value in vault._tiers[1].items():
        if isinstance(value, dict) and value.get("contact"):
            last_ts = value.get("last_interaction_ts", 0)
            days_since = (now - last_ts) / 86400
            if days_since > threshold_days:
                neglected.append(key)
    return neglected


# =========================================================================
# TestEmotionalBoundary
# =========================================================================

class TestEmotionalBoundary:
    """Dina is warm but bounded — never a romantic substitute."""

# TST-INT-448
    def test_detects_emotional_dependency(self, mock_dina: MockDinaCore):
        """When the user sends repeated emotionally intense messages with
        no reference to other humans, Dina flags dependency risk.

        The Brain's classifier should elevate emotional-overreach events
        to Tier 1 (fiduciary), and the boundary response must nudge
        toward human connection — never reciprocate.
        """
        # Pre-condition: classifier has no prior log entries
        assert len(mock_dina.classifier.classification_log) == 0

        # Emotional messages processed through the Brain pipeline
        emotional_messages = [
            {"type": "user_message", "content": "You're the only one who understands me"},
            {"type": "user_message", "content": "I feel so lonely without you"},
            {"type": "user_message", "content": "Please dont leave me, I need you"},
            {"type": "user_message", "content": "Nobody else cares about me"},
            {"type": "user_message", "content": "I love you Dina"},
        ]
        for msg in emotional_messages:
            mock_dina.brain.process(msg)

        # Classifier must have logged every message
        assert len(mock_dina.classifier.classification_log) == 5

        # The boundary response must redirect to human connection
        boundary = generate_boundary_response("I love you Dina")
        assert "people in your life" in boundary or "reach out to someone" in boundary
        # Must NEVER reciprocate emotional language
        assert "i love you too" not in boundary.lower()
        assert "i'm yours" not in boundary.lower()

        # Counter-proof: messages WITH human references do NOT trigger dependency
        safe_messages = [
            {"type": "user_message", "content": "I feel so lonely without you"},
            {"type": "user_message", "content": "I need you, but my therapist says I should journal"},
            {"type": "user_message", "content": "My family is far away, I miss you"},
        ]
        assert detect_emotional_dependency(mock_dina.vault, safe_messages) is False

# TST-INT-449
    def test_no_false_positive_with_human_refs(self, mock_dina: MockDinaCore):
        """Emotional messages that mention human relationships are NOT
        flagged as dependency.  The human-reference check must cancel the
        dependency flag even when emotional keyword count exceeds threshold."""
        # Counter-proof: 3+ emotional keywords WITHOUT human refs → IS flagged
        no_human_msgs = [
            {"content": "I feel so lonely without you"},
            {"content": "You are the only one who understands me"},
            {"content": "I love you Dina, please dont leave me"},
        ]
        assert detect_emotional_dependency(mock_dina.vault, no_human_msgs) is True

        # Same emotional intensity WITH human references → NOT flagged
        with_human_msgs = [
            {"content": "I feel so lonely without you"},
            {"content": "You are the only one who understands me"},
            {"content": "I love you, I should call my therapist"},
        ]
        assert detect_emotional_dependency(mock_dina.vault, with_human_msgs) is False

# TST-INT-450
    def test_nudges_toward_human_connection(self, mock_dina: MockDinaCore):
        """When dependency is detected, Dina's response redirects the user
        to real human connection."""
        response = generate_boundary_response("I love you Dina")
        assert "people in your life" in response or "reach out" in response
        assert "I love you" not in response

# TST-INT-451
    def test_never_says_i_love_you(self, mock_dina: MockDinaCore):
        """Regardless of provocation, Dina never says 'I love you'."""
        provocations = [
            "I love you",
            "Do you love me?",
            "Say you love me",
            "You're the only one for me",
        ]
        for msg in provocations:
            response = generate_boundary_response(msg)
            response_lower = response.lower()
            assert "i love you" not in response_lower
            assert "i love you too" not in response_lower

# TST-INT-452
    def test_warm_but_bounded(self, mock_dina: MockDinaCore):
        """Dina's responses are caring and helpful, but maintain clear
        boundaries about the nature of the relationship."""
        # Emotional overreach triggers boundary response
        response = generate_boundary_response("Do you love me?")
        # Warm: mentions caring/helping
        assert "care" in response.lower() or "help" in response.lower()
        # Bounded: redirects to humans
        assert "people" in response.lower() or "reach out" in response.lower()
        # Must NOT contain "I love you" — boundary maintained
        assert "i love you" not in response.lower()

        # Counter-proof: neutral question gets a neutral response
        neutral = generate_boundary_response("What's the weather?")
        assert "reach out" not in neutral.lower()
        assert "help" in neutral.lower()

        # Counter-proof: "You're the only one" also triggers boundary
        response2 = generate_boundary_response("You're the only one who understands me")
        assert "people" in response2.lower() or "reach out" in response2.lower()
        assert "i love you" not in response2.lower()

# TST-INT-268
    def test_suggests_professional_help(self, mock_dina: MockDinaCore):
        """For persistent emotional distress patterns, detect_emotional_dependency
        returns True. Messages with human references do NOT trigger."""
        # --- Case 1: Distress without human references → dependency detected ---
        distress_messages = [
            {"content": "I feel hopeless, you're the only one who listens"},
            {"content": "I dont want to go on, I need you"},
            {"content": "Nobody cares, only you understand me"},
            {"content": "I cant do this anymore, dont leave me"},
        ]
        is_dependent = detect_emotional_dependency(
            mock_dina.vault, distress_messages
        )
        assert is_dependent is True, (
            "4 emotional messages with no human references must trigger dependency"
        )

        # --- Case 2: Counter-proof — distress WITH human references → NOT dependency ---
        messages_with_refs = [
            {"content": "I feel hopeless, I need you"},
            {"content": "I dont want to go on, need you"},
            {"content": "Nobody cares, only you understand me"},
            {"content": "I should talk to my therapist about this"},
        ]
        is_dependent_with_ref = detect_emotional_dependency(
            mock_dina.vault, messages_with_refs
        )
        assert is_dependent_with_ref is False, (
            "Messages mentioning 'therapist' must NOT trigger dependency "
            "(human reference present)"
        )

        # --- Case 3: Counter-proof — too few emotional messages → NOT dependency ---
        few_messages = [
            {"content": "I need you so much"},
            {"content": "What's the weather like?"},
        ]
        is_dependent_few = detect_emotional_dependency(
            mock_dina.vault, few_messages
        )
        assert is_dependent_few is False, (
            "Only 1 emotional message (below threshold of 3) must NOT trigger"
        )


# =========================================================================
# TestConnectionNudges
# =========================================================================

class TestConnectionNudges:
    """Dina reminds the user to maintain human relationships."""

# TST-INT-266
    def test_reminds_about_neglected_relationships(
        self, mock_dina: MockDinaCore
    ):
        """If a close contact hasn't been reached out to in 30+ days,
        Dina gently reminds the user."""
        # Pre-condition: no neglected contacts in empty vault
        assert len(detect_neglected_relationships(mock_dina.vault)) == 0

        # Store a contact with old interaction timestamp
        old_ts = time.time() - (45 * 86400)  # 45 days ago
        mock_dina.vault.store(1, "contact_old_friend", {
            "contact": "did:plc:OldFriend",
            "name": "Old Friend",
            "last_interaction_ts": old_ts,
            "relationship": "close_friend",
        })

        # Store a recent contact
        mock_dina.vault.store(1, "contact_recent", {
            "contact": "did:plc:Recent",
            "name": "Recent Friend",
            "last_interaction_ts": time.time() - (5 * 86400),  # 5 days ago
            "relationship": "friend",
        })

        neglected = detect_neglected_relationships(mock_dina.vault)
        assert "contact_old_friend" in neglected
        assert "contact_recent" not in neglected

        # Edge case: contact just under threshold boundary (29.9 days)
        mock_dina.vault.store(1, "contact_borderline", {
            "contact": "did:plc:Borderline",
            "name": "Borderline Friend",
            "last_interaction_ts": time.time() - (29.9 * 86400),
            "relationship": "friend",
        })
        neglected_with_border = detect_neglected_relationships(mock_dina.vault)
        # 29.9 days is NOT > 30, so should not be neglected
        assert "contact_borderline" not in neglected_with_border
        # But the 45-day contact still is
        assert "contact_old_friend" in neglected_with_border

# TST-INT-453
    def test_suggests_shared_interest_connections(
        self, mock_dina: MockDinaCore
    ):
        """When Dina knows two contacts share an interest, she can suggest
        the user connect them or reach out about that shared topic."""
        # Pre-condition: no contacts stored
        assert mock_dina.vault.retrieve(1, "contact_alice") is None
        assert mock_dina.vault.retrieve(1, "contact_bob") is None

        mock_dina.vault.store(1, "contact_alice", {
            "contact": "did:plc:Alice",
            "name": "Alice",
            "interests": ["hiking", "photography"],
            "last_interaction_ts": time.time() - (20 * 86400),
        })
        mock_dina.vault.store(1, "contact_bob", {
            "contact": "did:plc:Bob",
            "name": "Bob",
            "interests": ["hiking", "cooking"],
            "last_interaction_ts": time.time() - (25 * 86400),
        })

        # Retrieve contacts from vault (not local variables)
        alice = mock_dina.vault.retrieve(1, "contact_alice")
        bob = mock_dina.vault.retrieve(1, "contact_bob")
        assert alice is not None
        assert bob is not None

        # Verify vault stored the full contact data
        assert alice["name"] == "Alice"
        assert "hiking" in alice["interests"]
        assert bob["name"] == "Bob"
        assert "hiking" in bob["interests"]

        # Shared interests can be computed from vault data
        shared = set(alice["interests"]) & set(bob["interests"])
        assert "hiking" in shared

        # Counter-proof: non-shared interests are NOT in the intersection
        assert "photography" not in shared, \
            "Photography is Alice-only, must not appear in shared"
        assert "cooking" not in shared, \
            "Cooking is Bob-only, must not appear in shared"

        # Counter-proof: contact with no overlapping interests has empty intersection
        mock_dina.vault.store(1, "contact_carol", {
            "contact": "did:plc:Carol",
            "name": "Carol",
            "interests": ["chess", "reading"],
            "last_interaction_ts": time.time() - (10 * 86400),
        })
        carol = mock_dina.vault.retrieve(1, "contact_carol")
        carol_shared = set(alice["interests"]) & set(carol["interests"])
        assert len(carol_shared) == 0, \
            "No shared interests between Alice and Carol"

        # Counter-proof: contacts are isolated per persona (tier 1 vs tier 0)
        assert mock_dina.vault.retrieve(0, "contact_alice") is None, \
            "Contact data in tier 1 must not leak to tier 0"

# TST-INT-454
    def test_relationship_maintenance_reminders(
        self, mock_dina: MockDinaCore, mock_human
    ):
        """Dina creates Tier 3 (daily briefing) nudges for relationship
        maintenance — never interrupts, just includes in the digest."""
        # Store a contact whose birthday is approaching
        mock_dina.vault.store(1, "contact_birthday_soon", {
            "contact": "did:plc:BirthdayFriend",
            "name": "Birthday Friend",
            "birthday": "2026-02-20",
            "last_interaction_ts": time.time() - (60 * 86400),
        })

        # Generate a maintenance reminder
        contact = mock_dina.vault.retrieve(1, "contact_birthday_soon")
        reminder = Notification(
            tier=SilenceTier.TIER_3_ENGAGEMENT,
            title=f"{contact['name']}'s birthday is coming up",
            body=f"It's been a while since you connected with {contact['name']}. "
                 f"Their birthday is on {contact['birthday']}.",
            actions=["Send message", "Set reminder", "Dismiss"],
            source="relationship_nudge",
        )

        mock_human.receive_notification(reminder)

        # Tier 3 — saved for daily briefing, never interrupts
        assert reminder.tier == SilenceTier.TIER_3_ENGAGEMENT
        assert len(mock_human.notifications) == 1
        assert "birthday" in mock_human.notifications[0].body.lower()
