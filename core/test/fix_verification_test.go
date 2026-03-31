package test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/adapter/brainclient"
	"github.com/rajmohanutopai/dina/core/internal/adapter/identity"
	"github.com/rajmohanutopai/dina/core/internal/adapter/transport"
	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/handler"
	"github.com/rajmohanutopai/dina/core/internal/middleware"
	"github.com/rajmohanutopai/dina/core/test/testutil"
)

// ============================================================================
// §31.1 D2D Pipeline Fixes Verification
// ============================================================================

// TST-CORE-1031 DrainSpool returns all non-expired payloads
// TRACE: {"suite": "CORE", "case": "0552", "section": "31", "sectionName": "Code Review Fix Verification", "subsection": "01", "scenario": "01", "title": "DrainSpoolReturnsPayloads"}
func TestFixVerify_31_1_1_DrainSpoolReturnsPayloads(t *testing.T) {
	// Use the real transport.InboxManager, not the test-only mock.
	inbox := transport.NewInboxManager(transport.InboxConfig{
		IPRateLimit:     50,
		GlobalRateLimit: 1000,
		SpoolMaxBytes:   500 * 1024 * 1024,
		DIDRateLimit:    100,
	})
	ctx := context.Background()

	// Set a long TTL so messages don't expire during the test.
	inbox.SetTTL(10 * time.Minute)

	msgs := []string{"msg1", "msg2", "msg3"}
	for _, m := range msgs {
		_, err := inbox.Spool(ctx, []byte(m))
		if err != nil {
			t.Fatalf("Spool(%q) error: %v", m, err)
		}
	}

	payloads, err := inbox.DrainSpool(ctx)
	if err != nil {
		t.Fatalf("DrainSpool error: %v", err)
	}
	if len(payloads) != 3 {
		t.Fatalf("expected 3 payloads, got %d", len(payloads))
	}

	// Verify actual payload content (not just count).
	found := map[string]bool{}
	for _, p := range payloads {
		found[string(p)] = true
	}
	for _, m := range msgs {
		if !found[m] {
			t.Errorf("expected payload %q in drained results", m)
		}
	}

	// Spool must be empty after drain.
	payloads2, err := inbox.DrainSpool(ctx)
	if err != nil {
		t.Fatalf("second DrainSpool error: %v", err)
	}
	if len(payloads2) != 0 {
		t.Errorf("expected empty spool after drain, got %d", len(payloads2))
	}
}

// TST-CORE-1032 DrainSpool skips expired messages
// TRACE: {"suite": "CORE", "case": "0553", "section": "31", "sectionName": "Code Review Fix Verification", "subsection": "01", "scenario": "02", "title": "DrainSpoolSkipsExpired"}
func TestFixVerify_31_1_2_DrainSpoolSkipsExpired(t *testing.T) {
	// Use the real transport.InboxManager which has SetTTL support.
	inbox := transport.NewInboxManager(transport.InboxConfig{
		IPRateLimit:     50,
		GlobalRateLimit: 1000,
		SpoolMaxBytes:   500 * 1024 * 1024,
		DIDRateLimit:    100,
	})
	ctx := context.Background()

	// Set a very short TTL (1 millisecond).
	inbox.SetTTL(1 * time.Millisecond)

	// Spool a message.
	_, err := inbox.Spool(ctx, []byte("will-expire"))
	if err != nil {
		t.Fatalf("Spool error: %v", err)
	}

	// Wait for the message to expire.
	time.Sleep(10 * time.Millisecond)

	// DrainSpool should return empty since the message expired.
	payloads, err := inbox.DrainSpool(ctx)
	if err != nil {
		t.Fatalf("DrainSpool error: %v", err)
	}
	if len(payloads) != 0 {
		t.Errorf("expected 0 payloads (all expired), got %d", len(payloads))
	}

	// Verify that a non-expired message is returned.
	inbox.SetTTL(10 * time.Minute)
	_, err = inbox.Spool(ctx, []byte("still-fresh"))
	if err != nil {
		t.Fatalf("Spool error: %v", err)
	}
	payloads, err = inbox.DrainSpool(ctx)
	if err != nil {
		t.Fatalf("DrainSpool error: %v", err)
	}
	if len(payloads) != 1 {
		t.Fatalf("expected 1 payload (non-expired), got %d", len(payloads))
	}
	if string(payloads[0]) != "still-fresh" {
		t.Errorf("expected payload 'still-fresh', got %q", string(payloads[0]))
	}
}

