//go:build cgo

package test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/handler"
	"github.com/rajmohanutopai/dina/core/internal/service"
	"github.com/rajmohanutopai/dina/core/test/testutil"
)

// callbackRecordingSender captures bridge sends and runs without ever
// touching a real transport. Duplicated locally (rather than exported
// from bridge_test.go) so this file can be read in isolation.
type callbackRecordingSender struct {
	mu    sync.Mutex
	calls []map[string]interface{}
}

func (r *callbackRecordingSender) send(_ context.Context, peerDID string, responseJSON []byte) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	var body map[string]interface{}
	_ = json.Unmarshal(responseJSON, &body)
	body["__peer_did"] = peerDID
	r.calls = append(r.calls, body)
	return nil
}

func (r *callbackRecordingSender) snapshot() []map[string]interface{} {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]map[string]interface{}, len(r.calls))
	copy(out, r.calls)
	return out
}

// newCallbackTestEnv wires a WorkflowCallbackHandler against a real
// SQLite-backed WorkflowService plus a recording bridge sender. The
// returned helpers allow tests to: insert a queued delegation task,
// POST to the /complete endpoint, and inspect what the bridge sent.
func newCallbackTestEnv(t *testing.T) (
	*handler.WorkflowCallbackHandler,
	*callbackRecordingSender,
	func(taskID string) string, // insertRunningTask returns taskID
) {
	t.Helper()
	store := newTestWorkflowStore(t)
	svc := service.NewWorkflowService(store, nil, nil, testClock{t: time.Now()})

	// Wire service config + response bridge so Complete/CompleteWithDetails
	// can fire the D2D bridge. Uses the same canonical config as bridge_test.
	cfgStore := &inMemServiceConfigStore{}
	testutil.RequireNoError(t, cfgStore.Put(etaQueryServiceConfigJSON(t)))
	svc.SetServiceConfig(service.NewServiceConfigService(cfgStore))

	sender := &callbackRecordingSender{}
	svc.SetResponseBridgeSender(sender.send)

	h := &handler.WorkflowCallbackHandler{
		Workflow:      svc,
		CallbackToken: "test-callback-token",
	}

	// insertRunningTask creates a service_query_execution delegation task
	// in running state (state transition created→running is legal) so
	// /complete can transition it to completed.
	insert := func(taskID string) string {
		t.Helper()
		payloadStr := `{"type": "service_query_execution", ` +
			`"from_did": "did:plc:requester-test", ` +
			`"query_id": "q-` + taskID + `", ` +
			`"capability": "eta_query", ` +
			`"params": {"route_id": "42"}, ` +
			`"ttl_seconds": 75, ` +
			`"schema_hash": "test-hash-eta"}`
		task := domain.WorkflowTask{
			ID:            taskID,
			Kind:          string(domain.WFKindDelegation),
			PayloadType:   "service_query_execution",
			Status:        string(domain.WFRunning),
			CorrelationID: "q-" + taskID,
			Priority:      string(domain.WFPriorityNormal),
			Payload:       payloadStr,
			Origin:        "d2d",
			AgentDID:      "did:plc:agent-test",
		}
		testutil.RequireNoError(t, store.Create(context.Background(), task))
		return taskID
	}

	return h, sender, insert
}

// postComplete wraps the /complete call. Returns the HTTP response.
func postComplete(t *testing.T, h *handler.WorkflowCallbackHandler, taskID, token string, body map[string]interface{}) *httptest.ResponseRecorder {
	t.Helper()
	bodyBytes, err := json.Marshal(body)
	testutil.RequireNoError(t, err)
	req := httptest.NewRequest(
		http.MethodPost,
		"/v1/internal/workflow-tasks/"+taskID+"/complete",
		bytes.NewReader(bodyBytes),
	)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	h.HandleComplete(w, req)
	return w
}

// ---------------------------------------------------------------------------
// Auth + method
// ---------------------------------------------------------------------------

func TestCallbackComplete_RejectsWrongMethod(t *testing.T) {
	h, _, _ := newCallbackTestEnv(t)
	req := httptest.NewRequest(http.MethodGet, "/v1/internal/workflow-tasks/x/complete", nil)
	w := httptest.NewRecorder()
	h.HandleComplete(w, req)
	testutil.RequireEqual(t, w.Code, http.StatusMethodNotAllowed)
}

func TestCallbackComplete_RejectsMissingAuth(t *testing.T) {
	h, _, _ := newCallbackTestEnv(t)
	w := postComplete(t, h, "t-1", "", map[string]interface{}{"result": "ok"})
	testutil.RequireEqual(t, w.Code, http.StatusUnauthorized)
}

func TestCallbackComplete_RejectsWrongToken(t *testing.T) {
	h, _, _ := newCallbackTestEnv(t)
	w := postComplete(t, h, "t-1", "not-the-token", map[string]interface{}{"result": "ok"})
	testutil.RequireEqual(t, w.Code, http.StatusUnauthorized)
}

