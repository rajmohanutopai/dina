package internal

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// waitForHub polls a condition until true or timeout. Same as handler_test.go.
func waitForHub(t *testing.T, timeout time.Duration, condition func() bool) bool {
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

// wsPair creates a connected WebSocket pair for Hub tests.
// Returns server-side WS, client-side WS, and cleanup function.
func wsPair(t *testing.T) (server *websocket.Conn, client *websocket.Conn, cleanup func()) {
	t.Helper()
	ch := make(chan *websocket.Conn, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		ch <- ws
		<-r.Context().Done()
	}))
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	c, _, err := websocket.Dial(context.Background(), wsURL, nil)
	if err != nil {
		srv.Close()
		t.Fatalf("wsPair dial: %v", err)
	}
	s := <-ch
	return s, c, func() {
		c.Close(websocket.StatusNormalClosure, "")
		s.Close(websocket.StatusNormalClosure, "")
		srv.Close()
	}
}

// --- TST-MBX-0086: Partial drain failure preserves tail ---
// TRACE: {"suite": "MBX", "case": "0086", "section": "08", "sectionName": "Reliability & Crash Recovery", "subsection": "01", "scenario": "01", "title": "partial_drain_failure_preserves_tail"}
//
// 5 buffered messages, message 1 sends OK, message 2 write fails →
// messages 2–5 remain buffered (delete-on-ack). Reconnect drains 2–5.
func TestHub_PartialDrainPreservesTail(t *testing.T) {
	buf := newTestBuffer(t)
	defer buf.Close()

	did := "did:plc:partial-drain"

	// Buffer 5 messages.
	for i := 0; i < 5; i++ {
		err := buf.Add(did, fmt.Sprintf("msg-%d", i), []byte(fmt.Sprintf("payload-%d", i)))
		if err != nil {
			t.Fatalf("Add msg-%d: %v", i, err)
		}
	}
	if buf.TotalCount() != 5 {
		t.Fatalf("buffered = %d, want 5", buf.TotalCount())
	}

	// Create a Hub with a WebSocket that will fail after the first message.
	// We use a fakeWriteConn that succeeds N times then fails.
	hub := NewHub(buf)

	// Create a real WS pair — the client side reads messages.
	wsCh := make(chan *websocket.Conn, 1)
	clientCh := make(chan *websocket.Conn, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		wsCh <- ws
		<-r.Context().Done()
	}))
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	clientWS, _, err := websocket.Dial(context.Background(), wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	clientCh <- clientWS
	serverWS := <-wsCh

	// Register with real WS — Hub will drain using Peek + delete-on-ack.
	// Client reads from the other end.
	connCtx, connCancel := context.WithCancel(context.Background())

	conn := &MsgBoxConn{
		WS:     serverWS,
		DID:    did,
		Ctx:    connCtx,
		Cancel: connCancel,
	}

	// Read messages on client side in background.
	var received []string
	var mu sync.Mutex
	clientDone := make(chan struct{})
	go func() {
		defer close(clientDone)
		client := <-clientCh
		for {
			_, data, err := client.Read(context.Background())
			if err != nil {
				break
			}
			mu.Lock()
			received = append(received, string(data))
			mu.Unlock()
		}
	}()

	// Register triggers drain.
	hub.Register(conn)

	// Close the connection to stop the client reader.
	serverWS.Close(websocket.StatusNormalClosure, "done")
	connCancel()
	<-clientDone

	mu.Lock()
	deliveredCount := len(received)
	mu.Unlock()

	// With delete-on-ack and a working WebSocket, all 5 should be delivered.
	// The buffer should now be empty.
	if deliveredCount != 5 {
		t.Errorf("delivered = %d, want 5", deliveredCount)
	}
	if buf.TotalCount() != 0 {
		t.Errorf("remaining buffered = %d, want 0 (all delivered)", buf.TotalCount())
	}

	// Verify FIFO order.
	mu.Lock()
	for i, msg := range received {
		expected := fmt.Sprintf("payload-%d", i)
		if msg != expected {
			t.Errorf("received[%d] = %q, want %q", i, msg, expected)
		}
	}
	mu.Unlock()

	// Now test the FAILURE case: buffer messages and close WS before drain.
	for i := 5; i < 10; i++ {
		buf.Add(did, fmt.Sprintf("msg-%d", i), []byte(fmt.Sprintf("payload-%d", i)))
	}
	if buf.TotalCount() != 5 {
		t.Fatalf("second batch buffered = %d, want 5", buf.TotalCount())
	}

	// Create a new WS pair, but close the server WS immediately to cause
	// write failures during drain.
	wsCh2 := make(chan *websocket.Conn, 1)
	srv2 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, _ := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		wsCh2 <- ws
		<-r.Context().Done()
	}))
	defer srv2.Close()

	wsURL2 := "ws" + strings.TrimPrefix(srv2.URL, "http")
	clientWS2, _, _ := websocket.Dial(context.Background(), wsURL2, nil)
	serverWS2 := <-wsCh2
	// Close the client side immediately — server writes will fail.
	clientWS2.Close(websocket.StatusNormalClosure, "force-close")

	conn2Ctx, conn2Cancel := context.WithCancel(context.Background())
	conn2 := &MsgBoxConn{
		WS:     serverWS2,
		DID:    did,
		Ctx:    conn2Ctx,
		Cancel: conn2Cancel,
	}

	// Register triggers drain — writes will fail.
	hub.Register(conn2)
	conn2Cancel()
	serverWS2.Close(websocket.StatusNormalClosure, "")

	// With delete-on-ack, messages that failed to write STAY in the buffer.
	remaining := buf.Peek(did)
	if len(remaining) == 0 {
		t.Fatal("after failed drain: buffer is empty — tail messages were lost (delete-on-ack not working)")
	}

	// The first message that failed and all subsequent must be preserved in FIFO order.
	// We don't know exactly which message failed first (depends on TCP timing),
	// but the remaining messages must be a contiguous tail of the original 5-9 sequence.
	firstRemainingIdx := -1
	for i := 5; i < 10; i++ {
		if remaining[0].ID == fmt.Sprintf("msg-%d", i) {
			firstRemainingIdx = i
			break
		}
	}
	if firstRemainingIdx == -1 {
		t.Fatalf("first remaining msg ID = %q, expected msg-5 through msg-9", remaining[0].ID)
	}

	// Verify contiguous FIFO from firstRemainingIdx to 9.
	expectedCount := 10 - firstRemainingIdx
	if len(remaining) != expectedCount {
		t.Errorf("remaining = %d, want %d (contiguous tail from msg-%d to msg-9)",
			len(remaining), expectedCount, firstRemainingIdx)
	}
	for i, m := range remaining {
		expectedID := fmt.Sprintf("msg-%d", firstRemainingIdx+i)
		if m.ID != expectedID {
			t.Errorf("remaining[%d].ID = %q, want %q (FIFO tail broken)", i, m.ID, expectedID)
		}
	}
	t.Logf("tail preserved: %d messages from msg-%d to msg-9", len(remaining), firstRemainingIdx)
}

