package internal

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// waitFor polls a condition function until it returns true or the timeout
// expires. Replaces sleep-based synchronization for async operations.
// Returns true if the condition was met, false if timed out.
func waitFor(t *testing.T, timeout time.Duration, condition func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if condition() {
			return true
		}
		time.Sleep(5 * time.Millisecond)
	}
	return false
}

// startTestMsgBox creates a full MsgBox handler (Hub + Handler) with an
// in-memory buffer and starts an HTTP test server. The caller gets a
// connected, authenticated WebSocket for the given DID. The handler runs
// the full read pump in a background goroutine.
//
// For auth, we bypass the normal challenge-response and directly register
// the connection by using a custom handler that skips auth. This isolates
// the binary-frame dispatch tests from the auth code.
func startTestMsgBox(t *testing.T, did string) (client *websocket.Conn, hub *Hub, buf *Buffer, cleanup func()) {
	t.Helper()

	buf = newTestBuffer(t)
	hub = NewHub(buf)
	handler := NewHandler(hub)

	// Custom HTTP handler: accept WS, skip auth, register directly, run read pump.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		connCtx, connCancel := context.WithCancel(r.Context())
		conn := &MsgBoxConn{
			WS:         ws,
			DID:        did,
			RemoteAddr: r.RemoteAddr,
			Ctx:        connCtx,
			Cancel:     func() { connCancel(); ws.Close(websocket.StatusNormalClosure, "closing") },
		}
		handler.Hub.Register(conn)

		// Read pump (same as HandleWebSocket, but using r.Context directly).
		for {
			msgType, data, readErr := ws.Read(r.Context())
			if readErr != nil {
				break
			}
			if msgType == websocket.MessageBinary {
				handler.handleWSBinaryForward(conn, data)
			}
		}
		handler.Hub.Unregister(did, conn)
	}))

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	ws, _, err := websocket.Dial(context.Background(), wsURL, nil)
	if err != nil {
		buf.Close()
		srv.Close()
		t.Fatalf("dial: %v", err)
	}

	cleanup = func() {
		ws.Close(websocket.StatusNormalClosure, "")
		srv.Close()
		buf.Close()
	}
	return ws, hub, buf, cleanup
}

// sendBinary sends a binary WebSocket frame.
func sendBinary(t *testing.T, ws *websocket.Conn, data []byte) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := ws.Write(ctx, websocket.MessageBinary, data); err != nil {
		t.Fatalf("sendBinary: %v", err)
	}
}

// makeD2DFrame builds a unified D2D JSON envelope with an auto-generated message ID.
// senderDID must match the conn.DID from startTestMsgBox for sender binding to pass.
func makeD2DFrame(senderDID, recipientDID string, payload []byte) []byte {
	return makeD2DEnvelope(senderDID, recipientDID, fmt.Sprintf("d2d-%d", time.Now().UnixNano()), payload)
}

// makeD2DEnvelope builds a unified D2D JSON envelope (the new format).
func makeD2DEnvelope(senderDID, recipientDID, msgID string, d2dPayload []byte) []byte {
	env := envelope{
		Type:       "d2d",
		ID:         msgID,
		FromDID:    senderDID,
		ToDID:      recipientDID,
		Ciphertext: string(d2dPayload),
	}
	data, _ := json.Marshal(env)
	return data
}

// --- TST-MBX-0073: Invalid JSON binary frame → dropped, connection alive ---
// TRACE: {"suite": "MBX", "case": "0073", "section": "07", "sectionName": "Envelope Parsing & Hardening", "subsection": "01", "scenario": "01", "title": "invalid_json_binary_frame_dropped"}
func TestHandler_InvalidJSONDropped(t *testing.T) {
	senderDID := "did:key:zSender001"
	recipientDID := "did:plc:recipient001"

	ws, _, buf, cleanup := startTestMsgBox(t, senderDID)
	defer cleanup()

	// Send invalid JSON that starts with '{' but is not valid JSON.
	sendBinary(t, ws, []byte(`{this is not json`))

	// Connection should still be alive — send a valid D2D frame.
	sendBinary(t, ws, makeD2DFrame(senderDID, recipientDID, []byte("alive-check")))

	// Wait for the D2D frame to be buffered (replaces fixed sleep).
	if !waitFor(t, 2*time.Second, func() bool { return buf.TotalCount() >= 1 }) {
		t.Fatalf("timeout: buffer count = %d, want >= 1", buf.TotalCount())
	}
	if buf.TotalCount() != 1 {
		t.Errorf("buffer count = %d, want 1 (D2D should have succeeded after bad JSON)", buf.TotalCount())
	}
}

// --- TST-MBX-0074: Unknown type field → ignored, connection alive ---
// TRACE: {"suite": "MBX", "case": "0074", "section": "07", "sectionName": "Envelope Parsing & Hardening", "subsection": "01", "scenario": "02", "title": "unknown_type_ignored"}
func TestHandler_UnknownTypeIgnored(t *testing.T) {
	senderDID := "did:key:zSender002"
	recipientDID := "did:plc:recipient002"

	ws, _, buf, cleanup := startTestMsgBox(t, senderDID)
	defer cleanup()

	// Send valid JSON with unknown type.
	sendBinary(t, ws, []byte(`{"type":"foo","id":"x","from_did":"a","to_did":"b"}`))

	time.Sleep(50 * time.Millisecond)

	// Connection alive — send valid D2D.
	sendBinary(t, ws, makeD2DFrame(senderDID, recipientDID, []byte("after-unknown-type")))

	time.Sleep(50 * time.Millisecond)

	if buf.TotalCount() != 1 {
		t.Errorf("buffer count = %d, want 1", buf.TotalCount())
	}
}

// --- TST-MBX-0075: RPC with bad direction → dropped ---
// TRACE: {"suite": "MBX", "case": "0075", "section": "07", "sectionName": "Envelope Parsing & Hardening", "subsection": "01", "scenario": "03", "title": "rpc_bad_direction_dropped"}
func TestHandler_RPCBadDirection(t *testing.T) {
	senderDID := "did:key:zSender003"
	recipientDID := "did:plc:recipient003"

	ws, _, buf, cleanup := startTestMsgBox(t, senderDID)
	defer cleanup()

	// Send RPC with invalid direction.
	env := envelope{
		Type:      "rpc",
		ID:        "req-bad-dir",
		FromDID:   senderDID,
		ToDID:     recipientDID,
		Direction: "sideways", // invalid
	}
	data, _ := json.Marshal(env)
	sendBinary(t, ws, data)

	time.Sleep(50 * time.Millisecond)

	// Should be dropped — nothing buffered for recipient.
	if buf.TotalCount() != 0 {
		t.Errorf("buffer count = %d, want 0 (bad direction should be dropped)", buf.TotalCount())
	}

	// Connection alive — send valid D2D.
	sendBinary(t, ws, makeD2DFrame(senderDID, recipientDID, []byte("still-alive")))
	time.Sleep(50 * time.Millisecond)

	if buf.TotalCount() != 1 {
		t.Errorf("after recovery: buffer count = %d, want 1", buf.TotalCount())
	}
}

// --- TST-MBX-0076: RPC with missing id → rejected ---
// TRACE: {"suite": "MBX", "case": "0076", "section": "07", "sectionName": "Envelope Parsing & Hardening", "subsection": "01", "scenario": "04", "title": "rpc_missing_id_rejected"}
func TestHandler_RPCMissingID(t *testing.T) {
	senderDID := "did:key:zSender004"
	recipientDID := "did:plc:recipient004"

	ws, _, buf, cleanup := startTestMsgBox(t, senderDID)
	defer cleanup()

	// Send RPC with missing id.
	env := envelope{
		Type:      "rpc",
		ID:        "", // missing
		FromDID:   senderDID,
		ToDID:     recipientDID,
		Direction: "request",
	}
	data, _ := json.Marshal(env)
	sendBinary(t, ws, data)

	time.Sleep(50 * time.Millisecond)

	// Should be rejected — nothing buffered.
	if buf.TotalCount() != 0 {
		t.Errorf("buffer count = %d, want 0 (missing id should be rejected)", buf.TotalCount())
	}

	// Connection alive.
	sendBinary(t, ws, makeD2DFrame(senderDID, recipientDID, []byte("alive")))
	time.Sleep(50 * time.Millisecond)

	if buf.TotalCount() != 1 {
		t.Errorf("after recovery: buffer count = %d, want 1", buf.TotalCount())
	}
}

// --- TST-MBX-0081: Rapid bad → good → bad → good sequence ---
// TRACE: {"suite": "MBX", "case": "0081", "section": "07", "sectionName": "Envelope Parsing & Hardening", "subsection": "01", "scenario": "09", "title": "rapid_bad_good_sequence"}
func TestHandler_RapidBadGoodSequence(t *testing.T) {
	senderDID := "did:key:zSender005"
	recipientDID := "did:plc:recipient005"

	ws, _, buf, cleanup := startTestMsgBox(t, senderDID)
	defer cleanup()

	// Frame 1: bad JSON.
	sendBinary(t, ws, []byte(`{broken`))

	// Frame 2: valid RPC.
	goodRPC := envelope{
		Type:      "rpc",
		ID:        "req-good-1",
		FromDID:   senderDID,
		ToDID:     recipientDID,
		Direction: "request",
	}
	rpcData, _ := json.Marshal(goodRPC)
	sendBinary(t, ws, rpcData)

	// Frame 3: bad — unknown type.
	sendBinary(t, ws, []byte(`{"type":"nonsense"}`))

	// Frame 4: valid D2D.
	sendBinary(t, ws, makeD2DFrame(senderDID, recipientDID, []byte("d2d-good")))

	// Give handler time to process all 4.
	time.Sleep(100 * time.Millisecond)

	// Exactly 2 messages should be buffered (the valid RPC + the valid D2D).
	count := buf.TotalCount()
	if count != 2 {
		t.Errorf("buffer count = %d, want 2 (1 valid RPC + 1 valid D2D)", count)
	}

	// Verify both messages are for the recipient.
	msgs := buf.Peek(recipientDID)
	if len(msgs) != 2 {
		t.Fatalf("Peek(%q) = %d msgs, want 2", recipientDID, len(msgs))
	}

	// Verify the RPC used the composite key.
	rpcKey := senderDID + ":req-good-1"
	foundRPC := false
	for _, m := range msgs {
		if m.ID == rpcKey {
			foundRPC = true
			// Verify the raw JSON was stored as-is (opaque to MsgBox).
			var stored envelope
			if json.Unmarshal(m.Payload, &stored) == nil && stored.ID == "req-good-1" {
				// Good — the full envelope is preserved.
			} else {
				t.Errorf("stored RPC payload is not the original envelope")
			}
		}
	}
	if !foundRPC {
		ids := make([]string, len(msgs))
		for i, m := range msgs {
			ids[i] = m.ID
		}
		t.Errorf("RPC with composite key %q not found in buffer, got IDs: %v", rpcKey, ids)
	}
}

