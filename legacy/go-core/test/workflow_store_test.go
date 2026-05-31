//go:build cgo

package test

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/adapter/sqlite"
	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
	"github.com/rajmohanutopai/dina/core/test/testutil"
)

// testDEK is a fixed 32-byte key for test databases.
var testDEK = []byte("01234567890123456789012345678901")

// newTestWorkflowStore creates a fresh WorkflowStore backed by a temp directory.
// Opens the identity.sqlite database with a test DEK (triggers migrations).
func newTestWorkflowStore(t *testing.T) *sqlite.WorkflowStore {
	t.Helper()
	dir, err := os.MkdirTemp("", "dina-wf-test-")
	testutil.RequireNoError(t, err)
	t.Cleanup(func() { os.RemoveAll(dir) })

	va := sqlite.NewVaultAdapter(dir)
	t.Cleanup(func() { va.CloseAll() })

	// Open identity database — triggers migrations including workflow_tasks creation.
	err = va.Pool().Open("identity", testDEK)
	testutil.RequireNoError(t, err)

	return sqlite.NewWorkflowStore(va.Pool())
}

func makeServiceQueryTask(id, queryID, peerDID, capability, serviceName string, expiresAt int64) domain.WorkflowTask {
	payload, _ := json.Marshal(map[string]interface{}{
		"to_did":       peerDID,
		"capability":   capability,
		"params":       map[string]interface{}{"lat": 12.9, "lng": 77.6},
		"service_name": serviceName,
		"query_id":     queryID,
		"ttl_seconds":  60,
	})
	return domain.WorkflowTask{
		ID:            id,
		Kind:          string(domain.WFKindServiceQuery),
		Status:        string(domain.WFRunning),
		CorrelationID: queryID,
		Priority:      string(domain.WFPriorityNormal),
		Payload:       string(payload),
		ExpiresAt:     expiresAt,
	}
}

// ---------------------------------------------------------------------------
// A1: ValidTransitions — created → completed, created → failed, queued → running
// ---------------------------------------------------------------------------

// TRACE: {"suite": "CORE", "case": "WS2-001", "section": "WS2", "title": "Transition_CreatedToRunning"}
func TestWS2_001_Transition_CreatedToRunning(t *testing.T) {
	store := newTestWorkflowStore(t)
	ctx := context.Background()

	task := domain.WorkflowTask{
		ID:       "t-trans-01",
		Kind:     string(domain.WFKindServiceQuery),
		Status:   string(domain.WFCreated),
		Priority: string(domain.WFPriorityNormal),
	}
	testutil.RequireNoError(t, store.Create(ctx, task))

	err := store.Transition(ctx, "t-trans-01", domain.WFCreated, domain.WFRunning)
	testutil.RequireNoError(t, err)

	got, err := store.GetByID(ctx, "t-trans-01")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, got.Status, "running")
}

// TRACE: {"suite": "CORE", "case": "WS2-002", "title": "Transition_InvalidRejected"}
func TestWS2_002_Transition_InvalidRejected(t *testing.T) {
	store := newTestWorkflowStore(t)
	ctx := context.Background()

	task := domain.WorkflowTask{
		ID:       "t-trans-02",
		Kind:     string(domain.WFKindServiceQuery),
		Status:   string(domain.WFCreated),
		Priority: string(domain.WFPriorityNormal),
	}
	testutil.RequireNoError(t, store.Create(ctx, task))

	// created → completed is valid, but created → claimed is NOT valid.
	err := store.Transition(ctx, "t-trans-02", domain.WFCreated, domain.WFClaimed)
	testutil.RequireError(t, err)
}

// TRACE: {"suite": "CORE", "case": "WS2-003", "title": "Complete_FromCreated"}
func TestWS2_003_Complete_FromCreated(t *testing.T) {
	store := newTestWorkflowStore(t)
	ctx := context.Background()

	task := domain.WorkflowTask{
		ID:       "t-complete-created",
		Kind:     string(domain.WFKindServiceQuery),
		Status:   string(domain.WFCreated),
		Priority: string(domain.WFPriorityNormal),
	}
	testutil.RequireNoError(t, store.Create(ctx, task))

	eventID, err := store.Complete(ctx, "t-complete-created", "", "fast response")
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, eventID > 0, "event should be created")

	got, _ := store.GetByID(ctx, "t-complete-created")
	testutil.RequireEqual(t, got.Status, "completed")
}

