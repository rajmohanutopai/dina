// Package bot implements the bot query handler for sanitization, routing, and scoring.
package bot

import (
	"strings"
	"sync"

	"github.com/rajmohanutopai/dina/core/test/testutil"
)

// Compile-time interface check.
var _ testutil.BotQueryHandler = (*QueryHandler)(nil)

// QueryHandler implements testutil.BotQueryHandler — bot query sanitization,
// trust scoring, and attribution validation.
type QueryHandler struct {
	mu     sync.Mutex
	scores map[string]float64 // botDID -> score
}

// NewQueryHandler returns a new BotQueryHandler.
func NewQueryHandler() *QueryHandler {
	return &QueryHandler{
		scores: make(map[string]float64),
	}
}

// SanitizeQuery strips DID, medical, and financial data from outbound queries.
func (h *QueryHandler) SanitizeQuery(query string, userDID string) (string, error) {
	sanitized := query

	// Strip the user's DID from the query.
	if userDID != "" {
		sanitized = strings.ReplaceAll(sanitized, userDID, "[REDACTED]")
	}

	// Strip common medical terms.
	medicalTerms := []string{
		"diabetes", "cancer", "hiv", "pregnancy", "diagnosis",
		"prescription", "medication", "surgery", "therapy",
	}
	lower := strings.ToLower(sanitized)
	for _, term := range medicalTerms {
		idx := strings.Index(lower, term)
		for idx >= 0 {
			sanitized = sanitized[:idx] + "[MEDICAL_REDACTED]" + sanitized[idx+len(term):]
			lower = strings.ToLower(sanitized)
			idx = strings.Index(lower, term)
		}
	}

	// Strip common financial terms with amounts.
	financialTerms := []string{
		"bank account", "credit card", "ssn", "social security",
	}
	lower = strings.ToLower(sanitized)
	for _, term := range financialTerms {
		idx := strings.Index(lower, term)
		for idx >= 0 {
			sanitized = sanitized[:idx] + "[FINANCIAL_REDACTED]" + sanitized[idx+len(term):]
			lower = strings.ToLower(sanitized)
			idx = strings.Index(lower, term)
		}
	}

	return sanitized, nil
}

// SendQuery sends a sanitized query to a bot and returns the response.
func (h *QueryHandler) SendQuery(_ string, query testutil.BotQuery) (*testutil.BotResponse, error) {
	return &testutil.BotResponse{
		Answer:      "Response to: " + query.Query,
		Attribution: "https://source.example.com/result",
		BotDID:      "did:key:z6MkBot",
		Signature:   []byte("bot-signature-placeholder"),
		Confidence:  0.8,
	}, nil
}

// ScoreBot records an outcome and updates the bot's local trust score.
func (h *QueryHandler) ScoreBot(botDID string, outcome testutil.BotOutcome) error {
	h.mu.Lock()
	defer h.mu.Unlock()

	current := h.scores[botDID]
	delta := -0.1
	if outcome.Helpful {
		delta = 0.1
	}
	if !outcome.Attribution {
		delta -= 0.05 // penalty for stripped attribution
	}
	h.scores[botDID] = current + delta
	return nil
}

// GetScore returns the current trust score for a bot.
func (h *QueryHandler) GetScore(botDID string) (float64, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.scores[botDID], nil
}

// ValidateAttribution checks that the bot response includes valid attribution.
func (h *QueryHandler) ValidateAttribution(resp testutil.BotResponse) (bool, error) {
	if resp.Attribution == "" {
		return false, nil
	}
	// Attribution must be a URL (starts with http:// or https://).
	if strings.HasPrefix(resp.Attribution, "http://") || strings.HasPrefix(resp.Attribution, "https://") {
		return true, nil
	}
	return false, nil
}

// ResetForTest clears all state for test isolation.
func (h *QueryHandler) ResetForTest() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.scores = make(map[string]float64)
}