// --- TST-MBX-0096: Large queue FIFO across partial failures ---
// TRACE: {"suite": "MBX", "case": "0096", "section": "08", "sectionName": "Reliability & Crash Recovery", "subsection": "01", "scenario": "06", "title": "large_queue_fifo_across_partial_failures"}
//
// 20 messages buffered. Verify Peek returns them in strict FIFO order and
// that delete-on-ack preserves ordering across multiple drain attempts.
func TestHub_LargeQueueFIFO(t *testing.T) {
	buf := newTestBuffer(t)
	defer buf.Close()

	did := "did:plc:fifo-test"

	// Buffer 20 messages.
	for i := 0; i < 20; i++ {
		err := buf.Add(did, fmt.Sprintf("msg-%02d", i), []byte(fmt.Sprintf("payload-%02d", i)))
		if err != nil {
			t.Fatalf("Add msg-%02d: %v", i, err)
		}
	}

	// Peek returns all 20 in FIFO.
	msgs := buf.Peek(did)
	if len(msgs) != 20 {
		t.Fatalf("Peek() = %d, want 20", len(msgs))
	}
	for i, m := range msgs {
		expected := fmt.Sprintf("msg-%02d", i)
		if m.ID != expected {
			t.Errorf("Peek[%d].ID = %q, want %q", i, m.ID, expected)
		}
	}

	// Simulate partial drain: deliver first 8, "fail" on 9.
	for i := 0; i < 8; i++ {
		buf.Delete(msgs[i].ID)
	}
	// Messages 8–19 should remain.
	remaining := buf.Peek(did)
	if len(remaining) != 12 {
		t.Fatalf("after first partial drain: %d messages, want 12", len(remaining))
	}
	for i, m := range remaining {
		expected := fmt.Sprintf("msg-%02d", i+8)
		if m.ID != expected {
			t.Errorf("remaining[%d].ID = %q, want %q (FIFO broken)", i, m.ID, expected)
		}
	}

	// Second partial drain: deliver 8–14, "fail" on 15.
	for i := 0; i < 7; i++ {
		buf.Delete(remaining[i].ID)
	}
	remaining2 := buf.Peek(did)
	if len(remaining2) != 5 {
		t.Fatalf("after second partial drain: %d messages, want 5", len(remaining2))
	}
	for i, m := range remaining2 {
		expected := fmt.Sprintf("msg-%02d", i+15)
		if m.ID != expected {
			t.Errorf("remaining2[%d].ID = %q, want %q (FIFO broken)", i, m.ID, expected)
		}
	}

	// Final drain: deliver all remaining.
	for _, m := range remaining2 {
		buf.Delete(m.ID)
	}
	if buf.TotalCount() != 0 {
		t.Errorf("after final drain: %d messages remain, want 0", buf.TotalCount())
	}
}

// --- TST-MBX-0087: Crash after WS write, before buffer delete (RPC) ---
// TRACE: {"suite": "MBX", "case": "0087", "section": "08", "sectionName": "Reliability & Crash Recovery", "subsection": "01", "scenario": "02", "title": "crash_after_write_before_delete_rpc"}
//
// Simulates the delete-on-ack failure window: message is written to WebSocket
// successfully, but the subsequent buffer Delete never runs (process crash).
// On reconnect, the message is re-delivered. For RPC, Core's idempotency
// cache absorbs the duplicate.
func TestHub_CrashAfterWriteBeforeDelete_RPC(t *testing.T) {
	buf := newTestBuffer(t)
	defer buf.Close()

	did := "did:plc:crash-rpc"
	msgID := "rpc-req-001"

	// Buffer a message.
	err := buf.Add(did, msgID, []byte(`{"type":"rpc","id":"req-001"}`))
	if err != nil {
		t.Fatal(err)
	}

	// Peek the message (simulating what Hub.Register does internally).
	msgs := buf.Peek(did)
	if len(msgs) != 1 || msgs[0].ID != msgID {
		t.Fatalf("Peek: got %d msgs, want 1 with ID %q", len(msgs), msgID)
	}

	// Simulate: WebSocket write SUCCEEDS (message delivered to Core).
	// But then the process crashes — Delete never runs.
	// We simply skip the Delete call here.

	// Message remains in buffer — this is the at-least-once guarantee.
	if buf.TotalCount() != 1 {
		t.Fatalf("after simulated crash: TotalCount = %d, want 1 (message preserved)", buf.TotalCount())
	}

	// On reconnect, Peek returns the same message again.
	msgs2 := buf.Peek(did)
	if len(msgs2) != 1 || msgs2[0].ID != msgID {
		t.Fatalf("after reconnect Peek: got %d msgs, want 1 with ID %q", len(msgs2), msgID)
	}

	// Core's idempotency cache would absorb this duplicate via (from_did, id).
	// Here we verify the buffer-level contract: the message is re-deliverable.

	// Now simulate successful delivery + Delete.
	buf.Delete(msgID)
	if buf.TotalCount() != 0 {
		t.Errorf("after successful delete: TotalCount = %d, want 0", buf.TotalCount())
	}
}

