package internal

import (
	"fmt"
	"sync"
	"testing"
)

// newTestBuffer creates an in-memory buffer for testing.
// Caller should defer buf.Close().
func newTestBuffer(t *testing.T) *Buffer {
	t.Helper()
	buf, err := NewBuffer(":memory:")
	if err != nil {
		t.Fatalf("NewBuffer(:memory:) failed: %v", err)
	}
	return buf
}

// --- TST-MBX-0101: DeleteIfExists: found → true ---
// TRACE: {"suite": "MBX", "case": "0101", "section": "09", "sectionName": "Backward Compatibility & Migration", "subsection": "03", "scenario": "01", "title": "delete_if_exists_found_true"}
func TestDeleteIfExists_Found(t *testing.T) {
	buf := newTestBuffer(t)
	defer buf.Close()

	// Insert a message.
	err := buf.Add("did:key:recipient", "msg-001", []byte("hello"))
	if err != nil {
		t.Fatalf("Add() failed: %v", err)
	}

	// Verify it exists.
	if buf.TotalCount() != 1 {
		t.Fatalf("expected 1 message, got %d", buf.TotalCount())
	}

	// DeleteIfExists should return true for an existing message.
	found := buf.DeleteIfExists("msg-001")
	if !found {
		t.Errorf("DeleteIfExists(\"msg-001\") = false, want true")
	}

	// Message should be gone.
	if buf.TotalCount() != 0 {
		t.Errorf("expected 0 messages after delete, got %d", buf.TotalCount())
	}
}

// --- TST-MBX-0102: DeleteIfExists: not found → false ---
// TRACE: {"suite": "MBX", "case": "0102", "section": "09", "sectionName": "Backward Compatibility & Migration", "subsection": "03", "scenario": "02", "title": "delete_if_exists_not_found_false"}
func TestDeleteIfExists_NotFound(t *testing.T) {
	buf := newTestBuffer(t)
	defer buf.Close()

	// DeleteIfExists on a nonexistent ID should return false.
	found := buf.DeleteIfExists("nonexistent-msg")
	if found {
		t.Errorf("DeleteIfExists(\"nonexistent-msg\") = true, want false")
	}
}

// --- TST-MBX-0103: DeleteIfExists: repeated delete → false ---
// TRACE: {"suite": "MBX", "case": "0103", "section": "09", "sectionName": "Backward Compatibility & Migration", "subsection": "03", "scenario": "03", "title": "delete_if_exists_repeated_false"}
func TestDeleteIfExists_Repeated(t *testing.T) {
	buf := newTestBuffer(t)
	defer buf.Close()

	// Insert a message.
	err := buf.Add("did:key:recipient", "msg-002", []byte("world"))
	if err != nil {
		t.Fatalf("Add() failed: %v", err)
	}

	// First delete: should return true.
	first := buf.DeleteIfExists("msg-002")
	if !first {
		t.Fatalf("first DeleteIfExists = false, want true")
	}

	// Second delete of the same ID: should return false.
	second := buf.DeleteIfExists("msg-002")
	if second {
		t.Errorf("second DeleteIfExists = true, want false (already deleted)")
	}
}

// --- TST-MBX-0097: Legacy D2D Hub→Buffer contract (offline path) ---
// TRACE: {"suite": "MBX", "case": "0097", "section": "09", "sectionName": "Backward Compatibility & Migration", "subsection": "01", "scenario": "01", "title": "legacy_d2d_hub_buffer_contract"}
//
// Validates Hub.Deliver buffers correctly for an unconnected recipient.
// This is the offline delivery path (no WebSocket connection registered).
// Online WebSocket delivery requires integration tests with real connections.
// This unit test validates the Hub→Buffer contract baseline.
// When MBX-065 lands, update this test to pass ("", nil) for the new params.
func TestLegacyD2D_HubBufferContract(t *testing.T) {
	buf := newTestBuffer(t)
	defer buf.Close()
	hub := NewHub(buf)

	// We cannot create a real WebSocket in a unit test, so we verify the
	// offline path. For online delivery we'd need a test WebSocket server.
	// This test validates that Deliver() for an unknown DID (no connection
	// registered) correctly buffers the message — which is the offline
	// path that must remain unchanged after signature expansion.
	//
	// The online delivery path (registered connection, WebSocket write)
	// is covered by integration tests. Here we verify the Hub/Buffer
	// contract for D2D messages with the current API surface.

	status, err := hub.Deliver("did:plc:unknown-node", "d2d-msg-001", []byte("encrypted-blob"))
	if err != nil {
		t.Fatalf("Deliver() error: %v", err)
	}
	if status != "buffered" {
		t.Errorf("Deliver() status = %q, want \"buffered\" (recipient not connected)", status)
	}

	// Verify message is in the buffer.
	if hub.BufferedCount() != 1 {
		t.Errorf("BufferedCount() = %d, want 1", hub.BufferedCount())
	}

	// Drain and verify content.
	msgs := buf.Drain("did:plc:unknown-node")
	if len(msgs) != 1 {
		t.Fatalf("Drain() returned %d messages, want 1", len(msgs))
	}
	if msgs[0].ID != "d2d-msg-001" {
		t.Errorf("msg.ID = %q, want \"d2d-msg-001\"", msgs[0].ID)
	}
	if string(msgs[0].Payload) != "encrypted-blob" {
		t.Errorf("msg.Payload = %q, want \"encrypted-blob\"", string(msgs[0].Payload))
	}
}