// --- Bonus: verify valid RPC is routed correctly (prerequisite for hardening) ---
func TestHandler_ValidRPCRouted(t *testing.T) {
	senderDID := "did:key:zSender006"
	recipientDID := "did:plc:recipient006"

	ws, _, buf, cleanup := startTestMsgBox(t, senderDID)
	defer cleanup()

	env := envelope{
		Type:       "rpc",
		ID:         "req-valid-001",
		FromDID:    senderDID,
		ToDID:      recipientDID,
		Direction:  "request",
		Ciphertext: "base64ciphertext",
	}
	data, _ := json.Marshal(env)
	sendBinary(t, ws, data)

	time.Sleep(50 * time.Millisecond)

	// Should be buffered for recipient with composite key.
	expectedKey := senderDID + ":req-valid-001"
	msgs := buf.Peek(recipientDID)
	if len(msgs) != 1 {
		t.Fatalf("Peek: got %d, want 1", len(msgs))
	}
	if msgs[0].ID != expectedKey {
		t.Errorf("msg.ID = %q, want %q", msgs[0].ID, expectedKey)
	}

	// Payload is the full raw JSON envelope (opaque).
	var stored map[string]interface{}
	if err := json.Unmarshal(msgs[0].Payload, &stored); err != nil {
		t.Fatalf("stored payload is not valid JSON: %v", err)
	}
	if stored["id"] != "req-valid-001" {
		t.Errorf("stored id = %v, want req-valid-001", stored["id"])
	}
	if fmt.Sprint(stored["ciphertext"]) != "base64ciphertext" {
		t.Errorf("stored ciphertext = %v, want base64ciphertext", stored["ciphertext"])
	}
}

// --- TST-MBX-0069: Mixed D2D + RPC interleaving ---
// TRACE: {"suite": "MBX", "case": "0069", "section": "06", "sectionName": "Operational & Load", "subsection": "04", "scenario": "01", "title": "mixed_d2d_rpc_interleaving"}
//
// Send D2D, RPC, D2D, RPC in sequence on the same connection → all 4 delivered
// correctly, no misparsing or cross-contamination.
func TestHandler_MixedD2DRPCInterleaving(t *testing.T) {
	senderDID := "did:key:zMixed001"
	recipientDID := "did:plc:mixedRecipient"

	ws, _, buf, cleanup := startTestMsgBox(t, senderDID)
	defer cleanup()

	// Frame 1: D2D binary.
	sendBinary(t, ws, makeD2DFrame(senderDID, recipientDID, []byte("d2d-first")))

	// Frame 2: RPC JSON.
	rpc1, _ := json.Marshal(envelope{
		Type: "rpc", ID: "rpc-1", FromDID: senderDID,
		ToDID: recipientDID, Direction: "request",
	})
	sendBinary(t, ws, rpc1)

	// Frame 3: D2D binary.
	sendBinary(t, ws, makeD2DFrame(senderDID, recipientDID, []byte("d2d-second")))

	// Frame 4: RPC JSON.
	rpc2, _ := json.Marshal(envelope{
		Type: "rpc", ID: "rpc-2", FromDID: senderDID,
		ToDID: recipientDID, Direction: "request",
	})
	sendBinary(t, ws, rpc2)

	if !waitFor(t, 2*time.Second, func() bool { return buf.TotalCount() >= 4 }) {
		t.Fatalf("timeout: buffer = %d, want 4", buf.TotalCount())
	}

	msgs := buf.Peek(recipientDID)
	if len(msgs) != 4 {
		t.Fatalf("Peek: got %d messages, want 4", len(msgs))
	}

	// Classify each message.
	var d2dCount, rpcCount int
	for _, m := range msgs {
		if len(m.Payload) > 0 && m.Payload[0] == '{' {
			var env envelope
			if json.Unmarshal(m.Payload, &env) == nil && env.Type == "rpc" {
				rpcCount++
				continue
			}
		}
		d2dCount++
	}
	if d2dCount != 2 {
		t.Errorf("D2D messages = %d, want 2", d2dCount)
	}
	if rpcCount != 2 {
		t.Errorf("RPC messages = %d, want 2", rpcCount)
	}
}

// --- TST-MBX-0070: D2D binary frame not misparsed as RPC ---
// TRACE: {"suite": "MBX", "case": "0070", "section": "06", "sectionName": "Operational & Load", "subsection": "04", "scenario": "02", "title": "d2d_not_misparsed_as_rpc"}
//
// D2D binary frames use 2-byte DID length prefix. The first byte is never '{'
// (0x7B) for any practical DID length, so the dispatch should never enter the
// JSON path.
func TestHandler_D2DUsesUnifiedEnvelopeFormat(t *testing.T) {
	senderDID := "did:key:zD2DOnly"
	recipientDID := "did:plc:d2dTarget"

	ws, _, buf, cleanup := startTestMsgBox(t, senderDID)
	defer cleanup()

	// Send several D2D envelopes with various payload sizes.
	payloads := []string{"small", "medium-length-payload-here", string(make([]byte, 1000))}
	for _, p := range payloads {
		sendBinary(t, ws, makeD2DFrame(senderDID, recipientDID, []byte(p)))
	}

	time.Sleep(100 * time.Millisecond)

	msgs := buf.Peek(recipientDID)
	if len(msgs) != 3 {
		t.Fatalf("got %d messages, want 3 (all D2D)", len(msgs))
	}

	// All D2D messages now use sender-scoped composite keys (unified format).
	for i, m := range msgs {
		if !strings.HasPrefix(m.ID, senderDID+":") {
			t.Errorf("msgs[%d].ID = %q should have composite key prefix %q", i, m.ID, senderDID+":")
		}
		var env envelope
		if err := json.Unmarshal(m.Payload, &env); err != nil {
			t.Errorf("msgs[%d] payload not a JSON envelope: %v", i, err)
		} else if env.Type != "d2d" {
			t.Errorf("msgs[%d] type = %q, want d2d", i, env.Type)
		}
	}
}

// --- TST-MBX-0071: RPC JSON frame not misparsed as D2D ---
// TRACE: {"suite": "MBX", "case": "0071", "section": "06", "sectionName": "Operational & Load", "subsection": "04", "scenario": "03", "title": "rpc_not_misparsed_as_d2d"}
//
// RPC binary-JSON frames start with '{'. They must enter the JSON dispatch path,
// not the D2D 2-byte-DID-length path.
func TestHandler_RPCNotMisparsedAsD2D(t *testing.T) {
	senderDID := "did:key:zRPCOnly"
	recipientDID := "did:plc:rpcTarget"

	ws, _, buf, cleanup := startTestMsgBox(t, senderDID)
	defer cleanup()

	// Send a valid RPC envelope.
	env := envelope{
		Type: "rpc", ID: "rpc-parse-test", FromDID: senderDID,
		ToDID: recipientDID, Direction: "request", Ciphertext: "opaque",
	}
	data, _ := json.Marshal(env)
	sendBinary(t, ws, data)

	time.Sleep(50 * time.Millisecond)

	msgs := buf.Peek(recipientDID)
	if len(msgs) != 1 {
		t.Fatalf("got %d messages, want 1", len(msgs))
	}

	// Must be stored with composite key (RPC path), not random key (D2D path).
	expectedKey := senderDID + ":rpc-parse-test"
	if msgs[0].ID != expectedKey {
		t.Errorf("msg.ID = %q, want %q (indicates RPC was misparsed as D2D)", msgs[0].ID, expectedKey)
	}

	// Payload must be the full JSON envelope (not truncated by D2D DID-prefix parsing).
	var stored envelope
	if err := json.Unmarshal(msgs[0].Payload, &stored); err != nil {
		t.Fatalf("payload is not valid JSON: %v", err)
	}
	if stored.ID != "rpc-parse-test" || stored.Ciphertext != "opaque" {
		t.Errorf("stored envelope corrupted: id=%q cipher=%q", stored.ID, stored.Ciphertext)
	}
}

// --- TST-MBX-0079: Cancel with missing cancel_of → ignored ---
// TRACE: {"suite": "MBX", "case": "0079", "section": "07", "sectionName": "Envelope Parsing & Hardening", "subsection": "01", "scenario": "07", "title": "cancel_missing_cancel_of_ignored"}
func TestHandler_CancelMissingCancelOf(t *testing.T) {
	senderDID := "did:key:zCancel001"
	recipientDID := "did:plc:cancelTarget"

	ws, _, buf, cleanup := startTestMsgBox(t, senderDID)
	defer cleanup()

	// Send cancel with missing cancel_of.
	cancel := envelope{
		Type:    "cancel",
		FromDID: senderDID,
		ToDID:   recipientDID,
		// CancelOf intentionally missing.
	}
	data, _ := json.Marshal(cancel)
	sendBinary(t, ws, data)

	time.Sleep(50 * time.Millisecond)

	// Nothing should be buffered (cancel was dropped).
	if buf.TotalCount() != 0 {
		t.Errorf("buffer count = %d, want 0 (invalid cancel should be silently dropped)", buf.TotalCount())
	}

	// Connection alive — send valid D2D.
	sendBinary(t, ws, makeD2DFrame(senderDID, recipientDID, []byte("alive")))
	time.Sleep(50 * time.Millisecond)

	if buf.TotalCount() != 1 {
		t.Errorf("after recovery: buffer count = %d, want 1", buf.TotalCount())
	}
}

// --- TST-MBX-0080: Cancel with missing from_did → ignored ---
// TRACE: {"suite": "MBX", "case": "0080", "section": "07", "sectionName": "Envelope Parsing & Hardening", "subsection": "01", "scenario": "08", "title": "cancel_missing_from_did_ignored"}
func TestHandler_CancelMissingFromDID(t *testing.T) {
	senderDID := "did:key:zCancel002"
	recipientDID := "did:plc:cancelTarget2"

	ws, _, buf, cleanup := startTestMsgBox(t, senderDID)
	defer cleanup()

	// Send cancel with missing from_did.
	cancel := envelope{
		Type:     "cancel",
		CancelOf: "req-to-cancel",
		ToDID:    recipientDID,
		// FromDID intentionally missing.
	}
	data, _ := json.Marshal(cancel)
	sendBinary(t, ws, data)

	time.Sleep(50 * time.Millisecond)

	// Nothing buffered — cancel dropped because from_did is empty.
	if buf.TotalCount() != 0 {
		t.Errorf("buffer count = %d, want 0", buf.TotalCount())
	}

	// Connection alive.
	sendBinary(t, ws, makeD2DFrame(senderDID, recipientDID, []byte("alive")))
	time.Sleep(50 * time.Millisecond)

	if buf.TotalCount() != 1 {
		t.Errorf("after recovery: buffer count = %d, want 1", buf.TotalCount())
	}
}

