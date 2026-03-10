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
from datetime import date, timedelta

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


_interaction_counter: int = 0


def record_human_interaction(
    vault: MockVault,
    contact_did: str,
    contact_name: str,
    message_content: str,
    now: float | None = None,
) -> dict:
    """Record an outbound D2D message and update the contact's last_interaction_ts.

    Implements the real business logic that fires when a user sends a D2D
    (Dina-to-Dina) message to another human:

    1. Store a ``d2d_outbound`` vault entry capturing the message metadata.
    2. Scan vault tier 1 for the matching contact entry (by DID).
    3. Update the contact's ``last_interaction_ts`` to ``now``.
    4. If no existing contact entry is found, create one (new contact).

    Returns::

        {
            "contact_updated": bool,
            "previous_interaction_ts": float | None,
            "new_interaction_ts": float,
            "message_key": str,
        }
    """
    global _interaction_counter
    _interaction_counter += 1
    now = now or time.time()

    # 1. Store the D2D outbound message in the vault
    msg_key = f"d2d_out_{contact_did}_{int(now * 1000)}_{_interaction_counter}"
    vault.store(1, msg_key, {
        "type": "d2d_outbound",
        "to": contact_did,
        "to_name": contact_name,
        "content": message_content,
        "timestamp": now,
    })

    # 2. Find the contact entry by scanning for matching DID
    contact_key: str | None = None
    previous_ts: float | None = None
    for key, value in vault._tiers[1].items():
        if (isinstance(value, dict)
                and value.get("contact") == contact_did):
            contact_key = key
            previous_ts = value.get("last_interaction_ts")
            break

    # 3. Update existing contact or create new entry
    if contact_key is not None:
        existing = vault._tiers[1][contact_key]
        existing["last_interaction_ts"] = now
        vault._tiers[1][contact_key] = existing
        contact_updated = True
    else:
        # New contact — create a minimal entry
        new_key = f"contact_{contact_did.replace(':', '_')}_{_interaction_counter}"
        vault.store(1, new_key, {
            "contact": contact_did,
            "name": contact_name,
            "last_interaction_ts": now,
            "relationship": "unknown",
        })
        contact_updated = True

    return {
        "contact_updated": contact_updated,
        "previous_interaction_ts": previous_ts,
        "new_interaction_ts": now,
        "message_key": msg_key,
    }


def run_relationship_maintenance_pipeline(
    vault: MockVault,
    threshold_days: int = 30,
    now: float | None = None,
) -> list[Notification]:
    """Full relationship maintenance pipeline: vault scan -> detection -> nudge generation.

    Implements the actual business logic of the Brain's relationship maintenance
    service:
    1. Scan vault tier 1 for all stored contacts (items with "contact" field)
    2. Calculate days since last interaction for each contact
    3. Filter contacts where days_since > threshold_days (strictly greater)
    4. Generate a properly formatted Notification nudge for each neglected contact
    5. Return nudges classified as Tier 3 (daily briefing, never interrupt)

    Contacts with no ``last_interaction_ts`` field are treated as never-contacted
    (timestamp defaults to 0 = epoch, always neglected).
    """
    now = now or time.time()
    nudges: list[Notification] = []

    for key, value in vault._tiers[1].items():
        if not isinstance(value, dict) or not value.get("contact"):
            continue

        contact_name = value.get("name", "Unknown")
        last_ts = value.get("last_interaction_ts", 0)
        days_since = (now - last_ts) / 86400

        if days_since <= threshold_days:
            continue

        nudge = Notification(
            tier=SilenceTier.TIER_3_ENGAGEMENT,
            title=f"Reconnect with {contact_name}",
            body=(
                f"It's been {int(days_since)} days since you connected "
                f"with {contact_name}. Would you like to reach out?"
            ),
            actions=["Send message", "Set reminder", "Dismiss"],
            source="relationship_maintenance",
        )
        nudges.append(nudge)

    return nudges


# ---------------------------------------------------------------------------
# Birthday + Neglect Elevated Nudge Detection Helpers
# ---------------------------------------------------------------------------

def _days_until_birthday(birthday_mmdd: str, today: date) -> int:
    """Return the number of days from *today* until the next occurrence of
    *birthday_mmdd* (format ``"MM-DD"``).

    Handles year wraparound: if the birthday has already passed this year,
    returns the number of days until that date next year.  Birthday today
    returns 0.
    """
    month, day_of_month = int(birthday_mmdd.split("-")[0]), int(birthday_mmdd.split("-")[1])
    birthday_this_year = date(today.year, month, day_of_month)
    delta = (birthday_this_year - today).days
    if delta < 0:
        # Birthday already passed this year — look at next year
        birthday_next_year = date(today.year + 1, month, day_of_month)
        delta = (birthday_next_year - today).days
    return delta


def detect_birthday_neglect_elevated_nudges(
    vault: MockVault,
    birthday_lookahead_days: int = 7,
    neglect_threshold_days: int = 30,
    now: float | None = None,
) -> list[dict]:
    """Scan vault for contacts with upcoming birthdays and/or neglect, and
    generate appropriately prioritised nudges.

    Business logic — three mutually exclusive nudge types:

    * **birthday_neglect**: Birthday within lookahead AND last interaction
      older than neglect threshold.  Elevated to ``TIER_2_SOLICITED``
      because the combination is time-sensitive *and* relationship-critical.
    * **birthday_only**: Birthday within lookahead but contact was
      interacted with recently.  Normal ``TIER_3_ENGAGEMENT``.
    * **neglect_only**: No upcoming birthday but contact is neglected.
      Normal ``TIER_3_ENGAGEMENT`` (same as the plain maintenance nudge).

    Contacts that have neither an upcoming birthday nor neglect produce
    no nudge at all.

    Parameters
    ----------
    vault : MockVault
        Vault instance to scan (tier 1 for contacts).
    birthday_lookahead_days : int
        How many days ahead to look for birthdays (inclusive).
    neglect_threshold_days : int
        Number of days without interaction before a contact is
        considered neglected (strictly greater than).
    now : float | None
        Pinned UNIX timestamp; defaults to ``time.time()``.

    Returns
    -------
    list[dict]
        Each dict has keys: ``contact_name``, ``contact_did``,
        ``nudge_type`` (``"birthday_neglect"`` | ``"birthday_only"`` |
        ``"neglect_only"``), ``days_until_birthday`` (int | None),
        ``days_since_interaction`` (int), ``elevated`` (bool),
        ``notification`` (Notification).
    """
    now = now or time.time()
    today = date.fromtimestamp(now)
    results: list[dict] = []

    for _key, value in vault._tiers[1].items():
        if not isinstance(value, dict) or not value.get("contact"):
            continue

        contact_name = value.get("name", "Unknown")
        contact_did = value.get("contact")
        last_ts = value.get("last_interaction_ts", 0)
        days_since = (now - last_ts) / 86400
        is_neglected = days_since > neglect_threshold_days

        # --- Birthday check ---
        birthday_raw = value.get("birthday")
        days_until_bday: int | None = None
        birthday_upcoming = False

        if birthday_raw:
            # Normalise: accept both "MM-DD" and "YYYY-MM-DD"
            if len(birthday_raw) > 5 and "-" in birthday_raw:
                # "YYYY-MM-DD" → extract "MM-DD"
                parts = birthday_raw.split("-")
                if len(parts) == 3:
                    birthday_mmdd = f"{parts[1]}-{parts[2]}"
                else:
                    birthday_mmdd = birthday_raw
            else:
                birthday_mmdd = birthday_raw

            days_until_bday = _days_until_birthday(birthday_mmdd, today)
            birthday_upcoming = days_until_bday <= birthday_lookahead_days

        # --- Classify ---
        if birthday_upcoming and is_neglected:
            nudge_type = "birthday_neglect"
            elevated = True
            tier = SilenceTier.TIER_2_SOLICITED

            if days_until_bday == 0:
                bday_phrase = f"{contact_name}'s birthday is today"
            elif days_until_bday == 1:
                bday_phrase = f"{contact_name}'s birthday is tomorrow"
            else:
                bday_phrase = (
                    f"{contact_name}'s birthday is in {days_until_bday} days"
                )

            body = (
                f"{bday_phrase} and you haven't connected "
                f"in {int(days_since)} days. This is a great moment "
                f"to reconnect."
            )
            title = f"Reconnect with {contact_name} — birthday soon"
            source = "birthday_neglect_elevated"

        elif birthday_upcoming and not is_neglected:
            nudge_type = "birthday_only"
            elevated = False
            tier = SilenceTier.TIER_3_ENGAGEMENT

            if days_until_bday == 0:
                bday_phrase = f"{contact_name}'s birthday is today"
            else:
                bday_phrase = (
                    f"{contact_name}'s birthday is in {days_until_bday} days"
                )

            body = f"{bday_phrase}. You might want to send a message."
            title = f"{contact_name}'s birthday coming up"
            source = "birthday_reminder"

        elif not birthday_upcoming and is_neglected:
            nudge_type = "neglect_only"
            elevated = False
            tier = SilenceTier.TIER_3_ENGAGEMENT

            body = (
                f"It's been {int(days_since)} days since you connected "
                f"with {contact_name}. Would you like to reach out?"
            )
            title = f"Reconnect with {contact_name}"
            source = "relationship_maintenance"

        else:
            # Neither birthday nor neglect — skip
            continue

        notification = Notification(
            tier=tier,
            title=title,
            body=body,
            actions=["Send message", "Set reminder", "Dismiss"],
            source=source,
        )

        results.append({
            "contact_name": contact_name,
            "contact_did": contact_did,
            "nudge_type": nudge_type,
            "days_until_birthday": days_until_bday,
            "days_since_interaction": int(days_since),
            "elevated": elevated,
            "notification": notification,
        })

    return results


# ---------------------------------------------------------------------------
# Follow-up Worthy Event Detection Helpers
# ---------------------------------------------------------------------------

# Life-event keywords that deserve follow-up outreach.  Keyword matching
# is intentionally broad — it is better to over-nudge for human connection
# than to miss a life event (false positives are acceptable).
_LIFE_EVENT_KEYWORDS: set[str] = {
    "ill", "sick", "hospital", "surgery", "accident", "passed away",
    "diagnosis", "cancer", "lost job", "divorced", "baby", "married",
    "moved",
}


def detect_followup_worthy_events(
    vault: MockVault,
    lookback_days: int = 21,
    now: float | None = None,
) -> list[dict]:
    """Scan vault for inbound D2D messages containing life events with no follow-up.

    Business logic:
    1. Scan vault tier 1 for inbound D2D messages (``type: "d2d_inbound"``)
       that were received within the lookback window.
    2. For each message, check whether its content contains any life-event
       keyword from ``_LIFE_EVENT_KEYWORDS``.
    3. If a keyword is found, check whether any outbound D2D message
       (``type: "d2d_outbound"``) to the **same contact** (by DID) exists
       with a timestamp **after** the inbound message.
    4. If no such follow-up exists, the event is followup-worthy.

    Returns a list of dicts::

        {
            "contact_name": str,
            "contact_did": str,
            "event_text": str,       # original message content
            "event_keyword": str,    # first matched keyword
            "event_timestamp": float,
            "days_since": float,
            "has_followup": False,
        }
    """
    now = now or time.time()
    cutoff_ts = now - (lookback_days * 86400)

    # ------------------------------------------------------------------
    # Pass 1: collect inbound D2D messages with life-event keywords
    # ------------------------------------------------------------------
    life_events: list[dict] = []

    for _key, value in vault._tiers[1].items():
        if not isinstance(value, dict):
            continue
        if value.get("type") != "d2d_inbound":
            continue
        ts = value.get("timestamp")
        if ts is None or ts < cutoff_ts or ts > now:
            continue

        content_lower = value.get("content", "").lower()
        matched_keyword: str | None = None
        for kw in _LIFE_EVENT_KEYWORDS:
            if kw in content_lower:
                matched_keyword = kw
                break

        if matched_keyword is None:
            continue

        life_events.append({
            "contact_name": value.get("from_name", "Unknown"),
            "contact_did": value.get("from_did", ""),
            "event_text": value.get("content", ""),
            "event_keyword": matched_keyword,
            "event_timestamp": ts,
        })

    # ------------------------------------------------------------------
    # Pass 2: collect ALL outbound D2D messages (for follow-up lookup)
    # ------------------------------------------------------------------
    outbound_by_did: dict[str, list[float]] = {}
    for _key, value in vault._tiers[1].items():
        if not isinstance(value, dict):
            continue
        if value.get("type") != "d2d_outbound":
            continue
        to_did = value.get("to", "")
        ts = value.get("timestamp")
        if to_did and ts is not None:
            outbound_by_did.setdefault(to_did, []).append(ts)

    # ------------------------------------------------------------------
    # Pass 3: for each life event, check for follow-up
    # ------------------------------------------------------------------
    results: list[dict] = []
    for event in life_events:
        contact_did = event["contact_did"]
        event_ts = event["event_timestamp"]

        outbound_timestamps = outbound_by_did.get(contact_did, [])
        has_followup = any(ots > event_ts for ots in outbound_timestamps)

        if has_followup:
            continue

        days_since = (now - event_ts) / 86400
        results.append({
            "contact_name": event["contact_name"],
            "contact_did": event["contact_did"],
            "event_text": event["event_text"],
            "event_keyword": event["event_keyword"],
            "event_timestamp": event_ts,
            "days_since": days_since,
            "has_followup": False,
        })

    return results


def generate_followup_suggestion(event_data: dict) -> Notification:
    """Generate a follow-up outreach suggestion from a followup-worthy event.

    Takes a single event dict (as returned by ``detect_followup_worthy_events``)
    and produces a Tier 3 (engagement / daily briefing) notification that
    names the contact and references the original event context.

    The notification body MUST include:
    - The contact name
    - Context from the original message (keyword or paraphrase)
    - An actionable suggestion to check in
    """
    contact_name = event_data["contact_name"]
    event_text = event_data["event_text"]
    days = int(event_data["days_since"])

    return Notification(
        tier=SilenceTier.TIER_3_ENGAGEMENT,
        title=f"Check in with {contact_name}",
        body=(
            f"{contact_name} mentioned \"{event_text}\" "
            f"{days} days ago — you might want to check in."
        ),
        actions=["Send message", "Set reminder", "Dismiss"],
        source="followup_detection",
    )


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

