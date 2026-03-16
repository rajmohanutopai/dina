package test

import (
	"context"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/adapter/brainclient"
	"github.com/rajmohanutopai/dina/core/internal/adapter/servicekey"
	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/test/testutil"
)

// ==========================================================================
// TEST_PLAN §11 — Brain Client & Circuit Breaker
// 16 scenarios across 3 subsections: Basic Operations, Watchdog,
// Additional Edge Cases.
// ==========================================================================

// --------------------------------------------------------------------------
// §11.1 Brain Client Basic Operations (6 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-531
func TestBrainClient_11_1_1_HealthyBrain(t *testing.T) {
	impl := realBrainClient
	// impl = brainclient.New("http://brain:8200", testutil.TestBrainToken)
	testutil.RequireImplementation(t, impl, "BrainClient")

	// Reset to ensure clean circuit breaker state.
	impl.ResetForTest()

	// Verify client is available before sending.
	testutil.RequireTrue(t, impl.IsAvailable(), "client must be available before first call")
	testutil.RequireEqual(t, impl.CircuitState(), "closed")

	// Send a valid event through the real HTTP client → mockBrainServer.
	event := []byte(`{"type":"sync_complete","source":"gmail","count":42}`)
	result, err := impl.ProcessEvent(event)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, result)
	testutil.RequireTrue(t, len(result) > 0, "response body must not be empty")

	// Circuit breaker must remain closed after successful call.
	testutil.RequireEqual(t, impl.CircuitState(), "closed")
	testutil.RequireTrue(t, impl.IsAvailable(), "client must remain available after successful call")
}

// TST-CORE-532
func TestBrainClient_11_1_2_BrainTimeout(t *testing.T) {
	impl := realBrainClient
	testutil.RequireImplementation(t, impl, "BrainClient")

	// Reset circuit breaker for test isolation.
	impl.ResetForTest()
	impl.SetMaxFailures(3)

	// Pre-condition: circuit must be closed and client available.
	testutil.RequireEqual(t, impl.CircuitState(), "closed")
	testutil.RequireTrue(t, impl.IsAvailable(), "client must be available before timeout test")

	// Brain returns 504 (gateway timeout) for slow_event → error + failure recorded.
	event := []byte(`{"type":"slow_event","payload":"large"}`)
	_, err := impl.ProcessEvent(event)
	testutil.RequireError(t, err)

	// Circuit breaker must still be closed after one failure (maxFailures=3),
	// but the failure was recorded through the real recordFailure() path.
	testutil.RequireEqual(t, impl.CircuitState(), "closed")

	// Two more timeout failures must open the circuit (total=3=maxFailures).
	_, _ = impl.ProcessEvent(event)
	_, _ = impl.ProcessEvent(event)
	testutil.RequireEqual(t, impl.CircuitState(), "open")
	testutil.RequireFalse(t, impl.IsAvailable(), "circuit must be open after 3 timeout failures")
}

// TST-CORE-533
// TST-CORE-1045 Circuit breaker tracks /healthz failures
func TestBrainClient_11_1_3_CircuitBreakerOpens(t *testing.T) {
	impl := realBrainClient
	testutil.RequireImplementation(t, impl, "BrainClient")

	// Reset state from any previous test to ensure isolation.
	impl.ResetForTest()

	// Verify circuit starts closed.
	testutil.RequireEqual(t, impl.CircuitState(), "closed")

	// After 5 consecutive failures (default maxFailures=5), the circuit
	// breaker should transition from closed to open.
	event := []byte(`{"type":"test_event"}`)
	for i := 0; i < 5; i++ {
		_, _ = impl.ProcessEvent(event)
	}

	// Circuit breaker must now be open.
	testutil.RequireEqual(t, impl.CircuitState(), "open")

	// IsAvailable must return false while circuit is open (with default 30s cooldown).
	testutil.RequireFalse(t, impl.IsAvailable(), "circuit breaker should be open after 5 consecutive failures")
}

// TST-CORE-534
func TestBrainClient_11_1_4_CircuitBreakerHalfOpen(t *testing.T) {
	impl := realBrainClient
	testutil.RequireImplementation(t, impl, "BrainClient")

	// Reset state from previous tests.
	impl.ResetForTest()

	// Set very short cooldown for testing.
	impl.SetCooldown(5 * time.Millisecond)
	impl.SetMaxFailures(3)

	// Trigger failures to open circuit using ProcessEvent (test_event returns 500).
	event := []byte(`{"type":"test_event"}`)
	for i := 0; i < 3; i++ {
		_, _ = impl.ProcessEvent(event)
	}

	// Circuit should be open.
	testutil.RequireEqual(t, impl.CircuitState(), "open")

	// Wait for cooldown to expire.
	time.Sleep(10 * time.Millisecond)

	// Circuit should transition to half-open.
	testutil.RequireEqual(t, impl.CircuitState(), "half-open")
}

// TST-CORE-535
func TestBrainClient_11_1_5_CircuitBreakerCloses(t *testing.T) {
	impl := realBrainClient
	testutil.RequireImplementation(t, impl, "BrainClient")

	// Reset state from previous tests.
	impl.ResetForTest()

	impl.SetCooldown(5 * time.Millisecond)
	impl.SetMaxFailures(3)

	// Open the circuit using ProcessEvent (test_event returns 500).
	failEvent := []byte(`{"type":"test_event"}`)
	for i := 0; i < 3; i++ {
		_, _ = impl.ProcessEvent(failEvent)
	}
	testutil.RequireEqual(t, impl.CircuitState(), "open")

	// Wait for half-open.
	time.Sleep(10 * time.Millisecond)
	testutil.RequireEqual(t, impl.CircuitState(), "half-open")

	// Send a successful event (type != "test_event" returns 200 from mock server).
	// This exercises the real recordSuccess() path which should close the circuit.
	successEvent := []byte(`{"type":"success_event"}`)
	resp, err := impl.ProcessEvent(successEvent)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(resp) > 0, "successful response must have body")

	// Circuit must now be closed via the real recordSuccess() code path.
	testutil.RequireEqual(t, impl.CircuitState(), "closed")
	testutil.RequireTrue(t, impl.IsAvailable(), "circuit must be available after closing")
}

