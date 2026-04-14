// query_window.go — Time-limited query windows for public service D2D traffic.
//
// Public service traffic bypasses the contacts-only D2D model. A QueryWindow
// tracks (peerDID, queryID, capability) → expiry entries that authorize
// specific D2D messages to skip the contact gate.
//
// Two instances are used:
//   - providerWindow: opened when a service.query is accepted from a stranger.
//     The provider's service.response uses Reserve/Commit to consume the window.
//   - requesterWindow: opened when a service.query is sent to a public service.
//     The requester's inbound service.response uses CheckAndConsume to accept it.
package service

import (
	"context"
	"sync"
	"time"
)

// QueryWindow tracks time-limited authorization windows for public service
// D2D traffic. Thread-safe. Memory-only (acceptable for ephemeral queries).
type QueryWindow struct {
	mu      sync.Mutex
	entries map[windowKey]*windowEntry
}

type windowKey struct {
	PeerDID string
	QueryID string
}

type windowEntry struct {
	Capability string
	Expiry     time.Time
	Reserved   bool // true = reserved by a pending send, prevents duplicate sends
}

// NewQueryWindow creates an empty query window.
func NewQueryWindow() *QueryWindow {
	return &QueryWindow{
		entries: make(map[windowKey]*windowEntry),
	}
}

// Open creates a new window entry. If an entry already exists for the same
// (peerDID, queryID), it is overwritten (last-write-wins).
func (qw *QueryWindow) Open(peerDID, queryID, capability string, ttl time.Duration) {
	qw.mu.Lock()
	defer qw.mu.Unlock()

	key := windowKey{PeerDID: peerDID, QueryID: queryID}
	qw.entries[key] = &windowEntry{
		Capability: capability,
		Expiry:     time.Now().Add(ttl),
	}
}

// Reserve atomically marks an entry as reserved if it exists, is not expired,
// is not already reserved, and the capability matches. Returns true if
// reserved successfully. Used by the provider side at egress gate 1 to
// prevent two concurrent service.response sends from both passing the gate.
func (qw *QueryWindow) Reserve(peerDID, queryID, capability string) bool {
	qw.mu.Lock()
	defer qw.mu.Unlock()

	key := windowKey{PeerDID: peerDID, QueryID: queryID}
	entry, ok := qw.entries[key]
	if !ok || entry.Reserved || time.Now().After(entry.Expiry) || entry.Capability != capability {
		return false
	}
	entry.Reserved = true
	return true
}

// Commit consumes a previously reserved entry (removes it). Called after
// successful outbox enqueue on the provider side. If the entry is not
// reserved or doesn't exist, this is a no-op.
func (qw *QueryWindow) Commit(peerDID, queryID, capability string) {
	qw.mu.Lock()
	defer qw.mu.Unlock()

	key := windowKey{PeerDID: peerDID, QueryID: queryID}
	if entry, ok := qw.entries[key]; ok && entry.Reserved && entry.Capability == capability {
		delete(qw.entries, key)
	}
}

// Release undoes a reservation without consuming the entry. Called when
// the send pipeline fails before enqueue. The entry becomes available
// for retry.
func (qw *QueryWindow) Release(peerDID, queryID, capability string) {
	qw.mu.Lock()
	defer qw.mu.Unlock()

	key := windowKey{PeerDID: peerDID, QueryID: queryID}
	if entry, ok := qw.entries[key]; ok && entry.Reserved && entry.Capability == capability {
		entry.Reserved = false
	}
}

// CheckAndConsume returns true and removes the entry if it exists, is not
// expired, and the capability matches. One-shot — subsequent calls for the
// same key return false. Used by the requester side for inbound
// service.response acceptance (no reservation step needed since inbound
// processing is single-threaded per connection).
func (qw *QueryWindow) CheckAndConsume(peerDID, queryID, capability string) bool {
	qw.mu.Lock()
	defer qw.mu.Unlock()

	key := windowKey{PeerDID: peerDID, QueryID: queryID}
	entry, ok := qw.entries[key]
	if !ok || time.Now().After(entry.Expiry) || entry.Capability != capability {
		return false
	}
	delete(qw.entries, key)
	return true
}

// Size returns the number of entries (for testing/metrics).
func (qw *QueryWindow) Size() int {
	qw.mu.Lock()
	defer qw.mu.Unlock()
	return len(qw.entries)
}

// CleanupLoop periodically removes expired entries. Blocks until ctx is
// cancelled. Call as a goroutine.
func (qw *QueryWindow) CleanupLoop(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			qw.cleanup()
		}
	}
}

func (qw *QueryWindow) cleanup() {
	qw.mu.Lock()
	defer qw.mu.Unlock()

	now := time.Now()
	for key, entry := range qw.entries {
		if now.After(entry.Expiry) {
			delete(qw.entries, key)
		}
	}
}
