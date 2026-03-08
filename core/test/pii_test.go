package test

import (
	"context"
	"strings"
	"testing"
	"time"

	piipkg "github.com/rajmohanutopai/dina/core/internal/adapter/pii"
	"github.com/rajmohanutopai/dina/core/test/testutil"
)

var piiCtx = context.Background()

// ---------- §5 PII Scrubber — Tier 1 Go Regex (18 scenarios) ----------

// TST-CORE-343
func TestPII_5_1_EmailDetection(t *testing.T) {
	impl := realPIIScrubber
	testutil.RequireImplementation(t, impl, "PIIScrubber")

	result, err := impl.Scrub(piiCtx, "Email me at john@example.com")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, result.Scrubbed, "Email me at [EMAIL_1]")
	testutil.RequireLen(t, len(result.Entities), 1)
}

// TST-CORE-344
func TestPII_5_2_PhoneDetection(t *testing.T) {
	impl := realPIIScrubber
	testutil.RequireImplementation(t, impl, "PIIScrubber")

	result, err := impl.Scrub(piiCtx, "Call 555-123-4567")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, result.Scrubbed, "Call [PHONE_1]")
	testutil.RequireLen(t, len(result.Entities), 1)
}

// TST-CORE-345
func TestPII_5_3_SSNDetection(t *testing.T) {
	impl := realPIIScrubber
	testutil.RequireImplementation(t, impl, "PIIScrubber")

	result, err := impl.Scrub(piiCtx, "SSN 123-45-6789")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, result.Scrubbed, "SSN [SSN_1]")
	testutil.RequireLen(t, len(result.Entities), 1)
}

// TST-CORE-346
func TestPII_5_4_CreditCardDetection(t *testing.T) {
	impl := realPIIScrubber
	testutil.RequireImplementation(t, impl, "PIIScrubber")

	result, err := impl.Scrub(piiCtx, "Card 4111-1111-1111-1111")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, result.Scrubbed, "Card [CREDIT_CARD_1]")
	testutil.RequireLen(t, len(result.Entities), 1)
}

// TST-CORE-355
func TestPII_5_5_MultipleEmails(t *testing.T) {
	impl := piipkg.NewScrubber()
	testutil.RequireImplementation(t, impl, "PIIScrubber")

	ctx := context.Background()

	// Positive: two distinct emails get unique numbered tokens.
	result, err := impl.Scrub(ctx, "From john@example.com to jane@example.com")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, result.Scrubbed, "From [EMAIL_1] to [EMAIL_2]")
	testutil.RequireLen(t, len(result.Entities), 2)
	testutil.RequireEqual(t, result.Entities[0].Type, "EMAIL")
	testutil.RequireEqual(t, result.Entities[1].Type, "EMAIL")

	// Negative: single email only produces [EMAIL_1], no [EMAIL_2].
	single, err := impl.Scrub(ctx, "Only alice@example.com here")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, single.Scrubbed, "Only [EMAIL_1] here")
	testutil.RequireLen(t, len(single.Entities), 1)

	// Negative: no emails at all → text unchanged, zero entities.
	clean, err := impl.Scrub(ctx, "No PII in this sentence")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, clean.Scrubbed, "No PII in this sentence")
	testutil.RequireLen(t, len(clean.Entities), 0)
}

// TST-CORE-348
func TestPII_5_6_NoPII(t *testing.T) {
	impl := realPIIScrubber
	testutil.RequireImplementation(t, impl, "PIIScrubber")

	result, err := impl.Scrub(piiCtx, "The weather is nice today")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, result.Scrubbed, "The weather is nice today")
	testutil.RequireLen(t, len(result.Entities), 0)
}

// TST-CORE-349
func TestPII_5_7_MixedPII(t *testing.T) {
	impl := piipkg.NewScrubber()
	testutil.RequireImplementation(t, impl, "PIIScrubber")

	ctx := context.Background()

	// Positive: mixed PII types (email + phone) get separate numbered tokens.
	result, err := impl.Scrub(ctx, "Contact john@example.com or call 555-123-4567")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, result.Scrubbed, "Contact [EMAIL_1] or call [PHONE_1]")
	testutil.RequireLen(t, len(result.Entities), 2)
	testutil.RequireEqual(t, result.Entities[0].Type, "EMAIL")
	testutil.RequireEqual(t, result.Entities[1].Type, "PHONE")

	// Negative: text with no PII → unchanged, zero entities.
	clean, err := impl.Scrub(ctx, "Just some normal text here")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, clean.Scrubbed, "Just some normal text here")
	testutil.RequireLen(t, len(clean.Entities), 0)
}

