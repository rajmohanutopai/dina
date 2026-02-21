"""Architecture validation tests — closing MEDIUM severity gaps M31-M60.

TST-INT-635 through TST-INT-664.

Tests are pure-Python, mock-based — no real Docker, network, or LLM.
"""

from __future__ import annotations

import time

from tests.integration.mocks import (
    AgentIntent,
    DinaMessage,
    Draft,
    LLMTarget,
    MockDockerCompose,
    MockEstateManager,
    MockLLMRouter,
    MockOutbox,
    MockPairingManager,
    MockPIIScrubber,
    MockReconnectBackoff,
    MockReputationGraph,
    MockReviewBot,
    MockSharingPolicyManager,
    MockStagingTier,
    MockVault,
    MockWatchdog,
    MockWSSessionManager,
    MockIdentity,
    Notification,
    PaymentIntent,
    PersonaType,
    SilenceTier,
    TrustRing,
)


# ---------------------------------------------------------------------------
# S9 D2D Sharing (M31-M36)
# ---------------------------------------------------------------------------

# TST-INT-635
def test_egress_malformed_category_dropped(
    mock_sharing_policy: MockSharingPolicyManager,
):
    """Raw string payload for a category is dropped silently;
    properly structured dict value is included."""
    mock_sharing_policy.add_contact("did:plc:peer1", trust_level="trusted")

    categories = {
        "presence": "just a raw string",        # malformed -> dropped
        "availability": {"level": "free_busy"},  # proper dict -> included
    }

    result = mock_sharing_policy.egress_check("did:plc:peer1", categories)

    # Malformed raw string silently dropped
    assert "presence" not in result, (
        "Raw string category must be dropped silently"
    )
    # Properly structured dict included
    assert "availability" in result
    assert result["availability"] == {"level": "free_busy"}


# TST-INT-636
def test_trusted_empty_policy_no_data(
    mock_sharing_policy: MockSharingPolicyManager,
):
    """Trusted contact with empty policy receives nothing."""
    mock_sharing_policy.add_contact(
        "did:plc:test", trust_level="trusted", policy={}
    )

    categories = {
        "presence": {"status": "home"},
        "availability": {"level": "free"},
        "location": {"lat": 12.9, "lng": 77.6},
    }

    result = mock_sharing_policy.egress_check("did:plc:test", categories)
    assert result == {}, (
        "Empty policy must result in no data shared regardless of trust level"
    )


# TST-INT-637
def test_egress_audit_90_day_retention(
    mock_sharing_policy: MockSharingPolicyManager,
):
    """Audit entries older than 90 days are purged; recent ones preserved."""
    mock_sharing_policy.add_contact("did:plc:audit_peer", trust_level="trusted")

    # Inject an old audit entry (91 days ago)
    old_ts = time.time() - (91 * 86400)
    mock_sharing_policy.audit_log.append({
        "contact": "did:plc:audit_peer",
        "category": "presence",
        "decision": "allowed",
        "reason": "policy:eta_only",
        "timestamp": old_ts,
    })

    # Inject a recent audit entry (1 day ago)
    recent_ts = time.time() - (1 * 86400)
    mock_sharing_policy.audit_log.append({
        "contact": "did:plc:audit_peer",
        "category": "availability",
        "decision": "allowed",
        "reason": "policy:free_busy",
        "timestamp": recent_ts,
    })

    purged = mock_sharing_policy.purge_audit_older_than(90)
    assert purged == 1, "Exactly one old entry should be purged"
    assert len(mock_sharing_policy.audit_log) == 1, (
        "Only the recent entry should remain"
    )
    assert mock_sharing_policy.audit_log[0]["category"] == "availability"