// --- TST-MBX-0098: Legacy D2D offline buffering ---
// TRACE: {"suite": "MBX", "case": "0098", "section": "09", "sectionName": "Backward Compatibility & Migration", "subsection": "01", "scenario": "02", "title": "legacy_d2d_offline_buffering"}
//
// D2D message buffered with current Add() (no sender, no expires_at columns
// yet) must store correctly. When schema migration (MBX-009) adds sender and
// expires_at columns, old rows get sender="" and expires_at=NULL via ALTER
// TABLE defaults. This test validates the pre-migration baseline.
func TestLegacyD2D_OfflineBuffering(t *testing.T) {
	buf := newTestBuffer(t)
	defer buf.Close()

	// Buffer multiple D2D messages for the same recipient.
	for i := 0; i < 5; i++ {
		msgID := fmt.Sprintf("d2d-%03d", i)
		payload := []byte(fmt.Sprintf("payload-%03d", i))
		err := buf.Add("did:plc:offline-node", msgID, payload)
		if err != nil {
			t.Fatalf("Add(%q) failed: %v", msgID, err)
		}
	}

	// All 5 should be buffered.
	if buf.TotalCount() != 5 {
		t.Fatalf("TotalCount() = %d, want 5", buf.TotalCount())
	}

	// Drain should return all 5 in FIFO order.
	msgs := buf.Drain("did:plc:offline-node")
	if len(msgs) != 5 {
		t.Fatalf("Drain() returned %d, want 5", len(msgs))
	}
	for i, m := range msgs {
		expectedID := fmt.Sprintf("d2d-%03d", i)
		if m.ID != expectedID {
			t.Errorf("msgs[%d].ID = %q, want %q", i, m.ID, expectedID)
		}
		expectedPayload := fmt.Sprintf("payload-%03d", i)
		if string(m.Payload) != expectedPayload {
			t.Errorf("msgs[%d].Payload = %q, want %q", i, string(m.Payload), expectedPayload)
		}
	}

	// After drain, buffer should be empty.
	if buf.TotalCount() != 0 {
		t.Errorf("TotalCount() after drain = %d, want 0", buf.TotalCount())
	}

	// Idempotent Add: re-adding a drained message should succeed (no conflict).
	err := buf.Add("did:plc:offline-node", "d2d-new", []byte("new-msg"))
	if err != nil {
		t.Errorf("Add() after drain failed: %v", err)
	}
	if buf.TotalCount() != 1 {
		t.Errorf("TotalCount() after re-add = %d, want 1", buf.TotalCount())
	}
}

// --- TST-MBX-0099: Legacy D2D drain ---
// TRACE: {"suite": "MBX", "case": "0099", "section": "09", "sectionName": "Backward Compatibility & Migration", "subsection": "01", "scenario": "03", "title": "legacy_d2d_drain"}
//
// Buffered D2D message with sender="" and expires_at=NULL → drained normally,
// no expiry check (NULL = no expiry). After schema migration (MBX-009) adds
// the new columns, old rows must still drain correctly via Hub.Register.
func TestLegacyD2D_Drain(t *testing.T) {
	buf := newTestBuffer(t)
	defer buf.Close()

	// Buffer 3 messages.
	for i := 0; i < 3; i++ {
		err := buf.Add("did:plc:drain-test", fmt.Sprintf("msg-%d", i), []byte(fmt.Sprintf("data-%d", i)))
		if err != nil {
			t.Fatalf("Add() failed: %v", err)
		}
	}

	// Drain returns all messages in FIFO order.
	msgs := buf.Drain("did:plc:drain-test")
	if len(msgs) != 3 {
		t.Fatalf("Drain() returned %d, want 3", len(msgs))
	}
	for i, m := range msgs {
		wantID := fmt.Sprintf("msg-%d", i)
		if m.ID != wantID {
			t.Errorf("msgs[%d].ID = %q, want %q", i, m.ID, wantID)
		}
		wantPayload := fmt.Sprintf("data-%d", i)
		if string(m.Payload) != wantPayload {
			t.Errorf("msgs[%d].Payload = %q, want %q", i, string(m.Payload), wantPayload)
		}
		if m.StoredAt.IsZero() {
			t.Errorf("msgs[%d].StoredAt is zero, want a real timestamp", i)
		}
	}

	// After drain, buffer is empty.
	if buf.TotalCount() != 0 {
		t.Errorf("TotalCount() after drain = %d, want 0", buf.TotalCount())
	}

	// Drain on empty DID returns nil (no panic, no error).
	empty := buf.Drain("did:plc:drain-test")
	if len(empty) != 0 {
		t.Errorf("second Drain() returned %d, want 0", len(empty))
	}
}

