package handler

import (
	"crypto/subtle"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"

	"github.com/rajmohanutopai/dina/core/internal/port"
)

// DelegatedTaskCallbackHandler handles terminal callbacks from OpenClaw's
// agent_end hook. These are internal endpoints authenticated by a pre-shared
// Bearer token, not by device Ed25519 signatures.
//
// Endpoints:
//   POST /v1/internal/delegated-tasks/{id}/complete
//   POST /v1/internal/delegated-tasks/{id}/fail
//   POST /v1/internal/delegated-tasks/{id}/progress
type DelegatedTaskCallbackHandler struct {
	Tasks         port.DelegatedTaskStore
	Sessions      port.AgentSessionManager
	CallbackToken string // pre-shared secret for OpenClaw hooks
}

// verifyToken checks the Bearer token with constant-time comparison.
func (h *DelegatedTaskCallbackHandler) verifyToken(r *http.Request) bool {
	if h.CallbackToken == "" {
		return false
	}
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		return false
	}
	token := strings.TrimPrefix(auth, "Bearer ")
	return subtle.ConstantTimeCompare([]byte(token), []byte(h.CallbackToken)) == 1
}

// HandleComplete handles POST /v1/internal/delegated-tasks/{id}/complete.
// Idempotent: already terminal → 200 no-op.
// Accepts tasks in running OR claimed (race protection for fast callbacks).
func (h *DelegatedTaskCallbackHandler) HandleComplete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !h.verifyToken(r) {
		jsonError(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	taskID := extractCallbackTaskID(r.URL.Path, "/complete")
	if taskID == "" {
		jsonError(w, "task_id required", http.StatusBadRequest)
		return
	}

	var req struct {
		Result string `json:"result"`
	}
	json.NewDecoder(r.Body).Decode(&req)

	// Look up the task to get agent_did for the store call.
	task, err := h.Tasks.GetByID(r.Context(), taskID)
	if err != nil || task == nil {
		jsonError(w, "task not found", http.StatusNotFound)
		return
	}

	// Idempotent: already terminal
	switch task.Status {
	case "completed", "failed", "cancelled", "expired":
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": string(task.Status), "noop": "true"})
		return
	}

	if err := h.Tasks.Complete(r.Context(), taskID, task.AgentDID, req.Result); err != nil {
		slog.Warn("callback.complete_failed", "task_id", taskID, "error", err)
		jsonError(w, "complete failed", http.StatusInternalServerError)
		return
	}

	// End linked session server-side.
	if h.Sessions != nil && task.SessionName != "" && task.AgentDID != "" {
		if err := h.Sessions.EndSession(r.Context(), task.AgentDID, task.SessionName); err != nil {
			slog.Warn("callback.session_end_failed",
				"task_id", taskID, "session", task.SessionName, "error", err)
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "completed"})
}

// HandleFail handles POST /v1/internal/delegated-tasks/{id}/fail.
func (h *DelegatedTaskCallbackHandler) HandleFail(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !h.verifyToken(r) {
		jsonError(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	taskID := extractCallbackTaskID(r.URL.Path, "/fail")
	if taskID == "" {
		jsonError(w, "task_id required", http.StatusBadRequest)
		return
	}

	var req struct {
		Error string `json:"error"`
	}
	json.NewDecoder(r.Body).Decode(&req)

	task, err := h.Tasks.GetByID(r.Context(), taskID)
	if err != nil || task == nil {
		jsonError(w, "task not found", http.StatusNotFound)
		return
	}

	// Idempotent
	switch task.Status {
	case "completed", "failed", "cancelled", "expired":
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": string(task.Status), "noop": "true"})
		return
	}

	if err := h.Tasks.Fail(r.Context(), taskID, task.AgentDID, req.Error); err != nil {
		slog.Warn("callback.fail_failed", "task_id", taskID, "error", err)
		jsonError(w, "fail failed", http.StatusInternalServerError)
		return
	}

	if h.Sessions != nil && task.SessionName != "" && task.AgentDID != "" {
		if err := h.Sessions.EndSession(r.Context(), task.AgentDID, task.SessionName); err != nil {
			slog.Warn("callback.session_end_failed",
				"task_id", taskID, "session", task.SessionName, "error", err)
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "failed"})
}

// HandleProgress handles POST /v1/internal/delegated-tasks/{id}/progress.
func (h *DelegatedTaskCallbackHandler) HandleProgress(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !h.verifyToken(r) {
		jsonError(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	taskID := extractCallbackTaskID(r.URL.Path, "/progress")
	if taskID == "" {
		jsonError(w, "task_id required", http.StatusBadRequest)
		return
	}

	var req struct {
		Message string `json:"message"`
	}
	json.NewDecoder(r.Body).Decode(&req)

	task, err := h.Tasks.GetByID(r.Context(), taskID)
	if err != nil || task == nil {
		jsonError(w, "task not found", http.StatusNotFound)
		return
	}

	if err := h.Tasks.UpdateProgress(r.Context(), taskID, task.AgentDID, req.Message); err != nil {
		jsonError(w, err.Error(), http.StatusBadRequest)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// HandleList handles GET /v1/internal/delegated-tasks?status=running.
// Returns all tasks unfiltered (not scoped by agent_did).
// Used by the reconciler to find stale running tasks from any daemon.
func (h *DelegatedTaskCallbackHandler) HandleList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !h.verifyToken(r) {
		jsonError(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	status := r.URL.Query().Get("status")
	tasks, err := h.Tasks.List(r.Context(), status, 100)
	if err != nil {
		jsonError(w, "list failed", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"tasks": tasks})
}

// extractCallbackTaskID extracts task ID from /v1/internal/delegated-tasks/{id}/suffix.
func extractCallbackTaskID(path, suffix string) string {
	const prefix = "/v1/internal/delegated-tasks/"
	if !strings.HasPrefix(path, prefix) {
		return ""
	}
	rest := path[len(prefix):]
	rest = strings.TrimSuffix(rest, suffix)
	rest = strings.TrimRight(rest, "/")
	if rest == "" || strings.Contains(rest, "/") {
		return ""
	}
	return rest
}