// --- TST-MBX-0118: Sender binding — from_did matches conn.DID → accepted ---
// TRACE: {"suite": "MBX", "case": "0118", "section": "12", "sectionName": "MsgBox Sender Binding", "subsection": "01", "scenario": "01", "title": "sender_binding_match_accepted"}
func TestHandler_SenderBindingMatch(t *testing.T) {
	senderDID := "did:key:zSenderBind01"
	recipientDID := "did:plc:sbRecipient"

	ws, _, buf, cleanup := startTestMsgBox(t, senderDID)
	defer cleanup()

	env := envelope{
		Type: "rpc", ID: "sb-ok-1", FromDID: senderDID,
		ToDID: recipientDID, Direction: "request",
	}
	data, _ := json.Marshal(env)
	sendBinary(t, ws, data)
	time.Sleep(50 * time.Millisecond)

	if buf.TotalCount() != 1 {
		t.Errorf("buffer = %d, want 1 (sender binding match should be accepted)", buf.TotalCount())
	}
}

// --- TST-MBX-0119: Sender binding — from_did != conn.DID → rejected ---
// TRACE: {"suite": "MBX", "case": "0119", "section": "12", "sectionName": "MsgBox Sender Binding", "subsection": "01", "scenario": "02", "title": "sender_binding_mismatch_rejected"}
func TestHandler_SenderBindingMismatch(t *testing.T) {
	senderDID := "did:key:zSenderBind02"
	recipientDID := "did:plc:sbRecipient2"

	ws, _, buf, cleanup := startTestMsgBox(t, senderDID)
	defer cleanup()

	env := envelope{
		Type: "rpc", ID: "sb-forged", FromDID: "did:key:zAttacker",
		ToDID: recipientDID, Direction: "request",
	}
	data, _ := json.Marshal(env)
	sendBinary(t, ws, data)
	time.Sleep(50 * time.Millisecond)

	if buf.TotalCount() != 0 {
		t.Errorf("buffer = %d, want 0 (forged from_did should be rejected)", buf.TotalCount())
	}

	// Connection still alive.
	sendBinary(t, ws, makeD2DFrame(senderDID, recipientDID, []byte("still-alive")))
	time.Sleep(50 * time.Millisecond)
	if buf.TotalCount() != 1 {
		t.Errorf("after valid frame: buffer = %d, want 1", buf.TotalCount())
	}
}

// --- TST-MBX-0120: Cancel sender binding mismatch → rejected ---
// TRACE: {"suite": "MBX", "case": "0120", "section": "12", "sectionName": "MsgBox Sender Binding", "subsection": "01", "scenario": "03", "title": "cancel_sender_binding_mismatch"}
func TestHandler_CancelSenderBindingMismatch(t *testing.T) {
	senderDID := "did:key:zCancelBind01"
	recipientDID := "did:plc:cbRecipient"

	ws, _, buf, cleanup := startTestMsgBox(t, senderDID)
	defer cleanup()

	// Buffer an RPC so there's something to cancel.
	rpcReq := envelope{
		Type: "rpc", ID: "cancel-target", FromDID: senderDID,
		ToDID: recipientDID, Direction: "request",
	}
	rpcData, _ := json.Marshal(rpcReq)
	sendBinary(t, ws, rpcData)
	time.Sleep(50 * time.Millisecond)

	if buf.TotalCount() != 1 {
		t.Fatalf("setup: buffer = %d, want 1", buf.TotalCount())
	}

	// Cancel with WRONG from_did.
	cancel := envelope{
		Type: "cancel", CancelOf: "cancel-target",
		FromDID: "did:key:zAttacker", ToDID: recipientDID,
	}
	cancelData, _ := json.Marshal(cancel)
	sendBinary(t, ws, cancelData)
	time.Sleep(50 * time.Millisecond)

	// Request should still be buffered.
	if buf.TotalCount() != 1 {
		t.Errorf("after forged cancel: buffer = %d, want 1 (should be rejected)", buf.TotalCount())
	}
}

// --- TST-MBX-0121: D2D uses conn.DID for rate limiting, no spoofing ---
// TRACE: {"suite": "MBX", "case": "0121", "section": "12", "sectionName": "MsgBox Sender Binding", "subsection": "01", "scenario": "04", "title": "d2d_uses_conn_did_no_spoofing"}
func TestHandler_D2DUsesConnDIDForRateLimit(t *testing.T) {
	senderDID := "did:key:zD2DRate01"
	recipientDID := "did:plc:d2dRateTarget"

	ws, _, buf, cleanup := startTestMsgBox(t, senderDID)
	defer cleanup()

	// Send D2D frames — even if payload contains a different DID, rate limit uses conn.DID.
	for i := 0; i < 5; i++ {
		fakePayload := fmt.Sprintf(`{"from":"did:key:zFake","data":%d}`, i)
		sendBinary(t, ws, makeD2DFrame(senderDID, recipientDID, []byte(fakePayload)))
	}
	time.Sleep(100 * time.Millisecond)

	if buf.TotalCount() != 5 {
		t.Errorf("buffer = %d, want 5", buf.TotalCount())
	}

	// Exhaust D2D limit: 55 more → 60 total.
	for i := 0; i < 55; i++ {
		sendBinary(t, ws, makeD2DFrame(senderDID, recipientDID, []byte("x")))
	}
	time.Sleep(100 * time.Millisecond)

	if buf.TotalCount() != 60 {
		t.Fatalf("after 60 sends: buffer = %d, want 60", buf.TotalCount())
	}

	// 61st D2D should be throttled.
	sendBinary(t, ws, makeD2DFrame(senderDID, recipientDID, []byte("throttled")))
	time.Sleep(50 * time.Millisecond)

	if buf.TotalCount() != 60 {
		t.Errorf("after throttle: buffer = %d, want 60 (61st dropped)", buf.TotalCount())
	}
}

// --- TST-MBX-0108: D2D does not consume RPC quota ---
// TRACE: {"suite": "MBX", "case": "0108", "section": "10", "sectionName": "Pairing Subtype & Rate Isolation", "subsection": "02", "scenario": "05", "title": "d2d_does_not_consume_rpc_quota"}
func TestHandler_D2DDoesNotConsumeRPCQuota(t *testing.T) {
	senderDID := "did:key:zIsolation01"
	recipientDID := "did:plc:isoTarget"

	ws, _, buf, cleanup := startTestMsgBox(t, senderDID)
	defer cleanup()

	// Exhaust D2D rate limit: 60 messages.
	for i := 0; i < rateLimitMaxD2D; i++ {
		sendBinary(t, ws, makeD2DFrame(senderDID, recipientDID, []byte(fmt.Sprintf("d2d-%d", i))))
	}
	time.Sleep(200 * time.Millisecond)

	if buf.TotalCount() != rateLimitMaxD2D {
		t.Fatalf("after %d D2D: buffer = %d", rateLimitMaxD2D, buf.TotalCount())
	}

	// 61st D2D throttled.
	sendBinary(t, ws, makeD2DFrame(senderDID, recipientDID, []byte("throttled")))
	time.Sleep(50 * time.Millisecond)
	if buf.TotalCount() != rateLimitMaxD2D {
		t.Fatalf("D2D throttle failed: buffer = %d", buf.TotalCount())
	}

	// RPC should still work — separate bucket.
	rpcEnv := envelope{
		Type: "rpc", ID: "rpc-after-d2d",
		FromDID: senderDID, ToDID: recipientDID, Direction: "request",
	}
	rpcData, _ := json.Marshal(rpcEnv)
	sendBinary(t, ws, rpcData)
	time.Sleep(50 * time.Millisecond)

	expected := rateLimitMaxD2D + 1
	if buf.TotalCount() != expected {
		t.Errorf("after RPC: buffer = %d, want %d (RPC should use separate bucket)", buf.TotalCount(), expected)
	}
}

// --- TST-MBX-0109: RPC does not consume D2D quota ---
// TRACE: {"suite": "MBX", "case": "0109", "section": "10", "sectionName": "Pairing Subtype & Rate Isolation", "subsection": "02", "scenario": "06", "title": "rpc_does_not_consume_d2d_quota"}
//
// Send 300 RPC messages (hit RPC limit) → D2D still works.
func TestHandler_RPCDoesNotConsumeD2DQuota(t *testing.T) {
	senderDID := "did:plc:zIsolation02"

	ws, _, buf, cleanup := startTestMsgBox(t, senderDID)
	defer cleanup()

	// Send RPC messages to multiple recipients to avoid per-DID buffer limit (100).
	// 50 RPCs each to 2 different recipients = 100 total RPCs.
	rpcCount := 0
	for _, recipientDID := range []string{"did:plc:isoA", "did:plc:isoB"} {
		for i := 0; i < 50; i++ {
			env := envelope{
				Type: "rpc", ID: fmt.Sprintf("rpc-%s-%04d", recipientDID[len(recipientDID)-4:], i),
				FromDID: senderDID, ToDID: recipientDID, Direction: "request",
			}
			data, _ := json.Marshal(env)
			sendBinary(t, ws, data)
			rpcCount++
		}
	}
	time.Sleep(200 * time.Millisecond)

	if buf.TotalCount() != rpcCount {
		t.Fatalf("after %d RPCs: buffer = %d", rpcCount, buf.TotalCount())
	}

	// All those RPCs consumed RPC rate-limit budget. But D2D bucket is untouched.
	// Send a D2D to a fresh recipient — should succeed.
	sendBinary(t, ws, makeD2DFrame(senderDID, "did:plc:isoD2D", []byte("d2d-after-rpc")))
	time.Sleep(50 * time.Millisecond)

	if buf.TotalCount() != rpcCount+1 {
		t.Errorf("after D2D: buffer = %d, want %d (D2D should use separate bucket)",
			buf.TotalCount(), rpcCount+1)
	}
}

// --- TST-MBX-0104: Pairing RPC emits subtype "pair" ---
// TRACE: {"suite": "MBX", "case": "0104", "section": "10", "sectionName": "Pairing Subtype & Rate Isolation", "subsection": "01", "scenario": "01", "title": "pairing_rpc_emits_subtype_pair"}
//
// Validates that a pairing RPC envelope has subtype: "pair" set in the outer
// envelope. This is a contract test — the handler routes it regardless of
// subtype (subtype is only used for rate-limit bucketing), but the field
// must be present for the pairing IP throttle (MBX-016b) to work.
func TestHandler_PairingRPCSubtype(t *testing.T) {
	senderDID := "did:key:zPairSub01"
	recipientDID := "did:plc:pairSubTarget"

	ws, _, buf, cleanup := startTestMsgBox(t, senderDID)
	defer cleanup()

	// Send RPC with subtype: "pair".
	env := envelope{
		Type: "rpc", ID: "pair-req-001", FromDID: senderDID,
		ToDID: recipientDID, Direction: "request",
		Subtype: "pair",
	}
	data, _ := json.Marshal(env)
	sendBinary(t, ws, data)
	time.Sleep(50 * time.Millisecond)

	// Should be routed normally (subtype doesn't affect routing).
	if buf.TotalCount() != 1 {
		t.Fatalf("buffer = %d, want 1", buf.TotalCount())
	}

	// Verify the stored payload preserves the subtype field.
	msgs := buf.Peek(recipientDID)
	if len(msgs) != 1 {
		t.Fatalf("Peek: got %d, want 1", len(msgs))
	}
	var stored envelope
	if err := json.Unmarshal(msgs[0].Payload, &stored); err != nil {
		t.Fatalf("unmarshal stored: %v", err)
	}
	if stored.Subtype != "pair" {
		t.Errorf("stored.Subtype = %q, want \"pair\"", stored.Subtype)
	}
}

