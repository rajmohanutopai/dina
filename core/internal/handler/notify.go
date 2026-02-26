package handler

import (
	"encoding/json"
	"net/http"

	"github.com/rajmohanutopai/dina/core/internal/port"
)

// NotifyHandler serves the /v1/notify endpoint.
type NotifyHandler struct {
	Notifier port.ClientNotifier
}

// notifyRequest is the JSON body for POST /v1/notify.
type notifyRequest struct {
	Message string `json:"message"`
}

// HandleNotify handles POST /v1/notify.
// It broadcasts a notification message to all connected client devices.
func (h *NotifyHandler) HandleNotify(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req notifyRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	if req.Message == "" {
		http.Error(w, `{"error":"message is required"}`, http.StatusBadRequest)
		return
	}

	if err := h.Notifier.Broadcast(r.Context(), []byte(req.Message)); err != nil {
		http.Error(w, `{"error":"broadcast failed"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "sent"})
}
