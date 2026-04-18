//go:build cgo

package test

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/adapter/sqlite"
	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/service"
	"github.com/rajmohanutopai/dina/core/test/testutil"
)

// inMemServiceConfigStore is a test-only implementation of port.ServiceConfigStore.
type inMemServiceConfigStore struct {
	mu   sync.Mutex
	data string
}

func (s *inMemServiceConfigStore) Get() (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.data, nil
}
func (s *inMemServiceConfigStore) Put(cfg string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data = cfg
	return nil
}

// recordingSender captures every bridge send call. failN lets a test simulate
// transport failure on the first N attempts so the stash/retry path can run.
type recordingSender struct {
	mu      sync.Mutex
	calls   []sentResponse
	failN   int
	failErr error
}

type sentResponse struct {
	peerDID      string
	responseBody map[string]interface{}
}

func (r *recordingSender) send(_ context.Context, peerDID string, responseJSON []byte) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.failN > 0 {
		r.failN--
		return r.failErr
	}
	var body map[string]interface{}
	_ = json.Unmarshal(responseJSON, &body)
	r.calls = append(r.calls, sentResponse{peerDID: peerDID, responseBody: body})
	return nil
}

func (r *recordingSender) snapshot() []sentResponse {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]sentResponse, len(r.calls))
	copy(out, r.calls)
	return out
}

// etaQueryServiceConfigJSON returns a service config JSON matching what
// ServicePublisher would emit for a provider with an eta_query capability.
func etaQueryServiceConfigJSON(t *testing.T) string {
	t.Helper()
	cfg := map[string]interface{}{
		"is_discoverable":    true,
		"name":         "Test Transit",
		"capabilities": map[string]interface{}{"eta_query": map[string]interface{}{"response_policy": "auto", "mcp_server": "transit", "mcp_tool": "get_eta"}},
		"capability_schemas": map[string]interface{}{
			"eta_query": map[string]interface{}{
				"description": "Query estimated time of arrival.",
				"params": map[string]interface{}{
					"type": "object",
					"properties": map[string]interface{}{
						"route_id": map[string]interface{}{"type": "string"},
						"lat":      map[string]interface{}{"type": "number"},
						"lng":      map[string]interface{}{"type": "number"},
					},
					"required": []string{"route_id", "lat", "lng"},
				},
				"result": map[string]interface{}{
					"type": "object",
					"properties": map[string]interface{}{
						"eta_minutes": map[string]interface{}{"type": "integer"},
						"stop_name":   map[string]interface{}{"type": "string"},
						"map_url":     map[string]interface{}{"type": "string"},
					},
					"required": []string{"eta_minutes", "stop_name"},
				},
				"schema_hash": "test-hash-eta",
			},
		},
		"service_area": map[string]interface{}{"lat": 37.77, "lng": -122.43, "radius_km": 10.0},
	}
	raw, err := json.Marshal(cfg)
	testutil.RequireNoError(t, err)
	return string(raw)
}

// newBridgeTestService builds a WorkflowService wired with service config and
// a recording sender. failN controls how many send attempts fail before
// succeeding (for testing the stash/retry path).
func newBridgeTestService(t *testing.T, failN int) (
	*service.WorkflowService,
	*sqlite.WorkflowStore,
	*recordingSender,
) {
	t.Helper()
	store := newTestWorkflowStore(t)
	svc := service.NewWorkflowService(store, nil, nil, testClock{t: time.Now()})

	cfgStore := &inMemServiceConfigStore{}
	testutil.RequireNoError(t, cfgStore.Put(etaQueryServiceConfigJSON(t)))
	svc.SetServiceConfig(service.NewServiceConfigService(cfgStore))

	sender := &recordingSender{failN: failN, failErr: errors.New("simulated transport failure")}
	svc.SetResponseBridgeSender(sender.send)

	return svc, store, sender
}