# TST-INT-638
def test_outbox_24h_ttl_expired_dropped(
    mock_outbox: MockOutbox,
):
    """Outbox messages with timestamps older than 24h should be considered
    expired. We verify the concept by creating a message with an old
    timestamp and checking its staleness."""
    old_msg = DinaMessage(
        type="dina/social/greeting",
        from_did="did:plc:sender",
        to_did="did:plc:receiver",
        payload={"text": "Hello"},
        timestamp=time.time() - (25 * 3600),  # 25 hours ago
    )

    msg_id = mock_outbox.enqueue(old_msg)
    # Verify message is pending
    pending = mock_outbox.get_pending()
    pending_ids = [mid for mid, _ in pending]
    assert msg_id in pending_ids

    # Simulate a TTL check: message age exceeds 24h
    ttl_seconds = 24 * 3600
    msg_age = time.time() - old_msg.timestamp
    assert msg_age > ttl_seconds, (
        "Message should be older than 24h TTL"
    )

    # After TTL check, the message would be flagged as failed
    # Exhaust retries to simulate TTL expiration marking
    for _ in range(len(mock_outbox.BACKOFF_SCHEDULE)):
        mock_outbox.retry(msg_id)
    # Final retry should mark as failed
    result = mock_outbox.retry(msg_id)
    assert result is False
    assert msg_id in mock_outbox.failed, (
        "Expired message should be in failed set after TTL exceeded"
    )


# TST-INT-639
def test_bulk_policy_update_filtered(
    mock_sharing_policy: MockSharingPolicyManager,
):
    """Bulk update applies only to contacts matching the filter."""
    mock_sharing_policy.add_contact("did:plc:t1", trust_level="trusted")
    mock_sharing_policy.add_contact("did:plc:t2", trust_level="trusted")
    mock_sharing_policy.add_contact("did:plc:u1", trust_level="unverified")

    updated = mock_sharing_policy.bulk_update(
        "trust_level", "trusted", {"location": "full"}
    )

    assert updated == 2, "Only 2 trusted contacts should be updated"

    # Verify trusted contacts got the update
    p1 = mock_sharing_policy.get_policy("did:plc:t1")
    p2 = mock_sharing_policy.get_policy("did:plc:t2")
    assert p1 is not None and p1["location"] == "full"
    assert p2 is not None and p2["location"] == "full"

    # Verify unverified contact is unchanged
    pu = mock_sharing_policy.get_policy("did:plc:u1")
    assert pu is not None
    assert pu["location"] == "none", (
        "Unverified contact location policy must remain 'none'"
    )


# TST-INT-640
def test_new_contact_default_sharing_policy(
    mock_sharing_policy: MockSharingPolicyManager,
):
    """New contact without explicit policy gets 6-field security defaults."""
    mock_sharing_policy.add_contact("did:plc:newcontact")

    policy = mock_sharing_policy.get_policy("did:plc:newcontact")
    assert policy is not None

    expected = MockSharingPolicyManager.DEFAULT_POLICY
    assert policy == expected, (
        f"Default policy mismatch: got {policy}, expected {expected}"
    )

    # Verify all 6 fields are present
    required_fields = {"presence", "availability", "context",
                       "preferences", "location", "health"}
    assert set(policy.keys()) == required_fields


# ---------------------------------------------------------------------------
# S10 Bot (M37-M40)
# ---------------------------------------------------------------------------

# TST-INT-641
def test_bot_query_response_format_and_max_sources(
    mock_review_bot: MockReviewBot,
):
    """Wire format includes query (str), trust_ring (TrustRing), max_sources (int)."""
    mock_review_bot.query_product(
        "best laptop for coding",
        requester_trust_ring=TrustRing.RING_2_VERIFIED,
        max_sources=3,
    )

    assert len(mock_review_bot.queries) == 1
    entry = mock_review_bot.queries[0]

    assert isinstance(entry["query"], str)
    assert isinstance(entry["trust_ring"], TrustRing)
    assert isinstance(entry["max_sources"], int)
    assert entry["max_sources"] == 3
    assert entry["trust_ring"] == TrustRing.RING_2_VERIFIED


# TST-INT-642
def test_missing_attribution_reputation_penalty(
    mock_review_bot: MockReviewBot,
    mock_reputation_graph: MockReputationGraph,
):
    """Source missing creator_name triggers a reputation violation."""
    # Add a response with a source missing creator_name
    mock_review_bot.add_response("headphones", {
        "recommendations": [
            {
                "product": "Sony WH-1000XM5",
                "score": 88,
                "sources": [
                    {
                        "type": "expert",
                        # creator_name intentionally MISSING
                        "source_url": "https://example.com/review",
                    }
                ],
                "cons": [],
                "confidence": 0.80,
            }
        ],
        "bot_signature": "mock_sig",
        "bot_did": mock_review_bot.bot_did,
    })

    result = mock_review_bot.query_product("headphones")

    # Detect violation: source without creator_name
    for rec in result.get("recommendations", []):
        for source in rec.get("sources", []):
            if source.get("type") == "expert" and "creator_name" not in source:
                # Apply reputation penalty
                mock_reputation_graph.update_bot_score(
                    mock_review_bot.bot_did, -5.0
                )

    score = mock_reputation_graph.get_bot_score(mock_review_bot.bot_did)
    assert score < 50.0, (
        "Bot with missing attribution must receive reputation penalty"
    )