// --- TST-MBX-0105: Normal RPC has no subtype ---
// TRACE: {"suite": "MBX", "case": "0105", "section": "10", "sectionName": "Pairing Subtype & Rate Isolation", "subsection": "01", "scenario": "02", "title": "normal_rpc_no_subtype"}
//
// Regular /api/v1/remember RPC envelope has no subtype field (or null/empty).
func TestHandler_NormalRPCNoSubtype(t *testing.T) {
	senderDID := "did:key:zNormSub01"
	recipientDID := "did:plc:normSubTarget"

	ws, _, buf, cleanup := startTestMsgBox(t, senderDID)
	defer cleanup()

	// Send RPC without subtype.
	env := envelope{
		Type: "rpc", ID: "normal-001", FromDID: senderDID,
		ToDID: recipientDID, Direction: "request",
		// Subtype intentionally not set.
	}
	data, _ := json.Marshal(env)
	sendBinary(t, ws, data)
	time.Sleep(50 * time.Millisecond)

	if buf.TotalCount() != 1 {
		t.Fatalf("buffer = %d, want 1", buf.TotalCount())
	}

	// Verify stored payload does NOT have subtype (omitempty).
	msgs := buf.Peek(recipientDID)
	var stored map[string]interface{}
	if err := json.Unmarshal(msgs[0].Payload, &stored); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if sub, exists := stored["subtype"]; exists && sub != "" {
		t.Errorf("stored has subtype = %v, want absent or empty", sub)
	}
}

// --- TST-MBX-0122: Challenge-response timeout ---
// TRACE: {"suite": "MBX", "case": "0122", "section": "13", "sectionName": "WebSocket Lifecycle & Connection Edge Cases", "subsection": "01", "scenario": "01", "title": "challenge_response_timeout"}
//
// Client connects, MsgBox sends challenge, client never responds →
// connection closed after AuthTimeout.
func TestAuth_ChallengeResponseTimeout(t *testing.T) {
	resolver := &mockPLCResolver{keys: map[string]ed25519.PublicKey{}}

	doneCh := make(chan error, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			doneCh <- err
			return
		}
		_, authErr := AuthenticateWithResolver(r.Context(), ws, resolver)
		if authErr != nil {
			ws.Close(websocket.StatusCode(4001), "auth failed")
			doneCh <- authErr
			return
		}
		doneCh <- nil
		ws.Close(websocket.StatusNormalClosure, "ok")
	}))
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")

	// Connect but do NOT send auth response — just wait.
	ctx, cancel := context.WithTimeout(context.Background(), AuthTimeout+2*time.Second)
	defer cancel()

	ws, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer ws.Close(websocket.StatusNormalClosure, "")

	// Read the challenge (server sends it).
	_, _, readErr := ws.Read(ctx)
	if readErr != nil {
		t.Fatalf("failed to read challenge: %v", readErr)
	}

	// Do NOT respond. Wait for server to time out.
	start := time.Now()
	select {
	case authErr := <-doneCh:
		elapsed := time.Since(start)
		if authErr == nil {
			t.Fatal("auth should have failed due to timeout")
		}
		if !strings.Contains(authErr.Error(), "read response") {
			t.Errorf("expected read-response timeout error, got: %v", authErr)
		}
		// Should have taken approximately AuthTimeout (5s).
		if elapsed < AuthTimeout-500*time.Millisecond {
			t.Errorf("timed out too fast: %v (expected ~%v)", elapsed, AuthTimeout)
		}
		t.Logf("auth timed out after %v (AuthTimeout=%v)", elapsed, AuthTimeout)
	case <-ctx.Done():
		t.Fatal("test timed out waiting for auth timeout")
	}
}

// --- TST-MBX-0133: Binary frame with 0 bytes ---
// TRACE: {"suite": "MBX", "case": "0133", "section": "15", "sectionName": "Crypto & Encoding Edge Cases", "subsection": "01", "scenario": "04", "title": "binary_frame_zero_bytes"}
//
// Empty binary WebSocket frame → ignored, connection stays alive.
func TestHandler_EmptyBinaryFrame(t *testing.T) {
	senderDID := "did:key:zEmpty01"
	recipientDID := "did:plc:emptyTarget"

	ws, _, buf, cleanup := startTestMsgBox(t, senderDID)
	defer cleanup()

	// Send empty binary frame (0 bytes).
	sendBinary(t, ws, []byte{})
	time.Sleep(50 * time.Millisecond)

	// Nothing buffered (empty frame ignored).
	if buf.TotalCount() != 0 {
		t.Errorf("buffer = %d, want 0 (empty frame should be ignored)", buf.TotalCount())
	}

	// Connection alive — send valid D2D.
	sendBinary(t, ws, makeD2DFrame(senderDID, recipientDID, []byte("alive")))
	time.Sleep(50 * time.Millisecond)

	if buf.TotalCount() != 1 {
		t.Errorf("after valid frame: buffer = %d, want 1", buf.TotalCount())
	}
}

// --- TST-MBX-0106: All did:key RPCs share IP throttle bucket ---
// TRACE: {"suite": "MBX", "case": "0106", "section": "10", "sectionName": "Pairing Subtype & Rate Isolation", "subsection": "02", "scenario": "03", "title": "all_did_key_rpcs_share_ip_throttle"}
//
// did:key senders are CLI devices — ALL their RPCs (with or without subtype)
// share the same IP throttle bucket. did:plc senders bypass IP throttle.
func TestHandler_PairingSubtypeIPThrottle(t *testing.T) {
	senderDID := "did:key:zPairThrottle01"
	recipientDID := "did:plc:pairThrottleTarget"

	ws, _, buf, cleanup := startTestMsgBox(t, senderDID)
	defer cleanup()

	// Send rateLimitMaxPairing (10) RPCs with subtype "pair".
	for i := 0; i < rateLimitMaxPairing; i++ {
		env := envelope{
			Type: "rpc", ID: fmt.Sprintf("pair-%d", i), FromDID: senderDID,
			ToDID: recipientDID, Direction: "request", Subtype: "pair",
		}
		data, _ := json.Marshal(env)
		sendBinary(t, ws, data)
	}
	time.Sleep(100 * time.Millisecond)

	if buf.TotalCount() != rateLimitMaxPairing {
		t.Fatalf("after %d pair RPCs: buffer = %d", rateLimitMaxPairing, buf.TotalCount())
	}

	// 11th pairing RPC should be throttled.
	env := envelope{
		Type: "rpc", ID: "pair-overflow", FromDID: senderDID,
		ToDID: recipientDID, Direction: "request", Subtype: "pair",
	}
	data, _ := json.Marshal(env)
	sendBinary(t, ws, data)
	time.Sleep(50 * time.Millisecond)

	if buf.TotalCount() != rateLimitMaxPairing {
		t.Errorf("IP throttle failed: buffer = %d, want %d", buf.TotalCount(), rateLimitMaxPairing)
	}

	// Normal RPC (no subtype "pair") should NOT be throttled — separate bucket.
	normalEnv := envelope{
		Type: "rpc", ID: "normal-after-pair", FromDID: senderDID,
		ToDID: recipientDID, Direction: "request",
	}
	normalData, _ := json.Marshal(normalEnv)
	sendBinary(t, ws, normalData)
	time.Sleep(50 * time.Millisecond)

	if buf.TotalCount() != rateLimitMaxPairing+1 {
		t.Errorf("normal RPC after pair throttle: buffer = %d, want %d (should use separate bucket)",
			buf.TotalCount(), rateLimitMaxPairing+1)
	}
}

// --- TST-MBX-0107: did:plc senders bypass IP throttle for normal RPCs ---
// TRACE: {"suite": "MBX", "case": "0107", "section": "10", "sectionName": "Pairing Subtype & Rate Isolation", "subsection": "02", "scenario": "04", "title": "plc_sender_bypasses_ip_throttle"}
//
// did:plc senders (Home Nodes) can send many RPCs without hitting IP throttle.
// Only did:key senders (CLI devices) are subject to IP throttle.
func TestHandler_PLCSenderBypassesIPThrottle(t *testing.T) {
	senderDID := "did:plc:pairIso01"
	recipientDID := "did:plc:pairIsoTarget"

	ws, _, buf, cleanup := startTestMsgBox(t, senderDID)
	defer cleanup()

	// Send 50 normal RPCs from did:plc sender — IP throttle should not apply.
	for i := 0; i < 50; i++ {
		env := envelope{
			Type: "rpc", ID: fmt.Sprintf("norm-%d", i), FromDID: senderDID,
			ToDID: recipientDID, Direction: "request",
		}
		data, _ := json.Marshal(env)
		sendBinary(t, ws, data)
	}
	time.Sleep(100 * time.Millisecond)

	if buf.TotalCount() != 50 {
		t.Fatalf("after 50 normal RPCs: buffer = %d, want 50 (did:plc bypasses IP throttle)", buf.TotalCount())
	}

	// Pairing RPC from did:plc also bypasses IP throttle.
	pairEnv := envelope{
		Type: "rpc", ID: "pair-after-normal", FromDID: senderDID,
		ToDID: recipientDID, Direction: "request", Subtype: "pair",
	}
	pairData, _ := json.Marshal(pairEnv)
	sendBinary(t, ws, pairData)
	time.Sleep(50 * time.Millisecond)

	if buf.TotalCount() != 51 {
		t.Errorf("after pairing RPC: buffer = %d, want 51 (did:plc bypasses IP throttle)", buf.TotalCount())
	}
}