// --- TST-MBX-0088: Crash after WS write, before buffer delete (D2D) ---
// TRACE: {"suite": "MBX", "case": "0088", "section": "08", "sectionName": "Reliability & Crash Recovery", "subsection": "01", "scenario": "03", "title": "crash_after_write_before_delete_d2d"}
//
// Same failure window as 0087, but for D2D messages. The recipient-side D2D
// dedupe (via message ID check) absorbs the duplicate delivery.
func TestHub_CrashAfterWriteBeforeDelete_D2D(t *testing.T) {
	buf := newTestBuffer(t)
	defer buf.Close()

	did := "did:plc:crash-d2d"
	msgID := "d2d-sealed-001"

	// Buffer a D2D message (opaque NaCl sealed blob).
	payload := []byte("nacl-sealed-blob-opaque-data")
	err := buf.Add(did, msgID, payload)
	if err != nil {
		t.Fatal(err)
	}

	// Peek without Delete (simulating crash after write).
	msgs := buf.Peek(did)
	if len(msgs) != 1 {
		t.Fatalf("Peek: got %d, want 1", len(msgs))
	}

	// Message stays in buffer.
	if buf.TotalCount() != 1 {
		t.Fatalf("after crash: TotalCount = %d, want 1", buf.TotalCount())
	}

	// Reconnect: Peek returns same message for re-delivery.
	msgs2 := buf.Peek(did)
	if len(msgs2) != 1 || msgs2[0].ID != msgID {
		t.Fatalf("reconnect Peek: got %d msgs, want 1 with ID %q", len(msgs2), msgID)
	}
	if string(msgs2[0].Payload) != string(payload) {
		t.Errorf("payload changed after reconnect: got %q, want %q", msgs2[0].Payload, payload)
	}

	// Recipient-side D2D dedupe would absorb this. Buffer contract verified.
	buf.Delete(msgID)
	if buf.TotalCount() != 0 {
		t.Errorf("after delete: TotalCount = %d, want 0", buf.TotalCount())
	}
}

// --- TST-MBX-0091: MsgBox restart persistence (request) ---
// TRACE: {"suite": "MBX", "case": "0091", "section": "08", "sectionName": "Reliability & Crash Recovery", "subsection": "02", "scenario": "01", "title": "msgbox_restart_persistence_request"}
//
// Buffer an RPC request (Core offline), close the buffer (simulating MsgBox
// restart), reopen the same SQLite file → request survives.
func TestHub_RestartPersistence_Request(t *testing.T) {
	// Use a real file (not :memory:) so data survives close/reopen.
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "msgbox-test.db")

	buf1, err := NewBuffer(dbPath)
	if err != nil {
		t.Fatalf("NewBuffer: %v", err)
	}

	did := "did:plc:restart-request"
	msgID := "rpc-survive-restart"
	payload := []byte(`{"type":"rpc","id":"req-999","ciphertext":"..."}`)

	err = buf1.Add(did, msgID, payload)
	if err != nil {
		t.Fatalf("Add: %v", err)
	}
	if buf1.TotalCount() != 1 {
		t.Fatalf("before close: TotalCount = %d, want 1", buf1.TotalCount())
	}

	// Close buffer (simulates MsgBox process exit).
	buf1.Close()

	// Reopen (simulates MsgBox restart).
	buf2, err := NewBuffer(dbPath)
	if err != nil {
		t.Fatalf("reopen NewBuffer: %v", err)
	}
	defer buf2.Close()

	// Request should survive.
	if buf2.TotalCount() != 1 {
		t.Fatalf("after restart: TotalCount = %d, want 1 (request lost!)", buf2.TotalCount())
	}

	// Peek should return the original message intact.
	msgs := buf2.Peek(did)
	if len(msgs) != 1 {
		t.Fatalf("after restart Peek: got %d, want 1", len(msgs))
	}
	if msgs[0].ID != msgID {
		t.Errorf("msg.ID = %q, want %q", msgs[0].ID, msgID)
	}
	if string(msgs[0].Payload) != string(payload) {
		t.Errorf("msg.Payload = %q, want %q", string(msgs[0].Payload), string(payload))
	}
}

// --- TST-MBX-0092: MsgBox restart persistence (response) ---
// TRACE: {"suite": "MBX", "case": "0092", "section": "08", "sectionName": "Reliability & Crash Recovery", "subsection": "02", "scenario": "02", "title": "msgbox_restart_persistence_response"}
//
// Buffer an RPC response (CLI offline), close and reopen → response survives.
func TestHub_RestartPersistence_Response(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "msgbox-test.db")

	buf1, err := NewBuffer(dbPath)
	if err != nil {
		t.Fatalf("NewBuffer: %v", err)
	}

	// Response is buffered for the CLI's did:key (CLI is offline).
	did := "did:key:z6MkCliDevice123"
	msgID := "rpc-resp-survive"
	payload := []byte(`{"type":"rpc","id":"req-999","direction":"response","ciphertext":"..."}`)

	err = buf1.Add(did, msgID, payload)
	if err != nil {
		t.Fatalf("Add: %v", err)
	}
	buf1.Close()

	// Reopen.
	buf2, err := NewBuffer(dbPath)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer buf2.Close()

	if buf2.TotalCount() != 1 {
		t.Fatalf("after restart: TotalCount = %d, want 1", buf2.TotalCount())
	}

	msgs := buf2.Peek(did)
	if len(msgs) != 1 {
		t.Fatalf("Peek: got %d, want 1", len(msgs))
	}
	if msgs[0].ID != msgID {
		t.Errorf("ID = %q, want %q", msgs[0].ID, msgID)
	}
	if string(msgs[0].Payload) != string(payload) {
		t.Errorf("Payload mismatch")
	}
	if msgs[0].StoredAt.IsZero() {
		t.Error("StoredAt should be non-zero")
	}
}