// --- TST-MBX-0100: Buffer migration — existing rows with no sender column ---
// TRACE: {"suite": "MBX", "case": "0100", "section": "09", "sectionName": "Backward Compatibility & Migration", "subsection": "02", "scenario": "01", "title": "buffer_migration_existing_rows"}
//
// Simulate pre-migration buffer rows. The current schema has no sender or
// expires_at columns. When MBX-009 adds them via ALTER TABLE with defaults,
// old rows get sender="" and expires_at=NULL. This test validates that the
// current schema can store and drain messages correctly, establishing the
// baseline that must survive migration.
func TestBufferMigration_ExistingRows(t *testing.T) {
	buf := newTestBuffer(t)
	defer buf.Close()

	// Insert messages using the current Add() — no sender/expires_at columns.
	err := buf.Add("did:plc:pre-migration", "old-msg-1", []byte("old-payload-1"))
	if err != nil {
		t.Fatalf("Add old-msg-1: %v", err)
	}
	err = buf.Add("did:plc:pre-migration", "old-msg-2", []byte("old-payload-2"))
	if err != nil {
		t.Fatalf("Add old-msg-2: %v", err)
	}

	// Verify stored correctly.
	if buf.TotalCount() != 2 {
		t.Fatalf("TotalCount() = %d, want 2", buf.TotalCount())
	}

	// Simulate what ALTER TABLE ADD COLUMN does: the columns get defaults.
	// Since we're using the current schema (no sender/expires_at columns),
	// the rows exist in the current format. The test verifies Drain() works
	// with the current schema — when migration adds columns, these old rows
	// will have defaults and must still drain identically.

	// Drain works with current schema.
	msgs := buf.Drain("did:plc:pre-migration")
	if len(msgs) != 2 {
		t.Fatalf("Drain() returned %d, want 2", len(msgs))
	}
	if msgs[0].ID != "old-msg-1" || msgs[1].ID != "old-msg-2" {
		t.Errorf("Drain() order: [%q, %q], want [old-msg-1, old-msg-2]", msgs[0].ID, msgs[1].ID)
	}

	// Delete works on drained (empty) buffer — no error.
	buf.Delete("nonexistent")

	// DeleteIfExists on empty — false.
	if buf.DeleteIfExists("nonexistent") {
		t.Error("DeleteIfExists on empty buffer returned true")
	}

	// After migration, Add() with new columns will extend the schema.
	// This test only validates the pre-migration baseline.
}

// --- TST-MBX-0059: Buffer full — Dead Drop at capacity ---
// TRACE: {"suite": "MBX", "case": "0059", "section": "06", "sectionName": "Operational & Load", "subsection": "02", "scenario": "04", "title": "buffer_full_dead_drop_capacity"}
func TestBufferFull(t *testing.T) {
	buf := newTestBuffer(t)
	defer buf.Close()

	did := "did:plc:buffer-full-test"

	// Fill to MaxMessagesPerDID (100).
	for i := 0; i < MaxMessagesPerDID; i++ {
		msgID := fmt.Sprintf("fill-%04d", i)
		err := buf.Add(did, msgID, []byte("x"))
		if err != nil {
			t.Fatalf("Add() at i=%d failed: %v", i, err)
		}
	}

	if buf.TotalCount() != MaxMessagesPerDID {
		t.Fatalf("TotalCount() = %d, want %d", buf.TotalCount(), MaxMessagesPerDID)
	}

	// Next add should fail with ErrBufferFull.
	err := buf.Add(did, "overflow-msg", []byte("y"))
	if err != ErrBufferFull {
		t.Errorf("Add() past capacity: err = %v, want ErrBufferFull", err)
	}

	// Buffer for a DIFFERENT DID should still work (per-DID limit).
	err = buf.Add("did:plc:other-node", "other-msg", []byte("z"))
	if err != nil {
		t.Errorf("Add() to different DID failed: %v (should not be affected by first DID's limit)", err)
	}

	// Drain the full DID — frees capacity.
	msgs := buf.Drain(did)
	if len(msgs) != MaxMessagesPerDID {
		t.Fatalf("Drain() returned %d, want %d", len(msgs), MaxMessagesPerDID)
	}

	// Now add should work again for the original DID.
	err = buf.Add(did, "after-drain", []byte("recovered"))
	if err != nil {
		t.Errorf("Add() after drain failed: %v", err)
	}
}

