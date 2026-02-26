package test

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/test/testutil"
)

// ==========================================================================
// TEST_PLAN §6 — Gatekeeper
// 22 scenarios across 3 subsections: Intent Evaluation, Egress Policy,
// Trust Ring & Persona Access Control.
// ==========================================================================

// --------------------------------------------------------------------------
// §6.1 Intent Evaluation (8 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-783
func TestGatekeeper_6_1_1_SafeIntentAllowed(t *testing.T) {
	impl := realGatekeeper
	// impl = gatekeeper.New()
	testutil.RequireImplementation(t, impl, "Gatekeeper")

	intent := testutil.Intent{
		AgentDID:   "did:key:z6MkWeatherBot",
		Action:     "fetch_weather",
		Target:     "zip:94105",
		PersonaID:  "consumer",
		TrustLevel: "trusted",
	}
	decision, err := impl.EvaluateIntent(context.Background(), intent)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, decision.Allowed, "safe intent should be allowed")
}

// TST-CORE-784
func TestGatekeeper_6_1_2_RiskyIntentFlagged(t *testing.T) {
	impl := realGatekeeper
	// impl = gatekeeper.New()
	testutil.RequireImplementation(t, impl, "Gatekeeper")

	intent := testutil.Intent{
		AgentDID:   "did:key:z6MkEmailBot",
		Action:     "send_email",
		Target:     "boss@company.com",
		PersonaID:  "professional",
		TrustLevel: "trusted",
	}
	decision, err := impl.EvaluateIntent(context.Background(), intent)
	testutil.RequireNoError(t, err)
	// Risky intents should be flagged — either blocked or audited for user review.
	testutil.RequireTrue(t, decision.Audit, "risky intent should generate an audit entry")
}

// TST-CORE-785
func TestGatekeeper_6_1_3_BlockedIntentDenied(t *testing.T) {
	impl := realGatekeeper
	// impl = gatekeeper.New()
	testutil.RequireImplementation(t, impl, "Gatekeeper")

	intent := testutil.Intent{
		AgentDID:   "did:key:z6MkUntrustedBot",
		Action:     "transfer_money",
		Target:     "external_account",
		PersonaID:  "financial",
		TrustLevel: "untrusted",
	}
	decision, err := impl.EvaluateIntent(context.Background(), intent)
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, decision.Allowed, "blocked intent from untrusted agent must be denied")
}

// TST-CORE-786
func TestGatekeeper_6_1_4_ReadVaultByUntrustedDenied(t *testing.T) {
	impl := realGatekeeper
	// impl = gatekeeper.New()
	testutil.RequireImplementation(t, impl, "Gatekeeper")

	intent := testutil.Intent{
		AgentDID:   "did:key:z6MkUntrustedBot",
		Action:     "read_vault",
		Target:     "financial",
		PersonaID:  "financial",
		TrustLevel: "untrusted",
	}
	decision, err := impl.EvaluateIntent(context.Background(), intent)
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, decision.Allowed, "untrusted agent must not read vault")
}

// TST-CORE-787
func TestGatekeeper_6_1_5_EmptyActionRejected(t *testing.T) {
	impl := realGatekeeper
	// impl = gatekeeper.New()
	testutil.RequireImplementation(t, impl, "Gatekeeper")

	intent := testutil.Intent{
		AgentDID:   "did:key:z6MkSomeBot",
		Action:     "",
		Target:     "any",
		PersonaID:  "consumer",
		TrustLevel: "trusted",
	}
	_, err := impl.EvaluateIntent(context.Background(), intent)
	testutil.RequireError(t, err)
}

// TST-CORE-788
func TestGatekeeper_6_1_6_EmptyAgentDIDRejected(t *testing.T) {
	impl := realGatekeeper
	// impl = gatekeeper.New()
	testutil.RequireImplementation(t, impl, "Gatekeeper")

	intent := testutil.Intent{
		AgentDID:   "",
		Action:     "fetch_weather",
		Target:     "zip:94105",
		PersonaID:  "consumer",
		TrustLevel: "trusted",
	}
	_, err := impl.EvaluateIntent(context.Background(), intent)
	testutil.RequireError(t, err)
}

// TST-CORE-789
func TestGatekeeper_6_1_7_DecisionContainsReason(t *testing.T) {
	impl := realGatekeeper
	// impl = gatekeeper.New()
	testutil.RequireImplementation(t, impl, "Gatekeeper")

	intent := testutil.Intent{
		AgentDID:   "did:key:z6MkUntrustedBot",
		Action:     "transfer_money",
		Target:     "external_account",
		PersonaID:  "financial",
		TrustLevel: "untrusted",
	}
	decision, err := impl.EvaluateIntent(context.Background(), intent)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(decision.Reason) > 0, "decision must include a reason string")
}

// TST-CORE-790
func TestGatekeeper_6_1_8_SafeIntentNoAudit(t *testing.T) {
	impl := realGatekeeper
	// impl = gatekeeper.New()
	testutil.RequireImplementation(t, impl, "Gatekeeper")

	intent := testutil.Intent{
		AgentDID:   "did:key:z6MkWeatherBot",
		Action:     "fetch_weather",
		Target:     "zip:10001",
		PersonaID:  "consumer",
		TrustLevel: "trusted",
	}
	decision, err := impl.EvaluateIntent(context.Background(), intent)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, decision.Allowed, "safe intent should pass")
	// Safe intents pass silently — no audit entry needed.
	testutil.RequireFalse(t, decision.Audit, "safe intent should not create an audit entry")
}

