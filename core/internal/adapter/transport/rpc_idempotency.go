// rpc_idempotency.go — Sender-scoped request deduplication + nonce replay cache.
//
// The idempotency cache stores (from_did, request_id) → response for RPC
// requests relayed via MsgBox. Retries with the same request_id return the
// cached response without re-executing the handler. The cache has a TTL
// (default 5 minutes) and background cleanup.
//
// The nonce cache prevents exact replay of signed requests by tracking
// recently-seen (DID, nonce) pairs within the timestamp validity window.
package transport

import (
	"sync"
	"time"
)

// IdempotencyCache stores RPC responses keyed by (from_did, request_id).
// Thread-safe. Injectable clock for testing.
type IdempotencyCache struct {
	mu      sync.Mutex
	entries map[idempotencyKey]*idempotencyEntry
	ttl     time.Duration
	now     func() time.Time // injectable clock
}

type idempotencyKey struct {
	FromDID   string
	RequestID string
}

type idempotencyEntry struct {
	Response  *RPCInnerResponse
	CreatedAt time.Time
}

// NewIdempotencyCache creates a cache with the given TTL.
func NewIdempotencyCache(ttl time.Duration) *IdempotencyCache {
	return &IdempotencyCache{
		entries: make(map[idempotencyKey]*idempotencyEntry),
		ttl:     ttl,
		now:     time.Now,
	}
}

// Get looks up a cached response. Returns nil if not found or expired.
func (c *IdempotencyCache) Get(fromDID, requestID string) *RPCInnerResponse {
	c.mu.Lock()
	defer c.mu.Unlock()

	key := idempotencyKey{FromDID: fromDID, RequestID: requestID}
	entry, ok := c.entries[key]
	if !ok {
		return nil
	}
	if c.now().Sub(entry.CreatedAt) > c.ttl {
		delete(c.entries, key)
		return nil
	}
	return entry.Response
}

// Put stores a response in the cache. Overwrites if exists.
func (c *IdempotencyCache) Put(fromDID, requestID string, resp *RPCInnerResponse) {
	c.mu.Lock()
	defer c.mu.Unlock()

	key := idempotencyKey{FromDID: fromDID, RequestID: requestID}
	c.entries[key] = &idempotencyEntry{
		Response:  resp,
		CreatedAt: c.now(),
	}
}

// Cleanup removes all expired entries. Returns count removed.
func (c *IdempotencyCache) Cleanup() int {
	c.mu.Lock()
	defer c.mu.Unlock()

	now := c.now()
	removed := 0
	for key, entry := range c.entries {
		if now.Sub(entry.CreatedAt) > c.ttl {
			delete(c.entries, key)
			removed++
		}
	}
	return removed
}

// Size returns the number of entries (for testing).
func (c *IdempotencyCache) Size() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.entries)
}

// NonceCache tracks recently-used nonces to prevent exact replay.
// Thread-safe. Injectable clock for testing.
type NonceCache struct {
	mu      sync.Mutex
	seen    map[nonceKey]time.Time
	window  time.Duration
	now     func() time.Time
}

type nonceKey struct {
	DID   string
	Nonce string
}

// NewNonceCache creates a cache with the given replay window.
func NewNonceCache(window time.Duration) *NonceCache {
	return &NonceCache{
		seen:   make(map[nonceKey]time.Time),
		window: window,
		now:    time.Now,
	}
}

// CheckAndStore returns true if the nonce is fresh (not seen before within
// the window). If fresh, it stores the nonce and returns true. If already
// seen, returns false (replay detected).
func (c *NonceCache) CheckAndStore(did, nonce string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()

	now := c.now()
	key := nonceKey{DID: did, Nonce: nonce}

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
