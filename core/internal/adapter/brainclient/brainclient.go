// Package brainclient implements §11 Brain Client — an HTTP client for
// the brain sidecar with a circuit breaker pattern.
//
// The brain sidecar (Python/ADK) runs as a separate container. This client
// provides typed HTTP calls with:
//   - 30-second request timeout
//   - Circuit breaker: opens after 5 consecutive failures, fail-fast while open
//   - Connection pooling via http.Client transport
//   - Thread-safe operation for concurrent requests
package brainclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/adapter/servicekey"
	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/middleware"
	"github.com/rajmohanutopai/dina/core/internal/port"
)

// Sentinel errors.
var (
	ErrCircuitOpen = errors.New("brainclient: circuit breaker is open — brain unavailable")
	ErrEmptyURL    = errors.New("brainclient: brain URL must not be empty")
	ErrBrainHealth = errors.New("brainclient: brain health check failed")
)

// Circuit breaker states.
const (
	stateClosed   = "closed"
	stateOpen     = "open"
	stateHalfOpen = "half-open"
)

// Default configuration.
const (
	defaultTimeout     = 30 * time.Second
	defaultMaxFailures = 5
	defaultCooldown    = 30 * time.Second
)

// TraceEmitter records structured trace events (optional, nil-safe).
type TraceEmitter interface {
	Emit(ctx context.Context, step, component string, detail map[string]string)
}

// BrainClient implements testutil.BrainClient — typed HTTP calls to brain.
type BrainClient struct {
	mu         sync.Mutex
	baseURL    string
	serviceKey *servicekey.ServiceKey
	httpClient *http.Client
	Tracer     TraceEmitter // optional — emit brain_call/brain_response traces

	// Circuit breaker state.
	cbState     string
	failures    int
	lastFailure time.Time
	maxFailures int
	cooldown    time.Duration
}

// New returns a new BrainClient that signs requests with an Ed25519 service key.
func New(baseURL string, sk *servicekey.ServiceKey) *BrainClient {
	transport := &http.Transport{
		MaxIdleConns:        10,
		MaxIdleConnsPerHost: 10,
		IdleConnTimeout:     90 * time.Second,
	}
	return &BrainClient{
		baseURL:    baseURL,
		serviceKey: sk,
		httpClient: &http.Client{
			Timeout:   defaultTimeout,
			Transport: transport,
		},
		cbState:     stateClosed,
		maxFailures: defaultMaxFailures,
		cooldown:    defaultCooldown,
	}
}

// ProcessEvent sends an event to brain's guardian loop (POST /api/v1/process).
// Returns the response body or an error.
func (c *BrainClient) ProcessEvent(event []byte) ([]byte, error) {
	return c.ProcessEventWithContext(context.Background(), event)
}