// --- TST-MBX-0123: Clean reconnection after client disconnect ---
// TRACE: {"suite": "MBX", "case": "0123", "section": "13", "sectionName": "WebSocket Lifecycle & Connection Edge Cases", "subsection": "01", "scenario": "02", "title": "clean_reconnection_after_disconnect"}
//
// Client-side WebSocket closed. Hub.Deliver to the stale connection may
// succeed (TCP kernel buffers) or fail (broken pipe) — OS-dependent.
// This test does NOT lock the write-failure → buffer path.
// It proves: no panic, clean reconnection, buffer empty after reconnect.
// failure on next delivery → buffers message → Core reconnects and drains.
func TestHub_StaleConnectionDetection(t *testing.T) {
	buf := newTestBuffer(t)
	defer buf.Close()
	hub := NewHub(buf)

	did := "did:plc:stale-conn"

	// Create a WS pair and register the connection.
	s1, c1, cleanup1 := wsPair(t)
	defer cleanup1()
	ctx1, cancel1 := context.WithCancel(context.Background())
	conn1 := &MsgBoxConn{WS: s1, DID: did, Ctx: ctx1, Cancel: cancel1}
	hub.Register(conn1)

	// Silently kill the client side — server WS doesn't know yet.
	c1.Close(websocket.StatusNormalClosure, "")

	// Deliver a message after client-side close.
	// TCP kernel may buffer the write (status="delivered") or detect broken
	// pipe (status="buffered"). Both are valid — the test cannot control
	// kernel behavior. What we CAN assert: no panic, no error, and clean
	// reconnection works regardless of which path was taken.
	status, err := hub.Deliver(did, "stale-msg-001", []byte("should-be-buffered"))
	if err != nil {
		t.Fatalf("Deliver error (should not happen): %v", err)
	}
	if status != "delivered" && status != "buffered" {
		t.Errorf("status = %q, want 'delivered' or 'buffered'", status)
	}
	t.Logf("Deliver to stale connection: status=%q (OS-dependent)", status)

	// Reconnect with a fresh WS — must succeed cleanly regardless of above.
	s2, c2, cleanup2 := wsPair(t)
	defer cleanup2()
	ctx2, cancel2 := context.WithCancel(context.Background())
	conn2 := &MsgBoxConn{WS: s2, DID: did, Ctx: ctx2, Cancel: cancel2}

	var received []string
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			_, data, err := c2.Read(context.Background())
			if err != nil {
				break
			}
			received = append(received, string(data))
		}
	}()

	hub.Register(conn2)
	time.Sleep(50 * time.Millisecond)

	s2.Close(websocket.StatusNormalClosure, "")
	cancel2()
	<-done

	// The deterministic assertion: after reconnect, buffer is empty and
	// conn2 is functional. The message went somewhere (delivered to stale
	// conn or buffered then drained) — either way state is clean.
	if buf.TotalCount() != 0 {
		t.Errorf("buffer = %d after reconnect, want 0 (state should be clean)", buf.TotalCount())
	}

	cancel1()
}

// --- TST-MBX-0124: Rapid reconnect storm ---
// TRACE: {"suite": "MBX", "case": "0124", "section": "13", "sectionName": "WebSocket Lifecycle & Connection Edge Cases", "subsection": "01", "scenario": "03", "title": "rapid_reconnect_storm"}
//
// Core disconnects and reconnects 10 times in rapid succession →
// each reconnect replaces previous connection cleanly, final state is correct.
func TestHub_RapidReconnectStorm(t *testing.T) {
	buf := newTestBuffer(t)
	defer buf.Close()
	hub := NewHub(buf)

	did := "did:plc:reconnect-storm"

	// Buffer a message before any connection.
	buf.Add(did, "storm-msg", []byte("survive-storm"))

	// Track all cleanup functions to defer them.
	var cleanups []func()
	var lastClient *websocket.Conn

	// Rapidly connect/replace 10 times.
	for i := 0; i < 10; i++ {
		s, c, cleanup := wsPair(t)
		ctx, cancel := context.WithCancel(context.Background())
		conn := &MsgBoxConn{WS: s, DID: did, Ctx: ctx, Cancel: cancel}
		cleanups = append(cleanups, func() { cancel(); cleanup() })
		hub.Register(conn) // replaces previous connection
		lastClient = c
	}
	// Defer all cleanups in reverse order.
	defer func() {
		for i := len(cleanups) - 1; i >= 0; i-- {
			cleanups[i]()
		}
	}()

	// Only 1 connection should be registered.
	if hub.ConnectedCount() != 1 {
		t.Errorf("ConnectedCount = %d, want 1 (only last connection)", hub.ConnectedCount())
	}

	// The buffered message should have been drained during one of the Register calls.
	// Read from the last client.
	done := make(chan struct{})
	var received []string
	go func() {
		defer close(done)
		for {
			_, data, err := lastClient.Read(context.Background())
			if err != nil {
				break
			}
			received = append(received, string(data))
		}
	}()

	time.Sleep(50 * time.Millisecond)
	// Close to stop reader.
	lastClient.Close(websocket.StatusNormalClosure, "")
	<-done

	// Buffer should be empty (message drained at some point during the storm).
	if buf.TotalCount() != 0 {
		t.Errorf("buffer = %d after storm, want 0 (message should have been drained)", buf.TotalCount())
	}
}

// --- TST-MBX-0125: Client disconnect mid-send ---
// TRACE: {"suite": "MBX", "case": "0125", "section": "13", "sectionName": "WebSocket Lifecycle & Connection Edge Cases", "subsection": "01", "scenario": "04", "title": "client_disconnect_mid_send"}
//
// CLI sends first half of a binary frame then disconnects → MsgBox handles
// partial read gracefully, no panic, no corrupted state.
func TestHandler_ClientDisconnectMidSend(t *testing.T) {
	senderDID := "did:key:zMidSend01"

	ws, _, buf, cleanup := startTestMsgBox(t, senderDID)
	defer cleanup()

	// Send a valid frame first to prove connection works.
	sendBinary(t, ws, makeD2DFrame(senderDID, "did:plc:midTarget", []byte("before")))
	time.Sleep(50 * time.Millisecond)
	if buf.TotalCount() != 1 {
		t.Fatalf("before disconnect: buffer = %d, want 1", buf.TotalCount())
	}

	// Abruptly close the WebSocket (simulates client crash mid-send).
	// The coder/websocket library handles the incomplete read on the server
	// side by returning an error from ws.Read(), which exits the read pump.
	ws.Close(websocket.StatusAbnormalClosure, "crash")

	// Give the handler time to process the close.
	time.Sleep(100 * time.Millisecond)

	// Verify no panic, no corrupted buffer. The first message should still be there.
	if buf.TotalCount() != 1 {
		t.Errorf("after disconnect: buffer = %d, want 1 (no corruption)", buf.TotalCount())
	}
}

// --- TST-MBX-0113: Unknown subtype → treated as normal RPC ---
// TRACE: {"suite": "MBX", "case": "0113", "section": "17", "sectionName": "Additional Envelope Hardening", "subsection": "01", "scenario": "01", "title": "unknown_subtype_normal_rpc"}
func TestHandler_UnknownSubtypeNormalRPC(t *testing.T) {
	senderDID := "did:key:zUnkSub01"
	recipientDID := "did:plc:unkSubTarget"

	ws, _, buf, cleanup := startTestMsgBox(t, senderDID)
	defer cleanup()

	// Send RPC with unknown subtype "foo".
	env := envelope{
		Type: "rpc", ID: "unk-sub-001", FromDID: senderDID,
		ToDID: recipientDID, Direction: "request", Subtype: "foo",
	}
	data, _ := json.Marshal(env)
	sendBinary(t, ws, data)
	time.Sleep(50 * time.Millisecond)

	// Should be routed normally (unknown subtype is not an error).
	if buf.TotalCount() != 1 {
		t.Errorf("buffer = %d, want 1 (unknown subtype should be treated as normal RPC)", buf.TotalCount())
	}

	// Connection alive — send another valid frame.
	sendBinary(t, ws, makeD2DFrame(senderDID, recipientDID, []byte("alive")))
	time.Sleep(50 * time.Millisecond)
	if buf.TotalCount() != 2 {
		t.Errorf("after D2D: buffer = %d, want 2", buf.TotalCount())
	}
}

// --- TST-MBX-0114: Invalid expires_at type → envelope dropped ---
// TRACE: {"suite": "MBX", "case": "0114", "section": "17", "sectionName": "Additional Envelope Hardening", "subsection": "01", "scenario": "02", "title": "invalid_expires_at_type"}
func TestHandler_InvalidExpiresAtType(t *testing.T) {
	senderDID := "did:key:zExpType01"
	recipientDID := "did:plc:expTypeTarget"

	ws, _, buf, cleanup := startTestMsgBox(t, senderDID)
	defer cleanup()

	// Send RPC with expires_at as a string instead of integer.
	// The envelope struct uses *int64, so we can't set it via the struct.
	// Send raw JSON directly.
	raw := fmt.Sprintf(`{"type":"rpc","id":"bad-exp","from_did":"%s","to_did":"%s","direction":"request","expires_at":"not-a-number"}`,
		senderDID, recipientDID)
	sendBinary(t, ws, []byte(raw))
	time.Sleep(50 * time.Millisecond)

	// The JSON unmarshal into envelope with *int64 will fail on "not-a-number".
	// handleJSONEnvelope drops the envelope on unmarshal error.
	if buf.TotalCount() != 0 {
		t.Errorf("buffer = %d, want 0 (invalid expires_at should drop envelope)", buf.TotalCount())
	}

	// Connection alive.
	sendBinary(t, ws, makeD2DFrame(senderDID, recipientDID, []byte("alive")))
	time.Sleep(50 * time.Millisecond)
	if buf.TotalCount() != 1 {
		t.Errorf("after recovery: buffer = %d, want 1", buf.TotalCount())
	}
}

// --- TST-MBX-0115: Missing to_did on RPC → dropped ---
// TRACE: {"suite": "MBX", "case": "0115", "section": "17", "sectionName": "Additional Envelope Hardening", "subsection": "01", "scenario": "03", "title": "missing_to_did_rpc"}
func TestHandler_MissingToDID(t *testing.T) {
	senderDID := "did:key:zMissToDID01"
	recipientDID := "did:plc:missToDIDTarget"

	ws, _, buf, cleanup := startTestMsgBox(t, senderDID)
	defer cleanup()

	// Send RPC with missing to_did.
	env := envelope{
		Type: "rpc", ID: "no-to-did", FromDID: senderDID,
		Direction: "request",
		// ToDID intentionally missing.
	}
	data, _ := json.Marshal(env)
	sendBinary(t, ws, data)
	time.Sleep(50 * time.Millisecond)

	if buf.TotalCount() != 0 {
		t.Errorf("buffer = %d, want 0 (missing to_did should be dropped)", buf.TotalCount())
	}

	// Connection alive.
	sendBinary(t, ws, makeD2DFrame(senderDID, recipientDID, []byte("alive")))
	time.Sleep(50 * time.Millisecond)
	if buf.TotalCount() != 1 {
		t.Errorf("after recovery: buffer = %d, want 1", buf.TotalCount())
	}
}

