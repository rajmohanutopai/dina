package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httputil"
	"net/url"
)

// AdminHandler serves the /admin/* endpoints by reverse-proxying
// to the Python brain's admin UI.
type AdminHandler struct {
	ProxyURL string
}

// HandleAdmin reverse-proxies requests to the brain admin UI.
func (h *AdminHandler) HandleAdmin(w http.ResponseWriter, r *http.Request) {
	target, err := url.Parse(h.ProxyURL)
	if err != nil {
		http.Error(w, `{"error":"invalid proxy target"}`, http.StatusInternalServerError)
		return
	}

	proxy := &httputil.ReverseProxy{
		Director: func(req *http.Request) {
			req.URL.Scheme = target.Scheme
			req.URL.Host = target.Host
			req.Host = target.Host
			// Forward the original client protocol so Brain can set
			// Secure cookie flag correctly behind the reverse proxy.
			if req.Header.Get("X-Forwarded-Proto") == "" {
				if req.TLS != nil {
					req.Header.Set("X-Forwarded-Proto", "https")
				} else {
					req.Header.Set("X-Forwarded-Proto", "http")
				}
			}
		},
	}

	proxy.ServeHTTP(w, r)
}

// syncStatusResponse is the JSON body for GET /admin/sync-status.
type syncStatusResponse struct {
	BrainConnected bool   `json:"brain_connected"`
	ProxyTarget    string `json:"proxy_target"`
	Status         string `json:"status"`
}

// HandleSyncStatus returns the sync status between core and brain.
func (h *AdminHandler) HandleSyncStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	resp := syncStatusResponse{
		BrainConnected: h.ProxyURL != "",
		ProxyTarget:    h.ProxyURL,
		Status:         "ok",
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(resp); err != nil {
		http.Error(w, `{"error":"failed to encode response"}`, http.StatusInternalServerError)
	}
}