// ProcessEventWithContext is like ProcessEvent but accepts a context for
// request-ID propagation and cancellation.
func (c *BrainClient) ProcessEventWithContext(ctx context.Context, event []byte) ([]byte, error) {
	c.mu.Lock()
	// Check circuit breaker state.
	if c.cbState == stateOpen {
		// Check if cooldown has elapsed for half-open transition.
		if time.Since(c.lastFailure) > c.cooldown {
			c.cbState = stateHalfOpen
		} else {
			c.mu.Unlock()
			return nil, ErrCircuitOpen
		}
	}
	c.mu.Unlock()

	if c.baseURL == "" {
		c.recordFailure()
		return nil, ErrEmptyURL
	}

	reqURL := c.baseURL + "/api/v1/process"

	// Trace: brain_call
	if c.Tracer != nil {
		c.Tracer.Emit(ctx, "brain_call", "core", map[string]string{
			"endpoint": "/api/v1/process",
		})
	}
	callStart := time.Now()

	req, err := http.NewRequestWithContext(ctx, "POST", reqURL, bytes.NewReader(event))
	if err != nil {
		c.recordFailure()
		return nil, fmt.Errorf("brainclient: request creation failed: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	c.signRequest(req, event)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		c.recordFailure()
		if c.Tracer != nil {
			c.Tracer.Emit(ctx, "brain_response", "core", map[string]string{
				"status": "error", "duration": time.Since(callStart).String(),
			})
		}
		return nil, fmt.Errorf("brainclient: request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		c.recordFailure()
		return nil, fmt.Errorf("brainclient: failed to read response: %w", err)
	}

	// Trace: brain_response
	if c.Tracer != nil {
		c.Tracer.Emit(ctx, "brain_response", "core", map[string]string{
			"status": fmt.Sprintf("%d", resp.StatusCode), "duration": time.Since(callStart).String(),
		})
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		c.recordFailure()
		return nil, fmt.Errorf("brainclient: brain returned status %d: %s", resp.StatusCode, string(body))
	}

	// Success — reset circuit breaker.
	c.recordSuccess()
	return body, nil
}

// Health checks brain's health endpoint (GET /healthz).
func (c *BrainClient) Health() error {
	if c.baseURL == "" {
		c.recordFailure()
		return ErrEmptyURL
	}

	reqURL := c.baseURL + "/healthz"
	req, err := http.NewRequest("GET", reqURL, nil)
	if err != nil {
		return fmt.Errorf("brainclient: health request creation failed: %w", err)
	}
	c.signRequest(req, nil)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		c.recordFailure()
		return fmt.Errorf("%w: %v", ErrBrainHealth, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		c.recordFailure()
		return fmt.Errorf("%w: status %d", ErrBrainHealth, resp.StatusCode)
	}

	c.recordSuccess()
	return nil
}

// IsAvailable returns true if the circuit breaker is closed (brain is reachable).
func (c *BrainClient) IsAvailable() bool {
	c.mu.Lock()
	defer c.mu.Unlock()

	switch c.cbState {
	case stateClosed:
		return true
	case stateHalfOpen:
		return true
	case stateOpen:
		// Check if cooldown elapsed.
		if time.Since(c.lastFailure) > c.cooldown {
			return true
		}
		return false
	}
	return false
}

// recordFailure increments the failure counter and opens the circuit if needed.
func (c *BrainClient) recordFailure() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.failures++
	c.lastFailure = time.Now()
	if c.failures >= c.maxFailures {
		c.cbState = stateOpen
	}
}

// recordSuccess resets the circuit breaker to closed state.
func (c *BrainClient) recordSuccess() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.failures = 0
	c.cbState = stateClosed
}

// signRequest adds auth headers to the request.
// If a service key is available, signs with Ed25519
// (X-DID/X-Timestamp/X-Signature).
func (c *BrainClient) signRequest(req *http.Request, body []byte) {
	if c.serviceKey != nil {
		parsed, _ := url.Parse(req.URL.String())
		path := req.URL.Path
		query := ""
		if parsed != nil {
			path = parsed.Path
			query = parsed.RawQuery
		}
		did, ts, nonce, sig := c.serviceKey.SignRequest(req.Method, path, query, body)
		req.Header.Set("X-DID", did)
		req.Header.Set("X-Timestamp", ts)
		req.Header.Set("X-Nonce", nonce)
		req.Header.Set("X-Signature", sig)
	}
	// Cross-service request-ID propagation for audit correlation.
	if rid, ok := req.Context().Value(middleware.RequestIDKey).(string); ok && rid != "" {
		req.Header.Set("X-Request-ID", rid)
	}
}

// Compile-time check: BrainClient satisfies port.BrainClient.
var _ port.BrainClient = (*BrainClient)(nil)

// Process marshals a TaskEvent and sends it to the brain's guardian loop.
func (c *BrainClient) Process(_ context.Context, event domain.TaskEvent) error {
	data, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("brainclient: marshal event: %w", err)
	}
	_, err = c.ProcessEvent(data)
	return err
}

