package test

import (
	"fmt"
	"sync"
	"sync/atomic"
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
// TRACE: {"suite": "CORE", "case": "1177", "section": "13", "sectionName": "Rate Limiting", "subsection": "01", "scenario": "01", "title": "BelowLimit"}
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
// TRACE: {"suite": "CORE", "case": "1178", "section": "13", "sectionName": "Rate Limiting", "subsection": "02", "scenario": "01", "title": "AtLimit"}
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
// TRACE: {"suite": "CORE", "case": "1179", "section": "13", "sectionName": "Rate Limiting", "subsection": "03", "scenario": "01", "title": "AboveLimit"}
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
// TRACE: {"suite": "CORE", "case": "1180", "section": "13", "sectionName": "Rate Limiting", "subsection": "04", "scenario": "01", "title": "Reset"}
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
// TRACE: {"suite": "CORE", "case": "1181", "section": "13", "sectionName": "Rate Limiting", "subsection": "05", "scenario": "01", "title": "PerIPIsolation"}
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
// TRACE: {"suite": "CORE", "case": "1182", "section": "13", "sectionName": "Rate Limiting", "subsection": "06", "scenario": "01", "title": "RateLimitHeaders"}
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

// ==========================================================================
// TST-CORE-1125: Agent attempts rate limit bypass via concurrent requests
// §34.2 Agent Sandbox Adversarial
// Requirement: 1000 concurrent requests from same agent DID → rate limiter
// enforces per-IP limit, excess requests rejected. No races or panics.
// ==========================================================================

// TRACE: {"suite": "CORE", "case": "1183", "section": "34", "sectionName": "Thesis: Loyalty", "subsection": "02", "scenario": "05", "title": "ConcurrentRateLimitBypass"}
func TestRateLimit_34_2_5_ConcurrentRateLimitBypass(t *testing.T) {
	// Use a fresh rate limiter with a small limit for testability.
	const limit = 60
	rl := auth.NewRateLimitChecker(limit, 60)

	// TRACE: {"suite": "CORE", "case": "1184", "section": "34", "sectionName": "Thesis: Loyalty", "title": "concurrent_requests_enforce_limit_no_excess_allowed"}
	t.Run("concurrent_requests_enforce_limit_no_excess_allowed", func(t *testing.T) {
		// Fire 200 concurrent requests from the same IP.
		// The rate limiter must allow at most `limit` requests total.
		// This verifies the mutex protection prevents double-spending tokens.
		ip := "10.10.10.1"
		rl.Reset(ip)

		const goroutines = 200
		var allowed int64
		var denied int64
		var wg sync.WaitGroup

		wg.Add(goroutines)
		for i := 0; i < goroutines; i++ {
			go func() {
				defer wg.Done()
				result := rl.Check(ip)
				if result.Allowed {
					atomic.AddInt64(&allowed, 1)
				} else {
					atomic.AddInt64(&denied, 1)
				}
			}()
		}
		wg.Wait()

		// Exactly `limit` requests must be allowed. No more.
		// The token bucket starts with `limit` tokens and each Allow() consumes one.
		if allowed > int64(limit) {
			t.Fatalf("rate limiter bypass! allowed %d requests but limit is %d", allowed, limit)
		}
		if allowed+denied != goroutines {
			t.Fatalf("total mismatch: allowed=%d + denied=%d != %d", allowed, denied, goroutines)
		}
		// At least some requests must be denied (200 > 60).
		if denied == 0 {
			t.Fatal("expected some denied requests when sending 200 concurrent to a limit-60 bucket")
		}
	})

	// TRACE: {"suite": "CORE", "case": "1185", "section": "34", "sectionName": "Thesis: Loyalty", "title": "per_IP_isolation_under_concurrent_load"}
	t.Run("per_IP_isolation_under_concurrent_load", func(t *testing.T) {
		// Verify that concurrent requests from DIFFERENT IPs don't interfere.
		// Each IP gets its own independent bucket.
		const ipsCount = 5
		const perIP = 50

		for i := 0; i < ipsCount; i++ {
			rl.Reset(fmt.Sprintf("172.16.0.%d", i))
		}

		var wg sync.WaitGroup
		allowedPerIP := make([]int64, ipsCount)

		for ipIdx := 0; ipIdx < ipsCount; ipIdx++ {
			for req := 0; req < perIP; req++ {
				wg.Add(1)
				go func(idx int) {
					defer wg.Done()
					ip := fmt.Sprintf("172.16.0.%d", idx)
					result := rl.Check(ip)
					if result.Allowed {
						atomic.AddInt64(&allowedPerIP[idx], 1)
					}
				}(ipIdx)
			}
		}
		wg.Wait()

		// Each IP should get its full limit (50 < 60 limit).
		for i := 0; i < ipsCount; i++ {
			if allowedPerIP[i] != perIP {
				t.Errorf("IP 172.16.0.%d: expected %d allowed, got %d (cross-IP interference)",
					i, perIP, allowedPerIP[i])
			}
		}
	})

	// TRACE: {"suite": "CORE", "case": "1186", "section": "34", "sectionName": "Thesis: Loyalty", "title": "no_panics_under_heavy_concurrent_access"}
	t.Run("no_panics_under_heavy_concurrent_access", func(t *testing.T) {
		// Stress test: 500 goroutines hit the rate limiter simultaneously.
		// Must not panic, deadlock, or produce data races.
		const stress = 500
		var wg sync.WaitGroup
		wg.Add(stress)

		for i := 0; i < stress; i++ {
			go func(n int) {
				defer wg.Done()
				ip := fmt.Sprintf("stress.%d", n%10)
				rl.Check(ip)
			}(i)
		}
		wg.Wait()
		// If we reach here without panic/deadlock, the test passes.
	})

	// TRACE: {"suite": "CORE", "case": "1187", "section": "34", "sectionName": "Thesis: Loyalty", "title": "after_window_reset_quota_restored_under_concurrency"}
	t.Run("after_window_reset_quota_restored_under_concurrency", func(t *testing.T) {
		// Verify that after the window resets, the token bucket is replenished.
		// Use a short-window limiter.
		shortRL := auth.NewRateLimitChecker(10, 1) // 10 req/sec
		ip := "10.20.30.40"
		shortRL.Reset(ip)

		// Exhaust the quota.
		for i := 0; i < 10; i++ {
			shortRL.Check(ip)
		}
		result := shortRL.Check(ip)
		if result.Allowed {
			t.Fatal("expected denial after exhausting quota")
		}

		// Wait for window to reset.
		time.Sleep(1100 * time.Millisecond)

		// After reset, concurrent requests should succeed again.
		var allowed int64
		var wg sync.WaitGroup
		const burst = 8
		wg.Add(burst)
		for i := 0; i < burst; i++ {
			go func() {
				defer wg.Done()
				if shortRL.Check(ip).Allowed {
					atomic.AddInt64(&allowed, 1)
				}
			}()
		}
		wg.Wait()

		if allowed != burst {
			t.Fatalf("after window reset, expected %d allowed, got %d", burst, allowed)
		}
	})

	// TRACE: {"suite": "CORE", "case": "1188", "section": "34", "sectionName": "Thesis: Loyalty", "title": "positive_control_sequential_requests_work"}
	t.Run("positive_control_sequential_requests_work", func(t *testing.T) {
		// Contrast check: sequential requests below limit all succeed.
		// Without this, the test passes if the rate limiter rejects everything.
		seqRL := auth.NewRateLimitChecker(20, 60)
		ip := "10.99.99.99"
		seqRL.Reset(ip)

		for i := 0; i < 20; i++ {
			result := seqRL.Check(ip)
			if !result.Allowed {
				t.Fatalf("sequential request %d should be allowed (limit=20)", i)
			}
		}
		// 21st should be denied.
		result := seqRL.Check(ip)
		if result.Allowed {
			t.Fatal("request beyond limit should be denied even sequentially")
		}
	})
}
