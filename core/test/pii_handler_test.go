package test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/handler"
	"github.com/rajmohanutopai/dina/core/test/testutil"
)

// ==========================================================================
// PII Handler — Tier 1 + Tier 2 chained scrubbing
// Tests the HandleScrub endpoint which chains regex (Tier 1) → Brain NER
// (Tier 2) and handles graceful degradation.
// ==========================================================================

// --- Mock implementations ---

type mockPIIScrubber struct {
	result *domain.ScrubResult
	err    error
}

func (m *mockPIIScrubber) Scrub(_ context.Context, text string) (*domain.ScrubResult, error) {
	if m.err != nil {
		return nil, m.err
	}
	if m.result != nil {
		return m.result, nil
	}
	// Default: return text as-is with no entities.
	return &domain.ScrubResult{Scrubbed: text, Entities: nil}, nil
}

type mockBrainClientForPII struct {
	scrubResult *domain.ScrubResult
	scrubErr    error
}

func (m *mockBrainClientForPII) Process(_ context.Context, _ domain.TaskEvent) error { return nil }
func (m *mockBrainClientForPII) Reason(_ context.Context, _ string) (*domain.ReasonResult, error) {
	return nil, nil
}
func (m *mockBrainClientForPII) ReasonWithContext(_ context.Context, _, _, _ string) (*domain.ReasonResult, error) {
	return nil, nil
}
func (m *mockBrainClientForPII) ReasonAsUser(_ context.Context, _, _ string) (*domain.ReasonResult, error) {
	return nil, nil
}
func (m *mockBrainClientForPII) IsHealthy(_ context.Context) bool { return true }
func (m *mockBrainClientForPII) ScrubPII(_ context.Context, text string) (*domain.ScrubResult, error) {
	if m.scrubErr != nil {
		return nil, m.scrubErr
	}
	return m.scrubResult, nil
}