// Reason sends a query to the brain's reasoning endpoint (POST /api/v1/reason).
func (c *BrainClient) Reason(ctx context.Context, query string) (*domain.ReasonResult, error) {
	c.mu.Lock()
	if c.cbState == stateOpen {
		if time.Since(c.lastFailure) > c.cooldown {
			c.cbState = stateHalfOpen
		} else {
			c.mu.Unlock()
			return nil, ErrCircuitOpen
		}
	}
	c.mu.Unlock()

	if c.baseURL == "" {
		c.recordFailure()
		return nil, ErrEmptyURL
	}

	body, err := json.Marshal(map[string]string{"prompt": query})
	if err != nil {
		return nil, fmt.Errorf("brainclient: marshal query: %w", err)
	}

	if c.Tracer != nil {
		c.Tracer.Emit(ctx, "brain_call", "core", map[string]string{"endpoint": "/api/v1/reason"})
	}

	reqURL := c.baseURL + "/api/v1/reason"
	req, err := http.NewRequestWithContext(ctx, "POST", reqURL, bytes.NewReader(body))
	if err != nil {
		c.recordFailure()
		return nil, fmt.Errorf("brainclient: request creation failed: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	c.signRequest(req, body)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		c.recordFailure()
		return nil, fmt.Errorf("brainclient: request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		c.recordFailure()
		return nil, fmt.Errorf("brainclient: failed to read response: %w", err)
	}

	// Trace: brain_response for Reason
	if c.Tracer != nil {
		c.Tracer.Emit(ctx, "brain_response", "core", map[string]string{
			"endpoint": "/api/v1/reason", "status": fmt.Sprintf("%d", resp.StatusCode),
		})
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		c.recordFailure()
		return nil, fmt.Errorf("brainclient: brain returned status %d: %s", resp.StatusCode, string(respBody))
	}

	c.recordSuccess()

	var result domain.ReasonResult
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, fmt.Errorf("brainclient: unmarshal response: %w", err)
	}
	return &result, nil
}

// ReasonWithContext sends a reasoning query to Brain with the originating agent's
// DID and session name. Brain forwards these as X-Agent-DID and X-Session headers
// when it calls Core's vault APIs, so access control is attributed to the
// originating agent, not to Brain.
func (c *BrainClient) ReasonWithContext(ctx context.Context, query, agentDID, sessionName string) (*domain.ReasonResult, error) {
	c.mu.Lock()
	if c.cbState == stateOpen {
		if time.Since(c.lastFailure) > c.cooldown {
			c.cbState = stateHalfOpen
		} else {
			c.mu.Unlock()
			return nil, ErrCircuitOpen
		}
	}
	c.mu.Unlock()

	if c.baseURL == "" {
		c.recordFailure()
		return nil, ErrEmptyURL
	}

	payload := map[string]string{
		"prompt":    query,
		"agent_did": agentDID,
		"session":   sessionName,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("brainclient: marshal query: %w", err)
	}

	if c.Tracer != nil {
		c.Tracer.Emit(ctx, "brain_call", "core", map[string]string{"endpoint": "/api/v1/reason"})
	}

	reqURL := c.baseURL + "/api/v1/reason"
	req, err := http.NewRequestWithContext(ctx, "POST", reqURL, bytes.NewReader(body))
	if err != nil {
		c.recordFailure()
		return nil, fmt.Errorf("brainclient: request creation failed: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	c.signRequest(req, body)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		c.recordFailure()
		return nil, fmt.Errorf("brainclient: request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		c.recordFailure()
		return nil, fmt.Errorf("brainclient: failed to read response: %w", err)
	}

	if c.Tracer != nil {
		c.Tracer.Emit(ctx, "brain_response", "core", map[string]string{
			"endpoint": "/api/v1/reason", "status": fmt.Sprintf("%d", resp.StatusCode),
		})
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		c.recordFailure()
		return nil, fmt.Errorf("brainclient: brain returned status %d: %s", resp.StatusCode, string(respBody))
	}

	c.recordSuccess()

	var result domain.ReasonResult
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, fmt.Errorf("brainclient: unmarshal response: %w", err)
	}
	return &result, nil
}

// ReasonAsUser sends a reasoning query with source (e.g. "admin") so Brain
// treats it as user-originated, enabling auto-unlock of sensitive personas.
// When source is empty, behaves identically to Reason().
func (c *BrainClient) ReasonAsUser(ctx context.Context, query, source string) (*domain.ReasonResult, error) {
	c.mu.Lock()
	if c.cbState == stateOpen {
		if time.Since(c.lastFailure) > c.cooldown {
			c.cbState = stateHalfOpen
		} else {
			c.mu.Unlock()
			return nil, ErrCircuitOpen
		}
	}
	c.mu.Unlock()

	if c.baseURL == "" {
		c.recordFailure()
		return nil, ErrEmptyURL
	}

	payload := map[string]string{"prompt": query}
	if source != "" {
		payload["source"] = source
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("brainclient: marshal query: %w", err)
	}

	reqURL := c.baseURL + "/api/v1/reason"
	req, err := http.NewRequestWithContext(ctx, "POST", reqURL, bytes.NewReader(body))
	if err != nil {
		c.recordFailure()
		return nil, fmt.Errorf("brainclient: request creation failed: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	c.signRequest(req, body)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		c.recordFailure()
		return nil, fmt.Errorf("brainclient: request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		c.recordFailure()
		return nil, fmt.Errorf("brainclient: failed to read response: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		c.recordFailure()
		return nil, fmt.Errorf("brainclient: brain returned status %d: %s", resp.StatusCode, string(respBody))
	}

	c.recordSuccess()

	var result domain.ReasonResult
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, fmt.Errorf("brainclient: unmarshal response: %w", err)
	}
	return &result, nil
}

// GetProposalStatus fetches the status of an intent proposal from Brain.
func (c *BrainClient) GetProposalStatus(proposalID string) ([]byte, error) {
	req, err := http.NewRequest("GET", c.baseURL+"/api/v1/proposals/"+proposalID+"/status", nil)
	if err != nil {
		return nil, err
	}
	c.signRequest(req, nil)
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("brain returned %d for proposal %s", resp.StatusCode, proposalID)
	}
	return body, nil
}

// ListProposals fetches all pending intent proposals from Brain.
func (c *BrainClient) ListProposals() ([]byte, error) {
	req, err := http.NewRequest("GET", c.baseURL+"/api/v1/proposals", nil)
	if err != nil {
		return nil, err
	}
	c.signRequest(req, nil)
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("brain returned %d for proposal list", resp.StatusCode)
	}
	return body, nil
}

// IsHealthy returns true if the brain is available and healthy.
func (c *BrainClient) IsHealthy(_ context.Context) bool {
	if !c.IsAvailable() {
		return false
	}
	return c.Health() == nil
}

// ResetForTest resets the circuit breaker for per-test isolation.
func (c *BrainClient) ResetForTest() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.failures = 0
	c.cbState = stateClosed
	c.lastFailure = time.Time{}
}

// SetCooldown sets the circuit breaker cooldown duration (for testing).
func (c *BrainClient) SetCooldown(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.cooldown = d
}

// SetMaxFailures sets the circuit breaker failure threshold (for testing).
func (c *BrainClient) SetMaxFailures(n int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.maxFailures = n
}

// CircuitState returns the current circuit breaker state: "closed", "open", or "half-open".
func (c *BrainClient) CircuitState() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cbState == stateOpen {
		if time.Since(c.lastFailure) > c.cooldown {
			return stateHalfOpen
		}
		return stateOpen
	}
	return c.cbState
}