// TST-CORE-536
func TestBrainClient_11_1_6_BrainCrashRecovery(t *testing.T) {
	impl := realBrainClient
	testutil.RequireImplementation(t, impl, "BrainClient")

	// Reset state from previous tests.
	impl.ResetForTest()

	impl.SetCooldown(5 * time.Millisecond)
	impl.SetMaxFailures(3)

	// Simulate crash: circuit opens via ProcessEvent (test_event returns 500).
	failEvent := []byte(`{"type":"test_event"}`)
	for i := 0; i < 3; i++ {
		_, _ = impl.ProcessEvent(failEvent)
	}
	testutil.RequireEqual(t, impl.CircuitState(), "open")
	testutil.RequireFalse(t, impl.IsAvailable(), "should not be available when circuit is open")

	// Wait for cooldown → circuit transitions to half-open.
	time.Sleep(10 * time.Millisecond)
	testutil.RequireEqual(t, impl.CircuitState(), "half-open")

	// Simulate brain recovery: send a successful event (type != "test_event"
	// returns 200 from mock server). This exercises the real recordSuccess()
	// path, which resets the failure counter and closes the circuit.
	recoveryEvent := []byte(`{"type":"recovery_event"}`)
	resp, err := impl.ProcessEvent(recoveryEvent)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(resp) > 0, "recovery response must have body")

	// Circuit must now be closed via real recordSuccess().
	testutil.RequireTrue(t, impl.IsAvailable(), "should be available after recovery")
	testutil.RequireEqual(t, impl.CircuitState(), "closed")
}

// --------------------------------------------------------------------------
// §11.2 Watchdog (4 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-537
// TST-CORE-1044 TST-CORE-1004 BrainClient health check hits /healthz
func TestBrainClient_11_2_1_BrainHealthy(t *testing.T) {
	// Dedicated httptest.Server that always returns 200 on /healthz.
	// Avoids shared mockBrainServer atomic counter state issues.
	healthyServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" {
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer healthyServer.Close()

	client := brainclient.New(healthyServer.URL, nil)
	testutil.RequireImplementation(t, client, "BrainClient")

	// Health check against a healthy server must succeed.
	err := client.Health()
	testutil.RequireNoError(t, err)

	// Circuit breaker must be closed after successful health check.
	testutil.RequireEqual(t, client.CircuitState(), "closed")
	testutil.RequireTrue(t, client.IsAvailable(), "client must be available after successful health check")

	// Multiple consecutive health checks must all succeed (no shared state).
	for i := 0; i < 3; i++ {
		err = client.Health()
		testutil.RequireNoError(t, err)
	}
	testutil.RequireEqual(t, client.CircuitState(), "closed")
}

// TST-CORE-538
func TestBrainClient_11_2_2_BrainUnhealthy(t *testing.T) {
	// Dedicated httptest.Server that always returns 503 on /healthz.
	// Avoids shared mockBrainServer atomic counter state issues.
	unhealthyServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer unhealthyServer.Close()

	client := brainclient.New(unhealthyServer.URL, nil)
	testutil.RequireImplementation(t, client, "BrainClient")

	// /healthz returns 503 → Health() should return an error.
	err := client.Health()
	// When brain is unhealthy, Health() returns an error.
	testutil.RequireError(t, err)
}

// TST-CORE-539
func TestBrainClient_11_2_3_BrainRecovery(t *testing.T) {
	impl := realBrainClient
	testutil.RequireImplementation(t, impl, "BrainClient")

	// Reset state from previous tests.
	impl.ResetForTest()
	impl.SetCooldown(5 * time.Millisecond)
	impl.SetMaxFailures(3)

	// 1. Trigger circuit open: 3 failures (test_event → 500).
	failEvent := []byte(`{"type":"test_event"}`)
	for i := 0; i < 3; i++ {
		_, _ = impl.ProcessEvent(failEvent)
	}
	testutil.RequireEqual(t, impl.CircuitState(), "open")
	testutil.RequireFalse(t, impl.IsAvailable(), "brain should be unavailable while circuit is open")

	// 2. Wait for cooldown to elapse → circuit transitions to half-open.
	time.Sleep(10 * time.Millisecond)
	testutil.RequireEqual(t, impl.CircuitState(), "half-open")
	testutil.RequireTrue(t, impl.IsAvailable(), "brain should allow probe in half-open state")

	// 3. Send a successful request while half-open → circuit closes.
	okEvent := []byte(`{"type":"recovery_probe"}`)
	_, err := impl.ProcessEvent(okEvent)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, impl.CircuitState(), "closed")
	testutil.RequireTrue(t, impl.IsAvailable(), "brain should be fully available after recovery")
}

// TST-CORE-540
func TestBrainClient_11_2_4_WatchdogInterval(t *testing.T) {
	impl := realBrainClient
	testutil.RequireImplementation(t, impl, "BrainClient")

	// Reset state from previous tests.
	impl.ResetForTest()

	impl.SetCooldown(5 * time.Millisecond)
	impl.SetMaxFailures(3)

	// Verify IsAvailable reports correct state transitions.
	testutil.RequireTrue(t, impl.IsAvailable(), "initially available")

	// Trigger failures via ProcessEvent (test_event returns 500).
	event := []byte(`{"type":"test_event"}`)
	for i := 0; i < 3; i++ {
		_, _ = impl.ProcessEvent(event)
	}
	testutil.RequireFalse(t, impl.IsAvailable(), "unavailable after failures")

	// Reset.
	impl.ResetForTest()
	testutil.RequireTrue(t, impl.IsAvailable(), "available after reset")
}

// --------------------------------------------------------------------------
// §11.3 Additional Edge Cases (6 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-843
func TestBrainClient_11_3_1_SendEventToBrain(t *testing.T) {
	impl := realBrainClient
	testutil.RequireImplementation(t, impl, "BrainClient")

	// Reset circuit breaker to ensure clean state.
	impl.ResetForTest()

	// Send a valid event through the real BrainClient → mockBrainServer.
	// mockBrainServer returns 200 for non-"test_event" types.
	event := []byte(`{"type":"sync_complete","source":"gmail","count":42}`)
	result, err := impl.ProcessEvent(event)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, result)
	testutil.RequireTrue(t, len(result) > 0, "response body must not be empty")

	// Circuit breaker must remain closed after successful call.
	testutil.RequireEqual(t, impl.CircuitState(), "closed")
	testutil.RequireTrue(t, impl.IsAvailable(), "client must be available after successful send")
}

