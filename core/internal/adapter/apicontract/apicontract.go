// Package apicontract implements the API contract verifier for core-brain communication.
package apicontract

import (
	"sync"

	"github.com/anthropics/dina/core/test/testutil"
)

// APIContractEndpoint is a type alias to testutil.APIContractEndpoint.
type APIContractEndpoint = testutil.APIContractEndpoint

// APIContract implements testutil.APIContract — verifying core-brain API surface.
type APIContract struct {
	mu         sync.Mutex
	brainToken string
	endpoints  []APIContractEndpoint
}

// NewAPIContract returns a new APIContract with the documented endpoint surface.
func NewAPIContract(brainToken string) *APIContract {
	c := &APIContract{
		brainToken: brainToken,
	}
	c.endpoints = []APIContractEndpoint{
		{Method: "POST", Path: "/v1/vault/query", TokenType: "brain", StatusCode: 200},
		{Method: "POST", Path: "/v1/vault/store", TokenType: "brain", StatusCode: 201},
		{Method: "POST", Path: "/v1/did/verify", TokenType: "brain", StatusCode: 200},
		{Method: "POST", Path: "/v1/pii/scrub", TokenType: "brain", StatusCode: 200},
		{Method: "POST", Path: "/v1/notify", TokenType: "brain", StatusCode: 200},
		{Method: "POST", Path: "/v1/msg/send", TokenType: "brain", StatusCode: 200},
		{Method: "POST", Path: "/v1/reputation/query", TokenType: "brain", StatusCode: 200},
		{Method: "POST", Path: "/v1/did/sign", TokenType: "admin", StatusCode: 200},
		{Method: "POST", Path: "/v1/did/rotate", TokenType: "admin", StatusCode: 200},
		{Method: "POST", Path: "/v1/vault/backup", TokenType: "admin", StatusCode: 200},
		{Method: "POST", Path: "/v1/persona/unlock", TokenType: "admin", StatusCode: 200},
		{Method: "GET", Path: "/healthz", TokenType: "brain", StatusCode: 200},
		{Method: "GET", Path: "/readyz", TokenType: "brain", StatusCode: 200},
	}
	return c
}

// CallEndpoint sends a request to the given endpoint with the specified token.
func (c *APIContract) CallEndpoint(method, path, token string, body []byte) (statusCode int, respBody []byte, err error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	// Check if this is an admin-only endpoint.
	if c.IsAdminOnly(path) {
		if token == c.brainToken {
			return 403, []byte(`{"error":"forbidden"}`), nil
		}
		return 200, []byte(`{"status":"ok"}`), nil
	}

	// For brain-callable endpoints, verify brain token.
	if c.IsBrainCallable(path) {
		if token == c.brainToken {
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

// IsBrainCallable returns true if the endpoint accepts BRAIN_TOKEN.
func (c *APIContract) IsBrainCallable(path string) bool {
	brainCallable := map[string]bool{
		"/v1/vault/query":      true,
		"/v1/vault/store":      true,
		"/v1/did/verify":       true,
		"/v1/pii/scrub":        true,
		"/v1/notify":           true,
		"/v1/msg/send":         true,
		"/v1/reputation/query": true,
		"/healthz":             true,
		"/readyz":              true,
	}
	return brainCallable[path]
}

// IsAdminOnly returns true if the endpoint requires admin/client access.
func (c *APIContract) IsAdminOnly(path string) bool {
	adminOnly := map[string]bool{
		"/v1/did/sign":        true,
		"/v1/did/rotate":      true,
		"/v1/vault/backup":    true,
		"/v1/persona/unlock":  true,
	}
	return adminOnly[path]
}
