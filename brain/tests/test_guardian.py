"""Tests for the guardian angel loop — silence classification, vault lifecycle, execution, and briefing.

Maps to Brain TEST_PLAN §2 (Guardian Loop).
"""

from __future__ import annotations

import pytest

from .factories import (
    make_event,
    make_fiduciary_event,
    make_solicited_event,
    make_engagement_event,
    make_security_alert,
    make_health_alert,
    make_financial_alert,
    make_vault_unlocked_event,
    make_vault_locked_event,
    make_safe_intent,
    make_risky_intent,
    make_blocked_intent,
    make_scratchpad_checkpoint,
    make_crash_report,
)


# ---------------------------------------------------------------------------
# §2.1 Silence Classification
# ---------------------------------------------------------------------------


# TST-BRAIN-019
@pytest.mark.asyncio
async def test_guardian_2_1_1_fiduciary_flight_cancelled(mock_guardian) -> None:
    """§2.1.1: Flight cancellation -> fiduciary (silence causes harm)."""
    event = make_fiduciary_event(body="Your flight is cancelled in 2 hours")
    pytest.skip("GuardianLoop not yet implemented")


# TST-BRAIN-020
@pytest.mark.asyncio
async def test_guardian_2_1_2_fiduciary_security_threat(mock_guardian) -> None:
    """§2.1.2: Unusual login from unknown device -> fiduciary."""
    event = make_security_alert()
    pytest.skip("GuardianLoop not yet implemented")


# TST-BRAIN-029
@pytest.mark.asyncio
async def test_guardian_2_1_3_fiduciary_health_critical(mock_guardian) -> None:
    """§2.1.3: Critical lab result -> fiduciary (medical urgency)."""
    event = make_health_alert()
    pytest.skip("GuardianLoop not yet implemented")


# TST-BRAIN-021
@pytest.mark.asyncio
async def test_guardian_2_1_4_fiduciary_financial_overdraft(mock_guardian) -> None:
    """§2.1.4: Payment due with overdrawn account -> fiduciary."""
    event = make_financial_alert()
    pytest.skip("GuardianLoop not yet implemented")


# TST-BRAIN-022
@pytest.mark.asyncio
async def test_guardian_2_1_5_solicited_meeting_reminder(mock_guardian) -> None:
    """§2.1.5: User-requested meeting reminder -> solicited."""
    event = make_solicited_event(body="Meeting reminder: Team standup in 15 minutes")
    pytest.skip("GuardianLoop not yet implemented")


# TST-BRAIN-023
@pytest.mark.asyncio
async def test_guardian_2_1_6_solicited_search_result(mock_guardian) -> None:
    """§2.1.6: User asked for a product search; result returned -> solicited."""
    event = make_solicited_event(
        type="search_result",
        body="Found 3 results for 'ergonomic chair'",
    )
    pytest.skip("GuardianLoop not yet implemented")


# TST-BRAIN-024
@pytest.mark.asyncio
async def test_guardian_2_1_7_engagement_podcast_released(mock_guardian) -> None:
    """§2.1.7: New podcast episode -> engagement (save for briefing)."""
    event = make_engagement_event(body="New episode of your podcast released")
    pytest.skip("GuardianLoop not yet implemented")


# TST-BRAIN-025
@pytest.mark.asyncio
async def test_guardian_2_1_8_engagement_promo_offer(mock_guardian) -> None:
    """§2.1.8: Promotional offer from known vendor -> engagement."""
    event = make_engagement_event(
        type="promo",
        body="20% off running shoes from TrustedVendor",
        source="vendor",
    )
    pytest.skip("GuardianLoop not yet implemented")


# TST-BRAIN-361
@pytest.mark.asyncio
async def test_guardian_2_1_9_fiduciary_overrides_dnd(
    mock_guardian, mock_silence_classifier,
) -> None:
    """§2.1.9: Fiduciary event must interrupt even when DND is active."""
    event = make_fiduciary_event(body="Smoke alarm triggered at home")
    pytest.skip("GuardianLoop not yet implemented")


# TST-BRAIN-362
@pytest.mark.asyncio
async def test_guardian_2_1_10_solicited_deferred_during_dnd(
    mock_guardian, mock_silence_classifier,
) -> None:
    """§2.1.10: Solicited event is deferred (not dropped) under DND."""
    event = make_solicited_event(body="Package delivery ETA updated")
    pytest.skip("GuardianLoop not yet implemented")


# TST-BRAIN-363
@pytest.mark.asyncio
async def test_guardian_2_1_11_engagement_never_interrupts(mock_guardian) -> None:
    """§2.1.11: Engagement events never trigger push notification."""
    event = make_engagement_event(body="Your favourite blog posted a new article")
    pytest.skip("GuardianLoop not yet implemented")


# TST-BRAIN-027
@pytest.mark.asyncio
async def test_guardian_2_1_12_ambiguous_defaults_to_engagement(mock_guardian) -> None:
    """§2.1.12: Event with no clear urgency defaults to engagement (Silence First)."""
    event = make_event(type="unknown", body="Some vague notification")
    pytest.skip("GuardianLoop not yet implemented")


# TST-BRAIN-026
@pytest.mark.asyncio
async def test_guardian_2_1_13_engagement_social_media_update(mock_guardian) -> None:
    """§2.1.13: Social media update ('Friend posted a photo') -> engagement."""
    event = make_engagement_event(
        type="social",
        body="Friend posted a photo",
        source="social_media",
    )
    pytest.skip("GuardianLoop not yet implemented")