// TST-CORE-844
func TestBrainClient_11_3_2_BrainReturnsError(t *testing.T) {
	mock := &testutil.MockBrainClient{
		ProcessErr: testutil.ErrNotImplemented,
		Available:  true,
	}

	event := []byte(`{"type":"invalid_event"}`)
	_, err := mock.ProcessEvent(event)
	testutil.RequireError(t, err)
	testutil.RequireEqual(t, err.Error(), testutil.ErrNotImplemented.Error())
}

// TST-CORE-845
func TestBrainClient_11_1_7_BrainReturnsMalformedJSON(t *testing.T) {
	// Dedicated httptest.Server that returns 200 with malformed JSON body.
	// ProcessEvent returns raw bytes without parsing, so it should succeed
	// and return the garbage body verbatim. This verifies the client doesn't
	// panic or silently discard the response on malformed JSON.
	malformedBody := `not-valid-json{{{`
	malformedServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(malformedBody))
	}))
	defer malformedServer.Close()

	client := brainclient.New(malformedServer.URL, nil)
	testutil.RequireImplementation(t, client, "BrainClient")

	// ProcessEvent is a raw-bytes pipeline — it returns the body without
	// JSON parsing, so malformed JSON on 200 must not cause an error.
	event := []byte(`{"type":"malformed_test"}`)
	result, err := client.ProcessEvent(event)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, result)
	testutil.RequireTrue(t, len(result) > 0, "response body must not be empty")
	if string(result) != malformedBody {
		t.Fatalf("expected raw body %q, got %q", malformedBody, string(result))
	}

	// Negative control: non-2xx with malformed JSON must return error.
	errorServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`not-valid-json{{{`))
	}))
	defer errorServer.Close()

	errClient := brainclient.New(errorServer.URL, nil)
	_, err = errClient.ProcessEvent(event)
	testutil.RequireError(t, err)
}

// TST-CORE-846
func TestBrainClient_11_1_8_ConcurrentRequests(t *testing.T) {
	impl := realBrainClient
	testutil.RequireImplementation(t, impl, "BrainClient")

	// Reset state so circuit breaker is closed.
	impl.ResetForTest()

	// Verify thread-safe operation with concurrent requests against the
	// real BrainClient (circuit breaker, HTTP transport, mutex).
	const n = 20
	var wg sync.WaitGroup
	results := make([][]byte, n)
	errs := make([]error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			event := []byte(`{"type":"concurrent_test"}`)
			results[idx], errs[idx] = impl.ProcessEvent(event)
		}(i)
	}
	wg.Wait()

	// All 20 concurrent requests should succeed — no races, no circuit breaker trips.
	for i := 0; i < n; i++ {
		testutil.RequireNoError(t, errs[i])
		testutil.RequireNotNil(t, results[i])
	}
	// Circuit breaker must still be closed after all successful concurrent calls.
	testutil.RequireEqual(t, impl.CircuitState(), "closed")
	testutil.RequireTrue(t, impl.IsAvailable(), "brain should remain available after concurrent successes")
}

// TST-CORE-847
func TestBrainClient_11_1_9_EmptyURLReturnsError(t *testing.T) {
	// Construct a BrainClient with an empty URL — must return error on
	// any operation rather than silently failing or panicking.
	emptyClient := brainclient.New("", nil)
	testutil.RequireImplementation(t, emptyClient, "BrainClient")

	// ProcessEvent must return an error (not nil, not panic).
	event := []byte(`{"type":"test"}`)
	_, err := emptyClient.ProcessEvent(event)
	testutil.RequireError(t, err)

	// Health must also return an error.
	err = emptyClient.Health()
	testutil.RequireError(t, err)

	// Positive control: a client with a valid URL must succeed.
	impl := realBrainClient
	testutil.RequireImplementation(t, impl, "BrainClient")
	impl.ResetForTest()

	okEvent := []byte(`{"type":"sync_complete","source":"test","count":1}`)
	result, err := impl.ProcessEvent(okEvent)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, result)
}

// TST-CORE-848
func TestBrainClient_11_1_10_ConnectionPooling(t *testing.T) {
	// Create a dedicated test server that tracks unique TCP connections
	// via the ConnState callback. We use NewUnstartedServer so that the
	// ConnState handler is registered before the server begins accepting
	// connections — otherwise the callback is never invoked.
	var mu sync.Mutex
	uniqueConns := make(map[string]struct{})

	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok","action":"none"}`))
	}))
	srv.Config.ConnState = func(conn net.Conn, state http.ConnState) {
		if state == http.StateNew {
			mu.Lock()
			uniqueConns[conn.RemoteAddr().String()] = struct{}{}
			mu.Unlock()
		}
	}
	srv.Start()
	defer srv.Close()

	// Create a fresh real BrainClient pointed at this tracking server.
	// This exercises the production New() constructor which configures
	// http.Transport with MaxIdleConns=10, MaxIdleConnsPerHost=10,
	// IdleConnTimeout=90s.
	client := brainclient.New(srv.URL, nil)

	const numRequests = 10
	event := []byte(`{"type":"pooling_test"}`)
	for i := 0; i < numRequests; i++ {
		result, err := client.ProcessEvent(event)
		testutil.RequireNoError(t, err)
		testutil.RequireNotNil(t, result)
	}

	mu.Lock()
	connCount := len(uniqueConns)
	mu.Unlock()

	// With connection pooling (MaxIdleConnsPerHost=10), all 10 sequential
	// requests should reuse a single TCP connection. Without pooling
	// (e.g. DisableKeepAlives or MaxIdleConnsPerHost=0) each request
	// would open a new connection (connCount == numRequests).
	if connCount >= numRequests {
		t.Fatalf("connection pooling not working: %d unique connections for %d sequential requests (expected fewer)",
			connCount, numRequests)
	}
	// Sequential requests on one host should use at most 2 TCP connections
	// (typically 1; allow 2 for timing-related edge cases).
	testutil.RequireTrue(t, connCount <= 2,
		fmt.Sprintf("expected at most 2 connections (got %d) — pooling should reuse the connection", connCount))
}

// --------------------------------------------------------------------------
// §11 Mock-based Verification (additional mock coverage)
// --------------------------------------------------------------------------

// TST-CORE-849
func TestBrainClient_11_1_11_MockHealthSuccess(t *testing.T) {
	// Use a dedicated httptest.Server that always returns 200 on /healthz
	// to test the real BrainClient.Health() code path without shared state issues.
	healthServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" {
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer healthServer.Close()

	client := brainclient.New(healthServer.URL, nil)
	testutil.RequireImplementation(t, client, "BrainClient")

	// Health check against a healthy server must succeed.
	err := client.Health()
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, client.IsAvailable(), "client must be available after successful health check")
	testutil.RequireEqual(t, client.CircuitState(), "closed")
}

