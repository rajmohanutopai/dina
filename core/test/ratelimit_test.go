package test

import (
	"testing"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/adapter/auth"
	"github.com/rajmohanutopai/dina/core/test/testutil"
)

// ==========================================================================
// TEST_PLAN §13 — Rate Limiting
// ==========================================================================
// Covers per-IP request rate limiting using a token bucket or sliding window.
//
// Every test calls testutil.RequireImplementation to skip until the real
// implementation is wired in.
// ==========================================================================

// --------------------------------------------------------------------------
// §13.1 Below Rate Limit
// --------------------------------------------------------------------------

// TST-CORE-545
func TestRateLimit_13_1_BelowLimit(t *testing.T) {
	// var impl testutil.RateLimitChecker = reallimit.New(...)
	impl := realRateLimitChecker
	testutil.RequireImplementation(t, impl, "RateLimitChecker")

	ip := "192.168.1.10"
	impl.Reset(ip)

	// A single request at normal rate must succeed.
	result := impl.Check(ip)
	testutil.RequireTrue(t, result.Allowed, "single request below limit must be allowed")
	testutil.RequireTrue(t, result.Remaining > 0, "remaining quota must be positive after one request")
}

// --------------------------------------------------------------------------
// §13.2 At Rate Limit
// --------------------------------------------------------------------------

// TST-CORE-546
func TestRateLimit_13_2_AtLimit(t *testing.T) {
	// var impl testutil.RateLimitChecker = reallimit.New(...)
	impl := realRateLimitChecker
	testutil.RequireImplementation(t, impl, "RateLimitChecker")

	ip := "192.168.1.20"
	impl.Reset(ip)

	// Send requests up to exactly the limit. The last request must succeed.
	// We use a reasonable limit assumption (60 req/min from default config).
	cfg := testutil.TestConfig()
	limit := cfg.RateLimit
	if limit <= 0 {
		limit = 60
	}

	var lastResult testutil.RateLimitResult
	for i := 0; i < limit; i++ {
		lastResult = impl.Check(ip)
	}
	testutil.RequireTrue(t, lastResult.Allowed, "request exactly at limit must succeed")
	testutil.RequireEqual(t, lastResult.Remaining, 0)
}

// --------------------------------------------------------------------------
// §13.3 Above Rate Limit
// --------------------------------------------------------------------------

// TST-CORE-547
func TestRateLimit_13_3_AboveLimit(t *testing.T) {
	// var impl testutil.RateLimitChecker = reallimit.New(...)
	impl := realRateLimitChecker
	testutil.RequireImplementation(t, impl, "RateLimitChecker")

	ip := "192.168.1.30"
	impl.Reset(ip)

	// Exceed the limit by sending limit+1 requests. The overflow request
	// must be rejected (429 Too Many Requests equivalent).
	cfg := testutil.TestConfig()
	limit := cfg.RateLimit
	if limit <= 0 {
		limit = 60
	}

	// Positive control: the first request must be allowed.
	first := impl.Check(ip)
	testutil.RequireTrue(t, first.Allowed, "first request must be allowed")

	// Consume remaining quota.
	for i := 1; i < limit; i++ {
		impl.Check(ip)
	}

	// Boundary: last in-limit request should have consumed all tokens.
	// The next request exceeds the limit.
	overflow := impl.Check(ip)
	testutil.RequireFalse(t, overflow.Allowed, "request above limit must be rejected (429)")
	testutil.RequireEqual(t, overflow.Remaining, 0)
	testutil.RequireTrue(t, overflow.ResetAt > 0, "ResetAt must be set on rejection")
}

// --------------------------------------------------------------------------
// §13.4 Rate Limit Reset
// --------------------------------------------------------------------------