// TRACE: {"suite": "CORE", "case": "WS2-004", "title": "Fail_FromCreated"}
func TestWS2_004_Fail_FromCreated(t *testing.T) {
	store := newTestWorkflowStore(t)
	ctx := context.Background()

	task := domain.WorkflowTask{
		ID:       "t-fail-created",
		Kind:     string(domain.WFKindServiceQuery),
		Status:   string(domain.WFCreated),
		Priority: string(domain.WFPriorityNormal),
	}
	testutil.RequireNoError(t, store.Create(ctx, task))

	eventID, err := store.Fail(ctx, "t-fail-created", "", "send_failed")
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, eventID > 0, "event should be created")

	got, _ := store.GetByID(ctx, "t-fail-created")
	testutil.RequireEqual(t, got.Status, "failed")
}

// ---------------------------------------------------------------------------
// A2: Idempotency — partial unique index, NULL normalization
// ---------------------------------------------------------------------------

// TRACE: {"suite": "CORE", "case": "WS2-005", "title": "Idempotency_NullKeyAllowsMultiple"}
func TestWS2_005_Idempotency_NullKeyAllowsMultiple(t *testing.T) {
	store := newTestWorkflowStore(t)
	ctx := context.Background()

	// Two tasks with empty idempotency_key (normalized to NULL) should not collide.
	t1 := domain.WorkflowTask{ID: "t-null-1", Kind: "generic", Status: "created", Priority: "normal"}
	t2 := domain.WorkflowTask{ID: "t-null-2", Kind: "generic", Status: "created", Priority: "normal"}
	testutil.RequireNoError(t, store.Create(ctx, t1))
	testutil.RequireNoError(t, store.Create(ctx, t2))
}

// TRACE: {"suite": "CORE", "case": "WS2-006", "title": "Idempotency_ActiveDedupe"}
func TestWS2_006_Idempotency_ActiveDedupe(t *testing.T) {
	store := newTestWorkflowStore(t)
	ctx := context.Background()

	t1 := domain.WorkflowTask{
		ID: "t-idem-1", Kind: "service_query", Status: "created",
		Priority: "normal", IdempotencyKey: "hash-abc",
	}
	testutil.RequireNoError(t, store.Create(ctx, t1))

	// Duplicate active task with same key → error
	t2 := domain.WorkflowTask{
		ID: "t-idem-2", Kind: "service_query", Status: "created",
		Priority: "normal", IdempotencyKey: "hash-abc",
	}
	err := store.Create(ctx, t2)
	testutil.RequireEqual(t, err, port.ErrDelegatedTaskExists)
}

// TRACE: {"suite": "CORE", "case": "WS2-007", "title": "Idempotency_TerminalReleasesKey"}
func TestWS2_007_Idempotency_TerminalReleasesKey(t *testing.T) {
	store := newTestWorkflowStore(t)
	ctx := context.Background()

	t1 := domain.WorkflowTask{
		ID: "t-idem-term-1", Kind: "service_query", Status: "created",
		Priority: "normal", IdempotencyKey: "hash-released",
	}
	testutil.RequireNoError(t, store.Create(ctx, t1))

	// Complete t1 → terminal
	_, err := store.Complete(ctx, "t-idem-term-1", "", "done")
	testutil.RequireNoError(t, err)

	// New task with same key should succeed (terminal released the key)
	t2 := domain.WorkflowTask{
		ID: "t-idem-term-2", Kind: "service_query", Status: "created",
		Priority: "normal", IdempotencyKey: "hash-released",
	}
	testutil.RequireNoError(t, store.Create(ctx, t2))
}

// TRACE: {"suite": "CORE", "case": "WS2-008", "title": "GetActiveByIdempotencyKey"}
func TestWS2_008_GetActiveByIdempotencyKey(t *testing.T) {
	store := newTestWorkflowStore(t)
	ctx := context.Background()

	t1 := domain.WorkflowTask{
		ID: "t-active-idem", Kind: "service_query", Status: "running",
		Priority: "normal", IdempotencyKey: "hash-active",
	}
	testutil.RequireNoError(t, store.Create(ctx, t1))

	// Should find it
	got, err := store.GetActiveByIdempotencyKey(ctx, "hash-active")
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, got)
	testutil.RequireEqual(t, got.ID, "t-active-idem")

	// Complete it
	store.Complete(ctx, "t-active-idem", "", "done")

	// Should NOT find it anymore (terminal)
	got, err = store.GetActiveByIdempotencyKey(ctx, "hash-active")
	testutil.RequireNoError(t, err)
	testutil.RequireNil(t, got)
}