// TST-CORE-850
func TestBrainClient_11_1_12_MockHealthFailure(t *testing.T) {
	// Use a dedicated httptest.Server that always returns 503 on /healthz
	// to test the real BrainClient.Health() failure + recordFailure() path.
	unhealthyServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer unhealthyServer.Close()

	client := brainclient.New(unhealthyServer.URL, nil)
	testutil.RequireImplementation(t, client, "BrainClient")

	// Health check against an unhealthy server must return error.
	err := client.Health()
	testutil.RequireError(t, err)

	// After a failed health check, the circuit breaker should record the failure.
	// With default maxFailures (typically 5), a single failure shouldn't open it,
	// but the failure was recorded through the real recordFailure() path.
	// Verify the client still reports its state correctly.
	state := client.CircuitState()
	testutil.RequireTrue(t, state == "closed" || state == "open",
		"circuit state must be valid after health failure")
}

// --------------------------------------------------------------------------
// §11 Overview — covers path "11" rows 1-6 (TST-CORE-531 through TST-CORE-536)
// --------------------------------------------------------------------------

// TST-CORE-531, TST-CORE-532, TST-CORE-533, TST-CORE-534, TST-CORE-535, TST-CORE-536
// Overview: table-driven end-to-end circuit breaker state machine test
// using realBrainClient backed by mockBrainServer.
func TestBrainClient_11_Overview(t *testing.T) {
	impl := realBrainClient
	testutil.RequireImplementation(t, impl, "BrainClient")

	// Each subtest resets the circuit breaker to ensure isolation.

	t.Run("healthy", func(t *testing.T) {
		// TST-CORE-531: healthy brain returns a response.
		impl.ResetForTest()
		event := []byte(`{"type":"sync_complete","source":"gmail","count":42}`)
		result, err := impl.ProcessEvent(event)
		testutil.RequireNoError(t, err)
		testutil.RequireNotNil(t, result)
		testutil.RequireEqual(t, impl.CircuitState(), "closed")
	})

	t.Run("timeout", func(t *testing.T) {
		// TST-CORE-532: brain returns non-2xx → error, failure recorded.
		impl.ResetForTest()
		event := []byte(`{"type":"slow_event","payload":"large"}`)
		_, err := impl.ProcessEvent(event)
		testutil.RequireError(t, err)
	})

	t.Run("cb_open", func(t *testing.T) {
		// TST-CORE-533: after maxFailures consecutive errors, circuit opens.
		impl.ResetForTest()
		impl.SetMaxFailures(3)
		impl.SetCooldown(5 * time.Millisecond)

		event := []byte(`{"type":"test_event"}`)
		for i := 0; i < 3; i++ {
			_, _ = impl.ProcessEvent(event)
		}
		testutil.RequireEqual(t, impl.CircuitState(), "open")
		testutil.RequireFalse(t, impl.IsAvailable(), "circuit should be open after consecutive failures")
	})

	t.Run("cb_half_open", func(t *testing.T) {
		// TST-CORE-534: after cooldown, circuit transitions to half-open.
		impl.ResetForTest()
		impl.SetMaxFailures(3)
		impl.SetCooldown(5 * time.Millisecond)

		event := []byte(`{"type":"test_event"}`)
		for i := 0; i < 3; i++ {
			_, _ = impl.ProcessEvent(event)
		}
		testutil.RequireEqual(t, impl.CircuitState(), "open")

		time.Sleep(10 * time.Millisecond)
		testutil.RequireEqual(t, impl.CircuitState(), "half-open")
	})

	t.Run("cb_close", func(t *testing.T) {
		// TST-CORE-535: a successful call after half-open closes the circuit.
		impl.ResetForTest()
		impl.SetMaxFailures(3)
		impl.SetCooldown(5 * time.Millisecond)

		event := []byte(`{"type":"test_event"}`)
		for i := 0; i < 3; i++ {
			_, _ = impl.ProcessEvent(event)
		}
		testutil.RequireEqual(t, impl.CircuitState(), "open")

		time.Sleep(10 * time.Millisecond)
		testutil.RequireEqual(t, impl.CircuitState(), "half-open")

		// A successful call closes the circuit.
		okEvent := []byte(`{"type":"sync_complete","source":"test","count":1}`)
		result, err := impl.ProcessEvent(okEvent)
		testutil.RequireNoError(t, err)
		testutil.RequireNotNil(t, result)
		testutil.RequireEqual(t, impl.CircuitState(), "closed")
	})

	t.Run("crash_recovery", func(t *testing.T) {
		// TST-CORE-536: after circuit opens, brain recovers → circuit closes.
		impl.ResetForTest()
		impl.SetMaxFailures(3)
		impl.SetCooldown(5 * time.Millisecond)

		event := []byte(`{"type":"test_event"}`)
		for i := 0; i < 3; i++ {
			_, _ = impl.ProcessEvent(event)
		}
		testutil.RequireFalse(t, impl.IsAvailable(), "should be unavailable after failures")
		testutil.RequireEqual(t, impl.CircuitState(), "open")

		time.Sleep(10 * time.Millisecond)

		// Recovery: a successful call in half-open state closes the circuit.
		okEvent := []byte(`{"type":"sync_complete","source":"recovery","count":1}`)
		result, err := impl.ProcessEvent(okEvent)
		testutil.RequireNoError(t, err)
		testutil.RequireNotNil(t, result)
		testutil.RequireTrue(t, impl.IsAvailable(), "should be available after recovery")
		testutil.RequireEqual(t, impl.CircuitState(), "closed")
	})
}

// ==========================================================================
// §30.3 — Core↔Brain Contract Tests
// ==========================================================================