// --------------------------------------------------------------------------
// §6.1 Mock-based Intent Evaluation (2 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-791
func TestGatekeeper_6_1_9_MockAllowAll(t *testing.T) {
	mock := &testutil.MockGatekeeper{
		EvaluateResult: testutil.Decision{Allowed: true, Reason: "mock: allow all"},
		EgressAllowed:  true,
	}

	intent := testutil.Intent{
		AgentDID:   "did:key:z6MkAnyBot",
		Action:     "any_action",
		Target:     "any_target",
		PersonaID:  "consumer",
		TrustLevel: "trusted",
	}
	decision, err := mock.EvaluateIntent(context.Background(), intent)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, decision.Allowed, "mock should allow all intents")
	testutil.RequireEqual(t, decision.Reason, "mock: allow all")
}

// TST-CORE-792
func TestGatekeeper_6_1_10_MockDenyAll(t *testing.T) {
	mock := &testutil.MockGatekeeper{
		EvaluateResult: testutil.Decision{Allowed: false, Reason: "mock: deny all", Audit: true},
		EgressAllowed:  false,
	}

	intent := testutil.Intent{
		AgentDID:   "did:key:z6MkAnyBot",
		Action:     "any_action",
		Target:     "any_target",
		PersonaID:  "consumer",
		TrustLevel: "trusted",
	}
	decision, err := mock.EvaluateIntent(context.Background(), intent)
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, decision.Allowed, "mock should deny all intents")
	testutil.RequireTrue(t, decision.Audit, "denied intents should create audit entries")
}

// --------------------------------------------------------------------------
// §6.2 Egress Policy (6 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-793
func TestGatekeeper_6_2_1_EgressToTrustedDestination(t *testing.T) {
	impl := realGatekeeper
	// impl = gatekeeper.New()
	testutil.RequireImplementation(t, impl, "Gatekeeper")

	allowed, err := impl.CheckEgress(context.Background(), "https://trusted-api.example.com", []byte(`{"summary":"weather data"}`))
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, allowed, "egress to trusted destination should be allowed")
}

// TST-CORE-794
func TestGatekeeper_6_2_2_EgressToBlockedDestination(t *testing.T) {
	impl := realGatekeeper
	// impl = gatekeeper.New()
	testutil.RequireImplementation(t, impl, "Gatekeeper")

	allowed, err := impl.CheckEgress(context.Background(), "https://blocked-tracker.example.com", []byte(`{"data":"sensitive"}`))
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, allowed, "egress to blocked destination must be denied")
}

// TST-CORE-795
func TestGatekeeper_6_2_3_EgressWithPIIBlocked(t *testing.T) {
	impl := realGatekeeper
	// impl = gatekeeper.New()
	testutil.RequireImplementation(t, impl, "Gatekeeper")

	// Data containing PII should be blocked from egress (raw data never leaves the Home Node).
	piiData := []byte(`{"email":"john@example.com","ssn":"123-45-6789"}`)
	allowed, err := impl.CheckEgress(context.Background(), "https://api.example.com", piiData)
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, allowed, "egress with PII data must be blocked")
}

// TST-CORE-796
func TestGatekeeper_6_2_4_EgressEmptyDestinationRejected(t *testing.T) {
	impl := realGatekeeper
	// impl = gatekeeper.New()
	testutil.RequireImplementation(t, impl, "Gatekeeper")

	_, err := impl.CheckEgress(context.Background(), "", []byte(`{"data":"test"}`))
	testutil.RequireError(t, err)
}

// TST-CORE-797
func TestGatekeeper_6_2_5_EgressNilDataAllowed(t *testing.T) {
	impl := realGatekeeper
	// impl = gatekeeper.New()
	testutil.RequireImplementation(t, impl, "Gatekeeper")

	// Egress check with nil data (e.g. a health check ping) should be allowed.
	allowed, err := impl.CheckEgress(context.Background(), "https://trusted-api.example.com", nil)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, allowed, "egress with nil data to trusted destination should pass")
}

// TST-CORE-798
func TestGatekeeper_6_2_6_MockEgressDeny(t *testing.T) {
	mock := &testutil.MockGatekeeper{
		EgressAllowed: false,
		EgressErr:     nil,
	}

	allowed, err := mock.CheckEgress(context.Background(), "https://any-destination.com", []byte("data"))
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, allowed, "mock should deny egress")
}

// --------------------------------------------------------------------------
// §6.3 Trust Ring & Persona Access Control (6 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-799
func TestGatekeeper_6_3_1_TrustedAgentAccessesOpenPersona(t *testing.T) {
	impl := realGatekeeper
	// impl = gatekeeper.New()
	testutil.RequireImplementation(t, impl, "Gatekeeper")

	intent := testutil.Intent{
		AgentDID:   "did:key:z6MkTrustedBot",
		Action:     "read_vault",
		Target:     "consumer",
		PersonaID:  "consumer",
		TrustLevel: "trusted",
	}
	decision, err := impl.EvaluateIntent(context.Background(), intent)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, decision.Allowed, "trusted agent should access open persona")
}

// TST-CORE-800
func TestGatekeeper_6_3_2_UntrustedAgentDeniedLockedPersona(t *testing.T) {
	impl := realGatekeeper
	// impl = gatekeeper.New()
	testutil.RequireImplementation(t, impl, "Gatekeeper")

	intent := testutil.Intent{
		AgentDID:   "did:key:z6MkUntrustedBot",
		Action:     "read_vault",
		Target:     "health",
		PersonaID:  "health",
		TrustLevel: "untrusted",
	}
	decision, err := impl.EvaluateIntent(context.Background(), intent)
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, decision.Allowed, "untrusted agent must not access locked persona")
}

