package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/rajmohanutopai/dina/core/internal/middleware"
	"github.com/rajmohanutopai/dina/core/internal/port"
)

// mockTraceStore implements port.TraceStore for testing.
type mockTraceStore struct {
	events []port.TraceEvent
}

func (m *mockTraceStore) Append(reqID, step, component, detail string) error {
	m.events = append(m.events, port.TraceEvent{
		ID:        int64(len(m.events) + 1),
		ReqID:     reqID,
		TsMs:      1711234567890 + int64(len(m.events)),
		Step:      step,
		Component: component,
		Detail:    detail,
	})
	return nil
}

func (m *mockTraceStore) Query(_ context.Context, reqID string) ([]port.TraceEvent, error) {
	var result []port.TraceEvent
	for _, e := range m.events {
		if e.ReqID == reqID {
			result = append(result, e)
		}
	}
	return result, nil
}

func (m *mockTraceStore) Purge(_ context.Context, _ int64) (int, error) {
	return 0, nil
}

func TestTraceHandler_Query(t *testing.T) {
	store := &mockTraceStore{}
	store.Append("test-req-1", "http_response", "core", `{"method":"POST","path":"/v1/vault/query","status":"200"}`)
	store.Append("test-req-1", "brain_call", "core", `{"endpoint":"/api/v1/reason"}`)
	store.Append("test-req-1", "brain_response", "core", `{"status":"200"}`)
	store.Append("other-req", "http_response", "core", `{"method":"GET","path":"/healthz"}`)

	h := &TraceHandler{Store: store}

	// Admin caller should see trace events
	req := httptest.NewRequest("GET", "/v1/trace/test-req-1", nil)
	ctx := context.WithValue(req.Context(), middleware.CallerTypeKey, "admin")
	req = req.WithContext(ctx)
	w := httptest.NewRecorder()

	h.HandleQuery(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp struct {
		ReqID  string `json:"req_id"`
		Events []struct {
			TsMs      int64           `json:"ts_ms"`
			Step      string          `json:"step"`
			Component string          `json:"component"`
			Detail    json.RawMessage `json:"detail"`
		} `json:"events"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if resp.ReqID != "test-req-1" {
		t.Errorf("req_id = %q, want test-req-1", resp.ReqID)
	}
	if len(resp.Events) != 3 {
		t.Errorf("events = %d, want 3 (other-req should be filtered)", len(resp.Events))
	}
	if resp.Events[0].Step != "http_response" {
		t.Errorf("events[0].step = %q, want http_response", resp.Events[0].Step)
	}
	if resp.Events[1].Step != "brain_call" {
		t.Errorf("events[1].step = %q, want brain_call", resp.Events[1].Step)
	}
}

func TestTraceHandler_AdminOnly(t *testing.T) {
	store := &mockTraceStore{}
	h := &TraceHandler{Store: store}

	// Agent caller should be rejected
	req := httptest.NewRequest("GET", "/v1/trace/test-req", nil)
	ctx := context.WithValue(req.Context(), middleware.CallerTypeKey, "agent")
	req = req.WithContext(ctx)
	w := httptest.NewRecorder()

	h.HandleQuery(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403, got %d", w.Code)
	}
}

func TestTraceHandler_NilStore(t *testing.T) {
	// No-CGO mode: store is nil → 503
	h := &TraceHandler{Store: nil}

	req := httptest.NewRequest("GET", "/v1/trace/test-req", nil)
	ctx := context.WithValue(req.Context(), middleware.CallerTypeKey, "admin")
	req = req.WithContext(ctx)
	w := httptest.NewRecorder()

	h.HandleQuery(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("expected 503 for nil store, got %d", w.Code)
	}
}

func TestTraceHandler_EmptyReqID(t *testing.T) {
	store := &mockTraceStore{}
	h := &TraceHandler{Store: store}

	req := httptest.NewRequest("GET", "/v1/trace/", nil)
	ctx := context.WithValue(req.Context(), middleware.CallerTypeKey, "admin")
	req = req.WithContext(ctx)
	w := httptest.NewRecorder()

	h.HandleQuery(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestTracer_Emit(t *testing.T) {
	store := &mockTraceStore{}
	tracer := &Tracer{Store: store}

	ctx := context.WithValue(context.Background(), middleware.RequestIDKey, "emit-test-123")
	tracer.Emit(ctx, "test_step", "core", map[string]string{"key": "value"})

	if len(store.events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(store.events))
	}
	if store.events[0].ReqID != "emit-test-123" {
		t.Errorf("req_id = %q, want emit-test-123", store.events[0].ReqID)
	}
	if store.events[0].Step != "test_step" {
		t.Errorf("step = %q, want test_step", store.events[0].Step)
	}
}

func TestTracer_NilSafe(t *testing.T) {
	// Nil tracer should not panic
	var tracer *Tracer
	tracer.Emit(context.Background(), "step", "core", nil) // should not panic

	// Nil store should not panic
	tracer2 := &Tracer{Store: nil}
	tracer2.Emit(context.Background(), "step", "core", nil) // should not panic
}

func TestTracer_NoReqID(t *testing.T) {
	store := &mockTraceStore{}
	tracer := &Tracer{Store: store}

	// No req_id in context → no event emitted
	tracer.Emit(context.Background(), "step", "core", nil)

	if len(store.events) != 0 {
		t.Errorf("expected 0 events without req_id, got %d", len(store.events))
	}
}