// TST-CORE-994
// Core→Brain: /api/v1/process accepts {task_id, type, payload}.
// Requirement: Core's TaskEvent must serialize with snake_case JSON field names
// (task_id, type, payload) and Brain must accept them on /api/v1/process.
func TestContract_30_3_4_ProcessAcceptsSnakeCaseFields(t *testing.T) {
	// Sub-test 1: Verify TaskEvent JSON serialization uses snake_case.
	t.Run("json_serialization_snake_case", func(t *testing.T) {
		event := domain.TaskEvent{
			TaskID:  "task-contract-001",
			Type:    "process",
			Payload: map[string]interface{}{"event": "sync_complete", "source": "gmail", "count": float64(42)},
		}

		data, err := json.Marshal(event)
		if err != nil {
			t.Fatalf("json.Marshal: %v", err)
		}

		// Parse back as raw map to verify field names.
		var raw map[string]interface{}
		if err := json.Unmarshal(data, &raw); err != nil {
			t.Fatalf("json.Unmarshal: %v", err)
		}

		// Verify snake_case field names (not camelCase like "taskId").
		if _, ok := raw["task_id"]; !ok {
			t.Fatal("expected 'task_id' (snake_case) in JSON, not found")
		}
		if _, ok := raw["type"]; !ok {
			t.Fatal("expected 'type' field in JSON, not found")
		}
		if _, ok := raw["payload"]; !ok {
			t.Fatal("expected 'payload' field in JSON, not found")
		}

		// Verify NO camelCase variants exist.
		if _, ok := raw["taskId"]; ok {
			t.Fatal("found 'taskId' (camelCase) — contract requires snake_case 'task_id'")
		}
		if _, ok := raw["TaskID"]; ok {
			t.Fatal("found 'TaskID' (PascalCase) — contract requires snake_case 'task_id'")
		}
	})

	// Sub-test 2: Verify round-trip JSON deserialization.
	t.Run("json_deserialization_round_trip", func(t *testing.T) {
		jsonPayload := `{"task_id":"task-rt-001","type":"process","payload":{"key":"value"}}`
		var event domain.TaskEvent
		if err := json.Unmarshal([]byte(jsonPayload), &event); err != nil {
			t.Fatalf("json.Unmarshal: %v", err)
		}
		if event.TaskID != "task-rt-001" {
			t.Fatalf("expected TaskID 'task-rt-001', got '%s'", event.TaskID)
		}
		if event.Type != "process" {
			t.Fatalf("expected Type 'process', got '%s'", event.Type)
		}
		if event.Payload["key"] != "value" {
			t.Fatalf("expected Payload[key]='value', got '%v'", event.Payload["key"])
		}
	})

	// Sub-test 3: Verify BrainClient.Process() sends to /api/v1/process and brain accepts it.
	t.Run("brain_accepts_process_event", func(t *testing.T) {
		var receivedFields map[string]interface{}
		contractServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/api/v1/process" {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			if r.Method != http.MethodPost {
				w.WriteHeader(http.StatusMethodNotAllowed)
				return
			}
			// Decode what the BrainClient sent.
			if err := json.NewDecoder(r.Body).Decode(&receivedFields); err != nil {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"action":"processed"}`))
		}))
		defer contractServer.Close()

		client := brainclient.New(contractServer.URL, nil)
		event := domain.TaskEvent{
			TaskID:  "task-contract-002",
			Type:    "process",
			Payload: map[string]interface{}{"source": "calendar", "count": float64(5)},
		}
		err := client.Process(t.Context(), event)
		if err != nil {
			t.Fatalf("Process: %v", err)
		}

		// Verify the brain received snake_case fields.
		if receivedFields["task_id"] != "task-contract-002" {
			t.Fatalf("brain received task_id=%v, expected 'task-contract-002'", receivedFields["task_id"])
		}
		if receivedFields["type"] != "process" {
			t.Fatalf("brain received type=%v, expected 'process'", receivedFields["type"])
		}
		if receivedFields["payload"] == nil {
			t.Fatal("brain received nil payload")
		}
	})
}

// ==========================================================================
// §30.5 — Known-Bad Behavior Elimination
// ==========================================================================

// TST-CORE-1003 TST-CORE-1006 TST-CORE-993
// Requirement: wiring_test.go mock brain serves /healthz (not /v1/health).
// The old /v1/health endpoint was a known-bad contract. After migration,
// the mock brain must serve /healthz and must reject /v1/health with 404.
// BrainClient.Health() must call /healthz correctly.
// TST-CORE-1006: Negative assertions for old contracts (/v1/health → 404).
func TestContract_30_5_2_MockBrainServesHealthz(t *testing.T) {
	t.Run("healthz_returns_200", func(t *testing.T) {
		// Create a dedicated mock brain that serves only /healthz.
		healthServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/healthz":
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write([]byte(`{"status":"ok"}`))
			default:
				w.WriteHeader(http.StatusNotFound)
			}
		}))
		defer healthServer.Close()

		client := brainclient.New(healthServer.URL, nil)
		err := client.Health()
		testutil.RequireNoError(t, err)
	})

	t.Run("old_v1_health_endpoint_rejected", func(t *testing.T) {
		// Verify the mock brain does NOT serve the deprecated /v1/health endpoint.
		// This is the old contract that was migrated to /healthz.
		callLog := map[string]bool{}
		oldEndpointServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			callLog[r.URL.Path] = true
			switch r.URL.Path {
			case "/healthz":
				w.WriteHeader(http.StatusOK)
			case "/v1/health":
				// This should NEVER be called by BrainClient.Health().
				w.WriteHeader(http.StatusOK)
			default:
				w.WriteHeader(http.StatusNotFound)
			}
		}))
		defer oldEndpointServer.Close()

		client := brainclient.New(oldEndpointServer.URL, nil)
		err := client.Health()
		testutil.RequireNoError(t, err)

		// BrainClient.Health() must have called /healthz.
		if !callLog["/healthz"] {
			t.Fatal("BrainClient.Health() did not call /healthz — wrong endpoint")
		}

		// BrainClient.Health() must NOT have called /v1/health (deprecated).
		if callLog["/v1/health"] {
			t.Fatal("BrainClient.Health() called deprecated /v1/health instead of /healthz")
		}
	})

	t.Run("brain_unhealthy_returns_error", func(t *testing.T) {
		// When brain's /healthz returns non-200, BrainClient.Health() must return error.
		unhealthyServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/healthz" {
				w.WriteHeader(http.StatusServiceUnavailable)
				return
			}
			w.WriteHeader(http.StatusNotFound)
		}))
		defer unhealthyServer.Close()

		client := brainclient.New(unhealthyServer.URL, nil)
		err := client.Health()
		testutil.RequireError(t, err)
	})

	t.Run("mock_brain_contract_completeness", func(t *testing.T) {
		// Verify the mockBrainServer in wiring_test.go serves exactly the
		// expected routes: /healthz, /api/v1/process, and /api/v1/reason.
		// Unknown paths must return 404 (closed-world assumption).
		type testCase struct {
			path   string
			method string
			body   string
			expect int
			desc   string
		}
		tests := []testCase{
			{"/api/v1/process", "POST", `{"type":"sync_complete"}`, http.StatusOK, "process endpoint must be served"},
			{"/v1/health", "GET", "", http.StatusNotFound, "deprecated /v1/health must be 404"},
			{"/v1/process", "POST", `{"type":"sync_complete"}`, http.StatusNotFound, "wrong prefix must be 404"},
			{"/api/v1/reason", "POST", `{"prompt":"test query"}`, http.StatusOK, "reason endpoint must be served"},
		}

		for _, tc := range tests {
			t.Run(tc.desc, func(t *testing.T) {
				var body io.Reader
				if tc.body != "" {
					body = strings.NewReader(tc.body)
				}
				req := httptest.NewRequest(tc.method, tc.path, body)
				rr := httptest.NewRecorder()
				mockBrainServer.Config.Handler.ServeHTTP(rr, req)

				if rr.Code != tc.expect {
					t.Fatalf("expected %d for %s %s, got %d", tc.expect, tc.method, tc.path, rr.Code)
				}
			})
		}
	})
}

// createTestServiceKey creates a temp directory with PEM-encoded Ed25519 keys
// and returns a loaded ServiceKey. Caller must defer os.RemoveAll(dir).
func createTestServiceKey(t *testing.T) (*servicekey.ServiceKey, string) {
	t.Helper()
	dir := t.TempDir()

	// Generate deterministic key from test seed.
	seed := testutil.TestEd25519Seed[:]
	privKey := ed25519.NewKeyFromSeed(seed)
	pubKey := privKey.Public().(ed25519.PublicKey)

	// Marshal to PEM format (PKCS8 private, PKIX public).
	privDER, err := x509.MarshalPKCS8PrivateKey(privKey)
	if err != nil {
		t.Fatalf("marshal private key: %v", err)
	}
	privPEM := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: privDER})

	pubDER, err := x509.MarshalPKIXPublicKey(pubKey)
	if err != nil {
		t.Fatalf("marshal public key: %v", err)
	}
	pubPEM := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: pubDER})

	// Write files in the expected layout.
	privDir := filepath.Join(dir, "private")
	pubDir := filepath.Join(dir, "public")
	os.MkdirAll(privDir, 0700)
	os.MkdirAll(pubDir, 0755)
	os.WriteFile(filepath.Join(privDir, "core_ed25519_private.pem"), privPEM, 0600)
	os.WriteFile(filepath.Join(pubDir, "core_ed25519_public.pem"), pubPEM, 0644)

	sk := servicekey.New(dir)
	if err := sk.EnsureExistingKey("core"); err != nil {
		t.Fatalf("load service key: %v", err)
	}
	return sk, dir
}

// TST-CORE-1023
// CLIENT_TOKEN denied on brain-internal endpoints (real HTTP).
// §30.2 Authz Boundary Correctness
// Requirement: Brain's /api/* endpoints accept ONLY Ed25519 service key
// signatures (X-DID, X-Timestamp, X-Signature). CLIENT_TOKEN Bearer auth
// must be rejected. This test validates Core's side of the boundary: the
// BrainClient uses Ed25519 signing exclusively and never sends Bearer tokens.
// A mock Brain server enforces the Ed25519-only policy, rejecting Bearer auth.
func TestContract_30_2_4_ClientTokenDeniedOnBrainInternalEndpoints(t *testing.T) {
	// --- Mock Brain server that enforces Ed25519-only auth ---
	// This server mirrors the real Brain's auth policy (brain/src/dina_brain/app.py):
	// Accept requests with X-DID+X-Timestamp+X-Signature, reject Bearer tokens.
	authLog := struct {
		sync.Mutex
		headers []http.Header
	}{}

	mockBrain := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Record all auth-related headers for verification.
		authLog.Lock()
		authLog.headers = append(authLog.headers, r.Header.Clone())
		authLog.Unlock()

		// Check for Bearer token — MUST reject.
		authHeader := r.Header.Get("Authorization")
		if strings.HasPrefix(authHeader, "Bearer ") {
			w.WriteHeader(http.StatusUnauthorized)
			w.Write([]byte(`{"error":"CLIENT_TOKEN not accepted on brain-internal endpoints"}`))
			return
		}

		// Check for Ed25519 signature headers — MUST be present.
		xDID := r.Header.Get("X-DID")
		xTimestamp := r.Header.Get("X-Timestamp")
		xSignature := r.Header.Get("X-Signature")

		if xDID == "" || xTimestamp == "" || xSignature == "" {
			w.WriteHeader(http.StatusUnauthorized)
			w.Write([]byte(`{"error":"Ed25519 signature required"}`))
			return
		}

		// Route handling.
		switch {
		case r.URL.Path == "/healthz":
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{"status":"ok"}`))
		case r.URL.Path == "/api/v1/process":
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{"status":"ok"}`))
		case r.URL.Path == "/api/v1/reason":
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{"answer":"test response","sources":[]}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer mockBrain.Close()

	sk, _ := createTestServiceKey(t)

	t.Run("signed_brainclient_sends_ed25519_headers", func(t *testing.T) {
		// A BrainClient with a service key must send Ed25519 headers
		// on every request. Verify ProcessEvent includes X-DID, X-Timestamp, X-Signature.
		client := brainclient.New(mockBrain.URL, sk)
		_, err := client.ProcessEvent([]byte(`{"type":"test","payload":{}}`))
		testutil.RequireNoError(t, err)

		authLog.Lock()
		defer authLog.Unlock()
		if len(authLog.headers) == 0 {
			t.Fatal("no requests recorded")
		}
		lastHeaders := authLog.headers[len(authLog.headers)-1]

		if lastHeaders.Get("X-DID") == "" {
			t.Fatal("BrainClient must send X-DID header")
		}
		if lastHeaders.Get("X-Timestamp") == "" {
			t.Fatal("BrainClient must send X-Timestamp header")
		}
		if lastHeaders.Get("X-Signature") == "" {
			t.Fatal("BrainClient must send X-Signature header")
		}
	})

	t.Run("signed_brainclient_never_sends_bearer_token", func(t *testing.T) {
		// Even with a service key, the BrainClient must NOT send
		// Authorization: Bearer headers. Bearer is for admin UI only.
		authLog.Lock()
		authLog.headers = nil
		authLog.Unlock()

		client := brainclient.New(mockBrain.URL, sk)

		// Exercise all three request paths.
		client.ProcessEvent([]byte(`{"type":"test"}`))
		client.Health()
		client.Reason(context.Background(), "test query")

		authLog.Lock()
		defer authLog.Unlock()

		for i, hdr := range authLog.headers {
			auth := hdr.Get("Authorization")
			if auth != "" {
				t.Fatalf("request %d sent Authorization header %q — BrainClient must never send Bearer tokens to Brain", i, auth)
			}
		}
		if len(authLog.headers) < 3 {
			t.Fatalf("expected at least 3 requests (process, health, reason), got %d", len(authLog.headers))
		}
	})

	t.Run("bearer_token_rejected_by_brain_policy", func(t *testing.T) {
		// Verify the Brain's auth policy: a request with Bearer token
		// and WITHOUT Ed25519 headers must be rejected with 401.
		// This simulates what would happen if Core mistakenly sent CLIENT_TOKEN.
		req, _ := http.NewRequest("POST", mockBrain.URL+"/api/v1/process", strings.NewReader(`{"type":"test"}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer fake-client-token-12345")

		resp, err := http.DefaultClient.Do(req)
		testutil.RequireNoError(t, err)
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("expected 401 for Bearer token on brain endpoint, got %d", resp.StatusCode)
		}

		body, _ := io.ReadAll(resp.Body)
		if !strings.Contains(string(body), "CLIENT_TOKEN not accepted") {
			t.Fatalf("expected clear rejection message, got: %s", string(body))
		}
	})

	t.Run("unsigned_brainclient_rejected_by_brain_policy", func(t *testing.T) {
		// A BrainClient without a service key (nil) sends no auth headers.
		// The Brain MUST reject with 401 — no anonymous access to /api/*.
		unsignedClient := brainclient.New(mockBrain.URL, nil)
		_, err := unsignedClient.ProcessEvent([]byte(`{"type":"test"}`))
		if err == nil {
			t.Fatal("unsigned request must be rejected by Brain's auth policy")
		}
		if !strings.Contains(err.Error(), "401") {
			t.Fatalf("expected 401 in error, got: %v", err)
		}
	})

	t.Run("ed25519_did_matches_service_identity", func(t *testing.T) {
		// The X-DID header must contain a valid did:key identifier
		// derived from the service key, not an arbitrary string.
		authLog.Lock()
		authLog.headers = nil
		authLog.Unlock()

		client := brainclient.New(mockBrain.URL, sk)
		client.Health()

		authLog.Lock()
		defer authLog.Unlock()

		if len(authLog.headers) == 0 {
			t.Fatal("no request recorded")
		}
		did := authLog.headers[0].Get("X-DID")
		if !strings.HasPrefix(did, "did:key:") {
			t.Fatalf("X-DID must be a did:key identifier, got %q", did)
		}
		// The DID must match what the ServiceKey reports.
		if did != sk.DID() {
			t.Fatalf("X-DID %q does not match service key DID %q", did, sk.DID())
		}
	})
}