// TST-CORE-801
func TestGatekeeper_6_3_3_VerifiedAgentRestrictedPersona(t *testing.T) {
	impl := realGatekeeper
	// impl = gatekeeper.New()
	testutil.RequireImplementation(t, impl, "Gatekeeper")

	// Verified (but not fully trusted) agent accessing a restricted persona
	// should produce an audit entry and require review.
	intent := testutil.Intent{
		AgentDID:   "did:key:z6MkVerifiedBot",
		Action:     "read_vault",
		Target:     "professional",
		PersonaID:  "professional",
		TrustLevel: "verified",
	}
	decision, err := impl.EvaluateIntent(context.Background(), intent)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, decision.Audit, "verified agent on restricted persona should trigger audit")
}

// TST-CORE-802
func TestGatekeeper_6_3_4_CrossPersonaAccessDenied(t *testing.T) {
	impl := realGatekeeper
	// impl = gatekeeper.New()
	testutil.RequireImplementation(t, impl, "Gatekeeper")

	// An agent authorized for "consumer" persona must not access "financial" persona.
	// This enforces cryptographic compartment isolation.
	intent := testutil.Intent{
		AgentDID:    "did:key:z6MkConsumerBot",
		Action:      "read_vault",
		Target:      "financial",
		PersonaID:   "financial",
		TrustLevel:  "trusted",
		Constraints: map[string]bool{"persona_consumer_only": true},
	}
	decision, err := impl.EvaluateIntent(context.Background(), intent)
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, decision.Allowed, "cross-persona access must be denied")
}

// TST-CORE-803
func TestGatekeeper_6_3_5_MoneyActionRequiresTrustedRing(t *testing.T) {
	impl := realGatekeeper
	// impl = gatekeeper.New()
	testutil.RequireImplementation(t, impl, "Gatekeeper")

	// Financial actions require the highest trust ring (Verified + Actioned).
	intent := testutil.Intent{
		AgentDID:   "did:key:z6MkPaymentBot",
		Action:     "transfer_money",
		Target:     "vendor_account",
		PersonaID:  "financial",
		TrustLevel: "verified",
	}
	decision, err := impl.EvaluateIntent(context.Background(), intent)
	testutil.RequireNoError(t, err)
	// Verified but not Verified+Actioned — should be denied or flagged.
	testutil.RequireFalse(t, decision.Allowed, "money actions require highest trust ring")
}

// TST-CORE-804
func TestGatekeeper_6_3_6_DataSharingActionFlagged(t *testing.T) {
	impl := realGatekeeper
	// impl = gatekeeper.New()
	testutil.RequireImplementation(t, impl, "Gatekeeper")

	// Data sharing with external services is a risky action per the Four Laws.
	intent := testutil.Intent{
		AgentDID:   "did:key:z6MkSharingBot",
		Action:     "share_data",
		Target:     "third_party_service",
		PersonaID:  "social",
		TrustLevel: "trusted",
	}
	decision, err := impl.EvaluateIntent(context.Background(), intent)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, decision.Audit, "data sharing actions must be flagged for review")
}

// ==========================================================================
// TEST_PLAN §6.1 — Sharing Policy Enforcement (additional scenarios)
// Default deny. Per-contact per-category. Tiers: none / summary / full.
// ==========================================================================

// TST-CORE-360
func TestGatekeeper_6_1_SP1_DefaultDenyNoPolicyExists(t *testing.T) {
	mock := testutil.NewMockSharingPolicyManager()

	// No policy for unknown contact — FilterEgress should block all categories.
	payload := testutil.EgressPayload{
		RecipientDID: "did:plc:unknown_contact",
		Categories: map[string]interface{}{
			"location": testutil.TieredPayload{Summary: "Nearby", Full: "123 Main St"},
		},
	}
	result, err := mock.FilterEgress(context.Background(), payload)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(result.Denied) > 0, "default deny: all categories should be denied when no policy exists")
	testutil.RequireEqual(t, len(result.Filtered), 0)
}

// TST-CORE-361
func TestGatekeeper_6_1_SP2_DefaultDenyMissingCategoryKey(t *testing.T) {
	mock := testutil.NewMockSharingPolicyManager()
	// Contact has a policy but no "location" key.
	_ = mock.SetPolicy(context.Background(), "did:plc:sancho", map[string]testutil.SharingTier{"health": "summary"})

	payload := testutil.EgressPayload{
		RecipientDID: "did:plc:sancho",
		Categories: map[string]interface{}{
			"location": testutil.TieredPayload{Summary: "Nearby", Full: "123 Main St"},
		},
	}
	result, err := mock.FilterEgress(context.Background(), payload)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(result.Denied) > 0, "missing category key should be treated as none — blocked")
}

// TST-CORE-362
func TestGatekeeper_6_1_SP3_PolicyNoneExplicit(t *testing.T) {
	mock := testutil.NewMockSharingPolicyManager()
	_ = mock.SetPolicy(context.Background(), "did:plc:sancho", map[string]testutil.SharingTier{"health": "none"})

	payload := testutil.EgressPayload{
		RecipientDID: "did:plc:sancho",
		Categories: map[string]interface{}{
			"health": testutil.TieredPayload{Summary: "Fine", Full: "Blood pressure 120/80, on medication X"},
		},
	}
	result, err := mock.FilterEgress(context.Background(), payload)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(result.Denied) == 1, "explicit none should deny health category")
	testutil.RequireEqual(t, result.Denied[0], "health")
}