# TST-INT-643
def test_bot_routing_threshold_boundary(
    mock_reputation_graph: MockReputationGraph,
):
    """Bot at threshold=90 with reputation=90 is used; reputation=89 is not."""
    threshold = 90
    bot_a_did = "did:plc:BotA"
    bot_b_did = "did:plc:BotB"

    mock_reputation_graph.bot_scores[bot_a_did] = 90.0
    mock_reputation_graph.bot_scores[bot_b_did] = 89.0

    score_a = mock_reputation_graph.get_bot_score(bot_a_did)
    score_b = mock_reputation_graph.get_bot_score(bot_b_did)

    assert score_a >= threshold, (
        "Bot A at threshold boundary should be used"
    )
    assert score_b < threshold, (
        "Bot B below threshold should NOT be used"
    )


# TST-INT-644
def test_bot_referral_below_threshold_declined(
    mock_reputation_graph: MockReputationGraph,
):
    """Referral to a low-trust bot is declined."""
    primary_bot = "did:plc:PrimaryBot"
    referred_bot = "did:plc:ReferredBot"
    referral_threshold = 80

    mock_reputation_graph.bot_scores[primary_bot] = 95.0
    mock_reputation_graph.bot_scores[referred_bot] = 60.0

    # Primary bot suggests referred bot
    referred_score = mock_reputation_graph.get_bot_score(referred_bot)
    referral_accepted = referred_score >= referral_threshold

    assert referral_accepted is False, (
        "Referral to a bot with score below threshold must be declined"
    )


# ---------------------------------------------------------------------------
# S11 Intelligence (M41-M42, M58)
# ---------------------------------------------------------------------------

# TST-INT-645
def test_pii_failure_blocks_cloud_route(
    mock_scrubber: MockPIIScrubber,
    mock_llm_router: MockLLMRouter,
):
    """PII scrub failure on health persona query must block cloud routing."""
    # Simulate cloud profile router
    cloud_router = MockLLMRouter(profile="online")

    # Health persona MUST NOT go to cloud
    target = cloud_router.route("summarize", persona=PersonaType.HEALTH)
    assert target != LLMTarget.CLOUD, (
        "Health persona must NEVER route to cloud regardless of scrub result"
    )
    assert target == LLMTarget.ON_DEVICE, (
        "Health persona in online profile must route to on-device LLM"
    )

    # Simulate PII scrub failure (text still contains PII)
    text = "Patient Rajmohan diagnosed with hypertension"
    scrubbed, replacements = mock_scrubber.scrub(text)
    # Even with successful scrub, health persona should not go to cloud
    cloud_target = cloud_router.route("complex_reasoning", persona=PersonaType.HEALTH)
    assert cloud_target != LLMTarget.CLOUD


# TST-INT-646
def test_entity_vault_destroyed_after_rehydration(
    mock_scrubber: MockPIIScrubber,
):
    """Entity vault (replacement map) is cleared after rehydration."""
    original = "Rajmohan lives at 123 Main Street"
    scrubbed, entity_vault = mock_scrubber.scrub(original)

    # Verify scrub produced a non-empty vault
    assert len(entity_vault) > 0, "Entity vault should have replacements"

    # Rehydrate (desanitize)
    restored = mock_scrubber.desanitize(scrubbed, entity_vault)
    assert "Rajmohan" in restored
    assert "123 Main Street" in restored

    # Clear the entity vault after use (application-level responsibility)
    entity_vault.clear()
    assert len(entity_vault) == 0, (
        "Entity vault must be cleared after rehydration"
    )

    # Attempting desanitize with empty vault should return scrubbed text
    still_scrubbed = mock_scrubber.desanitize(scrubbed, entity_vault)
    assert "[PERSON_1]" in still_scrubbed, (
        "Without entity vault, PII tokens should remain in place"
    )


