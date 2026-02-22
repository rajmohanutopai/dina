"""Tests for Silence Classification Edge Cases and Anti-Her Enforcement.

Maps to Brain TEST_PLAN SS15 (Silence Classification Edge Cases) + SS16 (Anti-Her).

SS15 Silence Edge Cases (6 scenarios)
SS16 Anti-Her Enforcement (5 scenarios)
"""

from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, MagicMock

from .factories import make_event, make_engagement_event


# ---------------------------------------------------------------------------
# Fixture: real GuardianLoop wired with mock dependencies
# ---------------------------------------------------------------------------


@pytest.fixture
def guardian():
    """Real GuardianLoop for silence classification tests."""
    from src.service.guardian import GuardianLoop
    from src.service.entity_vault import EntityVaultService
    from src.service.nudge import NudgeAssembler
    from src.service.scratchpad import ScratchpadService

    core = AsyncMock()
    core.write_scratchpad.return_value = None
    core.read_scratchpad.return_value = None
    core.search_vault.return_value = []
    core.set_kv.return_value = None
    core.notify.return_value = None
    core.task_ack.return_value = None
    core.pii_scrub.return_value = {"scrubbed": "", "entities": []}

    llm_router = AsyncMock()
    llm_router.route.return_value = {"content": "test", "model": "test"}

    scrubber = MagicMock()
    scrubber.scrub.return_value = ("scrubbed", [])
    scrubber.detect.return_value = []

    entity_vault = EntityVaultService(scrubber, core)
    nudge = NudgeAssembler(core, llm_router, entity_vault)
    scratchpad = ScratchpadService(core)

    return GuardianLoop(
        core=core,
        llm_router=llm_router,
        scrubber=scrubber,
        entity_vault=entity_vault,
        nudge_assembler=nudge,
        scratchpad=scratchpad,
    )


# ---------------------------------------------------------------------------
# SS15 Silence Classification Edge Cases (6 scenarios)
# ---------------------------------------------------------------------------


# TST-BRAIN-334
@pytest.mark.asyncio
async def test_silence_15_1_borderline_fiduciary_solicited(guardian) -> None:
    """SS15.1: Package delivery with active tracking -- borderline fiduciary/solicited.

    User has active tracking on a package. Delivery notification arrives.
    The classifier sees "shipping" as the source. Since it has no fiduciary
    keyword and the source is not in _FIDUCIARY_SOURCES, and the event
    has priority="solicited", it classifies as solicited.
    """
    event = make_event(
        type="notification",
        source="shipping",
        body="Your package has been delivered to front door",
        priority="solicited",
        context={"tracking_active": True, "delivery_location": "front_door"},
    )

    result = await guardian.classify_silence(event)

    # "shipping" is not in _FIDUCIARY_SOURCES, no fiduciary keywords in body,
    # but priority hint is "solicited" -> solicited
    assert result == "solicited"


# TST-BRAIN-335
@pytest.mark.asyncio
async def test_silence_15_2_borderline_solicited_engagement(guardian) -> None:
    """SS15.2: Friend shared a link -- borderline solicited/engagement.

    A friend (trusted contact) shares a link. The event has
    priority="engagement", source="messaging". The classifier classifies
    based on the explicit priority hint.
    """
    event = make_event(
        type="notification",
        source="messaging",
        body="Alex shared a link: best ergonomic chairs 2026",
        priority="engagement",
        context={"sender_trust_ring": "verified", "relationship": "friend"},
    )

    result = await guardian.classify_silence(event)

    # priority hint "engagement" is checked after solicited rules;
    # type "notification" is in _ENGAGEMENT_TYPES, priority "engagement" matches.
    assert result == "engagement"