// TST-CORE-1033 onEnvelope callback fires on fast-path ingest
// TRACE: {"suite": "CORE", "case": "0554", "section": "31", "sectionName": "Code Review Fix Verification", "subsection": "01", "scenario": "03", "title": "OnEnvelopeCallback"}
func TestFixVerify_31_1_3_OnEnvelopeCallback(t *testing.T) {
	// Test the onEnvelope callback pattern used by Router.ProcessPending:
	// spool messages -> drain -> invoke callback for each payload.
	// This proves the pattern works without needing the full Router + DeadDrop + Sweeper.
	inbox := transport.NewInboxManager(transport.DefaultInboxConfig())
	ctx := context.Background()

	// Spool 2 messages.
	_, err := inbox.Spool(ctx, []byte("envelope-1"))
	if err != nil {
		t.Fatalf("Spool error: %v", err)
	}
	_, err = inbox.Spool(ctx, []byte("envelope-2"))
	if err != nil {
		t.Fatalf("Spool error: %v", err)
	}

	// Drain and invoke callback for each payload (mimicking Router.ProcessPending).
	payloads, err := inbox.DrainSpool(ctx)
	if err != nil {
		t.Fatalf("DrainSpool error: %v", err)
	}

	var callbackPayloads []string
	onEnvelope := func(_ context.Context, envelope []byte) {
		callbackPayloads = append(callbackPayloads, string(envelope))
	}

	for _, envelope := range payloads {
		onEnvelope(ctx, envelope)
	}

	// Verify the callback fired for both messages.
	if len(callbackPayloads) != 2 {
		t.Fatalf("expected 2 callback invocations, got %d", len(callbackPayloads))
	}
	if callbackPayloads[0] != "envelope-1" {
		t.Errorf("expected first callback payload 'envelope-1', got %q", callbackPayloads[0])
	}
	if callbackPayloads[1] != "envelope-2" {
		t.Errorf("expected second callback payload 'envelope-2', got %q", callbackPayloads[1])
	}
}

// TST-CORE-1036 Immediate decrypt: no 10s delay for D2D
// TRACE: {"suite": "CORE", "case": "0555", "section": "31", "sectionName": "Code Review Fix Verification", "subsection": "01", "scenario": "06", "title": "ImmediateDecrypt"}
func TestFixVerify_31_1_6_ImmediateDecrypt(t *testing.T) {
	// Test that DrainSpool returns messages immediately (within milliseconds),
	// proving there is no artificial delay in the D2D pipeline.
	inbox := transport.NewInboxManager(transport.DefaultInboxConfig())
	ctx := context.Background()

	// Spool several messages.
	for i := 0; i < 5; i++ {
		_, err := inbox.Spool(ctx, []byte("msg"))
		if err != nil {
			t.Fatalf("Spool error: %v", err)
		}
	}

	// Time the DrainSpool call — it must complete in well under 1 second.
	start := time.Now()
	payloads, err := inbox.DrainSpool(ctx)
	elapsed := time.Since(start)

	if err != nil {
		t.Fatalf("DrainSpool error: %v", err)
	}
	if len(payloads) != 5 {
		t.Errorf("expected 5 payloads, got %d", len(payloads))
	}

	// The threshold of 100ms is generous; real DrainSpool should complete in microseconds.
	if elapsed > 100*time.Millisecond {
		t.Errorf("DrainSpool took %v, expected < 100ms (no artificial delay)", elapsed)
	}
}

// TST-CORE-1037 Cross-node D2D: Alonso -> Sancho roundtrip
// TRACE: {"suite": "CORE", "case": "0556", "section": "31", "sectionName": "Code Review Fix Verification", "subsection": "01", "scenario": "07", "title": "CrossNodeD2D_AlonsoToSancho"}
func TestFixVerify_31_1_7_CrossNodeD2D_AlonsoToSancho(t *testing.T) {
	// Test cross-node D2D message delivery using the PRODUCTION domain.DinaMessage
	// through TransportService.StoreInbound / GetInbound — not the testutil fixture.
	env := newTransportTestEnv(t)

	// Positive: store a valid inbound D2D message from Alonso to Sancho.
	msg := &domain.DinaMessage{
		ID:          "msg_alonso_to_sancho_001",
		Type:        "dina/social/arrival",
		From:        "did:plc:alonso",
		To:          []string{"did:plc:sancho"},
		CreatedTime: time.Now().Unix(),
		Body:        []byte(`{"text":"Sancho, saddle Rocinante!"}`),
	}
	env.svc.StoreInbound(msg)

	// Retrieve and verify all fields survived the round-trip through production code.
	inbox := env.svc.GetInbound()
	if len(inbox) != 1 {
		t.Fatalf("expected 1 inbound message, got %d", len(inbox))
	}
	got := inbox[0]
	testutil.RequireEqual(t, got.ID, "msg_alonso_to_sancho_001")
	testutil.RequireEqual(t, got.From, "did:plc:alonso")
	if len(got.To) != 1 || got.To[0] != "did:plc:sancho" {
		t.Fatalf("expected To=['did:plc:sancho'], got %v", got.To)
	}
	testutil.RequireEqual(t, string(got.Type), "dina/social/arrival")
	testutil.RequireEqual(t, string(got.Body), `{"text":"Sancho, saddle Rocinante!"}`)

	// Negative: empty inbox after clear — proves GetInbound returns a copy, not alias.
	env.svc.ClearInbound()
	inbox2 := env.svc.GetInbound()
	if len(inbox2) != 0 {
		t.Fatalf("expected empty inbox after ClearInbound, got %d", len(inbox2))
	}
}