// --- TST-MBX-0095: Connection replacement during drain ---
// TRACE: {"suite": "MBX", "case": "0095", "section": "08", "sectionName": "Reliability & Crash Recovery", "subsection": "01", "scenario": "05", "title": "connection_replacement_during_drain"}
//
// DID connects, drain starts delivering messages 1–5, second connection for
// same DID arrives mid-drain → first connection closed, remaining messages
// stay buffered → second connection drains them. No message loss, no double
// delivery.
func TestHub_ConnectionReplacementDuringDrain(t *testing.T) {
	buf := newTestBuffer(t)
	defer buf.Close()
	hub := NewHub(buf)

	did := "did:plc:conn-replace"

	// Buffer 5 messages.
	for i := 0; i < 5; i++ {
		buf.Add(did, fmt.Sprintf("msg-%d", i), []byte(fmt.Sprintf("payload-%d", i)))
	}

	// First connection: will receive some messages, then be replaced.
	s1, c1, cleanup1 := wsPair(t)
	defer cleanup1()

	ctx1, cancel1 := context.WithCancel(context.Background())
	conn1 := &MsgBoxConn{WS: s1, DID: did, Ctx: ctx1, Cancel: cancel1}

	// Read from client1 in background.
	var received1 []string
	var mu1 sync.Mutex
	done1 := make(chan struct{})
	go func() {
		defer close(done1)
		for {
			_, data, err := c1.Read(context.Background())
			if err != nil {
				break
			}
			mu1.Lock()
			received1 = append(received1, string(data))
			mu1.Unlock()
		}
	}()

	// Register conn1 — triggers drain of all 5 messages.
	hub.Register(conn1)

	// Give conn1 a moment to receive messages.
	time.Sleep(50 * time.Millisecond)

	// Second connection arrives — replaces conn1.
	s2, c2, cleanup2 := wsPair(t)
	defer cleanup2()

	ctx2, cancel2 := context.WithCancel(context.Background())
	conn2 := &MsgBoxConn{WS: s2, DID: did, Ctx: ctx2, Cancel: cancel2}

	var received2 []string
	var mu2 sync.Mutex
	done2 := make(chan struct{})
	go func() {
		defer close(done2)
		for {
			_, data, err := c2.Read(context.Background())
			if err != nil {
				break
			}
			mu2.Lock()
			received2 = append(received2, string(data))
			mu2.Unlock()
		}
	}()

	// Register conn2 — replaces conn1, drains any remaining buffered messages.
	hub.Register(conn2)

	// Give conn2 time to drain.
	time.Sleep(50 * time.Millisecond)

	// Close both to stop readers.
	s2.Close(websocket.StatusNormalClosure, "")
	cancel2()
	<-done2

	cancel1()
	<-done1

	mu1.Lock()
	count1 := len(received1)
	mu1.Unlock()
	mu2.Lock()
	count2 := len(received2)
	mu2.Unlock()

	// The invariant: total messages received across both connections = 5.
	// No message lost, no double delivery.
	total := count1 + count2
	if total != 5 {
		t.Errorf("total received = %d (conn1=%d, conn2=%d), want 5 — messages %s",
			total, count1, count2,
			func() string {
				if total < 5 {
					return "LOST"
				}
				return "DUPLICATED"
			}())
	} else {
		t.Logf("conn1 received %d, conn2 received %d (total 5 — no loss, no duplication)", count1, count2)
	}

	// Buffer should be empty.
	if buf.TotalCount() != 0 {
		t.Errorf("buffer still has %d messages after drain", buf.TotalCount())
	}

	// Verify no messages were duplicated: collect all payloads and check uniqueness.
	mu1.Lock()
	mu2.Lock()
	allPayloads := append(received1, received2...)
	mu2.Unlock()
	mu1.Unlock()

	seen := make(map[string]bool)
	for _, p := range allPayloads {
		if seen[p] {
			t.Errorf("duplicate payload: %q", p)
		}
		seen[p] = true
	}
}

// --- TST-MBX-0134: Clock skew — CLI ahead by 30s ---
// TRACE: {"suite": "MBX", "case": "0134", "section": "16", "sectionName": "Clock & Timing Edge Cases", "subsection": "01", "scenario": "01", "title": "clock_skew_cli_ahead"}
//
// CLI sets expires_at = now + 30s, but MsgBox clock is 30s behind →
// message not prematurely expired at drain.
func TestHub_ClockSkewCLIAhead(t *testing.T) {
	buf := newTestBuffer(t)
	defer buf.Close()
	hub := NewHub(buf)

	did := "did:plc:clock-ahead"

	// CLI is 30s ahead: expires_at = real_now + 30s from CLI's perspective,
	// which is real_now + 60s from MsgBox's perspective (MsgBox is 30s behind).
	// Buffer the message with expires_at 60s in the future (from real clock).
	expiresAt := time.Now().Unix() + 60
	buf.Add(did, "clock-msg-1", []byte("not-expired"), WithExpiresAt(expiresAt))

	// Register a connection — drain should deliver (not expire) this message.
	s, c, cleanup := wsPair(t)
	defer cleanup()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	conn := &MsgBoxConn{WS: s, DID: did, Ctx: ctx, Cancel: cancel}

	done := make(chan struct{})
	var received []string
	go func() {
		defer close(done)
		for {
			_, data, err := c.Read(context.Background())
			if err != nil {
				break
			}
			received = append(received, string(data))
		}
	}()

	hub.Register(conn)
	time.Sleep(50 * time.Millisecond)

	s.Close(websocket.StatusNormalClosure, "")
	cancel()
	<-done

	// Message should have been delivered (not expired).
	if len(received) != 1 {
		t.Errorf("received %d messages, want 1 (message should NOT be expired)", len(received))
	}
	if buf.TotalCount() != 0 {
		t.Errorf("buffer = %d, want 0", buf.TotalCount())
	}
}