// --- TST-MBX-0130: Composite msgID with DID containing colons ---
// TRACE: {"suite": "MBX", "case": "0130", "section": "15", "sectionName": "Crypto & Encoding Edge Cases", "subsection": "01", "scenario": "01", "title": "composite_msgid_with_colons"}
//
// from_did = "did:key:z6MkABC", id = "req-123" → composite key
// "did:key:z6MkABC:req-123" works as opaque key (never decomposed).
func TestBuffer_CompositeMsgIDWithColons(t *testing.T) {
	buf := newTestBuffer(t)
	defer buf.Close()

	// Realistic DID with multiple colons.
	fromDID := "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"
	reqID := "req-uuid-12345"
	compositeKey := fromDID + ":" + reqID
	recipientDID := "did:plc:composite-target"
	payload := []byte(`{"type":"rpc","id":"req-uuid-12345"}`)

	// Store with composite key.
	err := buf.Add(recipientDID, compositeKey, payload)
	if err != nil {
		t.Fatalf("Add with composite key: %v", err)
	}

	// Peek returns it with the exact composite key.
	msgs := buf.Peek(recipientDID)
	if len(msgs) != 1 {
		t.Fatalf("Peek: got %d, want 1", len(msgs))
	}
	if msgs[0].ID != compositeKey {
		t.Errorf("msg.ID = %q, want %q", msgs[0].ID, compositeKey)
	}

	// DeleteIfExists works with the composite key.
	if !buf.DeleteIfExists(compositeKey) {
		t.Error("DeleteIfExists(compositeKey) = false, want true")
	}

	// Verify deleted.
	if buf.TotalCount() != 0 {
		t.Error("after delete: buffer not empty")
	}

	// Idempotent add with same composite key.
	buf.Add(recipientDID, compositeKey, payload)
	buf.Add(recipientDID, compositeKey, payload) // duplicate — should be idempotent
	if buf.TotalCount() != 1 {
		t.Errorf("after double-add: count = %d, want 1 (idempotent)", buf.TotalCount())
	}
}

// --- Concurrent per-DID limit enforcement ---
// TRACE: {"suite": "MBX", "case": "0146", "section": "06", "sectionName": "Operational & Load", "subsection": "02", "scenario": "05", "title": "concurrent_per_did_limit_atomic"}
//
// Multiple goroutines concurrently Add() to the same recipient DID.
// Total stored messages must not exceed MaxMessagesPerDID. Before the
// transaction fix, the TOCTOU race between SELECT COUNT(*) and INSERT
// could allow the limit to be exceeded.
func TestBuffer_ConcurrentPerDIDLimit(t *testing.T) {
	buf := newTestBuffer(t)
	defer buf.Close()

	did := "did:plc:concurrent-test"
	// Use 10 concurrent goroutines each adding 15 messages (150 total attempts
	// for a limit of 100). This is realistic for production load and avoids
	// overwhelming SQLite's single-writer lock.
	workers := 10
	perWorker := 15
	total := workers * perWorker
	errs := make(chan error, total)

	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(worker int) {
			defer wg.Done()
			for i := 0; i < perWorker; i++ {
				msgID := fmt.Sprintf("conc-w%d-%04d", worker, i)
				errs <- buf.Add(did, msgID, []byte("x"))
			}
		}(w)
	}
	wg.Wait()
	close(errs)

	// Count outcomes.
	var successes, full, locked int
	for err := range errs {
		switch {
		case err == nil:
			successes++
		case err == ErrBufferFull:
			full++
		default:
			// SQLite lock contention — valid under concurrent writes.
			// The transaction ensures no TOCTOU, but concurrent Begin()
			// calls may timeout waiting for the write lock.
			locked++
		}
	}

	// THE CRITICAL ASSERTION: stored messages must NEVER exceed the limit.
	count := buf.TotalCount()
	if count > MaxMessagesPerDID {
		t.Errorf("buffer count = %d, EXCEEDS MaxMessagesPerDID (%d) — TOCTOU race!",
			count, MaxMessagesPerDID)
	}

	t.Logf("successes=%d, full=%d, locked=%d, stored=%d (limit=%d)",
		successes, full, locked, count, MaxMessagesPerDID)
}
