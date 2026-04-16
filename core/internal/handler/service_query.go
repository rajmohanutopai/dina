package handler

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
	"github.com/rajmohanutopai/dina/core/internal/service"
)

// ServiceQueryHandler handles POST /v1/service/query.
// Brain sends service queries through this endpoint. Core creates a durable
// workflow_task, sends the D2D message, and returns the task info.
type ServiceQueryHandler struct {
	Workflow  *service.WorkflowService
	Transport *service.TransportService
	Clock     port.Clock
}

type serviceQueryRequest struct {
	ToDID          string          `json:"to_did"`
	Capability     string          `json:"capability"`
	Params         json.RawMessage `json:"params"`
	TTLSeconds     int             `json:"ttl_seconds"`
	ServiceName    string          `json:"service_name"`
	QueryID        string          `json:"query_id"`
	OriginChannel  string          `json:"origin_channel,omitempty"` // WS2: routing context for notifications
}

type serviceQueryResponse struct {
	TaskID  string `json:"task_id"`
	QueryID string `json:"query_id"`
}

// Handle processes POST /v1/service/query.
func (h *ServiceQueryHandler) Handle(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, `{"error":"read body failed"}`, http.StatusBadRequest)
		return
	}

	var req serviceQueryRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, http.StatusBadRequest)
		return
	}

	// Validate required fields.
	if req.ToDID == "" || req.Capability == "" || req.QueryID == "" {
		http.Error(w, `{"error":"to_did, capability, and query_id are required"}`, http.StatusBadRequest)
		return
	}
	// Issue #16: validate to_did format (must be a DID).
	if !strings.HasPrefix(req.ToDID, "did:") {
		http.Error(w, `{"error":"to_did must be a valid DID (did:...)"}`, http.StatusBadRequest)
		return
	}
	if req.TTLSeconds < 1 || req.TTLSeconds > domain.MaxServiceTTL {
		http.Error(w, fmt.Sprintf(`{"error":"ttl_seconds must be 1–%d"}`, domain.MaxServiceTTL), http.StatusBadRequest)
		return
	}

	// Validate params is a non-null JSON object (not array/scalar/null/omitted).
	// Canonicalize by decoding into map, then re-encoding with sorted keys.
	if len(req.Params) == 0 || string(req.Params) == "null" {
		http.Error(w, `{"error":"params must be a non-null JSON object"}`, http.StatusBadRequest)
		return
	}
	var paramsMap map[string]interface{}
	if err := json.Unmarshal(req.Params, &paramsMap); err != nil {
		http.Error(w, `{"error":"params must be a JSON object"}`, http.StatusBadRequest)
		return
	}
	if paramsMap == nil {
		http.Error(w, `{"error":"params must be a non-null JSON object"}`, http.StatusBadRequest)
		return
	}
	canonicalParams, _ := json.Marshal(paramsMap)

	// Compute canonical idempotency hash. Core owns canonicalization.
	hashInput := req.ToDID + "|" + req.Capability + "|" + string(canonicalParams)
	hash := sha256.Sum256([]byte(hashInput))
	idemKey := hex.EncodeToString(hash[:])

	// Idempotency: check for existing active task with this key.
	existing, err := h.Workflow.Store().GetActiveByIdempotencyKey(r.Context(), idemKey)
	if err != nil {
		slog.Warn("service_query: idempotency lookup failed", "error", err)
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	if existing != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(serviceQueryResponse{
			TaskID:  existing.ID,
			QueryID: existing.CorrelationID,
		})
		return
	}

	// Issue #9: store canonical params in payload (same form as what we hash),
	// so payload always matches the idempotency key.
	payloadMap := map[string]interface{}{
		"to_did":         req.ToDID,
		"capability":     req.Capability,
		"params":         paramsMap,
		"service_name":   req.ServiceName,
		"query_id":       req.QueryID,
		"ttl_seconds":    req.TTLSeconds,
		"origin_channel": req.OriginChannel,
	}
	payloadJSON, _ := json.Marshal(payloadMap)

	// Issue #5: use full query_id as task ID (guaranteed unique by caller — UUID).
	// Short prefixes are collision-prone as primary keys.
	taskID := "sq-" + req.QueryID

	nowUnix := h.Clock.Now().Unix()
	task := domain.WorkflowTask{
		ID:             taskID,
		Kind:           string(domain.WFKindServiceQuery),
		Status:         string(domain.WFCreated),
		CorrelationID:  req.QueryID,
		Priority:       string(domain.WFPriorityNormal),
		Description:    fmt.Sprintf("Service query: %s to %s", req.Capability, req.ServiceName),
		Payload:        string(payloadJSON),
		IdempotencyKey: idemKey,
		ExpiresAt:      nowUnix + int64(req.TTLSeconds),
		Origin:         "api",
	}

	if err := h.Workflow.Create(r.Context(), task); err != nil {
		if err == port.ErrDelegatedTaskExists {
			// Issue #6: could be idempotency key collision or primary key collision.
			// Re-fetch by idempotency key first.
			existing, _ = h.Workflow.Store().GetActiveByIdempotencyKey(r.Context(), idemKey)
			if existing != nil {
				w.Header().Set("Content-Type", "application/json")
				json.NewEncoder(w).Encode(serviceQueryResponse{
					TaskID:  existing.ID,
					QueryID: existing.CorrelationID,
				})
				return
			}
			// Primary key collision with different idem key — duplicate query_id.
			http.Error(w, `{"error":"duplicate query_id"}`, http.StatusConflict)
			return
		}
		slog.Warn("service_query: create task failed", "error", err)
		http.Error(w, `{"error":"create task failed"}`, http.StatusInternalServerError)
		return
	}

	// Issue #7: set a message ID for replay protection and tracing.
	// Issue #9: send canonical params (same as stored) on the wire.
	queryBody := domain.ServiceQueryBody{
		QueryID:    req.QueryID,
		Capability: req.Capability,
		Params:     canonicalParams, // canonical form, not raw req.Params
		TTLSeconds: req.TTLSeconds,
	}
	queryBodyJSON, _ := json.Marshal(queryBody)
	d2dMsg := domain.DinaMessage{
		ID:          "sq-" + req.QueryID, // deterministic msg ID for replay protection
		Type:        domain.MsgTypeServiceQuery,
		Body:        queryBodyJSON,
		CreatedTime: nowUnix,
	}

	sendErr := h.Transport.SendMessage(r.Context(), domain.DID(req.ToDID), d2dMsg)
	if sendErr != nil {
		// Issue #10: send failed → fail the task, log if Fail also fails.
		slog.Warn("service_query: D2D send failed", "to", req.ToDID, "error", sendErr)
		if _, failErr := h.Workflow.Fail(r.Context(), taskID, "", "send_failed: "+sendErr.Error()); failErr != nil {
			slog.Error("service_query: failed to mark task as failed after send error",
				"task_id", taskID, "send_error", sendErr, "fail_error", failErr)
		}
		http.Error(w, `{"error":"send failed"}`, http.StatusBadGateway)
		return
	}

	// Send succeeded → transition created → running.
	transErr := h.Workflow.Store().Transition(r.Context(), taskID, domain.WFCreated, domain.WFRunning)
	if transErr != nil {
		// Check if the task is already terminal (fast response completed it).
		current, _ := h.Workflow.GetByID(r.Context(), taskID)
		if current != nil && domain.IsTerminal(domain.WorkflowTaskState(current.Status)) {
			slog.Info("service_query: task already completed by fast response",
				"task_id", taskID, "state", current.Status)
		} else {
			// Real DB failure — task stays in "created" instead of "running".
			// This is degraded but NOT broken: FindServiceQueryTask checks both
			// created and running states, so the response will still be accepted.
			// Sweeper will expire the task if no response arrives.
			slog.Error("service_query: transition to running failed — task stays in created (degraded, not broken)",
				"task_id", taskID, "error", transErr)
		}
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(serviceQueryResponse{
		TaskID:  taskID,
		QueryID: req.QueryID,
	})
}