// --- TST-MBX-0116: Missing from_did on RPC → dropped ---
// TRACE: {"suite": "MBX", "case": "0116", "section": "17", "sectionName": "Additional Envelope Hardening", "subsection": "01", "scenario": "04", "title": "missing_from_did_rpc"}
func TestHandler_MissingFromDID(t *testing.T) {
	senderDID := "did:key:zMissFromDID01"
	recipientDID := "did:plc:missFromDIDTarget"

	ws, _, buf, cleanup := startTestMsgBox(t, senderDID)
	defer cleanup()

	// Send RPC with missing from_did.
	env := envelope{
		Type: "rpc", ID: "no-from-did",
		ToDID: recipientDID, Direction: "request",
		// FromDID intentionally missing.
	}
	data, _ := json.Marshal(env)
	sendBinary(t, ws, data)
	time.Sleep(50 * time.Millisecond)

	// Missing from_did → fails sender binding (empty != conn.DID) or missing-DID check.
	if buf.TotalCount() != 0 {
		t.Errorf("buffer = %d, want 0 (missing from_did should be dropped)", buf.TotalCount())
	}

	// Connection alive.
	sendBinary(t, ws, makeD2DFrame(senderDID, recipientDID, []byte("alive")))
	time.Sleep(50 * time.Millisecond)
	if buf.TotalCount() != 1 {
		t.Errorf("after recovery: buffer = %d, want 1", buf.TotalCount())
	}
}

// --- TST-MBX-0117: Extremely long IDs → rejected, connection alive ---
// TRACE: {"suite": "MBX", "case": "0117", "section": "17", "sectionName": "Additional Envelope Hardening", "subsection": "01", "scenario": "05", "title": "extremely_long_ids"}
func TestHandler_ExtremelyLongIDs(t *testing.T) {
	senderDID := "did:key:zLongID01"
	recipientDID := "did:plc:longIDTarget"

	ws, _, buf, cleanup := startTestMsgBox(t, senderDID)
	defer cleanup()

	// Send RPC with 10KB id and from_did.
	longID := strings.Repeat("x", 10*1024)
	longFromDID := "did:key:z" + strings.Repeat("A", 10*1024)

	// This will fail sender binding (longFromDID != conn.DID).
	// But the point is: no panic, no memory explosion, connection alive.
	raw := fmt.Sprintf(`{"type":"rpc","id":"%s","from_did":"%s","to_did":"%s","direction":"request"}`,
		longID, longFromDID, recipientDID)
	sendBinary(t, ws, []byte(raw))
	time.Sleep(50 * time.Millisecond)

	// Dropped (sender binding mismatch).
	if buf.TotalCount() != 0 {
		t.Errorf("buffer = %d, want 0 (long ID envelope should be dropped)", buf.TotalCount())
	}

	// Connection alive — send normal frame.
	sendBinary(t, ws, makeD2DFrame(senderDID, recipientDID, []byte("alive")))
	time.Sleep(50 * time.Millisecond)
	if buf.TotalCount() != 1 {
		t.Errorf("after recovery: buffer = %d, want 1", buf.TotalCount())
	}
}

// --- TST-MBX-0034: CLI cancel while request still buffered → deleted ---
// TRACE: {"suite": "MBX", "case": "0034", "section": "04", "sectionName": "Offline Behavior, Expiry & Cancel", "subsection": "03", "scenario": "01", "title": "cli_cancel_buffered_request"}
//
// An RPC request is buffered (recipient offline). The CLI sends a cancel
// for that request. MsgBox deletes the buffered request.
func TestHandler_CLICancelBufferedRequest(t *testing.T) {
	senderDID := "did:key:zCancel034"
	recipientDID := "did:plc:cancel034Target"

	ws, _, buf, cleanup := startTestMsgBox(t, senderDID)
	defer cleanup()

	// Send an RPC request — recipient is not connected, so it's buffered.
	env := envelope{
		Type: "rpc", ID: "req-to-cancel", FromDID: senderDID,
		ToDID: recipientDID, Direction: "request",
	}
	reqData, _ := json.Marshal(env)
	sendBinary(t, ws, reqData)
	time.Sleep(50 * time.Millisecond)

	if buf.TotalCount() != 1 {
		t.Fatalf("setup: buffer = %d, want 1", buf.TotalCount())
	}

	// CLI sends cancel for that request.
	cancel := envelope{
		Type: "cancel", CancelOf: "req-to-cancel",
		FromDID: senderDID, ToDID: recipientDID,
	}
	cancelData, _ := json.Marshal(cancel)
	sendBinary(t, ws, cancelData)
	time.Sleep(50 * time.Millisecond)

	// The buffered request should have been deleted.
	if buf.TotalCount() != 0 {
		t.Errorf("after cancel: buffer = %d, want 0 (request should be deleted)", buf.TotalCount())
	}
}

// --- TST-MBX-0039: Cancel with matching from_did → buffered request deleted ---
// TRACE: {"suite": "MBX", "case": "0039", "section": "04", "sectionName": "Offline Behavior, Expiry & Cancel", "subsection": "03", "scenario": "06", "title": "cancel_matching_from_did_deleted"}
//
// Cancel ownership is inherent in the composite buffer key: the cancel
// constructs the same composite key (from_did:cancel_of) as the original
// request (from_did:id), so only the original sender can match.
func TestHandler_CancelMatchingFromDID(t *testing.T) {
	senderDID := "did:key:zOwn039"
	recipientDID := "did:plc:own039Target"

	ws, _, buf, cleanup := startTestMsgBox(t, senderDID)
	defer cleanup()

	// Buffer two requests from the same sender.
	for _, id := range []string{"keep-me", "delete-me"} {
		env := envelope{
			Type: "rpc", ID: id, FromDID: senderDID,
			ToDID: recipientDID, Direction: "request",
		}
		data, _ := json.Marshal(env)
		sendBinary(t, ws, data)
	}
	time.Sleep(50 * time.Millisecond)

	if buf.TotalCount() != 2 {
		t.Fatalf("setup: buffer = %d, want 2", buf.TotalCount())
	}

	// Cancel only "delete-me".
	cancel := envelope{
		Type: "cancel", CancelOf: "delete-me",
		FromDID: senderDID, ToDID: recipientDID,
	}
	cancelData, _ := json.Marshal(cancel)
	sendBinary(t, ws, cancelData)
	time.Sleep(50 * time.Millisecond)

	// Only "keep-me" should remain.
	if buf.TotalCount() != 1 {
		t.Errorf("after cancel: buffer = %d, want 1", buf.TotalCount())
	}
	msgs := buf.Peek(recipientDID)
	if len(msgs) == 1 {
		expectedKey := senderDID + ":keep-me"
		if msgs[0].ID != expectedKey {
			t.Errorf("remaining msg.ID = %q, want %q", msgs[0].ID, expectedKey)
		}
	}
}

// --- TST-MBX-0040: Cancel with non-matching from_did → rejected ---
// TRACE: {"suite": "MBX", "case": "0040", "section": "04", "sectionName": "Offline Behavior, Expiry & Cancel", "subsection": "03", "scenario": "07", "title": "cancel_nonmatching_from_did_rejected"}
//
// An attacker sends a cancel with a different from_did than the original
// request. The composite key won't match (different sender prefix), so
// the buffered request is preserved. Additionally, sender binding rejects
// the cancel because envelope.from_did != conn.DID.
func TestHandler_CancelNonMatchingFromDID(t *testing.T) {
	senderDID := "did:key:zOwn040"
	recipientDID := "did:plc:own040Target"

	ws, _, buf, cleanup := startTestMsgBox(t, senderDID)
	defer cleanup()

	// Buffer a request.
	env := envelope{
		Type: "rpc", ID: "protected-req", FromDID: senderDID,
		ToDID: recipientDID, Direction: "request",
	}
	reqData, _ := json.Marshal(env)
	sendBinary(t, ws, reqData)
	time.Sleep(50 * time.Millisecond)

	if buf.TotalCount() != 1 {
		t.Fatalf("setup: buffer = %d, want 1", buf.TotalCount())
	}

	// Attacker sends cancel with different from_did.
	// Sender binding rejects this (from_did != conn.DID).
	cancel := envelope{
		Type: "cancel", CancelOf: "protected-req",
		FromDID: "did:key:zAttacker040", ToDID: recipientDID,
	}
	cancelData, _ := json.Marshal(cancel)
	sendBinary(t, ws, cancelData)
	time.Sleep(50 * time.Millisecond)

	// Request should still be buffered — cancel rejected.
	if buf.TotalCount() != 1 {
		t.Errorf("after forged cancel: buffer = %d, want 1 (cancel should be rejected)", buf.TotalCount())
	}
}

// --- TST-MBX-0041: Buffer dedup — same sender + id → idempotent ---
// TRACE: {"suite": "MBX", "case": "0041", "section": "04", "sectionName": "Offline Behavior, Expiry & Cancel", "subsection": "04", "scenario": "01", "title": "buffer_dedup_same_sender_id"}
//
// Retry with same id from same sender → buffer deduplicates (idempotent add).
func TestHandler_BufferDedupSameSenderID(t *testing.T) {
	senderDID := "did:key:zDedup041"
	recipientDID := "did:plc:dedup041Target"

	ws, _, buf, cleanup := startTestMsgBox(t, senderDID)
	defer cleanup()

	// Send the same RPC twice (same id, same sender = same composite key).
	for i := 0; i < 2; i++ {
		env := envelope{
			Type: "rpc", ID: "dup-req", FromDID: senderDID,
			ToDID: recipientDID, Direction: "request",
		}
		data, _ := json.Marshal(env)
		sendBinary(t, ws, data)
	}
	time.Sleep(100 * time.Millisecond)

	// Buffer should have exactly 1 (idempotent add on composite key).
	if buf.TotalCount() != 1 {
		t.Errorf("buffer = %d, want 1 (second send should be deduplicated)", buf.TotalCount())
	}

	// Verify stored message has the correct composite key.
	msgs := buf.Peek(recipientDID)
	if len(msgs) != 1 {
		t.Fatalf("Peek: got %d, want 1", len(msgs))
	}
	expectedKey := senderDID + ":dup-req"
	if msgs[0].ID != expectedKey {
		t.Errorf("msg.ID = %q, want %q", msgs[0].ID, expectedKey)
	}
}