func TestCallbackComplete_404OnUnknownTask(t *testing.T) {
	h, _, _ := newCallbackTestEnv(t)
	w := postComplete(t, h, "does-not-exist", "test-callback-token",
		map[string]interface{}{"result": "ok"})
	testutil.RequireEqual(t, w.Code, http.StatusNotFound)
}

// ---------------------------------------------------------------------------
// Structured result_json path — fires the bridge via CompleteWithDetails
// ---------------------------------------------------------------------------

func TestCallbackComplete_StructuredResultFiresBridge(t *testing.T) {
	h, sender, insert := newCallbackTestEnv(t)
	taskID := insert("svc-exec-abc")

	structured := map[string]interface{}{
		"eta_minutes": 9,
		"stop_name":   "Castro Station",
		"map_url":     "https://maps.example/x",
	}
	w := postComplete(t, h, taskID, "test-callback-token", map[string]interface{}{
		"result":      "Bus 42 — 9 min to Castro Station",
		"result_json": structured,
	})

	testutil.RequireEqual(t, w.Code, http.StatusOK)
	calls := sender.snapshot()
	testutil.RequireEqual(t, len(calls), 1)
	testutil.RequireEqual(t, calls[0]["status"], "success")
	resp, ok := calls[0]["result"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected object result, got %T", calls[0]["result"])
	}
	testutil.RequireEqual(t, resp["eta_minutes"], float64(9)) // JSON numbers decode as float64
	testutil.RequireEqual(t, resp["stop_name"], "Castro Station")
	// TTL preserved from task payload (75 seconds).
	testutil.RequireEqual(t, int(calls[0]["ttl_seconds"].(float64)), 75)
}

// TestCallbackComplete_LargeStructuredResultRoundTrips checks the 4KB
// truncation regression: before the result_json field existed, large
// structured payloads were stuffed into the text summary and clipped.
func TestCallbackComplete_LargeStructuredResultRoundTrips(t *testing.T) {
	h, sender, insert := newCallbackTestEnv(t)
	taskID := insert("svc-exec-big")

	// Build a structured result that satisfies the eta schema AND carries
	// a large bag of extra bytes. 10 KB is well past the old 4KB limit.
	big := map[string]interface{}{
		"eta_minutes": 5,
		"stop_name":   "Castro Station",
		"extra":       map[string]interface{}{"blob": bytesBlob(10_000)},
	}
	w := postComplete(t, h, taskID, "test-callback-token", map[string]interface{}{
		"result":      "done",
		"result_json": big,
	})
	testutil.RequireEqual(t, w.Code, http.StatusOK)

	calls := sender.snapshot()
	testutil.RequireEqual(t, len(calls), 1)
	result, _ := calls[0]["result"].(map[string]interface{})
	extra, _ := result["extra"].(map[string]interface{})
	blob, _ := extra["blob"].(string)
	if len(blob) != 10_000 {
		t.Fatalf("expected full 10000-byte blob to round-trip, got %d", len(blob))
	}
}

// ---------------------------------------------------------------------------
// Text-only result path — uses Complete() and still fires the bridge
// ---------------------------------------------------------------------------

func TestCallbackComplete_TextOnlyResultStillFiresBridge(t *testing.T) {
	h, sender, insert := newCallbackTestEnv(t)
	taskID := insert("svc-exec-text")

	// Text looks like JSON that parses as the expected shape — bridge's
	// existing fallback parses it. Verifies that the text-only path
	// still reaches the bridge and produces a schema-valid response.
	textThatIsJSON := `{"eta_minutes": 4, "stop_name": "Castro Station"}`
	w := postComplete(t, h, taskID, "test-callback-token",
		map[string]interface{}{"result": textThatIsJSON})
	testutil.RequireEqual(t, w.Code, http.StatusOK)

	calls := sender.snapshot()
	testutil.RequireEqual(t, len(calls), 1)
	testutil.RequireEqual(t, calls[0]["status"], "success")
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

func TestCallbackComplete_IdempotentOnAlreadyCompletedTask(t *testing.T) {
	h, sender, insert := newCallbackTestEnv(t)
	taskID := insert("svc-exec-idem")
	good := map[string]interface{}{
		"eta_minutes": 2,
		"stop_name":   "Castro Station",
	}
	w1 := postComplete(t, h, taskID, "test-callback-token", map[string]interface{}{
		"result_json": good,
	})
	testutil.RequireEqual(t, w1.Code, http.StatusOK)

	// Second call should return 200 and a "noop" indicator, not crash.
	w2 := postComplete(t, h, taskID, "test-callback-token", map[string]interface{}{
		"result_json": good,
	})
	testutil.RequireEqual(t, w2.Code, http.StatusOK)
	var body map[string]string
	_ = json.Unmarshal(w2.Body.Bytes(), &body)
	if body["noop"] != "true" {
		t.Fatalf("expected noop=true on second call, got %v", body)
	}

	// Bridge only fires once — no duplicate D2D response.
	if n := len(sender.snapshot()); n != 1 {
		t.Fatalf("expected exactly 1 bridge send, got %d", n)
	}
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

func bytesBlob(n int) string {
	buf := make([]byte, n)
	for i := range buf {
		buf[i] = 'a' + byte(i%26)
	}
	return string(buf)
}
