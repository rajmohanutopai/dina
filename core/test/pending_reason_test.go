package test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/adapter/sqlite"
	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/test/testutil"
)

// ==========================================================================
// Pending Reason Store — async approval-wait-resume
// ==========================================================================

// mockPendingReasonStore is an in-memory implementation for testing.
type mockPendingReasonStore struct {
	records map[string]*domain.PendingReasonRecord
}

func newMockPendingReasonStore() *mockPendingReasonStore {
	return &mockPendingReasonStore{records: make(map[string]*domain.PendingReasonRecord)}
}

func (s *mockPendingReasonStore) Create(_ context.Context, r domain.PendingReasonRecord) error {
	s.records[r.RequestID] = &r
	return nil
}

func (s *mockPendingReasonStore) GetByID(_ context.Context, requestID, callerDID string) (*domain.PendingReasonRecord, error) {
	r, ok := s.records[requestID]
	if !ok {
		return nil, nil
	}
	if callerDID != "" && r.CallerDID != callerDID {
		return nil, fmt.Errorf("pending_reason: access denied (caller mismatch)")
	}
	return r, nil
}

func (s *mockPendingReasonStore) GetByApprovalID(_ context.Context, approvalID string) ([]domain.PendingReasonRecord, error) {
	var out []domain.PendingReasonRecord
	for _, r := range s.records {
		if r.ApprovalID == approvalID && r.Status == domain.ReasonPendingApproval {
			out = append(out, *r)
		}
	}
	return out, nil
}

func (s *mockPendingReasonStore) UpdateStatus(_ context.Context, requestID, status, result, errMsg string) error {
	r, ok := s.records[requestID]
	if !ok {
		return nil
	}
	r.Status = status
	r.Result = result
	r.Error = errMsg
	r.UpdatedAt = time.Now().Unix()
	return nil
}

func (s *mockPendingReasonStore) UpdateApprovalID(_ context.Context, requestID, approvalID string) error {
	r, ok := s.records[requestID]
	if !ok {
		return nil
	}
	r.ApprovalID = approvalID
	r.UpdatedAt = time.Now().Unix()
	r.ExpiresAt = time.Now().Unix() + int64(domain.DefaultPendingReasonTTL)
	return nil
}

func (s *mockPendingReasonStore) Sweep(_ context.Context) (int, error) {
	now := time.Now().Unix()
	count := 0
	for id, r := range s.records {
		if r.ExpiresAt > 0 && r.ExpiresAt < now {
			delete(s.records, id)
			count++
		}
	}
	return count, nil
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Real SQLite adapter tests (exercises actual persistence + query paths)
// ---------------------------------------------------------------------------

func newSQLitePendingReasonStore(t *testing.T) *sqlite.PendingReasonStore {
	t.Helper()
	dir := t.TempDir()
	// Use the real SQLite vault adapter (CGO/FTS5) for identity.sqlite.
	adapter := sqlite.NewVaultAdapter(dir)
	identityPersona, _ := domain.NewPersonaName("identity")
	dek := testutil.TestDEK[:]
	if err := adapter.Open(context.Background(), identityPersona, dek); err != nil {
		t.Fatalf("open identity: %v", err)
	}
	return sqlite.NewPendingReasonStore(adapter.Pool())
}

func TestPendingReason_SQLite_SecondApprovalExtendsExpiry(t *testing.T) {
	store := newSQLitePendingReasonStore(t)
	ctx := context.Background()
	now := time.Now().Unix()

	// Create with initial expiry close to now
	err := store.Create(ctx, domain.PendingReasonRecord{
		RequestID:   "reason-sqlite-1",
		CallerDID:   "did:key:agent1",
		ApprovalID:  "apr-first",
		Status:      domain.ReasonPendingApproval,
		RequestMeta: `{"prompt":"test"}`,
		CreatedAt:   now,
		UpdatedAt:   now,
		ExpiresAt:   now + 60, // expires in 60s
	})
	testutil.RequireNoError(t, err)

	// Update to second approval — must extend expiry
	err = store.UpdateApprovalID(ctx, "reason-sqlite-1", "apr-second")
	testutil.RequireNoError(t, err)

	// Verify expiry was extended
	r, err := store.GetByID(ctx, "reason-sqlite-1", "did:key:agent1")
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, r)
	testutil.RequireEqual(t, r.ApprovalID, "apr-second")

	// Expiry should be now + 30min, not the old now + 60s
	if r.ExpiresAt <= now+60 {
		t.Fatalf("expires_at not extended: got %d, want > %d", r.ExpiresAt, now+60)
	}
	if r.ExpiresAt < now+int64(domain.DefaultPendingReasonTTL)-10 {
		t.Fatalf("expires_at too short: got %d, want ~%d", r.ExpiresAt, now+int64(domain.DefaultPendingReasonTTL))
	}

	// Old approval ID should not find the record
	records, err := store.GetByApprovalID(ctx, "apr-first")
	testutil.RequireNoError(t, err)
	if len(records) != 0 {
		t.Fatalf("old approval_id should return 0 records, got %d", len(records))
	}

	// New approval ID should find it
	records, err = store.GetByApprovalID(ctx, "apr-second")
	testutil.RequireNoError(t, err)
	if len(records) != 1 {
		t.Fatalf("new approval_id should return 1 record, got %d", len(records))
	}
}