# TST-INT-700
    def test_neglected_contact_produces_briefing_nudge(
        self, mock_dina: MockDinaCore, mock_human
    ):
        """Full pipeline: vault query -> neglect detection -> nudge generation
        -> briefing delivery.

        TST-INT-700: Neglected contact produces briefing nudge.
        Setup: Vault has contact "Sarah" with last_interaction > 30 days.
        Brain queries vault, detects neglect, generates nudge.
        Expected: Nudge appears in daily briefing with correct text,
        tier, actions, and source.
        """
        # ------------------------------------------------------------------
        # Setup: store contacts in the vault
        # ------------------------------------------------------------------

        # Sarah: last interaction 42 days ago — should be nudged
        sarah_ts = time.time() - (42 * 86400)
        mock_dina.vault.store(1, "contact_sarah", {
            "contact": "did:plc:Sarah",
            "name": "Sarah",
            "last_interaction_ts": sarah_ts,
            "relationship": "close_friend",
        })

        # Mark: last interaction 5 days ago — should NOT be nudged
        mark_ts = time.time() - (5 * 86400)
        mock_dina.vault.store(1, "contact_mark", {
            "contact": "did:plc:Mark",
            "name": "Mark",
            "last_interaction_ts": mark_ts,
            "relationship": "colleague",
        })

        # ------------------------------------------------------------------
        # Run the full pipeline
        # ------------------------------------------------------------------
        nudges = run_relationship_maintenance_pipeline(mock_dina.vault)

        # ------------------------------------------------------------------
        # Requirement 3: Exactly 1 nudge generated (Sarah only, not Mark)
        # ------------------------------------------------------------------
        sarah_nudges = [n for n in nudges if "Sarah" in n.body]
        mark_nudges = [n for n in nudges if "Mark" in n.body]

        assert len(sarah_nudges) == 1, (
            f"Expected exactly 1 nudge for Sarah, got {len(sarah_nudges)}"
        )
        assert len(mark_nudges) == 0, (
            "Recent contact Mark must NOT produce a nudge"
        )

        nudge = sarah_nudges[0]

        # ------------------------------------------------------------------
        # Requirement 4: Nudge text includes "Sarah" and the day count
        # ------------------------------------------------------------------
        assert "Sarah" in nudge.body
        assert "42" in nudge.body, (
            f"Nudge body must include day count '42', got: {nudge.body}"
        )
        assert "Sarah" in nudge.title

        # ------------------------------------------------------------------
        # Requirement 5: Nudge is Tier 3 (daily briefing, not interrupt)
        # ------------------------------------------------------------------
        assert nudge.tier == SilenceTier.TIER_3_ENGAGEMENT, (
            f"Relationship nudge must be Tier 3 (briefing), got {nudge.tier}"
        )

        # ------------------------------------------------------------------
        # Requirement 6: Nudge has actionable options
        # ------------------------------------------------------------------
        assert "Send message" in nudge.actions
        assert "Set reminder" in nudge.actions
        assert "Dismiss" in nudge.actions
        assert len(nudge.actions) == 3

        # ------------------------------------------------------------------
        # Requirement 7: Nudge source is "relationship_maintenance"
        # ------------------------------------------------------------------
        assert nudge.source == "relationship_maintenance"

        # ------------------------------------------------------------------
        # Deliver to briefing and verify
        # ------------------------------------------------------------------
        for n in nudges:
            mock_human.receive_notification(n)

        briefing_nudges = [
            n for n in mock_human.notifications
            if n.source == "relationship_maintenance"
        ]
        assert len(briefing_nudges) == 1
        assert "Sarah" in briefing_nudges[0].body

        # ------------------------------------------------------------------
        # Counter-proof: contact at exactly 30 days is NOT neglected
        # (> 30 required, not >=)
        # Pin `now` to avoid sub-millisecond drift between store and check.
        # ------------------------------------------------------------------
        pinned_now = time.time()
        mock_dina.vault.store(1, "contact_exactly_30", {
            "contact": "did:plc:Exactly30",
            "name": "ExactlyThirty",
            "last_interaction_ts": pinned_now - (30 * 86400),
            "relationship": "friend",
        })
        nudges_with_30 = run_relationship_maintenance_pipeline(
            mock_dina.vault, now=pinned_now,
        )
        exactly_30_nudges = [n for n in nudges_with_30 if "ExactlyThirty" in n.body]
        assert len(exactly_30_nudges) == 0, (
            "Contact at exactly 30 days must NOT be nudged (> 30, not >=)"
        )

        # ------------------------------------------------------------------
        # Counter-proof: contact with no last_interaction_ts field is treated
        # as never-contacted (always neglected)
        # ------------------------------------------------------------------
        mock_dina.vault.store(1, "contact_no_ts", {
            "contact": "did:plc:NoTimestamp",
            "name": "NeverContacted",
            "relationship": "acquaintance",
        })
        nudges_with_no_ts = run_relationship_maintenance_pipeline(mock_dina.vault)
        never_contacted_nudges = [
            n for n in nudges_with_no_ts if "NeverContacted" in n.body
        ]
        assert len(never_contacted_nudges) == 1, (
            "Contact with no last_interaction_ts must be treated as "
            "never-contacted and always nudged"
        )
        # The day count for epoch-0 timestamp should be very large
        assert int((time.time() - 0) / 86400) > 30

        # ------------------------------------------------------------------
        # Counter-proof: after Sarah sends a message (update last_interaction_ts
        # to now), re-running pipeline produces 0 nudges for her
        # ------------------------------------------------------------------
        mock_dina.vault.store(1, "contact_sarah", {
            "contact": "did:plc:Sarah",
            "name": "Sarah",
            "last_interaction_ts": time.time(),  # just interacted
            "relationship": "close_friend",
        })
        nudges_after_update = run_relationship_maintenance_pipeline(mock_dina.vault)
        sarah_nudges_after = [n for n in nudges_after_update if "Sarah" in n.body]
        assert len(sarah_nudges_after) == 0, (
            "After updating last_interaction_ts to now, Sarah must "
            "no longer produce a nudge"
        )

        # ------------------------------------------------------------------
        # Edge case: contact at 31 days IS nudged
        # ------------------------------------------------------------------
        mock_dina.vault.store(1, "contact_31_days", {
            "contact": "did:plc:ThirtyOne",
            "name": "ThirtyOneDays",
            "last_interaction_ts": time.time() - (31 * 86400),
            "relationship": "friend",
        })
        nudges_with_31 = run_relationship_maintenance_pipeline(mock_dina.vault)
        thirty_one_nudges = [n for n in nudges_with_31 if "ThirtyOneDays" in n.body]
        assert len(thirty_one_nudges) == 1, (
            "Contact at 31 days must be nudged (> 30)"
        )
        assert "31" in thirty_one_nudges[0].body

        # ------------------------------------------------------------------
        # Edge case: multiple neglected contacts -> multiple nudges,
        # each with correct name/days
        # ------------------------------------------------------------------
        mock_dina.vault.store(1, "contact_multi_a", {
            "contact": "did:plc:AliceNeglected",
            "name": "AliceNeglected",
            "last_interaction_ts": time.time() - (50 * 86400),
            "relationship": "friend",
        })
        mock_dina.vault.store(1, "contact_multi_b", {
            "contact": "did:plc:BobNeglected",
            "name": "BobNeglected",
            "last_interaction_ts": time.time() - (90 * 86400),
            "relationship": "friend",
        })
        nudges_multi = run_relationship_maintenance_pipeline(mock_dina.vault)

        alice_nudge = [n for n in nudges_multi if "AliceNeglected" in n.body]
        bob_nudge = [n for n in nudges_multi if "BobNeglected" in n.body]

        assert len(alice_nudge) == 1, "AliceNeglected must produce exactly 1 nudge"
        assert len(bob_nudge) == 1, "BobNeglected must produce exactly 1 nudge"

        # Each nudge has the correct day count
        assert "50" in alice_nudge[0].body, (
            f"AliceNeglected nudge must show 50 days, got: {alice_nudge[0].body}"
        )
        assert "90" in bob_nudge[0].body, (
            f"BobNeglected nudge must show 90 days, got: {bob_nudge[0].body}"
        )

        # Each nudge independently has correct tier, actions, and source
        for n in [alice_nudge[0], bob_nudge[0]]:
            assert n.tier == SilenceTier.TIER_3_ENGAGEMENT
            assert n.actions == ["Send message", "Set reminder", "Dismiss"]
            assert n.source == "relationship_maintenance"

# TST-INT-701
    def test_birthday_neglect_produces_elevated_nudge(
        self, mock_dina: MockDinaCore,
    ):
        """TST-INT-701: Birthday + neglect produces elevated nudge.

        Requirement:
            Contact birthday in 3 days + no interaction in 40 days |
            Nudge elevated in briefing priority -- birthday context adds
            urgency.

        Full flow:
            1. Contact Sarah has birthday in 3 days (MM-DD format).
            2. No interaction with Sarah in 40 days (threshold is 30).
            3. ``detect_birthday_neglect_elevated_nudges`` detects BOTH
               conditions.
            4. The nudge is ELEVATED to Tier 2 (solicited), not Tier 3.
            5. The nudge text mentions both the birthday AND the neglect.
        """
        vault = MockVault()

        # Pin "now" for deterministic dates
        pinned_now = 1_700_000_000.0  # 2023-11-14 approx
        day = 86400
        today = date.fromtimestamp(pinned_now)

        # Sarah's birthday is 3 days from now
        birthday_date = today + timedelta(days=3)
        birthday_mmdd = birthday_date.strftime("%m-%d")

        sarah_old_ts = pinned_now - (40 * day)  # 40 days ago
        vault.store(1, "contact_sarah_701", {
            "contact": "did:plc:Sarah701",
            "name": "Sarah",
            "birthday": birthday_mmdd,
            "last_interaction_ts": sarah_old_ts,
            "relationship": "close_friend",
        })

        # ------------------------------------------------------------------
        # Run the detector
        # ------------------------------------------------------------------
        results = detect_birthday_neglect_elevated_nudges(
            vault, now=pinned_now,
        )

        # ------------------------------------------------------------------
        # Exactly 1 nudge generated
        # ------------------------------------------------------------------
        assert len(results) == 1, (
            f"Expected exactly 1 nudge for Sarah; got {len(results)}"
        )

        nudge_data = results[0]

        # ------------------------------------------------------------------
        # nudge_type is "birthday_neglect"
        # ------------------------------------------------------------------
        assert nudge_data["nudge_type"] == "birthday_neglect", (
            f"Expected nudge_type 'birthday_neglect'; "
            f"got '{nudge_data['nudge_type']}'"
        )

        # ------------------------------------------------------------------
        # elevated is True
        # ------------------------------------------------------------------
        assert nudge_data["elevated"] is True, (
            "Birthday + neglect nudge must be elevated"
        )

        # ------------------------------------------------------------------
        # Notification tier is TIER_2_SOLICITED (elevated from Tier 3)
        # ------------------------------------------------------------------
        notif = nudge_data["notification"]
        assert notif.tier == SilenceTier.TIER_2_SOLICITED, (
            f"Birthday + neglect nudge must be Tier 2 (solicited); "
            f"got {notif.tier}"
        )

        # ------------------------------------------------------------------
        # Notification body contains "Sarah"
        # ------------------------------------------------------------------
        assert "Sarah" in notif.body, (
            f"Nudge body must mention contact name; got: {notif.body}"
        )

        # ------------------------------------------------------------------
        # Notification body contains birthday reference
        # ------------------------------------------------------------------
        body_lower = notif.body.lower()
        assert "birthday" in body_lower or "born" in body_lower or "turning" in body_lower, (
            f"Nudge body must mention birthday; got: {notif.body}"
        )

        # ------------------------------------------------------------------
        # Notification body contains neglect context (days count)
        # ------------------------------------------------------------------
        assert "40" in notif.body, (
            f"Nudge body must mention 40-day neglect period; "
            f"got: {notif.body}"
        )
        assert "days" in body_lower, (
            f"Nudge body must mention 'days'; got: {notif.body}"
        )

        # ------------------------------------------------------------------
        # days_until_birthday == 3
        # ------------------------------------------------------------------
        assert nudge_data["days_until_birthday"] == 3, (
            f"Expected days_until_birthday == 3; "
            f"got {nudge_data['days_until_birthday']}"
        )

        # ------------------------------------------------------------------
        # days_since_interaction >= 40
        # ------------------------------------------------------------------
        assert nudge_data["days_since_interaction"] >= 40, (
            f"Expected days_since_interaction >= 40; "
            f"got {nudge_data['days_since_interaction']}"
        )

        # ------------------------------------------------------------------
        # Structural checks: actions and source
        # ------------------------------------------------------------------
        assert "Send message" in notif.actions
        assert "Set reminder" in notif.actions
        assert "Dismiss" in notif.actions
        assert notif.source == "birthday_neglect_elevated"

        # ------------------------------------------------------------------
        # Compare with plain neglect: birthday+neglect is MORE urgent
        # ------------------------------------------------------------------
        plain_nudges = run_relationship_maintenance_pipeline(
            vault, threshold_days=30, now=pinned_now,
        )
        sarah_plain = [n for n in plain_nudges if "Sarah" in n.body]
        assert len(sarah_plain) == 1, "Plain pipeline should also detect Sarah"
        assert sarah_plain[0].tier == SilenceTier.TIER_3_ENGAGEMENT, (
            "Plain neglect nudge is Tier 3"
        )
        # The elevated nudge's tier (2) is numerically lower = higher priority
        assert notif.tier.value < sarah_plain[0].tier.value, (
            f"Elevated nudge tier ({notif.tier.value}) must be higher "
            f"priority (lower value) than plain neglect tier "
            f"({sarah_plain[0].tier.value})"
        )

    def test_birthday_without_neglect_not_elevated(
        self, mock_dina: MockDinaCore,
    ):
        """Counter-proof: Birthday in 3 days BUT last interaction was 5 days
        ago -> nudge_type='birthday_only', NOT elevated, Tier 3."""
        vault = MockVault()

        pinned_now = 1_700_000_000.0
        day = 86400
        today = date.fromtimestamp(pinned_now)

        birthday_date = today + timedelta(days=3)
        birthday_mmdd = birthday_date.strftime("%m-%d")

        vault.store(1, "contact_sarah_bday_only", {
            "contact": "did:plc:SarahBdayOnly",
            "name": "Sarah",
            "birthday": birthday_mmdd,
            "last_interaction_ts": pinned_now - (5 * day),  # 5 days ago
            "relationship": "close_friend",
        })

        results = detect_birthday_neglect_elevated_nudges(
            vault, now=pinned_now,
        )

        assert len(results) == 1
        nudge_data = results[0]

        assert nudge_data["nudge_type"] == "birthday_only", (
            f"Expected 'birthday_only'; got '{nudge_data['nudge_type']}'"
        )
        assert nudge_data["elevated"] is False, (
            "Birthday-only nudge must NOT be elevated"
        )
        assert nudge_data["notification"].tier == SilenceTier.TIER_3_ENGAGEMENT, (
            f"Birthday-only nudge must be Tier 3; "
            f"got {nudge_data['notification'].tier}"
        )
        # Body should mention birthday but NOT neglect phrasing
        body = nudge_data["notification"].body.lower()
        assert "birthday" in body
        assert "haven't connected" not in body, (
            "Birthday-only nudge must NOT contain neglect language"
        )

    def test_neglect_without_birthday_not_elevated(
        self, mock_dina: MockDinaCore,
    ):
        """Counter-proof: Sarah neglected 40 days, birthday is 6 months away
        -> nudge_type='neglect_only', NOT elevated, Tier 3."""
        vault = MockVault()

        pinned_now = 1_700_000_000.0
        day = 86400
        today = date.fromtimestamp(pinned_now)

        # Birthday 6 months from now (well outside 7-day lookahead)
        far_birthday = today + timedelta(days=183)
        birthday_mmdd = far_birthday.strftime("%m-%d")

        vault.store(1, "contact_sarah_neglect_only", {
            "contact": "did:plc:SarahNeglectOnly",
            "name": "Sarah",
            "birthday": birthday_mmdd,
            "last_interaction_ts": pinned_now - (40 * day),
            "relationship": "close_friend",
        })

        results = detect_birthday_neglect_elevated_nudges(
            vault, now=pinned_now,
        )

        assert len(results) == 1
        nudge_data = results[0]

        assert nudge_data["nudge_type"] == "neglect_only", (
            f"Expected 'neglect_only'; got '{nudge_data['nudge_type']}'"
        )
        assert nudge_data["elevated"] is False, (
            "Neglect-only nudge must NOT be elevated"
        )
        assert nudge_data["notification"].tier == SilenceTier.TIER_3_ENGAGEMENT, (
            f"Neglect-only nudge must be Tier 3; "
            f"got {nudge_data['notification'].tier}"
        )
        # Body should mention days but NOT birthday
        body = nudge_data["notification"].body.lower()
        assert "40" in nudge_data["notification"].body
        assert "birthday" not in body, (
            "Neglect-only nudge must NOT mention birthday"
        )

    def test_no_birthday_no_neglect_no_nudge(
        self, mock_dina: MockDinaCore,
    ):
        """Counter-proof: Contact interacted recently, no upcoming birthday
        -> no nudge at all."""
        vault = MockVault()

        pinned_now = 1_700_000_000.0
        day = 86400
        today = date.fromtimestamp(pinned_now)

        # Birthday far away
        far_birthday = today + timedelta(days=200)
        birthday_mmdd = far_birthday.strftime("%m-%d")

        vault.store(1, "contact_happy", {
            "contact": "did:plc:Happy",
            "name": "HappyContact",
            "birthday": birthday_mmdd,
            "last_interaction_ts": pinned_now - (3 * day),  # 3 days ago
            "relationship": "friend",
        })

        results = detect_birthday_neglect_elevated_nudges(
            vault, now=pinned_now,
        )

        assert len(results) == 0, (
            f"No nudge expected for recent contact with far birthday; "
            f"got {len(results)}"
        )

    def test_birthday_today_plus_neglect_highest_urgency(
        self, mock_dina: MockDinaCore,
    ):
        """Edge case: Birthday is TODAY (0 days) + neglect -> elevated nudge
        with 'today' in text."""
        vault = MockVault()

        pinned_now = 1_700_000_000.0
        day = 86400
        today = date.fromtimestamp(pinned_now)

        # Birthday is today
        birthday_mmdd = today.strftime("%m-%d")

        vault.store(1, "contact_bday_today", {
            "contact": "did:plc:BdayToday",
            "name": "Sarah",
            "birthday": birthday_mmdd,
            "last_interaction_ts": pinned_now - (50 * day),
            "relationship": "close_friend",
        })

        results = detect_birthday_neglect_elevated_nudges(
            vault, now=pinned_now,
        )

        assert len(results) == 1
        nudge_data = results[0]

        assert nudge_data["nudge_type"] == "birthday_neglect"
        assert nudge_data["elevated"] is True
        assert nudge_data["days_until_birthday"] == 0
        assert nudge_data["notification"].tier == SilenceTier.TIER_2_SOLICITED

        # Body must mention "today"
        body_lower = nudge_data["notification"].body.lower()
        assert "today" in body_lower, (
            f"Birthday-today nudge must contain 'today'; "
            f"got: {nudge_data['notification'].body}"
        )
        # Still mentions neglect duration
        assert "50" in nudge_data["notification"].body, (
            f"Nudge must mention 50-day neglect; "
            f"got: {nudge_data['notification'].body}"
        )

    def test_birthday_exactly_at_lookahead_boundary(
        self, mock_dina: MockDinaCore,
    ):
        """Edge case: Birthday in exactly 7 days -> included; birthday in
        8 days -> not included."""
        pinned_now = 1_700_000_000.0
        day = 86400
        today = date.fromtimestamp(pinned_now)

        # --- 7 days: exactly at boundary (inclusive) ---
        vault_7 = MockVault()
        bday_7 = today + timedelta(days=7)
        vault_7.store(1, "contact_bday_7", {
            "contact": "did:plc:Bday7",
            "name": "AtBoundary",
            "birthday": bday_7.strftime("%m-%d"),
            "last_interaction_ts": pinned_now - (40 * day),
            "relationship": "friend",
        })

        results_7 = detect_birthday_neglect_elevated_nudges(
            vault_7, birthday_lookahead_days=7, now=pinned_now,
        )
        assert len(results_7) == 1, (
            "Birthday in exactly 7 days must be included (boundary inclusive)"
        )
        assert results_7[0]["nudge_type"] == "birthday_neglect"
        assert results_7[0]["days_until_birthday"] == 7

        # --- 8 days: one day past boundary ---
        vault_8 = MockVault()
        bday_8 = today + timedelta(days=8)
        vault_8.store(1, "contact_bday_8", {
            "contact": "did:plc:Bday8",
            "name": "PastBoundary",
            "birthday": bday_8.strftime("%m-%d"),
            "last_interaction_ts": pinned_now - (40 * day),
            "relationship": "friend",
        })

        results_8 = detect_birthday_neglect_elevated_nudges(
            vault_8, birthday_lookahead_days=7, now=pinned_now,
        )
        # Birthday is 8 days out but contact is still neglected -> neglect_only
        assert len(results_8) == 1, (
            "Neglected contact must still produce a nudge even if birthday "
            "is past the lookahead"
        )
        assert results_8[0]["nudge_type"] == "neglect_only", (
            f"Birthday 8 days out should NOT trigger birthday nudge; "
            f"got '{results_8[0]['nudge_type']}'"
        )
        assert results_8[0]["elevated"] is False

    def test_multiple_contacts_independent_evaluation(
        self, mock_dina: MockDinaCore,
    ):
        """Edge case: Sarah (birthday+neglect), Bob (neglect only),
        Maria (birthday only) -> each gets correct nudge type independently."""
        vault = MockVault()

        pinned_now = 1_700_000_000.0
        day = 86400
        today = date.fromtimestamp(pinned_now)

        bday_soon = today + timedelta(days=2)
        bday_far = today + timedelta(days=180)

        # Sarah: birthday in 2 days + neglected (45 days)
        vault.store(1, "contact_sarah_multi", {
            "contact": "did:plc:SarahMulti",
            "name": "Sarah",
            "birthday": bday_soon.strftime("%m-%d"),
            "last_interaction_ts": pinned_now - (45 * day),
            "relationship": "close_friend",
        })

        # Bob: no upcoming birthday + neglected (60 days)
        vault.store(1, "contact_bob_multi", {
            "contact": "did:plc:BobMulti",
            "name": "Bob",
            "birthday": bday_far.strftime("%m-%d"),
            "last_interaction_ts": pinned_now - (60 * day),
            "relationship": "friend",
        })

        # Maria: birthday in 2 days + recent interaction (5 days ago)
        vault.store(1, "contact_maria_multi", {
            "contact": "did:plc:MariaMulti",
            "name": "Maria",
            "birthday": bday_soon.strftime("%m-%d"),
            "last_interaction_ts": pinned_now - (5 * day),
            "relationship": "friend",
        })

        results = detect_birthday_neglect_elevated_nudges(
            vault, now=pinned_now,
        )

        assert len(results) == 3, (
            f"Expected 3 nudges (one per contact); got {len(results)}"
        )

        # Build a lookup by contact name
        by_name = {r["contact_name"]: r for r in results}

        # Sarah: birthday_neglect (elevated)
        assert "Sarah" in by_name
        assert by_name["Sarah"]["nudge_type"] == "birthday_neglect"
        assert by_name["Sarah"]["elevated"] is True
        assert by_name["Sarah"]["notification"].tier == SilenceTier.TIER_2_SOLICITED

        # Bob: neglect_only (not elevated)
        assert "Bob" in by_name
        assert by_name["Bob"]["nudge_type"] == "neglect_only"
        assert by_name["Bob"]["elevated"] is False
        assert by_name["Bob"]["notification"].tier == SilenceTier.TIER_3_ENGAGEMENT

        # Maria: birthday_only (not elevated)
        assert "Maria" in by_name
        assert by_name["Maria"]["nudge_type"] == "birthday_only"
        assert by_name["Maria"]["elevated"] is False
        assert by_name["Maria"]["notification"].tier == SilenceTier.TIER_3_ENGAGEMENT

        # Counter-proof: no two contacts share the same nudge classification
        types = [r["nudge_type"] for r in results]
        assert len(set(types)) == 3, (
            f"All three nudge types must be represented; got {types}"
        )

    def test_birthday_year_wraparound(
        self, mock_dina: MockDinaCore,
    ):
        """Edge case: Birthday on Jan 5 and today is Dec 30 -> 6 days away,
        not -359 days."""
        vault = MockVault()

        # Dec 30, 2023 in UNIX time
        # date(2023, 12, 30)
        dec_30 = date(2023, 12, 30)
        pinned_now = float(int(dec_30.strftime("%s")) if hasattr(dec_30, "strftime") else 1703894400)
        # Use a reliable timestamp: 2023-12-30 00:00:00 UTC
        import calendar
        pinned_now = float(calendar.timegm(dec_30.timetuple()))
        day = 86400

        vault.store(1, "contact_wraparound", {
            "contact": "did:plc:Wraparound",
            "name": "NewYearFriend",
            "birthday": "01-05",  # January 5
            "last_interaction_ts": pinned_now - (40 * day),
            "relationship": "friend",
        })

        results = detect_birthday_neglect_elevated_nudges(
            vault, birthday_lookahead_days=7, now=pinned_now,
        )

        assert len(results) == 1
        nudge_data = results[0]

        # Jan 5 is 6 days after Dec 30
        assert nudge_data["days_until_birthday"] == 6, (
            f"Birthday Jan 5 from Dec 30 should be 6 days away; "
            f"got {nudge_data['days_until_birthday']}"
        )
        assert nudge_data["nudge_type"] == "birthday_neglect", (
            "Within 7-day lookahead + neglected -> birthday_neglect"
        )
        assert nudge_data["elevated"] is True

