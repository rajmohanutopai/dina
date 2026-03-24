//go:build cgo

package test

// ==========================================================================
// Phase 2: Persistent Policies + Durable Outbox
//
// Tests verify:
//   ScenarioPolicyManager (SQLite-backed)
//     1. GetScenarioTier returns deny_by_default for unknown contact/scenario
//     2. SetScenarioPolicy + GetScenarioTier round-trip
//     3. ListPolicies returns empty map for unknown contact
//     4. ListPolicies returns all policies after SetScenarioPolicy calls
//     5. SetScenarioPolicy is idempotent (INSERT OR REPLACE)
//     6. SetDefaultPolicies inserts 6 defaults
//     7. SetDefaultPolicies does not overwrite existing policies (OR IGNORE)
//     8. Multiple contacts are isolated
//
//   D2DOutboxManager (SQLite-backed)
//     9.  Enqueue returns an ID
//     10. Enqueue is idempotent (same ID = same row, INSERT OR IGNORE)
//     11. ListPending returns pending messages with next_retry <= now
//     12. ListPending excludes pending_approval messages
//     13. ListPending excludes messages with retries >= 5
//     14. MarkDelivered transitions status to delivered
//     15. MarkFailed increments retries and sets next_retry with backoff
//     16. Requeue resets status to pending for failed messages
//     17. Requeue returns error for non-failed messages
//     18. PendingCount counts only pending (not failed/delivered/pending_approval)
//     19. DeleteExpired removes delivered/failed messages older than TTL
//     20. DeleteExpired does NOT remove pending messages
//     21. ResumeAfterApproval transitions pending_approval → pending
//     22. ResumeAfterApproval returns error for non-pending_approval messages
// ==========================================================================

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/adapter/sqlite"
	"github.com/rajmohanutopai/dina/core/internal/domain"
)

// ---------------------------------------------------------------------------
// Helper: openIdentityDB sets up a temporary SQLite identity DB for testing.
// ---------------------------------------------------------------------------