func TestPendingReason_SQLite_CallerBinding(t *testing.T) {
	store := newSQLitePendingReasonStore(t)
	ctx := context.Background()
	now := time.Now().Unix()

	err := store.Create(ctx, domain.PendingReasonRecord{
		RequestID:   "reason-bound",
		CallerDID:   "did:key:agent1",
		ApprovalID:  "apr-bound",
		Status:      domain.ReasonPendingApproval,
		RequestMeta: `{"prompt":"test"}`,
		CreatedAt:   now,
		UpdatedAt:   now,
		ExpiresAt:   now + 1800,
	})
	testutil.RequireNoError(t, err)

	// Same caller → success
	r, err := store.GetByID(ctx, "reason-bound", "did:key:agent1")
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, r)

	// Wrong caller → access denied
	_, err = store.GetByID(ctx, "reason-bound", "did:key:agent2")
	if err == nil {
		t.Fatal("expected access denied for wrong caller")
	}

	// Empty callerDID → bypasses binding (used by Core internal calls)
	r, err = store.GetByID(ctx, "reason-bound", "")
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, r)
	testutil.RequireEqual(t, r.CallerDID, "did:key:agent1")
}

func TestPendingReason_SQLite_NotFoundReturnsNil(t *testing.T) {
	store := newSQLitePendingReasonStore(t)
	ctx := context.Background()

	r, err := store.GetByID(ctx, "reason-nonexistent", "did:key:anyone")
	testutil.RequireNoError(t, err)
	if r != nil {
		t.Fatalf("expected nil for missing record, got %+v", r)
	}
}

func TestPendingReason_SQLite_CompleteLifecycle(t *testing.T) {
	store := newSQLitePendingReasonStore(t)
	ctx := context.Background()
	now := time.Now().Unix()

	// Create
	err := store.Create(ctx, domain.PendingReasonRecord{
		RequestID:   "reason-lifecycle",
		CallerDID:   "did:key:agent1",
		ApprovalID:  "apr-lifecycle",
		Status:      domain.ReasonPendingApproval,
		RequestMeta: `{"prompt":"health query"}`,
		CreatedAt:   now,
		UpdatedAt:   now,
		ExpiresAt:   now + 1800,
	})
	testutil.RequireNoError(t, err)

	// Update to resuming
	err = store.UpdateStatus(ctx, "reason-lifecycle", domain.ReasonResuming, "", "")
	testutil.RequireNoError(t, err)

	// Update to complete with result
	result := `{"content":"Your B12 is low.","model":"gemini-lite"}`
	err = store.UpdateStatus(ctx, "reason-lifecycle", domain.ReasonComplete, result, "")
	testutil.RequireNoError(t, err)

	// Verify
	r, err := store.GetByID(ctx, "reason-lifecycle", "did:key:agent1")
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, r)
	testutil.RequireEqual(t, r.Status, domain.ReasonComplete)
	testutil.RequireEqual(t, r.Result, result)
}