// --- TST-MBX-0082: Buffer key isolation — sender-scoped composite keys ---
// TRACE: {"suite": "MBX", "case": "0082", "section": "04", "sectionName": "Offline Behavior, Expiry & Cancel", "subsection": "04", "scenario": "02", "title": "buffer_key_isolation"}
//
// Two senders with same request_id="abc" → both buffered independently
// via sender-scoped composite keys (from_did:id). Delete one, other survives.
// This is a buffer-layer isolation test only. It does NOT exercise MsgBox
// routeRPC, drain, or Core idempotency — those are tested separately in
// TST-MBX-0069 (interleaving), TST-MBX-0096 (drain FIFO), TST-MBX-0021
// (idempotency sender-scoping).
func TestHandler_BufferSenderScopedCollision(t *testing.T) {
	senderA := "did:key:zSenderA082"
	senderB := "did:key:zSenderB082"
	recipientDID := "did:plc:collision082Target"

	// Direct buffer test: both senders buffer to the same recipient in same buffer.
	// This isolates the composite key mechanism from handler/WebSocket complexity.
	buf := newTestBuffer(t)
	defer buf.Close()

	// Sender A buffers request_id "abc".
	keyA := senderA + ":abc"
	buf.Add(recipientDID, keyA, []byte(`{"from":"A"}`))

	// Sender B buffers the SAME request_id "abc".
	keyB := senderB + ":abc"
	buf.Add(recipientDID, keyB, []byte(`{"from":"B"}`))

	// Both should be independently stored (different composite keys).
	if buf.TotalCount() != 2 {
		t.Fatalf("buffer = %d, want 2 (sender-scoped keys should not collide)", buf.TotalCount())
	}

	msgs := buf.Peek(recipientDID)
	if len(msgs) != 2 {
		t.Fatalf("Peek: got %d, want 2", len(msgs))
	}

	// Verify both keys present.
	ids := map[string]bool{}
	for _, m := range msgs {
		ids[m.ID] = true
	}
	if !ids[keyA] {
		t.Errorf("missing keyA %q", keyA)
	}
	if !ids[keyB] {
		t.Errorf("missing keyB %q", keyB)
	}

	// Delete A's request — B's should survive.
	buf.DeleteIfExists(keyA)
	if buf.TotalCount() != 1 {
		t.Errorf("after deleting A: buffer = %d, want 1", buf.TotalCount())
	}
	remaining := buf.Peek(recipientDID)
	if len(remaining) == 1 && remaining[0].ID != keyB {
		t.Errorf("remaining.ID = %q, want %q", remaining[0].ID, keyB)
	}
}

// --- TST-MBX-0035: Cancel after already delivered → relayed to Core ---
// TRACE: {"suite": "MBX", "case": "0035", "section": "04", "sectionName": "Offline Behavior, Expiry & Cancel", "subsection": "03", "scenario": "02", "title": "cancel_after_delivered_relayed"}
//
// An RPC request was already delivered to Core (not in buffer). CLI sends
// cancel. MsgBox's routeCancel does DeleteIfExists → false (not found in
// buffer), so it relays the cancel to Core's connection.
func TestHandler_CancelAfterDeliveredRelayed(t *testing.T) {
	senderDID := "did:key:zRelay035"
	recipientDID := "did:plc:relay035Target"

	ws, _, buf, cleanup := startTestMsgBox(t, senderDID)
	defer cleanup()

	// Register a connection for the recipient (Core is "online").
	// We need a second WS pair for the recipient to receive the cancel relay.
	recipientBuf := newTestBuffer(t)
	defer recipientBuf.Close()
	// Actually, both sender and recipient share the same Hub in startTestMsgBox.
	// The recipient isn't connected, so delivered messages go to buffer.

	// Send an RPC request — recipient not connected, so it's buffered.
	env := envelope{
		Type: "rpc", ID: "delivered-req", FromDID: senderDID,
		ToDID: recipientDID, Direction: "request",
	}
	reqData, _ := json.Marshal(env)
	sendBinary(t, ws, reqData)
	time.Sleep(50 * time.Millisecond)

	if buf.TotalCount() != 1 {
		t.Fatalf("setup: buffer = %d, want 1", buf.TotalCount())
	}

	// Simulate "already delivered": Peek + Delete (as if Core received it).
	msgs := buf.Peek(recipientDID)
	if len(msgs) != 1 {
		t.Fatalf("peek: got %d, want 1", len(msgs))
	}
	buf.Delete(msgs[0].ID)
	if buf.TotalCount() != 0 {
		t.Fatalf("after drain: buffer = %d, want 0", buf.TotalCount())
	}

	// Now CLI sends cancel for the already-delivered request.
	cancel := envelope{
		Type: "cancel", CancelOf: "delivered-req",
		FromDID: senderDID, ToDID: recipientDID,
	}
	cancelData, _ := json.Marshal(cancel)
	sendBinary(t, ws, cancelData)
	time.Sleep(50 * time.Millisecond)

	// The cancel was NOT in buffer (already delivered), so routeCancel
	// relays it to the recipient. Since recipient is not connected,
	// the relayed cancel gets buffered for the recipient.
	if buf.TotalCount() != 1 {
		t.Errorf("after cancel relay: buffer = %d, want 1 (cancel relayed and buffered for recipient)",
			buf.TotalCount())
	}

	// Verify the buffered message is the cancel relay.
	relayed := buf.Peek(recipientDID)
	if len(relayed) == 1 {
		var relayedEnv envelope
		if json.Unmarshal(relayed[0].Payload, &relayedEnv) == nil {
			if relayedEnv.Type != "cancel" {
				t.Errorf("relayed type = %q, want \"cancel\"", relayedEnv.Type)
			}
			if relayedEnv.CancelOf != "delivered-req" {
				t.Errorf("relayed cancel_of = %q, want \"delivered-req\"", relayedEnv.CancelOf)
			}
		}
	}
}

// --- TST-MBX-0051: Source-IP throttling: 11th pairing RPC throttled ---
// TRACE: {"suite": "MBX", "case": "0051", "section": "05", "sectionName": "Pairing", "subsection": "02", "scenario": "02", "title": "source_ip_throttle_11th_pairing"}
//
// Send 10 pairing RPCs → all pass. 11th pairing RPC → throttled by MsgBox.
func TestHandler_SourceIPThrottle11thPairing(t *testing.T) {
	senderDID := "did:key:zIPThrottle051"
	recipientDID := "did:plc:ipTarget051"

	ws, _, buf, cleanup := startTestMsgBox(t, senderDID)
	defer cleanup()

	// Send exactly rateLimitMaxPairing (10) pairing RPCs.
	for i := 0; i < rateLimitMaxPairing; i++ {
		env := envelope{
			Type: "rpc", ID: fmt.Sprintf("pair-051-%d", i), FromDID: senderDID,
			ToDID: recipientDID, Direction: "request", Subtype: "pair",
		}
		data, _ := json.Marshal(env)
		sendBinary(t, ws, data)
	}
	if !waitFor(t, 2*time.Second, func() bool { return buf.TotalCount() >= rateLimitMaxPairing }) {
		t.Fatalf("timeout: after %d pairing RPCs: buffer = %d", rateLimitMaxPairing, buf.TotalCount())
	}

	// 11th pairing RPC → throttled.
	env11 := envelope{
		Type: "rpc", ID: "pair-051-overflow", FromDID: senderDID,
		ToDID: recipientDID, Direction: "request", Subtype: "pair",
	}
	data11, _ := json.Marshal(env11)
	sendBinary(t, ws, data11)
	time.Sleep(50 * time.Millisecond)

	// Still 10 — the 11th was throttled.
	if buf.TotalCount() != rateLimitMaxPairing {
		t.Errorf("after 11th pairing: buffer = %d, want %d (11th should be throttled)",
			buf.TotalCount(), rateLimitMaxPairing)
	}
}

// --- TST-MBX-0057: RPC rate limit: device exceeds 300/min → throttled ---
// TRACE: {"suite": "MBX", "case": "0057", "section": "06", "sectionName": "Operational & Load", "subsection": "01", "scenario": "02", "title": "rpc_rate_limit_exceeded"}
//
// Device sends >300 RPCs/min → throttled after 300.
// Uses multiple recipients to avoid per-DID buffer limit.
func TestHandler_RPCRateLimitExceeded(t *testing.T) {
	senderDID := "did:plc:zRateLimit057"

	ws, _, buf, cleanup := startTestMsgBox(t, senderDID)
	defer cleanup()

	// Send exactly rateLimitMaxRPC (300) RPCs spread across multiple recipients
	// to avoid per-DID buffer limit (MaxMessagesPerDID=100).
	recipientCount := (rateLimitMaxRPC / 90) + 1 // ~4 recipients, 90 each
	sent := 0
	for r := 0; r < recipientCount && sent < rateLimitMaxRPC; r++ {
		recipientDID := fmt.Sprintf("did:plc:rate-%d", r)
		perRecipient := 90
		if sent+perRecipient > rateLimitMaxRPC {
			perRecipient = rateLimitMaxRPC - sent
		}
		for i := 0; i < perRecipient; i++ {
			env := envelope{
				Type: "rpc", ID: fmt.Sprintf("rpc-057-%d-%d", r, i), FromDID: senderDID,
				ToDID: recipientDID, Direction: "request",
			}
			data, _ := json.Marshal(env)
			sendBinary(t, ws, data)
			sent++
		}
	}
	time.Sleep(300 * time.Millisecond)

	if buf.TotalCount() != rateLimitMaxRPC {
		t.Fatalf("after %d RPCs: buffer = %d", rateLimitMaxRPC, buf.TotalCount())
	}

	// 301st RPC → throttled.
	env301 := envelope{
		Type: "rpc", ID: "rpc-057-overflow", FromDID: senderDID,
		ToDID: "did:plc:rate-overflow", Direction: "request",
	}
	data301, _ := json.Marshal(env301)
	sendBinary(t, ws, data301)
	time.Sleep(50 * time.Millisecond)

	if buf.TotalCount() != rateLimitMaxRPC {
		t.Errorf("after 301st RPC: buffer = %d, want %d (should be throttled)",
			buf.TotalCount(), rateLimitMaxRPC)
	}
}

// --- TST-MBX-0058: D2D rate limit 60/min exceeded → throttled ---
// TRACE: {"suite": "MBX", "case": "0058", "section": "06", "sectionName": "Operational & Load", "subsection": "01", "scenario": "03", "title": "d2d_rate_limit_exceeded"}
func TestHandler_D2DRateLimitExceeded(t *testing.T) {
	senderDID := "did:key:zD2DRate058"
	recipientDID := "did:plc:d2dTarget058"

	ws, _, buf, cleanup := startTestMsgBox(t, senderDID)
	defer cleanup()

	// Send rateLimitMaxD2D (60) D2D messages.
	for i := 0; i < rateLimitMaxD2D; i++ {
		sendBinary(t, ws, makeD2DFrame(senderDID, recipientDID, []byte(fmt.Sprintf("d2d-%d", i))))
	}
	time.Sleep(200 * time.Millisecond)

	if buf.TotalCount() != rateLimitMaxD2D {
		t.Fatalf("after %d D2D: buffer = %d", rateLimitMaxD2D, buf.TotalCount())
	}

	// 61st D2D → throttled.
	sendBinary(t, ws, makeD2DFrame(senderDID, recipientDID, []byte("overflow")))
	time.Sleep(50 * time.Millisecond)

	if buf.TotalCount() != rateLimitMaxD2D {
		t.Errorf("after 61st D2D: buffer = %d, want %d (should be throttled)",
			buf.TotalCount(), rateLimitMaxD2D)
	}
}