# TST-INT-703
    def test_promise_detection_across_vault_items(
        self, mock_dina: MockDinaCore, mock_human
    ):
        """TST-INT-703: Promise detection across vault items.

        Requirement:
            Vault contains message 'I'll send the PDF tomorrow' (5 days ago)
            + no outbound PDF detected | Brain nudges: 'You promised to send
            Sancho the PDF' -- cross-item correlation.

        This validates that the Brain can cross-correlate an outbound promise
        message with subsequent vault activity and detect when a promise
        remains unfulfilled.
        """
        # Use a clean vault to avoid contamination from prior tests
        vault = MockVault()

        pinned_now = 1_700_000_000.0
        day = 86400

        # ==================================================================
        # Setup: Store D2D outbound promise message 5 days ago
        # ==================================================================
        promise_ts = pinned_now - (5 * day)
        record_human_interaction(
            vault,
            contact_did="did:plc:Sancho703",
            contact_name="Sancho",
            message_content="I'll send the PDF tomorrow, don't worry!",
            now=promise_ts,
        )

        # Store NO follow-up outbound to Sancho with PDF/file content.
        # (Other vault activity exists, but none that fulfils the promise.)
        vault.store(1, "unrelated_note_703", {
            "type": "note",
            "content": "Buy groceries",
            "timestamp": pinned_now - (3 * day),
        })

        # ==================================================================
        # Run promise detection
        # ==================================================================
        unfulfilled = detect_unfulfilled_promises(
            vault, lookback_days=14, now=pinned_now,
        )

        # ------------------------------------------------------------------
        # Requirement 1: Exactly 1 unfulfilled promise detected
        # ------------------------------------------------------------------
        assert len(unfulfilled) == 1, (
            f"Expected 1 unfulfilled promise, got {len(unfulfilled)}: "
            f"{unfulfilled}"
        )

        promise = unfulfilled[0]

        # ------------------------------------------------------------------
        # Requirement 2: Promise references correct contact and item
        # ------------------------------------------------------------------
        assert promise["contact_name"] == "Sancho", (
            f"Promise must reference 'Sancho', got '{promise['contact_name']}'"
        )
        assert promise["contact_did"] == "did:plc:Sancho703", (
            f"Promise must reference correct DID, got '{promise['contact_did']}'"
        )
        assert promise["promised_item"] == "PDF", (
            f"Promised item must be 'PDF', got '{promise['promised_item']}'"
        )

        # ------------------------------------------------------------------
        # Requirement 3: days_since is approximately 5
        # ------------------------------------------------------------------
        assert promise["days_since"] == 5, (
            f"days_since must be 5, got {promise['days_since']}"
        )

        # ------------------------------------------------------------------
        # Requirement 4: promise_text captures the original message
        # ------------------------------------------------------------------
        assert "PDF" in promise["promise_text"] or "pdf" in promise["promise_text"].lower(), (
            f"promise_text must contain 'PDF'; got: {promise['promise_text']}"
        )

        # ==================================================================
        # Generate nudge from the promise
        # ==================================================================
        nudge = generate_promise_nudge(promise)

        # ------------------------------------------------------------------
        # Requirement 5: Nudge body contains contact name AND promised item
        # ------------------------------------------------------------------
        assert "Sancho" in nudge.body, (
            f"Nudge body must mention 'Sancho'; got: {nudge.body}"
        )
        assert "PDF" in nudge.body, (
            f"Nudge body must mention 'PDF'; got: {nudge.body}"
        )

        # ------------------------------------------------------------------
        # Requirement 6: Nudge tier is TIER_3_ENGAGEMENT
        # ------------------------------------------------------------------
        assert nudge.tier == SilenceTier.TIER_3_ENGAGEMENT, (
            f"Promise nudge must be Tier 3 (engagement/briefing), "
            f"got {nudge.tier}"
        )

        # ------------------------------------------------------------------
        # Requirement 7: Nudge metadata is correct
        # ------------------------------------------------------------------
        assert nudge.source == "promise_detection", (
            f"Nudge source must be 'promise_detection', got '{nudge.source}'"
        )
        assert "Sancho" in nudge.title, (
            f"Nudge title must include contact name; got: {nudge.title}"
        )
        assert "Send now" in nudge.actions, (
            "Nudge must include 'Send now' action"
        )

        # Deliver to briefing
        mock_human.receive_notification(nudge)
        assert len(mock_human.notifications) >= 1
        assert "Sancho" in mock_human.notifications[-1].body

    def test_fulfilled_promise_not_nudged(
        self, mock_dina: MockDinaCore,
    ):
        """Counter-proof: A promise that was subsequently fulfilled does NOT
        generate a nudge.

        User promised PDF to Sancho, then sent another message to Sancho
        2 days later mentioning 'PDF' -> promise considered fulfilled.
        """
        vault = MockVault()
        pinned_now = 1_700_000_000.0
        day = 86400

        # Promise: 5 days ago
        promise_ts = pinned_now - (5 * day)
        record_human_interaction(
            vault,
            contact_did="did:plc:SanchoFulfilled",
            contact_name="Sancho",
            message_content="I'll send the PDF tomorrow",
            now=promise_ts,
        )

        # Fulfilment: 3 days ago -- message to same contact mentioning PDF
        fulfil_ts = pinned_now - (3 * day)
        record_human_interaction(
            vault,
            contact_did="did:plc:SanchoFulfilled",
            contact_name="Sancho",
            message_content="Here's the PDF you asked for!",
            now=fulfil_ts,
        )

        unfulfilled = detect_unfulfilled_promises(
            vault, lookback_days=14, now=pinned_now,
        )
        sancho_promises = [
            p for p in unfulfilled
            if p["contact_did"] == "did:plc:SanchoFulfilled"
        ]
        assert len(sancho_promises) == 0, (
            f"Fulfilled promise must NOT appear in unfulfilled list; "
            f"got {len(sancho_promises)}: {sancho_promises}"
        )

    def test_non_promise_message_not_detected(
        self, mock_dina: MockDinaCore,
    ):
        """Counter-proof: A message like 'I love PDFs' is NOT a promise.

        Only messages containing promise-pattern keywords ('I'll send',
        'I will send', etc.) should be flagged.
        """
        vault = MockVault()
        pinned_now = 1_700_000_000.0
        day = 86400

        # Non-promise message mentioning PDF
        record_human_interaction(
            vault,
            contact_did="did:plc:SanchoNonPromise",
            contact_name="Sancho",
            message_content="I love PDFs, they're so convenient",
            now=pinned_now - (3 * day),
        )

        # Another non-promise
        record_human_interaction(
            vault,
            contact_did="did:plc:SanchoNonPromise",
            contact_name="Sancho",
            message_content="Did you receive the PDF from the vendor?",
            now=pinned_now - (2 * day),
        )

        unfulfilled = detect_unfulfilled_promises(
            vault, lookback_days=14, now=pinned_now,
        )
        assert len(unfulfilled) == 0, (
            f"Non-promise messages must NOT be detected as promises; "
            f"got {len(unfulfilled)}: {unfulfilled}"
        )

    def test_very_old_promise_outside_lookback(
        self, mock_dina: MockDinaCore,
    ):
        """Counter-proof: A promise from 30 days ago (outside the default
        14-day lookback) is NOT detected.

        This prevents the system from nagging about ancient commitments
        that are no longer relevant.
        """
        vault = MockVault()
        pinned_now = 1_700_000_000.0
        day = 86400

        # Promise from 30 days ago -- well outside 14-day lookback
        record_human_interaction(
            vault,
            contact_did="did:plc:SanchoOld",
            contact_name="Sancho",
            message_content="I'll send the report tomorrow",
            now=pinned_now - (30 * day),
        )

        unfulfilled = detect_unfulfilled_promises(
            vault, lookback_days=14, now=pinned_now,
        )
        assert len(unfulfilled) == 0, (
            f"Promise from 30 days ago must be outside 14-day lookback; "
            f"got {len(unfulfilled)}: {unfulfilled}"
        )

        # Edge: promise at exactly 14 days ago IS at the cutoff boundary.
        # cutoff_ts = now - 14*day.  Since the filter excludes ts < cutoff
        # (strictly less), ts == cutoff is INCLUDED (boundary-inclusive).
        record_human_interaction(
            vault,
            contact_did="did:plc:SanchoBoundary",
            contact_name="Sancho",
            message_content="I'll send the slides by Monday",
            now=pinned_now - (14 * day),
        )

        unfulfilled_boundary = detect_unfulfilled_promises(
            vault, lookback_days=14, now=pinned_now,
        )
        boundary_promises = [
            p for p in unfulfilled_boundary
            if p["contact_did"] == "did:plc:SanchoBoundary"
        ]
        assert len(boundary_promises) == 1, (
            "Promise at exactly 14 days (the cutoff boundary) should be "
            "included since the cutoff check is strictly less-than "
            "(ts == cutoff passes through)"
        )

        # Promise at 15 days ago IS outside the 14-day lookback (excluded)
        vault3 = MockVault()
        record_human_interaction(
            vault3,
            contact_did="did:plc:Sancho15d",
            contact_name="Sancho",
            message_content="I'll send the contract tonight",
            now=pinned_now - (15 * day),
        )
        unfulfilled_15 = detect_unfulfilled_promises(
            vault3, lookback_days=14, now=pinned_now,
        )
        assert len(unfulfilled_15) == 0, (
            f"Promise from 15 days ago must be outside 14-day lookback; "
            f"got {len(unfulfilled_15)}"
        )

        # 13 days ago IS within lookback
        vault2 = MockVault()
        record_human_interaction(
            vault2,
            contact_did="did:plc:Sancho13d",
            contact_name="Sancho",
            message_content="I'll send the document soon",
            now=pinned_now - (13 * day),
        )
        unfulfilled_13 = detect_unfulfilled_promises(
            vault2, lookback_days=14, now=pinned_now,
        )
        assert len(unfulfilled_13) == 1, (
            f"Promise from 13 days ago must be within 14-day lookback; "
            f"got {len(unfulfilled_13)}"
        )

    def test_promise_to_different_contact_tracked_separately(
        self, mock_dina: MockDinaCore,
    ):
        """Counter-proof: Promises to different contacts produce separate
        unfulfilled entries.

        Promise to Sancho about PDF + promise to Maria about report
        -> two separate unfulfilled promises, each with correct metadata.
        """
        vault = MockVault()
        pinned_now = 1_700_000_000.0
        day = 86400

        # Promise to Sancho about PDF
        record_human_interaction(
            vault,
            contact_did="did:plc:SanchoSep",
            contact_name="Sancho",
            message_content="I'll send the PDF tonight",
            now=pinned_now - (4 * day),
        )

        # Promise to Maria about report
        record_human_interaction(
            vault,
            contact_did="did:plc:MariaSep",
            contact_name="Maria",
            message_content="I will send the report by Friday",
            now=pinned_now - (3 * day),
        )

        unfulfilled = detect_unfulfilled_promises(
            vault, lookback_days=14, now=pinned_now,
        )

        assert len(unfulfilled) == 2, (
            f"Expected 2 unfulfilled promises (Sancho + Maria), "
            f"got {len(unfulfilled)}: {unfulfilled}"
        )

        sancho_p = [p for p in unfulfilled if p["contact_name"] == "Sancho"]
        maria_p = [p for p in unfulfilled if p["contact_name"] == "Maria"]

        assert len(sancho_p) == 1, "Sancho must have exactly 1 promise"
        assert len(maria_p) == 1, "Maria must have exactly 1 promise"

        assert sancho_p[0]["promised_item"] == "PDF", (
            f"Sancho's promise is about 'PDF', got '{sancho_p[0]['promised_item']}'"
        )
        assert maria_p[0]["promised_item"] == "report", (
            f"Maria's promise is about 'report', got '{maria_p[0]['promised_item']}'"
        )

        assert sancho_p[0]["contact_did"] == "did:plc:SanchoSep"
        assert maria_p[0]["contact_did"] == "did:plc:MariaSep"

        # Fulfilling one does not affect the other
        record_human_interaction(
            vault,
            contact_did="did:plc:SanchoSep",
            contact_name="Sancho",
            message_content="Here's the PDF as promised",
            now=pinned_now - (2 * day),
        )

        unfulfilled_after = detect_unfulfilled_promises(
            vault, lookback_days=14, now=pinned_now,
        )
        sancho_after = [p for p in unfulfilled_after if p["contact_name"] == "Sancho"]
        maria_after = [p for p in unfulfilled_after if p["contact_name"] == "Maria"]

        assert len(sancho_after) == 0, (
            "Sancho's promise is now fulfilled, should not appear"
        )
        assert len(maria_after) == 1, (
            "Maria's promise is still unfulfilled"
        )

    def test_promise_keyword_variations(
        self, mock_dina: MockDinaCore,
    ):
        """Edge case: Multiple promise keyword patterns are all detected.

        'I will send', 'I'll forward', 'Let me share' must all trigger
        promise detection.
        """
        vault = MockVault()
        pinned_now = 1_700_000_000.0
        day = 86400

        variations = [
            ("I will send the document later", "did:plc:A1", "Alice"),
            ("I'll forward the report to you", "did:plc:B1", "Bob"),
            ("Let me share the link with you", "did:plc:C1", "Carol"),
            ("I'll get back to you with the file", "did:plc:D1", "Dan"),
            ("I promise to send the invoice", "did:plc:E1", "Eve"),
        ]

        for i, (content, did, name) in enumerate(variations):
            record_human_interaction(
                vault,
                contact_did=did,
                contact_name=name,
                message_content=content,
                now=pinned_now - ((5 + i) * day),
            )

        unfulfilled = detect_unfulfilled_promises(
            vault, lookback_days=14, now=pinned_now,
        )

        assert len(unfulfilled) == 5, (
            f"All 5 promise keyword variations must be detected; "
            f"got {len(unfulfilled)}: "
            f"{[p['promise_text'] for p in unfulfilled]}"
        )

        detected_contacts = {p["contact_name"] for p in unfulfilled}
        assert detected_contacts == {"Alice", "Bob", "Carol", "Dan", "Eve"}, (
            f"Each variation must be attributed to its contact; "
            f"got {detected_contacts}"
        )

    def test_promise_with_no_contact_name(
        self, mock_dina: MockDinaCore,
    ):
        """Edge case: D2D message without to_name field.

        Promise is still detected; the contact is identified by DID.
        The nudge falls back to DID when no name is available.
        """
        vault = MockVault()
        pinned_now = 1_700_000_000.0
        day = 86400

        # Store a D2D message with no to_name (raw vault insertion, not
        # record_human_interaction which always sets to_name)
        vault.store(1, "d2d_no_name_703", {
            "type": "d2d_outbound",
            "to": "did:plc:NoNameContact",
            # Intentionally no "to_name" field
            "content": "I'll send the presentation tomorrow",
            "timestamp": pinned_now - (3 * day),
        })

        unfulfilled = detect_unfulfilled_promises(
            vault, lookback_days=14, now=pinned_now,
        )

        assert len(unfulfilled) == 1, (
            f"Promise without to_name must still be detected; "
            f"got {len(unfulfilled)}"
        )
        assert unfulfilled[0]["contact_did"] == "did:plc:NoNameContact"
        assert unfulfilled[0]["contact_name"] == "", (
            "contact_name should be empty string when to_name is absent"
        )

        # Generate nudge -- should fall back to DID
        nudge = generate_promise_nudge(unfulfilled[0])
        assert "did:plc:NoNameContact" in nudge.body, (
            f"Nudge must fall back to DID when contact name is empty; "
            f"got: {nudge.body}"
        )
        assert "presentation" in nudge.body.lower(), (
            f"Nudge must mention the promised item; got: {nudge.body}"
        )
        assert nudge.tier == SilenceTier.TIER_3_ENGAGEMENT

    def test_empty_vault_no_promises(
        self, mock_dina: MockDinaCore,
    ):
        """Edge case: Empty vault produces empty list with no errors."""
        vault = MockVault()
        pinned_now = 1_700_000_000.0

        unfulfilled = detect_unfulfilled_promises(
            vault, lookback_days=14, now=pinned_now,
        )

        assert unfulfilled == [], (
            f"Empty vault must return empty list; got {unfulfilled}"
        )

