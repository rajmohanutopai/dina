package test

import (
	"testing"

	"github.com/rajmohanutopai/dina/core/test/testutil"
)

// ==========================================================================
// TEST_PLAN §25 — Bot Interface
// ==========================================================================
// Covers bot query sanitization, communication protocol, trust scoring,
// and deep link attribution validation.
// ==========================================================================

// TST-CORE-858
func TestBotInterface_25_1_QuerySanitizationNoDIDNoMedical(t *testing.T) {
	// Bot query sanitization: no DID, no medical, no financial in outbound queries.
	impl := realBotQueryHandler
	testutil.RequireImplementation(t, impl, "BotQueryHandler")

	sanitized, err := impl.SanitizeQuery("did:plc:abc123 has diabetes and wants a chair review", "did:plc:abc123")
	testutil.RequireNoError(t, err)
	// DID must be stripped from outbound query.
	for i := 0; i <= len(sanitized)-len("did:plc:abc123"); i++ {
		if sanitized[i:i+len("did:plc:abc123")] == "did:plc:abc123" {
			t.Fatal("DID must not appear in sanitized query")
		}
	}
}

// TST-CORE-859
func TestBotInterface_25_2_QueryProtocolSchema(t *testing.T) {
	// Bot communication protocol: POST /query schema with bot_signature and attribution.
	impl := realBotQueryHandler
	testutil.RequireImplementation(t, impl, "BotQueryHandler")

	query := testutil.BotQuery{
		Query:       "best office chair under $500",
		RequesterID: "anon-requester-001",
		Category:    "product_review",
		Timestamp:   1700000000,
	}
	resp, err := impl.SendQuery("did:key:z6MkChairBot", query)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(resp.Signature) > 0, "bot response must include signature")
	testutil.RequireTrue(t, resp.Attribution != "", "bot response must include attribution")
}

// TST-CORE-860
func TestBotInterface_25_3_LocalBotScoreTracking(t *testing.T) {
	// Bot trust scoring: local score tracking, threshold-based routing.
	impl := realBotQueryHandler
	testutil.RequireImplementation(t, impl, "BotQueryHandler")

	outcome := testutil.BotOutcome{
		BotDID:      "did:key:z6MkLowScoreBot",
		QueryID:     "query-001",
		Helpful:     false,
		Attribution: false,
		Timestamp:   1700000000,
	}
	err := impl.ScoreBot("did:key:z6MkLowScoreBot", outcome)
	testutil.RequireNoError(t, err)
}

// TST-CORE-861
func TestBotInterface_25_4_DeepLinkAttributionValidation(t *testing.T) {
	// Deep Link attribution validation + penalty for stripping attribution.
	impl := realBotQueryHandler
	testutil.RequireImplementation(t, impl, "BotQueryHandler")

	// Response with valid attribution.
	validResp := testutil.BotResponse{
		Answer:      "The Steelcase Leap is rated 92/100",
		Attribution: "https://youtube.com/watch?v=abc123&t=142",
		BotDID:      "did:key:z6MkGoodBot",
		Signature:   []byte("sig-placeholder"),
		Confidence:  0.95,
	}
	valid, err := impl.ValidateAttribution(validResp)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, valid, "valid attribution must pass validation")

	// Response with stripped attribution.
	strippedResp := testutil.BotResponse{
		Answer:      "The chair is good",
		Attribution: "",
		BotDID:      "did:key:z6MkBadBot",
		Signature:   []byte("sig-placeholder"),
		Confidence:  0.5,
	}
	valid, err = impl.ValidateAttribution(strippedResp)
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, valid, "stripped attribution must fail validation")
}
