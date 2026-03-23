package handler

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
)

// PIIHandler exposes PII scrubbing endpoints.
// Two-tier pipeline: Tier 1 (Go regex) catches structured PII (phone, email,
// SSN, credit card), then Tier 2 (Brain spaCy NER) catches names, orgs,
// locations, and other contextual entities. If Brain is unavailable, Tier 1
// results are returned alone — graceful degradation, not failure.
type PIIHandler struct {
	Scrubber port.PIIScrubber  // Tier 1: regex (always available)
	Brain    port.BrainClient  // Tier 2: spaCy NER (optional, nil = Tier 1 only)
}

// scrubRequest is the JSON body for POST /v1/pii/scrub.
type scrubRequest struct {
	Text string `json:"text"`
}

// HandleScrub handles POST /v1/pii/scrub. Chains Tier 1 (regex) → Tier 2
// (Brain spaCy NER). Tier 2 runs on Tier 1's output so it doesn't re-detect
// already-replaced entities.
func (h *PIIHandler) HandleScrub(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req scrubRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	if req.Text == "" {
		http.Error(w, `{"error":"text is required"}`, http.StatusBadRequest)
		return
	}

	// Tier 1: regex-based scrubbing (phone, email, SSN, credit card).
	t1, err := h.Scrubber.Scrub(r.Context(), req.Text)
	if err != nil {
		clientError(w, "scrub failed", http.StatusInternalServerError, err)
		return
	}

	scrubbed := t1.Scrubbed
	entities := t1.Entities

	// Tier 2: Brain spaCy NER (names, orgs, locations).
	// Runs on Tier 1 output so already-replaced tokens are not re-detected.
	// Graceful degradation: if Brain is unavailable, return Tier 1 only.
	if h.Brain != nil {
		t2, err := h.Brain.ScrubPII(r.Context(), scrubbed)
		if err != nil {
			slog.Warn("pii.scrub: Tier 2 (Brain NER) unavailable, returning Tier 1 only",
				"error", err)
		} else if t2 != nil {
			scrubbed = t2.Scrubbed
			entities = mergeEntities(entities, t2.Entities)
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"scrubbed": scrubbed,
		"entities": entities,
	})
}

// mergeEntities combines Tier 1 and Tier 2 entity lists, deduplicating
// by type+value.
func mergeEntities(tier1, tier2 []domain.PIIEntity) []domain.PIIEntity {
	seen := make(map[string]bool, len(tier1))
	for _, e := range tier1 {
		seen[e.Type+":"+e.Value] = true
	}
	merged := append([]domain.PIIEntity{}, tier1...)
	for _, e := range tier2 {
		key := e.Type + ":" + e.Value
		if !seen[key] {
			merged = append(merged, e)
			seen[key] = true
		}
	}
	return merged
}