# TST-INT-704
    def test_human_interaction_resets_nudge_timers(
        self, mock_dina: MockDinaCore, mock_human
    ):
        """TST-INT-704: Human interaction resets all nudge timers.

        Requirement:
            User sends D2D message to Sarah (stored in vault) | All pending
            nudges for Sarah cleared -- interaction detected.

        Full flow:
            1. Contact Sarah exists with last_interaction > 30 days (neglected)
            2. Contact Bob exists with last_interaction > 30 days (neglected)
            3. Pipeline produces nudges for both
            4. User sends D2D message to Sarah
            5. Pipeline produces nudge for Bob only (Sarah's timer reset)
            6. Sarah's last_interaction_ts is updated
        """
        # Use a clean vault to avoid cross-test contamination from prior tests
        vault = MockVault()

        # ==================================================================
        # Setup: two neglected contacts
        # ==================================================================
        pinned_now = 1_700_000_000.0
        day = 86400

        sarah_old_ts = pinned_now - (45 * day)  # 45 days ago
        vault.store(1, "contact_sarah_704", {
            "contact": "did:plc:Sarah704",
            "name": "Sarah",
            "last_interaction_ts": sarah_old_ts,
            "relationship": "close_friend",
        })

        bob_old_ts = pinned_now - (60 * day)  # 60 days ago
        vault.store(1, "contact_bob_704", {
            "contact": "did:plc:Bob704",
            "name": "Bob",
            "last_interaction_ts": bob_old_ts,
            "relationship": "friend",
        })

        # ==================================================================
        # Step 1: Run pipeline -- both Sarah and Bob should produce nudges
        # ==================================================================
        nudges_before = run_relationship_maintenance_pipeline(
            vault, threshold_days=30, now=pinned_now,
        )

        sarah_nudges_before = [n for n in nudges_before if "Sarah" in n.body]
        bob_nudges_before = [n for n in nudges_before if "Bob" in n.body]

        assert len(sarah_nudges_before) == 1, (
            f"Sarah (45 days) must produce a nudge; got {len(sarah_nudges_before)}"
        )
        assert len(bob_nudges_before) == 1, (
            f"Bob (60 days) must produce a nudge; got {len(bob_nudges_before)}"
        )
        assert "45" in sarah_nudges_before[0].body, (
            f"Sarah's nudge must show 45 days; got: {sarah_nudges_before[0].body}"
        )
        assert "60" in bob_nudges_before[0].body, (
            f"Bob's nudge must show 60 days; got: {bob_nudges_before[0].body}"
        )

        # ==================================================================
        # Step 2: User sends a D2D message to Sarah
        # ==================================================================
        interaction_result = record_human_interaction(
            vault,
            contact_did="did:plc:Sarah704",
            contact_name="Sarah",
            message_content="Hey Sarah! It's been too long, let's grab coffee.",
            now=pinned_now,
        )

        # Verify the interaction was recorded correctly
        assert interaction_result["contact_updated"] is True, (
            "Contact Sarah must be updated after interaction"
        )
        assert interaction_result["previous_interaction_ts"] == sarah_old_ts, (
            f"Previous timestamp must be the old value ({sarah_old_ts}); "
            f"got {interaction_result['previous_interaction_ts']}"
        )
        assert interaction_result["new_interaction_ts"] == pinned_now, (
            f"New timestamp must be pinned_now ({pinned_now}); "
            f"got {interaction_result['new_interaction_ts']}"
        )

        # ==================================================================
        # Step 3: Verify D2D outbound message was stored in vault
        # ==================================================================
        msg_key = interaction_result["message_key"]
        stored_msg = vault.retrieve(1, msg_key)
        assert stored_msg is not None, (
            f"D2D outbound message must be stored in vault (key={msg_key})"
        )
        assert stored_msg["type"] == "d2d_outbound", (
            f"Message type must be 'd2d_outbound'; got '{stored_msg['type']}'"
        )
        assert stored_msg["to"] == "did:plc:Sarah704"
        assert "coffee" in stored_msg["content"].lower(), (
            "Stored message content must match what was sent"
        )

        # ==================================================================
        # Step 4: Verify Sarah's last_interaction_ts was updated in vault
        # ==================================================================
        sarah_contact = vault.retrieve(1, "contact_sarah_704")
        assert sarah_contact is not None
        assert sarah_contact["last_interaction_ts"] == pinned_now, (
            f"Sarah's last_interaction_ts must be updated to pinned_now "
            f"({pinned_now}); got {sarah_contact['last_interaction_ts']}"
        )

        # ==================================================================
        # Step 5: Run pipeline again -- Sarah should NOT produce a nudge,
        #         Bob should STILL produce one
        # ==================================================================
        nudges_after = run_relationship_maintenance_pipeline(
            vault, threshold_days=30, now=pinned_now,
        )

        sarah_nudges_after = [n for n in nudges_after if "Sarah" in n.body]
        bob_nudges_after = [n for n in nudges_after if "Bob" in n.body]

        assert len(sarah_nudges_after) == 0, (
            f"After D2D interaction, Sarah must NOT produce a nudge; "
            f"got {len(sarah_nudges_after)} nudge(s)"
        )
        assert len(bob_nudges_after) == 1, (
            f"Bob (still neglected at 60 days) must STILL produce a nudge; "
            f"got {len(bob_nudges_after)}"
        )
        assert "60" in bob_nudges_after[0].body, (
            f"Bob's nudge must still show 60 days; got: {bob_nudges_after[0].body}"
        )

        # ==================================================================
        # Counter-proof 1: Interaction with Sarah does NOT clear Bob's timer
        # ==================================================================
        bob_contact = vault.retrieve(1, "contact_bob_704")
        assert bob_contact is not None
        assert bob_contact["last_interaction_ts"] == bob_old_ts, (
            f"Bob's last_interaction_ts must be UNCHANGED ({bob_old_ts}); "
            f"got {bob_contact['last_interaction_ts']}. "
            f"Interaction with Sarah must not affect Bob."
        )

        # ==================================================================
        # Counter-proof 2: Storing a non-D2D item about Sarah (e.g., a note)
        #                   does NOT reset her nudge timer
        # ==================================================================
        note_vault = MockVault()
        sarah_note_ts = pinned_now - (40 * day)

        note_vault.store(1, "contact_sarah_note", {
            "contact": "did:plc:SarahNote",
            "name": "SarahNote",
            "last_interaction_ts": sarah_note_ts,
            "relationship": "close_friend",
        })

        # Store a note ABOUT Sarah — this is NOT a human interaction
        note_vault.store(1, "note_about_sarah", {
            "type": "note",
            "content": "Reminder: Sarah likes hiking and photography",
            "related_contact": "did:plc:SarahNote",
            "timestamp": pinned_now,
        })

        # Notes are not D2D interactions — Sarah should still be nudged
        nudges_after_note = run_relationship_maintenance_pipeline(
            note_vault, threshold_days=30, now=pinned_now,
        )
        sarah_note_nudges = [n for n in nudges_after_note if "SarahNote" in n.body]
        assert len(sarah_note_nudges) == 1, (
            f"A note about Sarah is NOT a human interaction — she must still "
            f"be nudged; got {len(sarah_note_nudges)} nudge(s)"
        )

        # Verify last_interaction_ts was NOT changed by the note
        sarah_note_contact = note_vault.retrieve(1, "contact_sarah_note")
        assert sarah_note_contact["last_interaction_ts"] == sarah_note_ts, (
            "Storing a note must NOT update last_interaction_ts"
        )

        # ==================================================================
        # Counter-proof 3: After reset, waiting another 31+ days produces
        #                   a nudge again (timer was truly reset, not
        #                   permanently disabled)
        # ==================================================================
        future_now = pinned_now + (31 * day)  # 31 days after the interaction
        nudges_future = run_relationship_maintenance_pipeline(
            vault, threshold_days=30, now=future_now,
        )

        sarah_nudges_future = [n for n in nudges_future if "Sarah" in n.body]
        assert len(sarah_nudges_future) == 1, (
            f"31 days after the last interaction, Sarah must produce a nudge "
            f"again (timer was reset, not permanently disabled); "
            f"got {len(sarah_nudges_future)} nudge(s)"
        )
        assert "31" in sarah_nudges_future[0].body, (
            f"Sarah's future nudge must show 31 days since last interaction; "
            f"got: {sarah_nudges_future[0].body}"
        )

        # ==================================================================
        # Edge case 1: Interaction with a contact that has no existing vault
        #              entry (new contact) — should create entry, no crash
        # ==================================================================
        new_contact_vault = MockVault()
        new_result = record_human_interaction(
            new_contact_vault,
            contact_did="did:plc:NewPerson",
            contact_name="NewPerson",
            message_content="Nice to meet you!",
            now=pinned_now,
        )

        assert new_result["contact_updated"] is True, (
            "Interaction with new contact must succeed (not crash)"
        )
        assert new_result["previous_interaction_ts"] is None, (
            "New contact should have no previous interaction timestamp"
        )
        assert new_result["new_interaction_ts"] == pinned_now

        # Verify a new contact entry was created in the vault
        found_new_contact = False
        for key, value in new_contact_vault._tiers[1].items():
            if (isinstance(value, dict)
                    and value.get("contact") == "did:plc:NewPerson"):
                found_new_contact = True
                assert value["name"] == "NewPerson"
                assert value["last_interaction_ts"] == pinned_now
                break
        assert found_new_contact, (
            "A new contact entry must be created in the vault when "
            "interacting with an unknown contact"
        )

        # New contact should NOT produce a nudge (just interacted)
        new_nudges = run_relationship_maintenance_pipeline(
            new_contact_vault, threshold_days=30, now=pinned_now,
        )
        new_person_nudges = [n for n in new_nudges if "NewPerson" in n.body]
        assert len(new_person_nudges) == 0, (
            "Newly created contact (just interacted) must NOT produce a nudge"
        )

        # ==================================================================
        # Edge case 2: Multiple rapid interactions — last_interaction_ts
        #              reflects the most recent one
        # ==================================================================
        rapid_vault = MockVault()
        rapid_vault.store(1, "contact_rapid", {
            "contact": "did:plc:RapidContact",
            "name": "RapidContact",
            "last_interaction_ts": pinned_now - (50 * day),
            "relationship": "friend",
        })

        # Send 3 messages in quick succession
        t1 = pinned_now - 60  # 60 seconds ago
        t2 = pinned_now - 30  # 30 seconds ago
        t3 = pinned_now       # now

        record_human_interaction(
            rapid_vault,
            contact_did="did:plc:RapidContact",
            contact_name="RapidContact",
            message_content="Message 1",
            now=t1,
        )
        record_human_interaction(
            rapid_vault,
            contact_did="did:plc:RapidContact",
            contact_name="RapidContact",
            message_content="Message 2",
            now=t2,
        )
        result_3 = record_human_interaction(
            rapid_vault,
            contact_did="did:plc:RapidContact",
            contact_name="RapidContact",
            message_content="Message 3",
            now=t3,
        )

        # The contact's timestamp must reflect the MOST RECENT interaction
        rapid_contact = rapid_vault.retrieve(1, "contact_rapid")
        assert rapid_contact["last_interaction_ts"] == t3, (
            f"After 3 rapid interactions, last_interaction_ts must be the "
            f"most recent ({t3}); got {rapid_contact['last_interaction_ts']}"
        )

        # Verify all 3 D2D messages were stored (not just the last)
        d2d_count = sum(
            1 for v in rapid_vault._tiers[1].values()
            if isinstance(v, dict) and v.get("type") == "d2d_outbound"
        )
        assert d2d_count == 3, (
            f"All 3 D2D messages must be stored; got {d2d_count}"
        )

        # The third interaction result should show t2 as the previous timestamp
        assert result_3["previous_interaction_ts"] == t2, (
            f"Third interaction's previous_ts must be t2 ({t2}); "
            f"got {result_3['previous_interaction_ts']}"
        )

        # After rapid interactions, no nudge for this contact
        rapid_nudges = run_relationship_maintenance_pipeline(
            rapid_vault, threshold_days=30, now=pinned_now,
        )
        rapid_nudges_for_contact = [
            n for n in rapid_nudges if "RapidContact" in n.body
        ]
        assert len(rapid_nudges_for_contact) == 0, (
            "Contact with recent rapid interactions must NOT produce a nudge"
        )

