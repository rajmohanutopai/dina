package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/middleware"
	"github.com/rajmohanutopai/dina/core/internal/port"
)

// RememberHandler handles POST /api/v1/remember — user-facing solicited
// memory writes. Delegates to StagingHandler for canonical provenance
// derivation, then polls for semantic completion.
type RememberHandler struct {
	StagingHandler *StagingHandler // reuses provenance derivation + ingest
	Staging        port.StagingInbox
	Brain          port.BrainClient
}

type rememberRequest struct {
	Text     string `json:"text"`
	Category string `json:"category"`
	Session  string `json:"session"`
	Source   string `json:"source"`
	SourceID string `json:"source_id"`
	Metadata string `json:"metadata"`
}

// HandleRemember handles POST /api/v1/remember.
// Translates to a staging ingest (with canonical provenance), triggers
// Brain drain, and polls for completion. Returns semantic status.
func (h *RememberHandler) HandleRemember(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req rememberRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	if req.Text == "" {
		http.Error(w, `{"error":"text is required"}`, http.StatusBadRequest)
		return
	}
	if req.Session == "" {
		http.Error(w, `{"error":"session is required"}`, http.StatusBadRequest)
		return
	}

	// Session is required for:
	// 1. Metadata — stored with the item for audit/traceability.
	// 2. Session-scoped access control — Brain forwards X-Session on
	//    staging_resolve, Core's HandleResolve calls AccessPersona()
	//    which checks session grants for sensitive personas.
	ctx := context.WithValue(r.Context(), middleware.SessionNameKey, req.Session)

	// Merge category and session into metadata so they flow through staging → vault.
	var metaMap map[string]interface{}
	if req.Metadata != "" {
		_ = json.Unmarshal([]byte(req.Metadata), &metaMap)
	}
	if metaMap == nil {
		metaMap = map[string]interface{}{}
	}
	if req.Category != "" {
		metaMap["category"] = req.Category
	}
	metaMap["session"] = req.Session
	mergedMeta, _ := json.Marshal(metaMap)

	// Build a staging ingest request body (same shape as /v1/staging/ingest).
	ingestBody, _ := json.Marshal(map[string]string{
		"source":    req.Source,
		"source_id": req.SourceID,
		"type":      "note",
		"summary":   req.Text,
		"body":      req.Text,
		"metadata":  string(mergedMeta),
	})

	// Delegate to StagingHandler.HandleIngest for canonical provenance.
	// Capture the response to extract the staging ID.
	recorder := &responseRecorder{headers: make(http.Header)}
	fakeReq := r.Clone(ctx)
	fakeReq.Body = io.NopCloser(bytes.NewReader(ingestBody))
	fakeReq.ContentLength = int64(len(ingestBody))
	// Forward session as X-Session header so auth middleware can scope it.
	fakeReq.Header.Set("X-Session", req.Session)
	h.StagingHandler.HandleIngest(recorder, fakeReq)

	if recorder.status != http.StatusCreated {
		http.Error(w, recorder.body.String(), recorder.status)
		return
	}

	// Extract staging ID from ingest response.
	var ingestResp struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(recorder.body.Bytes(), &ingestResp); err != nil || ingestResp.ID == "" {
		http.Error(w, `{"error":"staging ingest failed"}`, http.StatusInternalServerError)
		return
	}
	id := ingestResp.ID

	// Note: StagingHandler.HandleIngest already triggers Brain drain
	// via the Brain client (staging_drain event).

	// Poll for completion (up to 15 seconds).
	deadline := time.Now().Add(15 * time.Second)
	var status string
	for time.Now().Before(deadline) {
		time.Sleep(500 * time.Millisecond)
		s, err := h.Staging.GetStatus(ctx, id, "")
		if err != nil {
			break
		}
		status = s
		if status != domain.StagingReceived && status != domain.StagingClassifying {
			break // terminal state
		}
	}

	if status == "" {
		status = "processing"
	}

	// Return semantic result.
	resp := map[string]interface{}{
		"id":     id,
		"status": status,
	}

	switch status {
	case domain.StagingStored:
		resp["message"] = "Memory stored successfully."
	case domain.StagingPendingUnlock:
		resp["status"] = "needs_approval"
		resp["message"] = "Classified into a sensitive persona. Approve access via Telegram or dina-admin to complete storage."
	case domain.StagingFailed:
		resp["message"] = "Failed to process memory."
	case domain.StagingClassifying:
		resp["message"] = "Still processing. Check back shortly."
	default:
		resp["message"] = "Processing your memory."
	}

	w.Header().Set("Content-Type", "application/json")
	statusCode := http.StatusOK
	if status == domain.StagingPendingUnlock {
		statusCode = http.StatusAccepted
	}
	w.WriteHeader(statusCode)
	json.NewEncoder(w).Encode(resp)
}

// HandleRememberStatus handles GET /api/v1/remember/{id} — check completion.
func (h *RememberHandler) HandleRememberStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	// Extract ID from path: /api/v1/remember/{id}
	id := r.URL.Path[len("/api/v1/remember/"):]
	if id == "" {
		http.Error(w, `{"error":"id is required"}`, http.StatusBadRequest)
		return
	}

	// Enforce ownership — only the originating caller can check status.
	callerDID := ""
	if did, ok := r.Context().Value(middleware.AgentDIDKey).(string); ok {
		callerDID = did
	}
	status, err := h.Staging.GetStatus(r.Context(), id, callerDID)
	if err != nil {
		http.Error(w, `{"error":"item not found"}`, http.StatusNotFound)
		return
	}

	resp := map[string]interface{}{
		"id":     id,
		"status": status,
	}

	switch status {
	case domain.StagingStored:
		resp["message"] = "Memory stored successfully."
	case domain.StagingPendingUnlock:
		resp["status"] = "needs_approval"
		resp["message"] = "Classified into a sensitive persona. Approve access to complete storage."
	case domain.StagingFailed:
		resp["message"] = "Failed to process memory."
	case domain.StagingClassifying:
		resp["message"] = "Still processing."
	default:
		resp["message"] = "Processing."
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// responseRecorder captures an HTTP response for internal delegation.
type responseRecorder struct {
	status  int
	headers http.Header
	body    bytes.Buffer
}

func (r *responseRecorder) Header() http.Header         { return r.headers }
func (r *responseRecorder) WriteHeader(statusCode int)   { r.status = statusCode }
func (r *responseRecorder) Write(b []byte) (int, error)  { return r.body.Write(b) }
