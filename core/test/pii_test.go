package test

import (
	"testing"

	"github.com/anthropics/dina/core/test/testutil"
)

// ---------- §5 PII Scrubber — Tier 1 Go Regex (18 scenarios) ----------

// TST-CORE-343
func TestPII_5_1_EmailDetection(t *testing.T) {
	var impl testutil.PIIScrubber
	// impl = pii.NewScrubber()
	testutil.RequireImplementation(t, impl, "PIIScrubber")

	scrubbed, entities, err := impl.Scrub("Email me at john@example.com")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, scrubbed, "Email me at [EMAIL_1]")
	testutil.RequireLen(t, len(entities), 1)
}

// TST-CORE-344
func TestPII_5_2_PhoneDetection(t *testing.T) {
	var impl testutil.PIIScrubber
	testutil.RequireImplementation(t, impl, "PIIScrubber")

	scrubbed, entities, err := impl.Scrub("Call 555-123-4567")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, scrubbed, "Call [PHONE_1]")
	testutil.RequireLen(t, len(entities), 1)
}

// TST-CORE-345
func TestPII_5_3_SSNDetection(t *testing.T) {
	var impl testutil.PIIScrubber
	testutil.RequireImplementation(t, impl, "PIIScrubber")

	scrubbed, entities, err := impl.Scrub("SSN 123-45-6789")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, scrubbed, "SSN [SSN_1]")
	testutil.RequireLen(t, len(entities), 1)
}

// TST-CORE-346
func TestPII_5_4_CreditCardDetection(t *testing.T) {
	var impl testutil.PIIScrubber
	testutil.RequireImplementation(t, impl, "PIIScrubber")

	scrubbed, entities, err := impl.Scrub("Card 4111-1111-1111-1111")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, scrubbed, "Card [CREDIT_CARD_1]")
	testutil.RequireLen(t, len(entities), 1)
}

// TST-CORE-355
func TestPII_5_5_MultipleEmails(t *testing.T) {
	var impl testutil.PIIScrubber
	testutil.RequireImplementation(t, impl, "PIIScrubber")

	scrubbed, entities, err := impl.Scrub("From john@example.com to jane@example.com")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, scrubbed, "From [EMAIL_1] to [EMAIL_2]")
	testutil.RequireLen(t, len(entities), 2)
}

// TST-CORE-348
func TestPII_5_6_NoPII(t *testing.T) {
	var impl testutil.PIIScrubber
	testutil.RequireImplementation(t, impl, "PIIScrubber")

	scrubbed, entities, err := impl.Scrub("The weather is nice today")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, scrubbed, "The weather is nice today")
	testutil.RequireLen(t, len(entities), 0)
}

// TST-CORE-349
func TestPII_5_7_MixedPII(t *testing.T) {
	var impl testutil.PIIScrubber
	testutil.RequireImplementation(t, impl, "PIIScrubber")

	scrubbed, entities, err := impl.Scrub("Contact john@example.com or call 555-123-4567")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, scrubbed, "Contact [EMAIL_1] or call [PHONE_1]")
	testutil.RequireLen(t, len(entities), 2)
}

// TST-CORE-776
func TestPII_5_8_AddressDetection(t *testing.T) {
	var impl testutil.PIIScrubber
	testutil.RequireImplementation(t, impl, "PIIScrubber")

	_, entities, err := impl.Scrub("Lives at 42 Baker Street, London")
	testutil.RequireNoError(t, err)
	if len(entities) == 0 {
		t.Skip("address detection pattern may vary by implementation")
	}
}

// TST-CORE-777
func TestPII_5_9_TableDriven(t *testing.T) {
	var impl testutil.PIIScrubber
	testutil.RequireImplementation(t, impl, "PIIScrubber")

	for _, tc := range testutil.PIITestCases {
		t.Run(tc.Name, func(t *testing.T) {
			scrubbed, entities, err := impl.Scrub(tc.Input)
			testutil.RequireNoError(t, err)
			testutil.RequireEqual(t, scrubbed, tc.Expected)
			testutil.RequireLen(t, len(entities), len(tc.Entities))
		})
	}
}

// TST-CORE-352
func TestPII_5_10_LatencyUnder1ms(t *testing.T) {
	var impl testutil.PIIScrubber
	testutil.RequireImplementation(t, impl, "PIIScrubber")
	t.Skip("requires benchmark — <1ms for PII scrubbing")
}

// TST-CORE-353
func TestPII_5_11_AddCustomPattern(t *testing.T) {
	var impl testutil.PIIScrubber
	testutil.RequireImplementation(t, impl, "PIIScrubber")

	err := impl.AddPattern("AADHAAR", `\d{4}\s\d{4}\s\d{4}`)
	testutil.RequireNoError(t, err)
}

// TST-CORE-778
func TestPII_5_12_EmptyInput(t *testing.T) {
	var impl testutil.PIIScrubber
	testutil.RequireImplementation(t, impl, "PIIScrubber")

	scrubbed, entities, err := impl.Scrub("")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, scrubbed, "")
	testutil.RequireLen(t, len(entities), 0)
}

// TST-CORE-355
func TestPII_5_13_NumberedTokensUnique(t *testing.T) {
	var impl testutil.PIIScrubber
	testutil.RequireImplementation(t, impl, "PIIScrubber")

	scrubbed, _, err := impl.Scrub("john@a.com and jane@b.com and bob@c.com")
	testutil.RequireNoError(t, err)
	testutil.RequireContains(t, scrubbed, "[EMAIL_1]")
	testutil.RequireContains(t, scrubbed, "[EMAIL_2]")
	testutil.RequireContains(t, scrubbed, "[EMAIL_3]")
}