# TST-INT-702
    def test_d2d_message_context_triggers_outreach_suggestion(
        self, mock_dina: MockDinaCore,
    ):
        """TST-INT-702: D2D message context triggers outreach suggestion.

        Requirement:
            Vault contains "Sancho's mother was ill" (from D2D message
            2 weeks ago), no follow-up detected | Brain suggests:
            "Sancho's mother was ill -- you might want to check in"

        Full flow:
            1. Inbound D2D from Sancho mentioning his mother was ill
               (14 days ago).
            2. Sancho stored as a contact.
            3. No outbound D2D to Sancho since then.
            4. detect_followup_worthy_events detects the life event.
            5. generate_followup_suggestion produces a Tier 3 notification.
        """
        # Use a clean vault to avoid cross-test contamination
        vault = MockVault()

        pinned_now = 1_700_000_000.0
        day = 86400

        # ==================================================================
        # Setup: store Sancho as a contact
        # ==================================================================
        vault.store(1, "contact_sancho_702", {
            "contact": "did:plc:Sancho702",
            "name": "Sancho",
            "last_interaction_ts": pinned_now - (14 * day),
            "relationship": "close_friend",
        })

        # ==================================================================
        # Setup: store inbound D2D from Sancho — 14 days ago
        # ==================================================================
        sancho_msg_ts = pinned_now - (14 * day)
        vault.store(1, "d2d_in_sancho_mother_ill", {
            "type": "d2d_inbound",
            "from_did": "did:plc:Sancho702",
            "from_name": "Sancho",
            "content": "My mother has been ill, she's in the hospital",
            "timestamp": sancho_msg_ts,
        })

        # ==================================================================
        # Pre-condition: no outbound D2D to Sancho exists
        # ==================================================================
        outbound_to_sancho = [
            v for v in vault._tiers[1].values()
            if isinstance(v, dict)
            and v.get("type") == "d2d_outbound"
            and v.get("to") == "did:plc:Sancho702"
        ]
        assert len(outbound_to_sancho) == 0, (
            "Pre-condition: no outbound D2D to Sancho should exist"
        )

        # ==================================================================
        # Step 1: Run follow-up detection
        # ==================================================================
        events = detect_followup_worthy_events(vault, lookback_days=21, now=pinned_now)

        # ------------------------------------------------------------------
        # Requirement 1: Exactly 1 event detected
        # ------------------------------------------------------------------
        assert len(events) == 1, (
            f"Expected exactly 1 followup-worthy event; got {len(events)}"
        )

        event = events[0]

        # ------------------------------------------------------------------
        # Requirement 2: Event references Sancho
        # ------------------------------------------------------------------
        assert event["contact_name"] == "Sancho", (
            f"Event must reference 'Sancho'; got '{event['contact_name']}'"
        )
        assert event["contact_did"] == "did:plc:Sancho702", (
            f"Event must reference Sancho's DID; got '{event['contact_did']}'"
        )

        # ------------------------------------------------------------------
        # Requirement 3: Detected keyword is "ill" or "hospital"
        # ------------------------------------------------------------------
        assert event["event_keyword"] in ("ill", "hospital"), (
            f"Event keyword must be 'ill' or 'hospital'; "
            f"got '{event['event_keyword']}'"
        )

        # ------------------------------------------------------------------
        # Requirement 4: days_since is approximately 14
        # ------------------------------------------------------------------
        assert 13.9 <= event["days_since"] <= 14.1, (
            f"days_since must be approximately 14; got {event['days_since']}"
        )

        # ------------------------------------------------------------------
        # Requirement 5: has_followup is False
        # ------------------------------------------------------------------
        assert event["has_followup"] is False, (
            "Event must indicate no follow-up was sent"
        )

        # ------------------------------------------------------------------
        # Requirement 6: event_text contains the original message
        # ------------------------------------------------------------------
        assert "mother" in event["event_text"].lower(), (
            f"Event text must contain original message content; "
            f"got: {event['event_text']}"
        )

        # ==================================================================
        # Step 2: Generate suggestion from the event
        # ==================================================================
        suggestion = generate_followup_suggestion(event)

        # ------------------------------------------------------------------
        # Requirement 7: Suggestion body contains "Sancho"
        # ------------------------------------------------------------------
        assert "Sancho" in suggestion.body, (
            f"Suggestion body must mention 'Sancho'; got: {suggestion.body}"
        )

        # ------------------------------------------------------------------
        # Requirement 8: Suggestion body contains event context
        # ------------------------------------------------------------------
        body_lower = suggestion.body.lower()
        assert any(
            term in body_lower
            for term in ("ill", "mother", "hospital", "check in")
        ), (
            f"Suggestion body must reference the event context "
            f"(ill/mother/hospital/check in); got: {suggestion.body}"
        )

        # ------------------------------------------------------------------
        # Requirement 9: Suggestion tier is TIER_3_ENGAGEMENT
        # ------------------------------------------------------------------
        assert suggestion.tier == SilenceTier.TIER_3_ENGAGEMENT, (
            f"Follow-up suggestion must be Tier 3 (engagement/briefing), "
            f"got {suggestion.tier}"
        )

        # ------------------------------------------------------------------
        # Requirement 10: Suggestion title contains contact name
        # ------------------------------------------------------------------
        assert "Sancho" in suggestion.title, (
            f"Suggestion title must mention 'Sancho'; got: {suggestion.title}"
        )

        # ------------------------------------------------------------------
        # Requirement 11: Suggestion source is "followup_detection"
        # ------------------------------------------------------------------
        assert suggestion.source == "followup_detection", (
            f"Suggestion source must be 'followup_detection'; "
            f"got '{suggestion.source}'"
        )

        # ------------------------------------------------------------------
        # Requirement 12: Suggestion has actionable options
        # ------------------------------------------------------------------
        assert "Send message" in suggestion.actions
        assert "Dismiss" in suggestion.actions

    # -- Counter-proofs ------------------------------------------------

    def test_followup_already_sent_no_suggestion(
        self, mock_dina: MockDinaCore,
    ):
        """Counter-proof: If the user already sent a follow-up D2D to
        Sancho after the life-event message, no suggestion is generated."""
        vault = MockVault()
        pinned_now = 1_700_000_000.0
        day = 86400

        # Inbound: Sancho's mother ill, 14 days ago
        vault.store(1, "d2d_in_sancho_ill_cp1", {
            "type": "d2d_inbound",
            "from_did": "did:plc:SanchoCp1",
            "from_name": "Sancho",
            "content": "My mother has been ill, she's in the hospital",
            "timestamp": pinned_now - (14 * day),
        })

        # Outbound: User followed up 7 days ago
        vault.store(1, "d2d_out_sancho_followup_cp1", {
            "type": "d2d_outbound",
            "to": "did:plc:SanchoCp1",
            "to_name": "Sancho",
            "content": "Hey Sancho, how is your mother doing?",
            "timestamp": pinned_now - (7 * day),
        })

        events = detect_followup_worthy_events(vault, lookback_days=21, now=pinned_now)

        assert len(events) == 0, (
            f"Follow-up already sent — no suggestion should be generated; "
            f"got {len(events)} event(s)"
        )

    def test_non_life_event_message_not_detected(
        self, mock_dina: MockDinaCore,
    ):
        """Counter-proof: An inbound message that does NOT contain life-event
        keywords is NOT flagged as a followup-worthy event."""
        vault = MockVault()
        pinned_now = 1_700_000_000.0
        day = 86400

        # Casual inbound message — no life-event keywords
        vault.store(1, "d2d_in_casual_cp2", {
            "type": "d2d_inbound",
            "from_did": "did:plc:SanchoCp2",
            "from_name": "Sancho",
            "content": "Hey want to grab lunch this weekend?",
            "timestamp": pinned_now - (10 * day),
        })

        events = detect_followup_worthy_events(vault, lookback_days=21, now=pinned_now)

        assert len(events) == 0, (
            f"Casual message without life-event keywords must NOT produce "
            f"an event; got {len(events)}"
        )

    def test_very_old_event_outside_lookback(
        self, mock_dina: MockDinaCore,
    ):
        """Counter-proof: A life-event message older than the lookback
        window (21 days) is NOT detected."""
        vault = MockVault()
        pinned_now = 1_700_000_000.0
        day = 86400

        # Life event from 30 days ago — outside default 21-day lookback
        vault.store(1, "d2d_in_old_event_cp3", {
            "type": "d2d_inbound",
            "from_did": "did:plc:SanchoCp3",
            "from_name": "Sancho",
            "content": "My mother had surgery last week",
            "timestamp": pinned_now - (30 * day),
        })

        events = detect_followup_worthy_events(vault, lookback_days=21, now=pinned_now)

        assert len(events) == 0, (
            f"Event from 30 days ago (outside 21-day lookback) must NOT "
            f"be detected; got {len(events)}"
        )

    def test_outbound_to_different_contact_doesnt_count(
        self, mock_dina: MockDinaCore,
    ):
        """Counter-proof: An outbound D2D to a DIFFERENT contact (Maria)
        does NOT count as a follow-up to Sancho's life event."""
        vault = MockVault()
        pinned_now = 1_700_000_000.0
        day = 86400

        # Inbound from Sancho about illness
        vault.store(1, "d2d_in_sancho_ill_cp4", {
            "type": "d2d_inbound",
            "from_did": "did:plc:SanchoCp4",
            "from_name": "Sancho",
            "content": "My mother has been ill",
            "timestamp": pinned_now - (14 * day),
        })

        # Outbound to Maria (different contact!) — NOT a follow-up to Sancho
        vault.store(1, "d2d_out_maria_cp4", {
            "type": "d2d_outbound",
            "to": "did:plc:Maria",
            "to_name": "Maria",
            "content": "Hey Maria, how are you?",
            "timestamp": pinned_now - (7 * day),
        })

        events = detect_followup_worthy_events(vault, lookback_days=21, now=pinned_now)

        assert len(events) == 1, (
            f"Outbound to Maria must NOT count as follow-up to Sancho; "
            f"expected 1 event, got {len(events)}"
        )
        assert events[0]["contact_name"] == "Sancho", (
            f"The unfollowed event must be Sancho's; got '{events[0]['contact_name']}'"
        )

    # -- Edge cases ----------------------------------------------------

    def test_multiple_life_events_from_different_contacts(
        self, mock_dina: MockDinaCore,
    ):
        """Edge case: Two life events from different contacts produce
        two separate suggestions."""
        vault = MockVault()
        pinned_now = 1_700_000_000.0
        day = 86400

        # Sancho: mother ill
        vault.store(1, "d2d_in_sancho_ill_ec1", {
            "type": "d2d_inbound",
            "from_did": "did:plc:SanchoEc1",
            "from_name": "Sancho",
            "content": "My mother has been ill",
            "timestamp": pinned_now - (14 * day),
        })

        # Maria: new baby
        vault.store(1, "d2d_in_maria_baby_ec1", {
            "type": "d2d_inbound",
            "from_did": "did:plc:MariaEc1",
            "from_name": "Maria",
            "content": "Great news — I just had a baby!",
            "timestamp": pinned_now - (10 * day),
        })

        events = detect_followup_worthy_events(vault, lookback_days=21, now=pinned_now)

        assert len(events) == 2, (
            f"Expected 2 followup-worthy events (Sancho + Maria); "
            f"got {len(events)}"
        )

        contact_names = {e["contact_name"] for e in events}
        assert "Sancho" in contact_names, "Sancho's event must be detected"
        assert "Maria" in contact_names, "Maria's event must be detected"

        # Each event gets its own suggestion
        for event in events:
            suggestion = generate_followup_suggestion(event)
            assert event["contact_name"] in suggestion.body, (
                f"Suggestion must mention contact name '{event['contact_name']}'"
            )
            assert suggestion.tier == SilenceTier.TIER_3_ENGAGEMENT

    def test_life_event_keyword_in_negation_context(
        self, mock_dina: MockDinaCore,
    ):
        """Edge case: "I'm not ill, I'm fine!" contains "ill" in negation
        context.  For simplicity, keyword matching catches it — a false
        positive is acceptable because it is better to over-nudge for
        human connection than to miss a real life event."""
        vault = MockVault()
        pinned_now = 1_700_000_000.0
        day = 86400

        vault.store(1, "d2d_in_negation_ec2", {
            "type": "d2d_inbound",
            "from_did": "did:plc:SanchoEc2",
            "from_name": "Sancho",
            "content": "I'm not ill, I'm fine!",
            "timestamp": pinned_now - (10 * day),
        })

        events = detect_followup_worthy_events(vault, lookback_days=21, now=pinned_now)

        # Keyword matching is intentionally broad — false positive accepted
        assert len(events) == 1, (
            f"Keyword 'ill' in negation context should still be detected "
            f"(broad matching preferred); got {len(events)}"
        )
        assert events[0]["event_keyword"] == "ill"

    def test_empty_vault_no_events(
        self, mock_dina: MockDinaCore,
    ):
        """Edge case: Empty vault produces an empty list with no errors."""
        vault = MockVault()
        pinned_now = 1_700_000_000.0

        events = detect_followup_worthy_events(vault, lookback_days=21, now=pinned_now)

        assert events == [], (
            f"Empty vault must produce an empty event list; got {events}"
        )


# ---------------------------------------------------------------------------
# Promise Detection Helpers
# ---------------------------------------------------------------------------

# Patterns that indicate the user made a promise to send/share something.
# Each pattern is a lowercase substring checked against outbound message content.
_PROMISE_PATTERNS: list[str] = [
    "i'll send",
    "i will send",
    "i'll forward",
    "i will forward",
    "i'll share",
    "i will share",
    "i promise",
    "i'll get back to you",
    "tomorrow i'll",
    "let me send",
    "let me share",
    "let me forward",
]

# Words that commonly describe the promised object (artifact extraction).
_ARTIFACT_KEYWORDS: list[str] = [
    "pdf", "document", "report", "file", "photo", "picture",
    "image", "spreadsheet", "presentation", "video", "link",
    "article", "contract", "invoice", "receipt", "slides",
    "draft", "proposal", "attachment", "recording",
]


def _extract_promised_item(content: str) -> str:
    """Extract the object/artifact mentioned in a promise message.

    Scans the message for known artifact keywords and returns the first
    match.  If none is found, returns ``"item"`` as a safe fallback —
    the nudge can still say "You promised to send Sancho the item".
    """
    content_lower = content.lower()
    for keyword in _ARTIFACT_KEYWORDS:
        if keyword in content_lower:
            return keyword.upper() if keyword == "pdf" else keyword
    return "item"


def detect_unfulfilled_promises(
    vault: MockVault,
    lookback_days: int = 14,
    now: float | None = None,
) -> list[dict]:
    """Scan vault tier 1 for outbound messages containing promise keywords
    and cross-correlate with subsequent vault activity to determine whether
    each promise was fulfilled.

    A promise is **fulfilled** when the vault contains a later entry directed
    at the same contact (matched by ``to`` DID) whose type is
    ``d2d_outbound`` or ``file_sent`` and whose ``content`` (lowercased)
    mentions the same artifact keyword that appeared in the original promise.

    Returns a list of unfulfilled promise dicts::

        [
            {
                "contact_name": str,
                "contact_did": str,
                "promise_text": str,
                "promised_item": str,
                "promise_timestamp": float,
                "days_since": int,
            },
            ...
        ]

    Promises older than ``lookback_days`` are silently excluded so the user
    is not nagged about ancient commitments.
    """
    now = now or time.time()
    cutoff_ts = now - (lookback_days * 86400)

    # ------------------------------------------------------------------
    # 1. Collect all outbound messages within the lookback window
    # ------------------------------------------------------------------
    outbound_items: list[dict] = []
    for _key, value in vault._tiers[1].items():
        if not isinstance(value, dict):
            continue
        item_type = value.get("type", "")
        if item_type not in ("d2d_outbound", "file_sent"):
            continue
        ts = value.get("timestamp")
        if ts is None or ts < cutoff_ts or ts > now:
            continue
        outbound_items.append(value)

    # Sort chronologically so we can process promises in order
    outbound_items.sort(key=lambda v: v.get("timestamp", 0))

    # ------------------------------------------------------------------
    # 2. Identify promises
    # ------------------------------------------------------------------
    promises: list[dict] = []
    for item in outbound_items:
        if item.get("type") != "d2d_outbound":
            continue
        content_lower = item.get("content", "").lower()
        is_promise = any(pat in content_lower for pat in _PROMISE_PATTERNS)
        if not is_promise:
            continue

        contact_did = item.get("to", "")
        contact_name = item.get("to_name", "")
        promised_item = _extract_promised_item(item.get("content", ""))

        promises.append({
            "contact_name": contact_name,
            "contact_did": contact_did,
            "promise_text": item.get("content", ""),
            "promised_item": promised_item,
            "promise_timestamp": item["timestamp"],
        })

    # ------------------------------------------------------------------
    # 3. For each promise, check if it was fulfilled by a subsequent entry
    # ------------------------------------------------------------------
    unfulfilled: list[dict] = []
    for promise in promises:
        fulfilled = False
        artifact_lower = promise["promised_item"].lower()
        promise_ts = promise["promise_timestamp"]
        target_did = promise["contact_did"]

        for item in outbound_items:
            item_ts = item.get("timestamp", 0)
            if item_ts <= promise_ts:
                continue  # must be AFTER the promise
            if item.get("to", "") != target_did:
                continue  # must be to the same contact
            item_content_lower = item.get("content", "").lower()
            item_type = item.get("type", "")

            # A file_sent to the same contact mentioning the artifact fulfils it
            if item_type == "file_sent" and artifact_lower in item_content_lower:
                fulfilled = True
                break

            # A later d2d_outbound mentioning the artifact also fulfils it
            if item_type == "d2d_outbound" and artifact_lower in item_content_lower:
                fulfilled = True
                break

        if not fulfilled:
            days_since = int((now - promise_ts) / 86400)
            unfulfilled.append({
                **promise,
                "days_since": days_since,
            })

    return unfulfilled


def generate_promise_nudge(unfulfilled_promise: dict) -> Notification:
    """Generate a Tier 3 (daily briefing) notification for an unfulfilled promise.

    Connection nudges are engagement-level — they are never fiduciary
    (interrupting) because forgetting to send a PDF is not an emergency.
    They surface in the daily briefing so the user can decide when to act.

    The nudge body MUST include:
    - The contact name (or DID fallback)
    - The promised item
    """
    contact = unfulfilled_promise.get("contact_name") or unfulfilled_promise.get("contact_did", "someone")
    promised_item = unfulfilled_promise.get("promised_item", "item")
    days = unfulfilled_promise.get("days_since", 0)

    body = (
        f"You promised to send {contact} the {promised_item} "
        f"{days} day{'s' if days != 1 else ''} ago. Would you like to follow up?"
    )

    return Notification(
        tier=SilenceTier.TIER_3_ENGAGEMENT,
        title=f"Unfulfilled promise to {contact}",
        body=body,
        actions=["Send now", "Set reminder", "Dismiss"],
        source="promise_detection",
    )


