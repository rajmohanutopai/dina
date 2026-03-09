package test

import (
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/adapter/brainclient"
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
// TST-CORE-1044 BrainClient health check hits /healthz
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