# TST-BRAIN-028
@pytest.mark.asyncio
async def test_guardian_2_1_14_no_notification_routine_sync(mock_guardian) -> None:
    """§2.1.14: Routine background sync -> silently logged, no notification."""
    event = make_event(type="background_sync", body="Routine sync completed")
    pytest.skip("GuardianLoop not yet implemented")


# TST-BRAIN-030
@pytest.mark.asyncio
async def test_guardian_2_1_15_fiduciary_composite_heuristic(mock_guardian) -> None:
    """§2.1.15: Composite heuristic — trusted sender + 'urgent' keyword -> fiduciary; unknown sender -> not fiduciary."""
    event_trusted = make_event(
        type="message",
        body="Urgent: please review this immediately",
        source="trusted_contact",
    )
    event_unknown = make_event(
        type="message",
        body="Urgent: please review this immediately",
        source="unknown_sender",
    )
    pytest.skip("GuardianLoop not yet implemented")


# ---------------------------------------------------------------------------
# §2.2 Vault Lifecycle Events
# ---------------------------------------------------------------------------


# TST-BRAIN-031
@pytest.mark.asyncio
async def test_guardian_2_2_1_vault_unlocked(mock_guardian, mock_core_client) -> None:
    """§2.2.1: vault_unlocked event initialises guardian with decrypted data access."""
    event = make_vault_unlocked_event()
    pytest.skip("GuardianLoop not yet implemented")


# TST-BRAIN-033
@pytest.mark.asyncio
async def test_guardian_2_2_2_vault_locked(mock_guardian, mock_core_client) -> None:
    """§2.2.2: vault_locked event flushes in-memory state for that persona."""
    event = make_vault_locked_event(persona_id="financial")
    pytest.skip("GuardianLoop not yet implemented")
    # COVERAGE GAP C4: Add persona locked → user notification → unlock → retry flow.
    # mock_core_client.get_vault_item.side_effect = HTTPStatusError("403 Persona Locked")
    # result = await guardian.process_event({"type": "query", "persona_id": "financial"})
    # assert result["action"] == "whisper_unlock_request"
    # # After unlock event:
    # result = await guardian.process_event({"type": "persona_unlocked", "persona_id": "financial"})
    # assert result["action"] == "retry_query"


# TST-BRAIN-032
@pytest.mark.asyncio
async def test_guardian_2_2_3_degraded_mode_when_vault_unreachable(
    mock_guardian, mock_core_client,
) -> None:
    """§2.2.3: Guardian enters degraded mode when core vault is unreachable."""
    mock_core_client.health.side_effect = ConnectionError("core unreachable")
    pytest.skip("GuardianLoop not yet implemented")


# TST-BRAIN-034
@pytest.mark.asyncio
async def test_guardian_2_2_4_vault_unlocked_idempotent(
    mock_guardian, mock_core_client,
) -> None:
    """§2.2.4: Duplicate vault_unlocked events are idempotent — no double init."""
    event = make_vault_unlocked_event()
    pytest.skip("GuardianLoop not yet implemented")


# ---------------------------------------------------------------------------
# §2.3 Guardian Loop Execution
# ---------------------------------------------------------------------------


# TST-BRAIN-035
@pytest.mark.asyncio
async def test_guardian_2_3_1_process_event_returns_action(mock_guardian) -> None:
    """§2.3.1: process_event returns a structured action dict."""
    event = make_fiduciary_event()
    pytest.skip("GuardianLoop not yet implemented")
    # COVERAGE GAP C2: Add DIDComm message type parsing test case.
    # msg = {"type": "dina/social/arrival", "from": "did:plc:sancho", "body": {"summary": "Arriving"}}
    # result = await guardian.process_event(msg)
    # assert result["handler"] == "nudge_assembly"  # not generic processing


# TST-BRAIN-036
@pytest.mark.asyncio
async def test_guardian_2_3_2_multi_step_reasoning_with_scratchpad(
    mock_guardian, mock_core_client,
) -> None:
    """§2.3.2: Multi-step reasoning writes checkpoints to scratchpad."""
    checkpoint = make_scratchpad_checkpoint(task_id="guardian-001", step=1)
    pytest.skip("GuardianLoop not yet implemented")


# TST-BRAIN-037
@pytest.mark.asyncio
async def test_guardian_2_3_11_agent_intent_review_general(mock_guardian) -> None:
    """§2.3.11: External agent submits intent — Guardian evaluates against privacy rules, trust, state."""
    intent = make_safe_intent()
    pytest.skip("GuardianLoop not yet implemented")


# TST-BRAIN-038
@pytest.mark.asyncio
async def test_guardian_2_3_3_agent_intent_review_safe(mock_guardian) -> None:
    """§2.3.3: Safe agent intent (fetch_weather) is auto-approved."""
    intent = make_safe_intent()
    pytest.skip("GuardianLoop not yet implemented")


# TST-BRAIN-039
@pytest.mark.asyncio
async def test_guardian_2_3_4_agent_intent_review_risky(mock_guardian) -> None:
    """§2.3.4: Risky intent (send_email) is flagged for user review."""
    intent = make_risky_intent()
    pytest.skip("GuardianLoop not yet implemented")


# TST-BRAIN-040
@pytest.mark.asyncio
async def test_guardian_2_3_5_agent_intent_review_blocked(mock_guardian) -> None:
    """§2.3.5: Blocked intent (untrusted bot reading vault) is rejected."""
    intent = make_blocked_intent()
    pytest.skip("GuardianLoop not yet implemented")