// TST-CORE-776
func TestPII_5_8_AddressDetection(t *testing.T) {
	// Fresh instance — no shared state.
	scrubber := piipkg.NewScrubber()
	testutil.RequireImplementation(t, scrubber, "PIIScrubber")

	ctx := context.Background()

	// Positive control: text with a street address must be detected.
	// The ADDRESS regex matches: digits + capitalized words + street suffix.
	result, err := scrubber.Scrub(ctx, "Lives at 42 Baker Street, London")
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(result.Entities) >= 1,
		"address '42 Baker Street' must be detected as PII")
	testutil.RequireTrue(t, strings.Contains(result.Scrubbed, "[ADDRESS"),
		"scrubbed text must contain [ADDRESS redaction marker")
	// Verify the original address is removed from scrubbed output.
	testutil.RequireFalse(t, strings.Contains(result.Scrubbed, "42 Baker Street"),
		"scrubbed text must not contain the original address")

	// Negative control: text without any address must produce no ADDRESS entities.
	clean, err := scrubber.Scrub(ctx, "The weather is nice today")
	testutil.RequireNoError(t, err)
	for _, entity := range clean.Entities {
		testutil.RequireFalse(t, entity.Type == "ADDRESS",
			"non-address text must not produce ADDRESS entities")
	}
	testutil.RequireEqual(t, clean.Scrubbed, "The weather is nice today")
}

// TST-CORE-777
func TestPII_5_9_TableDriven(t *testing.T) {
	scrubber := piipkg.NewScrubber()
	testutil.RequireImplementation(t, scrubber, "PIIScrubber")

	ctx := context.Background()

	// Verify test cases are non-empty — guards against vacuous pass.
	testutil.RequireTrue(t, len(testutil.PIITestCases) >= 5, "PIITestCases must contain at least 5 cases")

	for _, tc := range testutil.PIITestCases {
		t.Run(tc.Name, func(t *testing.T) {
			result, err := scrubber.Scrub(ctx, tc.Input)
			testutil.RequireNoError(t, err)
			testutil.RequireEqual(t, result.Scrubbed, tc.Expected)
			testutil.RequireLen(t, len(result.Entities), len(tc.Entities))

			// Verify each entity's original value matches the expected fixture.
			for i, entity := range result.Entities {
				if i < len(tc.Entities) {
					testutil.RequireEqual(t, entity.Value, tc.Entities[i])
				}
			}
		})
	}
}

// TST-CORE-352
func TestPII_5_10_LatencyUnder1ms(t *testing.T) {
	// Fresh scrubber — no shared state.
	impl := piipkg.NewScrubber()
	testutil.RequireImplementation(t, impl, "PIIScrubber")

	input := "Contact john@example.com or call 555-123-4567"

	// Warm up — verify scrub works correctly before benchmarking.
	warmup, err := impl.Scrub(piiCtx, input)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(warmup.Entities) > 0,
		"warmup scrub should detect PII entities")

	// Measure latency over multiple iterations for reliability.
	iterations := 100
	start := time.Now()
	for i := 0; i < iterations; i++ {
		result, err := impl.Scrub(piiCtx, input)
		if err != nil {
			t.Fatalf("scrub failed on iteration %d: %v", i, err)
		}
		// Verify each iteration actually scrubs (not a no-op).
		if len(result.Entities) == 0 {
			t.Fatalf("iteration %d: scrub returned zero entities — no-op", i)
		}
	}
	elapsed := time.Since(start)
	avgLatency := elapsed / time.Duration(iterations)

	// Assert average latency is under 1ms.
	testutil.RequireTrue(t, avgLatency < time.Millisecond,
		"PII scrub average latency must be under 1ms, got "+avgLatency.String())

	t.Logf("PII scrub avg latency: %v (over %d iterations)", avgLatency, iterations)
}