// insertCompletedExecutionTask creates a service_query_execution delegation
// task directly in the completed state with the given structured result.
// Tests exercise the bridge alone, not the state machine around completion.
//
// Deliberately mimics the Python producer by using spaced JSON (Python's
// json.dumps default) so the reconciler SQL filter can't accidentally
// depend on Go-style compact encoding.
func insertCompletedExecutionTask(t *testing.T, store *sqlite.WorkflowStore, queryID string, result map[string]interface{}, ttlSeconds int) string {
	t.Helper()
	// Build the payload as Python json.dumps would: sorted-ish keys with
	// ", " / ": " separators. Hand-crafted to defeat the legacy LIKE
	// filter — the fix is the indexed payload_type column, not spacing.
	payloadStr := `{"type": "service_query_execution", ` +
		`"from_did": "did:plc:requester-test", ` +
		`"query_id": "` + queryID + `", ` +
		`"capability": "eta_query", ` +
		`"params": {"route_id": "42", "lat": 37.77, "lng": -122.43}, ` +
		`"ttl_seconds": ` + jsonInt(ttlSeconds) + `, ` +
		`"service_name": "Test Transit", ` +
		`"schema_hash": "test-hash-eta", ` +
		`"schema_snapshot": {}}`
	resultBytes, err := json.Marshal(result)
	testutil.RequireNoError(t, err)

	taskID := "exec-test-" + queryID
	task := domain.WorkflowTask{
		ID:            taskID,
		Kind:          string(domain.WFKindDelegation),
		PayloadType:   "service_query_execution",
		Status:        string(domain.WFCompleted),
		CorrelationID: queryID,
		Priority:      string(domain.WFPriorityNormal),
		Payload:       payloadStr,
		Result:        string(resultBytes),
		ResultSummary: "ok",
		Origin:        "d2d",
		AgentDID:      "did:plc:agent-test",
	}
	testutil.RequireNoError(t, store.Create(context.Background(), task))
	return taskID
}

// jsonInt formats an int for inline inclusion in hand-rolled JSON above.
func jsonInt(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}

// TRACE: {"suite": "CORE", "case": "TST-CORE-1145", "title": "Bridge_HappyPath_SendsSuccessResponse"}
func TestWS2_B01_Bridge_HappyPath_SendsSuccessResponse(t *testing.T) {
	svc, store, sender := newBridgeTestService(t, 0)
	taskID := insertCompletedExecutionTask(t, store, "q-happy",
		map[string]interface{}{
			"eta_minutes": 7,
			"stop_name":   "Castro Station",
			"map_url":     "https://maps.example/42",
		}, 90)

	svc.BridgeServiceQueryCompletionForTest(context.Background(), taskID, "ok")

	calls := sender.snapshot()
	testutil.RequireEqual(t, len(calls), 1)
	testutil.RequireEqual(t, calls[0].peerDID, "did:plc:requester-test")
	testutil.RequireEqual(t, calls[0].responseBody["status"], "success")
	testutil.RequireEqual(t, calls[0].responseBody["capability"], "eta_query")
	// TTL must come from the original request, not hardcoded 60.
	if ttl, _ := calls[0].responseBody["ttl_seconds"].(float64); int(ttl) != 90 {
		t.Fatalf("expected ttl_seconds=90 from request, got %v", calls[0].responseBody["ttl_seconds"])
	}
	// Durability marker recorded on successful send.
	events, err := store.ListEvents(context.Background(), taskID)
	testutil.RequireNoError(t, err)
	if !hasEventKind(events, "service_response_sent") {
		t.Fatalf("expected service_response_sent event after successful send, got %+v", events)
	}
}

// hasEventKind returns true if any event in events has the given kind.
func hasEventKind(events []domain.WorkflowEvent, kind string) bool {
	for _, e := range events {
		if e.EventKind == kind {
			return true
		}
	}
	return false
}

// TRACE: {"suite": "CORE", "case": "TST-CORE-1146", "title": "Bridge_ResultSchemaViolation_SendsErrorResponse"}
func TestWS2_B02_Bridge_ResultSchemaViolation_SendsErrorResponse(t *testing.T) {
	svc, store, sender := newBridgeTestService(t, 0)
	// Missing required eta_minutes.
	taskID := insertCompletedExecutionTask(t, store, "q-bad",
		map[string]interface{}{"stop_name": "Castro Station"}, 60)

	svc.BridgeServiceQueryCompletionForTest(context.Background(), taskID, "ok")

	calls := sender.snapshot()
	testutil.RequireEqual(t, len(calls), 1)
	testutil.RequireEqual(t, calls[0].responseBody["status"], "error")
	resultMap, ok := calls[0].responseBody["result"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected error result to be an object, got %T", calls[0].responseBody["result"])
	}
	if errStr, _ := resultMap["error"].(string); errStr != "result_schema_violation" {
		t.Fatalf("expected result.error=result_schema_violation, got %v", resultMap["error"])
	}
}