// --- TST-MBX-0135: Clock skew — MsgBox ahead by 30s ---
// TRACE: {"suite": "MBX", "case": "0135", "section": "16", "sectionName": "Clock & Timing Edge Cases", "subsection": "01", "scenario": "02", "title": "clock_skew_msgbox_ahead"}
//
// MsgBox clock is 30s ahead → message with tight 30s expiry dropped.
// Known behavior: tight expiry + clock skew = potential drops.
func TestHub_ClockSkewMsgBoxAhead(t *testing.T) {
	buf := newTestBuffer(t)
	defer buf.Close()
	hub := NewHub(buf)

	did := "did:plc:clock-behind"

	// Message with expires_at 5s in the past (simulating MsgBox being ahead).
	expiresAt := time.Now().Unix() - 5
	buf.Add(did, "clock-msg-expired", []byte("already-expired"), WithExpiresAt(expiresAt))

	// Also add a message with NO expiry (D2D legacy) — should drain normally.
	buf.Add(did, "clock-msg-noexpiry", []byte("no-expiry"))

	s, c, cleanup := wsPair(t)
	defer cleanup()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	conn := &MsgBoxConn{WS: s, DID: did, Ctx: ctx, Cancel: cancel}

	done := make(chan struct{})
	var received []string
	go func() {
		defer close(done)
		for {
			_, data, err := c.Read(context.Background())
			if err != nil {
				break
			}
			received = append(received, string(data))
		}
	}()

	hub.Register(conn) // drain is synchronous — writes happen here

	s.Close(websocket.StatusNormalClosure, "")
	cancel()
	<-done // waits for reader goroutine to consume all frames

	// Expired message dropped. Non-expired message delivered.
	if len(received) != 1 {
		t.Errorf("received %d messages, want 1 (expired should be dropped, no-expiry delivered)", len(received))
	}
	if len(received) == 1 && received[0] != "no-expiry" {
		t.Errorf("received %q, want \"no-expiry\"", received[0])
	}
	if buf.TotalCount() != 0 {
		t.Errorf("buffer = %d, want 0 (both should be gone: one delivered, one expired-and-deleted)", buf.TotalCount())
	}
}

// --- TST-MBX-0136: expires_at already past on online delivery ---
// TRACE: {"suite": "MBX", "case": "0136", "section": "16", "sectionName": "Clock & Timing Edge Cases", "subsection": "01", "scenario": "03", "title": "expires_at_past_online_delivery"}
//
// Message sent to an online recipient but expires_at is already in the past →
// MsgBox delivers anyway (expiry only checked at buffer drain, not online
// delivery). Core catches it at receipt-time check.
func TestHub_ExpiresAtPastOnOnlineDelivery(t *testing.T) {
	buf := newTestBuffer(t)
	defer buf.Close()
	hub := NewHub(buf)

	did := "did:plc:online-expired"

	// Register a connection first (recipient is online).
	s, c, cleanup := wsPair(t)
	defer cleanup()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	conn := &MsgBoxConn{WS: s, DID: did, Ctx: ctx, Cancel: cancel}
	hub.Register(conn)

	done := make(chan struct{})
	var received []string
	go func() {
		defer close(done)
		for {
			_, data, err := c.Read(context.Background())
			if err != nil {
				break
			}
			received = append(received, string(data))
		}
	}()

	// Deliver a message whose PAYLOAD contains an expired timestamp.
	// Hub.Deliver for online recipients writes directly to WebSocket without
	// inspecting payload content (opaque). Expiry is only checked at buffer
	// drain time (offline path). This proves online delivery is unconditional.
	expiredPayload := []byte(`{"type":"rpc","expires_at":1000000,"body":"expired-but-online"}`)
	status, err := hub.Deliver(did, "past-expiry-msg", expiredPayload)
	if err != nil {
		t.Fatalf("Deliver: %v", err)
	}

	time.Sleep(50 * time.Millisecond)
	s.Close(websocket.StatusNormalClosure, "")
	cancel()
	<-done

	// Online delivery does NOT check expires_at — message was sent.
	if status != "delivered" {
		t.Errorf("status = %q, want \"delivered\" (online path doesn't check expiry)", status)
	}
	if len(received) != 1 {
		t.Errorf("received %d, want 1 (online delivery ignores expires_at)", len(received))
	}
}

// --- TST-MBX-0032: Buffered request with expires_at in the past → dropped ---
// TRACE: {"suite": "MBX", "case": "0032", "section": "04", "sectionName": "Offline Behavior, Expiry & Cancel", "subsection": "02", "scenario": "01", "title": "buffered_request_expired_on_drain"}
//
// An RPC request buffered with expires_at already in the past is dropped
// at drain time, never delivered to Core.
func TestHub_BufferedRequestExpiredOnDrain(t *testing.T) {
	buf := newTestBuffer(t)
	defer buf.Close()
	hub := NewHub(buf)

	did := "did:plc:exp-drain"

	// Buffer an expired request (expires_at 10s in the past).
	expired := time.Now().Unix() - 10
	buf.Add(did, "expired-req", []byte(`{"type":"rpc"}`), WithExpiresAt(expired))

	// Buffer a valid request (expires_at 60s in the future).
	valid := time.Now().Unix() + 60
	buf.Add(did, "valid-req", []byte(`{"type":"rpc","valid":true}`), WithExpiresAt(valid))

	// Buffer a D2D message (no expires_at — nil).
	buf.Add(did, "d2d-msg", []byte("d2d-payload"))

	if buf.TotalCount() != 3 {
		t.Fatalf("setup: buffer = %d, want 3", buf.TotalCount())
	}

	// Register a connection → drain.
	s, c, cleanup := wsPair(t)
	defer cleanup()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	conn := &MsgBoxConn{WS: s, DID: did, Ctx: ctx, Cancel: cancel}

	done := make(chan struct{})
	var received []string
	go func() {
		defer close(done)
		for {
			_, data, err := c.Read(context.Background())
			if err != nil {
				break
			}
			received = append(received, string(data))
		}
	}()

	hub.Register(conn)
	time.Sleep(50 * time.Millisecond)

	s.Close(websocket.StatusNormalClosure, "")
	cancel()
	<-done

	// Expired request dropped. Valid request + D2D message delivered.
	if len(received) != 2 {
		t.Errorf("received %d messages, want 2 (expired dropped, valid + d2d delivered)", len(received))
	}

	// Buffer empty (expired deleted, valid + d2d delivered + deleted).
	if buf.TotalCount() != 0 {
		t.Errorf("buffer = %d, want 0", buf.TotalCount())
	}

	// Verify content: valid-req and d2d-msg (in FIFO order).
	if len(received) >= 1 && !strings.Contains(received[0], "valid") {
		t.Errorf("received[0] = %q, want the valid RPC", received[0])
	}
	if len(received) >= 2 && received[1] != "d2d-payload" {
		t.Errorf("received[1] = %q, want \"d2d-payload\"", received[1])
	}
}

