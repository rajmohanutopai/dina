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
	"sync"
	"time"

	"github.com/anthropics/dina/core/internal/domain"
	"github.com/anthropics/dina/core/internal/port"
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
	defaultTimeout      = 30 * time.Second
	defaultMaxFailures  = 5
	defaultCooldown     = 30 * time.Second
)

// BrainClient implements testutil.BrainClient — typed HTTP calls to brain.
type BrainClient struct {
	mu          sync.Mutex
	baseURL     string
	token       string
	httpClient  *http.Client

	// Circuit breaker state.
	cbState     string
	failures    int
	lastFailure time.Time
	maxFailures int
	cooldown    time.Duration
}

// New returns a new BrainClient configured with the brain's base URL and auth token.
func New(baseURL, token string) *BrainClient {
	transport := &http.Transport{
		MaxIdleConns:        10,
		MaxIdleConnsPerHost: 10,
		IdleConnTimeout:     90 * time.Second,
	}
	return &BrainClient{
		baseURL: baseURL,
		token:   token,
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

	url := c.baseURL + "/api/v1/process"
	req, err := http.NewRequest("POST", url, bytes.NewReader(event))
	if err != nil {
		c.recordFailure()
		return nil, fmt.Errorf("brainclient: request creation failed: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.token)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		c.recordFailure()
		return nil, fmt.Errorf("brainclient: request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		c.recordFailure()
		return nil, fmt.Errorf("brainclient: failed to read response: %w", err)
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

	url := c.baseURL + "/healthz"
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return fmt.Errorf("brainclient: health request creation failed: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.token)

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

	url := c.baseURL + "/api/v1/reason"
	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(body))
	if err != nil {
		c.recordFailure()
		return nil, fmt.Errorf("brainclient: request creation failed: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.token)

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
