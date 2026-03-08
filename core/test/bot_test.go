package test

import (
	"strings"
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
	if strings.Contains(sanitized, "did:plc:abc123") {
		t.Fatal("DID must not appear in sanitized query")
	}

	// Medical terms must be redacted (test name says "NoDIDNoMedical").
	if strings.Contains(strings.ToLower(sanitized), "diabetes") {
		t.Fatal("medical term 'diabetes' must be redacted from sanitized query")
	}

	// The non-sensitive part must be preserved.
	testutil.RequireContains(t, sanitized, "chair review")

	// Additional medical terms must also be stripped.
	sanitized2, err := impl.SanitizeQuery("patient needs cancer surgery and prescription", "did:key:z6MkUser1")
	testutil.RequireNoError(t, err)
	if strings.Contains(sanitized2, "did:key:z6MkUser1") {
		t.Fatal("DID must not appear in sanitized query")
	}
	for _, term := range []string{"cancer", "surgery", "prescription"} {
		if strings.Contains(strings.ToLower(sanitized2), term) {
			t.Fatalf("medical term %q must be redacted from sanitized query", term)
		}
	}
}

// TST-CORE-859
func TestBotInterface_25_2_QueryProtocolSchema(t *testing.T) {
	// Bot communication protocol: sanitize → send → validate full response schema.
	impl := realBotQueryHandler
	testutil.RequireImplementation(t, impl, "BotQueryHandler")

	// Step 1: Sanitize the query before sending (exercises real sanitization).
	rawQuery := "did:plc:userXYZ needs a chair review, has diabetes"
	sanitized, err := impl.SanitizeQuery(rawQuery, "did:plc:userXYZ")
	testutil.RequireNoError(t, err)
	if strings.Contains(sanitized, "did:plc:userXYZ") {
		t.Fatal("DID must be stripped before sending query to bot")
	}
	if strings.Contains(strings.ToLower(sanitized), "diabetes") {
		t.Fatal("medical terms must be stripped before sending query to bot")
	}

	// Step 2: Send the sanitized query and validate full response schema.
	query := testutil.BotQuery{
		Query:       sanitized,
		RequesterID: "anon-requester-001",
		Category:    "product_review",
		Timestamp:   1700000000,
	}
	resp, err := impl.SendQuery("did:key:z6MkChairBot", query)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, resp != nil, "response must not be nil")

	// Validate all schema fields are populated.
	testutil.RequireTrue(t, len(resp.Signature) > 0, "bot response must include signature")
	testutil.RequireTrue(t, resp.Attribution != "", "bot response must include attribution")
	testutil.RequireTrue(t, resp.BotDID != "", "bot response must include BotDID")
	testutil.RequireTrue(t, resp.Answer != "", "bot response must include Answer")
	testutil.RequireTrue(t, resp.Confidence > 0 && resp.Confidence <= 1.0,
		"bot response confidence must be in (0, 1.0]")

	// Step 3: Validate the attribution is well-formed (exercises real ValidateAttribution).
	valid, err := impl.ValidateAttribution(*resp)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, valid, "response with attribution must pass validation")

	// Step 4: Stripped attribution must fail validation.
	stripped := *resp
	stripped.Attribution = ""
	valid, err = impl.ValidateAttribution(stripped)
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, valid, "stripped attribution must fail validation")
}

// TST-CORE-860
func TestBotInterface_25_3_LocalBotScoreTracking(t *testing.T) {
	// Bot trust scoring: local score tracking with read-back verification.
	impl := realBotQueryHandler
	testutil.RequireImplementation(t, impl, "BotQueryHandler")

	// Reset state for isolation.
	impl.ResetForTest()

	botDID := "did:key:z6MkScoreTrackBot"

	// Initial score must be zero (no history).
	score0, err := impl.GetScore(botDID)
	testutil.RequireNoError(t, err)
	if score0 != 0 {
		t.Fatalf("initial score must be 0, got %f", score0)
	}

	// Negative outcome: not helpful, no attribution → score must decrease.
	negOutcome := testutil.BotOutcome{
		BotDID:      botDID,
		QueryID:     "query-001",
		Helpful:     false,
		Attribution: false,
		Timestamp:   1700000000,
	}
	err = impl.ScoreBot(botDID, negOutcome)
	testutil.RequireNoError(t, err)

	score1, err := impl.GetScore(botDID)
	testutil.RequireNoError(t, err)
	if score1 >= score0 {
		t.Fatalf("negative outcome must decrease score: was %f, now %f", score0, score1)
	}

	// Positive outcome: helpful + attribution → score must increase.
	posOutcome := testutil.BotOutcome{
		BotDID:      botDID,
		QueryID:     "query-002",
		Helpful:     true,
		Attribution: true,
		Timestamp:   1700000001,
	}
	err = impl.ScoreBot(botDID, posOutcome)
	testutil.RequireNoError(t, err)

	score2, err := impl.GetScore(botDID)
	testutil.RequireNoError(t, err)
	if score2 <= score1 {
		t.Fatalf("positive outcome must increase score: was %f, now %f", score1, score2)
	}

	// Different bot must have independent score.
	otherDID := "did:key:z6MkOtherBot"
	otherScore, err := impl.GetScore(otherDID)
	testutil.RequireNoError(t, err)
	if otherScore != 0 {
		t.Fatalf("unscored bot must have score 0, got %f", otherScore)
	}
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