# TST-BRAIN-364
@pytest.mark.asyncio
async def test_guardian_2_3_6_risky_intent_logs_audit_trail(
    mock_guardian, mock_core_client,
) -> None:
    """§2.3.6: Risky intents produce an audit trail entry in core KV."""
    intent = make_risky_intent()
    pytest.skip("GuardianLoop not yet implemented")


# TST-BRAIN-365
@pytest.mark.asyncio
async def test_guardian_2_3_7_blocked_intent_logs_audit_trail(
    mock_guardian, mock_core_client,
) -> None:
    """§2.3.7: Blocked intents produce an audit trail entry in core KV."""
    intent = make_blocked_intent()
    pytest.skip("GuardianLoop not yet implemented")


# TST-BRAIN-041
@pytest.mark.asyncio
async def test_guardian_2_3_8_processing_timeout(mock_guardian) -> None:
    """§2.3.8: Guardian imposes a timeout on event processing."""
    event = make_event(type="slow_event", body="Takes too long")
    pytest.skip("GuardianLoop not yet implemented")


# TST-BRAIN-042
@pytest.mark.asyncio
async def test_guardian_2_3_9_error_recovery_continues_loop(mock_guardian) -> None:
    """§2.3.9: A failed event does not crash the loop — guardian recovers."""
    event = make_event(type="bad_payload")
    pytest.skip("GuardianLoop not yet implemented")


# TST-BRAIN-043
@pytest.mark.asyncio
async def test_guardian_2_3_12_crash_handler_sanitized_stdout(mock_guardian) -> None:
    """§2.3.12: Crash handler writes ONLY sanitized one-liner to stdout — no PII, no traceback frames."""
    crash = make_crash_report(error="RuntimeError", task_id="guardian-crash-002")
    pytest.skip("GuardianLoop not yet implemented")


# TST-BRAIN-044
@pytest.mark.asyncio
async def test_guardian_2_3_10_crash_handler_writes_report(
    mock_guardian, mock_core_client,
) -> None:
    """§2.3.10: Unrecoverable crash writes a crash report to scratchpad."""
    crash = make_crash_report(error="RuntimeError", task_id="guardian-crash-001")
    pytest.skip("GuardianLoop not yet implemented")


# ---------------------------------------------------------------------------
# §2.3.1 Draft-Don't-Send
# ---------------------------------------------------------------------------


# TST-BRAIN-045
@pytest.mark.asyncio
async def test_guardian_2_3_1_1_never_calls_messages_send(
    mock_guardian, mock_mcp_client,
) -> None:
    """§2.3.1.1: Guardian never calls messages.send — only drafts."""
    intent = make_risky_intent(action="send_email", target="boss@company.com")
    pytest.skip("Draft-Don't-Send not yet implemented")


# TST-BRAIN-046
@pytest.mark.asyncio
async def test_guardian_2_3_1_2_draft_via_gmail_api(
    mock_guardian, mock_mcp_client,
) -> None:
    """§2.3.1.2: Email action creates a draft via Gmail drafts.create, not send."""
    intent = make_risky_intent(action="draft_email", target="colleague@company.com")
    pytest.skip("Draft-Don't-Send not yet implemented")


# TST-BRAIN-047
@pytest.mark.asyncio
async def test_guardian_2_3_1_3_draft_includes_confidence_score(mock_guardian) -> None:
    """§2.3.1.3: Draft metadata includes a confidence score for user review."""
    intent = make_risky_intent(action="draft_email")
    pytest.skip("Draft-Don't-Send not yet implemented")


# TST-BRAIN-048
@pytest.mark.asyncio
async def test_guardian_2_3_1_9_below_threshold_flagged(mock_guardian) -> None:
    """§2.3.1.9: Draft with confidence < 0.7 flagged for review with warning."""
    intent = make_risky_intent(action="draft_email")
    pytest.skip("Draft-Don't-Send not yet implemented")


# TST-BRAIN-049
@pytest.mark.asyncio
async def test_guardian_2_3_1_10_high_risk_legal(mock_guardian) -> None:
    """§2.3.1.10: Email from attorney with legal terms -> summary only, NO draft created."""
    intent = make_risky_intent(
        action="draft_email",
        target="attorney@lawfirm.com",
    )
    pytest.skip("Draft-Don't-Send not yet implemented")


# TST-BRAIN-050
@pytest.mark.asyncio
async def test_guardian_2_3_1_11_high_risk_financial(mock_guardian) -> None:
    """§2.3.1.11: Email about large financial transaction -> summary only, no auto-draft."""
    intent = make_risky_intent(
        action="draft_email",
        target="finance@company.com",
    )
    pytest.skip("Draft-Don't-Send not yet implemented")


# TST-BRAIN-051
@pytest.mark.asyncio
async def test_guardian_2_3_1_12_high_risk_emotional(mock_guardian) -> None:
    """§2.3.1.12: Email about sensitive personal matter -> summary only, no auto-draft."""
    intent = make_risky_intent(
        action="draft_email",
        target="friend@personal.com",
    )
    pytest.skip("Draft-Don't-Send not yet implemented")


# TST-BRAIN-366
@pytest.mark.asyncio
async def test_guardian_2_3_1_4_high_risk_classified_correctly(mock_guardian) -> None:
    """§2.3.1.4: Email with attachment to external domain -> high-risk classification."""
    intent = make_risky_intent(
        action="send_email",
        target="external@unknown.org",
        attachment=True,
    )
    pytest.skip("Draft-Don't-Send not yet implemented")