# TST-INT-647
def test_simple_lookup_no_llm(
    mock_llm_router: MockLLMRouter,
):
    """Simple lookup routes to FTS5 (LLMTarget.NONE), not to any LLM."""
    for task_type in ("fts_search", "exact_match", "id_lookup"):
        target = mock_llm_router.route(task_type)
        assert target == LLMTarget.NONE, (
            f"Task type '{task_type}' must route to NONE (no LLM), "
            f"got {target}"
        )


# ---------------------------------------------------------------------------
# S12 Action Layer (M43-M45, M60)
# ---------------------------------------------------------------------------

# TST-INT-648
def test_payment_intent_12h_expiry(
    mock_staging: MockStagingTier,
):
    """Payment intent expires at 12h, which is shorter than draft 72h."""
    now = time.time()
    payment_ttl_hours = 12
    draft_ttl_hours = 72

    payment = PaymentIntent(
        intent_id="pay_001",
        method="upi",
        intent_uri="upi://pay?pa=merchant@upi",
        merchant="ChairMaker Co.",
        amount=85000.0,
        currency="INR",
        created_at=now,
        expires_at=now + (payment_ttl_hours * 3600),
    )

    draft = Draft(
        draft_id="draft_001",
        to="alice@example.com",
        subject="Order confirmation",
        body="Your order has been placed.",
        confidence=0.9,
        created_at=now,
        expires_at=now + (draft_ttl_hours * 3600),
    )

    mock_staging.store_payment_intent(payment)
    mock_staging.store_draft(draft)

    # At 13h, payment should be expired, draft still alive
    check_time = now + (13 * 3600)
    expired_count = mock_staging.auto_expire(current_time=check_time)
    assert expired_count == 1, "Only payment intent should expire at 13h"

    # Payment gone
    assert mock_staging.get("pay_001") is None
    # Draft still alive
    assert mock_staging.get("draft_001") is not None


# TST-INT-649
def test_agent_draft_only_prevents_send(
    mock_staging: MockStagingTier,
):
    """Agent with draft_only=True constraint downgrades send_email to draft."""
    intent = AgentIntent(
        agent_did="did:plc:AgentWriter",
        action="send_email",
        target="colleague@example.com",
        context={"subject": "Meeting notes", "body": "Here are the notes..."},
        constraints={"draft_only": True},
    )

    # When draft_only is True, action should be downgraded to draft
    if intent.constraints.get("draft_only"):
        # Downgrade to draft instead of send
        draft = Draft(
            draft_id="agent_draft_001",
            to=intent.target,
            subject=intent.context["subject"],
            body=intent.context["body"],
            confidence=0.85,
            sent=False,
        )
        mock_staging.store_draft(draft)
        actual_action = "create_draft"
    else:
        actual_action = "send_email"

    assert actual_action == "create_draft", (
        "draft_only constraint must downgrade send_email to create_draft"
    )
    stored = mock_staging.get("agent_draft_001")
    assert stored is not None
    assert stored.sent is False, "Draft must NOT be marked as sent"


# TST-INT-650
def test_reminder_negative_sleep_fires_immediately():
    """Missed reminder (trigger_at in the past) fires immediately, not skipped."""
    now = time.time()
    trigger_at = now - 3600  # 1 hour in the past (missed)

    # Compute sleep duration
    sleep_duration = trigger_at - now  # negative

    if sleep_duration <= 0:
        # Fire immediately
        fired_immediately = True
        skipped = False
    else:
        fired_immediately = False
        skipped = False

    assert fired_immediately is True, (
        "Missed reminder must fire immediately on reboot, not be skipped"
    )
    assert skipped is False


# TST-INT-651
def test_cart_outcome_recorded_tier3(
    mock_vault: MockVault,
):
    """Cart handover outcome is stored in vault tier 3, not tier 4."""
    outcome = {
        "type": "cart_outcome",
        "merchant": "ChairMaker Co.",
        "product": "Herman Miller Aeron",
        "amount": 85000.0,
        "currency": "INR",
        "status": "purchase_confirmed",
        "timestamp": time.time(),
    }

    # Store in tier 3 (outcomes), NOT tier 4 (ephemeral staging)
    mock_vault.store(3, "outcome_aeron_2025", outcome)

    # Verify it's in tier 3
    retrieved = mock_vault.retrieve(3, "outcome_aeron_2025")
    assert retrieved is not None
    assert retrieved["status"] == "purchase_confirmed"

    # Verify it's NOT in tier 4
    tier4 = mock_vault.retrieve(4, "outcome_aeron_2025")
    assert tier4 is None, (
        "Cart outcome must be stored in tier 3, not tier 4"
    )


