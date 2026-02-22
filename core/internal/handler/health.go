package handler

import (
	"encoding/json"
	"net/http"

	"github.com/anthropics/dina/core/internal/port"
)

// HealthHandler exposes liveness and readiness probes.
type HealthHandler struct {
	Health port.HealthChecker
}

// HandleLiveness responds to GET /healthz. Returns 200 if the process is alive,
// 503 if the health check reports an error.
func (h *HealthHandler) HandleLiveness(w http.ResponseWriter, r *http.Request) {
	if err := h.Health.Liveness(); err != nil {
		http.Error(w, `{"status":"unhealthy"}`, http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// HandleReadiness responds to GET /readyz. Returns 200 if the vault is queryable,
// 503 with a reason if the system is not ready to serve traffic.
func (h *HealthHandler) HandleReadiness(w http.ResponseWriter, r *http.Request) {
	if err := h.Health.Readiness(); err != nil {
		http.Error(w, `{"status":"not ready","reason":"`+err.Error()+`"}`, http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ready"})
}