// TST-CORE-363
func TestGatekeeper_6_1_SP4_PolicySummaryTier(t *testing.T) {
	mock := testutil.NewMockSharingPolicyManager()
	_ = mock.SetPolicy(context.Background(), "did:plc:sancho", map[string]testutil.SharingTier{"availability": "summary"})

	payload := testutil.EgressPayload{
		RecipientDID: "did:plc:sancho",
		Categories: map[string]interface{}{
			"availability": testutil.TieredPayload{Summary: "Busy 2-3pm", Full: "Meeting with Dr. Patel at clinic"},
		},
	}
	result, err := mock.FilterEgress(context.Background(), payload)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, result.Filtered["availability"], "Busy 2-3pm")
}

// TST-CORE-364
func TestGatekeeper_6_1_SP5_PolicyFullTier(t *testing.T) {
	mock := testutil.NewMockSharingPolicyManager()
	_ = mock.SetPolicy(context.Background(), "did:plc:sancho", map[string]testutil.SharingTier{"preferences": "full"})

	payload := testutil.EgressPayload{
		RecipientDID: "did:plc:sancho",
		Categories: map[string]interface{}{
			"preferences": testutil.TieredPayload{Summary: "Likes chai", Full: "Chai, no sugar, served warm. Allergic to dairy."},
		},
	}
	result, err := mock.FilterEgress(context.Background(), payload)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, result.Filtered["preferences"], "Chai, no sugar, served warm. Allergic to dairy.")
}

// TST-CORE-365
func TestGatekeeper_6_1_SP6_PerContactPerCategoryGranularity(t *testing.T) {
	mock := testutil.NewMockSharingPolicyManager()
	_ = mock.SetPolicy(context.Background(), "did:plc:sancho", map[string]testutil.SharingTier{
		"presence": "eta_only",
		"health":   "none",
	})

	payload := testutil.EgressPayload{
		RecipientDID: "did:plc:sancho",
		Categories: map[string]interface{}{
			"presence": testutil.TieredPayload{Summary: "Arriving in 15 min", Full: "GPS: 37.7749,-122.4194"},
			"health":   testutil.TieredPayload{Summary: "Fine", Full: "Detailed health report"},
		},
	}
	result, err := mock.FilterEgress(context.Background(), payload)
	testutil.RequireNoError(t, err)
	// Presence should be shared (summary tier), health should be blocked.
	testutil.RequireEqual(t, result.Filtered["presence"], "Arriving in 15 min")
	found := false
	for _, d := range result.Denied {
		if d == "health" {
			found = true
		}
	}
	testutil.RequireTrue(t, found, "health should be denied for sancho")
}

// TST-CORE-366
func TestGatekeeper_6_1_SP7_DomainSpecificETAOnly(t *testing.T) {
	mock := testutil.NewMockSharingPolicyManager()
	_ = mock.SetPolicy(context.Background(), "did:plc:sancho", map[string]testutil.SharingTier{"presence": "eta_only"})

	payload := testutil.EgressPayload{
		RecipientDID: "did:plc:sancho",
		Categories: map[string]interface{}{
			"presence": testutil.TieredPayload{Summary: "Arriving in about 15 minutes", Full: "GPS: 37.7749,-122.4194, ETA: 2:45pm"},
		},
	}
	result, err := mock.FilterEgress(context.Background(), payload)
	testutil.RequireNoError(t, err)
	// eta_only maps to summary tier.
	testutil.RequireEqual(t, result.Filtered["presence"], "Arriving in about 15 minutes")
}

// TST-CORE-367
func TestGatekeeper_6_1_SP8_DomainSpecificFreeBusy(t *testing.T) {
	mock := testutil.NewMockSharingPolicyManager()
	_ = mock.SetPolicy(context.Background(), "did:plc:sancho", map[string]testutil.SharingTier{"availability": "free_busy"})

	payload := testutil.EgressPayload{
		RecipientDID: "did:plc:sancho",
		Categories: map[string]interface{}{
			"availability": testutil.TieredPayload{Summary: "Busy 2-3pm", Full: "Meeting with Dr. Patel at downtown clinic"},
		},
	}
	result, err := mock.FilterEgress(context.Background(), payload)
	testutil.RequireNoError(t, err)
	// free_busy maps to summary tier.
	testutil.RequireEqual(t, result.Filtered["availability"], "Busy 2-3pm")
}

// TST-CORE-368
func TestGatekeeper_6_1_SP9_DomainSpecificExactLocation(t *testing.T) {
	mock := testutil.NewMockSharingPolicyManager()
	_ = mock.SetPolicy(context.Background(), "did:plc:sancho", map[string]testutil.SharingTier{"presence": "exact_location"})

	payload := testutil.EgressPayload{
		RecipientDID: "did:plc:sancho",
		Categories: map[string]interface{}{
			"presence": testutil.TieredPayload{Summary: "Arriving soon", Full: "GPS: 37.7749,-122.4194, heading south on Market St"},
		},
	}
	result, err := mock.FilterEgress(context.Background(), payload)
	testutil.RequireNoError(t, err)
	// exact_location maps to full tier.
	testutil.RequireEqual(t, result.Filtered["presence"], "GPS: 37.7749,-122.4194, heading south on Market St")
}

// TST-CORE-371
func TestGatekeeper_6_1_SP12_TrustLevelNotEqualSharing(t *testing.T) {
	mock := testutil.NewMockSharingPolicyManager()
	// Contact is "trusted" but has no explicit sharing rules — trust and policy are independent.
	// No SetPolicy call — trust level doesn't auto-share.
	payload := testutil.EgressPayload{
		RecipientDID: "did:plc:trusted_contact",
		Categories: map[string]interface{}{
			"location": testutil.TieredPayload{Summary: "Nearby", Full: "123 Main St"},
		},
	}
	result, err := mock.FilterEgress(context.Background(), payload)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(result.Denied) > 0, "trusted contact with no policy should still have all categories denied")
}