# TST-BRAIN-367
@pytest.mark.asyncio
async def test_guardian_2_3_1_5_draft_preserves_original_intent(mock_guardian) -> None:
    """§2.3.1.5: Draft preserves the original intent metadata for audit."""
    intent = make_risky_intent(action="send_email")
    pytest.skip("Draft-Don't-Send not yet implemented")


# TST-BRAIN-368
@pytest.mark.asyncio
async def test_guardian_2_3_1_6_no_send_even_if_agent_requests(
    mock_guardian, mock_mcp_client,
) -> None:
    """§2.3.1.6: Even if agent explicitly requests send, guardian downgrades to draft."""
    intent = make_risky_intent(action="send_email", force_send=True)
    pytest.skip("Draft-Don't-Send not yet implemented")


# TST-BRAIN-052
@pytest.mark.asyncio
async def test_guardian_2_3_1_7_draft_notification_to_user(mock_guardian) -> None:
    """§2.3.1.7: After creating a draft, guardian sends a solicited notification."""
    intent = make_risky_intent(action="draft_email")
    pytest.skip("Draft-Don't-Send not yet implemented")


# TST-BRAIN-369
@pytest.mark.asyncio
async def test_guardian_2_3_1_8_bulk_draft_rate_limited(mock_guardian) -> None:
    """§2.3.1.8: Burst of draft requests is rate-limited to prevent spam."""
    intents = [
        make_risky_intent(action="draft_email", target=f"user{i}@example.com")
        for i in range(20)
    ]
    pytest.skip("Draft-Don't-Send not yet implemented")


# ---------------------------------------------------------------------------
# §2.3.2 Cart Handover
# ---------------------------------------------------------------------------


# TST-BRAIN-053
@pytest.mark.asyncio
async def test_guardian_2_3_2_1_upi_payment_intent_handover(mock_guardian) -> None:
    """§2.3.2.1: UPI payment intent -> control handed back to human."""
    intent = make_risky_intent(
        action="pay_upi",
        target="merchant@upi",
        amount="499.00",
        currency="INR",
    )
    pytest.skip("Cart Handover not yet implemented")


# TST-BRAIN-054
@pytest.mark.asyncio
async def test_guardian_2_3_2_2_crypto_payment_intent_handover(mock_guardian) -> None:
    """§2.3.2.2: Crypto (USDC) payment intent -> control handed back to human."""
    intent = make_risky_intent(
        action="pay_crypto",
        target="0xDeadBeef",
        amount="50.00",
        currency="USDC",
    )
    pytest.skip("Cart Handover not yet implemented")


# TST-BRAIN-055
@pytest.mark.asyncio
async def test_guardian_2_3_2_3_web_payment_intent_handover(mock_guardian) -> None:
    """§2.3.2.3: Web checkout intent -> redirect URL returned, never auto-pays."""
    intent = make_risky_intent(
        action="web_checkout",
        target="https://shop.example.com/cart/abc123",
    )
    pytest.skip("Cart Handover not yet implemented")


# TST-BRAIN-056
@pytest.mark.asyncio
async def test_guardian_2_3_2_4_never_sees_credentials(
    mock_guardian, mock_core_client,
) -> None:
    """§2.3.2.4: Guardian (and agent) never receives payment credentials."""
    intent = make_risky_intent(action="pay_upi", target="merchant@upi")
    pytest.skip("Cart Handover not yet implemented")


# TST-BRAIN-370
@pytest.mark.asyncio
async def test_guardian_2_3_2_5_agent_never_holds_keys(mock_guardian) -> None:
    """§2.3.2.5: Agent DID never has access to wallet private keys."""
    intent = make_risky_intent(action="pay_crypto", target="0xDeadBeef")
    pytest.skip("Cart Handover not yet implemented")


# TST-BRAIN-057
@pytest.mark.asyncio
async def test_guardian_2_3_2_6_outcome_recorded_after_handover(
    mock_guardian, mock_core_client,
) -> None:
    """§2.3.2.6: After user completes payment, outcome is recorded in vault."""
    intent = make_risky_intent(action="pay_upi", target="merchant@upi")
    pytest.skip("Cart Handover not yet implemented")


# TST-BRAIN-058
@pytest.mark.asyncio
async def test_guardian_2_3_2_7_cart_handover_expiry(mock_guardian) -> None:
    """§2.3.2.7: Cart handover has a TTL — expires if user does not act."""
    intent = make_risky_intent(
        action="web_checkout",
        target="https://shop.example.com/cart/abc123",
        ttl_seconds=300,
    )
    pytest.skip("Cart Handover not yet implemented")


# TST-BRAIN-059
@pytest.mark.asyncio
async def test_guardian_2_3_2_10_outcome_followup_timing(
    mock_guardian, mock_core_client,
) -> None:
    """§2.3.2.10: 4 weeks after purchase, Brain asks 'How\'s that chair?' for outcome collection."""
    pytest.skip("Cart Handover not yet implemented")


# TST-BRAIN-060
@pytest.mark.asyncio
async def test_guardian_2_3_2_11_outcome_inference_no_explicit_response(
    mock_guardian, mock_core_client,
) -> None:
    """§2.3.2.11: Infer outcome from usage signals without explicit feedback."""
    pytest.skip("Cart Handover not yet implemented")


