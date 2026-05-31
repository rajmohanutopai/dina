package service

import (
	"context"
	"sync"
	"testing"
	"time"
)

func TestQueryWindow_OpenAndCheckAndConsume(t *testing.T) {
	qw := NewQueryWindow()
	qw.Open("did:plc:bus42", "q-001", "eta_query", 60*time.Second)

	// First CheckAndConsume succeeds.
	if !qw.CheckAndConsume("did:plc:bus42", "q-001", "eta_query") {
		t.Error("first CheckAndConsume should succeed")
	}

	// Second is consumed — returns false.
	if qw.CheckAndConsume("did:plc:bus42", "q-001", "eta_query") {
		t.Error("second CheckAndConsume should fail (consumed)")
	}
}

func TestQueryWindow_WrongCapabilityRejected(t *testing.T) {
	qw := NewQueryWindow()
	qw.Open("did:plc:bus42", "q-001", "eta_query", 60*time.Second)

	if qw.CheckAndConsume("did:plc:bus42", "q-001", "route_info") {
		t.Error("wrong capability should be rejected")
	}

	// Correct capability still works.
	if !qw.CheckAndConsume("did:plc:bus42", "q-001", "eta_query") {
		t.Error("correct capability should succeed")
	}
}

func TestQueryWindow_ExpiredEntryRejected(t *testing.T) {
	qw := NewQueryWindow()
	qw.Open("did:plc:bus42", "q-002", "eta_query", 1*time.Millisecond)

	time.Sleep(5 * time.Millisecond)

	if qw.CheckAndConsume("did:plc:bus42", "q-002", "eta_query") {
		t.Error("expired entry should be rejected")
	}
}

func TestQueryWindow_WrongPeerRejected(t *testing.T) {
	qw := NewQueryWindow()
	qw.Open("did:plc:bus42", "q-001", "eta_query", 60*time.Second)

	if qw.CheckAndConsume("did:plc:attacker", "q-001", "eta_query") {
		t.Error("wrong peerDID should be rejected")
	}
}

func TestQueryWindow_ReserveCommit(t *testing.T) {
	qw := NewQueryWindow()
	qw.Open("did:key:zcli", "q-003", "eta_query", 60*time.Second)

	// Reserve succeeds.
	if !qw.Reserve("did:key:zcli", "q-003", "eta_query") {
		t.Fatal("Reserve should succeed")
	}

	// Second Reserve fails (already reserved).
	if qw.Reserve("did:key:zcli", "q-003", "eta_query") {
		t.Error("second Reserve should fail (already reserved)")
	}

	// Commit removes the entry.
	qw.Commit("did:key:zcli", "q-003", "eta_query")

	if qw.Size() != 0 {
		t.Errorf("size after Commit = %d, want 0", qw.Size())
	}
}

func TestQueryWindow_ReserveRelease(t *testing.T) {
	qw := NewQueryWindow()
	qw.Open("did:key:zcli", "q-004", "eta_query", 60*time.Second)

	// Reserve succeeds.
	if !qw.Reserve("did:key:zcli", "q-004", "eta_query") {
		t.Fatal("Reserve should succeed")
	}

	// Release restores the entry for retry.
	qw.Release("did:key:zcli", "q-004", "eta_query")

	// Reserve again succeeds (released).
	if !qw.Reserve("did:key:zcli", "q-004", "eta_query") {
		t.Error("Reserve after Release should succeed")
	}
}

func TestQueryWindow_ReserveConcurrentRace(t *testing.T) {
	qw := NewQueryWindow()
	qw.Open("did:key:zcli", "q-005", "eta_query", 60*time.Second)

	// Two goroutines race to Reserve the same entry.
	var reserved [2]bool
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			reserved[idx] = qw.Reserve("did:key:zcli", "q-005", "eta_query")
		}(i)
	}
	wg.Wait()

	// Exactly one should win.
	wins := 0
	for _, r := range reserved {
		if r {
			wins++
		}
	}
	if wins != 1 {
		t.Errorf("exactly 1 Reserve should win, got %d", wins)
	}
}

func TestQueryWindow_CleanupRemovesExpired(t *testing.T) {
	qw := NewQueryWindow()
	qw.Open("did:plc:a", "q-old", "eta_query", 1*time.Millisecond)
	qw.Open("did:plc:b", "q-fresh", "eta_query", 60*time.Second)

	time.Sleep(5 * time.Millisecond)
	qw.cleanup()

	if qw.Size() != 1 {
		t.Errorf("size after cleanup = %d, want 1 (only fresh entry)", qw.Size())
	}

	// Fresh entry should still work.
	if !qw.CheckAndConsume("did:plc:b", "q-fresh", "eta_query") {
		t.Error("fresh entry should survive cleanup")
	}
}

func TestQueryWindow_CleanupLoop(t *testing.T) {
	qw := NewQueryWindow()
	qw.Open("did:plc:a", "q-loop", "eta_query", 1*time.Millisecond)

	ctx, cancel := context.WithCancel(context.Background())
	go qw.CleanupLoop(ctx, 10*time.Millisecond)

	time.Sleep(50 * time.Millisecond)
	cancel()

	if qw.Size() != 0 {
		t.Errorf("size after CleanupLoop = %d, want 0", qw.Size())
	}
}

func TestQueryWindow_ReserveExpiredFails(t *testing.T) {
	qw := NewQueryWindow()
	qw.Open("did:key:zcli", "q-exp", "eta_query", 1*time.Millisecond)

	time.Sleep(5 * time.Millisecond)

	if qw.Reserve("did:key:zcli", "q-exp", "eta_query") {
		t.Error("Reserve on expired entry should fail")
	}
}