// TST-CORE-353
func TestPII_5_11_AddCustomPattern(t *testing.T) {
	impl := piipkg.NewScrubber()
	testutil.RequireImplementation(t, impl, "PIIScrubber")

	ctx := context.Background()

	// Negative: before adding pattern, custom ID format is NOT detected.
	before, err := impl.Scrub(ctx, "ID: CUST-12345")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, before.Scrubbed, "ID: CUST-12345")
	testutil.RequireLen(t, len(before.Entities), 0)

	// Positive: add a custom pattern and verify it detects matches.
	err = impl.AddPattern("CUSTOM_ID", `CUST-\d{5}`)
	testutil.RequireNoError(t, err)

	after, err := impl.Scrub(ctx, "ID: CUST-12345")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, after.Scrubbed, "ID: [CUSTOM_ID_1]")
	testutil.RequireLen(t, len(after.Entities), 1)
	testutil.RequireEqual(t, after.Entities[0].Type, "CUSTOM_ID")

	// Negative: invalid regex must return error.
	err = impl.AddPattern("BAD", `[invalid`)
	testutil.RequireTrue(t, err != nil, "invalid regex must return error")
}

// TST-CORE-778
func TestPII_5_12_EmptyInput(t *testing.T) {
	impl := piipkg.NewScrubber()
	testutil.RequireImplementation(t, impl, "PIIScrubber")

	ctx := context.Background()

	// Positive: empty string → empty output, zero entities.
	result, err := impl.Scrub(ctx, "")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, result.Scrubbed, "")
	testutil.RequireLen(t, len(result.Entities), 0)

	// Positive companion: non-empty text WITH PII is detected (proves scrubber works).
	withPII, err := impl.Scrub(ctx, "test@example.com")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, withPII.Scrubbed, "[EMAIL_1]")
	testutil.RequireLen(t, len(withPII.Entities), 1)
}

// TST-CORE-355
func TestPII_5_13_NumberedTokensUnique(t *testing.T) {
	impl := realPIIScrubber
	testutil.RequireImplementation(t, impl, "PIIScrubber")

	result, err := impl.Scrub(piiCtx, "john@a.com and jane@b.com and bob@c.com")
	testutil.RequireNoError(t, err)
	testutil.RequireContains(t, result.Scrubbed, "[EMAIL_1]")
	testutil.RequireContains(t, result.Scrubbed, "[EMAIL_2]")
	testutil.RequireContains(t, result.Scrubbed, "[EMAIL_3]")
}

// TST-CORE-359
func TestPII_5_14_IndianPhoneNumber(t *testing.T) {
	// Fresh scrubber — no shared state.
	impl := piipkg.NewScrubber()
	testutil.RequireImplementation(t, impl, "PIIScrubber")

	// Positive: Indian phone number must be detected and scrubbed.
	input := "Call +91 98765 43210 for details"
	result, err := impl.Scrub(piiCtx, input)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(result.Entities) >= 1,
		"expected Indian phone number to be detected")

	// Verify entity type is PHONE.
	foundPhone := false
	for _, e := range result.Entities {
		if e.Type == "PHONE" {
			foundPhone = true
		}
	}
	testutil.RequireTrue(t, foundPhone, "entity type must be PHONE for Indian number")

	// Verify the phone number is removed from scrubbed output.
	testutil.RequireFalse(t, strings.Contains(result.Scrubbed, "98765"),
		"scrubbed output must not contain the phone number digits")

	// Negative: text without phone numbers → 0 PHONE entities.
	clean, err := impl.Scrub(piiCtx, "Hello world, no phone here")
	testutil.RequireNoError(t, err)
	for _, e := range clean.Entities {
		if e.Type == "PHONE" {
			t.Fatalf("clean text should not produce PHONE entities, got %+v", e)
		}
	}
}