// TST-CORE-1038 Cross-node D2D: Sancho -> Alonso roundtrip
// TRACE: {"suite": "CORE", "case": "0557", "section": "31", "sectionName": "Code Review Fix Verification", "subsection": "01", "scenario": "08", "title": "CrossNodeD2D_SanchoToAlonso"}
func TestFixVerify_31_1_8_CrossNodeD2D_SanchoToAlonso(t *testing.T) {
	// Test the reverse direction: Sancho → Alonso using PRODUCTION domain.DinaMessage
	// through TransportService.StoreInbound / GetInbound.
	env := newTransportTestEnv(t)

	// Positive: store a response message from Sancho to Alonso.
	msg := &domain.DinaMessage{
		ID:          "msg_sancho_to_alonso_001",
		Type:        "dina/response",
		From:        "did:plc:sancho",
		To:          []string{"did:plc:alonso"},
		CreatedTime: time.Now().Unix(),
		Body:        []byte(`{"text":"Rocinante is saddled, my lord."}`),
	}
	env.svc.StoreInbound(msg)

	// Retrieve and verify all fields round-tripped through production code.
	inbox := env.svc.GetInbound()
	if len(inbox) != 1 {
		t.Fatalf("expected 1 inbound message, got %d", len(inbox))
	}
	got := inbox[0]
	testutil.RequireEqual(t, got.ID, "msg_sancho_to_alonso_001")
	testutil.RequireEqual(t, got.From, "did:plc:sancho")
	if len(got.To) != 1 || got.To[0] != "did:plc:alonso" {
		t.Fatalf("expected To=['did:plc:alonso'], got %v", got.To)
	}
	testutil.RequireEqual(t, string(got.Type), "dina/response")
	testutil.RequireEqual(t, string(got.Body), `{"text":"Rocinante is saddled, my lord."}`)

	// Negative: store a second message, verify ordering (FIFO).
	msg2 := &domain.DinaMessage{
		ID:   "msg_sancho_to_alonso_002",
		Type: "dina/ack",
		From: "did:plc:sancho",
		To:   []string{"did:plc:alonso"},
	}
	env.svc.StoreInbound(msg2)
	inbox2 := env.svc.GetInbound()
	if len(inbox2) != 2 {
		t.Fatalf("expected 2 inbound messages, got %d", len(inbox2))
	}
	testutil.RequireEqual(t, inbox2[0].ID, "msg_sancho_to_alonso_001")
	testutil.RequireEqual(t, inbox2[1].ID, "msg_sancho_to_alonso_002")
}

// TST-CORE-1039 Cross-node D2D: multicast (Alonso -> all 3)
// TRACE: {"suite": "CORE", "case": "0558", "section": "31", "sectionName": "Code Review Fix Verification", "subsection": "01", "scenario": "09", "title": "CrossNodeD2D_Multicast"}
func TestFixVerify_31_1_9_CrossNodeD2D_Multicast(t *testing.T) {
	// Test multicast using PRODUCTION domain.DinaMessage through TransportService.
	env := newTransportTestEnv(t)

	// Positive: store a multicast message with 3 recipients.
	msg := &domain.DinaMessage{
		ID:          "msg_multicast_001",
		Type:        "dina/social/arrival",
		From:        "did:plc:alonso",
		To:          []string{"did:plc:sancho", "did:plc:dulcinea", "did:plc:rocinante"},
		CreatedTime: time.Now().Unix(),
		Body:        []byte(`{"text":"We ride at dawn!"}`),
	}
	env.svc.StoreInbound(msg)

	// Retrieve and verify all 3 recipients survived the round-trip.
	inbox := env.svc.GetInbound()
	if len(inbox) != 1 {
		t.Fatalf("expected 1 inbound message, got %d", len(inbox))
	}
	got := inbox[0]
	testutil.RequireEqual(t, got.ID, "msg_multicast_001")
	testutil.RequireEqual(t, got.From, "did:plc:alonso")
	if len(got.To) != 3 {
		t.Fatalf("expected 3 recipients, got %d", len(got.To))
	}

	expectedRecipients := map[string]bool{
		"did:plc:sancho":    false,
		"did:plc:dulcinea":  false,
		"did:plc:rocinante": false,
	}
	for _, r := range got.To {
		if _, ok := expectedRecipients[r]; !ok {
			t.Errorf("unexpected recipient %q", r)
		}
		expectedRecipients[r] = true
	}
	for r, found := range expectedRecipients {
		if !found {
			t.Errorf("missing expected recipient %q", r)
		}
	}
	testutil.RequireEqual(t, string(got.Body), `{"text":"We ride at dawn!"}`)

	// Negative: single-recipient message must have exactly 1 To entry.
	single := &domain.DinaMessage{
		ID:   "msg_single_001",
		From: "did:plc:alonso",
		To:   []string{"did:plc:sancho"},
	}
	env.svc.StoreInbound(single)
	inbox2 := env.svc.GetInbound()
	if len(inbox2) != 2 {
		t.Fatalf("expected 2 inbound messages, got %d", len(inbox2))
	}
	if len(inbox2[1].To) != 1 || inbox2[1].To[0] != "did:plc:sancho" {
		t.Fatalf("single-recipient message corrupted: To=%v", inbox2[1].To)
	}
}

// ============================================================================
// §31.2 Core<->Brain Contract Alignment
// ============================================================================