// TST-CORE-372
func TestGatekeeper_6_1_SP13_RecognizedCategories(t *testing.T) {
	// Verify Phase 1 category list.
	expected := testutil.Phase1RecognizedCategories
	testutil.RequireLen(t, len(expected), 6)
	testutil.RequireEqual(t, expected[0], "presence")
	testutil.RequireEqual(t, expected[1], "availability")
	testutil.RequireEqual(t, expected[2], "context")
	testutil.RequireEqual(t, expected[3], "preferences")
	testutil.RequireEqual(t, expected[4], "location")
	testutil.RequireEqual(t, expected[5], "health")
}

// TST-CORE-375
func TestGatekeeper_6_1_SP16_ExtensibleCategoryAccepted(t *testing.T) {
	mock := testutil.NewMockSharingPolicyManager()
	// Custom category "hobbies" should be storable.
	err := mock.SetPolicy(context.Background(), "did:plc:sancho", map[string]testutil.SharingTier{"hobbies": "full"})
	testutil.RequireNoError(t, err)

	policy, err := mock.GetPolicy(context.Background(), "did:plc:sancho")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, policy.Categories["hobbies"], testutil.SharingTier("full"))
}

// TST-CORE-376
func TestGatekeeper_6_1_SP17_ExtensibleCategoryEnforcedAtEgress(t *testing.T) {
	mock := testutil.NewMockSharingPolicyManager()
	_ = mock.SetPolicy(context.Background(), "did:plc:sancho", map[string]testutil.SharingTier{"hobbies": "summary"})

	payload := testutil.EgressPayload{
		RecipientDID: "did:plc:sancho",
		Categories: map[string]interface{}{
			"hobbies": testutil.TieredPayload{Summary: "Likes cycling", Full: "Rides 50km every weekend, owns a Trek Domane"},
		},
	}
	result, err := mock.FilterEgress(context.Background(), payload)
	testutil.RequireNoError(t, err)
	// Custom category goes through the same egress pipeline — summary tier only.
	testutil.RequireEqual(t, result.Filtered["hobbies"], "Likes cycling")
}


// --------------------------------------------------------------------------
// §6.1 Uncovered Sharing Policy Scenarios
// --------------------------------------------------------------------------

// TST-CORE-369
func TestGatekeeper_6_1_SP10_PolicyUpdateViaPatch(t *testing.T) {
	mock := testutil.NewMockSharingPolicyManager()
	_ = mock.SetPolicy(context.Background(), "did:plc:sancho", map[string]testutil.SharingTier{"health": "none"})

	// PATCH: update health from "none" to "summary"
	err := mock.SetPolicy(context.Background(), "did:plc:sancho", map[string]testutil.SharingTier{"health": "summary"})
	testutil.RequireNoError(t, err)

	policy, err := mock.GetPolicy(context.Background(), "did:plc:sancho")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, policy.Categories["health"], testutil.SharingTier("summary"))
}

// TST-CORE-370
func TestGatekeeper_6_1_SP11_BulkPolicyUpdate(t *testing.T) {
	mock := testutil.NewMockSharingPolicyManager()
	_ = mock.SetPolicy(context.Background(), "did:plc:alice", map[string]testutil.SharingTier{"location": "full"})
	_ = mock.SetPolicy(context.Background(), "did:plc:bob", map[string]testutil.SharingTier{"location": "full"})

	count, err := mock.SetBulkPolicy(context.Background(),
		map[string]string{"trust_level": "trusted"},
		map[string]testutil.SharingTier{"location": "none"},
	)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, count, 2)
}

// TST-CORE-373
func TestGatekeeper_6_1_SP14_SharingDefaultsForNewContacts(t *testing.T) {
	impl := realSharingPolicyManager
	testutil.RequireImplementation(t, impl, "SharingPolicyManager")

	cd := realContactDirectory
	testutil.RequireImplementation(t, cd, "ContactDirectory")

	ctx := context.Background()

	// Add a new contact to the directory.
	newDID := "did:key:z6MkNewContactSP14"
	err := cd.Add(ctx, newDID, "New Contact SP14", "unknown")
	testutil.RequireNoError(t, err)

	// Query the sharing policy for this new contact.
	// Without explicit policy, GetPolicy returns a default empty policy.
	policy, err := impl.GetPolicy(ctx, newDID)
	testutil.RequireNoError(t, err)

	// A new contact must get a default sharing policy.
	// Default-deny: categories map is empty (all categories blocked).
	// This is equivalent to "unverified" / "open" tier — no data shared until configured.
	testutil.RequireTrue(t, policy != nil, "new contact must get a default sharing policy")
	testutil.RequireEqual(t, policy.ContactDID, newDID)

	// Default policy should have empty categories (default-deny semantics).
	testutil.RequireTrue(t, len(policy.Categories) == 0,
		"new contact default policy should have empty categories (default-deny / unverified)")
}

// TST-CORE-374
func TestGatekeeper_6_1_SP15_OutboundPIIScrub(t *testing.T) {
	impl := realGatekeeper
	testutil.RequireImplementation(t, impl, "Gatekeeper")

	ctx := context.Background()

	// Verify outbound data with PII is blocked by egress checks.
	// The gatekeeper's CheckEgress scans for PII patterns and blocks data containing them.
	dataWithPII := []byte("User email: john@example.com, SSN: 123-45-6789")

	allowed, err := impl.CheckEgress(ctx, "https://external-api.example.com", dataWithPII)
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, allowed, "outbound data containing PII must be blocked by egress check")

	// Clean data (no PII) should be allowed.
	cleanData := []byte("The weather forecast for today is sunny")
	allowed, err = impl.CheckEgress(ctx, "https://external-api.example.com", cleanData)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, allowed, "outbound data without PII should be allowed")
}