// --- TST-MBX-0033: Buffered request with expires_at in the future → delivered ---
// TRACE: {"suite": "MBX", "case": "0033", "section": "04", "sectionName": "Offline Behavior, Expiry & Cancel", "subsection": "02", "scenario": "02", "title": "buffered_request_future_expiry_delivered"}
func TestHub_BufferedRequestFutureExpiryDelivered(t *testing.T) {
	buf := newTestBuffer(t)
	defer buf.Close()
	hub := NewHub(buf)

	did := "did:plc:future-exp"

	// Buffer a request with expires_at 60s in the future.
	future := time.Now().Unix() + 60
	buf.Add(did, "future-req", []byte(`{"valid":"rpc"}`), WithExpiresAt(future))

	if buf.TotalCount() != 1 {
		t.Fatalf("setup: buffer = %d, want 1", buf.TotalCount())
	}

	s, c, cleanup := wsPair(t)
	defer cleanup()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	conn := &MsgBoxConn{WS: s, DID: did, Ctx: ctx, Cancel: cancel}

	done := make(chan struct{})
	var received []string
	go func() {
		defer close(done)
		for {
			_, data, err := c.Read(context.Background())
			if err != nil {
				break
			}
			received = append(received, string(data))
		}
	}()

	hub.Register(conn)
	time.Sleep(50 * time.Millisecond)

	s.Close(websocket.StatusNormalClosure, "")
	cancel()
	<-done

	if len(received) != 1 {
		t.Errorf("received %d, want 1 (future expiry → should be delivered)", len(received))
	}
	if len(received) == 1 && received[0] != `{"valid":"rpc"}` {
		t.Errorf("received[0] = %q, want the valid RPC payload", received[0])
	}
	if buf.TotalCount() != 0 {
		t.Errorf("buffer = %d, want 0", buf.TotalCount())
	}
}

// --- TST-MBX-0036: Interactive read with 30s expiry + Core offline for 60s ---
// TRACE: {"suite": "MBX", "case": "0036", "section": "04", "sectionName": "Offline Behavior, Expiry & Cancel", "subsection": "02", "scenario": "05", "title": "interactive_read_expired_offline"}
//
// An /api/v1/ask request with 30s expiry is buffered (Core offline).
// Core reconnects after 60s. The request is expired and dropped, never
// delivered to Core.
func TestHub_InteractiveReadExpiredOffline(t *testing.T) {
	buf := newTestBuffer(t)
	defer buf.Close()
	hub := NewHub(buf)

	did := "did:plc:ask-expired"

	// Simulate: CLI sent /ask with 30s expiry, but Core is offline.
	// We buffer with expires_at = now - 30s (simulating 60s delay).
	expired := time.Now().Unix() - 30
	buf.Add(did, "ask-req-001", []byte(`{"type":"rpc","path":"/api/v1/ask"}`), WithExpiresAt(expired))

	if buf.TotalCount() != 1 {
		t.Fatalf("setup: buffer = %d, want 1", buf.TotalCount())
	}

	// "Core reconnects" — register a connection. Drain should drop the expired request.
	s, c, cleanup := wsPair(t)
	defer cleanup()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	conn := &MsgBoxConn{WS: s, DID: did, Ctx: ctx, Cancel: cancel}

	done := make(chan struct{})
	var received []string
	go func() {
		defer close(done)
		for {
			_, data, err := c.Read(context.Background())
			if err != nil {
				break
			}
			received = append(received, string(data))
		}
	}()

	hub.Register(conn)
	time.Sleep(50 * time.Millisecond)

	s.Close(websocket.StatusNormalClosure, "")
	cancel()
	<-done

	// Expired request should NOT have been delivered.
	if len(received) != 0 {
		t.Errorf("received %d messages, want 0 (expired request should be dropped)", len(received))
	}
	// Buffer should be empty (expired → deleted).
	if buf.TotalCount() != 0 {
		t.Errorf("buffer = %d, want 0 (expired request deleted)", buf.TotalCount())
	}
}

// --- TST-MBX-0025: Core offline → request buffered in Dead Drop ---
// TRACE: {"suite": "MBX", "case": "0025", "section": "04", "sectionName": "Offline Behavior, Expiry & Cancel", "subsection": "01", "scenario": "01", "title": "core_offline_request_buffered"}
//
// No connection registered for the recipient DID → Hub.Deliver buffers the
// message in the Dead Drop. This is the fundamental offline behavior.
func TestHub_CoreOfflineRequestBuffered(t *testing.T) {
	buf := newTestBuffer(t)
	defer buf.Close()
	hub := NewHub(buf)

	recipientDID := "did:plc:offline-core"

	// No connection registered for this DID — Core is "offline".
	status, err := hub.Deliver(recipientDID, "rpc-offline-001", []byte(`{"type":"rpc"}`))
	if err != nil {
		t.Fatalf("Deliver error: %v", err)
	}
	if status != "buffered" {
		t.Errorf("status = %q, want \"buffered\" (Core offline)", status)
	}
	if buf.TotalCount() != 1 {
		t.Errorf("buffer = %d, want 1", buf.TotalCount())
	}

	// Deliver a second message — also buffered.
	status2, err2 := hub.Deliver(recipientDID, "rpc-offline-002", []byte(`{"type":"rpc","id":"002"}`))
	if err2 != nil {
		t.Fatalf("Deliver 2 error: %v", err2)
	}
	if status2 != "buffered" {
		t.Errorf("status2 = %q, want \"buffered\"", status2)
	}
	if buf.TotalCount() != 2 {
		t.Errorf("buffer = %d, want 2", buf.TotalCount())
	}

	// Messages survive in buffer until Core reconnects.
	msgs := buf.Peek(recipientDID)
	if len(msgs) != 2 {
		t.Fatalf("Peek: got %d, want 2", len(msgs))
	}
	if msgs[0].ID != "rpc-offline-001" || msgs[1].ID != "rpc-offline-002" {
		t.Errorf("wrong IDs: [%q, %q]", msgs[0].ID, msgs[1].ID)
	}
}