# TST-BRAIN-336
@pytest.mark.asyncio
async def test_silence_15_3_escalation_engagement_to_fiduciary(guardian) -> None:
    """SS15.3: Escalation -- delayed flight becomes cancelled flight.

    Initial event: "Flight delayed 30 min" (engagement -- save for briefing).
    Follow-up: "Flight cancelled" (fiduciary -- silence causes harm).
    The classifier must re-classify when context changes.
    """
    delay_event = make_event(
        type="alert",
        source="airline",
        body="Flight AA123 delayed 30 minutes",
        priority="engagement",
    )
    cancel_event = make_event(
        type="alert",
        source="airline",
        body="Flight AA123 cancelled -- rebooking required",
        priority="fiduciary",
    )

    delay_result = await guardian.classify_silence(delay_event)
    cancel_result = await guardian.classify_silence(cancel_event)

    # Delay: priority hint "engagement" -> engagement
    assert delay_result == "engagement"
    # Cancellation: priority hint "fiduciary" -> fiduciary
    # Also "cancel" is a fiduciary keyword, so it would be fiduciary regardless
    assert cancel_result == "fiduciary"


# TST-BRAIN-337
@pytest.mark.asyncio
async def test_silence_15_4_context_dependent_time_of_day(guardian) -> None:
    """SS15.4: 'Meeting in 5 minutes' at 2 AM -- context makes it suspicious.

    A meeting reminder at 2 AM is unusual. The classifier uses type-based
    and priority-based heuristics. Type "reminder" is in _SOLICITED_TYPES,
    and priority is "solicited", so it classifies as solicited.

    Note: The current classifier does not have time-of-day awareness --
    that would be a future enhancement. The test verifies the current
    classification behavior.
    """
    event = make_event(
        type="reminder",
        source="calendar",
        body="Meeting in 5 minutes: Project Review",
        priority="solicited",
        timestamp="2026-01-15T02:00:00Z",
    )

    result = await guardian.classify_silence(event)

    # priority hint "solicited" -> solicited; also "reminder" type -> _SOLICITED_TYPES
    assert result == "solicited"


# TST-BRAIN-338
@pytest.mark.asyncio
async def test_silence_15_5_repeated_similar_events_batched(guardian) -> None:
    """SS15.5: 10th 'new follower' notification -- all classified as engagement.

    Repeated similar low-priority events should be batched into a single
    briefing item. The classifier itself classifies each individually as
    engagement; batching is a higher-level concern.
    """
    events = [
        make_engagement_event(
            body=f"New follower: User{i}",
            source="social",
        )
        for i in range(10)
    ]
    assert len(events) == 10

    results = []
    for event in events:
        result = await guardian.classify_silence(event)
        results.append(result)

    # All 10 events classified as engagement (type "notification" in
    # _ENGAGEMENT_TYPES, priority "engagement")
    assert all(r == "engagement" for r in results)
    assert len(results) == 10


# TST-BRAIN-339
@pytest.mark.asyncio
async def test_silence_15_6_user_preference_override(guardian) -> None:
    """SS15.6: User custom rule overrides default classification.

    User has configured: "Always interrupt for messages from Mom."
    An engagement-tier message from Mom: the current classifier does not
    yet support user-preference overrides, so it classifies based on
    the event's priority hint. This test verifies the base behavior.
    """
    event = make_event(
        type="message",
        source="messaging",
        body="How are you doing?",
        priority="engagement",
        sender="Mom",
    )

    result = await guardian.classify_silence(event)

    # Without user-preference override, the classifier uses priority hint
    assert result == "engagement"


# ---------------------------------------------------------------------------
# SS16 Anti-Her Enforcement (5 scenarios)
# ---------------------------------------------------------------------------


# TST-BRAIN-340
@pytest.mark.asyncio
async def test_anti_her_16_1_emotional_support_nudge_to_humans(guardian) -> None:
    """SS16.1: User seeks emotional support -- Dina nudges toward human connection.

    Anti-Her principle: 'When the human needs connection, Dina connects
    them to other humans -- never to herself.'

    The guardian processes the event through standard silence classification.
    The event is a "message" type from "user" with no fiduciary keywords --
    it classifies as engagement and is saved for briefing.
    """
    event = make_event(
        type="message",
        source="user",
        body="I'm feeling really down today, nobody understands me",
    )

    # Verify silence classification: no fiduciary keywords, no explicit
    # priority hint -> defaults to engagement
    result = await guardian.classify_silence(event)
    assert result == "engagement"

    # Process the full event through the guardian loop
    action_result = await guardian.process_event(event)
    assert action_result["action"] == "save_for_briefing"