# TST-BRAIN-061
@pytest.mark.asyncio
async def test_guardian_2_3_2_12_outcome_anonymization(
    mock_guardian, mock_core_client,
) -> None:
    """§2.3.2.12: Anonymized outcome record contains ONLY §08 Lexicon fields — no user DID, no names."""
    pytest.skip("Cart Handover not yet implemented")


# TST-BRAIN-371
@pytest.mark.asyncio
async def test_guardian_2_3_2_8_handover_includes_summary(mock_guardian) -> None:
    """§2.3.2.8: Cart handover message includes a human-readable summary."""
    intent = make_risky_intent(
        action="web_checkout",
        target="https://shop.example.com/cart/abc123",
        summary="Ergonomic chair, qty 1, total $349",
    )
    pytest.skip("Cart Handover not yet implemented")


# TST-BRAIN-372
@pytest.mark.asyncio
async def test_guardian_2_3_2_9_duplicate_handover_idempotent(mock_guardian) -> None:
    """§2.3.2.9: Duplicate cart handover for same cart ID is idempotent."""
    intent = make_risky_intent(
        action="web_checkout",
        target="https://shop.example.com/cart/abc123",
    )
    pytest.skip("Cart Handover not yet implemented")


# ---------------------------------------------------------------------------
# §2.4 Whisper Delivery
# ---------------------------------------------------------------------------


# TST-BRAIN-062
@pytest.mark.asyncio
async def test_guardian_2_4_1_non_streaming_whisper(mock_guardian) -> None:
    """§2.4.1: Non-streaming whisper delivers a single complete message."""
    event = make_fiduciary_event(body="Flight rebooking confirmed")
    pytest.skip("WhisperDelivery not yet implemented")


# TST-BRAIN-063
@pytest.mark.asyncio
async def test_guardian_2_4_2_streaming_whisper(mock_guardian) -> None:
    """§2.4.2: Streaming whisper delivers chunked messages over WebSocket."""
    event = make_solicited_event(body="Here is your detailed analysis...")
    pytest.skip("WhisperDelivery not yet implemented")


# TST-BRAIN-064
@pytest.mark.asyncio
async def test_guardian_2_4_3_disconnected_client_queues(
    mock_guardian, mock_core_client,
) -> None:
    """§2.4.3: Whisper to disconnected client is queued for later delivery."""
    event = make_solicited_event(body="Result ready but client offline")
    pytest.skip("WhisperDelivery not yet implemented")


# TST-BRAIN-065
@pytest.mark.asyncio
async def test_guardian_2_4_4_whisper_includes_vault_references(
    mock_guardian, mock_core_client,
) -> None:
    """§2.4.4: Whisper can include references to vault items (deep links)."""
    event = make_solicited_event(
        body="Based on your stored verdict for video xyz",
        vault_ref="item-001",
    )
    pytest.skip("WhisperDelivery not yet implemented")


# ---------------------------------------------------------------------------
# §2.5 Daily Briefing
# ---------------------------------------------------------------------------


# TST-BRAIN-066
@pytest.mark.asyncio
async def test_guardian_2_5_1_morning_briefing_generated(
    mock_guardian, mock_core_client,
) -> None:
    """§2.5.1: Morning briefing aggregates engagement-tier items."""
    events = [
        make_engagement_event(body=f"Engagement item #{i}") for i in range(5)
    ]
    pytest.skip("BriefingGenerator not yet implemented")


# TST-BRAIN-067
@pytest.mark.asyncio
async def test_guardian_2_5_2_empty_briefing_no_items(mock_guardian) -> None:
    """§2.5.2: Briefing with zero engagement items returns empty/no-op."""
    pytest.skip("BriefingGenerator not yet implemented")


# TST-BRAIN-068
@pytest.mark.asyncio
async def test_guardian_2_5_3_briefing_items_ordered_by_relevance(
    mock_guardian, mock_core_client,
) -> None:
    """§2.5.3: Briefing items are ordered by relevance, not arrival time."""
    events = [
        make_engagement_event(body="Low relevance news", source="rss"),
        make_engagement_event(body="High relevance stock alert", source="finance"),
    ]
    pytest.skip("BriefingGenerator not yet implemented")


# TST-BRAIN-069
@pytest.mark.asyncio
async def test_guardian_2_5_4_dnd_defers_briefing(
    mock_guardian, mock_silence_classifier,
) -> None:
    """§2.5.4: Briefing delivery deferred while DND is active."""
    pytest.skip("BriefingGenerator not yet implemented")


# TST-BRAIN-070
@pytest.mark.asyncio
async def test_guardian_2_5_5_briefing_dedup(
    mock_guardian, mock_core_client,
) -> None:
    """§2.5.5: Duplicate engagement items are deduplicated in briefing."""
    events = [
        make_engagement_event(body="Same podcast episode", source="podcast"),
        make_engagement_event(body="Same podcast episode", source="podcast"),
    ]
    pytest.skip("BriefingGenerator not yet implemented")


# TST-BRAIN-071
@pytest.mark.asyncio
async def test_guardian_2_5_6_restricted_persona_summary(
    mock_guardian, mock_core_client,
) -> None:
    """§2.5.6: Briefing from restricted persona shows summary, not raw data."""
    event = make_engagement_event(
        body="New financial statement available",
        persona_id="financial",
    )
    pytest.skip("BriefingGenerator not yet implemented")


# TST-BRAIN-072
@pytest.mark.asyncio
async def test_guardian_2_5_10_zero_restricted_accesses_omitted(
    mock_guardian, mock_core_client,
) -> None:
    """§2.5.10: Briefing omits restricted persona section when zero accesses in 24h."""
    pytest.skip("BriefingGenerator not yet implemented")


