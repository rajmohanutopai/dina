package handler

import (
	"encoding/json"
	"net/http"

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