// TST-CORE-548
func TestRateLimit_13_4_Reset(t *testing.T) {
	rl := auth.NewRateLimitChecker(10, 60)
	testutil.RequireImplementation(t, rl, "RateLimitChecker")

	ip := "192.168.1.40"

	// Positive: first request allowed on fresh limiter.
	first := rl.Check(ip)
	testutil.RequireTrue(t, first.Allowed, "first request must be allowed")

	// Exhaust the limit (10 total, 1 already consumed).
	for i := 1; i < 10; i++ {
		rl.Check(ip)
	}

	// Verify limit is exhausted.
	overflow := rl.Check(ip)
	testutil.RequireFalse(t, overflow.Allowed, "request above limit must be rejected")

	// After reset, requests must succeed again.
	rl.Reset(ip)
	result := rl.Check(ip)
	testutil.RequireTrue(t, result.Allowed, "after reset, requests must succeed")
	testutil.RequireTrue(t, result.Remaining > 0, "after reset, remaining must be positive")
}

// --------------------------------------------------------------------------
// §13.5 Per-IP Isolation
// --------------------------------------------------------------------------

// TST-CORE-549
func TestRateLimit_13_5_PerIPIsolation(t *testing.T) {
	rl := auth.NewRateLimitChecker(5, 60)
	testutil.RequireImplementation(t, rl, "RateLimitChecker")

	ipA := "10.0.0.1"
	ipB := "10.0.0.2"

	// Positive: both IPs start with full quota.
	firstA := rl.Check(ipA)
	testutil.RequireTrue(t, firstA.Allowed, "IP A first request must be allowed")
	firstB := rl.Check(ipB)
	testutil.RequireTrue(t, firstB.Allowed, "IP B first request must be allowed")

	// Exhaust the remaining quota for IP A (4 already consumed for A, need 4 more).
	for i := 1; i < 5; i++ {
		rl.Check(ipA)
	}

	// IP A should be rate-limited.
	overflowA := rl.Check(ipA)
	testutil.RequireFalse(t, overflowA.Allowed, "IP A must be rate-limited after exhaustion")
	testutil.RequireEqual(t, overflowA.Remaining, 0)

	// IP B should still be allowed — tracked independently.
	resultB := rl.Check(ipB)
	testutil.RequireTrue(t, resultB.Allowed, "IP B must not be affected by IP A's rate limit")
	testutil.RequireTrue(t, resultB.Remaining > 0, "IP B remaining must be positive")
}

// --------------------------------------------------------------------------
// §13.6 Rate Limit Headers
// --------------------------------------------------------------------------

// TST-CORE-550
func TestRateLimit_13_6_RateLimitHeaders(t *testing.T) {
	impl := realRateLimitChecker
	testutil.RequireImplementation(t, impl, "RateLimitChecker")

	ip := "10.0.0.10"
	impl.Reset(ip)

	// First request: must be allowed with Remaining = limit - 1.
	first := impl.Check(ip)
	testutil.RequireTrue(t, first.Allowed, "first request must be allowed")
	testutil.RequireTrue(t, first.Remaining >= 0, "Remaining must be non-negative")

	// ResetAt must be in the future (current time or later).
	now := time.Now().Unix()
	testutil.RequireTrue(t, first.ResetAt >= now,
		"ResetAt must be in the future (window hasn't expired yet)")

	// Second request: Remaining must decrement by 1.
	second := impl.Check(ip)
	testutil.RequireTrue(t, second.Allowed, "second request must be allowed")
	testutil.RequireEqual(t, second.Remaining, first.Remaining-1)

	// Exhaust remaining quota.
	for i := 0; i < second.Remaining; i++ {
		impl.Check(ip)
	}

	// After exhaustion: must be denied with Remaining == 0 and ResetAt still set.
	denied := impl.Check(ip)
	testutil.RequireFalse(t, denied.Allowed, "request above limit must be denied")
	testutil.RequireEqual(t, denied.Remaining, 0)
	testutil.RequireTrue(t, denied.ResetAt > 0,
		"ResetAt must still be set when denied (tells client when to retry)")
}