// ---------------------------------------------------------------------------
// A3: FindServiceQueryTask — strict tuple, 0-or-1 check
// ---------------------------------------------------------------------------

// TRACE: {"suite": "CORE", "case": "WS2-009", "title": "FindServiceQueryTask_Match"}
func TestWS2_009_FindServiceQueryTask_Match(t *testing.T) {
	store := newTestWorkflowStore(t)
	ctx := context.Background()

	now := time.Now().Unix()
	task := makeServiceQueryTask("t-find-1", "q-123", "did:key:zPeer1", "eta_query", "Bus 42", now+120)
	testutil.RequireNoError(t, store.Create(ctx, task))

	found, err := store.FindServiceQueryTask(ctx, "q-123", "did:key:zPeer1", "eta_query", now)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, found)
	testutil.RequireEqual(t, found.ID, "t-find-1")
}

// TRACE: {"suite": "CORE", "case": "WS2-010", "title": "FindServiceQueryTask_NoMatch_WrongCapability"}
func TestWS2_010_FindServiceQueryTask_NoMatch_WrongCapability(t *testing.T) {
	store := newTestWorkflowStore(t)
	ctx := context.Background()

	now := time.Now().Unix()
	task := makeServiceQueryTask("t-find-2", "q-456", "did:key:zPeer2", "eta_query", "Bus 42", now+120)
	testutil.RequireNoError(t, store.Create(ctx, task))

	found, err := store.FindServiceQueryTask(ctx, "q-456", "did:key:zPeer2", "route_search", now)
	testutil.RequireNoError(t, err)
	testutil.RequireNil(t, found)
}

// TRACE: {"suite": "CORE", "case": "WS2-011", "title": "FindServiceQueryTask_NoMatch_Expired"}
func TestWS2_011_FindServiceQueryTask_NoMatch_Expired(t *testing.T) {
	store := newTestWorkflowStore(t)
	ctx := context.Background()

	now := time.Now().Unix()
	task := makeServiceQueryTask("t-find-3", "q-expired", "did:key:zPeer3", "eta_query", "Bus 42", now-10)
	testutil.RequireNoError(t, store.Create(ctx, task))

	found, err := store.FindServiceQueryTask(ctx, "q-expired", "did:key:zPeer3", "eta_query", now)
	testutil.RequireNoError(t, err)
	testutil.RequireNil(t, found)
}

// TRACE: {"suite": "CORE", "case": "WS2-012", "title": "FindServiceQueryTask_NoMatch_Terminal"}
func TestWS2_012_FindServiceQueryTask_NoMatch_Terminal(t *testing.T) {
	store := newTestWorkflowStore(t)
	ctx := context.Background()

	now := time.Now().Unix()
	task := makeServiceQueryTask("t-find-4", "q-done", "did:key:zPeer4", "eta_query", "Bus 42", now+120)
	testutil.RequireNoError(t, store.Create(ctx, task))

	// Complete the task
	store.Complete(ctx, "t-find-4", "", "done")

	found, err := store.FindServiceQueryTask(ctx, "q-done", "did:key:zPeer4", "eta_query", now)
	testutil.RequireNoError(t, err)
	testutil.RequireNil(t, found)
}

// ---------------------------------------------------------------------------
// A4: CompleteWithDetails — persists result + rich event
// ---------------------------------------------------------------------------

// TRACE: {"suite": "CORE", "case": "WS2-013", "title": "CompleteWithDetails_PersistsResult"}
func TestWS2_013_CompleteWithDetails_PersistsResult(t *testing.T) {
	store := newTestWorkflowStore(t)
	ctx := context.Background()

	task := domain.WorkflowTask{
		ID:       "t-cwd-1",
		Kind:     string(domain.WFKindServiceQuery),
		Status:   string(domain.WFRunning),
		Priority: string(domain.WFPriorityNormal),
	}
	testutil.RequireNoError(t, store.Create(ctx, task))

	resultJSON := `{"response_status":"success","eta_minutes":45}`
	eventDetails := `{"response_status":"success","service_name":"Bus 42","capability":"eta_query"}`

	eventID, err := store.CompleteWithDetails(ctx, "t-cwd-1", "", "success: eta_query", resultJSON, eventDetails)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, eventID > 0, "event should be created")

	// Verify result persisted in task
	got, _ := store.GetByID(ctx, "t-cwd-1")
	testutil.RequireEqual(t, got.Status, "completed")
	testutil.RequireEqual(t, got.Result, resultJSON)
	testutil.RequireEqual(t, got.ResultSummary, "success: eta_query")

	// Verify rich event details
	events, _ := store.ListEvents(ctx, "t-cwd-1")
	testutil.RequireTrue(t, len(events) >= 1, "should have at least 1 event")
	lastEvt := events[len(events)-1]
	testutil.RequireEqual(t, lastEvt.Details, eventDetails)
}

