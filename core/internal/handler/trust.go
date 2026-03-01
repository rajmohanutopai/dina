package handler

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/service"
)

// TrustHandler exposes trust cache endpoints for the admin UI.
type TrustHandler struct {
	Trust  *service.TrustService
	OwnDID string
}

// HandleListCache returns all cached trust entries.
// GET /v1/trust/cache
func (h *TrustHandler) HandleListCache(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	entries, err := h.Trust.GetCacheEntries()
	if err != nil {
		http.Error(w, `{"error":"failed to list trust cache"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"entries": entries,
	})
}

// HandleStats returns trust cache statistics.
// GET /v1/trust/stats
func (h *TrustHandler) HandleStats(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	stats, err := h.Trust.GetCacheStats()
	if err != nil {
		http.Error(w, `{"error":"failed to get trust stats"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(stats)
}

// HandleResolve looks up a DID's trust profile from AppView.
// GET /v1/trust/resolve?did={did}
func (h *TrustHandler) HandleResolve(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	did := r.URL.Query().Get("did")
	if did == "" {
		http.Error(w, `{"error":"did parameter required"}`, http.StatusBadRequest)
		return
	}

	profile, err := h.Trust.ResolveProfile(did)
	if err != nil {
		if errors.Is(err, domain.ErrAppViewNotConfigured) {
			http.Error(w, `{"error":"appview not configured"}`, http.StatusServiceUnavailable)
			return
		}
		// Transient upstream failure — report as 502 Bad Gateway so the caller
		// can distinguish "AppView is down" from "DID not found".
		http.Error(w, `{"error":"appview upstream error"}`, http.StatusBadGateway)
		return
	}

	if profile == nil {
		// (nil, nil) means DID genuinely not found in AppView (404).
		http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Write(profile)
}

// HandleSync triggers a manual trust neighborhood sync.
// POST /v1/trust/sync
func (h *TrustHandler) HandleSync(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	synced, err := h.Trust.ManualSync(h.OwnDID)
	if err != nil {
		http.Error(w, `{"error":"sync failed"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"synced_count": synced,
	})
}
