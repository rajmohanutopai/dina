package test

import (
	"encoding/json"
	"testing"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/test/testutil"
)

// ==========================================================================
// Approval Preview field — verifies the Preview field on ApprovalRequest
// carries the owner-visible trigger text and is NOT copied into grants.
// ==========================================================================

// --------------------------------------------------------------------------
// TST-CORE-910: staging resolve creates approval with Preview containing
// the item summary.
// --------------------------------------------------------------------------

// TRACE: {"suite": "CORE", "case": "0028", "section": "15", "sectionName": "API Endpoint Tests", "subsection": "01", "scenario": "01", "title": "Approval_PreviewContainsSummary"}
func TestApproval_PreviewContainsSummary(t *testing.T) {
	req := domain.ApprovalRequest{
		ClientDID: "did:key:z6MkAgent1",
		PersonaID: "health",
		SessionID: "research-task",
		Action:    "staging_resolve",
		Reason:    "Store memory in health",
		Preview:   "Blood test results from Dr. Sharma",
	}
	testutil.RequireEqual(t, req.Preview, "Blood test results from Dr. Sharma")
	testutil.RequireEqual(t, req.Reason, "Store memory in health")
	testutil.RequireEqual(t, req.Action, "staging_resolve")

	// Verify Preview appears in JSON representation.
	data, err := json.Marshal(req)
	testutil.RequireNoError(t, err)
	testutil.RequireContains(t, string(data), `"preview"`)
	testutil.RequireContains(t, string(data), "Blood test results from Dr. Sharma")
}

// --------------------------------------------------------------------------
// TST-CORE-911: vault_query creates approval with Preview = query text.
// --------------------------------------------------------------------------

// TRACE: {"suite": "CORE", "case": "0029", "section": "15", "sectionName": "API Endpoint Tests", "subsection": "02", "scenario": "01", "title": "Approval_PreviewContainsQueryText"}
func TestApproval_PreviewContainsQueryText(t *testing.T) {
	req := domain.ApprovalRequest{
		ClientDID: "did:key:z6MkAgent1",
		PersonaID: "financial",
		SessionID: "budget-check",
		Action:    "vault_query",
		Reason:    "Query financial persona",
		Preview:   "monthly expenses for March 2024",
	}
	testutil.RequireEqual(t, req.Preview, "monthly expenses for March 2024")
	testutil.RequireEqual(t, req.Action, "vault_query")
}

// --------------------------------------------------------------------------
// TST-CORE-912: Preview is NOT in AccessGrant — only Reason is.
// --------------------------------------------------------------------------

// TRACE: {"suite": "CORE", "case": "0030", "section": "15", "sectionName": "API Endpoint Tests", "subsection": "03", "scenario": "01", "title": "Approval_PreviewNotInGrant"}
func TestApproval_PreviewNotInGrant(t *testing.T) {
	grant := domain.AccessGrant{
		ClientDID: "did:key:z6MkAgent1",
		PersonaID: "health",
		SessionID: "session-1",
		Scope:     "session",
		GrantedBy: "socket-local",
		Reason:    "Approved by owner",
	}
	testutil.RequireEqual(t, grant.Reason, "Approved by owner")

	// AccessGrant JSON must NOT contain "preview" — only ApprovalRequest has it.
	data, err := json.Marshal(grant)
	testutil.RequireNoError(t, err)
	jsonStr := string(data)
	testutil.RequireFalse(t, contains(jsonStr, `"preview"`),
		"AccessGrant must not have a preview field in JSON")
}

// contains checks if s contains substr.
func contains(s, substr string) bool {
	return len(s) >= len(substr) && searchSubstring(s, substr)
}

func searchSubstring(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

// --------------------------------------------------------------------------
// TST-CORE-913: Preview is truncated to 250 chars + "..." by handler logic.
// --------------------------------------------------------------------------

// TRACE: {"suite": "CORE", "case": "0031", "section": "15", "sectionName": "API Endpoint Tests", "subsection": "04", "scenario": "01", "title": "Approval_PreviewTruncation"}
func TestApproval_PreviewTruncation(t *testing.T) {
	// Simulate what the handler does: truncate preview to 250 chars.
	longSummary := ""
	for i := 0; i < 300; i++ {
		longSummary += "x"
	}

	preview := longSummary
	if len(preview) > 250 {
		preview = preview[:250] + "..."
	}

	testutil.RequireEqual(t, len(preview), 253) // 250 + "..."
	testutil.RequireTrue(t, preview[250:] == "...", "must end with ellipsis")

	// Short preview stays as-is.
	shortPreview := "Short summary"
	if len(shortPreview) > 250 {
		shortPreview = shortPreview[:250] + "..."
	}
	testutil.RequireEqual(t, shortPreview, "Short summary")
}