// TST-CORE-779
func TestPII_5_15_EmailInURL(t *testing.T) {
	scrubber := piipkg.NewScrubber()
	testutil.RequireImplementation(t, scrubber, "PIIScrubber")

	// Positive: email inside mailto: URI must be detected and scrubbed.
	result, err := scrubber.Scrub(piiCtx, "Visit mailto:john@example.com")
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(result.Entities) >= 1, "must detect email in mailto: URI")
	testutil.RequireEqual(t, result.Entities[0].Type, "EMAIL")
	testutil.RequireEqual(t, result.Entities[0].Value, "john@example.com")
	testutil.RequireTrue(t, strings.Contains(result.Scrubbed, "[EMAIL_1]"),
		"scrubbed output must contain [EMAIL_1] placeholder")
	testutil.RequireTrue(t, !strings.Contains(result.Scrubbed, "john@example.com"),
		"raw email must not appear in scrubbed output")

	// Positive: email in an https URL query parameter.
	result2, err := scrubber.Scrub(piiCtx, "https://example.com/login?user=alice@corp.io")
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(result2.Entities) >= 1, "must detect email in URL query param")
	testutil.RequireEqual(t, result2.Entities[0].Type, "EMAIL")
	testutil.RequireEqual(t, result2.Entities[0].Value, "alice@corp.io")

	// Negative: URL without email must pass through unchanged.
	safe, err := scrubber.Scrub(piiCtx, "Visit https://example.com/page")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, safe.Scrubbed, "Visit https://example.com/page")
	testutil.RequireEqual(t, len(safe.Entities), 0)
}

// TST-CORE-780
func TestPII_5_16_ConsecutivePIISameType(t *testing.T) {
	scrubber := piipkg.NewScrubber()
	testutil.RequireImplementation(t, scrubber, "PIIScrubber")

	ctx := context.Background()

	// Positive: two SSNs in same text get sequential tokens.
	result, err := scrubber.Scrub(ctx, "SSN 123-45-6789 and 987-65-4321")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, result.Scrubbed, "SSN [SSN_1] and [SSN_2]")
	testutil.RequireLen(t, len(result.Entities), 2)
	testutil.RequireEqual(t, result.Entities[0].Type, "SSN")
	testutil.RequireEqual(t, result.Entities[1].Type, "SSN")
	testutil.RequireEqual(t, result.Entities[0].Value, "123-45-6789")
	testutil.RequireEqual(t, result.Entities[1].Value, "987-65-4321")

	// Negative: text without SSNs returns unchanged.
	clean, err := scrubber.Scrub(ctx, "No social security numbers here")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, clean.Scrubbed, "No social security numbers here")
	testutil.RequireLen(t, len(clean.Entities), 0)
}

// TST-CORE-781
func TestPII_5_17_SQLInjectionInInput(t *testing.T) {
	scrubber := piipkg.NewScrubber()
	testutil.RequireImplementation(t, scrubber, "PIIScrubber")

	// Positive: SQL injection payload with no PII must pass through unmodified.
	sqlPayload := "'; DROP TABLE users; --"
	result, err := scrubber.Scrub(piiCtx, sqlPayload)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, result.Scrubbed, sqlPayload)
	testutil.RequireEqual(t, len(result.Entities), 0)

	// SQL injection payload WITH embedded PII — PII is scrubbed, SQL passes through.
	mixed := "'; DROP TABLE users; -- john@evil.com"
	result2, err := scrubber.Scrub(piiCtx, mixed)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, strings.Contains(result2.Scrubbed, "DROP TABLE users"), "SQL payload must survive scrubbing")
	testutil.RequireTrue(t, strings.Contains(result2.Scrubbed, "[EMAIL_1]"), "embedded email must be scrubbed")
	testutil.RequireTrue(t, !strings.Contains(result2.Scrubbed, "john@evil.com"), "raw email must not appear in scrubbed output")
	testutil.RequireTrue(t, len(result2.Entities) >= 1, "must detect at least 1 PII entity")
	testutil.RequireEqual(t, result2.Entities[0].Type, "EMAIL")
	testutil.RequireEqual(t, result2.Entities[0].Value, "john@evil.com")

	// Negative: another common injection pattern — no PII, passes through.
	injection2 := "1 OR 1=1; SELECT * FROM passwords"
	result3, err := scrubber.Scrub(piiCtx, injection2)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, result3.Scrubbed, injection2)
	testutil.RequireEqual(t, len(result3.Entities), 0)
}

