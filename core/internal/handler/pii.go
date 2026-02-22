package handler

import (
	"encoding/json"
	"net/http"

	"github.com/anthropics/dina/core/internal/port"
)

// PIIHandler exposes PII scrubbing endpoints.
type PIIHandler struct {
	Scrubber port.PIIScrubber
}

// scrubRequest is the JSON body for POST /v1/pii/scrub.
type scrubRequest struct {
	Text string `json:"text"`
}

// HandleScrub handles POST /v1/pii/scrub. It scrubs PII from the provided text
// using the configured PIIScrubber and returns the scrubbed text along with
// detected entities.
func (h *PIIHandler) HandleScrub(w http.ResponseWriter, r *http.Request) {
	var req scrubRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	if req.Text == "" {
		http.Error(w, `{"error":"text is required"}`, http.StatusBadRequest)
		return
	}

	result, err := h.Scrubber.Scrub(r.Context(), req.Text)
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"scrubbed": result.Scrubbed,
		"entities": result.Entities,
	})
}