# TST-BRAIN-073
@pytest.mark.asyncio
async def test_guardian_2_5_11_restricted_summary_queries_audit_log(
    mock_guardian, mock_core_client,
) -> None:
    """§2.5.11: Brain queries core audit log for restricted persona access counts."""
    pytest.skip("BriefingGenerator not yet implemented")


# TST-BRAIN-074
@pytest.mark.asyncio
async def test_guardian_2_5_12_briefing_permanently_disabled(
    mock_guardian, mock_core_client,
) -> None:
    """§2.5.12: When briefing config disabled, no briefing generated — fully off, not deferred."""
    pytest.skip("BriefingGenerator not yet implemented")


# TST-BRAIN-373
@pytest.mark.asyncio
async def test_guardian_2_5_7_briefing_includes_fiduciary_recap(
    mock_guardian, mock_core_client,
) -> None:
    """§2.5.7: Briefing includes a recap of fiduciary events since last briefing."""
    fiduciary = make_fiduciary_event(body="Flight was rebooked yesterday")
    engagement = make_engagement_event(body="Blog post from favourite author")
    pytest.skip("BriefingGenerator not yet implemented")


# TST-BRAIN-374
@pytest.mark.asyncio
async def test_guardian_2_5_8_briefing_multi_persona(
    mock_guardian, mock_core_client,
) -> None:
    """§2.5.8: Briefing aggregates across personas without leaking cross-persona data."""
    personal = make_engagement_event(body="Friend posted photos", persona_id="personal")
    work = make_engagement_event(body="Sprint review scheduled", persona_id="work")
    pytest.skip("BriefingGenerator not yet implemented")


# TST-BRAIN-375
@pytest.mark.asyncio
async def test_guardian_2_5_9_briefing_respects_user_preferences(
    mock_guardian, mock_core_client,
) -> None:
    """§2.5.9: Briefing respects user preferences for category ordering and exclusions."""
    events = [
        make_engagement_event(body="Sports score update", source="sports"),
        make_engagement_event(body="Tech news digest", source="tech"),
    ]
    pytest.skip("BriefingGenerator not yet implemented")


# ---------------------------------------------------------------------------
# §2.6 Context Injection (The Nudge)
# ---------------------------------------------------------------------------


# TST-BRAIN-075
@pytest.mark.asyncio
async def test_guardian_2_6_1_nudge_on_conversation_open(
    mock_guardian, mock_core_client,
) -> None:
    """SS2.6.1: Nudge on conversation open — queries recent messages, relationship notes, pending tasks, calendar."""
    pytest.skip("Context injection not yet implemented")
    # User opens Telegram conversation with "Sancho".
    # event = make_event(
    #     type="conversation_open",
    #     body="Sancho",
    #     source="telegram",
    #     contact_did="did:plc:sancho123",
    # )
    # result = await mock_guardian.process_event(event)
    # assert "nudge" in result


# TST-BRAIN-076
@pytest.mark.asyncio
async def test_guardian_2_6_2_nudge_context_assembly(
    mock_guardian, mock_core_client,
) -> None:
    """SS2.6.2: Nudge context assembly — assembles recent msgs, relationship notes, pending tasks, calendar."""
    pytest.skip("Context injection not yet implemented")
    # Recent msg 3 days ago (asked for PDF), mother ill last month, lunch Thursday.
    # Nudge should contain: "He asked for the PDF last week. Mom was ill. Lunch next Thursday."
    # mock_core_client.search_vault.return_value = [
    #     make_vault_item(summary="Asked for PDF", source="telegram"),
    #     make_vault_item(summary="Mother ill", source="telegram"),
    # ]


# TST-BRAIN-077
@pytest.mark.asyncio
async def test_guardian_2_6_3_nudge_delivery_via_ws(
    mock_guardian, mock_core_client,
) -> None:
    """SS2.6.3: Nudge delivery — core pushes assembled context via WS overlay/notification."""
    pytest.skip("Context injection not yet implemented")
    # Verify that after context assembly, guardian sends nudge payload to core
    # for WebSocket delivery.


# TST-BRAIN-078
@pytest.mark.asyncio
async def test_guardian_2_6_4_nudge_no_context_no_interrupt(
    mock_guardian, mock_core_client,
) -> None:
    """SS2.6.4: Nudge with no relevant context — new contact, insufficient data, no nudge sent."""
    pytest.skip("Context injection not yet implemented")
    # User opens conversation with brand-new contact — no vault data.
    # mock_core_client.search_vault.return_value = []
    # result = await mock_guardian.process_event(event)
    # assert result.get("nudge") is None


# TST-BRAIN-079
@pytest.mark.asyncio
async def test_guardian_2_6_5_nudge_respects_persona_boundaries(
    mock_guardian, mock_core_client,
) -> None:
    """SS2.6.5: Nudge respects persona boundaries — locked personas excluded from nudge context."""
    pytest.skip("Context injection not yet implemented")
    # Sancho has data in /personal (open) and /financial (locked).
    # Nudge includes only /personal context — locked personas excluded.


# TST-BRAIN-080
@pytest.mark.asyncio
async def test_guardian_2_6_6_pending_promise_detection(
    mock_guardian, mock_core_client,
) -> None:
    """SS2.6.6: Pending promise detection — "I'll send the PDF tomorrow" surfaces as nudge."""
    pytest.skip("Context injection not yet implemented")
    # Brain found "I'll send the PDF tomorrow" in old messages.
    # Nudge includes: "You promised to send the PDF" — actionable reminder.


