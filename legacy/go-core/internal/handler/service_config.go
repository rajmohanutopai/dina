package handler

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
	"github.com/rajmohanutopai/dina/core/internal/service"
)

// ServiceConfigHandler exposes GET/PUT /v1/service/config.
type ServiceConfigHandler struct {
	Config *service.ServiceConfigService
	Brain  port.BrainClient // optional: push config_changed events to Brain
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

	// Push config_changed event to Brain so it picks up changes immediately.
	// Best-effort — Brain also loads config at startup.
	if h.Brain != nil {
		go func() {
			cfgJSON, _ := json.Marshal(cfg)
			_ = h.Brain.Process(context.Background(), domain.TaskEvent{
				Type: "config_changed",
				Payload: map[string]interface{}{
					"scope":  "service_config",
					"config": json.RawMessage(cfgJSON),
				},
			})
			slog.Info("service_config: pushed config_changed to Brain")
		}()
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}
