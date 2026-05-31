package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
)

// ContactHandler serves the /v1/contacts endpoints.
type ContactHandler struct {
	Contacts         port.ContactDirectory
	Aliases          port.ContactAliasStore
	Sharing          port.SharingPolicyManager
	ScenarioPolicies port.ScenarioPolicyManager
}

// addContactRequest is the JSON body for POST /v1/contacts.
// Relationship and DataResponsibility are pointer types to distinguish
// "omitted" (nil) from "present" — this determines whether
// responsibility_explicit is set on creation.
type addContactRequest struct {
	DID                string  `json:"did"`
	Name               string  `json:"name"`
	TrustLevel         string  `json:"trust_level"`
	Relationship       *string `json:"relationship,omitempty"`
	DataResponsibility *string `json:"data_responsibility,omitempty"`
}

// setPolicyRequest is the JSON body for PUT /v1/contacts/{did}/policy.
type setPolicyRequest struct {
	Categories map[string]domain.SharingTier `json:"categories"`
}

// HandleFindContactsByPreference handles GET /v1/contacts/by-preference?category=X.
//
// Returns the contacts whose `preferred_for` list contains the given
// category. Drives the reasoning agent's resolver: a query with a
// dental intent looks up `category=dental` and gets back the user's
// go-to dentist(s) without having to AppView-search for a provider.
//
// Empty category returns 400 — the resolver must always pass a
// concrete intent; there's no "match anything" semantics.
func (h *ContactHandler) HandleFindContactsByPreference(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	category := strings.TrimSpace(r.URL.Query().Get("category"))
	if category == "" {
		http.Error(w, `{"error":"category query parameter is required"}`, http.StatusBadRequest)
		return
	}

	contacts, err := h.Contacts.FindByPreferredFor(r.Context(), category)
	if err != nil {
		slog.Warn("failed to find contacts by preference", "category", category, "error", err)
		http.Error(w, `{"error":"failed to query contacts"}`, http.StatusInternalServerError)
		return
	}

	// Populate aliases from the alias store (same enrichment as List).
	if h.Aliases != nil {
		allAliases, err := h.Aliases.ListAllAliases(r.Context())
		if err == nil {
			for i := range contacts {
				if aliases, ok := allAliases[contacts[i].DID]; ok {
					contacts[i].Aliases = aliases
					if len(aliases) > 0 {
						contacts[i].Alias = aliases[0]
					}
				}
			}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]interface{}{"contacts": contacts}); err != nil {
		http.Error(w, `{"error":"failed to encode response"}`, http.StatusInternalServerError)
	}
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

	// Populate aliases from the alias store.
	if h.Aliases != nil {
		allAliases, err := h.Aliases.ListAllAliases(r.Context())
		if err == nil {
			for i := range contacts {
				if aliases, ok := allAliases[contacts[i].DID]; ok {
					contacts[i].Aliases = aliases
					if len(aliases) > 0 {
						contacts[i].Alias = aliases[0] // compatibility
					}
				}
			}
		}
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

	// Default trust_level to "unknown" — CHECK constraint requires a valid value.
	trustLevel := req.TrustLevel
	if trustLevel == "" {
		trustLevel = "unknown"
	}

	// Relationship defaults to "unknown".
	relationship := domain.RelationshipUnknown
	if req.Relationship != nil {
		relationship = *req.Relationship
		if !domain.ValidContactRelationships[relationship] {
			http.Error(w, `{"error":"invalid relationship value"}`, http.StatusBadRequest)
			return
		}
	}

	// DataResponsibility: nil → derive from relationship (not explicit).
	// Non-nil → validate and mark as explicitly set.
	var dataResponsibility string
	responsibilityExplicit := false
	if req.DataResponsibility != nil {
		dataResponsibility = *req.DataResponsibility
		if dataResponsibility == "self" || !domain.ValidDataResponsibility[dataResponsibility] {
			http.Error(w, `{"error":"invalid data_responsibility value (self not allowed)"}`, http.StatusBadRequest)
			return
		}
		responsibilityExplicit = true
	} else {
		dataResponsibility = domain.DefaultResponsibility(relationship)
	}

	// Bidirectional uniqueness: reject if name collides with an existing alias.
	if h.Aliases != nil {
		if existingDID, err := h.Aliases.ResolveAlias(r.Context(), req.Name); err == nil && existingDID != "" {
			http.Error(w, `{"error":"name conflicts with an existing contact alias"}`, http.StatusConflict)
			return
		}
	}

	if err := h.Contacts.Add(r.Context(), req.DID, req.Name, trustLevel, relationship, dataResponsibility, responsibilityExplicit); err != nil {
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
	Name               string    `json:"name"`
	TrustLevel         string    `json:"trust_level"`
	LastContact        int64     `json:"last_contact"`
	Relationship       *string   `json:"relationship,omitempty"`
	DataResponsibility *string   `json:"data_responsibility,omitempty"`
	// PreferredFor is a pointer-to-slice so the caller can distinguish
	// "don't touch" (nil) from "clear all preferences" (empty slice).
	// Values are normalised (lowercased + trimmed + deduped) inside the
	// directory — callers can pass raw input.
	PreferredFor       *[]string `json:"preferred_for,omitempty"`
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
		// Bidirectional uniqueness: reject if new name collides with an existing alias.
		if h.Aliases != nil {
			if existingDID, err := h.Aliases.ResolveAlias(r.Context(), req.Name); err == nil && existingDID != "" && existingDID != did {
				http.Error(w, `{"error":"name conflicts with an existing contact alias"}`, http.StatusConflict)
				return
			}
		}
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

	// Update precedence: data_responsibility first (sets explicit=true),
	// then relationship (won't recompute since explicit is already true).
	if req.DataResponsibility != nil {
		dr := *req.DataResponsibility
		if dr == "self" || !domain.ValidDataResponsibility[dr] {
			http.Error(w, `{"error":"invalid data_responsibility value"}`, http.StatusBadRequest)
			return
		}
		if err := h.Contacts.UpdateDataResponsibility(r.Context(), did, dr); err != nil {
			slog.Warn("failed to update contact data_responsibility", "did", did, "error", err)
			http.Error(w, `{"error":"failed to update contact"}`, http.StatusInternalServerError)
			return
		}
	}

	if req.Relationship != nil {
		rel := *req.Relationship
		if !domain.ValidContactRelationships[rel] {
			http.Error(w, `{"error":"invalid relationship value"}`, http.StatusBadRequest)
			return
		}
		if err := h.Contacts.UpdateRelationship(r.Context(), did, rel); err != nil {
			slog.Warn("failed to update contact relationship", "did", did, "error", err)
			http.Error(w, `{"error":"failed to update contact"}`, http.StatusInternalServerError)
			return
		}
	}

	// PreferredFor: pointer-to-slice so nil = no-op, empty = clear.
	// The directory normalises input; callers can be sloppy.
	if req.PreferredFor != nil {
		if err := h.Contacts.SetPreferredFor(r.Context(), did, *req.PreferredFor); err != nil {
			slog.Warn("failed to update contact preferred_for", "did", did, "error", err)
			http.Error(w, `{"error":"failed to update contact"}`, http.StatusInternalServerError)
			return
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

	// Use transactional delete if alias store supports it (SQLite).
	type txDeleter interface {
		DeleteContactWithAliases(ctx context.Context, did string) error
	}
	if td, ok := h.Aliases.(txDeleter); ok {
		if err := td.DeleteContactWithAliases(r.Context(), did); err != nil {
			slog.Warn("failed to delete contact", "did", did, "error", err)
			http.Error(w, `{"error":"failed to delete contact"}`, http.StatusInternalServerError)
			return
		}
	} else {
		// Fallback: delete aliases first, then contact (non-transactional).
		if h.Aliases != nil {
			_ = h.Aliases.DeleteAllForContact(r.Context(), did)
		}
		if err := h.Contacts.Delete(r.Context(), did); err != nil {
			slog.Warn("failed to delete contact", "did", did, "error", err)
			http.Error(w, `{"error":"failed to delete contact"}`, http.StatusInternalServerError)
			return
		}
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

// ---------------------------------------------------------------------------
// Alias endpoints
// ---------------------------------------------------------------------------

type addAliasRequest struct {
	Alias string `json:"alias"`
}

// HandleAddAlias handles POST /v1/contacts/{did}/aliases.
func (h *ContactHandler) HandleAddAlias(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	if h.Aliases == nil {
		http.Error(w, `{"error":"alias store not configured"}`, http.StatusInternalServerError)
		return
	}

	// Extract DID: path is /v1/contacts/{did}/aliases
	path := r.URL.Path
	if r.URL.RawPath != "" {
		path = r.URL.RawPath
	}
	trimmed := strings.TrimPrefix(path, "/v1/contacts/")
	trimmed = strings.TrimSuffix(trimmed, "/aliases")
	did, err := url.PathUnescape(trimmed)
	if err != nil || did == "" {
		http.Error(w, `{"error":"missing DID in path"}`, http.StatusBadRequest)
		return
	}

	var req addAliasRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	if err := h.Aliases.AddAlias(r.Context(), did, req.Alias); err != nil {
		if strings.Contains(err.Error(), "conflicts") || strings.Contains(err.Error(), "already belongs") {
			http.Error(w, fmt.Sprintf(`{"error":"%s"}`, err.Error()), http.StatusConflict)
		} else {
			http.Error(w, fmt.Sprintf(`{"error":"%s"}`, err.Error()), http.StatusBadRequest)
		}
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{"status": "alias_added", "alias": req.Alias})
}

// HandleRemoveAlias handles DELETE /v1/contacts/{did}/aliases/{alias}.
func (h *ContactHandler) HandleRemoveAlias(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	if h.Aliases == nil {
		http.Error(w, `{"error":"alias store not configured"}`, http.StatusInternalServerError)
		return
	}

	// Extract DID and alias from path: /v1/contacts/{did}/aliases/{alias}
	path := r.URL.Path
	if r.URL.RawPath != "" {
		path = r.URL.RawPath
	}
	trimmed := strings.TrimPrefix(path, "/v1/contacts/")
	parts := strings.SplitN(trimmed, "/aliases/", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		http.Error(w, `{"error":"missing DID or alias in path"}`, http.StatusBadRequest)
		return
	}
	did, _ := url.PathUnescape(parts[0])
	alias, _ := url.PathUnescape(parts[1])

	if err := h.Aliases.RemoveAlias(r.Context(), did, alias); err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"%s"}`, err.Error()), http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "alias_removed"})
}

// HandleListAliases handles GET /v1/contacts/{did}/aliases.
func (h *ContactHandler) HandleListAliases(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	if h.Aliases == nil {
		http.Error(w, `{"error":"alias store not configured"}`, http.StatusInternalServerError)
		return
	}

	path := r.URL.Path
	if r.URL.RawPath != "" {
		path = r.URL.RawPath
	}
	trimmed := strings.TrimPrefix(path, "/v1/contacts/")
	trimmed = strings.TrimSuffix(trimmed, "/aliases")
	did, _ := url.PathUnescape(trimmed)
	if did == "" {
		http.Error(w, `{"error":"missing DID in path"}`, http.StatusBadRequest)
		return
	}

	aliases, err := h.Aliases.ListAliases(r.Context(), did)
	if err != nil {
		http.Error(w, `{"error":"failed to list aliases"}`, http.StatusInternalServerError)
		return
	}
	if aliases == nil {
		aliases = []string{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"aliases": aliases})
}
