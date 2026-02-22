package ingress

import (
	"sync"
	"time"
)

// RateLimiter implements the two-valve ingress rate limiting:
//   - Valve 1: Per-IP rate limit (token bucket) — prevents a single
//     sender from flooding the ingress endpoint.
//   - Valve 2: Global spool capacity — prevents disk exhaustion when
//     the vault is locked and messages accumulate.
type RateLimiter struct {
	mu sync.Mutex

	// Valve 1: Per-IP token bucket.
	ipBuckets map[string]*bucket
	ipRate    int           // tokens per window
	ipWindow  time.Duration // bucket window

	// Valve 2: Global capacity.
	spoolMaxBytes int64
	spoolMaxBlobs int
	deadDrop      *DeadDrop
}

// bucket is a simple token bucket for rate limiting.
type bucket struct {
	tokens    int
	lastReset time.Time
}

// NewRateLimiter creates an ingress rate limiter.
// ipRate is the maximum requests per IP per window.
// spoolMaxBlobs and spoolMaxBytes set global spool capacity limits.
func NewRateLimiter(ipRate int, ipWindow time.Duration, spoolMaxBlobs int, spoolMaxBytes int64, deadDrop *DeadDrop) *RateLimiter {
	return &RateLimiter{
		ipBuckets:     make(map[string]*bucket),
		ipRate:        ipRate,
		ipWindow:      ipWindow,
		spoolMaxBlobs: spoolMaxBlobs,
		spoolMaxBytes: spoolMaxBytes,
		deadDrop:      deadDrop,
	}
}

// AllowIP checks whether the given IP is allowed to send another message.
// Returns false if the IP has exhausted its rate limit.
func (r *RateLimiter) AllowIP(ip string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()

	now := time.Now()
	b, ok := r.ipBuckets[ip]
	if !ok {
		r.ipBuckets[ip] = &bucket{tokens: r.ipRate - 1, lastReset: now}
		return true
	}

	// Reset bucket if the window has elapsed.
	if now.Sub(b.lastReset) >= r.ipWindow {
		b.tokens = r.ipRate - 1
		b.lastReset = now
		return true
	}

	if b.tokens <= 0 {
		return false
	}

	b.tokens--
	return true
}

// AllowGlobal checks whether the global spool has capacity for more messages.
// Returns false if the dead drop is at capacity (Valve 2).
func (r *RateLimiter) AllowGlobal() bool {
	if r.deadDrop == nil {
		return true
	}

	count, err := r.deadDrop.Count()
	if err != nil {
		// If we can't check, allow (fail open for availability).
		return true
	}

	return count < r.spoolMaxBlobs
}

// ResetIP clears the rate limit bucket for a specific IP.
func (r *RateLimiter) ResetIP(ip string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.ipBuckets, ip)
}

// PurgeExpired removes rate limit buckets older than the window duration.
// Should be called periodically to prevent unbounded memory growth.
func (r *RateLimiter) PurgeExpired() int {
	r.mu.Lock()
	defer r.mu.Unlock()

	now := time.Now()
	purged := 0
	for ip, b := range r.ipBuckets {
		if now.Sub(b.lastReset) >= r.ipWindow*2 {
			delete(r.ipBuckets, ip)
			purged++
		}
	}
	return purged
}
