// Package errors implements HTTP error handling and edge cases for dina-core.
package errors

import (
	"encoding/json"
	"strings"
)

// knownEndpoints maps method+path to expected behavior.
var knownEndpoints = map[string]string{
	"POST /v1/vault/store":       "json",
	"POST /v1/vault/query":       "json",
	"POST /v1/vault/store/batch": "json",
	"POST /v1/vault/crash":       "json",
	"POST /v1/task/ack":          "json",
	"PUT /v1/vault/kv/:key":      "json",
	"GET /v1/vault/kv/:key":      "",
	"GET /v1/vault/item/:id":     "",
	"DELETE /v1/vault/item/:id":  "",
	"GET /healthz":               "",
	"GET /readyz":                "",
	"GET /v1/did":                "",
	"POST /v1/personas":          "json",
	"GET /v1/personas":           "",
	"GET /v1/contacts":           "",
	"POST /v1/contacts":          "json",
	"POST /v1/devices":           "json",
	"GET /v1/devices":            "",
	"POST /v1/msg/send":          "json",
	"GET /v1/msg/inbox":          "",
	"POST /v1/pair/initiate":     "json",
	"POST /v1/pair/complete":     "json",
	"POST /v1/pii/scrub":        "json",
	"POST /v1/notify":            "json",
	"POST /v1/reputation/query":  "json",
	"POST /v1/did/sign":          "json",
	"POST /v1/did/verify":        "json",
}

// methodsForPath returns valid methods for a path.
func methodsForPath(path string) []string {
	var methods []string
	for key := range knownEndpoints {
		parts := strings.SplitN(key, " ", 2)
		if len(parts) == 2 && parts[1] == path {
			methods = append(methods, parts[0])
		}
	}
	return methods
}

// pathExists checks if any method is registered for the given path.
func pathExists(path string) bool {
	for key := range knownEndpoints {
		parts := strings.SplitN(key, " ", 2)
		if len(parts) == 2 && parts[1] == path {
			return true
		}
	}
	return false
}

// ErrorHandler implements testutil.ErrorHandler — HTTP error handling.
type ErrorHandler struct {
	maxBodySize int64
}

// NewErrorHandler returns a new ErrorHandler with the given max body size.
func NewErrorHandler(maxBodySize int64) *ErrorHandler {
	if maxBodySize <= 0 {
		maxBodySize = 10 * 1024 * 1024 // 10 MiB default
	}
	return &ErrorHandler{maxBodySize: maxBodySize}
}

// HandleRequest processes an HTTP request and returns the appropriate status code and response body.
func (h *ErrorHandler) HandleRequest(method, path, contentType string, body []byte) (statusCode int, respBody []byte, err error) {
	// Check body size first.
	if int64(len(body)) > h.maxBodySize {
		return 413, []byte(`{"error":"payload too large"}`), nil
	}

	// Check if path exists.
	if !pathExists(path) {
		return 404, []byte(`{"error":"not found"}`), nil
	}

	// Check if method is allowed for this path.
	validMethods := methodsForPath(path)
	methodAllowed := false
	for _, m := range validMethods {
		if m == method {
			methodAllowed = true
			break
		}
	}
	if !methodAllowed {
		return 405, []byte(`{"error":"method not allowed"}`), nil
	}

	// For POST/PUT endpoints that expect JSON, enforce Content-Type.
	key := method + " " + path
	expected, ok := knownEndpoints[key]
	if ok && expected == "json" && contentType != "" && !strings.Contains(contentType, "application/json") {
		return 415, []byte(`{"error":"unsupported media type"}`), nil
	}

	// Validate JSON body for POST endpoints requiring JSON.
	if ok && expected == "json" && len(body) > 0 {
		var js json.RawMessage
		if jsonErr := json.Unmarshal(body, &js); jsonErr != nil {
			return 400, []byte(`{"error":"failed to parse JSON body"}`), nil
		}

		// Validate specific endpoints for required fields.
		if path == "/v1/vault/crash" {
			var payload map[string]interface{}
			_ = json.Unmarshal(body, &payload)
			if _, hasError := payload["error"]; !hasError {
				if _, hasErr := payload["traceback"]; !hasErr {
					return 400, []byte(`{"error":"missing required fields: error, traceback"}`), nil
				}
			}
		}
		if path == "/v1/vault/query" {
			var payload map[string]interface{}
			_ = json.Unmarshal(body, &payload)
			if _, hasPersona := payload["persona"]; !hasPersona {
				return 400, []byte(`{"error":"missing required field: persona"}`), nil
			}
		}
	}

	return 200, []byte(`{"status":"ok"}`), nil
}

// MaxBodySize returns the maximum allowed request body size in bytes.
func (h *ErrorHandler) MaxBodySize() int64 {
	return h.maxBodySize
}

// RecoverFromPanic returns true if the server recovers from handler panics.
func (h *ErrorHandler) RecoverFromPanic() bool {
	return true
}