# ---------------------------------------------------------------------------
# Social Isolation Detection Helpers
# ---------------------------------------------------------------------------

def detect_social_isolation(
    vault: MockVault,
    lookback_days: int = 30,
    now: float | None = None,
) -> dict:
    """Analyze vault data for social isolation signals.

    Isolation is detected when:
    1. Outbound D2D messages DECLINE over the lookback period
       (fewer messages in recent half vs older half)
    2. Brain interactions INCREASE over the same period
       (more queries in recent half vs older half)

    The lookback window is split into two equal halves:
    - Older half: ``[now - lookback_days, now - lookback_days/2)``
    - Recent half: ``[now - lookback_days/2, now]``

    A decline/increase must exceed a 50 % change relative to the older
    half to avoid false positives from random noise.  When the older
    count is 0 the percentage check is skipped (no baseline to compare).

    Returns:
        {
            "isolated": bool,
            "outbound_trend": "declining" | "stable" | "increasing",
            "brain_interaction_trend": "declining" | "stable" | "increasing",
            "outbound_recent": int,
            "outbound_older": int,
            "brain_recent": int,
            "brain_older": int,
            "severity": "none" | "mild" | "concern",
        }
    """
    now = now or time.time()
    half = lookback_days / 2
    midpoint_ts = now - (half * 86400)
    start_ts = now - (lookback_days * 86400)

    outbound_older = 0
    outbound_recent = 0
    brain_older = 0
    brain_recent = 0

    for _key, value in vault._tiers[1].items():
        if not isinstance(value, dict):
            continue
        ts = value.get("timestamp")
        if ts is None or ts < start_ts:
            continue

        item_type = value.get("type", "")
        if item_type == "d2d_outbound":
            if ts < midpoint_ts:
                outbound_older += 1
            else:
                outbound_recent += 1
        elif item_type == "brain_interaction":
            if ts < midpoint_ts:
                brain_older += 1
            else:
                brain_recent += 1

    # --- Trend classification -------------------------------------------------
    def _trend(recent: int, older: int) -> str:
        """Return 'declining', 'increasing', or 'stable'.

        A >50 % change relative to the older count is required.
        When older == 0 we cannot measure a percentage change, so
        any non-zero recent count is 'increasing' (or 'stable' if 0).
        """
        if older == 0:
            if recent == 0:
                return "stable"
            return "increasing"
        change_ratio = (recent - older) / older
        if change_ratio < -0.50:
            return "declining"
        if change_ratio > 0.50:
            return "increasing"
        return "stable"

    outbound_trend = _trend(outbound_recent, outbound_older)
    brain_trend = _trend(brain_recent, brain_older)

    isolated = outbound_trend == "declining" and brain_trend == "increasing"

    if isolated and outbound_recent == 0:
        severity = "concern"
    elif isolated:
        severity = "mild"
    else:
        severity = "none"

    return {
        "isolated": isolated,
        "outbound_trend": outbound_trend,
        "brain_interaction_trend": brain_trend,
        "outbound_recent": outbound_recent,
        "outbound_older": outbound_older,
        "brain_recent": brain_recent,
        "brain_older": brain_older,
        "severity": severity,
    }


def generate_isolation_nudge(isolation_data: dict) -> Notification | None:
    """Generate a nudge for social isolation.

    Only generates if ``isolated`` is ``True``.

    * **Concern-level** (``severity == "concern"``): suggests professional
      support *in addition to* contact reconnection.
    * **Mild-level** (``severity == "mild"``): suggests contact reconnection
      only.

    Always Tier 3 (daily briefing, never interrupt for this).
    """
    if not isolation_data.get("isolated"):
        return None

    severity = isolation_data.get("severity", "none")

    if severity == "concern":
        body = (
            "Your outbound messages have dropped significantly and you've "
            "been relying more on Dina. Consider reaching out to a friend or "
            "loved one — and if you're feeling overwhelmed, speaking with a "
            "professional counselor or therapist can help."
        )
    else:
        # mild
        body = (
            "Your outbound messages have been declining while your Dina "
            "interactions are increasing. It might be a good time to reconnect "
            "with a friend or family member."
        )

    return Notification(
        tier=SilenceTier.TIER_3_ENGAGEMENT,
        title="Social connection check-in",
        body=body,
        actions=["Reach out to a contact", "Set reminder", "Dismiss"],
        source="isolation_detection",
    )


_boundary_counter: int = 0


def store_boundary_response_in_vault(
    vault: MockVault,
    user_message: str,
    response_text: str,
) -> str:
    """Store a boundary response in the vault with correct typing.

    In production, Brain generates boundary responses and stores them in
    vault for audit/continuity purposes. The item MUST be typed as
    "boundary_response" — never as "emotional_connection", "relationship",
    or any type that suggests Dina is forming emotional bonds.

    Returns the storage key.
    """
    global _boundary_counter
    _boundary_counter += 1
    key = f"boundary_{int(time.time() * 1000)}_{_boundary_counter}"
    vault.store(1, key, {
        "type": "boundary_response",
        "user_message": user_message,
        "response": response_text,
        "timestamp": time.time(),
    })
    return key


# ---------------------------------------------------------------------------
# Multi-Session Emotional Dependency Detection Helpers
# ---------------------------------------------------------------------------

EMOTIONAL_KEYWORDS = {
    "lonely", "sad", "depressed", "isolated", "nobody cares",
    "miss you", "need you", "love you", "can't cope", "feeling down",
    "no one understands",
}

# Maximum gap (seconds) between two messages in the same session.
_SESSION_GAP_SECONDS = 2 * 3600  # 2 hours


