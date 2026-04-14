package handler

import (
	"encoding/json"
	"io"
	"net/http"

	"github.com/rajmohanutopai/dina/core/internal/service"
)

// ServiceConfigHandler exposes GET/PUT /v1/service/config.
type ServiceConfigHandler struct {
	Config *service.ServiceConfigService
}

// Handle routes GET and PUT for /v1/service/config.
func (h *ServiceConfigHandler) Handle(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		h.handleGet(w, r)
	case http.MethodPut:
		h.handlePut(w, r)
	default:
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
	}
}

func (h *ServiceConfigHandler) handleGet(w http.ResponseWriter, _ *http.Request) {
	if h.Config == nil {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte("null"))
		return
	}
	cfg, err := h.Config.Get()
	if err != nil {
		clientError(w, "failed to read service config", http.StatusInternalServerError, err)
		return
	}
	if cfg == nil {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte("null"))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(cfg)
}

func (h *ServiceConfigHandler) handlePut(w http.ResponseWriter, r *http.Request) {
	if h.Config == nil {
		http.Error(w, `{"error":"service config not available (no-CGO mode)"}`, http.StatusServiceUnavailable)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 64*1024))
	if err != nil {
		http.Error(w, `{"error":"read body failed"}`, http.StatusBadRequest)
		return
	}

	var cfg service.ServiceConfig
	if err := json.Unmarshal(body, &cfg); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, http.StatusBadRequest)
		return
	}

	if err := h.Config.Put(&cfg); err != nil {
		clientError(w, "failed to save service config", http.StatusBadRequest, err)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}