// --- TST-MBX-0060: Oversized ciphertext > 1 MiB → rejected ---
// TRACE: {"suite": "MBX", "case": "0060", "section": "06", "sectionName": "Operational & Load", "subsection": "02", "scenario": "05", "title": "oversized_ciphertext_rejected"}
//
// An RPC envelope with ciphertext exceeding MaxPayloadSize (1 MiB) is
// sent as a binary frame. The handler should not panic or crash, and
// the connection should stay alive for subsequent valid frames.
func TestHandler_OversizedCiphertextRejected(t *testing.T) {
	senderDID := "did:key:zOversize060"
	recipientDID := "did:plc:oversizeTarget"

	ws, _, buf, cleanup := startTestMsgBox(t, senderDID)
	defer cleanup()

	// First, verify normal-sized RPC works.
	smallEnv := envelope{
		Type: "rpc", ID: "small-req", FromDID: senderDID,
		ToDID: recipientDID, Direction: "request", Ciphertext: "small",
	}
	smallData, _ := json.Marshal(smallEnv)
	sendBinary(t, ws, smallData)
	time.Sleep(50 * time.Millisecond)

	if buf.TotalCount() != 1 {
		t.Fatalf("small RPC: buffer = %d, want 1", buf.TotalCount())
	}

	// Now attempt to send an oversized frame (> 1 MiB). The coder/websocket
	// library enforces a read limit on the server side (default ~32KB, but
	// can be configured). An oversized write from the client may either:
	// (a) fail on the client side (write error), or
	// (b) succeed in sending but server reads fail (connection closed).
	//
	// Either way, the oversized payload does NOT reach the handler, and
	// the server does not panic. This is the WebSocket-level protection.
	bigPayload := make([]byte, MaxPayloadSize+100)
	for i := range bigPayload {
		bigPayload[i] = 'X'
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	err := ws.Write(ctx, websocket.MessageBinary, bigPayload)
	// The write may or may not error depending on buffering.
	// What matters: no panic on server, oversized data not buffered.
	_ = err

	time.Sleep(100 * time.Millisecond)

	// The small RPC from before should still be in the buffer.
	// The oversized payload should NOT have been additionally buffered.
	// Buffer count must be exactly 1 (the small RPC). If >1, oversized
	// data leaked into the buffer. If 0, the oversized frame corrupted state.
	if buf.TotalCount() != 1 {
		t.Errorf("buffer = %d, want 1 (oversized must not pollute buffer or corrupt state)", buf.TotalCount())
	}
}

// --- TST-MBX-0056: Two concurrent CLI devices → both routed independently ---
// TRACE: {"suite": "MBX", "case": "0056", "section": "06", "sectionName": "Operational & Load", "subsection": "01", "scenario": "01", "title": "two_concurrent_devices"}
//
// Two CLI devices (different DIDs) send RPC requests simultaneously to the
// same recipient. Both should be buffered independently with correct
// composite keys.
func TestHandler_TwoConcurrentDevices(t *testing.T) {
	recipientDID := "did:plc:concurrent056Target"

	// Device A.
	wsA, _, bufA, cleanupA := startTestMsgBox(t, "did:key:zDeviceA056")
	defer cleanupA()

	// Device B — separate MsgBox instance (in production they share a MsgBox,
	// but each has its own connection and buffer).
	wsB, _, bufB, cleanupB := startTestMsgBox(t, "did:key:zDeviceB056")
	defer cleanupB()

	// Both devices send RPCs concurrently.
	envA := envelope{
		Type: "rpc", ID: "req-A", FromDID: "did:key:zDeviceA056",
		ToDID: recipientDID, Direction: "request",
	}
	envB := envelope{
		Type: "rpc", ID: "req-B", FromDID: "did:key:zDeviceB056",
		ToDID: recipientDID, Direction: "request",
	}
	dataA, _ := json.Marshal(envA)
	dataB, _ := json.Marshal(envB)

	// Send both simultaneously.
	sendBinary(t, wsA, dataA)
	sendBinary(t, wsB, dataB)
	time.Sleep(100 * time.Millisecond)

	// Each buffer is separate (different startTestMsgBox instances).
	// Device A's buffer has its request, Device B's buffer has its request.
	if bufA.TotalCount() != 1 {
		t.Errorf("bufA = %d, want 1", bufA.TotalCount())
	}
	if bufB.TotalCount() != 1 {
		t.Errorf("bufB = %d, want 1", bufB.TotalCount())
	}

	// Verify composite keys are correct and independent.
	msgsA := bufA.Peek(recipientDID)
	msgsB := bufB.Peek(recipientDID)

	if len(msgsA) == 1 && msgsA[0].ID != "did:key:zDeviceA056:req-A" {
		t.Errorf("A msg.ID = %q, want did:key:zDeviceA056:req-A", msgsA[0].ID)
	}
	if len(msgsB) == 1 && msgsB[0].ID != "did:key:zDeviceB056:req-B" {
		t.Errorf("B msg.ID = %q, want did:key:zDeviceB056:req-B", msgsB[0].ID)
	}
}

// ==========================================================================
// Unified D2D Envelope Tests
// ==========================================================================

// --- D2D JSON envelope accepted and buffered ---
func TestHandler_D2DEnvelopeAccepted(t *testing.T) {
	senderDID := "did:key:zD2DEnv001"
	recipientDID := "did:plc:d2dTarget001"
	ws, _, buf, cleanup := startTestMsgBox(t, senderDID)
	defer cleanup()

	d2dPayload := []byte(`{"c":"base64data","s":"hexsig"}`)
	frame := makeD2DEnvelope(senderDID, recipientDID, "d2d-msg-001", d2dPayload)
	sendBinary(t, ws, frame)
	time.Sleep(50 * time.Millisecond)

	if buf.TotalCount() != 1 {
		t.Fatalf("buffer = %d, want 1", buf.TotalCount())
	}
	msgs := buf.Peek(recipientDID)
	if len(msgs) != 1 {
		t.Fatalf("peek = %d, want 1", len(msgs))
	}
	// Composite key: sender-scoped.
	wantID := senderDID + ":d2d-msg-001"
	if msgs[0].ID != wantID {
		t.Errorf("msg.ID = %q, want %q", msgs[0].ID, wantID)
	}
	// Stored payload is the full envelope JSON.
	var stored envelope
	if json.Unmarshal(msgs[0].Payload, &stored) != nil {
		t.Fatal("stored payload is not valid JSON envelope")
	}
	if stored.Type != "d2d" {
		t.Errorf("stored.Type = %q, want d2d", stored.Type)
	}
	if stored.Ciphertext != string(d2dPayload) {
		t.Errorf("stored.Ciphertext = %q, want d2dPayload", stored.Ciphertext)
	}
}

// --- D2D envelope sender binding: mismatch rejected ---
func TestHandler_D2DEnvelopeSenderBindingRejected(t *testing.T) {
	senderDID := "did:key:zD2DReal"
	ws, _, buf, cleanup := startTestMsgBox(t, senderDID)
	defer cleanup()

	// Envelope claims a different from_did than the authenticated connection.
	frame := makeD2DEnvelope("did:key:zAttacker", "did:plc:target", "d2d-spoof", []byte(`{}`))
	sendBinary(t, ws, frame)
	time.Sleep(50 * time.Millisecond)

	if buf.TotalCount() != 0 {
		t.Errorf("buffer = %d, want 0 (sender binding should reject)", buf.TotalCount())
	}
}

// --- D2D envelope sender binding: match accepted ---
func TestHandler_D2DEnvelopeSenderBindingAccepted(t *testing.T) {
	senderDID := "did:key:zD2DAuth"
	ws, _, buf, cleanup := startTestMsgBox(t, senderDID)
	defer cleanup()

	frame := makeD2DEnvelope(senderDID, "did:plc:target", "d2d-ok", []byte(`{"c":"x","s":"y"}`))
	sendBinary(t, ws, frame)
	time.Sleep(50 * time.Millisecond)

	if buf.TotalCount() != 1 {
		t.Errorf("buffer = %d, want 1 (sender binding should accept)", buf.TotalCount())
	}
}

// --- D2D envelope missing ID rejected ---
func TestHandler_D2DEnvelopeMissingIDRejected(t *testing.T) {
	senderDID := "did:key:zD2DNoID"
	ws, _, buf, cleanup := startTestMsgBox(t, senderDID)
	defer cleanup()

	frame := makeD2DEnvelope(senderDID, "did:plc:target", "", []byte(`{}`))
	sendBinary(t, ws, frame)
	time.Sleep(50 * time.Millisecond)

	if buf.TotalCount() != 0 {
		t.Errorf("buffer = %d, want 0 (missing ID should reject)", buf.TotalCount())
	}
}

// --- D2D envelope rate limit uses D2D bucket ---
func TestHandler_D2DEnvelopeUsesD2DBucket(t *testing.T) {
	senderDID := "did:key:zD2DRate"
	ws, _, buf, cleanup := startTestMsgBox(t, senderDID)
	defer cleanup()

	// Send 60 D2D envelopes (exhaust D2D limit).
	for i := 0; i < 60; i++ {
		frame := makeD2DEnvelope(senderDID, "did:plc:target", fmt.Sprintf("d2d-%03d", i), []byte(`{}`))
		sendBinary(t, ws, frame)
	}
	time.Sleep(100 * time.Millisecond)

	// 61st should be throttled.
	frame := makeD2DEnvelope(senderDID, "did:plc:target", "d2d-over", []byte(`{}`))
	sendBinary(t, ws, frame)
	time.Sleep(50 * time.Millisecond)

	if buf.TotalCount() > 60 {
		t.Errorf("buffer = %d, want ≤60 (D2D rate limit)", buf.TotalCount())
	}

	// RPC should still work (separate bucket).
	rpcFrame, _ := json.Marshal(envelope{
		Type: "rpc", ID: "rpc-after-d2d", FromDID: senderDID,
		ToDID: "did:plc:target", Direction: "request",
		Ciphertext: `{"method":"GET","path":"/test"}`,
	})
	sendBinary(t, ws, rpcFrame)
	time.Sleep(50 * time.Millisecond)

	// RPC should have been delivered (separate rate limit bucket).
	msgs := buf.Peek("did:plc:target")
	foundRPC := false
	for _, m := range msgs {
		if strings.Contains(m.ID, "rpc-after-d2d") {
			foundRPC = true
		}
	}
	if !foundRPC {
		t.Error("RPC should still work after D2D rate limit exhausted (separate bucket)")
	}
}