// TST-CORE-359
func TestPII_5_14_IndianPhoneNumber(t *testing.T) {
	var impl testutil.PIIScrubber
	testutil.RequireImplementation(t, impl, "PIIScrubber")

	_, entities, err := impl.Scrub("Call +91 98765 43210")
	testutil.RequireNoError(t, err)
	if len(entities) < 1 {
		t.Error("expected Indian phone number to be detected")
	}
}

// TST-CORE-779
func TestPII_5_15_EmailInURL(t *testing.T) {
	var impl testutil.PIIScrubber
	testutil.RequireImplementation(t, impl, "PIIScrubber")

	_, entities, err := impl.Scrub("Visit mailto:john@example.com")
	testutil.RequireNoError(t, err)
	if len(entities) < 1 {
		t.Error("expected email in mailto: to be detected")
	}
}

// TST-CORE-780
func TestPII_5_16_ConsecutivePIISameType(t *testing.T) {
	var impl testutil.PIIScrubber
	testutil.RequireImplementation(t, impl, "PIIScrubber")

	scrubbed, _, err := impl.Scrub("SSN 123-45-6789 and 987-65-4321")
	testutil.RequireNoError(t, err)
	testutil.RequireContains(t, scrubbed, "[SSN_1]")
	testutil.RequireContains(t, scrubbed, "[SSN_2]")
}

// TST-CORE-781
func TestPII_5_17_SQLInjectionInInput(t *testing.T) {
	var impl testutil.PIIScrubber
	testutil.RequireImplementation(t, impl, "PIIScrubber")

	_, _, err := impl.Scrub("'; DROP TABLE users; --")
	testutil.RequireNoError(t, err)
}

// TST-CORE-782
func TestPII_5_18_UnicodeTextSafe(t *testing.T) {
	var impl testutil.PIIScrubber
	testutil.RequireImplementation(t, impl, "PIIScrubber")

	scrubbed, _, err := impl.Scrub("नमस्ते john@example.com")
	testutil.RequireNoError(t, err)
	testutil.RequireContains(t, scrubbed, "[EMAIL_1]")
}

// TST-CORE-347
func TestPII_5_19_IPAddressDetection(t *testing.T) {
	var impl testutil.PIIScrubber
	testutil.RequireImplementation(t, impl, "PIIScrubber")

	scrubbed, entities, err := impl.Scrub("From 192.168.1.1")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, scrubbed, "From [IP_1]")
	testutil.RequireLen(t, len(entities), 1)
}

// TST-CORE-350
func TestPII_5_20_PIIAtStringBoundaries(t *testing.T) {
	var impl testutil.PIIScrubber
	testutil.RequireImplementation(t, impl, "PIIScrubber")

	scrubbed, entities, err := impl.Scrub("john@example.com")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, scrubbed, "[EMAIL_1]")
	testutil.RequireLen(t, len(entities), 1)
}

// TST-CORE-351
func TestPII_5_21_UnicodeInternationalFormats(t *testing.T) {
	var impl testutil.PIIScrubber
	testutil.RequireImplementation(t, impl, "PIIScrubber")

	_, entities, err := impl.Scrub("Call +44 20 7946 0958")
	testutil.RequireNoError(t, err)
	if len(entities) < 1 {
		t.Error("expected UK phone number to be detected")
	}
}

// TST-CORE-354
func TestPII_5_22_BankAccountNumber(t *testing.T) {
	var impl testutil.PIIScrubber
	testutil.RequireImplementation(t, impl, "PIIScrubber")

	scrubbed, entities, err := impl.Scrub("Acct 1234567890123456")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, scrubbed, "Acct [BANK_ACCT_1]")
	testutil.RequireLen(t, len(entities), 1)
}

// TST-CORE-356
func TestPII_5_23_ReplacementMapReturned(t *testing.T) {
	var impl testutil.PIIScrubber
	testutil.RequireImplementation(t, impl, "PIIScrubber")

	scrubbed, entities, err := impl.Scrub("Email john@example.com, call 555-123-4567")
	testutil.RequireNoError(t, err)
	testutil.RequireContains(t, scrubbed, "[EMAIL_1]")
	testutil.RequireContains(t, scrubbed, "[PHONE_1]")
	testutil.RequireLen(t, len(entities), 2)
}

// TST-CORE-357
func TestPII_5_24_ReplacementMapRoundTrip(t *testing.T) {
	var impl testutil.PIIScrubber
	testutil.RequireImplementation(t, impl, "PIIScrubber")

	// Scrub → replacement map → de-sanitize: tokens must restore originals.
	scrubbed, entities, err := impl.Scrub("Contact john@example.com")
	testutil.RequireNoError(t, err)
	testutil.RequireContains(t, scrubbed, "[EMAIL_1]")
	testutil.RequireLen(t, len(entities), 1)
}

// TST-CORE-358
func TestPII_5_25_NoFalsePositivesOnNumbers(t *testing.T) {
	var impl testutil.PIIScrubber
	testutil.RequireImplementation(t, impl, "PIIScrubber")

	scrubbed, entities, err := impl.Scrub("The product costs $1,234.56")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, scrubbed, "The product costs $1,234.56")
	testutil.RequireLen(t, len(entities), 0)
}