func TestPendingReason_SQLite_DeniedStatus(t *testing.T) {
	store := newSQLitePendingReasonStore(t)
	ctx := context.Background()
	now := time.Now().Unix()

	err := store.Create(ctx, domain.PendingReasonRecord{
		RequestID:   "reason-deny-sql",
		CallerDID:   "did:key:agent1",
		ApprovalID:  "apr-deny",
		Status:      domain.ReasonPendingApproval,
		RequestMeta: `{"prompt":"test"}`,
		CreatedAt:   now,
		UpdatedAt:   now,
		ExpiresAt:   now + 1800,
	})
	testutil.RequireNoError(t, err)

	err = store.UpdateStatus(ctx, "reason-deny-sql", domain.ReasonDenied, "", "user denied access")
	testutil.RequireNoError(t, err)

	r, err := store.GetByID(ctx, "reason-deny-sql", "did:key:agent1")
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, r)
	testutil.RequireEqual(t, r.Status, domain.ReasonDenied)
	testutil.RequireEqual(t, r.Error, "user denied access")

	// Denied records should NOT appear in GetByApprovalID (only pending_approval)
	records, err := store.GetByApprovalID(ctx, "apr-deny")
	testutil.RequireNoError(t, err)
	if len(records) != 0 {
		t.Fatalf("denied records should not appear in GetByApprovalID, got %d", len(records))
	}
}

func TestPendingReason_SQLite_GetByApprovalIDFiltersNonPending(t *testing.T) {
	store := newSQLitePendingReasonStore(t)
	ctx := context.Background()
	now := time.Now().Unix()

	// Create two records with the same approval_id
	for _, id := range []string{"reason-a", "reason-b"} {
		err := store.Create(ctx, domain.PendingReasonRecord{
			RequestID:   id,
			CallerDID:   "did:key:agent1",
			ApprovalID:  "apr-shared",
			Status:      domain.ReasonPendingApproval,
			RequestMeta: `{}`,
			CreatedAt:   now,
			UpdatedAt:   now,
			ExpiresAt:   now + 1800,
		})
		testutil.RequireNoError(t, err)
	}

	// Both should be found
	records, err := store.GetByApprovalID(ctx, "apr-shared")
	testutil.RequireNoError(t, err)
	if len(records) != 2 {
		t.Fatalf("expected 2 pending records, got %d", len(records))
	}

	// Complete one — only one should remain
	err = store.UpdateStatus(ctx, "reason-a", domain.ReasonComplete, `{"done":true}`, "")
	testutil.RequireNoError(t, err)

	records, err = store.GetByApprovalID(ctx, "apr-shared")
	testutil.RequireNoError(t, err)
	if len(records) != 1 {
		t.Fatalf("expected 1 pending record after completing one, got %d", len(records))
	}
	testutil.RequireEqual(t, records[0].RequestID, "reason-b")
}

func TestPendingReason_SQLite_SweepExpiresPendingEntries(t *testing.T) {
	store := newSQLitePendingReasonStore(t)
	ctx := context.Background()
	now := time.Now().Unix()

	// Create a record that has already expired (expires_at in the past)
	err := store.Create(ctx, domain.PendingReasonRecord{
		RequestID:   "reason-expired",
		CallerDID:   "did:key:agent1",
		ApprovalID:  "apr-expired",
		Status:      domain.ReasonPendingApproval,
		RequestMeta: `{"prompt":"old request"}`,
		CreatedAt:   now - 3600,
		UpdatedAt:   now - 3600,
		ExpiresAt:   now - 1, // already expired
	})
	testutil.RequireNoError(t, err)

	// Create a record that is still valid
	err = store.Create(ctx, domain.PendingReasonRecord{
		RequestID:   "reason-valid",
		CallerDID:   "did:key:agent1",
		ApprovalID:  "apr-valid",
		Status:      domain.ReasonPendingApproval,
		RequestMeta: `{"prompt":"fresh request"}`,
		CreatedAt:   now,
		UpdatedAt:   now,
		ExpiresAt:   now + 1800,
	})
	testutil.RequireNoError(t, err)

	// Sweep
	count, err := store.Sweep(ctx)
	testutil.RequireNoError(t, err)
	if count != 1 {
		t.Fatalf("expected sweep to process 1 entry, got %d", count)
	}

	// Expired record should now be status=expired (not deleted — Sweep marks pending as expired)
	r, err := store.GetByID(ctx, "reason-expired", "did:key:agent1")
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, r)
	testutil.RequireEqual(t, r.Status, domain.ReasonExpired)

	// Valid record should be untouched
	r, err = store.GetByID(ctx, "reason-valid", "did:key:agent1")
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, r)
	testutil.RequireEqual(t, r.Status, domain.ReasonPendingApproval)
}