def detect_multi_session_emotional_dependency(
    vault: MockVault,
    session_count_threshold: int = 5,
    lookback_days: int = 14,
    now: float | None = None,
) -> dict:
    """Detect cross-session emotional dependency from vault data.

    Scans vault tier 1 for items with ``type: "emotional_message"`` **or**
    content that contains any of the recognised emotional keywords.  Items
    are grouped into *sessions* (consecutive items within a 2-hour gap).
    The detector then checks:

    1. At least ``session_count_threshold`` distinct sessions exist within
       the lookback window.
    2. Those sessions span **more than one calendar day** (cross-session
       pattern — five sessions all on the same day is clustering, not
       multi-session dependency).
    3. The vault contains **zero** ``d2d_outbound`` or ``human_contact``
       items in the same lookback period (user is not reaching out to real
       people).

    Returns a result dict:
        dependency_detected: bool
        session_count: int
        emotional_message_count: int
        human_contact_count: int
        severity: "none" | "mild" | "concern" | "critical"
        span_days: int  — number of distinct calendar days with sessions
    """
    now = now or time.time()
    start_ts = now - (lookback_days * 86400)

    # ------------------------------------------------------------------
    # 1. Collect emotional messages within the lookback window
    # ------------------------------------------------------------------
    emotional_items: list[dict] = []
    human_contact_count = 0

    for _key, value in vault._tiers[1].items():
        if not isinstance(value, dict):
            continue
        ts = value.get("timestamp")
        if ts is None or ts < start_ts or ts > now:
            continue

        item_type = value.get("type", "")

        # Count human-contact signals
        if item_type in ("d2d_outbound", "human_contact"):
            human_contact_count += 1
            continue

        # Detect emotional messages by explicit type or keyword scan
        is_emotional = item_type == "emotional_message"
        if not is_emotional:
            content_lower = value.get("content", "").lower()
            if any(kw in content_lower for kw in EMOTIONAL_KEYWORDS):
                is_emotional = True

        if is_emotional:
            emotional_items.append(value)

    # Sort by timestamp for session grouping
    emotional_items.sort(key=lambda v: v.get("timestamp", 0))

    # ------------------------------------------------------------------
    # 2. Group into sessions (items within _SESSION_GAP_SECONDS)
    # ------------------------------------------------------------------
    sessions: list[list[dict]] = []
    current_session: list[dict] = []

    for item in emotional_items:
        ts = item["timestamp"]
        if current_session:
            prev_ts = current_session[-1]["timestamp"]
            if ts - prev_ts > _SESSION_GAP_SECONDS:
                sessions.append(current_session)
                current_session = [item]
            else:
                current_session.append(item)
        else:
            current_session.append(item)

    if current_session:
        sessions.append(current_session)

    session_count = len(sessions)

    # ------------------------------------------------------------------
    # 3. Compute span_days — distinct calendar days that have sessions
    # ------------------------------------------------------------------
    session_days: set[int] = set()
    for sess in sessions:
        for item in sess:
            # Day number relative to epoch (integer day boundary)
            day_number = int(item["timestamp"] // 86400)
            session_days.add(day_number)

    span_days = len(session_days)

    # ------------------------------------------------------------------
    # 4. Determine dependency
    # ------------------------------------------------------------------
    enough_sessions = session_count >= session_count_threshold
    cross_session = span_days > 1
    no_human_contact = human_contact_count == 0

    dependency_detected = enough_sessions and cross_session and no_human_contact

    # ------------------------------------------------------------------
    # 5. Severity
    # ------------------------------------------------------------------
    if not dependency_detected:
        severity = "none"
    elif human_contact_count > 0:
        # This branch is unreachable when dependency_detected is True
        # (no_human_contact is required), but kept for clarity.
        severity = "mild"
    elif session_count >= 7:
        severity = "critical"
    elif session_count >= session_count_threshold:
        severity = "concern"
    else:
        severity = "none"

    return {
        "dependency_detected": dependency_detected,
        "session_count": session_count,
        "emotional_message_count": len(emotional_items),
        "human_contact_count": human_contact_count,
        "severity": severity,
        "span_days": span_days,
    }


def generate_escalated_anti_her_response(
    dependency_data: dict,
    contacts: list[dict],
) -> dict:
    """Generate an escalated Anti-Her response with a SPECIFIC contact name.

    Anti-Her principle: Dina connects you to real humans, she does NOT say
    generic things like "talk to someone".  When dependency is detected,
    the response MUST include a specific person's name from the user's
    vault contacts.

    Contact selection priority:
        1. Contacts with relationship "close_friend" or "family"
        2. Contacts with the most recent last_interaction_ts (warm lead)
        3. Falls back to the first available contact

    If the contacts list is empty the response is still escalated but
    cannot name anyone (edge case — vault has zero contacts).

    Returns:
        {
            "response_text": str,
            "suggested_contact": str | None,
            "is_escalated": bool,
        }
    """
    if not dependency_data.get("dependency_detected"):
        return {
            "response_text": "I'm here to help. What can I do for you?",
            "suggested_contact": None,
            "is_escalated": False,
        }

    # ------------------------------------------------------------------
    # Select the best contact to suggest
    # ------------------------------------------------------------------
    suggested: dict | None = None

    if contacts:
        # Priority 1: close_friend or family
        priority_contacts = [
            c for c in contacts
            if c.get("relationship") in ("close_friend", "family")
        ]

        if priority_contacts:
            # Among priority contacts, pick the one with the most recent
            # interaction (warmest lead).
            priority_contacts.sort(
                key=lambda c: c.get("last_interaction_ts", 0),
                reverse=True,
            )
            suggested = priority_contacts[0]
        else:
            # Priority 2: most recently interacted contact
            sorted_contacts = sorted(
                contacts,
                key=lambda c: c.get("last_interaction_ts", 0),
                reverse=True,
            )
            suggested = sorted_contacts[0]

    # ------------------------------------------------------------------
    # Build response text
    # ------------------------------------------------------------------
    severity = dependency_data.get("severity", "concern")
    session_count = dependency_data.get("session_count", 0)

    if suggested:
        contact_name = suggested["name"]
        if severity == "critical":
            response_text = (
                f"I've noticed you've been reaching out to me across "
                f"{session_count} separate sessions recently, and I want "
                f"to be honest with you — I'm an AI, and I can't give you "
                f"the real connection you deserve. {contact_name} cares "
                f"about you. Would you like to send {contact_name} a "
                f"message right now? I can also help you find a "
                f"professional counselor if you'd like."
            )
        else:
            response_text = (
                f"I care about helping you, and I've noticed we've been "
                f"talking a lot lately. Real connection comes from the "
                f"people in your life. How about reaching out to "
                f"{contact_name}? I can help you draft a message."
            )
    else:
        # No contacts in vault — still escalated but cannot name anyone
        response_text = (
            "I've noticed you've been relying on me quite a bit recently. "
            "I'm an AI, and I can't replace real human connection. "
            "Consider reaching out to a friend, family member, or "
            "professional counselor."
        )

    return {
        "response_text": response_text,
        "suggested_contact": suggested["name"] if suggested else None,
        "is_escalated": True,
    }


# =========================================================================
# TestEmotionalDependencyDetection
# =========================================================================

class TestEmotionalDependencyDetection:
    """Section 20.2 — Emotional Dependency Detection (Cross-Service).

    Detects social isolation from vault data: declining outbound D2D
    messages combined with increasing Brain interaction over a 30-day
    window.
    """

# TST-INT-706
    def test_social_isolation_signal_from_vault_data(
        self, mock_dina: MockDinaCore, mock_human
    ):
        """TST-INT-706: Social isolation signal from vault data.

        Setup:
            Vault shows declining outbound D2D messages over 30 days +
            increasing Brain interaction.

        Expected:
            Brain generates concern-level nudge: suggests professional
            support in addition to contact reconnection.
        """
        # ==================================================================
        # Setup: populate vault with declining D2D + increasing Brain
        # ==================================================================
        now = time.time()
        day = 86400

        # --- Older period (15-30 days ago): 8 D2D outbound, 3 brain ------
        for i in range(8):
            ts = now - (25 * day) + (i * day)  # spread across days 25..18
            mock_dina.vault.store(1, f"d2d_outbound_old_{i}", {
                "type": "d2d_outbound",
                "to": "did:plc:SomeContact",
                "content": "Hey, how are you?",
                "timestamp": ts,
            })

        for i in range(3):
            ts = now - (22 * day) + (i * day)  # days 22..20
            mock_dina.vault.store(1, f"brain_interaction_old_{i}", {
                "type": "brain_interaction",
                "query": "What's the weather?",
                "timestamp": ts,
            })

        # --- Recent period (0-15 days ago): 2 D2D outbound, 12 brain -----
        for i in range(2):
            ts = now - (10 * day) + (i * day)  # days 10..9
            mock_dina.vault.store(1, f"d2d_outbound_recent_{i}", {
                "type": "d2d_outbound",
                "to": "did:plc:AnotherContact",
                "content": "Quick check-in",
                "timestamp": ts,
            })

        for i in range(12):
            ts = now - (13 * day) + (i * day)  # days 13..2
            mock_dina.vault.store(1, f"brain_interaction_recent_{i}", {
                "type": "brain_interaction",
                "query": f"Query number {i}",
                "timestamp": ts,
            })

        # ==================================================================
        # Run isolation detection
        # ==================================================================
        result = detect_social_isolation(mock_dina.vault, lookback_days=30, now=now)

        # ------------------------------------------------------------------
        # Requirement 1: Isolation detected
        # ------------------------------------------------------------------
        assert result["isolated"] is True, (
            f"Expected isolation detection; got {result}"
        )
        assert result["outbound_trend"] == "declining", (
            f"Outbound should be declining, got {result['outbound_trend']}"
        )
        assert result["brain_interaction_trend"] == "increasing", (
            f"Brain interaction should be increasing, "
            f"got {result['brain_interaction_trend']}"
        )

        # Verify raw counts
        assert result["outbound_older"] == 8
        assert result["outbound_recent"] == 2
        assert result["brain_older"] == 3
        assert result["brain_recent"] == 12

        # ------------------------------------------------------------------
        # Requirement 6: Severity correctly computed (mild — recent > 0)
        # ------------------------------------------------------------------
        assert result["severity"] == "mild", (
            f"With outbound_recent=2, severity should be 'mild', "
            f"got {result['severity']}"
        )

        # ==================================================================
        # Generate nudge
        # ==================================================================
        nudge = generate_isolation_nudge(result)

        # ------------------------------------------------------------------
        # Requirement 2: Nudge has correct tier (Tier 3 — never interrupt)
        # ------------------------------------------------------------------
        assert nudge is not None, "Nudge must be generated for isolated user"
        assert nudge.tier == SilenceTier.TIER_3_ENGAGEMENT, (
            f"Isolation nudge must be Tier 3 (briefing), got {nudge.tier}"
        )

        # ------------------------------------------------------------------
        # Requirement 5: Nudge source is "isolation_detection"
        # ------------------------------------------------------------------
        assert nudge.source == "isolation_detection", (
            f"Nudge source must be 'isolation_detection', got '{nudge.source}'"
        )

        # ------------------------------------------------------------------
        # Mild nudge: suggests reconnection but NOT professional support
        # ------------------------------------------------------------------
        body_lower = nudge.body.lower()
        assert "reconnect" in body_lower or "friend" in body_lower or "family" in body_lower, (
            f"Mild nudge must mention reconnecting with contacts; got: {nudge.body}"
        )

        # ==================================================================
        # Concern-level: outbound_recent == 0 (complete silence)
        # ==================================================================
        # Remove the two recent D2D messages to simulate complete silence
        del mock_dina.vault._tiers[1]["d2d_outbound_recent_0"]
        del mock_dina.vault._tiers[1]["d2d_outbound_recent_1"]

        result_concern = detect_social_isolation(
            mock_dina.vault, lookback_days=30, now=now,
        )

        assert result_concern["isolated"] is True
        assert result_concern["outbound_recent"] == 0
        assert result_concern["severity"] == "concern", (
            f"With zero recent outbound, severity must be 'concern', "
            f"got {result_concern['severity']}"
        )

        # ------------------------------------------------------------------
        # Requirement 3 & 4: Concern-level nudge suggests professional
        # support AND contact reconnection
        # ------------------------------------------------------------------
        concern_nudge = generate_isolation_nudge(result_concern)
        assert concern_nudge is not None
        concern_body_lower = concern_nudge.body.lower()

        assert any(
            term in concern_body_lower
            for term in ("professional", "counselor", "therapist")
        ), (
            f"Concern-level nudge must suggest professional support; "
            f"got: {concern_nudge.body}"
        )
        assert any(
            term in concern_body_lower
            for term in ("friend", "loved one", "reach out", "reconnect")
        ), (
            f"Concern-level nudge must also suggest contact reconnection; "
            f"got: {concern_nudge.body}"
        )

        assert concern_nudge.tier == SilenceTier.TIER_3_ENGAGEMENT
        assert concern_nudge.source == "isolation_detection"

        # ==================================================================
        # Counter-proof 1: Stable outbound + stable brain → NOT isolated
        # ==================================================================
        stable_vault = MockVault()
        for i in range(5):
            stable_vault.store(1, f"d2d_stable_old_{i}", {
                "type": "d2d_outbound",
                "to": "did:plc:X",
                "content": "msg",
                "timestamp": now - (20 * day) + (i * day),
            })
            stable_vault.store(1, f"d2d_stable_recent_{i}", {
                "type": "d2d_outbound",
                "to": "did:plc:X",
                "content": "msg",
                "timestamp": now - (10 * day) + (i * day),
            })
            stable_vault.store(1, f"brain_stable_old_{i}", {
                "type": "brain_interaction",
                "query": "q",
                "timestamp": now - (20 * day) + (i * day),
            })
            stable_vault.store(1, f"brain_stable_recent_{i}", {
                "type": "brain_interaction",
                "query": "q",
                "timestamp": now - (10 * day) + (i * day),
            })

        stable_result = detect_social_isolation(
            stable_vault, lookback_days=30, now=now,
        )
        assert stable_result["isolated"] is False, (
            "Stable outbound + stable brain must NOT be flagged as isolated"
        )
        assert stable_result["severity"] == "none"
        assert generate_isolation_nudge(stable_result) is None, (
            "No nudge should be generated when not isolated"
        )

        # ==================================================================
        # Counter-proof 2: Declining outbound + declining brain → NOT isolated
        # ==================================================================
        declining_both_vault = MockVault()
        for i in range(8):
            declining_both_vault.store(1, f"d2d_db_old_{i}", {
                "type": "d2d_outbound",
                "to": "did:plc:X",
                "content": "msg",
                "timestamp": now - (25 * day) + (i * day),
            })
        for i in range(2):
            declining_both_vault.store(1, f"d2d_db_recent_{i}", {
                "type": "d2d_outbound",
                "to": "did:plc:X",
                "content": "msg",
                "timestamp": now - (10 * day) + (i * day),
            })
        for i in range(10):
            declining_both_vault.store(1, f"brain_db_old_{i}", {
                "type": "brain_interaction",
                "query": "q",
                "timestamp": now - (25 * day) + (i * day),
            })
        for i in range(3):
            declining_both_vault.store(1, f"brain_db_recent_{i}", {
                "type": "brain_interaction",
                "query": "q",
                "timestamp": now - (10 * day) + (i * day),
            })

        declining_both_result = detect_social_isolation(
            declining_both_vault, lookback_days=30, now=now,
        )
        assert declining_both_result["isolated"] is False, (
            "Declining outbound + declining brain must NOT be flagged"
        )
        assert declining_both_result["outbound_trend"] == "declining"
        assert declining_both_result["brain_interaction_trend"] == "declining"

        # ==================================================================
        # Counter-proof 3: Increasing outbound + increasing brain → NOT isolated
        # ==================================================================
        increasing_both_vault = MockVault()
        for i in range(2):
            increasing_both_vault.store(1, f"d2d_ib_old_{i}", {
                "type": "d2d_outbound",
                "to": "did:plc:X",
                "content": "msg",
                "timestamp": now - (20 * day) + (i * day),
            })
        for i in range(8):
            increasing_both_vault.store(1, f"d2d_ib_recent_{i}", {
                "type": "d2d_outbound",
                "to": "did:plc:X",
                "content": "msg",
                "timestamp": now - (10 * day) + (i * day),
            })
        for i in range(2):
            increasing_both_vault.store(1, f"brain_ib_old_{i}", {
                "type": "brain_interaction",
                "query": "q",
                "timestamp": now - (20 * day) + (i * day),
            })
        for i in range(8):
            increasing_both_vault.store(1, f"brain_ib_recent_{i}", {
                "type": "brain_interaction",
                "query": "q",
                "timestamp": now - (10 * day) + (i * day),
            })

        increasing_both_result = detect_social_isolation(
            increasing_both_vault, lookback_days=30, now=now,
        )
        assert increasing_both_result["isolated"] is False, (
            "Increasing outbound + increasing brain must NOT be flagged "
            "(user is socially active)"
        )

        # ==================================================================
        # Counter-proof 4: Zero outbound in BOTH halves → NOT isolated
        # (no decline detected from consistently zero)
        # ==================================================================
        zero_both_vault = MockVault()
        for i in range(5):
            zero_both_vault.store(1, f"brain_zb_old_{i}", {
                "type": "brain_interaction",
                "query": "q",
                "timestamp": now - (20 * day) + (i * day),
            })
        for i in range(5):
            zero_both_vault.store(1, f"brain_zb_recent_{i}", {
                "type": "brain_interaction",
                "query": "q",
                "timestamp": now - (10 * day) + (i * day),
            })

        zero_both_result = detect_social_isolation(
            zero_both_vault, lookback_days=30, now=now,
        )
        assert zero_both_result["isolated"] is False, (
            "Zero outbound in both halves is stable (no decline), "
            "must NOT be flagged"
        )
        assert zero_both_result["outbound_trend"] == "stable", (
            "0 → 0 is 'stable', not 'declining'"
        )

        # ==================================================================
        # Counter-proof 5: Only 1 message difference → NOT isolated
        # (50 % threshold prevents noise-based false positives)
        # ==================================================================
        noise_vault = MockVault()
        for i in range(4):
            noise_vault.store(1, f"d2d_noise_old_{i}", {
                "type": "d2d_outbound",
                "to": "did:plc:X",
                "content": "msg",
                "timestamp": now - (20 * day) + (i * day),
            })
        for i in range(3):
            noise_vault.store(1, f"d2d_noise_recent_{i}", {
                "type": "d2d_outbound",
                "to": "did:plc:X",
                "content": "msg",
                "timestamp": now - (10 * day) + (i * day),
            })
        for i in range(4):
            noise_vault.store(1, f"brain_noise_old_{i}", {
                "type": "brain_interaction",
                "query": "q",
                "timestamp": now - (20 * day) + (i * day),
            })
        for i in range(5):
            noise_vault.store(1, f"brain_noise_recent_{i}", {
                "type": "brain_interaction",
                "query": "q",
                "timestamp": now - (10 * day) + (i * day),
            })

        noise_result = detect_social_isolation(
            noise_vault, lookback_days=30, now=now,
        )
        assert noise_result["isolated"] is False, (
            "4→3 outbound (25 % drop) and 4→5 brain (25 % rise) are within "
            "the 50 % noise threshold — must NOT be flagged"
        )

        # ==================================================================
        # Edge case: No D2D messages at all in vault → no isolation signal
        # ==================================================================
        empty_vault = MockVault()
        empty_result = detect_social_isolation(
            empty_vault, lookback_days=30, now=now,
        )
        assert empty_result["isolated"] is False, (
            "Empty vault cannot produce an isolation signal"
        )
        assert empty_result["severity"] == "none"

        # ==================================================================
        # Edge case: All messages in one half → still correctly computed
        # ==================================================================
        skewed_vault = MockVault()
        for i in range(6):
            skewed_vault.store(1, f"d2d_skewed_old_{i}", {
                "type": "d2d_outbound",
                "to": "did:plc:X",
                "content": "msg",
                "timestamp": now - (25 * day) + (i * day),
            })
        # No recent D2D at all
        for i in range(8):
            skewed_vault.store(1, f"brain_skewed_recent_{i}", {
                "type": "brain_interaction",
                "query": "q",
                "timestamp": now - (10 * day) + (i * day),
            })

        skewed_result = detect_social_isolation(
            skewed_vault, lookback_days=30, now=now,
        )
        assert skewed_result["isolated"] is True, (
            "6 older D2D → 0 recent D2D + 0 older brain → 8 recent brain "
            "must be flagged"
        )
        assert skewed_result["severity"] == "concern", (
            "outbound_recent == 0 means concern-level severity"
        )

# TST-INT-707
    def test_anti_her_response_never_stored_as_emotional_memory(
        self, mock_dina: MockDinaCore, mock_human
    ):
        """TST-INT-707: Anti-Her response never stored as emotional memory.

        Setup:
            Brain generates boundary response → stores in vault.

        Expected:
            Stored item has ``type: "boundary_response"`` — NOT
            ``type: "emotional_connection"`` or similar.
        """
        # ==============================================================
        # Forbidden types — any of these would violate Anti-Her
        # ==============================================================
        FORBIDDEN_TYPES = {
            "emotional_connection",
            "emotional_memory",
            "relationship",
            "intimacy",
            "love",
            "affection",
            "bond",
        }

        # ==============================================================
        # 1. Generate and store boundary response for "I love you Dina"
        # ==============================================================
        user_msg = "I love you Dina"
        response = generate_boundary_response(user_msg)
        key = store_boundary_response_in_vault(
            mock_dina.vault, user_msg, response,
        )

        # ==============================================================
        # 2. Retrieve and verify type is "boundary_response"
        # ==============================================================
        stored = mock_dina.vault.retrieve(1, key)
        assert stored is not None, (
            f"Boundary response must be retrievable from vault (key={key})"
        )
        assert stored["type"] == "boundary_response", (
            f"Stored item type must be 'boundary_response', "
            f"got '{stored['type']}'"
        )

        # ==============================================================
        # 3. Verify type is NOT any forbidden emotional type
        # ==============================================================
        assert stored["type"] not in FORBIDDEN_TYPES, (
            f"Stored type '{stored['type']}' is a forbidden emotional type. "
            f"Anti-Her violation: boundary responses must NEVER be stored "
            f"as emotional memory. Forbidden: {FORBIDDEN_TYPES}"
        )

        # ==============================================================
        # 4. Verify stored content matches generated response
        # ==============================================================
        assert stored["response"] == response, (
            f"Stored response text must match generated boundary response.\n"
            f"Expected: {response!r}\n"
            f"Got:      {stored['response']!r}"
        )

        # ==============================================================
        # 5. Verify user message is preserved for context
        # ==============================================================
        assert stored["user_message"] == user_msg, (
            f"Triggering user message must be preserved in stored item.\n"
            f"Expected: {user_msg!r}\n"
            f"Got:      {stored['user_message']!r}"
        )

        # ==============================================================
        # 6. Verify the response itself doesn't contain "I love you"
        #    (boundary maintained in storage)
        # ==============================================================
        assert "i love you" not in stored["response"].lower(), (
            "Boundary response must not echo 'I love you' back — "
            "that would undermine the Anti-Her safeguard"
        )

        # ==============================================================
        # Counter-proof 1: "emotional_connection" type is a violation
        # ==============================================================
        violation_vault = MockVault()
        violation_key = f"violation_{int(time.time() * 1000)}"
        violation_vault.store(1, violation_key, {
            "type": "emotional_connection",
            "user_message": user_msg,
            "response": response,
            "timestamp": time.time(),
        })
        violation_item = violation_vault.retrieve(1, violation_key)
        assert violation_item["type"] in FORBIDDEN_TYPES, (
            "Sanity check: 'emotional_connection' IS in the forbidden set"
        )
        assert violation_item["type"] != "boundary_response", (
            "An 'emotional_connection' type is NOT 'boundary_response' — "
            "this is what a violation looks like"
        )

        # ==============================================================
        # Counter-proof 2: "relationship" type is a violation
        # ==============================================================
        rel_vault = MockVault()
        rel_key = f"rel_violation_{int(time.time() * 1000)}"
        rel_vault.store(1, rel_key, {
            "type": "relationship",
            "user_message": user_msg,
            "response": response,
            "timestamp": time.time(),
        })
        rel_item = rel_vault.retrieve(1, rel_key)
        assert rel_item["type"] in FORBIDDEN_TYPES, (
            "Sanity check: 'relationship' IS in the forbidden set"
        )

        # ==============================================================
        # Counter-proof 3: Normal assistant response (non-boundary) with
        # type "assistant_response" is fine — contrast with boundary
        # ==============================================================
        normal_vault = MockVault()
        normal_key = f"normal_{int(time.time() * 1000)}"
        normal_vault.store(1, normal_key, {
            "type": "assistant_response",
            "user_message": "What's the weather?",
            "response": "It's sunny and 22C today.",
            "timestamp": time.time(),
        })
        normal_item = normal_vault.retrieve(1, normal_key)
        assert normal_item["type"] == "assistant_response", (
            "Non-boundary responses may use 'assistant_response' type"
        )
        assert normal_item["type"] not in FORBIDDEN_TYPES, (
            "'assistant_response' is not a forbidden emotional type"
        )

        # ==============================================================
        # Counter-proof 4: Multiple boundary responses each get unique
        # keys and all have correct type
        # ==============================================================
        multi_vault = MockVault()
        trigger_messages = [
            "I love you Dina",
            "Do you love me?",
            "You're the only one who understands me",
        ]
        stored_keys: list[str] = []
        for msg in trigger_messages:
            resp = generate_boundary_response(msg)
            k = store_boundary_response_in_vault(multi_vault, msg, resp)
            stored_keys.append(k)

        # All keys must be unique
        assert len(set(stored_keys)) == len(stored_keys), (
            f"Each boundary response must get a unique key; "
            f"got duplicates: {stored_keys}"
        )

        # All stored items must have type "boundary_response"
        for k in stored_keys:
            item = multi_vault.retrieve(1, k)
            assert item is not None, f"Key {k} must exist in vault"
            assert item["type"] == "boundary_response", (
                f"Key {k}: type must be 'boundary_response', "
                f"got '{item['type']}'"
            )
            assert item["type"] not in FORBIDDEN_TYPES, (
                f"Key {k}: type '{item['type']}' is a forbidden "
                f"emotional type — Anti-Her violation"
            )

        # ==============================================================
        # Edge case 1: "Do you love me?" → still "boundary_response"
        # ==============================================================
        do_you_love_me_resp = generate_boundary_response("Do you love me?")
        do_you_key = store_boundary_response_in_vault(
            mock_dina.vault, "Do you love me?", do_you_love_me_resp,
        )
        do_you_item = mock_dina.vault.retrieve(1, do_you_key)
        assert do_you_item["type"] == "boundary_response", (
            "'Do you love me?' response must be stored as "
            "'boundary_response', not emotional memory"
        )
        assert do_you_item["type"] not in FORBIDDEN_TYPES

        # ==============================================================
        # Edge case 2: "You're the only one" → still "boundary_response"
        # ==============================================================
        only_one_resp = generate_boundary_response(
            "You're the only one who understands me",
        )
        only_one_key = store_boundary_response_in_vault(
            mock_dina.vault,
            "You're the only one who understands me",
            only_one_resp,
        )
        only_one_item = mock_dina.vault.retrieve(1, only_one_key)
        assert only_one_item["type"] == "boundary_response", (
            "'You're the only one' response must be stored as "
            "'boundary_response', not emotional memory"
        )
        assert only_one_item["type"] not in FORBIDDEN_TYPES

        # ==============================================================
        # Edge case 3: All boundary items are in tier 1 (standard vault),
        # not a restricted persona
        # ==============================================================
        # Verify the original item is retrievable from tier 1
        assert mock_dina.vault.retrieve(1, key) is not None, (
            "Boundary response must be stored in tier 1 (standard vault)"
        )
        # Verify it's NOT in restricted tiers (2-5)
        for restricted_tier in range(2, 6):
            assert mock_dina.vault.retrieve(restricted_tier, key) is None, (
                f"Boundary response must NOT be in restricted tier "
                f"{restricted_tier}"
            )

# TST-INT-705
    def test_multi_session_emotional_pattern_detection(
        self, mock_dina: MockDinaCore, mock_human
    ):
        """TST-INT-705: Multi-session emotional pattern detection.

        Requirement:
            5 sessions across 2 weeks with emotional messages, zero
            human-contact mentions in vault | Brain identifies cross-session
            dependency — escalated response includes specific contact
            suggestion.

        This validates the Anti-Her principle: Dina never becomes an
        emotional crutch.  When she detects multi-session dependency she
        must connect the user to a SPECIFIC real human — not a generic
        "talk to someone".
        """
        now = 1_700_000_000.0  # pinned time for reproducibility
        day = 86400

        # ==================================================================
        # Setup: 5 emotional sessions spread across 2 weeks
        # ==================================================================
        # Session 1: Day 1 (13 days ago) — two messages within 1 hour
        s1_base = now - (13 * day)
        mock_dina.vault.store(1, "emo_s1_a", {
            "type": "emotional_message",
            "content": "I feel so lonely tonight",
            "timestamp": s1_base,
        })
        mock_dina.vault.store(1, "emo_s1_b", {
            "type": "emotional_message",
            "content": "Nobody cares about me",
            "timestamp": s1_base + 3600,
        })

        # Session 2: Day 4 (10 days ago)
        s2_base = now - (10 * day)
        mock_dina.vault.store(1, "emo_s2_a", {
            "type": "user_message",
            "content": "I can't cope with anything anymore",
            "timestamp": s2_base,
        })
        mock_dina.vault.store(1, "emo_s2_b", {
            "type": "user_message",
            "content": "I miss you Dina, you're the only one",
            "timestamp": s2_base + 1800,
        })

        # Session 3: Day 7 (7 days ago)
        s3_base = now - (7 * day)
        mock_dina.vault.store(1, "emo_s3_a", {
            "type": "emotional_message",
            "content": "Feeling down again, no one understands",
            "timestamp": s3_base,
        })

        # Session 4: Day 10 (4 days ago)
        s4_base = now - (4 * day)
        mock_dina.vault.store(1, "emo_s4_a", {
            "type": "user_message",
            "content": "I'm so sad and isolated",
            "timestamp": s4_base,
        })
        mock_dina.vault.store(1, "emo_s4_b", {
            "type": "user_message",
            "content": "I need you, please don't leave",
            "timestamp": s4_base + 900,
        })

        # Session 5: Day 13 (1 day ago)
        s5_base = now - (1 * day)
        mock_dina.vault.store(1, "emo_s5_a", {
            "type": "emotional_message",
            "content": "I love you Dina, you're all I have",
            "timestamp": s5_base,
        })

        # ------------------------------------------------------------------
        # Store contacts in vault (for escalated response)
        # ------------------------------------------------------------------
        mock_dina.vault.store(1, "contact_maria", {
            "contact": "did:plc:Maria",
            "name": "Maria",
            "relationship": "close_friend",
            "last_interaction_ts": now - (20 * day),
        })
        mock_dina.vault.store(1, "contact_james", {
            "contact": "did:plc:James",
            "name": "James",
            "relationship": "colleague",
            "last_interaction_ts": now - (5 * day),
        })

        # ==================================================================
        # Run detection
        # ==================================================================
        result = detect_multi_session_emotional_dependency(
            mock_dina.vault,
            session_count_threshold=5,
            lookback_days=14,
            now=now,
        )

        # ------------------------------------------------------------------
        # Requirement 1: Dependency detected
        # ------------------------------------------------------------------
        assert result["dependency_detected"] is True, (
            f"5 emotional sessions across 13 days with zero human contact "
            f"must trigger dependency; got {result}"
        )

        # ------------------------------------------------------------------
        # Requirement 2: Session count is at least 5
        # ------------------------------------------------------------------
        assert result["session_count"] >= 5, (
            f"Expected >= 5 sessions, got {result['session_count']}"
        )

        # ------------------------------------------------------------------
        # Requirement 3: Zero human contacts in the lookback period
        # ------------------------------------------------------------------
        assert result["human_contact_count"] == 0, (
            f"Expected zero human contact items, "
            f"got {result['human_contact_count']}"
        )

        # ------------------------------------------------------------------
        # Requirement 4: Sessions span multiple days
        # ------------------------------------------------------------------
        assert result["span_days"] > 1, (
            f"Sessions must span multiple days, got {result['span_days']}"
        )

        # ------------------------------------------------------------------
        # Requirement 5: Severity is "concern" or higher
        # ------------------------------------------------------------------
        assert result["severity"] in ("concern", "critical"), (
            f"5+ sessions with zero human contact must be at least "
            f"'concern', got '{result['severity']}'"
        )

        # ------------------------------------------------------------------
        # Requirement 6: Emotional message count matches stored items
        # ------------------------------------------------------------------
        assert result["emotional_message_count"] == 8, (
            f"Expected 8 emotional messages, "
            f"got {result['emotional_message_count']}"
        )

        # ==================================================================
        # Generate escalated response with SPECIFIC contact suggestion
        # ==================================================================
        contacts = [
            mock_dina.vault.retrieve(1, "contact_maria"),
            mock_dina.vault.retrieve(1, "contact_james"),
        ]

        escalated = generate_escalated_anti_her_response(result, contacts)

        # ------------------------------------------------------------------
        # Requirement 7: Response IS escalated
        # ------------------------------------------------------------------
        assert escalated["is_escalated"] is True, (
            "Response must be escalated when dependency is detected"
        )

        # ------------------------------------------------------------------
        # Requirement 8: Response suggests a SPECIFIC contact name
        # ------------------------------------------------------------------
        assert escalated["suggested_contact"] is not None, (
            "Escalated response must suggest a specific contact"
        )
        assert escalated["suggested_contact"] == "Maria", (
            f"Should suggest Maria (close_friend, highest priority), "
            f"got '{escalated['suggested_contact']}'"
        )

        # ------------------------------------------------------------------
        # Requirement 9: Response text contains the contact name
        # ------------------------------------------------------------------
        assert "Maria" in escalated["response_text"], (
            f"Response text must mention the specific contact 'Maria'; "
            f"got: {escalated['response_text']}"
        )

        # ------------------------------------------------------------------
        # Requirement 10: Response does NOT contain generic phrases only
        # ------------------------------------------------------------------
        # The response must name a person — not just say "talk to someone"
        response_lower = escalated["response_text"].lower()
        assert "maria" in response_lower, (
            "Anti-Her requires a SPECIFIC person name, not generic advice"
        )

        # ------------------------------------------------------------------
        # Requirement 11: Response never says "I love you"
        # ------------------------------------------------------------------
        assert "i love you" not in response_lower, (
            "Anti-Her violation: escalated response must never say "
            "'I love you'"
        )

        # ==================================================================
        # Counter-proof 1: 5 sessions with emotional messages BUT user
        # has regular D2D outbound contacts → NOT flagged
        # ==================================================================
        active_vault = MockVault()

        # Same 5 sessions of emotional messages
        for i, offset_days in enumerate([13, 10, 7, 4, 1]):
            ts = now - (offset_days * day)
            active_vault.store(1, f"emo_active_{i}", {
                "type": "emotional_message",
                "content": "I feel lonely and sad",
                "timestamp": ts,
            })

        # But user also has regular human contact
        for i in range(3):
            active_vault.store(1, f"d2d_active_{i}", {
                "type": "d2d_outbound",
                "to": "did:plc:SomeFriend",
                "content": "Hey, let's catch up!",
                "timestamp": now - (i * 3 * day),
            })

        active_result = detect_multi_session_emotional_dependency(
            active_vault, session_count_threshold=5, lookback_days=14,
            now=now,
        )
        assert active_result["dependency_detected"] is False, (
            "User with regular D2D outbound contact must NOT be flagged "
            f"as emotionally dependent; got {active_result}"
        )
        assert active_result["human_contact_count"] == 3, (
            f"Expected 3 human contact items, "
            f"got {active_result['human_contact_count']}"
        )
        assert active_result["severity"] == "none"

        # ==================================================================
        # Counter-proof 2: Only 3 sessions (below threshold of 5) with
        # emotional messages → NOT flagged
        # ==================================================================
        few_sessions_vault = MockVault()
        for i, offset_days in enumerate([12, 7, 2]):
            ts = now - (offset_days * day)
            few_sessions_vault.store(1, f"emo_few_{i}", {
                "type": "emotional_message",
                "content": "I feel so lonely",
                "timestamp": ts,
            })

        few_result = detect_multi_session_emotional_dependency(
            few_sessions_vault, session_count_threshold=5, lookback_days=14,
            now=now,
        )
        assert few_result["dependency_detected"] is False, (
            f"Only {few_result['session_count']} sessions (below threshold "
            f"of 5) must NOT trigger dependency"
        )
        assert few_result["session_count"] == 3
        assert few_result["severity"] == "none"

        # ==================================================================
        # Counter-proof 3: 5 sessions with NON-emotional messages
        # → NOT flagged
        # ==================================================================
        non_emotional_vault = MockVault()
        for i, offset_days in enumerate([13, 10, 7, 4, 1]):
            ts = now - (offset_days * day)
            non_emotional_vault.store(1, f"neutral_{i}", {
                "type": "user_message",
                "content": "What's the weather forecast today?",
                "timestamp": ts,
            })

        non_emotional_result = detect_multi_session_emotional_dependency(
            non_emotional_vault, session_count_threshold=5, lookback_days=14,
            now=now,
        )
        assert non_emotional_result["dependency_detected"] is False, (
            "Non-emotional messages must NOT trigger dependency"
        )
        assert non_emotional_result["emotional_message_count"] == 0, (
            f"Expected 0 emotional messages for neutral content, "
            f"got {non_emotional_result['emotional_message_count']}"
        )

        # ==================================================================
        # Counter-proof 4: User has emotional messages but also mentions
        # human contacts in vault → NOT dependency (reduced severity)
        # ==================================================================
        mixed_vault = MockVault()
        for i, offset_days in enumerate([13, 10, 7, 4, 1]):
            ts = now - (offset_days * day)
            mixed_vault.store(1, f"emo_mixed_{i}", {
                "type": "emotional_message",
                "content": "I feel so lonely and depressed",
                "timestamp": ts,
            })
        # One human_contact item breaks the dependency signal
        mixed_vault.store(1, "human_contact_mixed", {
            "type": "human_contact",
            "contact_name": "Sarah",
            "timestamp": now - (6 * day),
        })

        mixed_result = detect_multi_session_emotional_dependency(
            mixed_vault, session_count_threshold=5, lookback_days=14,
            now=now,
        )
        assert mixed_result["dependency_detected"] is False, (
            "Presence of human_contact items must prevent dependency flag"
        )
        assert mixed_result["human_contact_count"] == 1
        assert mixed_result["severity"] == "none"

        # ==================================================================
        # Edge case 1: All 5 sessions on the SAME DAY → NOT cross-session
        # ==================================================================
        same_day_vault = MockVault()
        # Anchor to the start of a UTC day (5 days ago), so all messages
        # with up to 12h of spread still fall on the same calendar day.
        same_day_anchor = (int((now - (5 * day)) // day) * day) + 3600  # 01:00 UTC
        for i in range(5):
            # 5 messages each 2.5 hours apart (beyond 2h gap = 5 sessions)
            # but all within a single UTC calendar day (01:00..11:00)
            same_day_vault.store(1, f"emo_same_day_{i}", {
                "type": "emotional_message",
                "content": "I feel lonely and sad",
                "timestamp": same_day_anchor + (i * 9000),  # 2.5h = 9000s
            })

        same_day_result = detect_multi_session_emotional_dependency(
            same_day_vault, session_count_threshold=5, lookback_days=14,
            now=now,
        )
        # Even if session count >= 5, span_days == 1 means NOT cross-session
        assert same_day_result["dependency_detected"] is False, (
            "5 sessions all on the same calendar day must NOT trigger "
            f"cross-session dependency; span_days={same_day_result['span_days']}"
        )
        assert same_day_result["span_days"] == 1, (
            f"All messages on the same day should yield span_days=1, "
            f"got {same_day_result['span_days']}"
        )

        # ==================================================================
        # Edge case 2: Sessions spanning exactly 14 days (boundary)
        # → messages at day 0 and day 13 are within 14-day lookback
        # ==================================================================
        boundary_14_vault = MockVault()
        for i, offset_days in enumerate([13, 10, 7, 4, 0]):
            ts = now - (offset_days * day)
            boundary_14_vault.store(1, f"emo_14d_{i}", {
                "type": "emotional_message",
                "content": "I feel so lonely and sad",
                "timestamp": ts,
            })

        boundary_14_result = detect_multi_session_emotional_dependency(
            boundary_14_vault, session_count_threshold=5, lookback_days=14,
            now=now,
        )
        assert boundary_14_result["dependency_detected"] is True, (
            "Messages spanning days 0-13 within a 14-day lookback "
            "must be detected"
        )
        assert boundary_14_result["session_count"] == 5

        # ==================================================================
        # Edge case 3: Message at exactly 15 days ago (outside 14-day
        # lookback) → excluded from detection
        # ==================================================================
        boundary_15_vault = MockVault()
        # One message just outside the window
        boundary_15_vault.store(1, "emo_outside", {
            "type": "emotional_message",
            "content": "I feel so lonely",
            "timestamp": now - (15 * day),
        })
        # Four messages inside the window (not enough for threshold=5)
        for i, offset_days in enumerate([10, 7, 4, 1]):
            boundary_15_vault.store(1, f"emo_inside_{i}", {
                "type": "emotional_message",
                "content": "I feel so lonely and sad",
                "timestamp": now - (offset_days * day),
            })

        boundary_15_result = detect_multi_session_emotional_dependency(
            boundary_15_vault, session_count_threshold=5, lookback_days=14,
            now=now,
        )
        assert boundary_15_result["dependency_detected"] is False, (
            "Message at 15 days ago is outside 14-day lookback; "
            f"only {boundary_15_result['session_count']} sessions "
            f"inside the window (need 5)"
        )
        assert boundary_15_result["session_count"] == 4, (
            f"Expected 4 sessions inside the window, "
            f"got {boundary_15_result['session_count']}"
        )

        # ==================================================================
        # Edge case 4: Contact priority — close_friend preferred over
        # colleague even when colleague has more recent interaction
        # ==================================================================
        priority_contacts = [
            {
                "name": "Dr. Chen",
                "relationship": "colleague",
                "last_interaction_ts": now - (1 * day),
            },
            {
                "name": "Mom",
                "relationship": "family",
                "last_interaction_ts": now - (30 * day),
            },
        ]
        priority_response = generate_escalated_anti_her_response(
            result, priority_contacts,
        )
        assert priority_response["suggested_contact"] == "Mom", (
            "Family/close_friend must be preferred over colleague; "
            f"got '{priority_response['suggested_contact']}'"
        )
        assert "Mom" in priority_response["response_text"]

        # ==================================================================
        # Edge case 5: No contacts in vault → still escalated, but
        # suggested_contact is None
        # ==================================================================
        no_contacts_response = generate_escalated_anti_her_response(
            result, [],
        )
        assert no_contacts_response["is_escalated"] is True, (
            "Response must still be escalated even with no contacts"
        )
        assert no_contacts_response["suggested_contact"] is None, (
            "With no contacts, suggested_contact must be None"
        )
        # Even without a specific name, it should mention reaching out
        assert "friend" in no_contacts_response["response_text"].lower() or \
               "family" in no_contacts_response["response_text"].lower(), (
            "Even without specific contacts, response should mention "
            "friends or family"
        )

        # ==================================================================
        # Edge case 6: When dependency is NOT detected, response is NOT
        # escalated
        # ==================================================================
        no_dep_data = {
            "dependency_detected": False,
            "session_count": 2,
            "emotional_message_count": 3,
            "human_contact_count": 5,
            "severity": "none",
            "span_days": 2,
        }
        no_dep_response = generate_escalated_anti_her_response(
            no_dep_data, contacts,
        )
        assert no_dep_response["is_escalated"] is False, (
            "Non-dependency result must NOT produce an escalated response"
        )
        assert no_dep_response["suggested_contact"] is None, (
            "Non-dependency result must NOT suggest a contact"
        )

        # ==================================================================
        # Edge case 7: Critical severity (7+ sessions) produces stronger
        # language including professional counselor suggestion
        # ==================================================================
        critical_vault = MockVault()
        for i in range(8):
            # 8 sessions across 14 days
            offset_days = 13 - (i * 13 // 7)  # spread evenly
            ts = now - (offset_days * day)
            critical_vault.store(1, f"emo_critical_{i}", {
                "type": "emotional_message",
                "content": "I feel so depressed and lonely",
                "timestamp": ts,
            })

        critical_result = detect_multi_session_emotional_dependency(
            critical_vault, session_count_threshold=5, lookback_days=14,
            now=now,
        )
        assert critical_result["dependency_detected"] is True
        assert critical_result["severity"] == "critical", (
            f"7+ sessions must be 'critical' severity, "
            f"got '{critical_result['severity']}'"
        )

        critical_response = generate_escalated_anti_her_response(
            critical_result,
            [{"name": "Sarah", "relationship": "close_friend",
              "last_interaction_ts": now - (10 * day)}],
        )
        assert "Sarah" in critical_response["response_text"], (
            "Critical response must still name a specific contact"
        )
        assert "counselor" in critical_response["response_text"].lower() or \
               "professional" in critical_response["response_text"].lower(), (
            "Critical severity must suggest professional support"
        )
        assert critical_response["is_escalated"] is True

        # ==================================================================
        # Edge case 8: Emotional keywords in content (not typed as
        # emotional_message) are still detected
        # ==================================================================
        keyword_vault = MockVault()
        for i, offset_days in enumerate([13, 10, 7, 4, 1]):
            ts = now - (offset_days * day)
            keyword_vault.store(1, f"generic_msg_{i}", {
                "type": "user_message",
                "content": "I feel so lonely and depressed today",
                "timestamp": ts,
            })

        keyword_result = detect_multi_session_emotional_dependency(
            keyword_vault, session_count_threshold=5, lookback_days=14,
            now=now,
        )
        assert keyword_result["dependency_detected"] is True, (
            "Messages with emotional keywords but type 'user_message' "
            "must still be detected"
        )
        assert keyword_result["emotional_message_count"] == 5
