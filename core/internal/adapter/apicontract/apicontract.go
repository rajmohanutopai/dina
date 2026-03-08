// Package apicontract implements the API contract verifier for core-brain communication.
// It delegates authorization decisions to the real auth.adminEndpointChecker so that
// any drift between the contract and production auth rules is caught by tests.
package apicontract

import (
	"sync"

	"github.com/rajmohanutopai/dina/core/internal/adapter/auth"
	"github.com/rajmohanutopai/dina/core/test/testutil"
)

// APIContractEndpoint is a type alias to testutil.APIContractEndpoint.
type APIContractEndpoint = testutil.APIContractEndpoint

// authChecker is the interface satisfied by auth.NewAdminEndpointChecker().
// We use a local interface to avoid exporting the concrete type.
type authChecker interface {
	IsAdminEndpoint(path string) bool
	AllowedForTokenKind(kind, path string, scope ...string) bool
}

// APIContract implements testutil.APIContract — verifying core-brain API surface.
// Authorization checks delegate to the real auth.AdminEndpointChecker so that
// the contract stays in sync with production middleware.
type APIContract struct {
	mu          sync.Mutex
	serviceID   string
	endpoints   []APIContractEndpoint
	checker     authChecker
}

// NewAPIContract returns a new APIContract with the documented endpoint surface.
// Authorization is delegated to auth.NewAdminEndpointChecker() — the same checker
// used by the production middleware chain.
func NewAPIContract(serviceID string) *APIContract {
	c := &APIContract{
		serviceID: serviceID,
		checker:   auth.NewAdminEndpointChecker(),
	}
	c.endpoints = []APIContractEndpoint{
		{Method: "POST", Path: "/v1/vault/query", TokenType: "brain", StatusCode: 200},
		{Method: "POST", Path: "/v1/vault/store", TokenType: "brain", StatusCode: 201},
		{Method: "POST", Path: "/v1/did/verify", TokenType: "brain", StatusCode: 200},
		{Method: "POST", Path: "/v1/pii/scrub", TokenType: "brain", StatusCode: 200},
		{Method: "POST", Path: "/v1/notify", TokenType: "brain", StatusCode: 200},
		{Method: "POST", Path: "/v1/msg/send", TokenType: "brain", StatusCode: 200},
		{Method: "POST", Path: "/v1/trust/query", TokenType: "brain", StatusCode: 200},
		{Method: "POST", Path: "/v1/did/sign", TokenType: "admin", StatusCode: 200},
		// Planned endpoints — not yet routed in main.go:
		{Method: "POST", Path: "/v1/did/rotate", TokenType: "admin", StatusCode: 200},   // planned: requires signature-based rotation (CORE-HIGH-14)
		{Method: "POST", Path: "/v1/vault/backup", TokenType: "admin", StatusCode: 200}, // planned: requires MigrationService handler wiring
		{Method: "POST", Path: "/v1/persona/unlock", TokenType: "admin", StatusCode: 200},
		{Method: "GET", Path: "/healthz", TokenType: "brain", StatusCode: 200},
		{Method: "GET", Path: "/readyz", TokenType: "brain", StatusCode: 200},
	}
	return c
}

// CallEndpoint sends a request to the given endpoint with the specified token.
// Authorization is delegated to the real auth checker — not hardcoded maps.
func (c *APIContract) CallEndpoint(method, path, token string, body []byte) (statusCode int, respBody []byte, err error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	// Check if this is an admin-only endpoint using the real auth checker.
	if c.IsAdminOnly(path) {
		if token == c.serviceID {
			// Brain token on admin-only endpoint → forbidden.
			return 403, []byte(`{"error":"forbidden"}`), nil
		}
		return 200, []byte(`{"status":"ok"}`), nil
	}

	// For service-callable endpoints, verify service identity marker.
	if c.IsBrainCallable(path) {
		if token == c.serviceID {
			// Find the expected status code.
			for _, ep := range c.endpoints {
				if ep.Path == path {
					return ep.StatusCode, []byte(`{"status":"ok"}`), nil
				}
			}
			return 200, []byte(`{"status":"ok"}`), nil
		}
		return 401, []byte(`{"error":"unauthorized"}`), nil
	}

	return 404, []byte(`{"error":"not found"}`), nil
}

// ListEndpoints returns all registered API endpoints.
func (c *APIContract) ListEndpoints() []APIContractEndpoint {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]APIContractEndpoint, len(c.endpoints))
	copy(out, c.endpoints)
	return out
}

// IsBrainCallable returns true if the endpoint accepts service-authenticated calls.
// Delegates to the real auth checker: brain token must be allowed on this path.
func (c *APIContract) IsBrainCallable(path string) bool {
	return c.checker.AllowedForTokenKind("brain", path)
}

// IsAdminOnly returns true if the endpoint requires admin/client access.
// Delegates to the real auth checker used in production middleware.
func (c *APIContract) IsAdminOnly(path string) bool {
	return c.checker.IsAdminEndpoint(path)
}