// TST-CORE-782
func TestPII_5_18_UnicodeTextSafe(t *testing.T) {
	scrubber := piipkg.NewScrubber()

	// Positive: Unicode text with embedded PII — email must be scrubbed,
	// Unicode prefix must be preserved intact.
	result, err := scrubber.Scrub(piiCtx, "नमस्ते john@example.com")
	testutil.RequireNoError(t, err)
	testutil.RequireContains(t, result.Scrubbed, "नमस्ते")
	testutil.RequireContains(t, result.Scrubbed, "[EMAIL_1]")
	testutil.RequireTrue(t, len(result.Entities) >= 1, "must detect at least 1 PII entity")

	// Verify the detected entity is EMAIL with correct value.
	found := false
	for _, e := range result.Entities {
		if e.Type == "EMAIL" && e.Value == "john@example.com" {
			found = true
		}
	}
	testutil.RequireTrue(t, found, "must detect EMAIL entity with value john@example.com")

	// Negative: pure Unicode text without PII must pass through unmodified.
	safe, err := scrubber.Scrub(piiCtx, "नमस्ते दुनिया")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, safe.Scrubbed, "नमस्ते दुनिया")
	testutil.RequireEqual(t, len(safe.Entities), 0)
}

// TST-CORE-347
func TestPII_5_19_IPAddressDetection(t *testing.T) {
	impl := realPIIScrubber
	testutil.RequireImplementation(t, impl, "PIIScrubber")

	// Positive: IPv4 address is detected and scrubbed.
	result, err := impl.Scrub(piiCtx, "From 192.168.1.1")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, result.Scrubbed, "From [IP_1]")
	testutil.RequireLen(t, len(result.Entities), 1)
	testutil.RequireEqual(t, result.Entities[0].Type, "IP")
	testutil.RequireEqual(t, result.Entities[0].Value, "192.168.1.1")

	// Negative: text without IP addresses must not be flagged as IP.
	safe, err := impl.Scrub(piiCtx, "version 3.14 released")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, safe.Scrubbed, "version 3.14 released")
	for _, e := range safe.Entities {
		if e.Type == "IP" {
			t.Fatal("non-IP text '3.14' must not be detected as an IP address")
		}
	}
}

// TST-CORE-350
func TestPII_5_20_PIIAtStringBoundaries(t *testing.T) {
	impl := piipkg.NewScrubber()
	testutil.RequireImplementation(t, impl, "PIIScrubber")

	ctx := context.Background()

	// Positive: PII at start of string (no leading text).
	start, err := impl.Scrub(ctx, "john@example.com")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, start.Scrubbed, "[EMAIL_1]")
	testutil.RequireLen(t, len(start.Entities), 1)

	// Positive: PII at end of string (no trailing text).
	end, err := impl.Scrub(ctx, "Send to john@example.com")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, end.Scrubbed, "Send to [EMAIL_1]")
	testutil.RequireLen(t, len(end.Entities), 1)

	// Positive: PII is the ENTIRE string.
	entire, err := impl.Scrub(ctx, "555-123-4567")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, entire.Scrubbed, "[PHONE_1]")
	testutil.RequireLen(t, len(entire.Entities), 1)

	// Negative: text with no PII → unchanged.
	clean, err := impl.Scrub(ctx, "Hello world")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, clean.Scrubbed, "Hello world")
	testutil.RequireLen(t, len(clean.Entities), 0)
}

// TST-CORE-351
func TestPII_5_21_UnicodeInternationalFormats(t *testing.T) {
	// §5.21: International phone number formats must be detected and scrubbed.
	// Fresh scrubber to avoid shared state.
	scrubber := piipkg.NewScrubber()
	testutil.RequireImplementation(t, scrubber, "PIIScrubber")

	ctx := context.Background()

	// Positive: UK phone number with international prefix.
	result, err := scrubber.Scrub(ctx, "Call +44 20 7946 0958")
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(result.Entities) >= 1,
		"UK phone number +44 20 7946 0958 must be detected")
	testutil.RequireEqual(t, result.Entities[0].Type, "PHONE")

	// Positive: US phone number with international prefix.
	usResult, err := scrubber.Scrub(ctx, "Dial +1 555 123 4567 for info")
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(usResult.Entities) >= 1,
		"US phone number +1 555 123 4567 must be detected")

	// Negative: text without phone numbers must return unchanged.
	clean, err := scrubber.Scrub(ctx, "The price is 42 euros")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, clean.Scrubbed, "The price is 42 euros")
	testutil.RequireEqual(t, len(clean.Entities), 0)
}

