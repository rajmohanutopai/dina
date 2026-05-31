package handler

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
	"github.com/rajmohanutopai/dina/core/internal/service"
)

// ServiceRespondHandler handles POST /v1/service/respond.
// Brain calls this to send a service.response for an approved approval task.
// Core atomically claims the task, opens a fresh provider window, sends the
// response, and completes the task.
type ServiceRespondHandler struct {
	Workflow  *service.WorkflowService
	Transport *service.TransportService
	Clock     port.Clock
}

type serviceRespondRequest struct {
	TaskID       string          `json:"task_id"`
	ResponseBody json.RawMessage `json:"response_body"`
}

// Handle processes POST /v1/service/respond.
func (h *ServiceRespondHandler) Handle(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, `{"error":"read body failed"}`, http.StatusBadRequest)
		return
	}

	var req serviceRespondRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, http.StatusBadRequest)
		return
	}
	if req.TaskID == "" {
		http.Error(w, `{"error":"task_id required"}`, http.StatusBadRequest)
		return
	}

	// Atomic claim: queued → running, extends expires_at by 60s.
	claimErr := h.Workflow.Store().ClaimApprovalForExecution(r.Context(), req.TaskID, 60)
	if claimErr != nil {
		// Disambiguate: already terminal, running (another caller), or not found.
		task, _ := h.Workflow.GetByID(r.Context(), req.TaskID)
		if task == nil {
			http.Error(w, `{"error":"task not found"}`, http.StatusNotFound)
			return
		}
		if domain.IsTerminal(domain.WorkflowTaskState(task.Status)) {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"already_processed": true,
				"status":            task.Status,
			})
			return
		}
		if task.Status == string(domain.WFRunning) && task.Kind == string(domain.WFKindApproval) {
			// Check for crash recovery: run_id set = response already enqueued.
			// Complete the task now (response is already in the outbox).
			if task.RunID != "" {
				slog.Info("service_respond: crash recovery — completing task with enqueued response",
					"task_id", req.TaskID, "run_id", task.RunID)
				// Use the result from the task if available, otherwise minimal details.
				resultJSON := task.Result
				eventDetails := `{"state":"completed","reason":"crash_recovery"}`
				if resultJSON == "" {
					resultJSON = `{"recovered":true}`
				}
				_, recoverErr := h.Workflow.CompleteWithDetails(
					r.Context(), req.TaskID, "", "recovered", resultJSON, eventDetails,
				)
				if recoverErr != nil {
					slog.Warn("service_respond: crash recovery completion failed",
						"task_id", req.TaskID, "error", recoverErr)
					http.Error(w, `{"error":"crash recovery completion failed"}`, http.StatusInternalServerError)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				json.NewEncoder(w).Encode(map[string]interface{}{
					"already_processed": true,
					"status":            "recovered",
				})
				return
			}
			http.Error(w, `{"error":"task already claimed by another caller"}`, http.StatusConflict)
			return
		}
		slog.Warn("service_respond: claim failed", "task_id", req.TaskID, "error", claimErr)
		http.Error(w, `{"error":"claim failed"}`, http.StatusInternalServerError)
		return
	}

	// Extract from_did, query_id, capability from task payload.
	task, err := h.Workflow.GetByID(r.Context(), req.TaskID)
	if err != nil || task == nil {
		slog.Warn("service_respond: GetByID failed after claim — rolling back", "task_id", req.TaskID, "error", err)
		if rbErr := h.Workflow.Store().Transition(r.Context(), req.TaskID, domain.WFRunning, domain.WFQueued); rbErr != nil {
			slog.Warn("service_respond: rollback to queued failed", "task_id", req.TaskID, "error", rbErr)
		}
		http.Error(w, `{"error":"task read failed after claim"}`, http.StatusInternalServerError)
		return
	}
	var taskPayload map[string]interface{}
	if err := json.Unmarshal([]byte(task.Payload), &taskPayload); err != nil {
		slog.Error("service_respond: invalid task payload JSON", "task_id", req.TaskID, "error", err)
		if rbErr := h.Workflow.Store().Transition(r.Context(), req.TaskID, domain.WFRunning, domain.WFQueued); rbErr != nil {
			slog.Warn("service_respond: rollback to queued failed — task stuck in running", "task_id", req.TaskID, "error", rbErr)
		}
		http.Error(w, `{"error":"invalid task payload"}`, http.StatusInternalServerError)
		return
	}
	fromDID, _ := taskPayload["from_did"].(string)
	queryID, _ := taskPayload["query_id"].(string)
	capability, _ := taskPayload["capability"].(string)
	ttlSeconds := 60 // default
	if ttl, ok := taskPayload["ttl_seconds"].(float64); ok {
		ttlSeconds = int(ttl)
	}

	if fromDID == "" || queryID == "" || capability == "" {
		slog.Error("service_respond: incomplete task payload", "task_id", req.TaskID)
		// Transition back to queued for retry.
		if rbErr := h.Workflow.Store().Transition(r.Context(), req.TaskID, domain.WFRunning, domain.WFQueued); rbErr != nil {
			slog.Warn("service_respond: rollback to queued failed — task stuck in running", "task_id", req.TaskID, "error", rbErr)
		}
		http.Error(w, `{"error":"incomplete task payload"}`, http.StatusInternalServerError)
		return
	}

	// Open a fresh provider window scoped to the original request's TTL so
	// the response contract matches what the requester is already waiting
	// for. Matches the bridge path's behaviour.
	h.Transport.SetProviderWindow(fromDID, queryID, capability, ttlSeconds)

	// Build service.response D2D message.
	responseBody := domain.ServiceResponseBody{
		QueryID:    queryID,
		Capability: capability,
		TTLSeconds: ttlSeconds,
	}
	// Merge response_body from request (validate JSON).
	if len(req.ResponseBody) > 0 {
		if err := json.Unmarshal(req.ResponseBody, &responseBody); err != nil {
			slog.Warn("service_respond: invalid response_body JSON", "task_id", req.TaskID, "error", err)
			h.Transport.ReleaseProviderWindow(fromDID, queryID, capability)
			if rbErr := h.Workflow.Store().Transition(r.Context(), req.TaskID, domain.WFRunning, domain.WFQueued); rbErr != nil {
				slog.Warn("service_respond: rollback to queued failed", "task_id", req.TaskID, "error", rbErr)
			}
			http.Error(w, `{"error":"invalid response_body JSON"}`, http.StatusBadRequest)
			return
		}
	}
	// Preserve task-authoritative fields (not overridable from request body).
	responseBody.QueryID = queryID
	responseBody.Capability = capability
	responseBody.TTLSeconds = ttlSeconds // original query contract
	// Validate status — must be one of the D2D wire vocabulary.
	if responseBody.Status != "success" && responseBody.Status != "unavailable" && responseBody.Status != "error" {
		h.Transport.ReleaseProviderWindow(fromDID, queryID, capability)
		if rbErr := h.Workflow.Store().Transition(r.Context(), req.TaskID, domain.WFRunning, domain.WFQueued); rbErr != nil {
			slog.Warn("service_respond: rollback to queued failed", "task_id", req.TaskID, "error", rbErr)
		}
		http.Error(w, `{"error":"response_body.status must be success|unavailable|error"}`, http.StatusBadRequest)
		return
	}

	responseJSON, _ := json.Marshal(responseBody)
	nowUnix := h.Clock.Now().Unix()
	d2dMsg := domain.DinaMessage{
		ID:          "svc-resp-" + req.TaskID,
		Type:        domain.MsgTypeServiceResponse,
		Body:        responseJSON,
		CreatedTime: nowUnix,
	}

	sendErr := h.Transport.SendMessage(r.Context(), domain.DID(fromDID), d2dMsg)
	if sendErr != nil {
		slog.Warn("service_respond: D2D send failed", "task_id", req.TaskID, "error", sendErr)
		// Release window, transition back to queued for retry.
		h.Transport.ReleaseProviderWindow(fromDID, queryID, capability)
		if rbErr := h.Workflow.Store().Transition(r.Context(), req.TaskID, domain.WFRunning, domain.WFQueued); rbErr != nil {
			slog.Warn("service_respond: rollback to queued failed — task stuck in running", "task_id", req.TaskID, "error", rbErr)
		}
		http.Error(w, `{"error":"send failed"}`, http.StatusBadGateway)
		return
	}

	// Set run_id as durable marker (response enqueued in outbox).
	// run_id is unused for approval tasks (no agents) and not user-visible via Telegram.
	if runIDErr := h.Workflow.Store().SetRunID(r.Context(), req.TaskID, "svc-resp:"+req.TaskID); runIDErr != nil {
		slog.Warn("service_respond: SetRunID failed — crash recovery marker not set",
			"task_id", req.TaskID, "error", runIDErr)
		// Non-fatal: CompleteWithDetails below will still attempt task completion.
		// If both fail (persistent DB outage), task stays running until expiry.
		// The response was already enqueued in the outbox and will be delivered.
	}

	// Complete the task with response details.
	eventDetails, _ := json.Marshal(map[string]interface{}{
		"response_status": responseBody.Status,
		"service_name":    taskPayload["service_name"],
		"capability":      capability,
	})
	_, completeErr := h.Workflow.CompleteWithDetails(
		r.Context(), req.TaskID, "", "responded", string(responseJSON), string(eventDetails),
	)
	if completeErr != nil {
		// Response was sent (outbox has it) but task completion failed.
		// run_id marker is set, so reconciliation can complete it later.
		slog.Warn("service_respond: task completion failed after send",
			"task_id", req.TaskID, "error", completeErr)
		http.Error(w, `{"error":"response sent but task completion failed"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "sent", "task_id": req.TaskID})
}
