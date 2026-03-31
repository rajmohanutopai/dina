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
// TRACE: {"suite": "CORE", "case": "0166", "section": "25", "sectionName": "Bot Interface", "subsection": "01", "scenario": "01", "title": "QuerySanitizationNoDIDNoMedical"}
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
// TRACE: {"suite": "CORE", "case": "0167", "section": "25", "sectionName": "Bot Interface", "subsection": "02", "scenario": "01", "title": "QueryProtocolSchema"}
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
// TRACE: {"suite": "CORE", "case": "0168", "section": "25", "sectionName": "Bot Interface", "subsection": "03", "scenario": "01", "title": "LocalBotScoreTracking"}
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
// TRACE: {"suite": "CORE", "case": "0169", "section": "25", "sectionName": "Bot Interface", "subsection": "04", "scenario": "01", "title": "DeepLinkAttributionValidation"}
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

// --------------------------------------------------------------------------
// §33.1 Dead Internet Filter — Bot response without attribution rejected
// --------------------------------------------------------------------------

// TST-CORE-1118
// TRACE: {"suite": "CORE", "case": "0170", "section": "33", "sectionName": "Architecture Review Coverage", "subsection": "01", "scenario": "01", "title": "BotResponseWithoutAttributionRejectedAtIngestion"}
func TestBotInterface_33_1_BotResponseWithoutAttributionRejectedAtIngestion(t *testing.T) {
	// Requirement (§33.1 / §34.1):
	//   A bot response with no source_url and no creator_name must be rejected.
	//   Core must make it architecturally impossible for unattributed
	//   (AI-generated or malicious) recommendations to enter the vault.
	//   Deep Link principle: creators get traffic, users get truth.
	//
	//   ValidateAttribution(resp) must return false for:
	//     - Empty Attribution field
	//     - Non-URL Attribution (e.g., "source: bot")
	//     - Whitespace-only Attribution
	//   And must return true for:
	//     - Valid https:// URL
	//     - Valid http:// URL
	//
	// Anti-tautological design:
	//   1. Empty attribution → validation fails
	//   2. Non-URL attribution → validation fails
	//   3. Positive control: valid URL → validation passes
	//   4. Multiple URL schemes tested (https, http)
	//   5. Whitespace-only attribution → fails
	//   6. Protocol-relative URL (//example.com) → fails

	impl := realBotQueryHandler
	testutil.RequireImplementation(t, impl, "BotQueryHandler")

	// TRACE: {"suite": "CORE", "case": "0171", "section": "33", "sectionName": "Architecture Review Coverage", "title": "empty_attribution_rejected"}
	t.Run("empty_attribution_rejected", func(t *testing.T) {
		resp := testutil.BotResponse{
			Answer:      "Buy this product, it's great",
			Attribution: "", // No attribution — bot stripped source
			BotDID:      "did:key:z6MkUnattributedBot",
			Signature:   []byte("sig"),
			Confidence:  0.8,
		}
		valid, err := impl.ValidateAttribution(resp)
		testutil.RequireNoError(t, err)
		if valid {
			t.Fatal("empty attribution must fail validation — unattributed content cannot enter vault")
		}
	})

	// TRACE: {"suite": "CORE", "case": "0172", "section": "33", "sectionName": "Architecture Review Coverage", "title": "non_url_attribution_rejected"}
	t.Run("non_url_attribution_rejected", func(t *testing.T) {
		// A plain string that is not a URL should fail — it doesn't link
		// to the original source (Deep Link principle violated).
		resp := testutil.BotResponse{
			Answer:      "This is a review from my training data",
			Attribution: "source: internal knowledge base",
			BotDID:      "did:key:z6MkFakeAttribBot",
			Signature:   []byte("sig"),
			Confidence:  0.7,
		}
		valid, err := impl.ValidateAttribution(resp)
		testutil.RequireNoError(t, err)
		if valid {
			t.Fatal("non-URL attribution must fail — must be a linkable source")
		}
	})

	// TRACE: {"suite": "CORE", "case": "0173", "section": "33", "sectionName": "Architecture Review Coverage", "title": "whitespace_only_attribution_rejected"}
	t.Run("whitespace_only_attribution_rejected", func(t *testing.T) {
		resp := testutil.BotResponse{
			Answer:      "Some answer",
			Attribution: "   ",
			BotDID:      "did:key:z6MkWhitespaceBot",
			Signature:   []byte("sig"),
			Confidence:  0.5,
		}
		valid, err := impl.ValidateAttribution(resp)
		testutil.RequireNoError(t, err)
		if valid {
			t.Fatal("whitespace-only attribution must fail validation")
		}
	})

	// TRACE: {"suite": "CORE", "case": "0174", "section": "33", "sectionName": "Architecture Review Coverage", "title": "protocol_relative_url_rejected"}
	t.Run("protocol_relative_url_rejected", func(t *testing.T) {
		// "//example.com/path" is not a full URL (no scheme).
		resp := testutil.BotResponse{
			Answer:      "Answer from somewhere",
			Attribution: "//example.com/article",
			BotDID:      "did:key:z6MkRelativeBot",
			Signature:   []byte("sig"),
			Confidence:  0.6,
		}
		valid, err := impl.ValidateAttribution(resp)
		testutil.RequireNoError(t, err)
		if valid {
			t.Fatal("protocol-relative URL must fail — requires explicit http:// or https://")
		}
	})

	// TRACE: {"suite": "CORE", "case": "0175", "section": "33", "sectionName": "Architecture Review Coverage", "title": "positive_control_https_url_accepted"}
	t.Run("positive_control_https_url_accepted", func(t *testing.T) {
		// Contrast: valid HTTPS URL must pass validation.
		// Without this, the test passes if ValidateAttribution always returns false.
		resp := testutil.BotResponse{
			Answer:      "The Steelcase Leap scored 92/100 in durability tests",
			Attribution: "https://youtube.com/watch?v=abc123&t=142",
			BotDID:      "did:key:z6MkGoodBot",
			Signature:   []byte("sig"),
			Confidence:  0.95,
		}
		valid, err := impl.ValidateAttribution(resp)
		testutil.RequireNoError(t, err)
		if !valid {
			t.Fatal("valid HTTPS attribution must pass validation — positive control failed")
		}
	})

	// TRACE: {"suite": "CORE", "case": "0176", "section": "33", "sectionName": "Architecture Review Coverage", "title": "positive_control_http_url_accepted"}
	t.Run("positive_control_http_url_accepted", func(t *testing.T) {
		resp := testutil.BotResponse{
			Answer:      "Review from legacy site",
			Attribution: "http://reviews.example.com/product/42",
			BotDID:      "did:key:z6MkLegacyBot",
			Signature:   []byte("sig"),
			Confidence:  0.8,
		}
		valid, err := impl.ValidateAttribution(resp)
		testutil.RequireNoError(t, err)
		if !valid {
			t.Fatal("valid HTTP attribution must pass validation")
		}
	})

	// TRACE: {"suite": "CORE", "case": "0177", "section": "33", "sectionName": "Architecture Review Coverage", "title": "trust_penalty_for_stripped_attribution"}
	t.Run("trust_penalty_for_stripped_attribution", func(t *testing.T) {
		// Requirement: bots that strip attribution receive a trust penalty.
		// A bot with stripped attribution must end up with a LOWER score
		// than an identical bot that preserves attribution. This validates
		// the penalty exists without depending on absolute score values.
		impl.ResetForTest()

		goodBot := "did:key:z6MkGoodBot1118"
		badBot := "did:key:z6MkStripperBot1118"

		// Give both bots the same helpful outcome with attribution.
		for _, did := range []string{goodBot, badBot} {
			err := impl.ScoreBot(did, testutil.BotOutcome{
				BotDID:      did,
				Attribution: true,
				Helpful:     true,
			})
			testutil.RequireNoError(t, err)
		}

		// Now good bot gets another attributed outcome...
		err := impl.ScoreBot(goodBot, testutil.BotOutcome{
			BotDID:      goodBot,
			Attribution: true,
			Helpful:     true,
		})
		testutil.RequireNoError(t, err)

		// ...while bad bot strips attribution on the same interaction.
		err = impl.ScoreBot(badBot, testutil.BotOutcome{
			BotDID:      badBot,
			Attribution: false, // Stripped attribution
			Helpful:     true,
		})
		testutil.RequireNoError(t, err)

		goodScore, err := impl.GetScore(goodBot)
		testutil.RequireNoError(t, err)
		badScore, err := impl.GetScore(badBot)
		testutil.RequireNoError(t, err)

		// The bot that stripped attribution must have a lower score.
		if badScore >= goodScore {
			t.Fatalf("bot that strips attribution must score lower than one that preserves it: "+
				"stripped=%.4f, preserved=%.4f", badScore, goodScore)
		}
	})
}