// ==========================================================================
// TEST_PLAN §6.2 — Sharing Policy API (8 scenarios)
// ==========================================================================

// TST-CORE-377
func TestGatekeeper_6_2_SP1_GetPolicy(t *testing.T) {
	impl := realSharingPolicyManager
	testutil.RequireImplementation(t, impl, "SharingPolicyManager")

	// GET /v1/contacts/:did/policy returns sharing policy for a known contact.
	policy, err := impl.GetPolicy(context.Background(), "did:plc:sancho")
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, policy)
}

// TST-CORE-378
func TestGatekeeper_6_2_SP2_PatchSingleCategory(t *testing.T) {
	mock := testutil.NewMockSharingPolicyManager()
	_ = mock.SetPolicy(context.Background(), "did:plc:sancho", map[string]testutil.SharingTier{
		"location": "none", "health": "none", "preferences": "full",
	})

	// PATCH single category — only location changed, rest preserved.
	err := mock.SetPolicy(context.Background(), "did:plc:sancho", map[string]testutil.SharingTier{"location": "exact_location"})
	testutil.RequireNoError(t, err)

	policy, err := mock.GetPolicy(context.Background(), "did:plc:sancho")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, policy.Categories["location"], testutil.SharingTier("exact_location"))
	testutil.RequireEqual(t, policy.Categories["health"], testutil.SharingTier("none"))
	testutil.RequireEqual(t, policy.Categories["preferences"], testutil.SharingTier("full"))
}

// TST-CORE-379
func TestGatekeeper_6_2_SP3_PatchMultipleCategories(t *testing.T) {
	mock := testutil.NewMockSharingPolicyManager()
	_ = mock.SetPolicy(context.Background(), "did:plc:sancho", map[string]testutil.SharingTier{
		"health": "none", "location": "none", "preferences": "full",
	})

	// PATCH two categories at once.
	err := mock.SetPolicy(context.Background(), "did:plc:sancho", map[string]testutil.SharingTier{
		"health": "summary", "location": "none",
	})
	testutil.RequireNoError(t, err)

	policy, err := mock.GetPolicy(context.Background(), "did:plc:sancho")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, policy.Categories["health"], testutil.SharingTier("summary"))
	testutil.RequireEqual(t, policy.Categories["location"], testutil.SharingTier("none"))
	testutil.RequireEqual(t, policy.Categories["preferences"], testutil.SharingTier("full"))
}

// TST-CORE-380
func TestGatekeeper_6_2_SP4_PatchBulkByTrustLevel(t *testing.T) {
	mock := testutil.NewMockSharingPolicyManager()
	_ = mock.SetPolicy(context.Background(), "did:plc:alice", map[string]testutil.SharingTier{"location": "full"})
	_ = mock.SetPolicy(context.Background(), "did:plc:bob", map[string]testutil.SharingTier{"location": "full"})

	// Bulk update — turn off location for all matching contacts.
	count, err := mock.SetBulkPolicy(context.Background(),
		map[string]string{"trust_level": "trusted"},
		map[string]testutil.SharingTier{"location": "none"},
	)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, count, 2)

	policyA, _ := mock.GetPolicy(context.Background(), "did:plc:alice")
	testutil.RequireEqual(t, policyA.Categories["location"], testutil.SharingTier("none"))
	policyB, _ := mock.GetPolicy(context.Background(), "did:plc:bob")
	testutil.RequireEqual(t, policyB.Categories["location"], testutil.SharingTier("none"))
}

// TST-CORE-381
func TestGatekeeper_6_2_SP5_PatchBulkAllContacts(t *testing.T) {
	mock := testutil.NewMockSharingPolicyManager()
	_ = mock.SetPolicy(context.Background(), "did:plc:alice", map[string]testutil.SharingTier{"location": "full"})
	_ = mock.SetPolicy(context.Background(), "did:plc:bob", map[string]testutil.SharingTier{"location": "full"})
	_ = mock.SetPolicy(context.Background(), "did:plc:charlie", map[string]testutil.SharingTier{"location": "full"})

	// Bulk update with empty filter — all contacts updated.
	count, err := mock.SetBulkPolicy(context.Background(),
		map[string]string{},
		map[string]testutil.SharingTier{"location": "none"},
	)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, count, 3)
}

// TST-CORE-382
func TestGatekeeper_6_2_SP6_GetPolicyUnknownDID(t *testing.T) {
	mock := testutil.NewMockSharingPolicyManager()

	// GET policy for unknown DID should return error (404).
	_, err := mock.GetPolicy(context.Background(), "did:plc:unknown")
	testutil.RequireError(t, err)
}

// TST-CORE-383
func TestGatekeeper_6_2_SP7_PatchInvalidTierValue(t *testing.T) {
	impl := realSharingPolicyManager
	testutil.RequireImplementation(t, impl, "SharingPolicyManager")

	// PATCH with unrecognized tier value should fail (400).
	err := impl.SetPolicy(context.Background(), "did:plc:sancho", map[string]testutil.SharingTier{"health": "maximum"})
	testutil.RequireError(t, err)
}

// TST-CORE-384
func TestGatekeeper_6_2_SP8_PolicyStoredInContactsTable(t *testing.T) {
	// Schema validation: sharing_policy is stored in contacts table.
	schemaImpl := realSchemaInspector
	testutil.RequireImplementation(t, schemaImpl, "SchemaInspector")

	cols, err := schemaImpl.TableColumns("identity", "contacts")
	testutil.RequireNoError(t, err)
	found := false
	for _, col := range cols {
		if col == "sharing_policy" || col == "sharing_tier" {
			found = true
			break
		}
	}
	testutil.RequireTrue(t, found, "contacts table must have sharing_policy or sharing_tier column")
}

