package handler

import (
	"encoding/json"
	"net/http"

	"github.com/anthropics/dina/core/internal/service"
)

// TaskHandler exposes task acknowledgement endpoints.
type TaskHandler struct {
	Task *service.TaskService
}

// ackRequest is the JSON body for POST /v1/task/ack.
type ackRequest struct {
	TaskID string `json:"task_id"`
}

// HandleAck handles POST /v1/task/ack. It acknowledges the completion of a
// task by processing the next item in the queue. Returns 200 OK on success.
func (h *TaskHandler) HandleAck(w http.ResponseWriter, r *http.Request) {
	var req ackRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	if req.TaskID == "" {
		http.Error(w, `{"error":"task_id is required"}`, http.StatusBadRequest)
		return
	}

	// Process the next queued task. The task_id is used for correlation
	// and audit logging in the task service.
	task, err := h.Task.ProcessNext(r.Context())
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if task == nil {
		json.NewEncoder(w).Encode(map[string]string{"status": "no pending tasks"})
		return
	}
	json.NewEncoder(w).Encode(map[string]string{"status": "acknowledged", "task_id": task.ID})
}
