// nonce_cache.go — Nonce replay protection for /forward endpoint.
//
// Each signed /forward request includes a random nonce in the canonical
// signing payload. Without server-side nonce storage, an attacker who
// intercepts a valid signed request can replay it within the 5-minute
// timestamp window, causing buffer duplication.
//
// The NonceCache stores (senderDID, nonce) pairs and rejects replays.
// Entries auto-expire after the timestamp validity window (6 min = 5 min
// window + 1 min buffer for clock skew).
package internal

import (
	"sync"
	"time"
)

// NonceCache tracks recently-used nonces to prevent exact replay on /forward.
// Thread-safe. Injectable clock for testing.
type NonceCache struct {
	mu     sync.Mutex
	seen   map[nonceKey]time.Time
	window time.Duration
	now    func() time.Time
}

type nonceKey struct {
	SenderDID string
	Nonce     string
}

// NewNonceCache creates a cache with the given replay window.
// Recommended window: 6 minutes (5-min timestamp validity + 1-min buffer).
func NewNonceCache(window time.Duration) *NonceCache {
	return &NonceCache{
		seen:   make(map[nonceKey]time.Time),
		window: window,
		now:    time.Now,
	}
}

// CheckAndStore returns true if the nonce is fresh (not seen within the
// window). Stores the nonce and returns true if fresh. Returns false if
// the nonce was already seen (replay detected).
func (c *NonceCache) CheckAndStore(senderDID, nonce string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()

	now := c.now()
	key := nonceKey{SenderDID: senderDID, Nonce: nonce}

	if seenAt, exists := c.seen[key]; exists {
		if now.Sub(seenAt) < c.window {
			return false // replay
		}
		// Expired entry — allow reuse.
	}

	c.seen[key] = now
	return true
}

// Cleanup removes expired nonce entries. Returns count removed.
// Called periodically by a background goroutine.
func (c *NonceCache) Cleanup() int {
	c.mu.Lock()
	defer c.mu.Unlock()

	now := c.now()
	removed := 0
	for key, seenAt := range c.seen {
		if now.Sub(seenAt) > c.window {
			delete(c.seen, key)
			removed++
		}
	}
	return removed
}

// Size returns the number of entries (for testing/metrics).
func (c *NonceCache) Size() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.seen)
}