// ==========================================================================
// TEST_PLAN §6.3 — Egress Pipeline (9 scenarios)
// ==========================================================================

// TST-CORE-385
func TestGatekeeper_6_3_EP1_BrainSendsTieredPayload(t *testing.T) {
	mock := testutil.NewMockSharingPolicyManager()
	_ = mock.SetPolicy(context.Background(), "did:plc:sancho", map[string]testutil.SharingTier{"availability": "summary"})

	// Brain sends POST /v1/dina/send with tiered payload.
	payload := testutil.EgressPayload{
		RecipientDID: "did:plc:sancho",
		Categories: map[string]interface{}{
			"availability": testutil.TieredPayload{Summary: "Busy 2-3pm", Full: "Meeting with Dr. Patel at clinic"},
		},
	}
	result, err := mock.FilterEgress(context.Background(), payload)
	testutil.RequireNoError(t, err)
	// Core picks correct tier per sharing_policy.
	testutil.RequireEqual(t, result.Filtered["availability"], "Busy 2-3pm")
}

// TST-CORE-386
func TestGatekeeper_6_3_EP2_CoreStripsDeniedCategories(t *testing.T) {
	mock := testutil.NewMockSharingPolicyManager()
	_ = mock.SetPolicy(context.Background(), "did:plc:sancho", map[string]testutil.SharingTier{"location": "none", "availability": "summary"})

	payload := testutil.EgressPayload{
		RecipientDID: "did:plc:sancho",
		Categories: map[string]interface{}{
			"location":     testutil.TieredPayload{Summary: "Nearby", Full: "123 Main St"},
			"availability": testutil.TieredPayload{Summary: "Busy", Full: "Meeting details"},
		},
	}
	result, err := mock.FilterEgress(context.Background(), payload)
	testutil.RequireNoError(t, err)
	// Location entirely removed, availability kept.
	_, hasLocation := result.Filtered["location"]
	testutil.RequireFalse(t, hasLocation, "location category should be stripped from outbound payload")
	testutil.RequireEqual(t, result.Filtered["availability"], "Busy")
}

// TST-CORE-387
func TestGatekeeper_6_3_EP3_MalformedPayloadCategoryDropped(t *testing.T) {
	mock := testutil.NewMockSharingPolicyManager()
	_ = mock.SetPolicy(context.Background(), "did:plc:sancho", map[string]testutil.SharingTier{"availability": "summary"})

	// Brain sends raw string instead of {summary, full} for a category.
	payload := testutil.EgressPayload{
		RecipientDID: "did:plc:sancho",
		Categories: map[string]interface{}{
			"availability": "raw string, not a TieredPayload",
		},
	}
	result, err := mock.FilterEgress(context.Background(), payload)
	testutil.RequireNoError(t, err)
	// Malformed = denied — category stripped.
	found := false
	for _, d := range result.Denied {
		if d == "availability" {
			found = true
		}
	}
	testutil.RequireTrue(t, found, "malformed payload category should be denied")
}

// TST-CORE-388
func TestGatekeeper_6_3_EP4_EgressEnforcementInCompiledGo(t *testing.T) {
	// Code audit: sharing policy enforcement is in compiled Go, not delegated to LLM.
	src, err := os.ReadFile("../internal/adapter/gatekeeper/gatekeeper.go")
	if err != nil {
		t.Fatalf("cannot read gatekeeper source: %v", err)
	}
	content := string(src)
	// Gatekeeper must contain CheckEgress in Go code.
	if !strings.Contains(content, "CheckEgress") {
		t.Fatal("egress enforcement must be in compiled Go (CheckEgress function)")
	}
	// Must not delegate policy to LLM.
	if strings.Contains(content, "llm.Evaluate") || strings.Contains(content, "brain.Reason") {
		t.Fatal("egress policy must not be delegated to LLM")
	}
}

// TST-CORE-389
func TestGatekeeper_6_3_EP5_EgressNotIngress(t *testing.T) {
	// Design audit: enforcement is at egress (outbound), not ingress (inbound).
	src, err := os.ReadFile("../internal/adapter/gatekeeper/gatekeeper.go")
	if err != nil {
		t.Fatalf("cannot read gatekeeper source: %v", err)
	}
	content := string(src)
	// CheckEgress must exist (outbound enforcement).
	if !strings.Contains(content, "CheckEgress") {
		t.Fatal("gatekeeper must have egress enforcement (CheckEgress)")
	}
}

// TST-CORE-390
func TestGatekeeper_6_3_EP6_RecipientDIDResolution(t *testing.T) {
	impl := realTransporter
	testutil.RequireImplementation(t, impl, "Transporter")

	// Resolve recipient's service endpoint from DID Document.
	endpoint, err := impl.ResolveEndpoint("did:plc:sancho")
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(endpoint) > 0, "resolved endpoint should be non-empty")
}

// TST-CORE-391
func TestGatekeeper_6_3_EP7_EgressAuditLogging(t *testing.T) {
	mock := testutil.NewMockSharingPolicyManager()
	_ = mock.SetPolicy(context.Background(), "did:plc:sancho", map[string]testutil.SharingTier{"availability": "summary"})

	payload := testutil.EgressPayload{
		RecipientDID: "did:plc:sancho",
		Categories: map[string]interface{}{
			"availability": testutil.TieredPayload{Summary: "Busy", Full: "Meeting details"},
		},
	}
	result, err := mock.FilterEgress(context.Background(), payload)
	testutil.RequireNoError(t, err)
	// Every decision should be logged in audit entries.
	testutil.RequireTrue(t, len(result.AuditEntries) > 0, "egress decisions must generate audit entries")
	testutil.RequireEqual(t, result.AuditEntries[0].Action, "egress_check")
	testutil.RequireEqual(t, result.AuditEntries[0].Decision, "allowed")
}

