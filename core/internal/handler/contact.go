package handler

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"net/url"
	"strings"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
)

// ContactHandler serves the /v1/contacts endpoints.
type ContactHandler struct {
	Contacts        port.ContactDirectory
	Sharing         port.SharingPolicyManager
	ScenarioPolicies port.ScenarioPolicyManager
}

// addContactRequest is the JSON body for POST /v1/contacts.
type addContactRequest struct {
	DID        string `json:"did"`
	Name       string `json:"name"`
	TrustLevel string `json:"trust_level"`
}

// setPolicyRequest is the JSON body for PUT /v1/contacts/{did}/policy.
type setPolicyRequest struct {
	Categories map[string]domain.SharingTier `json:"categories"`
}

// HandleListContacts handles GET /v1/contacts.
func (h *ContactHandler) HandleListContacts(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	contacts, err := h.Contacts.List(r.Context())
	if err != nil {
		http.Error(w, `{"error":"failed to list contacts"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]interface{}{"contacts": contacts}); err != nil {
		http.Error(w, `{"error":"failed to encode response"}`, http.StatusInternalServerError)
	}
}

// HandleAddContact handles POST /v1/contacts.
func (h *ContactHandler) HandleAddContact(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req addContactRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	if req.DID == "" || req.Name == "" {
		http.Error(w, `{"error":"did and name are required"}`, http.StatusBadRequest)
		return
	}

	if err := h.Contacts.Add(r.Context(), req.DID, req.Name, req.TrustLevel); err != nil {
		http.Error(w, `{"error":"failed to add contact"}`, http.StatusInternalServerError)
		return
	}

	// Auto-install v1 default scenario policies for the new contact.
	if h.ScenarioPolicies != nil {
		if err := h.ScenarioPolicies.SetDefaultPolicies(r.Context(), req.DID); err != nil {
			// Non-fatal: log and continue — the contact is created; policies can
			// be set manually if this fails.
			slog.Warn("contact: failed to set default scenario policies",
				"did", req.DID, "error", err)
		}
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{"status": "created"})
}

// HandleGetPolicy handles GET /v1/contacts/{did}/policy.
func (h *ContactHandler) HandleGetPolicy(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	did := extractDIDFromPath(r.URL.Path, "/v1/contacts/", "/policy")
	if did == "" {
		http.Error(w, `{"error":"missing DID in path"}`, http.StatusBadRequest)
		return
	}

	policy, err := h.Sharing.GetPolicy(r.Context(), did)
	if err != nil {
		http.Error(w, `{"error":"failed to get policy"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(policy); err != nil {
		http.Error(w, `{"error":"failed to encode response"}`, http.StatusInternalServerError)
	}
}

// HandleSetPolicy handles PUT /v1/contacts/{did}/policy.
func (h *ContactHandler) HandleSetPolicy(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	did := extractDIDFromPath(r.URL.Path, "/v1/contacts/", "/policy")
	if did == "" {
		http.Error(w, `{"error":"missing DID in path"}`, http.StatusBadRequest)
		return
	}

	var req setPolicyRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	if err := h.Sharing.SetPolicy(r.Context(), did, req.Categories); err != nil {
		http.Error(w, `{"error":"failed to set policy"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "updated"})
}

// setScenariosRequest is the JSON body for PUT /v1/contacts/{did}/scenarios.
type setScenariosRequest struct {
	Scenarios map[string]domain.ScenarioTier `json:"scenarios"`
}

// HandleListScenarios handles GET /v1/contacts/{did}/scenarios.
// Returns the scenario→tier map for the given contact DID.
func (h *ContactHandler) HandleListScenarios(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	if h.ScenarioPolicies == nil {
		http.Error(w, `{"error":"scenario policies not configured"}`, http.StatusNotImplemented)
		return
	}

	did := extractDIDFromPath(r.URL.Path, "/v1/contacts/", "/scenarios")
	if did == "" {
		http.Error(w, `{"error":"missing DID in path"}`, http.StatusBadRequest)
		return
	}

	policies, err := h.ScenarioPolicies.ListPolicies(r.Context(), did)
	if err != nil {
		http.Error(w, `{"error":"failed to list scenarios"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]interface{}{"scenarios": policies}); err != nil {
		http.Error(w, `{"error":"failed to encode response"}`, http.StatusInternalServerError)
	}
}

// HandleSetScenarios handles PUT /v1/contacts/{did}/scenarios.
// Accepts JSON {"scenarios": {"scenario": "tier", ...}} and sets each policy.
func (h *ContactHandler) HandleSetScenarios(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	if h.ScenarioPolicies == nil {
		http.Error(w, `{"error":"scenario policies not configured"}`, http.StatusNotImplemented)
		return
	}

	did := extractDIDFromPath(r.URL.Path, "/v1/contacts/", "/scenarios")
	if did == "" {
		http.Error(w, `{"error":"missing DID in path"}`, http.StatusBadRequest)
		return
	}

	var req setScenariosRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	if len(req.Scenarios) == 0 {
		http.Error(w, `{"error":"scenarios map must not be empty"}`, http.StatusBadRequest)
		return
	}

	// Validate all tiers before writing any.
	validTiers := map[domain.ScenarioTier]bool{
		domain.ScenarioStandingPolicy: true,
		domain.ScenarioExplicitOnce:   true,
		domain.ScenarioDenyByDefault:  true,
	}
	for scenario, tier := range req.Scenarios {
		if !validTiers[tier] {
			http.Error(w, `{"error":"invalid scenario tier: `+string(tier)+`"}`, http.StatusBadRequest)
			_ = scenario
			return
		}
	}

	ctx := r.Context()
	for scenario, tier := range req.Scenarios {
		if err := h.ScenarioPolicies.SetScenarioPolicy(ctx, did, scenario, tier); err != nil {
			slog.Warn("contact: failed to set scenario policy",
				"did", did, "scenario", scenario, "error", err)
			http.Error(w, `{"error":"failed to set scenario policy"}`, http.StatusInternalServerError)
			return
		}
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "updated"})
}

// updateContactRequest is the JSON body for PUT /v1/contacts/{did}.
type updateContactRequest struct {
	Name        string `json:"name"`
	TrustLevel  string `json:"trust_level"`
	LastContact int64  `json:"last_contact"`
}

// HandleUpdateContact handles PUT /v1/contacts/{did}.
func (h *ContactHandler) HandleUpdateContact(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	did := strings.TrimPrefix(r.URL.Path, "/v1/contacts/")
	if did == "" || did == r.URL.Path {
		http.Error(w, `{"error":"missing DID in path"}`, http.StatusBadRequest)
		return
	}

	var req updateContactRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	if req.Name != "" {
		if err := h.Contacts.UpdateName(r.Context(), did, req.Name); err != nil {
			slog.Warn("failed to update contact name", "did", did, "error", err)
			http.Error(w, `{"error":"failed to update contact"}`, http.StatusInternalServerError)
			return
		}
	}

	if req.TrustLevel != "" {
		if err := h.Contacts.UpdateTrust(r.Context(), did, req.TrustLevel); err != nil {
			slog.Warn("failed to update contact trust level", "did", did, "error", err)
			http.Error(w, `{"error":"failed to update contact"}`, http.StatusInternalServerError)
			return
		}
	}

	if req.LastContact > 0 {
		if err := h.Contacts.UpdateLastContact(r.Context(), did, req.LastContact); err != nil {
			slog.Warn("failed to update contact last_contact", "did", did, "error", err)
			// Non-fatal — don't block the response for a timestamp update.
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "updated"})
}

// HandleDeleteContact handles DELETE /v1/contacts/{did}.
func (h *ContactHandler) HandleDeleteContact(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	// Use RawPath when available to preserve percent-encoded segments
	// (e.g. DIDs with colons: did%3Aplc%3Axyz).  Fall back to Path.
	path := r.URL.Path
	if r.URL.RawPath != "" {
		path = r.URL.RawPath
	}
	raw := strings.TrimPrefix(path, "/v1/contacts/")
	if raw == "" || raw == path {
		http.Error(w, `{"error":"missing DID in path"}`, http.StatusBadRequest)
		return
	}
	did, err := url.PathUnescape(raw)
	if err != nil {
		did = raw
	}

	if err := h.Contacts.Delete(r.Context(), did); err != nil {
		slog.Warn("failed to delete contact", "did", did, "error", err)
		http.Error(w, `{"error":"failed to delete contact"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "deleted"})
}

// HandleDeleteContactByName handles DELETE /v1/contacts/by-name/{name}.
// Resolves the name to a DID, then deletes.  Used when the stored DID
// contains path-unsafe characters that break URL routing.
func (h *ContactHandler) HandleDeleteContactByName(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	name := strings.TrimPrefix(r.URL.Path, "/v1/contacts/by-name/")
	if name == "" || name == r.URL.Path {
		http.Error(w, `{"error":"missing name in path"}`, http.StatusBadRequest)
		return
	}
	decoded, err := url.PathUnescape(name)
	if err == nil {
		name = decoded
	}

	// Resolve name → DID, then delete by DID.
	did, err := h.Contacts.Resolve(r.Context(), name)
	if err != nil {
		http.Error(w, `{"error":"contact not found"}`, http.StatusNotFound)
		return
	}

	if err := h.Contacts.Delete(r.Context(), did); err != nil {
		slog.Warn("failed to delete contact by name", "name", name, "did", did, "error", err)
		http.Error(w, `{"error":"failed to delete contact"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "deleted", "name": name})
}

// extractDIDFromPath extracts a DID segment from a URL path between a prefix and suffix.
// For example, extractDIDFromPath("/v1/contacts/did:key:abc/policy", "/v1/contacts/", "/policy")
// returns "did:key:abc".
func extractDIDFromPath(path, prefix, suffix string) string {
	if !strings.HasPrefix(path, prefix) || !strings.HasSuffix(path, suffix) {
		return ""
	}
	did := strings.TrimPrefix(path, prefix)
	did = strings.TrimSuffix(did, suffix)
	return did
}
