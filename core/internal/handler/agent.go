package handler

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"

	mw "github.com/rajmohanutopai/dina/core/internal/middleware"
)

// AgentHandler proxies agent validation requests to the brain sidecar.
// External clients (CLI, paired devices) authenticate to core via Ed25519
// signatures; core forwards the request to brain with service-key signatures.
// This keeps brain non-public — no shared bearer secret in external clients.
//
// Only agent_intent events are accepted — this is not a generic proxy.
// The caller's agent_did is overridden with the authenticated identity from
// the auth middleware, and trust_level is set to "verified" for any device
// that passed authentication (untrusted devices can't reach this endpoint).
type AgentHandler struct {
	// Brain forwards events to the brain sidecar's guardian.
	// Accepts raw JSON, returns raw JSON.
	Brain interface {
		ProcessEvent(event []byte) ([]byte, error)
	}
}

// maxValidateBody is the hard limit for request body size (64 KB).
// Agent validation payloads are small JSON objects; anything larger is rejected.
const maxValidateBody = 64 * 1024

// HandleValidate handles POST /v1/agent/validate.
// It validates that the payload is an agent_intent event, binds the
// authenticated caller's identity, forwards it to brain's guardian via
// ProcessEvent, and returns the guardian's decision.
func (h *AgentHandler) HandleValidate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	// Read body with a hard size limit — reject, don't truncate.
	// Read one extra byte to detect oversized bodies.
	limited := io.LimitReader(r.Body, maxValidateBody+1)
	body, err := io.ReadAll(limited)
	if err != nil {
		jsonError(w, "failed to read request body", http.StatusBadRequest)
		return
	}
	if int64(len(body)) > maxValidateBody {
		jsonError(w, "request body too large", http.StatusRequestEntityTooLarge)
		return
	}
	if len(body) == 0 {
		jsonError(w, "empty request body", http.StatusBadRequest)
		return
	}

	// Parse into a generic map so we can validate type and override fields.
	var payload map[string]interface{}
	if err := json.Unmarshal(body, &payload); err != nil {
		jsonError(w, "invalid JSON", http.StatusBadRequest)
		return
	}

	// Enforce agent_intent only — this endpoint is not a generic proxy.
	if t, _ := payload["type"].(string); t != "agent_intent" {
		jsonError(w, `only type "agent_intent" is accepted on this endpoint`, http.StatusBadRequest)
		return
	}

	// Bind the authenticated caller's identity — never trust caller-supplied
	// agent_did or trust_level.
	//
	// For Ed25519 signature auth: X-DID header contains the real did:key:z6Mk...
	// For bearer token auth: context holds a device/token ID, not a DID.
	//
	// Any device that passed auth is "verified"; untrusted devices can't
	// reach this endpoint at all (auth middleware rejects them with 401).
	if xDID := r.Header.Get("X-DID"); xDID != "" {
		// Signature auth — X-DID is the real DID (validated by auth middleware).
		payload["agent_did"] = xDID
	} else if deviceID, ok := r.Context().Value(mw.AgentDIDKey).(string); ok && deviceID != "" {
		// Bearer token auth — context holds a device ID, not a DID.
		// Prefix to distinguish from real DIDs downstream.
		payload["agent_did"] = "device:" + deviceID
	}
	payload["trust_level"] = "verified"

	// Forward session context if present (for scoped approval grants).
	if sessionName, ok := r.Context().Value(mw.SessionNameKey).(string); ok && sessionName != "" {
		payload["session"] = sessionName
	}

	// Re-marshal with the overridden fields.
	patched, err := json.Marshal(payload)
	if err != nil {
		jsonError(w, "failed to encode request", http.StatusInternalServerError)
		return
	}

	// Forward to brain's guardian.
	resp, err := h.Brain.ProcessEvent(patched)
	if err != nil {
		msg := err.Error()
		// Distinguish circuit breaker (brain down) from other errors.
		if strings.Contains(msg, "circuit breaker") || strings.Contains(msg, "request failed") {
			jsonError(w, "brain unavailable", http.StatusBadGateway)
		} else if strings.Contains(msg, "status 4") {
			// Brain returned 4xx — likely a client error (bad payload).
			jsonError(w, "guardian rejected request", http.StatusBadRequest)
		} else {
			jsonError(w, "guardian error", http.StatusBadGateway)
		}
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Write(resp)
}

// jsonError writes a JSON error response with properly escaped message.
func jsonError(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
