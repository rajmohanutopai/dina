package handler

import (
	"encoding/json"
	"net/http"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
	"github.com/rajmohanutopai/dina/core/internal/reminder"
)

// ReminderHandler exposes reminder scheduling endpoints.
type ReminderHandler struct {
	Scheduler port.ReminderScheduler
	Loop      *reminder.Loop
	OnFire    func(id, typ string) // callback for test-only fire endpoint
}

// storeReminderRequest is the JSON body for POST /v1/reminder.
type storeReminderRequest struct {
	Type         string `json:"type"`
	Message      string `json:"message"`
	TriggerAt    int64  `json:"trigger_at"`
	Metadata     string `json:"metadata"`
	SourceItemID string `json:"source_item_id"`
	Source       string `json:"source"`
	Persona      string `json:"persona"`
	Timezone     string `json:"timezone"`
	Kind         string `json:"kind"`
}

// HandleStoreReminder handles POST /v1/reminder.
// It stores a new reminder and wakes the reminder loop.
func (h *ReminderHandler) HandleStoreReminder(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req storeReminderRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	// Type (recurrence) is optional — reminders can have just a kind.
	// At least one of type or kind must be set.
	if req.Type == "" && req.Kind == "" {
		http.Error(w, `{"error":"type or kind is required"}`, http.StatusBadRequest)
		return
	}
	if req.TriggerAt <= 0 {
		http.Error(w, `{"error":"trigger_at must be a positive Unix timestamp"}`, http.StatusBadRequest)
		return
	}

	rem := domain.Reminder{
		Type:         req.Type,
		Message:      req.Message,
		TriggerAt:    req.TriggerAt,
		Metadata:     req.Metadata,
		SourceItemID: req.SourceItemID,
		Source:       req.Source,
		Persona:      req.Persona,
		Timezone:     req.Timezone,
		Kind:         req.Kind,
		Status:       "pending",
	}

	id, err := h.Scheduler.StoreReminder(r.Context(), rem)
	if err != nil {
		http.Error(w, `{"error":"failed to store reminder"}`, http.StatusInternalServerError)
		return
	}

	// Wake the loop so it recomputes the next trigger time.
	if h.Loop != nil {
		h.Loop.Wake()
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{
		"id":     id,
		"status": "stored",
	})
}

// HandleListPending handles GET /v1/reminders/pending.
// It returns all unfired reminders.
func (h *ReminderHandler) HandleListPending(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	pending, err := h.Scheduler.ListPending(r.Context())
	if err != nil {
		http.Error(w, `{"error":"failed to list reminders"}`, http.StatusInternalServerError)
		return
	}

	if pending == nil {
		pending = []domain.Reminder{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"reminders": pending,
	})
}

// fireReminderRequest is the JSON body for POST /v1/reminder/fire.
type fireReminderRequest struct {
	ReminderID string `json:"reminder_id"`
}

// HandleFireReminder handles POST /v1/reminder/fire (test-only).
// It marks a reminder as fired and invokes the onFire callback synchronously.
func (h *ReminderHandler) HandleFireReminder(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req fireReminderRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	if req.ReminderID == "" {
		http.Error(w, `{"error":"reminder_id is required"}`, http.StatusBadRequest)
		return
	}

	// Get the reminder to retrieve its type.
	rem, err := h.Scheduler.GetByID(r.Context(), req.ReminderID)
	if err != nil {
		http.Error(w, `{"error":"reminder not found"}`, http.StatusNotFound)
		return
	}

	// Mark as fired.
	if err := h.Scheduler.MarkFired(r.Context(), req.ReminderID); err != nil {
		http.Error(w, `{"error":"failed to mark fired"}`, http.StatusInternalServerError)
		return
	}

	// Invoke the onFire callback (same code path as the reminder loop).
	if h.OnFire != nil {
		h.OnFire(rem.ID, rem.Type)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"status":      "fired",
		"reminder_id": rem.ID,
		"type":        rem.Type,
	})
}