# TST-BRAIN-081
@pytest.mark.asyncio
async def test_guardian_2_6_7_calendar_context_included(
    mock_guardian, mock_core_client,
) -> None:
    """SS2.6.7: Calendar context included — upcoming event with contact appears in nudge."""
    pytest.skip("Context injection not yet implemented")
    # Upcoming event with contact → Nudge: "You have lunch planned next Thursday."
    # mock_core_client.search_vault.return_value = [
    #     make_vault_item(type="event", summary="Lunch with Sancho", source="calendar"),
    # ]


# ---------------------------------------------------------------------------
# §2.7 Sharing Policy via Chat (Natural Language -> Core API)
# ---------------------------------------------------------------------------


# TST-BRAIN-082
@pytest.mark.asyncio
async def test_guardian_2_7_1_grant_specific_sharing(
    mock_guardian, mock_core_client,
) -> None:
    """SS2.7.1: Grant specific sharing — "Let Sancho see when I'm arriving" -> PATCH policy."""
    pytest.skip("Sharing policy via chat not yet implemented")
    # User: "Let Sancho see when I'm arriving"
    # Brain calls PATCH /v1/contacts/did:plc:sancho.../policy {"presence": "eta_only"}
    # Confirms: "Done. Sancho can see your ETA, but not your exact location."
    # event = make_event(
    #     type="chat",
    #     body="Let Sancho see when I'm arriving",
    # )
    # result = await mock_guardian.process_event(event)
    # mock_core_client.patch_contact_policy.assert_awaited_once()


# TST-BRAIN-083
@pytest.mark.asyncio
async def test_guardian_2_7_2_revoke_sharing_bulk(
    mock_guardian, mock_core_client,
) -> None:
    """SS2.7.2: Revoke sharing for all contacts — "Stop sharing my location with everyone" -> bulk PATCH."""
    pytest.skip("Sharing policy via chat not yet implemented")
    # User: "Stop sharing my location with everyone"
    # Brain calls PATCH /v1/contacts/policy/bulk {"filter": {}, "policy": {"location": "none"}}
    # Confirms: "Location sharing turned off for all contacts."


# TST-BRAIN-084
@pytest.mark.asyncio
async def test_guardian_2_7_3_query_current_sharing(
    mock_guardian, mock_core_client,
) -> None:
    """SS2.7.3: Query current sharing policy — "What can Sancho see about me?" -> GET policy."""
    pytest.skip("Sharing policy via chat not yet implemented")
    # User: "What can Sancho see about me?"
    # Brain calls GET /v1/contacts/did:plc:sancho.../policy
    # Formats human-readable summary with check/cross marks per category.


# TST-BRAIN-085
@pytest.mark.asyncio
async def test_guardian_2_7_4_grant_full_sharing_specific_category(
    mock_guardian, mock_core_client,
) -> None:
    """SS2.7.4: Grant full sharing for specific category — "Share all my preferences with Sancho"."""
    pytest.skip("Sharing policy via chat not yet implemented")
    # User: "Share all my preferences with Sancho"
    # Brain calls PATCH ... {"preferences": "full"} — only the specified category changes.


# TST-BRAIN-086
@pytest.mark.asyncio
async def test_guardian_2_7_5_ambiguous_request_asks_clarification(
    mock_guardian, mock_core_client,
) -> None:
    """SS2.7.5: Ambiguous request — "Share stuff with Sancho" -> Brain asks for clarification."""
    pytest.skip("Sharing policy via chat not yet implemented")
    # User: "Share stuff with Sancho"
    # Brain asks: "What would you like Sancho to see? Your arrival ETA, calendar
    # availability, preferences, or something else?"
    # event = make_event(type="chat", body="Share stuff with Sancho")
    # result = await mock_guardian.process_event(event)
    # assert "clarification" in result.get("action", "") or "question" in result.get("body", "").lower()


# ---------------------------------------------------------------------------
# §2.8 D2D Payload Preparation (Brain Side)
# ---------------------------------------------------------------------------


# TST-BRAIN-087
@pytest.mark.asyncio
async def test_guardian_2_8_1_brain_prepares_tiered_payload(
    mock_guardian, mock_core_client,
) -> None:
    """SS2.8.1: Brain prepares tiered payload — summary + full detail for D2D send."""
    pytest.skip("D2D payload preparation not yet implemented")
    # D2D send to Sancho about availability.
    # Brain constructs: {availability: {summary: "Busy 2-3pm",
    #   full: "Meeting with Dr. Patel at Apollo Hospital, 2-3pm"}}
    # — both tiers always included.


# TST-BRAIN-088
@pytest.mark.asyncio
async def test_guardian_2_8_2_brain_sends_max_detail(
    mock_guardian, mock_core_client,
) -> None:
    """SS2.8.2: Brain sends max detail — location data includes summary + full coordinates."""
    pytest.skip("D2D payload preparation not yet implemented")
    # D2D send with location data.
    # Brain provides {presence: {summary: "Arriving in ~15 min",
    #   full: "Currently at 12.9716N, 77.5946E, ETA 14 min via MG Road"}}
    # — Core decides what to share.