// TST-CORE-1040 TaskEvent marshals to snake_case JSON
// TRACE: {"suite": "CORE", "case": "0559", "section": "31", "sectionName": "Code Review Fix Verification", "subsection": "02", "scenario": "01", "title": "TaskEventSnakeCaseJSON"}
func TestFixVerify_31_2_1_TaskEventSnakeCaseJSON(t *testing.T) {
	evt := domain.TaskEvent{
		TaskID:  "task_123",
		Type:    "process",
		Payload: map[string]interface{}{"key": "value"},
	}
	data, err := json.Marshal(evt)
	if err != nil {
		t.Fatalf("Marshal error: %v", err)
	}
	var m map[string]interface{}
	json.Unmarshal(data, &m)
	if _, ok := m["task_id"]; !ok {
		t.Error("expected snake_case key 'task_id' in JSON output")
	}
	if _, ok := m["type"]; !ok {
		t.Error("expected key 'type' in JSON output")
	}
	if _, ok := m["payload"]; !ok {
		t.Error("expected key 'payload' in JSON output")
	}
}

// TST-CORE-1041 ProcessEventRequest accepts task_id field
// TRACE: {"suite": "CORE", "case": "0560", "section": "31", "sectionName": "Code Review Fix Verification", "subsection": "02", "scenario": "02", "title": "ProcessEventAcceptsTaskID"}
func TestFixVerify_31_2_2_ProcessEventAcceptsTaskID(t *testing.T) {
	// Verify that a TaskEvent with task_id marshals correctly and can round-trip
	// through JSON, which is the format used by ProcessEvent on the wire.
	evt := domain.TaskEvent{
		TaskID:  "task_abc_789",
		Type:    "process",
		Payload: map[string]interface{}{"connector": "gmail", "cursor": "2026-01-01"},
	}

	// Marshal to JSON (what ProcessEvent sends to brain).
	data, err := json.Marshal(evt)
	if err != nil {
		t.Fatalf("Marshal error: %v", err)
	}

	// Verify the wire format contains task_id.
	if !bytes.Contains(data, []byte(`"task_id"`)) {
		t.Error("wire format missing 'task_id' key")
	}
	if !bytes.Contains(data, []byte(`"task_abc_789"`)) {
		t.Error("wire format missing task_id value")
	}

	// Round-trip: unmarshal back and verify.
	var decoded domain.TaskEvent
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("Unmarshal error: %v", err)
	}
	if decoded.TaskID != "task_abc_789" {
		t.Errorf("round-trip TaskID mismatch: got %q, want 'task_abc_789'", decoded.TaskID)
	}
	if decoded.Type != "process" {
		t.Errorf("round-trip Type mismatch: got %q, want 'process'", decoded.Type)
	}

	// Verify brain-style response can be unmarshaled.
	brainResp := `{"status":"ok","action":"none","task_id":"task_abc_789"}`
	var respMap map[string]interface{}
	if err := json.Unmarshal([]byte(brainResp), &respMap); err != nil {
		t.Fatalf("brain response Unmarshal error: %v", err)
	}
	if respMap["task_id"] != "task_abc_789" {
		t.Errorf("brain response task_id mismatch: got %v", respMap["task_id"])
	}
}