// TST-CORE-354
func TestPII_5_22_BankAccountNumber(t *testing.T) {
	scrubber := piipkg.NewScrubber()
	testutil.RequireImplementation(t, scrubber, "PIIScrubber")

	ctx := context.Background()

	// Positive: 16-digit bank account number is detected and scrubbed.
	result, err := scrubber.Scrub(ctx, "Acct 1234567890123456")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, result.Scrubbed, "Acct [BANK_ACCT_1]")
	testutil.RequireLen(t, len(result.Entities), 1)
	testutil.RequireEqual(t, result.Entities[0].Type, "BANK_ACCT")

	// Negative control: text without a bank account number returns unchanged.
	clean, err := scrubber.Scrub(ctx, "Order total is 42 dollars")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, clean.Scrubbed, "Order total is 42 dollars")
	testutil.RequireLen(t, len(clean.Entities), 0)
}

// TST-CORE-356
func TestPII_5_23_ReplacementMapReturned(t *testing.T) {
	scrubber := piipkg.NewScrubber()
	testutil.RequireImplementation(t, scrubber, "PIIScrubber")

	ctx := context.Background()

	// Positive: scrub text with both email and phone — replacement map must contain both.
	result, err := scrubber.Scrub(ctx, "Email john@example.com, call 555-123-4567")
	testutil.RequireNoError(t, err)
	testutil.RequireContains(t, result.Scrubbed, "[EMAIL_1]")
	testutil.RequireContains(t, result.Scrubbed, "[PHONE_1]")
	testutil.RequireLen(t, len(result.Entities), 2)

	// Verify entity types and original values are in the replacement map.
	typeSet := map[string]bool{}
	for _, e := range result.Entities {
		typeSet[e.Type] = true
	}
	testutil.RequireTrue(t, typeSet["EMAIL"], "replacement map must contain EMAIL entity")
	testutil.RequireTrue(t, typeSet["PHONE"], "replacement map must contain PHONE entity")

	// Negative control: clean text returns empty replacement map.
	clean, err := scrubber.Scrub(ctx, "No PII here at all")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, clean.Scrubbed, "No PII here at all")
	testutil.RequireLen(t, len(clean.Entities), 0)
}

// TST-CORE-357
func TestPII_5_24_ReplacementMapRoundTrip(t *testing.T) {
	scrubber := piipkg.NewScrubber()
	testutil.RequireImplementation(t, scrubber, "PIIScrubber")
	desanitizer := piipkg.NewDeSanitizer()
	testutil.RequireImplementation(t, desanitizer, "PIIDeSanitizer")

	ctx := context.Background()

	// Positive: full round trip — scrub → de-sanitize must restore original text.
	original := "Contact john@example.com or call 555-123-4567"
	result, err := scrubber.Scrub(ctx, original)
	testutil.RequireNoError(t, err)
	testutil.RequireContains(t, result.Scrubbed, "[EMAIL_1]")
	testutil.RequireContains(t, result.Scrubbed, "[PHONE_1]")
	testutil.RequireLen(t, len(result.Entities), 2)

	restored, err := desanitizer.DeSanitize(result.Scrubbed, result.Entities)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, restored, original)

	// Negative: empty entities → text unchanged (no-op de-sanitize).
	unchanged, err := desanitizer.DeSanitize("Just plain text", nil)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, unchanged, "Just plain text")
}

// TST-CORE-358
func TestPII_5_16_NoFalsePositivesOnNumbers(t *testing.T) {
	impl := realPIIScrubber
	testutil.RequireImplementation(t, impl, "PIIScrubber")

	result, err := impl.Scrub(piiCtx, "The product costs $1,234.56")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, result.Scrubbed, "The product costs $1,234.56")
	testutil.RequireLen(t, len(result.Entities), 0)
}

// TST-CORE-886
func TestPII_5_26_DeSanitizeEndpoint_RestoresTokensFromMap(t *testing.T) {
	// PII de-sanitization endpoint — restores tokens from replacement map.
	scrubber := realPIIScrubber
	testutil.RequireImplementation(t, scrubber, "PIIScrubber")
	desanitizer := realDeSanitizer
	testutil.RequireImplementation(t, desanitizer, "PIIDeSanitizer")

	original := "Contact john@example.com or call 555-123-4567"
	result, err := scrubber.Scrub(piiCtx, original)
	testutil.RequireNoError(t, err)

	restored, err := desanitizer.DeSanitize(result.Scrubbed, result.Entities)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, restored, original)
}