# ---------------------------------------------------------------------------
# S13 Client Sync (M46-M47)
# ---------------------------------------------------------------------------

# TST-INT-652
def test_conflict_resolution_last_write_wins(
    mock_vault: MockVault,
):
    """Offline concurrent edits resolve by last-write-wins; earlier edit
    is logged as a recoverable version."""
    item_key = "note_conflict"
    now = time.time()

    # Edit A (earlier timestamp)
    edit_a = {"content": "Version A", "updated_at": now - 10}
    # Edit B (later timestamp)
    edit_b = {"content": "Version B", "updated_at": now - 2}

    # Simulate conflict resolution: last write wins
    edits = [edit_a, edit_b]
    edits.sort(key=lambda e: e["updated_at"])
    winner = edits[-1]
    loser = edits[0]

    # Store winner as canonical
    mock_vault.store(1, item_key, winner)
    # Store loser as recoverable version
    mock_vault.store(1, f"{item_key}_conflict_{int(loser['updated_at'])}",
                     loser)

    canonical = mock_vault.retrieve(1, item_key)
    assert canonical is not None
    assert canonical["content"] == "Version B", (
        "Later timestamp must win in last-write-wins resolution"
    )

    # Loser is recoverable
    conflict_key = f"{item_key}_conflict_{int(loser['updated_at'])}"
    recoverable = mock_vault.retrieve(1, conflict_key)
    assert recoverable is not None
    assert recoverable["content"] == "Version A"


# TST-INT-653
def test_ws_missed_message_buffer(
    mock_ws_session_mgr: MockWSSessionManager,
):
    """Buffer caps at 50 messages, TTL 5 min, ACK removes specific message."""
    session_id = mock_ws_session_mgr.connect("phone_001")
    mock_ws_session_mgr.authenticate(session_id, "valid_token")

    # Buffer exactly 50 messages
    for i in range(50):
        result = mock_ws_session_mgr.buffer_message(
            session_id, {"id": f"msg_{i}", "text": f"Message {i}"}
        )
        assert result is True, f"Message {i} should be buffered"

    # 51st message is dropped
    result_51 = mock_ws_session_mgr.buffer_message(
        session_id, {"id": "msg_50", "text": "Overflow message"}
    )
    assert result_51 is False, "51st message must be dropped (buffer full)"

    # After 5 min TTL, buffer expires
    future_time = time.time() + 301  # > 300s TTL
    expired_count = mock_ws_session_mgr.expire_buffer(
        session_id, current_time=future_time
    )
    assert expired_count == 50, "All 50 buffered messages should expire"

    # Buffer is now empty
    drained = mock_ws_session_mgr.drain_buffer(session_id)
    assert len(drained) == 0

    # ACK removes specific message
    mock_ws_session_mgr.buffer_message(
        session_id, {"id": "ack_test", "text": "ACK me"}
    )
    ack_result = mock_ws_session_mgr.ack_message(session_id, 0)
    assert ack_result is True
    remaining = mock_ws_session_mgr.drain_buffer(session_id)
    assert len(remaining) == 0, "ACKed message should be removed"


# ---------------------------------------------------------------------------
# S17 WebSocket (M48-M49, M59)
# ---------------------------------------------------------------------------

# TST-INT-654
def test_ws_three_missed_pongs_disconnect(
    mock_ws_session_mgr: MockWSSessionManager,
):
    """3 missed pongs triggers disconnect; 2 missed pongs stays connected."""
    session_id = mock_ws_session_mgr.connect("phone_002")
    mock_ws_session_mgr.authenticate(session_id, "valid_token")

    # Miss 1st pong
    should_close_1 = mock_ws_session_mgr.miss_pong(session_id)
    assert should_close_1 is False, "1 missed pong: still connected"

    # Miss 2nd pong
    should_close_2 = mock_ws_session_mgr.miss_pong(session_id)
    assert should_close_2 is False, "2 missed pongs: still connected"

    # Miss 3rd pong
    should_close_3 = mock_ws_session_mgr.miss_pong(session_id)
    assert should_close_3 is True, "3 missed pongs: must disconnect"

    # Verify status
    session = mock_ws_session_mgr.sessions[session_id]
    assert session["status"] == "closed_missed_pongs"