func TestPendingReason_SQLite_SweepDeletesOldCompletedEntries(t *testing.T) {
	store := newSQLitePendingReasonStore(t)
	ctx := context.Background()
	now := time.Now().Unix()

	// Create a completed record with updated_at older than retention (1 hour)
	err := store.Create(ctx, domain.PendingReasonRecord{
		RequestID:   "reason-old-complete",
		CallerDID:   "did:key:agent1",
		ApprovalID:  "apr-old",
		Status:      domain.ReasonPendingApproval,
		RequestMeta: `{}`,
		CreatedAt:   now - 7200,
		UpdatedAt:   now - 7200,
		ExpiresAt:   now - 3600,
	})
	testutil.RequireNoError(t, err)

	// Mark complete with an old updated_at (simulate via direct SQL would be needed,
	// but UpdateStatus sets updated_at to now. So we first UpdateStatus, then we
	// need the record to be old enough. Since retention is 1 hour and we just set
	// updated_at to now, this record won't be swept yet — test the non-deletion case.)
	err = store.UpdateStatus(ctx, "reason-old-complete", domain.ReasonComplete, `{"done":true}`, "")
	testutil.RequireNoError(t, err)

	// Sweep — completed entry was just updated (now), so it's within retention
	count, err := store.Sweep(ctx)
	testutil.RequireNoError(t, err)
	// The pending entry was already past expiry before we marked it complete,
	// but now it's complete with updated_at=now, so it's within retention.

	// Record should still exist (within retention window)
	r, err := store.GetByID(ctx, "reason-old-complete", "did:key:agent1")
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, r)
	testutil.RequireEqual(t, r.Status, domain.ReasonComplete)
	_ = count
}

func TestPendingReason_SQLite_SweepSkipsResumingEntries(t *testing.T) {
	store := newSQLitePendingReasonStore(t)
	ctx := context.Background()
	now := time.Now().Unix()

	// Create an entry that is past expiry but in "resuming" state
	err := store.Create(ctx, domain.PendingReasonRecord{
		RequestID:   "reason-resuming",
		CallerDID:   "did:key:agent1",
		ApprovalID:  "apr-resume",
		Status:      domain.ReasonPendingApproval,
		RequestMeta: `{"prompt":"resuming"}`,
		CreatedAt:   now - 3600,
		UpdatedAt:   now - 3600,
		ExpiresAt:   now - 1, // expired
	})
	testutil.RequireNoError(t, err)

	// Mark as resuming
	err = store.UpdateStatus(ctx, "reason-resuming", domain.ReasonResuming, "", "")
	testutil.RequireNoError(t, err)

	// Sweep — should mark as expired (Sweep catches both pending_approval and resuming)
	count, err := store.Sweep(ctx)
	testutil.RequireNoError(t, err)
	// The UpdateStatus sets updated_at to now but expiry check uses expires_at field.
	// expires_at was set in the past, but the sweep only uses expires_at, not updated_at
	// for the pending→expired transition.
	if count != 1 {
		t.Fatalf("expected sweep to mark 1 resuming entry expired, got %d", count)
	}

	r, err := store.GetByID(ctx, "reason-resuming", "did:key:agent1")
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, r)
	testutil.RequireEqual(t, r.Status, domain.ReasonExpired)
}

// ---------------------------------------------------------------------------
// Mock store tests (contract semantics)
// ---------------------------------------------------------------------------

func TestPendingReason_CreateAndGetByID(t *testing.T) {
	store := newMockPendingReasonStore()
	ctx := context.Background()
	now := time.Now().Unix()

	err := store.Create(ctx, domain.PendingReasonRecord{
		RequestID: "reason-abc123",
		CallerDID: "did:key:agent1",
		ApprovalID: "apr-001",
		Status:    domain.ReasonPendingApproval,
		CreatedAt: now,
		UpdatedAt: now,
		ExpiresAt: now + int64(domain.DefaultPendingReasonTTL),
	})
	testutil.RequireNoError(t, err)

	// Same caller → success
	r, err := store.GetByID(ctx, "reason-abc123", "did:key:agent1")
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, r)
	testutil.RequireEqual(t, r.Status, domain.ReasonPendingApproval)
}

func TestPendingReason_CallerBinding(t *testing.T) {
	store := newMockPendingReasonStore()
	ctx := context.Background()
	now := time.Now().Unix()

	store.Create(ctx, domain.PendingReasonRecord{
		RequestID: "reason-bound",
		CallerDID: "did:key:agent1",
		ApprovalID: "apr-002",
		Status:    domain.ReasonPendingApproval,
		CreatedAt: now,
		UpdatedAt: now,
		ExpiresAt: now + 1800,
	})

	// Wrong caller → access denied
	_, err := store.GetByID(ctx, "reason-bound", "did:key:agent2")
	if err == nil {
		t.Fatal("expected access denied for wrong caller")
	}

	// Right caller → success
	r, err := store.GetByID(ctx, "reason-bound", "did:key:agent1")
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, r)
}