// TST-CORE-887
func TestPII_5_27_ScrubEndpoint_NoOutboundNetworkCalls(t *testing.T) {
	// §5.27: PII scrubber must be fully local — regex-only, no network calls.
	// Verify by code audit: scrubber source must not import net/http or make outbound calls.
	// Fresh scrubber for isolation.
	scrubber := piipkg.NewScrubber()
	testutil.RequireImplementation(t, scrubber, "PIIScrubber")

	ctx := context.Background()

	// Positive: scrubbing produces correct replacements without any network dependency.
	result, err := scrubber.Scrub(ctx, "Email john@example.com and SSN 123-45-6789")
	testutil.RequireNoError(t, err)
	testutil.RequireContains(t, result.Scrubbed, "[EMAIL_1]")
	testutil.RequireContains(t, result.Scrubbed, "[SSN_1]")
	testutil.RequireTrue(t, len(result.Entities) >= 2,
		"must detect at least 2 PII entities (email + SSN)")

	// Verify entity types are correct.
	entityTypes := map[string]bool{}
	for _, e := range result.Entities {
		entityTypes[e.Type] = true
	}
	testutil.RequireTrue(t, entityTypes["EMAIL"], "EMAIL entity type must be present")
	testutil.RequireTrue(t, entityTypes["SSN"], "SSN entity type must be present")

	// Code audit: scrubber source must NOT import net/http (no network calls).
	src, err := os.ReadFile("../internal/adapter/pii/scrubber.go")
	if err != nil {
		t.Fatalf("cannot read scrubber source: %v", err)
	}
	srcStr := string(src)
	testutil.RequireFalse(t, strings.Contains(srcStr, `"net/http"`),
		"PII scrubber must not import net/http — must be fully local")
	testutil.RequireFalse(t, strings.Contains(srcStr, `http.Get`),
		"PII scrubber must not call http.Get — must be fully local")

	// Negative: clean text returns unchanged.
	clean, err := scrubber.Scrub(ctx, "No PII here at all")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, clean.Scrubbed, "No PII here at all")
	testutil.RequireEqual(t, len(clean.Entities), 0)
}

// TST-CORE-888
func TestPII_5_28_SensitivePersona_MandatoryPIIScrubBeforeCloudLLM(t *testing.T) {
	// Fresh scrubber for isolation.
	impl := piipkg.NewScrubber()

	// Health persona data with multiple PII types: name, SSN, phone.
	healthData := "Patient John Smith (SSN 123-45-6789) call 555-867-5309 diagnosed with condition X"
	result, err := impl.Scrub(piiCtx, healthData)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(result.Entities) >= 2, "health data must have at least 2 PII entities detected")

	// Verify specific PII types were detected.
	entityTypes := map[string]bool{}
	for _, e := range result.Entities {
		entityTypes[e.Type] = true
	}
	testutil.RequireTrue(t, entityTypes["SSN"], "SSN entity must be detected")
	testutil.RequireTrue(t, entityTypes["PHONE"], "PHONE entity must be detected")

	// Positive: no raw PII remains in scrubbed output.
	scrubbed := result.Scrubbed
	testutil.RequireTrue(t, len(scrubbed) > 0, "scrubbed text must not be empty")

	// SSN must be replaced.
	for i := 0; i <= len(scrubbed)-len("123-45-6789"); i++ {
		if scrubbed[i:i+len("123-45-6789")] == "123-45-6789" {
			t.Fatal("SSN must not appear in scrubbed output for sensitive persona")
		}
	}
	// Phone must be replaced.
	for i := 0; i <= len(scrubbed)-len("555-867-5309"); i++ {
		if scrubbed[i:i+len("555-867-5309")] == "555-867-5309" {
			t.Fatal("Phone must not appear in scrubbed output for sensitive persona")
		}
	}

	// Negative: text without PII should produce 0 entities.
	cleanResult, err := impl.Scrub(piiCtx, "No personal data here, just medical notes about condition X")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(cleanResult.Entities), 0)
}