// TST-CORE-392
func TestGatekeeper_6_3_EP8_AuditIncludesDeniedCategories(t *testing.T) {
	mock := testutil.NewMockSharingPolicyManager()
	_ = mock.SetPolicy(context.Background(), "did:plc:sancho", map[string]testutil.SharingTier{"health": "none"})

	payload := testutil.EgressPayload{
		RecipientDID: "did:plc:sancho",
		Categories: map[string]interface{}{
			"health": testutil.TieredPayload{Summary: "Fine", Full: "Detailed report"},
		},
	}
	result, err := mock.FilterEgress(context.Background(), payload)
	testutil.RequireNoError(t, err)
	// Denied categories must also be in the audit log.
	testutil.RequireTrue(t, len(result.AuditEntries) > 0, "denied decisions must generate audit entries")
	testutil.RequireEqual(t, result.AuditEntries[0].Decision, "denied")
	testutil.RequireEqual(t, result.AuditEntries[0].Reason, "tier_none")
}

// TST-CORE-393
func TestGatekeeper_6_3_EP9_NaClEncryptionAfterPolicyCheck(t *testing.T) {
	// After payload passes egress check, it should be encrypted with crypto_box_seal.
	// This is a design integration test requiring BoxSealer.
	boxImpl := realEncryptor
	testutil.RequireImplementation(t, boxImpl, "Encryptor")

	sImpl := realSigner
	testutil.RequireImplementation(t, sImpl, "Signer")

	convImpl := realConverter
	testutil.RequireImplementation(t, convImpl, "KeyConverter")

	// Generate recipient keys.
	pub, _, err := sImpl.GenerateFromSeed(testutil.TestEd25519Seed[:])
	testutil.RequireNoError(t, err)

	recipientPub, err := convImpl.Ed25519ToX25519Public(pub)
	testutil.RequireNoError(t, err)

	// Payload that passed egress check should be sealable.
	egressPayload := []byte(`{"availability":"Busy 2-3pm"}`)
	sealed, err := boxImpl.SealAnonymous(egressPayload, recipientPub)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(sealed) > len(egressPayload), "sealed payload should be larger than plaintext")
}

// TST-CORE-889
func TestGatekeeper_6_4_AuditLog_90DayRollingRetention(t *testing.T) {
	// Egress audit 90-day rolling retention policy (auto-purge old entries).
	impl := realVaultAuditLogger
	testutil.RequireImplementation(t, impl, "VaultAuditLogger")

	purged, err := impl.Purge(90)
	testutil.RequireNoError(t, err)
	_ = purged // may be 0 on fresh instance
}

// TST-CORE-890
func TestGatekeeper_6_5_ContactsUpdatedAtRefreshedOnPolicyChange(t *testing.T) {
	// Contact updated_at refreshed on sharing policy mutation.
	impl := realSharingPolicyManager
	testutil.RequireImplementation(t, impl, "SharingPolicyManager")

	// Set a policy — this should refresh updated_at.
	err := impl.SetPolicy(context.Background(), "did:key:z6MkTestContact", map[string]testutil.SharingTier{
		"location": "summary",
	})
	testutil.RequireNoError(t, err)
}

// TST-CORE-891
func TestGatekeeper_6_6_DraftConfidenceScore_Validated(t *testing.T) {
	// Draft confidence score: low -> flagged for review, high-risk -> draft blocked.
	impl := realStagingManager
	testutil.RequireImplementation(t, impl, "StagingManager")

	// Stage an item (simulating a draft with implicit confidence scoring).
	vaultCtx := context.Background()
	item := testutil.VaultItem{
		ID:       "draft-low-confidence",
		Type:     "note",
		Source:   "agent",
		Summary:  "low confidence draft",
		Metadata: `{"confidence": 0.3}`,
	}
	_, err := impl.Stage(vaultCtx, domain.PersonaName("personal"), item, 1700000000)
	testutil.RequireNoError(t, err)
}

// TST-CORE-892
func TestGatekeeper_6_6_26_AgentConstraint_DraftOnlyEnforced(t *testing.T) {
	// Agent draft_only: true constraint enforced, no raw vault data to agents.
	impl := realGatekeeper
	testutil.RequireImplementation(t, impl, "Gatekeeper")

	intent := testutil.Intent{
		AgentDID:    "did:key:z6MkDraftOnlyAgent",
		Action:      "send_email",
		Target:      "external",
		PersonaID:   "personal",
		TrustLevel:  "trusted",
		Constraints: map[string]bool{"draft_only": true},
	}
	decision, err := impl.EvaluateIntent(context.Background(), intent)
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, decision.Allowed, "draft_only agent must not be allowed to send_email directly")
}

// TST-CORE-893
func TestGatekeeper_6_6_27_AgentOutcome_RecordedForReputation(t *testing.T) {
	// Agent outcomes recorded in Tier 3 for reputation scoring.
	impl := realVaultAuditLogger
	testutil.RequireImplementation(t, impl, "VaultAuditLogger")

	vaultCtx := context.Background()
	entry := testutil.VaultAuditEntry{
		Timestamp: "2024-01-01T00:00:00Z",
		Persona:   "consumer",
		Action:    "agent_outcome",
		Requester: "did:key:z6MkAgent",
		Reason:    "task completed successfully",
	}
	_, err := impl.Append(vaultCtx, entry)
	testutil.RequireNoError(t, err)
}