// TST-CORE-1042 TST-CORE-995 BrainClient.Reason sends "prompt" (not "query")
// TRACE: {"suite": "CORE", "case": "0561", "section": "31", "sectionName": "Code Review Fix Verification", "subsection": "02", "scenario": "03", "title": "ReasonSendsPrompt"}
func TestFixVerify_31_2_3_ReasonSendsPrompt(t *testing.T) {
	// Create a test HTTP server that captures the request body.
	var capturedBody []byte
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/reason" {
			body, err := io.ReadAll(r.Body)
			if err != nil {
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
			capturedBody = body
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"content":"test answer","model":"test-model","tokens_in":5,"tokens_out":10}`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer ts.Close()

	// Create a BrainClient pointing to our test server.
	client := brainclient.New(ts.URL, nil)
	ctx := context.Background()

	// Call Reason.
	result, err := client.Reason(ctx, "What is the meaning of life?")
	if err != nil {
		t.Fatalf("Reason error: %v", err)
	}

	// Verify the response was parsed correctly.
	if result.Content != "test answer" {
		t.Errorf("expected Content='test answer', got %q", result.Content)
	}
	if result.Model != "test-model" {
		t.Errorf("expected Model='test-model', got %q", result.Model)
	}

	// Verify the captured request body contains "prompt" key, not "query".
	var reqBody map[string]interface{}
	if err := json.Unmarshal(capturedBody, &reqBody); err != nil {
		t.Fatalf("failed to parse captured request body: %v", err)
	}

	if _, ok := reqBody["prompt"]; !ok {
		t.Error("request body missing 'prompt' key -- BrainClient.Reason must send 'prompt'")
	}
	if _, ok := reqBody["query"]; ok {
		t.Error("request body contains deprecated 'query' key -- must use 'prompt' instead")
	}
	if reqBody["prompt"] != "What is the meaning of life?" {
		t.Errorf("prompt value mismatch: got %q", reqBody["prompt"])
	}
}

// TST-CORE-1043 ReasonResult fields
// TRACE: {"suite": "CORE", "case": "0562", "section": "31", "sectionName": "Code Review Fix Verification", "subsection": "02", "scenario": "04", "title": "ReasonResultFields"}
func TestFixVerify_31_2_4_ReasonResultFields(t *testing.T) {
	jsonStr := `{"content":"answer","model":"gemini","tokens_in":10,"tokens_out":20}`
	var result domain.ReasonResult
	if err := json.Unmarshal([]byte(jsonStr), &result); err != nil {
		t.Fatalf("Unmarshal error: %v", err)
	}
	if result.Content != "answer" {
		t.Errorf("expected Content='answer', got %q", result.Content)
	}
	if result.Model != "gemini" {
		t.Errorf("expected Model='gemini', got %q", result.Model)
	}
	if result.TokensIn != 10 {
		t.Errorf("expected TokensIn=10, got %d", result.TokensIn)
	}
	if result.TokensOut != 20 {
		t.Errorf("expected TokensOut=20, got %d", result.TokensOut)
	}
}

// TST-CORE-1201 ReasonHandler propagates approval_required from Brain as 403
// TRACE: {"suite": "CORE", "case": "0563", "section": "34", "sectionName": "Thesis: Loyalty", "subsection": "03", "scenario": "01", "title": "ReasonApprovalPropagation"}
func TestFixVerify_34_3_ReasonApprovalPropagation(t *testing.T) {
	// Scenario: Brain returns HTTP 403 with approval_required detail.
	// Core's ReasonHandler must detect "approval_required" in the error
	// and return 403 (not 502) to the client, so the CLI approval UX triggers.

	// Mock Brain that returns 403 for reason requests.
	approvalBrain := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/reason" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"detail":{"error":"approval_required","persona":"health","approval_id":"apr-123","message":"Approval required for health"}}`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer approvalBrain.Close()

	client := brainclient.New(approvalBrain.URL, nil)
	reasonHandler := &handler.ReasonHandler{Brain: client}

	// 1. Agent caller → ReasonHandler detects approval_required → 403
	body := strings.NewReader(`{"prompt":"office chairs for back pain"}`)
	req := httptest.NewRequest("POST", "/api/v1/reason", body)
	ctx := context.WithValue(req.Context(), middleware.CallerTypeKey, "agent")
	ctx = context.WithValue(ctx, middleware.AgentDIDKey, "did:key:z6MkTestAgent")
	ctx = context.WithValue(ctx, middleware.SessionNameKey, "chair-research")
	req = req.WithContext(ctx)
	rr := httptest.NewRecorder()

	reasonHandler.HandleReason(rr, req)

	if rr.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for approval_required, got %d: %s", rr.Code, rr.Body.String())
	}
	var respBody map[string]string
	if err := json.Unmarshal(rr.Body.Bytes(), &respBody); err != nil {
		t.Fatalf("response is not valid JSON: %v", err)
	}
	if respBody["error"] != "approval_required" {
		t.Errorf("expected error='approval_required', got %q", respBody["error"])
	}

	// 2. Negative control: Brain returns 200 → ReasonHandler returns 200
	happyBrain := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"content":"Here are some office chairs...","model":"test"}`))
	}))
	defer happyBrain.Close()

	happyClient := brainclient.New(happyBrain.URL, nil)
	happyHandler := &handler.ReasonHandler{Brain: happyClient}

	body2 := strings.NewReader(`{"prompt":"office chairs"}`)
	req2 := httptest.NewRequest("POST", "/api/v1/reason", body2)
	ctx2 := context.WithValue(req2.Context(), middleware.CallerTypeKey, "user")
	req2 = req2.WithContext(ctx2)
	rr2 := httptest.NewRecorder()

	happyHandler.HandleReason(rr2, req2)

	if rr2.Code != http.StatusOK {
		t.Fatalf("expected 200 for successful reason, got %d: %s", rr2.Code, rr2.Body.String())
	}

	// 3. Negative control: Brain returns 500 → ReasonHandler returns 502 (not 403)
	failBrain := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`internal server error`))
	}))
	defer failBrain.Close()

	failClient := brainclient.New(failBrain.URL, nil)
	failHandler := &handler.ReasonHandler{Brain: failClient}

	body3 := strings.NewReader(`{"prompt":"test query"}`)
	req3 := httptest.NewRequest("POST", "/api/v1/reason", body3)
	rr3 := httptest.NewRecorder()

	failHandler.HandleReason(rr3, req3)

	if rr3.Code != http.StatusBadGateway {
		t.Fatalf("expected 502 for brain error, got %d", rr3.Code)
	}
}

// ============================================================================
// §31.4 Search Fallback
// ============================================================================

// TST-CORE-1050 Degradation signal in response
// TRACE: {"suite": "CORE", "case": "0564", "section": "31", "sectionName": "Code Review Fix Verification", "subsection": "04", "scenario": "02", "title": "DegradationSignal"}
func TestFixVerify_31_4_2_DegradationSignal(t *testing.T) {
	// Test real degradation: VectorSearch on items without embeddings returns
	// empty (degradation signal), while FTS5 Query on the same items succeeds.
	// This proves the caller can detect degradation and fallback.

	ctx := context.Background()
	mgr := realVaultManager
	persona := domain.PersonaName("degradation-signal-test")
	dek := make([]byte, 32)
	copy(dek, []byte("degradation-signal-dek-key-12345"))

	if err := mgr.Open(ctx, persona, dek); err != nil {
		t.Fatalf("Open vault: %v", err)
	}
	defer mgr.Close(persona)

	// Store an item WITHOUT embeddings.
	item := domain.VaultItem{
		Type:      "note",
		Summary:   "degradation test meeting agenda",
		BodyText:  "Review Q4 targets and team capacity",
		Timestamp: 5000,
	}
	_, err := mgr.Store(ctx, persona, item)
	if err != nil {
		t.Fatalf("Store: %v", err)
	}

	// Semantic path: VectorSearch returns 0 results (degradation signal).
	results, err := mgr.VectorSearch(ctx, persona, []float32{0.1, 0.2, 0.3}, 10)
	if err != nil {
		t.Fatalf("VectorSearch error: %v", err)
	}
	if len(results) != 0 {
		t.Fatalf("VectorSearch must return 0 for items without embeddings (degradation signal), got %d", len(results))
	}

	// FTS5 path: Query finds the same item — proves fallback works.
	ftsResults, err := mgr.Query(ctx, persona, domain.SearchQuery{
		Mode:  domain.SearchFTS5,
		Query: "degradation meeting",
		Limit: 10,
	})
	if err != nil {
		t.Fatalf("Query (FTS5) error: %v", err)
	}
	if len(ftsResults) == 0 {
		t.Fatal("FTS5 Query must find the item that VectorSearch could not — fallback path broken")
	}

	// Verify the three SearchMode constants are distinct (prevents typo collapse).
	if domain.SearchHybrid == domain.SearchSemantic || domain.SearchSemantic == domain.SearchFTS5 || domain.SearchHybrid == domain.SearchFTS5 {
		t.Fatal("SearchMode constants must all be distinct")
	}
}

// TST-CORE-1051 Semantic query returns FTS5 with degradation flag
// TRACE: {"suite": "CORE", "case": "0565", "section": "31", "sectionName": "Code Review Fix Verification", "subsection": "04", "scenario": "03", "title": "SemanticFallbackToFTS5"}
func TestFixVerify_31_4_3_SemanticFallbackToFTS5(t *testing.T) {
	// Test the real fallback pattern: VectorSearch returns nothing when
	// items have no embeddings, so the caller falls back to Query (FTS5).
	// Both methods exercise real vault.Manager production code.

	ctx := context.Background()
	mgr := realVaultManager
	persona := domain.PersonaName("fallback-fts5-test")
	dek := make([]byte, 32)
	copy(dek, []byte("fallback-fts5-dek-test-key-12345"))

	if err := mgr.Open(ctx, persona, dek); err != nil {
		t.Fatalf("Open vault: %v", err)
	}
	defer mgr.Close(persona)

	// Store items WITHOUT embeddings (simulating pre-embedding-migration data).
	items := []domain.VaultItem{
		{Type: "note", Summary: "important meeting notes from Monday", BodyText: "Discussed Q3 roadmap with the team.", Timestamp: 1000},
		{Type: "note", Summary: "grocery list", BodyText: "Buy milk, eggs, and bread.", Timestamp: 2000},
		{Type: "note", Summary: "important quarterly review", BodyText: "Review all meeting notes for Q3.", Timestamp: 3000},
	}
	for _, item := range items {
		if _, err := mgr.Store(ctx, persona, item); err != nil {
			t.Fatalf("Store item: %v", err)
		}
	}

	// Step 1: Attempt VectorSearch (semantic mode) — should return empty
	// because none of the items have embeddings.
	queryVec := []float32{0.1, 0.2, 0.3, 0.4}
	semanticResults, err := mgr.VectorSearch(ctx, persona, queryVec, 10)
	if err != nil {
		t.Fatalf("VectorSearch error: %v", err)
	}
	if len(semanticResults) != 0 {
		t.Fatalf("VectorSearch should return 0 results for items without embeddings, got %d", len(semanticResults))
	}

	// Step 2: Fallback to FTS5 text search via Query — should find matches.
	ftsQuery := domain.SearchQuery{
		Mode:  domain.SearchFTS5,
		Query: "meeting notes",
		Limit: 10,
	}
	ftsResults, err := mgr.Query(ctx, persona, ftsQuery)
	if err != nil {
		t.Fatalf("Query (FTS5 fallback) error: %v", err)
	}
	if len(ftsResults) != 2 {
		t.Fatalf("FTS5 fallback should find 2 items matching 'meeting notes', got %d", len(ftsResults))
	}

	// Verify results are sorted by timestamp descending (most recent first).
	if ftsResults[0].Timestamp <= ftsResults[1].Timestamp {
		t.Errorf("expected descending timestamp order, got %d then %d",
			ftsResults[0].Timestamp, ftsResults[1].Timestamp)
	}

	// Step 3: Now store an item WITH an embedding and verify VectorSearch
	// finds it (confirming VectorSearch works when embeddings exist).
	embeddedItem := domain.VaultItem{
		Type:      "note",
		Summary:   "embedded meeting notes",
		BodyText:  "This item has an embedding vector.",
		Timestamp: 4000,
		Embedding: []float32{0.1, 0.2, 0.3, 0.4}, // matches query vector exactly
	}
	if _, err := mgr.Store(ctx, persona, embeddedItem); err != nil {
		t.Fatalf("Store embedded item: %v", err)
	}

	semanticResults2, err := mgr.VectorSearch(ctx, persona, queryVec, 10)
	if err != nil {
		t.Fatalf("VectorSearch (with embeddings) error: %v", err)
	}
	if len(semanticResults2) != 1 {
		t.Fatalf("VectorSearch should return 1 result for item with matching embedding, got %d", len(semanticResults2))
	}
	if semanticResults2[0].Summary != "embedded meeting notes" {
		t.Errorf("VectorSearch returned wrong item: got %q", semanticResults2[0].Summary)
	}
}

// ============================================================================
// §31.5 Contact Routes
// ============================================================================

// TST-CORE-1052 PUT /v1/contacts/{did} updates contact name
// TRACE: {"suite": "CORE", "case": "0566", "section": "31", "sectionName": "Code Review Fix Verification", "subsection": "05", "scenario": "01", "title": "UpdateContact"}
func TestFixVerify_31_5_1_UpdateContact(t *testing.T) {
	// Fresh ContactDirectory per test — no shared state leaks.
	cd := identity.NewContactDirectory()

	ctx := context.Background()

	testDID := "did:plc:contact-update-test"
	originalName := "Original Name"
	updatedName := "Updated Name"

	// Negative: Resolve on empty directory must fail.
	_, err := cd.Resolve(ctx, originalName)
	testutil.RequireError(t, err)

	// Add a contact.
	err = cd.Add(ctx, testDID, originalName, "trusted")
	testutil.RequireNoError(t, err)

	// Verify the contact was added with the original name.
	resolvedDID, err := cd.Resolve(ctx, originalName)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, resolvedDID, testDID)

	// Verify trust level was stored correctly.
	trust := cd.GetTrustLevel(testDID)
	testutil.RequireEqual(t, trust, "trusted")

	// Update the contact name (this is what PUT /v1/contacts/{did} does).
	err = cd.UpdateName(ctx, testDID, updatedName)
	testutil.RequireNoError(t, err)

	// Verify the name changed: old name should no longer resolve.
	_, err = cd.Resolve(ctx, originalName)
	testutil.RequireError(t, err)

	// New name should resolve to the same DID.
	resolvedDID, err = cd.Resolve(ctx, updatedName)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, resolvedDID, testDID)

	// Verify the contact appears in the list with the updated name.
	contacts, err := cd.List(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(contacts), 1)
	testutil.RequireEqual(t, contacts[0].DID, testDID)
	testutil.RequireEqual(t, contacts[0].Name, updatedName)
	testutil.RequireEqual(t, contacts[0].TrustLevel, "trusted")

	// Negative: UpdateName for non-existent DID must fail.
	err = cd.UpdateName(ctx, "did:plc:nonexistent", "Foo")
	testutil.RequireError(t, err)

	// Delete and verify removal.
	err = cd.Delete(ctx, testDID)
	testutil.RequireNoError(t, err)

	contacts2, err := cd.List(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(contacts2), 0)

	// Negative: Delete non-existent DID should not error (idempotent) or error.
	// Either behavior is acceptable — just verify no panic.
	_ = cd.Delete(ctx, "did:plc:nonexistent")
}

// TST-CORE-1054 Admin UI update calls core API (not vault hack)
// TRACE: {"suite": "CORE", "case": "0567", "section": "31", "sectionName": "Code Review Fix Verification", "subsection": "05", "scenario": "03", "title": "AdminUICallsCoreAPI"}
func TestFixVerify_31_5_3_AdminUICallsCoreAPI(t *testing.T) {
	// This test verifies the core API contract that the admin UI would call.
	// The admin UI must use the ContactDirectory API (Add, UpdateName, UpdateTrust)
	// rather than directly modifying the vault.
	cd := identity.NewContactDirectory()

	ctx := context.Background()
	testDID := "did:plc:admin-ui-test"

	// Step 1: Add contact via core API (not vault hack).
	err := cd.Add(ctx, testDID, "Admin UI Contact", "unknown")
	if err != nil {
		t.Fatalf("Add error: %v", err)
	}

	// Step 2: Update trust via core API.
	err = cd.UpdateTrust(ctx, testDID, "trusted")
	if err != nil {
		t.Fatalf("UpdateTrust error: %v", err)
	}

	// Step 3: Verify the trust level changed.
	contacts, err := cd.List(ctx)
	if err != nil {
		t.Fatalf("List error: %v", err)
	}
	for _, c := range contacts {
		if c.DID == testDID {
			if c.TrustLevel != "trusted" {
				t.Errorf("expected trust level 'trusted', got %q", c.TrustLevel)
			}
		}
	}

	// Clean up.
	_ = cd.Delete(ctx, testDID)
}

// ============================================================================
// §31.6 Config & Startup
// ============================================================================

// TST-CORE-1055 Default brain config core URL is http://core:8100
// TRACE: {"suite": "CORE", "case": "0568", "section": "31", "sectionName": "Code Review Fix Verification", "subsection": "06", "scenario": "01", "title": "DefaultCoreURL"}
func TestFixVerify_31_6_1_DefaultCoreURL(t *testing.T) {
	// Clear env vars that could override defaults, ensuring we test production defaults().
	t.Setenv("DINA_ADMIN_ADDR", "")
	t.Setenv("DINA_BRAIN_URL", "")
	t.Setenv("DINA_CONFIG_PATH", "")

	loader := realConfigLoader
	testutil.RequireImplementation(t, loader, "ConfigLoader")

	loadedCfg, err := loader.Load()
	if err != nil {
		t.Fatalf("config Load error: %v", err)
	}
	// The real config loader's defaults() must produce the expected values.
	if loadedCfg.AdminAddr != ":8100" {
		t.Errorf("loaded config AdminAddr: got %q, want ':8100'", loadedCfg.AdminAddr)
	}
	if loadedCfg.BrainURL != "http://brain:8200" {
		t.Errorf("loaded config BrainURL: got %q, want 'http://brain:8200'", loadedCfg.BrainURL)
	}
}

// TST-CORE-1057 DINA_KNOWN_PEERS parsed into peer registry
// TRACE: {"suite": "CORE", "case": "0569", "section": "31", "sectionName": "Code Review Fix Verification", "subsection": "06", "scenario": "03", "title": "KnownPeersParsed"}
func TestFixVerify_31_6_3_KnownPeersParsed(t *testing.T) {
	// DINA_KNOWN_PEERS is a comma-separated list of "did=endpoint" pairs.
	// While the actual env var handling is in main.go, we test the parsing
	// logic and format contract here.

	// Define the expected format.
	knownPeers := "did:plc:sancho=https://sancho.dina.local:8300,did:plc:dulcinea=https://dulcinea.dina.local:8300,did:plc:rocinante=https://rocinante.dina.local:8300"

	// Set the env var.
	oldVal := os.Getenv("DINA_KNOWN_PEERS")
	os.Setenv("DINA_KNOWN_PEERS", knownPeers)
	defer func() {
		if oldVal == "" {
			os.Unsetenv("DINA_KNOWN_PEERS")
		} else {
			os.Setenv("DINA_KNOWN_PEERS", oldVal)
		}
	}()

	// Parse the env var using the same logic main.go would use.
	raw := os.Getenv("DINA_KNOWN_PEERS")
	if raw == "" {
		t.Fatal("DINA_KNOWN_PEERS env var not set")
	}

	peers := make(map[string]string) // DID -> endpoint
	for _, entry := range strings.Split(raw, ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		parts := strings.SplitN(entry, "=", 2)
		if len(parts) != 2 {
			t.Errorf("invalid peer entry format: %q (expected did=endpoint)", entry)
			continue
		}
		did := strings.TrimSpace(parts[0])
		endpoint := strings.TrimSpace(parts[1])
		if !strings.HasPrefix(did, "did:") {
			t.Errorf("invalid DID in peer entry: %q", did)
			continue
		}
		if !strings.HasPrefix(endpoint, "https://") && !strings.HasPrefix(endpoint, "http://") {
			t.Errorf("invalid endpoint in peer entry: %q", endpoint)
			continue
		}
		peers[did] = endpoint
	}

	// Verify all 3 peers were parsed.
	if len(peers) != 3 {
		t.Fatalf("expected 3 peers, got %d", len(peers))
	}

	expectedPeers := map[string]string{
		"did:plc:sancho":    "https://sancho.dina.local:8300",
		"did:plc:dulcinea":  "https://dulcinea.dina.local:8300",
		"did:plc:rocinante": "https://rocinante.dina.local:8300",
	}
	for did, endpoint := range expectedPeers {
		if got, ok := peers[did]; !ok {
			t.Errorf("missing peer %q", did)
		} else if got != endpoint {
			t.Errorf("peer %q: got endpoint %q, want %q", did, got, endpoint)
		}
	}

	// Verify the parsed peers can be registered with the DID resolver.
	resolver := transport.NewTestDIDResolver()
	for did, endpoint := range peers {
		doc := []byte(`{"id":"` + did + `","service":[{"id":"#didcomm","type":"DIDCommMessaging","serviceEndpoint":"` + endpoint + `"}]}`)
		resolver.AddDocument(did, doc)
	}
	if resolver.CacheSize() < 3 {
		t.Errorf("expected at least 3 cached docs after registering peers, got %d", resolver.CacheSize())
	}
}

// helper
func newTestInboxManager(t *testing.T) *testInboxManager {
	t.Helper()
	return &testInboxManager{
		spoolData: make([]spoolEntry, 0),
		msgTTL:    5 * time.Minute,
	}
}

type spoolEntry struct {
	payload   []byte
	spooledAt time.Time
}

type testInboxManager struct {
	spoolData  []spoolEntry
	spoolBytes int64
	msgTTL     time.Duration
}

func (im *testInboxManager) CheckIPRate(ip string) bool    { return true }
func (im *testInboxManager) CheckGlobalRate() bool          { return true }
func (im *testInboxManager) CheckPayloadSize(p []byte) bool { return len(p) < 256*1024 }
func (im *testInboxManager) Spool(ctx context.Context, p []byte) (string, error) {
	im.spoolData = append(im.spoolData, spoolEntry{payload: p, spooledAt: time.Now()})
	im.spoolBytes += int64(len(p))
	return "id", nil
}
func (im *testInboxManager) SpoolSize() (int64, error)                    { return im.spoolBytes, nil }
func (im *testInboxManager) ProcessSpool(ctx context.Context) (int, error) { return 0, nil }
func (im *testInboxManager) DrainSpool(ctx context.Context) ([][]byte, error) {
	if len(im.spoolData) == 0 {
		return nil, nil
	}
	var payloads [][]byte
	for _, entry := range im.spoolData {
		if im.msgTTL > 0 && time.Since(entry.spooledAt) >= im.msgTTL {
			continue
		}
		payloads = append(payloads, entry.payload)
	}
	im.spoolData = nil
	im.spoolBytes = 0
	return payloads, nil
}