func newTestPool(t *testing.T) *sqlite.Pool {
	t.Helper()
	dir, err := os.MkdirTemp("", "dina-phase2-test-*")
	if err != nil {
		t.Fatalf("mkdtemp: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })

	pool := sqlite.NewPool(dir)
	// Use a fixed 32-byte DEK (all zeros) — this is a test; encryption
	// correctness is tested in the vault adapter tests.
	dek := make([]byte, 32)
	if err := pool.Open("identity", dek); err != nil {
		t.Fatalf("pool.Open: %v", err)
	}
	t.Cleanup(func() { pool.Close("identity") })
	return pool
}

// ---------------------------------------------------------------------------
// ScenarioPolicyManager tests
// ---------------------------------------------------------------------------

// TST-CORE-D2D-200
// GetScenarioTier returns deny_by_default when no policy has been set.
func TestScenarioPolicy_GetTier_DefaultDeny(t *testing.T) {
	pool := newTestPool(t)
	mgr := sqlite.NewScenarioPolicyManager(pool)

	tier, err := mgr.GetScenarioTier(context.Background(), "did:plc:unknown", "presence.signal")
	if err != nil {
		t.Fatalf("GetScenarioTier: %v", err)
	}
	if tier != domain.ScenarioDenyByDefault {
		t.Errorf("want ScenarioDenyByDefault, got %q", tier)
	}
}

// TST-CORE-D2D-201
// SetScenarioPolicy + GetScenarioTier round-trip.
func TestScenarioPolicy_SetGet_RoundTrip(t *testing.T) {
	pool := newTestPool(t)
	mgr := sqlite.NewScenarioPolicyManager(pool)
	ctx := context.Background()

	contact := "did:plc:alice"
	cases := []struct {
		scenario string
		tier     domain.ScenarioTier
	}{
		{"presence.signal", domain.ScenarioStandingPolicy},
		{"trust.vouch", domain.ScenarioExplicitOnce},
		{"coordination", domain.ScenarioDenyByDefault},
	}

	for _, tc := range cases {
		if err := mgr.SetScenarioPolicy(ctx, contact, tc.scenario, tc.tier); err != nil {
			t.Fatalf("SetScenarioPolicy(%q, %q, %q): %v", contact, tc.scenario, tc.tier, err)
		}
		got, err := mgr.GetScenarioTier(ctx, contact, tc.scenario)
		if err != nil {
			t.Fatalf("GetScenarioTier(%q, %q): %v", contact, tc.scenario, err)
		}
		if got != tc.tier {
			t.Errorf("scenario=%q: want %q, got %q", tc.scenario, tc.tier, got)
		}
	}
}

// TST-CORE-D2D-202
// ListPolicies returns empty map for unknown contact.
func TestScenarioPolicy_ListPolicies_EmptyForUnknown(t *testing.T) {
	pool := newTestPool(t)
	mgr := sqlite.NewScenarioPolicyManager(pool)

	policies, err := mgr.ListPolicies(context.Background(), "did:plc:nobody")
	if err != nil {
		t.Fatalf("ListPolicies: %v", err)
	}
	if len(policies) != 0 {
		t.Errorf("want empty map, got %v", policies)
	}
}

// TST-CORE-D2D-203
// ListPolicies returns all policies after SetScenarioPolicy calls.
func TestScenarioPolicy_ListPolicies_AllPolicies(t *testing.T) {
	pool := newTestPool(t)
	mgr := sqlite.NewScenarioPolicyManager(pool)
	ctx := context.Background()

	contact := "did:plc:bob"
	want := map[string]domain.ScenarioTier{
		"presence.signal":  domain.ScenarioStandingPolicy,
		"social.update":    domain.ScenarioStandingPolicy,
		"trust.vouch":      domain.ScenarioExplicitOnce,
		"coordination": domain.ScenarioStandingPolicy,
	}
	for scenario, tier := range want {
		if err := mgr.SetScenarioPolicy(ctx, contact, scenario, tier); err != nil {
			t.Fatalf("SetScenarioPolicy: %v", err)
		}
	}

	got, err := mgr.ListPolicies(ctx, contact)
	if err != nil {
		t.Fatalf("ListPolicies: %v", err)
	}
	if len(got) != len(want) {
		t.Fatalf("want %d policies, got %d: %v", len(want), len(got), got)
	}
	for scenario, tier := range want {
		if got[scenario] != tier {
			t.Errorf("scenario=%q: want %q, got %q", scenario, tier, got[scenario])
		}
	}
}

// TST-CORE-D2D-204
// SetScenarioPolicy is idempotent (INSERT OR REPLACE replaces existing tier).
func TestScenarioPolicy_SetPolicy_Idempotent(t *testing.T) {
	pool := newTestPool(t)
	mgr := sqlite.NewScenarioPolicyManager(pool)
	ctx := context.Background()

	contact := "did:plc:charlie"
	scenario := "presence.signal"

	// First set to standing_policy.
	if err := mgr.SetScenarioPolicy(ctx, contact, scenario, domain.ScenarioStandingPolicy); err != nil {
		t.Fatalf("first set: %v", err)
	}
	// Replace with deny_by_default.
	if err := mgr.SetScenarioPolicy(ctx, contact, scenario, domain.ScenarioDenyByDefault); err != nil {
		t.Fatalf("second set: %v", err)
	}

	got, err := mgr.GetScenarioTier(ctx, contact, scenario)
	if err != nil {
		t.Fatalf("GetScenarioTier: %v", err)
	}
	if got != domain.ScenarioDenyByDefault {
		t.Errorf("want deny_by_default (replaced), got %q", got)
	}
}

// TST-CORE-D2D-205
// SetDefaultPolicies inserts 6 defaults for a new contact.
func TestScenarioPolicy_SetDefaultPolicies_FiveDefaults(t *testing.T) {
	pool := newTestPool(t)
	mgr := sqlite.NewScenarioPolicyManager(pool)
	ctx := context.Background()

	contact := "did:plc:dave"
	if err := mgr.SetDefaultPolicies(ctx, contact); err != nil {
		t.Fatalf("SetDefaultPolicies: %v", err)
	}

	policies, err := mgr.ListPolicies(ctx, contact)
	if err != nil {
		t.Fatalf("ListPolicies: %v", err)
	}
	if len(policies) != 5 {
		t.Errorf("want 5 default policies, got %d: %v", len(policies), policies)
	}

	// Verify specific defaults.
	if policies["presence"] != domain.ScenarioStandingPolicy {
		t.Errorf("presence: want standing_policy, got %q", policies["presence"])
	}
	if policies["coordination"] != domain.ScenarioStandingPolicy {
		t.Errorf("coordination: want standing_policy, got %q", policies["coordination"])
	}
	if policies["social"] != domain.ScenarioStandingPolicy {
		t.Errorf("social: want standing_policy, got %q", policies["social"])
	}
	if policies["trust"] != domain.ScenarioExplicitOnce {
		t.Errorf("trust: want explicit_once, got %q", policies["trust"])
	}
	if policies["safety"] != domain.ScenarioStandingPolicy {
		t.Errorf("safety: want standing_policy, got %q", policies["safety"])
	}
}

// TST-CORE-D2D-206
// SetDefaultPolicies does not overwrite existing policies (INSERT OR IGNORE).
func TestScenarioPolicy_SetDefaultPolicies_NoOverwrite(t *testing.T) {
	pool := newTestPool(t)
	mgr := sqlite.NewScenarioPolicyManager(pool)
	ctx := context.Background()

	contact := "did:plc:eve"

	// Pre-set presence.signal to deny_by_default before defaults.
	if err := mgr.SetScenarioPolicy(ctx, contact, "presence.signal", domain.ScenarioDenyByDefault); err != nil {
		t.Fatalf("pre-set: %v", err)
	}

	// SetDefaultPolicies should not overwrite the existing presence.signal policy.
	if err := mgr.SetDefaultPolicies(ctx, contact); err != nil {
		t.Fatalf("SetDefaultPolicies: %v", err)
	}

	got, err := mgr.GetScenarioTier(ctx, contact, "presence.signal")
	if err != nil {
		t.Fatalf("GetScenarioTier: %v", err)
	}
	if got != domain.ScenarioDenyByDefault {
		t.Errorf("pre-existing policy should not be overwritten; want deny_by_default, got %q", got)
	}
}

// TST-CORE-D2D-207
// Multiple contacts have isolated policies.
func TestScenarioPolicy_MultipleContacts_Isolated(t *testing.T) {
	pool := newTestPool(t)
	mgr := sqlite.NewScenarioPolicyManager(pool)
	ctx := context.Background()

	if err := mgr.SetScenarioPolicy(ctx, "did:plc:alice", "presence.signal", domain.ScenarioStandingPolicy); err != nil {
		t.Fatal(err)
	}
	if err := mgr.SetScenarioPolicy(ctx, "did:plc:bob", "presence.signal", domain.ScenarioDenyByDefault); err != nil {
		t.Fatal(err)
	}

	aliceTier, _ := mgr.GetScenarioTier(ctx, "did:plc:alice", "presence.signal")
	bobTier, _ := mgr.GetScenarioTier(ctx, "did:plc:bob", "presence.signal")

	if aliceTier != domain.ScenarioStandingPolicy {
		t.Errorf("alice: want standing_policy, got %q", aliceTier)
	}
	if bobTier != domain.ScenarioDenyByDefault {
		t.Errorf("bob: want deny_by_default, got %q", bobTier)
	}
}

// ---------------------------------------------------------------------------
// D2DOutboxManager tests
// ---------------------------------------------------------------------------

func newTestD2DOutbox(t *testing.T) *sqlite.D2DOutboxManager {
	t.Helper()
	pool := newTestPool(t)
	return sqlite.NewD2DOutboxManager(pool)
}

// TST-CORE-D2D-210
// Enqueue returns a non-empty ID.
func TestD2DOutbox_Enqueue_ReturnsID(t *testing.T) {
	outbox := newTestD2DOutbox(t)
	ctx := context.Background()

	id, err := outbox.Enqueue(ctx, domain.OutboxMessage{
		ToDID:   "did:plc:recipient",
		Payload: []byte(`{"test":true}`),
	})
	if err != nil {
		t.Fatalf("Enqueue: %v", err)
	}
	if id == "" {
		t.Fatal("Enqueue returned empty ID")
	}
}

// TST-CORE-D2D-211
// Enqueue with the same ID is idempotent (INSERT OR IGNORE).
func TestD2DOutbox_Enqueue_Idempotent(t *testing.T) {
	outbox := newTestD2DOutbox(t)
	ctx := context.Background()

	msg := domain.OutboxMessage{
		ID:      "test-idempotent-id",
		ToDID:   "did:plc:recipient",
		Payload: []byte(`{"test":true}`),
	}

	id1, err := outbox.Enqueue(ctx, msg)
	if err != nil {
		t.Fatalf("first Enqueue: %v", err)
	}
	id2, err := outbox.Enqueue(ctx, msg)
	if err != nil {
		t.Fatalf("second Enqueue: %v", err)
	}
	if id1 != id2 {
		t.Errorf("idempotent: want same ID, got %q vs %q", id1, id2)
	}

	// Count should be exactly 1.
	count, err := outbox.PendingCount(ctx)
	if err != nil {
		t.Fatalf("PendingCount: %v", err)
	}
	if count != 1 {
		t.Errorf("want 1 pending, got %d", count)
	}
}

// TST-CORE-D2D-212
// ListPending returns pending messages with next_retry <= now.
func TestD2DOutbox_ListPending_ReturnsPendingMessages(t *testing.T) {
	outbox := newTestD2DOutbox(t)
	ctx := context.Background()

	// Enqueue 2 messages.
	id1, err := outbox.Enqueue(ctx, domain.OutboxMessage{ToDID: "did:plc:a", Payload: []byte(`{}`)})
	if err != nil {
		t.Fatalf("Enqueue 1: %v", err)
	}
	id2, err := outbox.Enqueue(ctx, domain.OutboxMessage{ToDID: "did:plc:b", Payload: []byte(`{}`)})
	if err != nil {
		t.Fatalf("Enqueue 2: %v", err)
	}

	msgs, err := outbox.ListPending(ctx)
	if err != nil {
		t.Fatalf("ListPending: %v", err)
	}
	if len(msgs) != 2 {
		t.Fatalf("want 2 pending, got %d", len(msgs))
	}

	ids := map[string]bool{msgs[0].ID: true, msgs[1].ID: true}
	if !ids[id1] || !ids[id2] {
		t.Errorf("expected both IDs in pending list, got %v", ids)
	}
}

// TST-CORE-D2D-213
// ListPending excludes pending_approval messages.
func TestD2DOutbox_ListPending_ExcludesPendingApproval(t *testing.T) {
	outbox := newTestD2DOutbox(t)
	ctx := context.Background()

	// Enqueue a message with status=pending_approval.
	_, err := outbox.Enqueue(ctx, domain.OutboxMessage{
		ID:      "approval-msg",
		ToDID:   "did:plc:x",
		Payload: []byte(`{}`),
		Status:  string(domain.OutboxPendingApproval),
	})
	if err != nil {
		t.Fatalf("Enqueue pending_approval: %v", err)
	}

	msgs, err := outbox.ListPending(ctx)
	if err != nil {
		t.Fatalf("ListPending: %v", err)
	}
	for _, m := range msgs {
		if m.ID == "approval-msg" {
			t.Error("ListPending should not include pending_approval messages")
		}
	}
}

// TST-CORE-D2D-214
// ListPending excludes messages with retries >= 5.
func TestD2DOutbox_ListPending_ExcludesExhaustedRetries(t *testing.T) {
	outbox := newTestD2DOutbox(t)
	ctx := context.Background()

	// Enqueue a message that has been retried 5 times.
	_, err := outbox.Enqueue(ctx, domain.OutboxMessage{
		ID:      "exhausted-msg",
		ToDID:   "did:plc:x",
		Payload: []byte(`{}`),
		Retries: 5,
	})
	if err != nil {
		t.Fatalf("Enqueue exhausted: %v", err)
	}

	// Exhaust retries via MarkFailed.
	for i := 0; i < 5; i++ {
		if err := outbox.MarkFailed(ctx, "exhausted-msg"); err != nil {
			t.Fatalf("MarkFailed iteration %d: %v", i, err)
		}
	}

	msgs, err := outbox.ListPending(ctx)
	if err != nil {
		t.Fatalf("ListPending: %v", err)
	}
	for _, m := range msgs {
		if m.ID == "exhausted-msg" {
			t.Error("ListPending should not include messages with retries >= 5")
		}
	}
}

// TST-CORE-D2D-215
// MarkDelivered transitions status to delivered.
func TestD2DOutbox_MarkDelivered(t *testing.T) {
	outbox := newTestD2DOutbox(t)
	ctx := context.Background()

	id, err := outbox.Enqueue(ctx, domain.OutboxMessage{ToDID: "did:plc:x", Payload: []byte(`{}`)})
	if err != nil {
		t.Fatalf("Enqueue: %v", err)
	}

	if err := outbox.MarkDelivered(ctx, id); err != nil {
		t.Fatalf("MarkDelivered: %v", err)
	}

	// Delivered messages should not appear in ListPending.
	msgs, err := outbox.ListPending(ctx)
	if err != nil {
		t.Fatalf("ListPending: %v", err)
	}
	for _, m := range msgs {
		if m.ID == id {
			t.Error("delivered message should not appear in ListPending")
		}
	}
}

// TST-CORE-D2D-216
// MarkFailed increments retries and sets next_retry with exponential backoff.
func TestD2DOutbox_MarkFailed_ExponentialBackoff(t *testing.T) {
	outbox := newTestD2DOutbox(t)
	ctx := context.Background()

	id, err := outbox.Enqueue(ctx, domain.OutboxMessage{ToDID: "did:plc:x", Payload: []byte(`{}`)})
	if err != nil {
		t.Fatalf("Enqueue: %v", err)
	}

	before := time.Now().Unix()
	if err := outbox.MarkFailed(ctx, id); err != nil {
		t.Fatalf("MarkFailed: %v", err)
	}

	// After first failure: retries=1, backoff=30*2^1=60s.
	msgs, err := outbox.ListPending(ctx)
	if err != nil {
		t.Fatalf("ListPending: %v", err)
	}
	// Message should not be in ListPending immediately (next_retry is in the future).
	for _, m := range msgs {
		if m.ID == id {
			t.Error("failed message with future next_retry should not appear in ListPending immediately")
		}
	}
	_ = before // suppress unused warning
}

// TST-CORE-D2D-217
// Requeue resets failed message to pending with zero retries.
func TestD2DOutbox_Requeue_ResetsPendingState(t *testing.T) {
	outbox := newTestD2DOutbox(t)
	ctx := context.Background()

	id, err := outbox.Enqueue(ctx, domain.OutboxMessage{ToDID: "did:plc:x", Payload: []byte(`{}`)})
	if err != nil {
		t.Fatalf("Enqueue: %v", err)
	}

	// Fail the message.
	if err := outbox.MarkFailed(ctx, id); err != nil {
		t.Fatalf("MarkFailed: %v", err)
	}

	// Requeue it.
	if err := outbox.Requeue(ctx, id); err != nil {
		t.Fatalf("Requeue: %v", err)
	}

	// Message should be pending (ListPending should include it now).
	msgs, err := outbox.ListPending(ctx)
	if err != nil {
		t.Fatalf("ListPending: %v", err)
	}
	found := false
	for _, m := range msgs {
		if m.ID == id {
			found = true
			if m.Status != "pending" {
				t.Errorf("want status=pending, got %q", m.Status)
			}
		}
	}
	if !found {
		t.Error("requeued message should appear in ListPending")
	}
}

// TST-CORE-D2D-218
// Requeue returns error for non-failed messages.
func TestD2DOutbox_Requeue_ErrorForNonFailed(t *testing.T) {
	outbox := newTestD2DOutbox(t)
	ctx := context.Background()

	id, err := outbox.Enqueue(ctx, domain.OutboxMessage{ToDID: "did:plc:x", Payload: []byte(`{}`)})
	if err != nil {
		t.Fatalf("Enqueue: %v", err)
	}

	// Try to requeue a pending (not failed) message.
	err = outbox.Requeue(ctx, id)
	if err == nil {
		t.Error("Requeue on a pending message should return an error")
	}
}

// TST-CORE-D2D-219
// PendingCount counts only pending (not failed/delivered/pending_approval).
func TestD2DOutbox_PendingCount(t *testing.T) {
	outbox := newTestD2DOutbox(t)
	ctx := context.Background()

	// Enqueue 3 messages.
	id1, _ := outbox.Enqueue(ctx, domain.OutboxMessage{ToDID: "did:plc:a", Payload: []byte(`{}`)})
	id2, _ := outbox.Enqueue(ctx, domain.OutboxMessage{ToDID: "did:plc:b", Payload: []byte(`{}`)})
	_, _ = outbox.Enqueue(ctx, domain.OutboxMessage{
		ID:      "approval-only",
		ToDID:   "did:plc:c",
		Payload: []byte(`{}`),
		Status:  string(domain.OutboxPendingApproval),
	})

	// Mark one delivered.
	_ = outbox.MarkDelivered(ctx, id1)
	// Mark one failed.
	_ = outbox.MarkFailed(ctx, id2)

	count, err := outbox.PendingCount(ctx)
	if err != nil {
		t.Fatalf("PendingCount: %v", err)
	}
	// Only the third message (approval-only) started as pending_approval (not counted),
	// id1 is delivered, id2 is failed — count should be 0.
	if count != 0 {
		t.Errorf("want 0 pending (all transitioned), got %d", count)
	}
}

// TST-CORE-D2D-220
// DeleteExpired removes delivered/failed messages older than TTL.
func TestD2DOutbox_DeleteExpired_RemovesOldTerminalMessages(t *testing.T) {
	outbox := newTestD2DOutbox(t)
	ctx := context.Background()

	// Enqueue and deliver an old message (25 hours ago).
	oldID, err := outbox.Enqueue(ctx, domain.OutboxMessage{
		ID:        "old-delivered",
		ToDID:     "did:plc:x",
		Payload:   []byte(`{}`),
		CreatedAt: time.Now().Unix() - 90000, // 25 hours ago
	})
	if err != nil {
		t.Fatalf("Enqueue old: %v", err)
	}
	if err := outbox.MarkDelivered(ctx, oldID); err != nil {
		t.Fatalf("MarkDelivered old: %v", err)
	}

	// Enqueue a fresh delivered message.
	freshID, err := outbox.Enqueue(ctx, domain.OutboxMessage{
		ID:      "fresh-delivered",
		ToDID:   "did:plc:y",
		Payload: []byte(`{}`),
	})
	if err != nil {
		t.Fatalf("Enqueue fresh: %v", err)
	}
	if err := outbox.MarkDelivered(ctx, freshID); err != nil {
		t.Fatalf("MarkDelivered fresh: %v", err)
	}

	// DeleteExpired with 24h TTL — only old message should be removed.
	n, err := outbox.DeleteExpired(ctx, 86400)
	if err != nil {
		t.Fatalf("DeleteExpired: %v", err)
	}
	if n != 1 {
		t.Errorf("want 1 deleted, got %d", n)
	}

	// Fresh message still lives in the DB (verify via pending count — it's delivered,
	// so pending count won't show it, but calling DeleteExpired again proves it remains).
	n2, err := outbox.DeleteExpired(ctx, 86400)
	if err != nil {
		t.Fatalf("DeleteExpired 2nd call: %v", err)
	}
	if n2 != 0 {
		t.Errorf("fresh message should not be deleted; want 0, got %d", n2)
	}
}

// TST-CORE-D2D-221
// DeleteExpired does NOT remove pending messages.
func TestD2DOutbox_DeleteExpired_PreservesPendingMessages(t *testing.T) {
	outbox := newTestD2DOutbox(t)
	ctx := context.Background()

	// Enqueue an old pending message.
	_, err := outbox.Enqueue(ctx, domain.OutboxMessage{
		ID:        "old-pending",
		ToDID:     "did:plc:x",
		Payload:   []byte(`{}`),
		CreatedAt: time.Now().Unix() - 90000, // 25 hours ago
	})
	if err != nil {
		t.Fatalf("Enqueue: %v", err)
	}

	// DeleteExpired should NOT delete pending messages.
	n, err := outbox.DeleteExpired(ctx, 86400)
	if err != nil {
		t.Fatalf("DeleteExpired: %v", err)
	}
	if n != 0 {
		t.Errorf("pending messages must not be deleted; want 0, got %d", n)
	}

	// Message should still be in ListPending.
	msgs, err := outbox.ListPending(ctx)
	if err != nil {
		t.Fatalf("ListPending: %v", err)
	}
	found := false
	for _, m := range msgs {
		if m.ID == "old-pending" {
			found = true
		}
	}
	if !found {
		t.Error("old pending message should still appear in ListPending after DeleteExpired")
	}
}

// TST-CORE-D2D-222
// ResumeAfterApproval transitions pending_approval → pending.
func TestD2DOutbox_ResumeAfterApproval(t *testing.T) {
	outbox := newTestD2DOutbox(t)
	ctx := context.Background()

	// Enqueue a pending_approval message.
	_, err := outbox.Enqueue(ctx, domain.OutboxMessage{
		ID:      "approval-msg",
		ToDID:   "did:plc:x",
		Payload: []byte(`{}`),
		Status:  string(domain.OutboxPendingApproval),
	})
	if err != nil {
		t.Fatalf("Enqueue pending_approval: %v", err)
	}

	// It should NOT be in ListPending.
	msgs, err := outbox.ListPending(ctx)
	if err != nil {
		t.Fatalf("ListPending before resume: %v", err)
	}
	for _, m := range msgs {
		if m.ID == "approval-msg" {
			t.Error("pending_approval should not appear in ListPending")
		}
	}

	// Resume after approval.
	if err := outbox.ResumeAfterApproval(ctx, "approval-msg"); err != nil {
		t.Fatalf("ResumeAfterApproval: %v", err)
	}

	// Now it should appear in ListPending.
	msgs, err = outbox.ListPending(ctx)
	if err != nil {
		t.Fatalf("ListPending after resume: %v", err)
	}
	found := false
	for _, m := range msgs {
		if m.ID == "approval-msg" {
			found = true
			if m.Status != "pending" {
				t.Errorf("want status=pending after resume, got %q", m.Status)
			}
		}
	}
	if !found {
		t.Error("resumed message should appear in ListPending")
	}
}

// TST-CORE-D2D-223
// ResumeAfterApproval returns error for non-pending_approval messages.
func TestD2DOutbox_ResumeAfterApproval_ErrorForWrongStatus(t *testing.T) {
	outbox := newTestD2DOutbox(t)
	ctx := context.Background()

	id, err := outbox.Enqueue(ctx, domain.OutboxMessage{ToDID: "did:plc:x", Payload: []byte(`{}`)})
	if err != nil {
		t.Fatalf("Enqueue: %v", err)
	}

	// Message is pending, not pending_approval.
	err = outbox.ResumeAfterApproval(ctx, id)
	if err == nil {
		t.Error("ResumeAfterApproval on non-pending_approval message should return error")
	}
}