// TRACE: {"suite": "CORE", "case": "TST-CORE-1147", "title": "Bridge_FailedTask_SendsErrorResponseFromTaskError"}
func TestWS2_B04_Bridge_FailedTask_SendsErrorResponseFromTaskError(t *testing.T) {
	svc, store, sender := newBridgeTestService(t, 0)
	// Set up a task that the agent explicitly failed (not completed).
	payloadStr := `{"type": "service_query_execution", ` +
		`"from_did": "did:plc:requester-test", ` +
		`"query_id": "q-failed", ` +
		`"capability": "eta_query", ` +
		`"params": {}, ` +
		`"ttl_seconds": 45, ` +
		`"schema_hash": "test-hash-eta"}`
	task := domain.WorkflowTask{
		ID:            "exec-failed-q",
		Kind:          string(domain.WFKindDelegation),
		PayloadType:   "service_query_execution",
		Status:        string(domain.WFFailed),
		CorrelationID: "q-failed",
		Priority:      string(domain.WFPriorityNormal),
		Payload:       payloadStr,
		Error:         "route unreachable",
		Origin:        "d2d",
		AgentDID:      "did:plc:agent-test",
	}
	testutil.RequireNoError(t, store.Create(context.Background(), task))

	svc.BridgeServiceQueryCompletionForTest(context.Background(), "exec-failed-q", "")

	calls := sender.snapshot()
	testutil.RequireEqual(t, len(calls), 1)
	testutil.RequireEqual(t, calls[0].responseBody["status"], "error")
	// Crucial: the provider's error text is surfaced as-is, NOT wrapped
	// and schema-validated into result_schema_violation.
	resultMap, ok := calls[0].responseBody["result"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected error result to be a map, got %T", calls[0].responseBody["result"])
	}
	if errStr, _ := resultMap["error"].(string); errStr != "route unreachable" {
		t.Fatalf("expected result.error=route unreachable, got %v", resultMap["error"])
	}
	if ttl, _ := calls[0].responseBody["ttl_seconds"].(float64); int(ttl) != 45 {
		t.Fatalf("expected ttl_seconds=45 preserved, got %v", calls[0].responseBody["ttl_seconds"])
	}
}

// TRACE: {"suite": "CORE", "case": "TST-CORE-1148", "title": "Bridge_ReconcilerFindsPythonSerializedTasks"}
func TestWS2_B05_Bridge_ReconcilerFindsPythonSerializedTasks(t *testing.T) {
	svc, store, sender := newBridgeTestService(t, 0)
	// Python json.dumps default uses ", " / ": " separators. An earlier
	// implementation matched payloads via LIKE '%"type":"service_query_execution"%',
	// which Python-serialised payloads never matched. The payload_type
	// indexed column fixes that — verify the reconciler actually finds
	// the task despite the spaced payload JSON.
	taskID := insertCompletedExecutionTask(t, store, "q-recon",
		map[string]interface{}{"eta_minutes": 3, "stop_name": "Castro"}, 60)

	// Force-clear any service_response_sent event so the reconciler
	// considers the task pending. (Our happy-path bridge hasn't run.)
	events, err := store.ListEvents(context.Background(), taskID)
	testutil.RequireNoError(t, err)
	for _, e := range events {
		if e.EventKind == "service_response_sent" {
			t.Fatalf("precondition violated: sent event already present")
		}
	}

	svc.RetryBridgePendingResponsesForTest(context.Background())

	calls := sender.snapshot()
	testutil.RequireEqual(t, len(calls), 1)
	testutil.RequireEqual(t, calls[0].responseBody["status"], "success")
}

// TRACE: {"suite": "CORE", "case": "TST-CORE-1149", "title": "Bridge_SendFailure_ReconcilerReSends"}
func TestWS2_B03_Bridge_SendFailure_ReconcilerReSends(t *testing.T) {
	svc, store, sender := newBridgeTestService(t, 1) // first attempt fails
	taskID := insertCompletedExecutionTask(t, store, "q-retry",
		map[string]interface{}{
			"eta_minutes": 5,
			"stop_name":   "Castro Station",
		}, 60)

	// First attempt: sender fails → no event marker written, task is
	// detectable by the reconciler without any pre-send stash.
	svc.BridgeServiceQueryCompletionForTest(context.Background(), taskID, "ok")
	if got := sender.snapshot(); len(got) != 0 {
		t.Fatalf("expected no successful sends after first-attempt failure, got %d", len(got))
	}
	events, err := store.ListEvents(context.Background(), taskID)
	testutil.RequireNoError(t, err)
	if hasEventKind(events, "service_response_sent") {
		t.Fatalf("expected no service_response_sent event after failed send")
	}

	// Sweeper reconciler finds the missing-event task and re-sends.
	svc.RetryBridgePendingResponsesForTest(context.Background())

	calls := sender.snapshot()
	testutil.RequireEqual(t, len(calls), 1)
	testutil.RequireEqual(t, calls[0].peerDID, "did:plc:requester-test")
	events, err = store.ListEvents(context.Background(), taskID)
	testutil.RequireNoError(t, err)
	if !hasEventKind(events, "service_response_sent") {
		t.Fatalf("expected service_response_sent event after retry succeeded")
	}
}