// helper: invoke HandleScrub and return status code + decoded body.
func invokeScrub(h *handler.PIIHandler, text string) (int, map[string]interface{}) {
	body, _ := json.Marshal(map[string]string{"text": text})
	req := httptest.NewRequest("POST", "/v1/pii/scrub", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	h.HandleScrub(rr, req)

	var result map[string]interface{}
	json.NewDecoder(rr.Body).Decode(&result)
	return rr.Code, result
}

// --------------------------------------------------------------------------
// TST-CORE-900: Tier 1 only (Brain=nil) — structured PII scrubbed, names
// pass through.
// --------------------------------------------------------------------------

func TestPIIHandler_Tier1Only_BrainNil(t *testing.T) {
	h := &handler.PIIHandler{
		Scrubber: &mockPIIScrubber{
			result: &domain.ScrubResult{
				Scrubbed: "Call [PHONE_1] or email [EMAIL_1], ask for Dr. Smith",
				Entities: []domain.PIIEntity{
					{Type: "PHONE", Value: "555-123-4567"},
					{Type: "EMAIL", Value: "john@example.com"},
				},
			},
		},
		Brain: nil, // Tier 2 not available
	}

	code, result := invokeScrub(h, "Call 555-123-4567 or email john@example.com, ask for Dr. Smith")

	testutil.RequireEqual(t, code, http.StatusOK)
	scrubbed, _ := result["scrubbed"].(string)
	testutil.RequireContains(t, scrubbed, "[PHONE_1]")
	testutil.RequireContains(t, scrubbed, "[EMAIL_1]")
	// Name passes through — Tier 1 regex does not catch names.
	testutil.RequireContains(t, scrubbed, "Dr. Smith")

	entities, _ := result["entities"].([]interface{})
	testutil.RequireLen(t, len(entities), 2)
}

// --------------------------------------------------------------------------
// TST-CORE-901: Tier 1 + Tier 2 chain — both structured PII and names
// scrubbed.
// --------------------------------------------------------------------------

func TestPIIHandler_Tier1PlusTier2(t *testing.T) {
	h := &handler.PIIHandler{
		Scrubber: &mockPIIScrubber{
			result: &domain.ScrubResult{
				Scrubbed: "Call [PHONE_1], ask for Dr. Smith at Acme Corp",
				Entities: []domain.PIIEntity{
					{Type: "PHONE", Value: "555-123-4567"},
				},
			},
		},
		Brain: &mockBrainClientForPII{
			scrubResult: &domain.ScrubResult{
				Scrubbed: "Call [PHONE_1], ask for [PERSON_1] at [ORG_1]",
				Entities: []domain.PIIEntity{
					{Type: "PERSON", Value: "Dr. Smith"},
					{Type: "ORG", Value: "Acme Corp"},
				},
			},
		},
	}

	code, result := invokeScrub(h, "Call 555-123-4567, ask for Dr. Smith at Acme Corp")

	testutil.RequireEqual(t, code, http.StatusOK)
	scrubbed, _ := result["scrubbed"].(string)
	// Final scrubbed text from Tier 2 (which ran on Tier 1 output).
	testutil.RequireContains(t, scrubbed, "[PHONE_1]")
	testutil.RequireContains(t, scrubbed, "[PERSON_1]")
	testutil.RequireContains(t, scrubbed, "[ORG_1]")

	// Merged entities: 1 from Tier 1 + 2 from Tier 2 = 3 total.
	entities, _ := result["entities"].([]interface{})
	testutil.RequireLen(t, len(entities), 3)
}

// --------------------------------------------------------------------------
// TST-CORE-902: Tier 2 failure — graceful degradation to Tier 1 only.
// --------------------------------------------------------------------------

func TestPIIHandler_Tier2Failure_GracefulDegradation(t *testing.T) {
	h := &handler.PIIHandler{
		Scrubber: &mockPIIScrubber{
			result: &domain.ScrubResult{
				Scrubbed: "Email [EMAIL_1], Dr. Smith",
				Entities: []domain.PIIEntity{
					{Type: "EMAIL", Value: "john@example.com"},
				},
			},
		},
		Brain: &mockBrainClientForPII{
			scrubErr: errors.New("brain unavailable"),
		},
	}

	code, result := invokeScrub(h, "Email john@example.com, Dr. Smith")

	// Should succeed with Tier 1 results only — not a 500 error.
	testutil.RequireEqual(t, code, http.StatusOK)
	scrubbed, _ := result["scrubbed"].(string)
	testutil.RequireContains(t, scrubbed, "[EMAIL_1]")
	// Name NOT scrubbed since Tier 2 failed.
	testutil.RequireContains(t, scrubbed, "Dr. Smith")

	entities, _ := result["entities"].([]interface{})
	testutil.RequireLen(t, len(entities), 1)
}

// --------------------------------------------------------------------------
// TST-CORE-903: Entity deduplication — same entity found by both tiers,
// only appears once.
// --------------------------------------------------------------------------

func TestPIIHandler_EntityDeduplication(t *testing.T) {
	h := &handler.PIIHandler{
		Scrubber: &mockPIIScrubber{
			result: &domain.ScrubResult{
				Scrubbed: "Contact [EMAIL_1]",
				Entities: []domain.PIIEntity{
					{Type: "EMAIL", Value: "john@example.com"},
				},
			},
		},
		Brain: &mockBrainClientForPII{
			scrubResult: &domain.ScrubResult{
				Scrubbed: "Contact [EMAIL_1]",
				Entities: []domain.PIIEntity{
					// Brain also detected the same email.
					{Type: "EMAIL", Value: "john@example.com"},
					// Brain found a name that Tier 1 missed.
					{Type: "PERSON", Value: "John Doe"},
				},
			},
		},
	}

	code, result := invokeScrub(h, "Contact john@example.com")

	testutil.RequireEqual(t, code, http.StatusOK)

	// Deduplicated: EMAIL appears once (not twice), plus PERSON = 2 total.
	entities, _ := result["entities"].([]interface{})
	testutil.RequireLen(t, len(entities), 2)

	// Verify no duplicate EMAIL entries.
	emailCount := 0
	for _, e := range entities {
		em, _ := e.(map[string]interface{})
		if em["type"] == "EMAIL" {
			emailCount++
		}
	}
	testutil.RequireEqual(t, emailCount, 1)
}
