package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/service"
)

// PeerlensHandler exposes trust cache endpoints for the admin UI.
type PeerlensHandler struct {
	Trust  *service.PeerlensService
	OwnDID string
}

// HandleListCache returns all cached trust entries.
// GET /v1/peerlens/cache
func (h *PeerlensHandler) HandleListCache(w http.ResponseWriter, r *http.Request) {
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
// GET /v1/peerlens/stats
func (h *PeerlensHandler) HandleStats(w http.ResponseWriter, r *http.Request) {
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

// HandleResolve looks up a DID's PeerLens profile from AppView.
// GET /v1/peerlens/resolve?did={did}
func (h *PeerlensHandler) HandleResolve(w http.ResponseWriter, r *http.Request) {
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

// HandleSearch proxies search queries to AppView's trust search endpoint.
// GET /v1/peerlens/search?q={query}&category={category}&subjectType={type}&limit={n}
func (h *PeerlensHandler) HandleSearch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	query := r.URL.Query().Get("q")
	category := r.URL.Query().Get("category")
	subjectType := r.URL.Query().Get("subjectType")
	limit := 10
	if l := r.URL.Query().Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 && n <= 25 {
			limit = n
		}
	}

	results, err := h.Trust.SearchPeerlens(query, category, subjectType, limit)
	if err != nil {
		if errors.Is(err, domain.ErrAppViewNotConfigured) {
			http.Error(w, `{"error":"appview not configured"}`, http.StatusServiceUnavailable)
			return
		}
		http.Error(w, `{"error":"appview search failed"}`, http.StatusBadGateway)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Write(results)
}

// HandleSync triggers a manual trust neighborhood sync.
// POST /v1/peerlens/sync
func (h *PeerlensHandler) HandleSync(w http.ResponseWriter, r *http.Request) {
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