// --- TST-MBX-0029: Drain order — multiple buffered responses in FIFO ---
// TRACE: {"suite": "MBX", "case": "0029", "section": "04", "sectionName": "Offline Behavior, Expiry & Cancel", "subsection": "01", "scenario": "05", "title": "drain_fifo_order"}
//
// Multiple messages buffered for a DID. On reconnect, drain delivers them
// in strict FIFO order (ordered by stored_at).
func TestHub_DrainFIFOOrder(t *testing.T) {
	buf := newTestBuffer(t)
	defer buf.Close()
	hub := NewHub(buf)

	did := "did:plc:fifo-029"

	// Buffer 10 messages in order.
	for i := 0; i < 10; i++ {
		buf.Add(did, fmt.Sprintf("msg-%02d", i), []byte(fmt.Sprintf("payload-%02d", i)))
	}

	// Register → drain.
	s, c, cleanup := wsPair(t)
	defer cleanup()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	conn := &MsgBoxConn{WS: s, DID: did, Ctx: ctx, Cancel: cancel}

	done := make(chan struct{})
	var received []string
	go func() {
		defer close(done)
		for {
			_, data, err := c.Read(context.Background())
			if err != nil {
				break
			}
			received = append(received, string(data))
		}
	}()

	hub.Register(conn)
	time.Sleep(50 * time.Millisecond)

	s.Close(websocket.StatusNormalClosure, "")
	cancel()
	<-done

	if len(received) != 10 {
		t.Fatalf("received %d, want 10", len(received))
	}

	// Strict FIFO order.
	for i, msg := range received {
		expected := fmt.Sprintf("payload-%02d", i)
		if msg != expected {
			t.Errorf("received[%d] = %q, want %q (FIFO broken)", i, msg, expected)
		}
	}
}

// --- TST-MBX-0083: Response-side expiry ---
// TRACE: {"suite": "MBX", "case": "0083", "section": "04", "sectionName": "Offline Behavior, Expiry & Cancel", "subsection": "02", "scenario": "08", "title": "response_side_expiry"}
//
// Core sends an RPC response with expires_at (2min default). CLI is offline
// for >2min. On CLI reconnect, MsgBox drops the expired response. CLI would
// retry with same request_id → Core returns cached response from idempotency.
// This test validates the MsgBox-side: expired response is dropped on drain.
func TestHub_ResponseSideExpiry(t *testing.T) {
	buf := newTestBuffer(t)
	defer buf.Close()
	hub := NewHub(buf)

	cliDID := "did:key:zCLIOffline083"

	// Core sent a response 3 minutes ago with 2-minute expiry.
	// expires_at = now - 60s (expired 60s ago).
	expired := time.Now().Unix() - 60
	buf.Add(cliDID, "resp-expired",
		[]byte(`{"type":"rpc","direction":"response","id":"req-001"}`),
		WithExpiresAt(expired))

	// Core also sent a fresh response with future expiry.
	future := time.Now().Unix() + 120
	buf.Add(cliDID, "resp-fresh",
		[]byte(`{"type":"rpc","direction":"response","id":"req-002"}`),
		WithExpiresAt(future))

	if buf.TotalCount() != 2 {
		t.Fatalf("setup: buffer = %d, want 2", buf.TotalCount())
	}

	// CLI reconnects.
	s, c, cleanup := wsPair(t)
	defer cleanup()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	conn := &MsgBoxConn{WS: s, DID: cliDID, Ctx: ctx, Cancel: cancel}

	done := make(chan struct{})
	var received []string
	go func() {
		defer close(done)
		for {
			_, data, err := c.Read(context.Background())
			if err != nil {
				break
			}
			received = append(received, string(data))
		}
	}()

	hub.Register(conn)
	time.Sleep(50 * time.Millisecond)

	s.Close(websocket.StatusNormalClosure, "")
	cancel()
	<-done

	// Only the fresh response should have been delivered.
	if len(received) != 1 {
		t.Errorf("received %d, want 1 (expired response dropped, fresh delivered)", len(received))
	}
	if len(received) == 1 && !strings.Contains(received[0], "req-002") {
		t.Errorf("received %q, want the fresh response (req-002)", received[0])
	}
	if buf.TotalCount() != 0 {
		t.Errorf("buffer = %d, want 0", buf.TotalCount())
	}
}

// --- TST-MBX-0027: CLI disconnects before response → response buffered ---
// TRACE: {"suite": "MBX", "case": "0027", "section": "04", "sectionName": "Offline Behavior, Expiry & Cancel", "subsection": "01", "scenario": "03", "title": "cli_disconnect_response_buffered"}
func TestHub_CLIDisconnectResponseBuffered(t *testing.T) {
	buf := newTestBuffer(t)
	defer buf.Close()
	hub := NewHub(buf)

	cliDID := "did:key:zCLI027"

	// CLI is NOT connected. Core sends a response → should be buffered.
	status, err := hub.Deliver(cliDID, "resp-001",
		[]byte(`{"type":"rpc","direction":"response","id":"req-001","status":200}`))
	if err != nil {
		t.Fatalf("Deliver: %v", err)
	}
	if status != "buffered" {
		t.Errorf("status = %q, want \"buffered\" (CLI disconnected)", status)
	}
	if buf.TotalCount() != 1 {
		t.Fatalf("buffer = %d, want 1", buf.TotalCount())
	}

	// CLI reconnects → drain delivers the response.
	s, c, cleanup := wsPair(t)
	defer cleanup()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	conn := &MsgBoxConn{WS: s, DID: cliDID, Ctx: ctx, Cancel: cancel}

	done := make(chan struct{})
	var received []string
	go func() {
		defer close(done)
		for {
			_, data, err := c.Read(context.Background())
			if err != nil {
				break
			}
			received = append(received, string(data))
		}
	}()

	hub.Register(conn)
	time.Sleep(50 * time.Millisecond)
	s.Close(websocket.StatusNormalClosure, "")
	cancel()
	<-done

	if len(received) != 1 {
		t.Fatalf("received %d, want 1", len(received))
	}
	if !strings.Contains(received[0], "req-001") {
		t.Errorf("received %q, want response containing req-001", received[0])
	}
	if buf.TotalCount() != 0 {
		t.Errorf("buffer = %d, want 0 (drained)", buf.TotalCount())
	}
}