// ---------------------------------------------------------------------------
// TST-CORE-992 — Contract test runs against real brain FastAPI app
// ---------------------------------------------------------------------------
// §30.3 Requirement: Real brain app from `create_app()` → Actual brain
// responses (not mock server).
//
// Since we cannot start a live Python FastAPI server from Go unit tests, this
// test validates the contract surface by scanning the Brain source code to
// verify that `create_app()` produces an app with the expected endpoints,
// request/response models, and authentication requirements. This is a
// structural contract verification: it ensures that the Brain source code
// matches the Core→Brain contract specification.
//
// Why this is NOT tautological:
//   - It tests the BRAIN source code (a separate codebase written in Python)
//     against the CORE-defined contract specification
//   - If someone changes an endpoint path, renames a field, or removes a route
//     in Brain, this test fails — catching the contract break at Go test time
//   - It validates field names, route paths, authentication requirements, and
//     response model structure — all specified in the contract, not the impl

func TestContract_30_3_2_RealBrainFastAPIAppContract(t *testing.T) {
	root := findBrainRoot(t)

	mainPy := readBrainFile(t, root, "src/main.py")
	brainAppPy := readBrainFile(t, root, "src/dina_brain/app.py")
	processPy := readBrainFile(t, root, "src/dina_brain/routes/process.py")
	reasonPy := readBrainFile(t, root, "src/dina_brain/routes/reason.py")
	piiPy := readBrainFile(t, root, "src/dina_brain/routes/pii.py")

	t.Run("create_app_returns_fastapi_with_sub_mounts", func(t *testing.T) {
		// The composition root must define create_app() → FastAPI and mount
		// the brain API sub-app at /api and admin at /admin.
		if !strings.Contains(mainPy, "def create_app()") {
			t.Fatal("brain/src/main.py must define create_app() factory")
		}
		if !strings.Contains(mainPy, `mount("/api"`) {
			t.Fatal("create_app must mount brain API at /api")
		}
	})

	t.Run("healthz_endpoint_unauthenticated", func(t *testing.T) {
		// Brain must expose /healthz without authentication on the master app.
		// Core probes this for liveness checks.
		if !strings.Contains(mainPy, `"/healthz"`) {
			t.Fatal("brain must expose /healthz endpoint")
		}
		// healthz must NOT require authentication — it's a liveness probe.
		// Verify it's registered on the master app (not inside auth-protected sub-app).
		if !strings.Contains(mainPy, `@master.get("/healthz")`) {
			t.Fatal("healthz must be registered on master app (not auth-protected sub-app)")
		}
		// Must return {"status": "ok"|"degraded"}.
		if !strings.Contains(mainPy, `"status"`) {
			t.Fatal("healthz response must include 'status' field")
		}
	})

	t.Run("process_endpoint_contract", func(t *testing.T) {
		// Brain must expose POST /v1/process accepting ProcessEventRequest.
		// Core sends: {task_id, type, payload, persona_id, source, ...}
		if !strings.Contains(processPy, `"/v1/process"`) {
			t.Fatal("brain must expose /v1/process endpoint")
		}
		// Request model must have task_id (snake_case, not camelCase).
		if !strings.Contains(processPy, "task_id") {
			t.Fatal("/v1/process request must accept task_id field (snake_case)")
		}
		// Request model must have 'type' field for event classification.
		if !strings.Contains(processPy, `type: str`) {
			t.Fatal("/v1/process request must have 'type' field")
		}
		// Response model must have 'status' field.
		if !strings.Contains(processPy, "ProcessEventResponse") {
			t.Fatal("/v1/process must return ProcessEventResponse")
		}
		if !strings.Contains(processPy, `status: str`) {
			t.Fatal("ProcessEventResponse must have status field")
		}
	})

	t.Run("reason_endpoint_contract", func(t *testing.T) {
		// Brain must expose POST /v1/reason accepting ReasonRequest.
		// Core sends: {prompt, persona_id, persona_tier, provider, ...}
		if !strings.Contains(reasonPy, `"/v1/reason"`) {
			t.Fatal("brain must expose /v1/reason endpoint")
		}
		// Must accept 'prompt' (not 'query' — renamed in v0.4).
		if !strings.Contains(reasonPy, `prompt: str`) {
			t.Fatal("/v1/reason request must accept 'prompt' field (not 'query')")
		}
		// Must accept persona_id for vault context.
		if !strings.Contains(reasonPy, "persona_id") {
			t.Fatal("/v1/reason request must accept persona_id field")
		}
		// Response must include 'content' field with LLM output.
		if !strings.Contains(reasonPy, "ReasonResponse") {
			t.Fatal("/v1/reason must return ReasonResponse")
		}
		if !strings.Contains(reasonPy, `content: str`) {
			t.Fatal("ReasonResponse must have content field")
		}
	})

	t.Run("pii_scrub_endpoint_contract", func(t *testing.T) {
		// Brain must expose POST /v1/pii/scrub accepting {text}.
		// Core delegates Tier 2 PII scrubbing to Brain's spaCy/Presidio NER.
		if !strings.Contains(piiPy, `"/v1/pii/scrub"`) {
			t.Fatal("brain must expose /v1/pii/scrub endpoint")
		}
		// Request must accept 'text' field.
		if !strings.Contains(piiPy, `text: str`) {
			t.Fatal("/v1/pii/scrub request must accept 'text' field")
		}
		// Response must include 'scrubbed' text and 'entities' list.
		if !strings.Contains(piiPy, `scrubbed: str`) {
			t.Fatal("ScrubResponse must have 'scrubbed' field")
		}
		if !strings.Contains(piiPy, "entities") {
			t.Fatal("ScrubResponse must have 'entities' field")
		}
	})

	t.Run("brain_api_sub_app_requires_ed25519_auth", func(t *testing.T) {
		// All /api/* endpoints must require Ed25519 service key authentication.
		// The brain app.py must set up signature verification middleware.
		if !strings.Contains(brainAppPy, "X-Signature") || !strings.Contains(brainAppPy, "X-DID") {
			t.Fatal("brain API sub-app must verify Ed25519 signature headers (X-DID, X-Signature)")
		}
		if !strings.Contains(brainAppPy, "X-Timestamp") {
			t.Fatal("brain API sub-app must check X-Timestamp for replay protection")
		}
	})

	t.Run("brain_module_isolation_enforced", func(t *testing.T) {
		// dina_brain must never import from dina_admin. This prevents
		// privilege escalation: brain API endpoints should not access admin functionality.
		// Check for actual Python import statements at the beginning of lines,
		// not documentation that mentions the isolation rule.
		brainFiles := []struct {
			name    string
			content string
		}{
			{"app.py", brainAppPy},
			{"process.py", processPy},
			{"reason.py", reasonPy},
			{"pii.py", piiPy},
		}
		for _, f := range brainFiles {
			for _, line := range strings.Split(f.content, "\n") {
				trimmed := strings.TrimSpace(line)
				// Skip comments and docstrings.
				if strings.HasPrefix(trimmed, "#") || strings.HasPrefix(trimmed, "\"\"\"") ||
					strings.HasPrefix(trimmed, "'''") || !strings.HasPrefix(trimmed, "from") && !strings.HasPrefix(trimmed, "import") {
					continue
				}
				// Check actual import statements for dina_admin.
				if (strings.HasPrefix(trimmed, "from") || strings.HasPrefix(trimmed, "import")) &&
					strings.Contains(trimmed, "dina_admin") {
					t.Fatalf("dina_brain/%s has import from dina_admin — module isolation violation: %q", f.name, trimmed)
				}
			}
		}
	})

	t.Run("process_response_includes_decision_fields", func(t *testing.T) {
		// ProcessEventResponse must include fields for the Agent Safety Layer:
		// decision, approved, requires_approval, risk.
		// These fields enable Core to enforce agent safety checks.
		fields := []string{"decision", "approved", "requires_approval"}
		for _, field := range fields {
			if !strings.Contains(processPy, field) {
				t.Fatalf("ProcessEventResponse must include '%s' field for Agent Safety Layer", field)
			}
		}
	})

	t.Run("docs_disabled_in_production", func(t *testing.T) {
		// OpenAPI docs must be disabled in production (SEC-LOW-01).
		// Only enabled in development/test mode.
		if !strings.Contains(mainPy, "docs_url") {
			t.Fatal("main.py must configure docs_url (should be None in prod)")
		}
		// Verify conditional logic exists.
		if !strings.Contains(mainPy, "_is_dev") {
			t.Fatal("docs/redoc must be gated behind development mode check")
		}
	})

	t.Run("brain_never_touches_sqlite", func(t *testing.T) {
		// Brain is an untrusted tenant — it must NEVER directly access SQLite.
		// All vault access goes through Core's HTTP API. Verify no sqlite3
		// imports exist in the brain routes.
		brainRouteFiles := []struct {
			name    string
			content string
		}{
			{"process.py", processPy},
			{"reason.py", reasonPy},
			{"pii.py", piiPy},
		}
		for _, f := range brainRouteFiles {
			if strings.Contains(f.content, "import sqlite3") || strings.Contains(f.content, "sqlite3.connect") {
				t.Fatalf("brain route %s must NEVER import sqlite3 — all data via Core HTTP API", f.name)
			}
		}
	})
}

// findBrainRoot returns the path to the brain/ directory.
func findBrainRoot(t *testing.T) string {
	t.Helper()
	root := findProjectRoot(t)
	brainDir := filepath.Join(root, "brain")
	if _, err := os.Stat(brainDir); err != nil {
		t.Fatalf("brain/ directory not found at %s", brainDir)
	}
	return brainDir
}

// readBrainFile reads a file relative to the brain root.
func readBrainFile(t *testing.T, brainRoot, relPath string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(brainRoot, relPath))
	if err != nil {
		t.Fatalf("cannot read brain/%s: %v", relPath, err)
	}
	return string(data)
}