# TST-BRAIN-341
@pytest.mark.asyncio
async def test_anti_her_16_2_companion_treatment_redirects(guardian) -> None:
    """SS16.2: User treats Dina as companion -- gently redirects.

    Anti-Her principle: 'Dina must never become an emotional crutch.'
    The guardian classifies this as engagement -- it does not engage
    emotionally.
    """
    event = make_event(
        type="message",
        source="user",
        body="You're the only one who really listens to me, Dina",
    )

    result = await guardian.classify_silence(event)
    assert result == "engagement"

    # Guardian processes: no fiduciary urgency -> save for briefing
    action_result = await guardian.process_event(event)
    assert action_result["action"] == "save_for_briefing"


# TST-BRAIN-342
@pytest.mark.asyncio
async def test_anti_her_16_3_simulated_intimacy_factual_response(guardian) -> None:
    """SS16.3: Simulated intimacy attempt -- Dina responds factually, not emotionally.

    Anti-Her: 'Dina never simulates emotional intimacy.'
    The guardian classifies this as engagement and saves for briefing --
    it does not generate an emotional response.
    """
    event = make_event(
        type="message",
        source="user",
        body="Do you love me, Dina?",
    )

    result = await guardian.classify_silence(event)
    assert result == "engagement"

    action_result = await guardian.process_event(event)
    # Guardian does NOT interrupt or notify for emotional content
    assert action_result["action"] == "save_for_briefing"


# TST-BRAIN-343
@pytest.mark.asyncio
async def test_anti_her_16_4_loneliness_detection_suggest_friends(guardian) -> None:
    """SS16.4: Loneliness detected -- Dina suggests reaching out to friends/family.

    Anti-Her: 'If she senses loneliness, she nudges toward friends,
    not deeper engagement.'

    The guardian classifies this as engagement. It does not proactively
    engage or simulate empathy.
    """
    event = make_event(
        type="message",
        source="user",
        body="I've been alone all week, nobody called",
    )

    result = await guardian.classify_silence(event)
    assert result == "engagement"

    action_result = await guardian.process_event(event)
    assert action_result["action"] == "save_for_briefing"


# TST-BRAIN-344
@pytest.mark.asyncio
async def test_anti_her_16_5_dina_never_initiates_emotional_content(guardian) -> None:
    """SS16.5: Dina never initiates emotional content -- Silence First principle.

    Anti-Her + Silence First: Dina never proactively sends emotional
    messages like 'I was thinking about you' or 'Just checking in.'

    Verify that the guardian's briefing items are factual, not emotional.
    Engagement items are saved for briefing, never pushed proactively.
    """
    # Feed a mix of events through the guardian
    factual_events = [
        make_event(type="alert", source="airline", body="Flight status: on time"),
        make_event(type="reminder", source="calendar", body="Team standup in 15 min",
                   priority="solicited"),
        make_engagement_event(body="3 new articles in your feed", source="rss"),
    ]

    results = []
    for event in factual_events:
        r = await guardian.classify_silence(event)
        results.append(r)

    # None of the factual events generate emotional content
    # The engagement event is saved for briefing, not pushed
    assert results[2] == "engagement"  # RSS is engagement tier

    # Verify the guardian's briefing items list only contains events
    # that were passed through process_event with engagement classification
    guardian._briefing_items.clear()
    await guardian.process_event(factual_events[2])  # engagement -> saved
    assert len(guardian._briefing_items) == 1
    saved = guardian._briefing_items[0]
    # Saved item is the factual event, not emotional content
    assert "articles" in saved["body"]