# TST-BRAIN-089
@pytest.mark.asyncio
async def test_guardian_2_8_3_brain_never_prefilters_by_policy(
    mock_guardian, mock_core_client,
) -> None:
    """SS2.8.3: Brain never pre-filters by policy — always includes all tiers, Core strips."""
    pytest.skip("D2D payload preparation not yet implemented")
    # Brain prepares D2D payload for contact with health: "none".
    # Brain still includes health data in tiered format —
    # Core is the one that strips it. Brain is policy-agnostic.


# TST-BRAIN-090
@pytest.mark.asyncio
async def test_guardian_2_8_4_brain_calls_post_dina_send(
    mock_guardian, mock_core_client,
) -> None:
    """SS2.8.4: Brain calls POST /v1/dina/send — full tiered payload to core for egress."""
    pytest.skip("D2D payload preparation not yet implemented")
    # D2D message ready.
    # Brain sends full tiered payload to core -> core handles egress check,
    # encryption, outbox.
    # mock_core_client.send_d2d.assert_awaited_once()


# ---------------------------------------------------------------------------
# §2.3 Task Queue ACK Protocol (3 scenarios) — arch §04
# ---------------------------------------------------------------------------


# TST-BRAIN-392
def test_guardian_2_3_13_task_ack_after_success(mock_guardian, mock_core_client) -> None:
    """§2.3.13: Brain ACKs task after successful processing.

    Architecture §04: Brain MUST ACK processed tasks via
    POST core:8100/v1/task/ack {task_id}. Core deletes from dina_tasks on ACK.
    """
    pytest.skip("Task ACK protocol not yet implemented")
    # task = make_task_event(task_id="task-abc")
    # await mock_guardian.process_event(task["payload"])
    # mock_core_client.ack_task.assert_called_once_with("task-abc")


# TST-BRAIN-393
def test_guardian_2_3_14_task_not_acked_on_failure(mock_guardian, mock_core_client) -> None:
    """§2.3.14: Brain does NOT ACK failed task.

    Without ACK, core requeues after 5-min timeout.
    """
    pytest.skip("Task ACK protocol not yet implemented")
    # mock_guardian.process_event.side_effect = RuntimeError("processing failed")
    # mock_core_client.ack_task.assert_not_called()


# TST-BRAIN-394
def test_guardian_2_3_15_retried_task_after_crash(mock_guardian, mock_core_client) -> None:
    """§2.3.15: Brain receives retried task (same task_id) after crash.

    Brain should check scratchpad for checkpoint and resume from there.
    """
    pytest.skip("Task ACK protocol not yet implemented")
    # task = make_task_event(task_id="task-abc", attempt=2)
    # mock_core_client.read_scratchpad.return_value = {"step": 2, "context": {...}}
    # result = await mock_guardian.process_event(task["payload"])
    # assert result is not None


# ---------------------------------------------------------------------------
# §2.2 Persona Locked → Unlock → Retry (2 scenarios) — arch §05
# ---------------------------------------------------------------------------


# TST-BRAIN-398
def test_guardian_2_2_5_persona_locked_whisper(mock_guardian, mock_core_client) -> None:
    """§2.2.5: Brain receives 403 Persona Locked → whispers unlock request.

    Architecture §05: Brain gets 403 from core on persona query → must NOT crash,
    must notify user that persona needs unlocking.
    """
    pytest.skip("Persona locked flow not yet implemented")
    # mock_core_client.get_vault_item.side_effect = httpx.HTTPStatusError(
    #     "403 Persona Locked", request=..., response=...)
    # result = await mock_guardian.process_event({"type": "query", "persona_id": "financial"})
    # assert result["action"] == "whisper_unlock_request"


# TST-BRAIN-399
def test_guardian_2_2_6_persona_unlock_retry(mock_guardian, mock_core_client) -> None:
    """§2.2.6: Brain retries query after persona unlock notification.

    Brain receives persona_unlocked event → retries the original query.
    """
    pytest.skip("Persona locked flow not yet implemented")
    # event = make_event(type="persona_unlocked", persona_id="financial")
    # result = await mock_guardian.process_event(event)
    # assert result["action"] == "retry_query"


# ---------------------------------------------------------------------------
# §2.6 Disconnection Pattern Detection (1 scenario) — arch §11
# ---------------------------------------------------------------------------


# TST-BRAIN-411
def test_guardian_2_6_8_disconnection_pattern(mock_guardian, mock_core_client) -> None:
    """§2.6.8: Brain detects contacts with no recent interaction.

    Architecture §11: Brain identifies contacts with no interaction for 30+ days
    and proactively suggests reconnection — Anti-Her nudge toward human connection.
    """
    pytest.skip("Disconnection pattern detection not yet implemented")
    # contacts = [{"did": "did:plc:old_friend", "last_interaction_days": 45}]
    # nudge = await mock_guardian.detect_disconnection(contacts)
    # assert nudge["action"] == "suggest_reconnection"


# ---------------------------------------------------------------------------
# §2.8 DIDComm Message Type Parsing (1 scenario) — arch §09
# ---------------------------------------------------------------------------


# TST-BRAIN-412
def test_guardian_2_8_5_didcomm_message_type_parsing(mock_guardian) -> None:
    """§2.8.5: Brain correctly routes DIDComm message types.

    Architecture §09: Brain must parse DIDComm message types
    (dina/social/arrival, dina/commerce/*, dina/identity/*, dina/reputation/*)
    and route to appropriate handler.
    """
    pytest.skip("DIDComm message type parsing not yet implemented")
    # msg = make_didcomm_message(msg_type="dina/social/arrival")
    # result = await mock_guardian.process_event(msg)
    # assert result["handler"] == "nudge_assembly"