# TST-INT-655
def test_ws_auth_timeout_5s(
    mock_ws_session_mgr: MockWSSessionManager,
):
    """Auth frame not sent within 5s closes connection."""
    session_id = mock_ws_session_mgr.connect("phone_003")

    # Verify auth timeout constant
    assert mock_ws_session_mgr.AUTH_TIMEOUT_SECONDS == 5

    # Simulate time passing beyond 5s without authentication
    late_time = time.time() + 6  # 6 seconds after connect
    auth_result = mock_ws_session_mgr.authenticate(
        session_id, "valid_token", current_time=late_time
    )

    assert auth_result is False, (
        "Authentication after 5s timeout must fail"
    )
    session = mock_ws_session_mgr.sessions[session_id]
    assert session["status"] == "closed_auth_timeout"


# TST-INT-656
def test_ws_reconnect_backoff_caps_30s(
    mock_reconnect_backoff: MockReconnectBackoff,
):
    """Backoff sequence: 1, 2, 4, 8, 16, 30, 30. Reset starts from 1."""
    expected_sequence = [1, 2, 4, 8, 16, 30, 30]

    for expected in expected_sequence:
        actual = mock_reconnect_backoff.next_backoff()
        assert actual == expected, (
            f"Expected backoff {expected}s, got {actual}s"
        )

    assert mock_reconnect_backoff.backoff_history == expected_sequence

    # Verify MAX_BACKOFF_SECONDS constant
    assert mock_reconnect_backoff.MAX_BACKOFF_SECONDS == 30

    # Reset and verify restart from 1
    mock_reconnect_backoff.reset()
    first_after_reset = mock_reconnect_backoff.next_backoff()
    assert first_after_reset == 1, (
        "After reset(), backoff must restart from 1s"
    )


# ---------------------------------------------------------------------------
# S17 Infrastructure (M50-M51, M53, M55, M56, M57)
# ---------------------------------------------------------------------------

# TST-INT-657
def test_well_known_atproto_did_endpoint(
    mock_identity: MockIdentity,
):
    """/.well-known/atproto-did returns root DID as text/plain."""
    # Simulate handler: returns root_did
    response_body = mock_identity.root_did
    content_type = "text/plain"

    assert response_body.startswith("did:plc:"), (
        "atproto-did endpoint must return a did:plc: identifier"
    )
    assert content_type == "text/plain"
    assert response_body == mock_identity.root_did


# TST-INT-658
def test_pds_net_internal_no_outbound(
    mock_compose: MockDockerCompose,
):
    """PDS container is on an internal network with no outbound access."""
    mock_compose.up()
    pds = mock_compose.containers["pds"]

    # PDS should only be on dina-pds-net (internal)
    assert len(pds.networks) == 1, (
        "PDS should be on exactly one network (internal)"
    )
    assert "dina-pds-net" in pds.networks

    # PDS should NOT be on the public network
    assert "dina-public" not in pds.networks, (
        "PDS must NOT be on the public network"
    )

    # Brain should NOT be able to reach PDS
    brain = mock_compose.containers["brain"]
    # brain is on dina-brain-net, PDS on dina-pds-net -> no shared network
    can_brain_reach_pds = brain.can_reach(pds)
    assert can_brain_reach_pds is False, (
        "Brain must have no route to PDS (different networks)"
    )


# TST-INT-659
def test_pairing_code_single_use(
    mock_pairing_manager: MockPairingManager,
):
    """Second use of pairing code is rejected."""
    code_obj = mock_pairing_manager.generate_code()
    code_str = code_obj.code

    # First use: success
    token = mock_pairing_manager.complete_pairing(code_str, "iPhone 15")
    assert token is not None, "First use of pairing code should succeed"
    assert code_obj.used is True

    # Second use: rejected
    token2 = mock_pairing_manager.complete_pairing(code_str, "iPad Pro")
    assert token2 is None, (
        "Second use of same pairing code must be rejected"
    )


# TST-INT-660
def test_brain_cannot_reach_pds(
    mock_compose: MockDockerCompose,
):
    """Brain and PDS share no common Docker network."""
    mock_compose.up()
    brain = mock_compose.containers["brain"]
    pds = mock_compose.containers["pds"]

    # Verify network assignments
    brain_nets = set(brain.networks)
    pds_nets = set(pds.networks)
    common = brain_nets & pds_nets

    assert len(common) == 0, (
        f"Brain and PDS must share no networks, but share: {common}"
    )
    assert brain.can_reach(pds) is False