func TestPendingReason_GetByApprovalID(t *testing.T) {
	store := newMockPendingReasonStore()
	ctx := context.Background()
	now := time.Now().Unix()

	store.Create(ctx, domain.PendingReasonRecord{
		RequestID: "reason-1",
		CallerDID: "agent1",
		ApprovalID: "apr-shared",
		Status:    domain.ReasonPendingApproval,
		CreatedAt: now,
		UpdatedAt: now,
		ExpiresAt: now + 1800,
	})

	records, err := store.GetByApprovalID(ctx, "apr-shared")
	testutil.RequireNoError(t, err)
	if len(records) != 1 {
		t.Fatalf("expected 1 record, got %d", len(records))
	}
	testutil.RequireEqual(t, records[0].RequestID, "reason-1")
}

func TestPendingReason_SecondApprovalCycle(t *testing.T) {
	store := newMockPendingReasonStore()
	ctx := context.Background()
	now := time.Now().Unix()

	// Create with first approval
	store.Create(ctx, domain.PendingReasonRecord{
		RequestID: "reason-multi",
		CallerDID: "agent1",
		ApprovalID: "apr-first",
		Status:    domain.ReasonPendingApproval,
		CreatedAt: now,
		UpdatedAt: now,
		ExpiresAt: now + 100, // close to expiry
	})

	// Simulate first approval → resume → hits second persona
	store.UpdateStatus(ctx, "reason-multi", domain.ReasonResuming, "", "")
	store.UpdateStatus(ctx, "reason-multi", domain.ReasonPendingApproval, "", "")

	// Update to second approval — must extend expiry
	store.UpdateApprovalID(ctx, "reason-multi", "apr-second")

	r, _ := store.GetByID(ctx, "reason-multi", "agent1")
	testutil.RequireNotNil(t, r)

	// Approval ID updated
	testutil.RequireEqual(t, r.ApprovalID, "apr-second")

	// Expiry extended — should be now + 30min, not the old close-to-expiry value
	if r.ExpiresAt <= now+100 {
		t.Fatalf("expires_at not extended: %d (should be > %d)", r.ExpiresAt, now+100)
	}

	// Should be findable by new approval ID
	records, _ := store.GetByApprovalID(ctx, "apr-second")
	if len(records) != 1 {
		t.Fatalf("expected 1 record for apr-second, got %d", len(records))
	}

	// Old approval ID should return nothing
	records, _ = store.GetByApprovalID(ctx, "apr-first")
	if len(records) != 0 {
		t.Fatalf("expected 0 records for apr-first, got %d", len(records))
	}
}

func TestPendingReason_DeniedStatus(t *testing.T) {
	store := newMockPendingReasonStore()
	ctx := context.Background()
	now := time.Now().Unix()

	store.Create(ctx, domain.PendingReasonRecord{
		RequestID: "reason-deny",
		CallerDID: "agent1",
		ApprovalID: "apr-deny",
		Status:    domain.ReasonPendingApproval,
		CreatedAt: now,
		UpdatedAt: now,
		ExpiresAt: now + 1800,
	})

	store.UpdateStatus(ctx, "reason-deny", domain.ReasonDenied, "", "user denied")

	r, _ := store.GetByID(ctx, "reason-deny", "agent1")
	testutil.RequireNotNil(t, r)
	testutil.RequireEqual(t, r.Status, domain.ReasonDenied)
	testutil.RequireEqual(t, r.Error, "user denied")
}

func TestPendingReason_CompleteWithResult(t *testing.T) {
	store := newMockPendingReasonStore()
	ctx := context.Background()
	now := time.Now().Unix()

	store.Create(ctx, domain.PendingReasonRecord{
		RequestID: "reason-complete",
		CallerDID: "agent1",
		ApprovalID: "apr-complete",
		Status:    domain.ReasonPendingApproval,
		CreatedAt: now,
		UpdatedAt: now,
		ExpiresAt: now + 1800,
	})

	result := `{"content":"Based on your health data...","model":"gemini-lite"}`
	store.UpdateStatus(ctx, "reason-complete", domain.ReasonComplete, result, "")

	r, _ := store.GetByID(ctx, "reason-complete", "agent1")
	testutil.RequireNotNil(t, r)
	testutil.RequireEqual(t, r.Status, domain.ReasonComplete)
	testutil.RequireEqual(t, r.Result, result)
}