// --- TST-MBX-0030: Expired buffered response (Dead Drop TTL) ---
// TRACE: {"suite": "MBX", "case": "0030", "section": "04", "sectionName": "Offline Behavior, Expiry & Cancel", "subsection": "01", "scenario": "06", "title": "expired_dead_drop_ttl"}
func TestHub_ExpiredDeadDropTTL(t *testing.T) {
	buf := newTestBuffer(t)
	defer buf.Close()

	did := "did:key:zTTL030"

	// Buffer a message with stored_at 25h ago (beyond 24h MessageTTL).
	// Use direct SQL since Add() uses time.Now() for stored_at.
	_, err := buf.db.Exec(
		"INSERT INTO messages (id, recipient, payload, size, stored_at, sender, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		"ttl-expired-msg", did, []byte("old-payload"), 11,
		time.Now().Add(-25*time.Hour).Unix(),
		"", nil,
	)
	if err != nil {
		t.Fatalf("manual insert: %v", err)
	}

	// Also buffer a fresh message via normal Add.
	buf.Add(did, "ttl-fresh-msg", []byte("fresh-payload"))

	if buf.TotalCount() != 2 {
		t.Fatalf("setup: buffer = %d, want 2", buf.TotalCount())
	}

	// Run TTL expiration.
	expired := buf.ExpireTTL()
	if expired != 1 {
		t.Errorf("ExpireTTL removed %d, want 1", expired)
	}
	if buf.TotalCount() != 1 {
		t.Errorf("after TTL: buffer = %d, want 1", buf.TotalCount())
	}

	msgs := buf.Peek(did)
	if len(msgs) != 1 || msgs[0].ID != "ttl-fresh-msg" {
		t.Errorf("surviving msg = %v, want ttl-fresh-msg", msgs)
	}
}

// --- TST-MBX-0026: Core reconnects → buffered request with valid expires_at drained ---
// TRACE: {"suite": "MBX", "case": "0026", "section": "04", "sectionName": "Offline Behavior, Expiry & Cancel", "subsection": "01", "scenario": "02", "title": "core_reconnect_drain_valid_expiry"}
//
// An RPC request with future expires_at is buffered (Core offline). Core
// reconnects → Hub drains the request → delivered to Core's connection.
func TestHub_CoreReconnectDrainValidExpiry(t *testing.T) {
	buf := newTestBuffer(t)
	defer buf.Close()
	hub := NewHub(buf)

	did := "did:plc:reconnect026"

	// Buffer a request with future expiry.
	future := time.Now().Unix() + 300 // 5 min from now
	buf.Add(did, "rpc-valid-026", []byte(`{"type":"rpc","id":"req-026"}`),
		WithExpiresAt(future), WithSender("did:key:zCLI026"))

	if buf.TotalCount() != 1 {
		t.Fatalf("setup: buffer = %d, want 1", buf.TotalCount())
	}

	// Core reconnects.
	s, c, cleanup := wsPair(t)
	defer cleanup()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	conn := &MsgBoxConn{WS: s, DID: did, Ctx: ctx, Cancel: cancel}

	done := make(chan struct{})
	var received []string
	go func() {
		defer close(done)
		for {
			_, data, err := c.Read(context.Background())
			if err != nil {
				break
			}
			received = append(received, string(data))
		}
	}()

	hub.Register(conn)
	time.Sleep(50 * time.Millisecond)
	s.Close(websocket.StatusNormalClosure, "")
	cancel()
	<-done

	// Request should have been delivered (not expired).
	if len(received) != 1 {
		t.Fatalf("received %d, want 1", len(received))
	}
	if !strings.Contains(received[0], "req-026") {
		t.Errorf("received %q, want request containing req-026", received[0])
	}
	if buf.TotalCount() != 0 {
		t.Errorf("buffer = %d, want 0 (drained)", buf.TotalCount())
	}
}

// --- TST-MBX-0042: Store-before-send from MsgBox buffer perspective ---
// TRACE: {"suite": "MBX", "case": "0042", "section": "04", "sectionName": "Offline Behavior, Expiry & Cancel", "subsection": "05", "scenario": "01", "title": "store_before_send_buffer_perspective"}
//
// Core receives RPC via drain, processes it, stores response in idempotency
// cache (store-before-send). Then "crashes" before WebSocket send of the
// response. The response for the CLI was meant to go to CLI's did:key buffer,
// but the crash means the response never got buffered.
//
// From MsgBox buffer's perspective: the original request was drained and
// deleted (delete-on-ack). If the CLI retries with the same request_id,
// Core's idempotency cache returns the cached response. The buffer-level
// contract is: once drained (Peek + Delete), the request is gone from
// the buffer. Re-delivery comes from the idempotency cache, not the buffer.
func TestHub_StoreBeforeSendBufferPerspective(t *testing.T) {
	buf := newTestBuffer(t)
	defer buf.Close()
	hub := NewHub(buf)

	did := "did:plc:sbs042"

	// Buffer a request.
	buf.Add(did, "sbs-req-001", []byte(`{"type":"rpc","id":"sbs-001"}`))

	// Core "reconnects" → drain delivers the request.
	s, c, cleanup := wsPair(t)
	defer cleanup()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	conn := &MsgBoxConn{WS: s, DID: did, Ctx: ctx, Cancel: cancel}

	done := make(chan struct{})
	var received []string
	go func() {
		defer close(done)
		for {
			_, data, err := c.Read(context.Background())
			if err != nil {
				break
			}
			received = append(received, string(data))
		}
	}()

	hub.Register(conn)
	time.Sleep(50 * time.Millisecond)
	s.Close(websocket.StatusNormalClosure, "")
	cancel()
	<-done

	// Request was drained.
	if len(received) != 1 {
		t.Fatalf("received %d, want 1", len(received))
	}

	// Buffer is empty — the request was delete-on-ack'd.
	if buf.TotalCount() != 0 {
		t.Fatalf("buffer = %d, want 0 (drained)", buf.TotalCount())
	}

	// "Core processes and stores in idempotency cache, then crashes
	// before sending response to CLI." From the buffer's perspective,
	// the original request is GONE. If CLI retries, the request is NOT
	// in the buffer — Core's idempotency cache handles it.
	//
	// Verify: Peek returns nothing for this DID.
	if msgs := buf.Peek(did); len(msgs) != 0 {
		t.Errorf("Peek after drain+crash: got %d messages, want 0", len(msgs))
	}
}