// ---------------------------------------------------------------------------
// A9: Rich expiry details in-transaction
// ---------------------------------------------------------------------------

// TRACE: {"suite": "CORE", "case": "WS2-014", "title": "ExpireTasks_ServiceQuery_RichDetails"}
func TestWS2_014_ExpireTasks_ServiceQuery_RichDetails(t *testing.T) {
	store := newTestWorkflowStore(t)
	ctx := context.Background()

	now := time.Now().Unix()
	task := makeServiceQueryTask("t-expire-1", "q-exp", "did:key:zPeer", "eta_query", "Route 42 AC", now-10)
	task.Status = string(domain.WFRunning)
	testutil.RequireNoError(t, store.Create(ctx, task))

	expired, err := store.ExpireTasks(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(expired) >= 1, "should expire 1 task")

	// Verify task is failed
	got, _ := store.GetByID(ctx, "t-expire-1")
	testutil.RequireEqual(t, got.Status, "failed")

	// Verify rich event details
	events, _ := store.ListEvents(ctx, "t-expire-1")
	testutil.RequireTrue(t, len(events) >= 1, "should have expiry event")
	lastEvt := events[len(events)-1]

	var details map[string]interface{}
	json.Unmarshal([]byte(lastEvt.Details), &details)
	testutil.RequireEqual(t, details["response_status"], "expired")
	testutil.RequireEqual(t, details["service_name"], "Route 42 AC")
	testutil.RequireEqual(t, details["capability"], "eta_query")

	// Issue #13: verify structured result persisted
	testutil.RequireTrue(t, got.Result != "", "result should be persisted for expired service_query")
	var resultMap map[string]interface{}
	json.Unmarshal([]byte(got.Result), &resultMap)
	testutil.RequireEqual(t, resultMap["response_status"], "expired")
}

// ---------------------------------------------------------------------------
// A8: ListDeliverableEventsForTask
// ---------------------------------------------------------------------------

// TRACE: {"suite": "CORE", "case": "WS2-015", "title": "ListDeliverableEventsForTask"}
func TestWS2_015_ListDeliverableEventsForTask(t *testing.T) {
	store := newTestWorkflowStore(t)
	ctx := context.Background()

	task := domain.WorkflowTask{
		ID: "t-deliver-1", Kind: "service_query", Status: "running", Priority: "normal",
	}
	testutil.RequireNoError(t, store.Create(ctx, task))

	// Append a deliverable event
	evtID, err := store.AppendEvent(ctx, "t-deliver-1", "notification", `{"test":true}`, true)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, evtID > 0, "event ID should be positive")

	// Should find it
	events, err := store.ListDeliverableEventsForTask(ctx, "t-deliver-1", 10)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(events) == 1, "should find 1 deliverable event")
	testutil.RequireEqual(t, events[0].TaskID, "t-deliver-1")

	// ACK it
	store.MarkEventAcknowledged(ctx, events[0].EventID)

	// Should not find it anymore
	events, err = store.ListDeliverableEventsForTask(ctx, "t-deliver-1", 10)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(events) == 0, "should find 0 after ACK")
}

// ---------------------------------------------------------------------------
// Queued → Running transition (for approval claim)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// A11/A12: Approve, ClaimApprovalForExecution
// ---------------------------------------------------------------------------