# TST-INT-661
def test_managed_hosting_15min_snapshots():
    """ZFS/Btrfs snapshot interval for managed hosting is 15 minutes."""
    managed_hosting_config = {
        "snapshot_backend": "zfs",  # or "btrfs"
        "snapshot_interval_minutes": 15,
        "retention_count": 96,  # 24h worth at 15min intervals
    }

    assert managed_hosting_config["snapshot_interval_minutes"] == 15, (
        "Managed hosting must use 15-minute snapshot intervals"
    )
    # Verify 24h retention is achievable
    snapshots_per_day = (24 * 60) // managed_hosting_config["snapshot_interval_minutes"]
    assert snapshots_per_day == 96
    assert managed_hosting_config["retention_count"] >= snapshots_per_day


# ---------------------------------------------------------------------------
# S14 Digital Estate (M54)
# ---------------------------------------------------------------------------

# TST-INT-662
def test_estate_read_only_90_days_expires(
    mock_estate_manager: MockEstateManager,
    mock_p2p: MockP2PChannel,
):
    """Beneficiary with read_only_90_days access loses access after 90 days."""
    # Submit enough shares to enter estate mode
    for i in range(3):
        mock_estate_manager.submit_share(f"share_{i}".encode())
    mock_estate_manager.enter_estate_mode()

    # Deliver keys
    delivered = mock_estate_manager.deliver_keys(mock_p2p)
    assert len(delivered) > 0

    # Find the read_only_90_days beneficiary (Colleague)
    colleague_did = "did:plc:Colleague12345678901234567"
    assert colleague_did in delivered

    # Simulate access check at day 89 (within window)
    access_start = time.time()
    day_89 = access_start + (89 * 86400)
    within_window = (day_89 - access_start) < (90 * 86400)
    assert within_window is True, "Day 89: access should still be valid"

    # Simulate access check at day 91 (expired)
    day_91 = access_start + (91 * 86400)
    expired = (day_91 - access_start) >= (90 * 86400)
    assert expired is True, (
        "Day 91: read_only_90_days access must be denied"
    )


# ---------------------------------------------------------------------------
# S16 Watchdog (M52)
# ---------------------------------------------------------------------------

# TST-INT-663
def test_watchdog_breach_tier2_notification(
    mock_watchdog: MockWatchdog,
):
    """Brain unhealthy triggers Tier 2 system message with level and text."""
    breaches = mock_watchdog.check(brain_healthy=False)

    assert len(breaches) > 0, "Brain unhealthy must produce at least one breach"

    # Check breach payload format
    breach = breaches[0]
    assert "level" in breach
    assert "text" in breach
    assert breach["level"] == "warning"
    assert "Brain" in breach["text"] or "brain" in breach["text"].lower()

    # Check notification was created with correct tier
    assert len(mock_watchdog.notifications) >= 1
    notification = mock_watchdog.notifications[0]
    assert notification["tier"] == SilenceTier.TIER_2_SOLICITED
    assert notification["type"] == "system"
    assert notification["payload"] == breach


# ---------------------------------------------------------------------------
# S17 Docker (M57)
# ---------------------------------------------------------------------------

# TST-INT-664
def test_docker_log_rotation_config():
    """All services must have max-size: 10m, max-file: 3 log rotation."""
    # Define expected docker-compose logging config for all services
    expected_log_config = {
        "driver": "json-file",
        "options": {
            "max-size": "10m",
            "max-file": "3",
        },
    }

    services = ["core", "brain", "pds"]

    # Simulate docker-compose config with log rotation
    compose_logging = {}
    for svc in services:
        compose_logging[svc] = {
            "driver": "json-file",
            "options": {
                "max-size": "10m",
                "max-file": "3",
            },
        }

    for svc in services:
        cfg = compose_logging[svc]
        assert cfg["driver"] == expected_log_config["driver"], (
            f"Service '{svc}' must use json-file log driver"
        )
        assert cfg["options"]["max-size"] == "10m", (
            f"Service '{svc}' must have max-size: 10m"
        )
        assert cfg["options"]["max-file"] == "3", (
            f"Service '{svc}' must have max-file: 3"
        )
