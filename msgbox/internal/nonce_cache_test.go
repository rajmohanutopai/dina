package internal

import (
	"testing"
	"time"
)

func TestNonceCache_FreshAccepted(t *testing.T) {
	c := NewNonceCache(5 * time.Minute)
	if !c.CheckAndStore("did:key:z1", "nonce-aaa") {
		t.Error("fresh nonce should be accepted")
	}
}

func TestNonceCache_ReplayRejected(t *testing.T) {
	c := NewNonceCache(5 * time.Minute)
	c.CheckAndStore("did:key:z1", "nonce-bbb")
	if c.CheckAndStore("did:key:z1", "nonce-bbb") {
		t.Error("replayed nonce should be rejected")
	}
}

func TestNonceCache_DifferentSenderSameNonce(t *testing.T) {
	c := NewNonceCache(5 * time.Minute)
	c.CheckAndStore("did:key:z1", "nonce-shared")
	// Same nonce from a different sender is NOT a replay (sender-scoped).
	if !c.CheckAndStore("did:key:z2", "nonce-shared") {
		t.Error("same nonce from different sender should be accepted")
	}
}

func TestNonceCache_ExpiredEntryReusable(t *testing.T) {
	c := NewNonceCache(5 * time.Minute)
	now := time.Now()
	c.now = func() time.Time { return now }

	c.CheckAndStore("did:key:z1", "nonce-exp")

	// Advance past the window.
	now = now.Add(6 * time.Minute)

	// Same nonce should be accepted (entry expired).
	if !c.CheckAndStore("did:key:z1", "nonce-exp") {
		t.Error("expired nonce entry should allow reuse")
	}
}

func TestNonceCache_Cleanup(t *testing.T) {
	c := NewNonceCache(5 * time.Minute)
	now := time.Now()
	c.now = func() time.Time { return now }

	c.CheckAndStore("did:key:z1", "nonce-1")
	c.CheckAndStore("did:key:z2", "nonce-2")

	if c.Size() != 2 {
		t.Fatalf("size = %d, want 2", c.Size())
	}

	// Advance past window and cleanup.
	now = now.Add(6 * time.Minute)
	removed := c.Cleanup()
	if removed != 2 {
		t.Errorf("cleanup removed %d, want 2", removed)
	}
	if c.Size() != 0 {
		t.Errorf("size after cleanup = %d, want 0", c.Size())
	}
}

func TestNonceCache_CleanupKeepsFresh(t *testing.T) {
	c := NewNonceCache(5 * time.Minute)
	now := time.Now()
	c.now = func() time.Time { return now }

	c.CheckAndStore("did:key:z1", "old-nonce")

	// Advance 3 minutes — "old-nonce" is still within window.
	now = now.Add(3 * time.Minute)
	c.CheckAndStore("did:key:z1", "new-nonce")

	// Advance another 3 minutes — "old-nonce" is now 6 min old (expired),
	// "new-nonce" is 3 min old (still fresh).
	now = now.Add(3 * time.Minute)
	removed := c.Cleanup()
	if removed != 1 {
		t.Errorf("cleanup removed %d, want 1 (only old-nonce)", removed)
	}
	if c.Size() != 1 {
		t.Errorf("size = %d, want 1 (new-nonce still fresh)", c.Size())
	}
}