// TRACE: {"suite": "CORE", "case": "WS2-017", "title": "Approve_PendingApproval_ToQueued"}
func TestWS2_017_Approve_PendingApproval_ToQueued(t *testing.T) {
	store := newTestWorkflowStore(t)
	ctx := context.Background()

	payload := `{"from_did":"did:key:zReq","query_id":"q-approve","capability":"eta_query","params":{}}`
	task := domain.WorkflowTask{
		ID:       "t-approve-1",
		Kind:     string(domain.WFKindApproval),
		Status:   string(domain.WFPendingApproval),
		Priority: string(domain.WFPriorityNormal),
		Payload:  payload,
	}
	testutil.RequireNoError(t, store.Create(ctx, task))

	eventID, err := store.Approve(ctx, "t-approve-1")
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, eventID > 0, "event should be created")

	got, _ := store.GetByID(ctx, "t-approve-1")
	testutil.RequireEqual(t, got.Status, "queued")

	// Verify event includes task_payload
	events, _ := store.ListEvents(ctx, "t-approve-1")
	testutil.RequireTrue(t, len(events) >= 1, "should have approval event")
	lastEvt := events[len(events)-1]
	var details map[string]interface{}
	json.Unmarshal([]byte(lastEvt.Details), &details)
	testutil.RequireEqual(t, details["reason"], "approved")
	testutil.RequireNotNil(t, details["task_payload"])
}

// TRACE: {"suite": "CORE", "case": "WS2-018", "title": "ClaimApprovalForExecution"}
func TestWS2_018_ClaimApprovalForExecution(t *testing.T) {
	store := newTestWorkflowStore(t)
	ctx := context.Background()

	now := time.Now().Unix()
	task := domain.WorkflowTask{
		ID:        "t-claim-approval",
		Kind:      string(domain.WFKindApproval),
		Status:    string(domain.WFQueued),
		Priority:  string(domain.WFPriorityNormal),
		ExpiresAt: now + 30,
	}
	testutil.RequireNoError(t, store.Create(ctx, task))

	err := store.ClaimApprovalForExecution(ctx, "t-claim-approval", 60)
	testutil.RequireNoError(t, err)

	got, _ := store.GetByID(ctx, "t-claim-approval")
	testutil.RequireEqual(t, got.Status, "running")
	testutil.RequireTrue(t, got.ExpiresAt > now+50, "expires_at should be extended")

	// Second claim should fail (already running).
	err = store.ClaimApprovalForExecution(ctx, "t-claim-approval", 60)
	testutil.RequireError(t, err)
}

// TRACE: {"suite": "CORE", "case": "WS2-019", "title": "ListExpiringApprovalTasks"}
func TestWS2_019_ListExpiringApprovalTasks(t *testing.T) {
	store := newTestWorkflowStore(t)
	ctx := context.Background()

	now := time.Now().Unix()
	// Expired approval task
	t1 := domain.WorkflowTask{
		ID: "t-exp-approval-1", Kind: string(domain.WFKindApproval),
		Status: string(domain.WFQueued), Priority: "normal",
		ExpiresAt: now - 10,
	}
	// Non-expired approval task
	t2 := domain.WorkflowTask{
		ID: "t-exp-approval-2", Kind: string(domain.WFKindApproval),
		Status: string(domain.WFQueued), Priority: "normal",
		ExpiresAt: now + 120,
	}
	testutil.RequireNoError(t, store.Create(ctx, t1))
	testutil.RequireNoError(t, store.Create(ctx, t2))

	expiring, err := store.ListExpiringApprovalTasks(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(expiring) == 1, "should find 1 expiring task")
	testutil.RequireEqual(t, expiring[0].ID, "t-exp-approval-1")
}

// TRACE: {"suite": "CORE", "case": "WS2-020", "title": "SetRunID"}
func TestWS2_020_SetRunID(t *testing.T) {
	store := newTestWorkflowStore(t)
	ctx := context.Background()

	task := domain.WorkflowTask{
		ID: "t-runid", Kind: "approval", Status: "running", Priority: "normal",
	}
	testutil.RequireNoError(t, store.Create(ctx, task))

	err := store.SetRunID(ctx, "t-runid", "svc-resp:t-runid")
	testutil.RequireNoError(t, err)

	got, _ := store.GetByID(ctx, "t-runid")
	testutil.RequireEqual(t, got.RunID, "svc-resp:t-runid")
}

// TRACE: {"suite": "CORE", "case": "WS2-016", "title": "Transition_QueuedToRunning"}
func TestWS2_016_Transition_QueuedToRunning(t *testing.T) {
	store := newTestWorkflowStore(t)
	ctx := context.Background()

	task := domain.WorkflowTask{
		ID: "t-approval-1", Kind: "approval", Status: "queued", Priority: "normal",
	}
	testutil.RequireNoError(t, store.Create(ctx, task))

	err := store.Transition(ctx, "t-approval-1", domain.WFQueued, domain.WFRunning)
	testutil.RequireNoError(t, err)

	got, _ := store.GetByID(ctx, "t-approval-1")
	testutil.RequireEqual(t, got.Status, "running")
}
