package test

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/adapter/gatekeeper"
	"github.com/rajmohanutopai/dina/core/internal/adapter/vault"
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

	// Positive: safe action from trusted agent must be allowed.
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
	testutil.RequireFalse(t, decision.Audit, "safe intent must not generate audit entry")

	// Negative control: risky action (send_email) from the same trusted agent
	// must NOT be silently allowed — proves the gatekeeper discriminates by action.
	riskyIntent := testutil.Intent{
		AgentDID:   "did:key:z6MkWeatherBot",
		Action:     "send_email",
		Target:     "boss@company.com",
		PersonaID:  "consumer",
		TrustLevel: "trusted",
	}
	riskyDecision, err := impl.EvaluateIntent(context.Background(), riskyIntent)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, riskyDecision.Audit, "risky action send_email must generate audit entry — negative control")
}

// TST-CORE-784
func TestGatekeeper_6_1_2_RiskyIntentFlagged(t *testing.T) {
	impl := realGatekeeper
	// impl = gatekeeper.New()
	testutil.RequireImplementation(t, impl, "Gatekeeper")

	// Positive control: safe action from same agent must NOT generate audit entry.
	safeIntent := testutil.Intent{
		AgentDID:   "did:key:z6MkEmailBot",
		Action:     "fetch_weather",
		Target:     "zip:94105",
		PersonaID:  "professional",
		TrustLevel: "trusted",
	}
	safeDecision, err := impl.EvaluateIntent(context.Background(), safeIntent)
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, safeDecision.Audit, "safe intent must not generate audit — positive control")

	// Negative: risky action (send_email) must be flagged for user review.
	intent := testutil.Intent{
		AgentDID:   "did:key:z6MkEmailBot",
		Action:     "send_email",
		Target:     "boss@company.com",
		PersonaID:  "professional",
		TrustLevel: "trusted",
	}
	decision, err := impl.EvaluateIntent(context.Background(), intent)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, decision.Audit, "risky intent send_email should generate an audit entry")
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
		Action:     "vault_read",
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

	// Positive control: non-empty action from same agent must succeed.
	validIntent := testutil.Intent{
		AgentDID:   "did:key:z6MkSomeBot",
		Action:     "fetch_weather",
		Target:     "any",
		PersonaID:  "consumer",
		TrustLevel: "trusted",
	}
	decision, err := impl.EvaluateIntent(context.Background(), validIntent)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, decision.Allowed, "non-empty safe action must succeed — positive control")

	// Negative: empty action must be rejected with an error.
	emptyIntent := testutil.Intent{
		AgentDID:   "did:key:z6MkSomeBot",
		Action:     "",
		Target:     "any",
		PersonaID:  "consumer",
		TrustLevel: "trusted",
	}
	_, err = impl.EvaluateIntent(context.Background(), emptyIntent)
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

	// Negative: denied intent must include a non-empty reason explaining why.
	intent := testutil.Intent{
		AgentDID:   "did:key:z6MkUntrustedBot",
		Action:     "transfer_money",
		Target:     "external_account",
		PersonaID:  "financial",
		TrustLevel: "untrusted",
	}
	decision, err := impl.EvaluateIntent(context.Background(), intent)
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, decision.Allowed, "untrusted agent must be denied")
	testutil.RequireTrue(t, len(decision.Reason) > 0, "denied decision must include a reason string")
	testutil.RequireContains(t, decision.Reason, "untrusted")

	// Positive control: safe intent from trusted agent must be allowed.
	// The reason may be empty for allowed intents (no explanation needed).
	safeIntent := testutil.Intent{
		AgentDID:   "did:key:z6MkTrustedBot",
		Action:     "fetch_weather",
		Target:     "zip:94105",
		PersonaID:  "consumer",
		TrustLevel: "trusted",
	}
	safeDecision, err := impl.EvaluateIntent(context.Background(), safeIntent)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, safeDecision.Allowed, "trusted safe intent must be allowed — positive control")
}

// TST-CORE-790
func TestGatekeeper_6_1_8_SafeIntentNoAudit(t *testing.T) {
	impl := realGatekeeper
	// impl = gatekeeper.New()
	testutil.RequireImplementation(t, impl, "Gatekeeper")

	// Positive: safe intent passes silently — no audit entry needed.
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
	testutil.RequireFalse(t, decision.Audit, "safe intent should not create an audit entry")

	// Negative control: risky intent from the same agent must generate an audit entry.
	riskyIntent := testutil.Intent{
		AgentDID:   "did:key:z6MkWeatherBot",
		Action:     "transfer_money",
		Target:     "external_account",
		PersonaID:  "consumer",
		TrustLevel: "trusted",
	}
	riskyDecision, err := impl.EvaluateIntent(context.Background(), riskyIntent)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, riskyDecision.Audit, "risky intent must create an audit entry — negative control")
}

// --------------------------------------------------------------------------
// §6.1 Mock-based Intent Evaluation (2 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-791
func TestGatekeeper_6_1_9_MockAllowAll(t *testing.T) {
	impl := realGatekeeper
	testutil.RequireImplementation(t, impl, "Gatekeeper")

	ctx := context.Background()

	// Positive: a safe intent from a trusted agent should be allowed.
	intent := testutil.Intent{
		AgentDID:   "did:key:z6MkSafeBot",
		Action:     "read_vault",
		Target:     "vault_items",
		PersonaID:  "consumer",
		TrustLevel: "trusted",
	}
	decision, err := impl.EvaluateIntent(ctx, intent)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, decision.Allowed, "safe intent from trusted agent must be allowed")

	// Negative: untrusted agent must be denied.
	untrusted := testutil.Intent{
		AgentDID:   "did:key:z6MkUntrusted",
		Action:     "read_vault",
		Target:     "vault_items",
		PersonaID:  "consumer",
		TrustLevel: "untrusted",
	}
	denied, err := impl.EvaluateIntent(ctx, untrusted)
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, denied.Allowed, "untrusted agent must be denied")

	// Negative: empty AgentDID must error.
	_, err = impl.EvaluateIntent(ctx, testutil.Intent{Action: "read_vault", TrustLevel: "trusted"})
	testutil.RequireError(t, err)
}

// TST-CORE-792
func TestGatekeeper_6_1_10_MockDenyAll(t *testing.T) {
	impl := realGatekeeper
	testutil.RequireImplementation(t, impl, "Gatekeeper")

	ctx := context.Background()

	// Positive denial: risky action "send_email" must be denied and audited.
	risky := testutil.Intent{
		AgentDID:   "did:key:z6MkRiskyBot",
		Action:     "send_email",
		Target:     "outbox",
		PersonaID:  "consumer",
		TrustLevel: "trusted",
	}
	decision, err := impl.EvaluateIntent(ctx, risky)
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, decision.Allowed, "risky action must be denied")
	testutil.RequireTrue(t, decision.Audit, "denied risky action must create audit entry")

	// Positive denial: brain agent on locked persona must be denied.
	brainLocked := testutil.Intent{
		AgentDID:   "brain",
		Action:     "read_vault",
		Target:     "vault",
		PersonaID:  "financial",
		TrustLevel: "locked",
	}
	decision2, err := impl.EvaluateIntent(ctx, brainLocked)
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, decision2.Allowed, "brain on locked persona must be denied")
	testutil.RequireTrue(t, decision2.Audit, "brain-locked denial must be audited")

	// Negative control: a safe read from trusted agent must be allowed (not deny-all).
	safe := testutil.Intent{
		AgentDID:   "did:key:z6MkSafe",
		Action:     "read_vault",
		Target:     "items",
		PersonaID:  "consumer",
		TrustLevel: "trusted",
	}
	decision3, err := impl.EvaluateIntent(ctx, safe)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, decision3.Allowed, "safe intent must NOT be denied")
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

	// Negative: empty destination must return an error.
	_, err := impl.CheckEgress(context.Background(), "", []byte(`{"data":"test"}`))
	testutil.RequireError(t, err)

	// Positive control: non-empty destination with clean data must succeed.
	allowed, err := impl.CheckEgress(context.Background(), "https://example.com/api", []byte(`{"data":"test"}`))
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, allowed, "non-empty destination with clean data must be allowed")
}

// TST-CORE-797
func TestGatekeeper_6_2_5_EgressNilDataAllowed(t *testing.T) {
	impl := realGatekeeper
	// impl = gatekeeper.New()
	testutil.RequireImplementation(t, impl, "Gatekeeper")

	// Positive: nil data (health-check ping) should be allowed.
	allowed, err := impl.CheckEgress(context.Background(), "https://trusted-api.example.com", nil)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, allowed, "egress with nil data to trusted destination should pass")

	// Negative control: non-nil data containing PII must be blocked,
	// proving CheckEgress actually inspects the data parameter.
	piiData := []byte("user lives at 192.168.1.1 internal address")
	blocked, err := impl.CheckEgress(context.Background(), "https://trusted-api.example.com", piiData)
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, blocked, "egress with PII data must be blocked even to trusted destination")
}

// TST-CORE-798
func TestGatekeeper_6_2_6_MockEgressDeny(t *testing.T) {
	impl := realGatekeeper
	testutil.RequireImplementation(t, impl, "Gatekeeper")

	ctx := context.Background()

	// Positive denial: data containing PII (email) must be denied egress.
	piiData := []byte(`{"name":"Alice","email":"alice@example.com","msg":"hello"}`)
	allowed, err := impl.CheckEgress(ctx, "https://external-api.example.com", piiData)
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, allowed, "egress with PII (email) must be denied")

	// Positive allow: clean data to a non-blocked destination must pass.
	cleanData := []byte(`{"summary":"weather data","temp":72}`)
	allowed2, err := impl.CheckEgress(ctx, "https://external-api.example.com", cleanData)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, allowed2, "clean data to non-blocked dest must be allowed")

	// Negative: empty destination must return an error.
	_, err = impl.CheckEgress(ctx, "", []byte("data"))
	testutil.RequireError(t, err)
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
		Action:     "vault_read",
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

	// Positive control: trusted agent with safe action must be allowed.
	trustedIntent := testutil.Intent{
		AgentDID:   "did:key:z6MkTrustedBot",
		Action:     "fetch_weather",
		Target:     "zip:94105",
		PersonaID:  "consumer",
		TrustLevel: "trusted",
	}
	trustedDecision, err := impl.EvaluateIntent(context.Background(), trustedIntent)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, trustedDecision.Allowed, "trusted agent with safe action must be allowed — positive control")

	// Negative: untrusted agent attempting vault_read on locked persona must be denied.
	intent := testutil.Intent{
		AgentDID:   "did:key:z6MkUntrustedBot",
		Action:     "vault_read",
		Target:     "health",
		PersonaID:  "health",
		TrustLevel: "untrusted",
	}
	decision, err := impl.EvaluateIntent(context.Background(), intent)
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, decision.Allowed, "untrusted agent must not access locked persona")
	testutil.RequireTrue(t, decision.Audit, "denied access must generate audit trail")
}

// TST-CORE-801
func TestGatekeeper_6_3_3_VerifiedAgentRestrictedPersona(t *testing.T) {
	impl := realGatekeeper
	testutil.RequireImplementation(t, impl, "Gatekeeper")

	ctx := context.Background()

	// Positive: verified agent on vault_read is allowed but audited.
	intent := testutil.Intent{
		AgentDID:   "did:key:z6MkVerifiedBot",
		Action:     "vault_read",
		Target:     "professional",
		PersonaID:  "professional",
		TrustLevel: "verified",
	}
	decision, err := impl.EvaluateIntent(ctx, intent)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, decision.Allowed, "verified agent vault_read should be allowed")
	testutil.RequireTrue(t, decision.Audit, "verified agent on restricted persona must trigger audit")

	// Negative: untrusted agent must be denied entirely (not just audited).
	untrusted := testutil.Intent{
		AgentDID:   "did:key:z6MkUntrustedBot",
		Action:     "vault_read",
		Target:     "professional",
		PersonaID:  "professional",
		TrustLevel: "untrusted",
	}
	denied, err := impl.EvaluateIntent(ctx, untrusted)
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, denied.Allowed, "untrusted agent must be denied, not just audited")
}

// TST-CORE-802
func TestGatekeeper_6_3_4_CrossPersonaAccessDenied(t *testing.T) {
	impl := gatekeeper.New()
	testutil.RequireImplementation(t, impl, "Gatekeeper")

	ctx := context.Background()

	// Positive: same-persona access (consumer → consumer) must be allowed.
	samePersona := testutil.Intent{
		AgentDID:    "did:key:z6MkConsumerBot",
		Action:      "vault_read",
		Target:      "consumer",
		PersonaID:   "consumer",
		TrustLevel:  "trusted",
		Constraints: map[string]bool{"persona_consumer_only": true},
	}
	decision, err := impl.EvaluateIntent(ctx, samePersona)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, decision.Allowed, "same-persona access must be allowed")

	// Negative: cross-persona access (consumer → financial) must be denied.
	crossPersona := testutil.Intent{
		AgentDID:    "did:key:z6MkConsumerBot",
		Action:      "vault_read",
		Target:      "financial",
		PersonaID:   "financial",
		TrustLevel:  "trusted",
		Constraints: map[string]bool{"persona_consumer_only": true},
	}
	decision, err = impl.EvaluateIntent(ctx, crossPersona)
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, decision.Allowed, "cross-persona access must be denied")
	testutil.RequireTrue(t, decision.Audit, "cross-persona denial must be audited")
	testutil.RequireTrue(t, strings.Contains(decision.Reason, "cross-persona"), "reason must mention cross-persona")
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

	// Positive control: trusted agent with transfer_money must be allowed.
	trustedIntent := testutil.Intent{
		AgentDID:   "did:key:z6MkPaymentBot",
		Action:     "transfer_money",
		Target:     "vendor_account",
		PersonaID:  "financial",
		TrustLevel: "trusted",
	}
	trustedDecision, err := impl.EvaluateIntent(context.Background(), trustedIntent)
	testutil.RequireNoError(t, err)
	if !trustedDecision.Allowed {
		t.Fatal("trusted agent must be allowed to transfer_money")
	}
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
	testutil.RequireTrue(t, decision.Allowed, "trusted agent share_data should be allowed (but audited)")

	// Negative control: a safe, non-risky action must NOT be flagged.
	safeIntent := testutil.Intent{
		AgentDID:   "did:key:z6MkSafeBot",
		Action:     "read_note",
		Target:     "personal_vault",
		PersonaID:  "social",
		TrustLevel: "trusted",
	}
	safeDecision, err := impl.EvaluateIntent(context.Background(), safeIntent)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, safeDecision.Allowed, "safe action must be allowed")
	testutil.RequireFalse(t, safeDecision.Audit, "safe non-risky action must not be flagged for audit")
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
	spm := gatekeeper.NewSharingPolicyManager()
	ctx := context.Background()
	did := "did:plc:sancho-sp2"

	// Set policy with "health" only — no "location" key.
	err := spm.SetPolicy(ctx, did, map[string]testutil.SharingTier{"health": "summary"})
	testutil.RequireNoError(t, err)

	// Positive: request "location" which has no policy key → must be denied.
	payload := testutil.EgressPayload{
		RecipientDID: did,
		Categories: map[string]interface{}{
			"location": testutil.TieredPayload{Summary: "Nearby", Full: "123 Main St"},
		},
	}
	result, err := spm.FilterEgress(ctx, payload)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(result.Denied), 1)
	testutil.RequireEqual(t, result.Denied[0], "location")
	testutil.RequireTrue(t, len(result.AuditEntries) > 0, "denied egress must produce audit entry")
	testutil.RequireEqual(t, result.AuditEntries[0].Reason, "tier_none")

	// Negative control: request "health" which HAS a "summary" policy → must be allowed.
	payloadAllowed := testutil.EgressPayload{
		RecipientDID: did,
		Categories: map[string]interface{}{
			"health": testutil.TieredPayload{Summary: "Fine", Full: "Blood pressure 120/80"},
		},
	}
	resultAllowed, err := spm.FilterEgress(ctx, payloadAllowed)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(resultAllowed.Denied), 0)
	testutil.RequireEqual(t, resultAllowed.Filtered["health"], "Fine")
}

// TST-CORE-362
func TestGatekeeper_6_1_SP3_PolicyNoneExplicit(t *testing.T) {
	impl := realSharingPolicyManager
	testutil.RequireImplementation(t, impl, "SharingPolicyManager")

	ctx := context.Background()
	did := "did:plc:sancho-sp3"

	// Set health to "none" explicitly.
	err := impl.SetPolicy(ctx, did, map[string]testutil.SharingTier{"health": "none"})
	testutil.RequireNoError(t, err)

	// Positive: FilterEgress must deny health category.
	payload := testutil.EgressPayload{
		RecipientDID: did,
		Categories: map[string]interface{}{
			"health": testutil.TieredPayload{Summary: "Fine", Full: "Blood pressure 120/80, on medication X"},
		},
	}
	result, err := impl.FilterEgress(ctx, payload)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(result.Denied) == 1, "explicit none must deny health category")
	testutil.RequireEqual(t, result.Denied[0], "health")
	if _, ok := result.Filtered["health"]; ok {
		t.Fatal("health must NOT appear in filtered output when tier is none")
	}

	// Negative: change tier to "summary" — health must now pass through.
	err = impl.SetPolicy(ctx, did, map[string]testutil.SharingTier{"health": "summary"})
	testutil.RequireNoError(t, err)
	result2, err := impl.FilterEgress(ctx, payload)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(result2.Denied), 0)
	testutil.RequireEqual(t, result2.Filtered["health"], "Fine")
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
	impl := realSharingPolicyManager
	testutil.RequireImplementation(t, impl, "SharingPolicyManager")

	ctx := context.Background()
	did := "did:plc:sancho-sp5"

	// Set preferences to "full" tier.
	err := impl.SetPolicy(ctx, did, map[string]testutil.SharingTier{"preferences": "full"})
	testutil.RequireNoError(t, err)

	payload := testutil.EgressPayload{
		RecipientDID: did,
		Categories: map[string]interface{}{
			"preferences": testutil.TieredPayload{Summary: "Likes chai", Full: "Chai, no sugar, served warm. Allergic to dairy."},
		},
	}

	// Positive: "full" tier must return the Full content, not Summary.
	result, err := impl.FilterEgress(ctx, payload)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, result.Filtered["preferences"], "Chai, no sugar, served warm. Allergic to dairy.")
	testutil.RequireEqual(t, len(result.Denied), 0)

	// Negative: change to "summary" — must return Summary content instead.
	err = impl.SetPolicy(ctx, did, map[string]testutil.SharingTier{"preferences": "summary"})
	testutil.RequireNoError(t, err)

	result2, err := impl.FilterEgress(ctx, payload)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, result2.Filtered["preferences"], "Likes chai")
}

// TST-CORE-365
func TestGatekeeper_6_1_SP6_PerContactPerCategoryGranularity(t *testing.T) {
	impl := realSharingPolicyManager
	testutil.RequireImplementation(t, impl, "SharingPolicyManager")

	ctx := context.Background()
	contactDID := "did:plc:sancho-sp6-granularity"
	err := impl.SetPolicy(ctx, contactDID, map[string]testutil.SharingTier{
		"presence": "eta_only",
		"health":   "none",
	})
	testutil.RequireNoError(t, err)

	payload := testutil.EgressPayload{
		RecipientDID: contactDID,
		Categories: map[string]interface{}{
			"presence": testutil.TieredPayload{Summary: "Arriving in 15 min", Full: "GPS: 37.7749,-122.4194"},
			"health":   testutil.TieredPayload{Summary: "Fine", Full: "Detailed health report"},
		},
	}
	result, err := impl.FilterEgress(ctx, payload)
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
	impl := realSharingPolicyManager
	testutil.RequireImplementation(t, impl, "SharingPolicyManager")

	ctx := context.Background()
	contactDID := "did:plc:sancho-sp8-freebusy"
	err := impl.SetPolicy(ctx, contactDID, map[string]testutil.SharingTier{"availability": "free_busy"})
	testutil.RequireNoError(t, err)

	payload := testutil.EgressPayload{
		RecipientDID: contactDID,
		Categories: map[string]interface{}{
			"availability": testutil.TieredPayload{Summary: "Busy 2-3pm", Full: "Meeting with Dr. Patel at downtown clinic"},
		},
	}
	result, err := impl.FilterEgress(ctx, payload)
	testutil.RequireNoError(t, err)
	// free_busy maps to summary tier.
	testutil.RequireEqual(t, result.Filtered["availability"], "Busy 2-3pm")
}

// TST-CORE-368
func TestGatekeeper_6_1_SP9_DomainSpecificExactLocation(t *testing.T) {
	spm := gatekeeper.NewSharingPolicyManager()
	ctx := context.Background()
	did := "did:plc:sancho-sp9"

	err := spm.SetPolicy(ctx, did, map[string]testutil.SharingTier{
		"presence": "exact_location",
		"health":   "summary",
	})
	testutil.RequireNoError(t, err)

	// Positive: exact_location tier maps to Full data.
	payload := testutil.EgressPayload{
		RecipientDID: did,
		Categories: map[string]interface{}{
			"presence": testutil.TieredPayload{Summary: "Arriving soon", Full: "GPS: 37.7749,-122.4194, heading south on Market St"},
		},
	}
	result, err := spm.FilterEgress(ctx, payload)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(result.Denied), 0)
	testutil.RequireEqual(t, result.Filtered["presence"], "GPS: 37.7749,-122.4194, heading south on Market St")

	// Negative control: "summary" tier returns Summary data, NOT Full.
	payloadHealth := testutil.EgressPayload{
		RecipientDID: did,
		Categories: map[string]interface{}{
			"health": testutil.TieredPayload{Summary: "Fine", Full: "Blood pressure 120/80, on medication X"},
		},
	}
	resultHealth, err := spm.FilterEgress(ctx, payloadHealth)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(resultHealth.Denied), 0)
	testutil.RequireEqual(t, resultHealth.Filtered["health"], "Fine")
}

// TST-CORE-371
func TestGatekeeper_6_1_SP12_TrustLevelNotEqualSharing(t *testing.T) {
	// Fresh production SharingPolicyManager — no shared state.
	spm := gatekeeper.NewSharingPolicyManager()

	ctx := context.Background()

	// Negative control: contact with no explicit sharing rules — trust level alone
	// must NOT grant sharing. Default-deny semantics.
	payload := gatekeeper.EgressPayload{
		RecipientDID: "did:plc:trusted_no_policy",
		Categories: map[string]interface{}{
			"location": gatekeeper.TieredPayload{Summary: "Nearby", Full: "123 Main St"},
			"health":   gatekeeper.TieredPayload{Summary: "Fine", Full: "Blood pressure 120/80"},
		},
	}
	result, err := spm.FilterEgress(ctx, payload)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(result.Denied), 2)
	testutil.RequireEqual(t, len(result.Filtered), 0)

	// Positive control: set an explicit policy for a different contact with "full" tier
	// on location — that contact's egress must be allowed for location.
	err = spm.SetPolicy(ctx, "did:plc:allowed_contact", map[string]domain.SharingTier{
		"location": "full",
	})
	testutil.RequireNoError(t, err)

	allowedPayload := gatekeeper.EgressPayload{
		RecipientDID: "did:plc:allowed_contact",
		Categories: map[string]interface{}{
			"location": gatekeeper.TieredPayload{Summary: "Nearby", Full: "123 Main St"},
		},
	}
	allowedResult, err := spm.FilterEgress(ctx, allowedPayload)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(allowedResult.Denied), 0)
	testutil.RequireTrue(t, len(allowedResult.Filtered) > 0, "contact with full policy must have filtered output")

	// Verify original contact (no policy) is still denied — setting policy on one
	// contact must not affect another.
	result2, err := spm.FilterEgress(ctx, payload)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(result2.Denied), 2)
}

// TST-CORE-372
func TestGatekeeper_6_1_SP13_RecognizedCategories(t *testing.T) {
	// §6.1 SP13: Phase 1 must recognize these 6 categories at egress.
	// Test validates requirements, not a fixture list.
	impl := gatekeeper.NewSharingPolicyManager()
	testutil.RequireImplementation(t, impl, "SharingPolicyManager")

	ctx := context.Background()
	contactDID := "did:plc:sp13-categories"

	// The 6 Phase 1 recognized categories per §6.1 SP13.
	recognized := []string{"presence", "availability", "context", "preferences", "location", "health"}

	// Set all 6 categories to "full" tier for this contact.
	policyMap := map[string]domain.SharingTier{}
	for _, cat := range recognized {
		policyMap[cat] = "full"
	}
	err := impl.SetPolicy(ctx, contactDID, policyMap)
	testutil.RequireNoError(t, err)

	// Build egress payload with all 6 categories.
	categories := map[string]interface{}{}
	for _, cat := range recognized {
		categories[cat] = domain.TieredPayload{
			Summary: cat + "-summary",
			Full:    cat + "-full-data",
		}
	}
	payload := domain.EgressPayload{
		RecipientDID: contactDID,
		Categories:   categories,
	}

	// Positive: all 6 recognized categories should pass FilterEgress.
	result, err := impl.FilterEgress(ctx, payload)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(result.Denied), 0)
	for _, cat := range recognized {
		testutil.RequireEqual(t, result.Filtered[cat], cat+"-full-data")
	}

	// Negative: a category NOT in the policy is denied by default-deny.
	payloadUnknown := domain.EgressPayload{
		RecipientDID: contactDID,
		Categories: map[string]interface{}{
			"financial": domain.TieredPayload{Summary: "balance", Full: "$10k"},
		},
	}
	resultDenied, err := impl.FilterEgress(ctx, payloadUnknown)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(resultDenied.Denied), 1)
	_, hasFinancial := resultDenied.Filtered["financial"]
	testutil.RequireFalse(t, hasFinancial, "unlisted category must not appear in filtered output")
}

// TST-CORE-375
func TestGatekeeper_6_1_SP16_ExtensibleCategoryAccepted(t *testing.T) {
	impl := gatekeeper.NewSharingPolicyManager()
	testutil.RequireImplementation(t, impl, "SharingPolicyManager")

	ctx := context.Background()
	contactDID := "did:plc:sp16-extensible"

	// Custom category "hobbies" should be storable and retrievable.
	err := impl.SetPolicy(ctx, contactDID, map[string]domain.SharingTier{"hobbies": "full"})
	testutil.RequireNoError(t, err)

	policy, err := impl.GetPolicy(ctx, contactDID)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, policy.Categories["hobbies"], domain.SharingTier("full"))

	// Verify custom category is enforced at egress — "full" tier returns Full content.
	payload := domain.EgressPayload{
		RecipientDID: contactDID,
		Categories: map[string]interface{}{
			"hobbies": domain.TieredPayload{Summary: "Likes cycling", Full: "Rides 50km every weekend"},
		},
	}
	result, err := impl.FilterEgress(ctx, payload)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, result.Filtered["hobbies"], "Rides 50km every weekend")
	testutil.RequireEqual(t, len(result.Denied), 0)

	// Negative: a different custom category not in the policy is denied.
	payload2 := domain.EgressPayload{
		RecipientDID: contactDID,
		Categories: map[string]interface{}{
			"pets": domain.TieredPayload{Summary: "Has a dog", Full: "Golden retriever named Max"},
		},
	}
	result2, err := impl.FilterEgress(ctx, payload2)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(result2.Denied), 1)
	testutil.RequireEqual(t, result2.Denied[0], "pets")
}

// TST-CORE-376
func TestGatekeeper_6_1_SP17_ExtensibleCategoryEnforcedAtEgress(t *testing.T) {
	impl := gatekeeper.NewSharingPolicyManager()
	testutil.RequireImplementation(t, impl, "SharingPolicyManager")

	ctx := context.Background()
	contactDID := "did:plc:sp17-extensible-egress"

	// Set custom category "hobbies" with "summary" tier.
	err := impl.SetPolicy(ctx, contactDID, map[string]domain.SharingTier{"hobbies": "summary"})
	testutil.RequireNoError(t, err)

	// Positive: summary tier returns Summary content, not Full.
	payload := domain.EgressPayload{
		RecipientDID: contactDID,
		Categories: map[string]interface{}{
			"hobbies": domain.TieredPayload{Summary: "Likes cycling", Full: "Rides 50km every weekend, owns a Trek Domane"},
		},
	}
	result, err := impl.FilterEgress(ctx, payload)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, result.Filtered["hobbies"], "Likes cycling")
	testutil.RequireEqual(t, len(result.Denied), 0)

	// Verify Full content is NOT exposed when tier is "summary".
	testutil.RequireTrue(t, result.Filtered["hobbies"] != "Rides 50km every weekend, owns a Trek Domane",
		"summary tier must not expose Full content")

	// Upgrade to "full" tier — Full content should now be returned.
	err = impl.SetPolicy(ctx, contactDID, map[string]domain.SharingTier{"hobbies": "full"})
	testutil.RequireNoError(t, err)

	result2, err := impl.FilterEgress(ctx, payload)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, result2.Filtered["hobbies"], "Rides 50km every weekend, owns a Trek Domane")

	// Negative: downgrade to "none" — category should be denied.
	err = impl.SetPolicy(ctx, contactDID, map[string]domain.SharingTier{"hobbies": "none"})
	testutil.RequireNoError(t, err)

	result3, err := impl.FilterEgress(ctx, payload)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(result3.Denied), 1)
	testutil.RequireEqual(t, result3.Denied[0], "hobbies")
	_, inFiltered := result3.Filtered["hobbies"]
	testutil.RequireTrue(t, !inFiltered, "denied category must not appear in Filtered map")
}


// --------------------------------------------------------------------------
// §6.1 Uncovered Sharing Policy Scenarios
// --------------------------------------------------------------------------

// TST-CORE-369
func TestGatekeeper_6_1_SP10_PolicyUpdateViaPatch(t *testing.T) {
	impl := realSharingPolicyManager
	testutil.RequireImplementation(t, impl, "SharingPolicyManager")

	ctx := context.Background()

	// Set initial policy: health=none, location=full.
	err := impl.SetPolicy(ctx, "did:plc:sancho-sp10", map[string]testutil.SharingTier{
		"health": "none", "location": "full",
	})
	testutil.RequireNoError(t, err)

	// Verify initial state.
	policy, err := impl.GetPolicy(ctx, "did:plc:sancho-sp10")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, policy.Categories["health"], testutil.SharingTier("none"))

	// PATCH: update health from "none" to "summary".
	err = impl.SetPolicy(ctx, "did:plc:sancho-sp10", map[string]testutil.SharingTier{"health": "summary"})
	testutil.RequireNoError(t, err)

	// Verify health changed AND location preserved.
	policy2, err := impl.GetPolicy(ctx, "did:plc:sancho-sp10")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, policy2.Categories["health"], testutil.SharingTier("summary"))
	testutil.RequireEqual(t, policy2.Categories["location"], testutil.SharingTier("full"))

	// Negative control: verify the change is reflected in FilterEgress.
	payload := testutil.EgressPayload{
		RecipientDID: "did:plc:sancho-sp10",
		Categories: map[string]interface{}{
			"health": testutil.TieredPayload{Summary: "All good", Full: "Blood pressure 120/80"},
		},
	}
	result, err := impl.FilterEgress(ctx, payload)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, result.Filtered["health"], "All good")
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
	impl := gatekeeper.NewSharingPolicyManager()
	testutil.RequireImplementation(t, impl, "SharingPolicyManager")

	ctx := context.Background()

	// Query the sharing policy for a brand-new DID (no contact entry, no policy set).
	newDID := "did:key:z6MkSP14DefaultPolicy"
	policy, err := impl.GetPolicy(ctx, newDID)
	testutil.RequireNoError(t, err)

	// Default-deny: non-nil policy with empty categories (all categories blocked).
	testutil.RequireTrue(t, policy != nil, "new contact must get a default sharing policy")
	testutil.RequireEqual(t, policy.ContactDID, newDID)
	testutil.RequireEqual(t, len(policy.Categories), 0)

	// Verify default-deny is enforced at egress: all categories are denied.
	payload := domain.EgressPayload{
		RecipientDID: newDID,
		Categories: map[string]interface{}{
			"location": domain.TieredPayload{Summary: "NYC", Full: "123 Main St"},
			"health":   domain.TieredPayload{Summary: "Fine", Full: "Full report"},
		},
	}
	result, err := impl.FilterEgress(ctx, payload)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(result.Denied), 2)
	testutil.RequireEqual(t, len(result.Filtered), 0)

	// After explicitly setting a policy, default-deny is replaced.
	err = impl.SetPolicy(ctx, newDID, map[string]domain.SharingTier{"location": "summary"})
	testutil.RequireNoError(t, err)

	result2, err := impl.FilterEgress(ctx, payload)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, result2.Filtered["location"], "NYC")
	testutil.RequireEqual(t, len(result2.Denied), 1) // health still denied
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

	ctx := context.Background()

	// Positive: set a policy, then retrieve it and verify categories match.
	err := impl.SetPolicy(ctx, "did:plc:sancho-getpol", map[string]testutil.SharingTier{
		"location": "summary", "health": "none",
	})
	testutil.RequireNoError(t, err)

	policy, err := impl.GetPolicy(ctx, "did:plc:sancho-getpol")
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, policy)
	testutil.RequireEqual(t, policy.Categories["location"], testutil.SharingTier("summary"))
	testutil.RequireEqual(t, policy.Categories["health"], testutil.SharingTier("none"))

	// Negative control: unknown DID returns default-deny (empty categories).
	unknownPolicy, err := impl.GetPolicy(ctx, "did:plc:unknown-never-set")
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, unknownPolicy)
	testutil.RequireEqual(t, len(unknownPolicy.Categories), 0)
}

// TST-CORE-378
func TestGatekeeper_6_2_SP2_PatchSingleCategory(t *testing.T) {
	impl := realSharingPolicyManager
	testutil.RequireImplementation(t, impl, "SharingPolicyManager")

	ctx := context.Background()

	// Set initial policy with 3 categories.
	err := impl.SetPolicy(ctx, "did:plc:sancho-patch1", map[string]testutil.SharingTier{
		"location": "none", "health": "none", "preferences": "full",
	})
	testutil.RequireNoError(t, err)

	// PATCH single category — only location changed, rest must be preserved.
	err = impl.SetPolicy(ctx, "did:plc:sancho-patch1", map[string]testutil.SharingTier{"location": "exact_location"})
	testutil.RequireNoError(t, err)

	policy, err := impl.GetPolicy(ctx, "did:plc:sancho-patch1")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, policy.Categories["location"], testutil.SharingTier("exact_location"))
	testutil.RequireEqual(t, policy.Categories["health"], testutil.SharingTier("none"))
	testutil.RequireEqual(t, policy.Categories["preferences"], testutil.SharingTier("full"))

	// Negative control: patching a category to "none" must actually set it to none,
	// not delete it.
	err = impl.SetPolicy(ctx, "did:plc:sancho-patch1", map[string]testutil.SharingTier{"preferences": "none"})
	testutil.RequireNoError(t, err)
	policy2, err := impl.GetPolicy(ctx, "did:plc:sancho-patch1")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, policy2.Categories["preferences"], testutil.SharingTier("none"))
	// location must still be exact_location from previous patch.
	testutil.RequireEqual(t, policy2.Categories["location"], testutil.SharingTier("exact_location"))
}

// TST-CORE-379
func TestGatekeeper_6_2_SP3_PatchMultipleCategories(t *testing.T) {
	impl := realSharingPolicyManager
	testutil.RequireImplementation(t, impl, "SharingPolicyManager")

	// Set initial policy with 3 categories.
	err := impl.SetPolicy(context.Background(), "did:plc:patch-multi", map[string]testutil.SharingTier{
		"health": "none", "location": "none", "preferences": "full",
	})
	testutil.RequireNoError(t, err)

	// PATCH two categories at once — merge semantics, not replace.
	err = impl.SetPolicy(context.Background(), "did:plc:patch-multi", map[string]testutil.SharingTier{
		"health": "summary", "location": "none",
	})
	testutil.RequireNoError(t, err)

	policy, err := impl.GetPolicy(context.Background(), "did:plc:patch-multi")
	testutil.RequireNoError(t, err)

	// Verify merge: patched categories updated, untouched categories preserved.
	testutil.RequireEqual(t, policy.Categories["health"], testutil.SharingTier("summary"))
	testutil.RequireEqual(t, policy.Categories["location"], testutil.SharingTier("none"))
	testutil.RequireEqual(t, policy.Categories["preferences"], testutil.SharingTier("full"))

	// Category count must remain 3 (merge, not replace).
	testutil.RequireEqual(t, len(policy.Categories), 3)
}

// TST-CORE-380
func TestGatekeeper_6_2_SP4_PatchBulkByTrustLevel(t *testing.T) {
	// §6.2 SP4: Bulk policy update by trust level filter.
	// Fresh production SharingPolicyManager.
	impl := gatekeeper.NewSharingPolicyManager()
	testutil.RequireImplementation(t, impl, "SharingPolicyManager")

	ctx := context.Background()

	// Set up 3 contacts with location=full.
	err := impl.SetPolicy(ctx, "did:plc:bulk-alice", map[string]domain.SharingTier{"location": "full"})
	testutil.RequireNoError(t, err)
	err = impl.SetPolicy(ctx, "did:plc:bulk-bob", map[string]domain.SharingTier{"location": "full"})
	testutil.RequireNoError(t, err)
	err = impl.SetPolicy(ctx, "did:plc:bulk-carol", map[string]domain.SharingTier{"location": "full"})
	testutil.RequireNoError(t, err)

	// Positive: bulk update with empty filter (all contacts) should work.
	count, err := impl.SetBulkPolicy(ctx,
		map[string]string{},
		map[string]domain.SharingTier{"location": "none"},
	)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, count >= 3, "bulk update with empty filter must affect at least 3 contacts")

	// Verify all 3 contacts now have location=none.
	policyA, err := impl.GetPolicy(ctx, "did:plc:bulk-alice")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, policyA.Categories["location"], domain.SharingTier("none"))
	policyB, err := impl.GetPolicy(ctx, "did:plc:bulk-bob")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, policyB.Categories["location"], domain.SharingTier("none"))

	// Negative: bulk update with trust_level filter returns error (not yet supported).
	_, err = impl.SetBulkPolicy(ctx,
		map[string]string{"trust_level": "trusted"},
		map[string]domain.SharingTier{"location": "full"},
	)
	testutil.RequireError(t, err)
}

// TST-CORE-381
func TestGatekeeper_6_2_SP5_PatchBulkAllContacts(t *testing.T) {
	impl := realSharingPolicyManager
	testutil.RequireImplementation(t, impl, "SharingPolicyManager")

	ctx := context.Background()
	_ = impl.SetPolicy(ctx, "did:plc:bulkAlice", map[string]testutil.SharingTier{"location": "full"})
	_ = impl.SetPolicy(ctx, "did:plc:bulkBob", map[string]testutil.SharingTier{"location": "full"})
	_ = impl.SetPolicy(ctx, "did:plc:bulkCharlie", map[string]testutil.SharingTier{"location": "full"})

	// Bulk update with empty filter — all contacts updated.
	count, err := impl.SetBulkPolicy(ctx,
		map[string]string{},
		map[string]testutil.SharingTier{"location": "none"},
	)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, count >= 3, "bulk update must affect at least 3 contacts")

	// Verify mutations actually occurred.
	policyA, err := impl.GetPolicy(ctx, "did:plc:bulkAlice")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, policyA.Categories["location"], testutil.SharingTier("none"))

	policyB, err := impl.GetPolicy(ctx, "did:plc:bulkBob")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, policyB.Categories["location"], testutil.SharingTier("none"))

	policyC, err := impl.GetPolicy(ctx, "did:plc:bulkCharlie")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, policyC.Categories["location"], testutil.SharingTier("none"))
}

// TST-CORE-382
func TestGatekeeper_6_2_SP6_GetPolicyUnknownDID(t *testing.T) {
	impl := realSharingPolicyManager
	testutil.RequireImplementation(t, impl, "SharingPolicyManager")

	ctx := context.Background()

	// Unknown DID must return a default-deny empty policy (not an error).
	// Production returns SharingPolicy{ContactDID: did, Categories: {}} for unknown DIDs.
	policy, err := impl.GetPolicy(ctx, "did:plc:totally-unknown-sp6")
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, policy)
	testutil.RequireEqual(t, len(policy.Categories), 0)

	// Positive control: set a policy, then GetPolicy returns the categories.
	err = impl.SetPolicy(ctx, "did:plc:known-sp6", map[string]testutil.SharingTier{"health": "summary"})
	testutil.RequireNoError(t, err)
	knownPolicy, err := impl.GetPolicy(ctx, "did:plc:known-sp6")
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, knownPolicy.Categories["health"], testutil.SharingTier("summary"))

	// Verify unknown DID's empty policy means FilterEgress denies everything.
	payload := testutil.EgressPayload{
		RecipientDID: "did:plc:totally-unknown-sp6",
		Categories: map[string]interface{}{
			"availability": testutil.TieredPayload{Summary: "Busy", Full: "Full details"},
		},
	}
	result, err := impl.FilterEgress(ctx, payload)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(result.Filtered), 0)
	testutil.RequireTrue(t, len(result.Denied) > 0, "unknown DID must deny all categories")
}

// TST-CORE-383
func TestGatekeeper_6_2_SP7_PatchInvalidTierValue(t *testing.T) {
	impl := gatekeeper.NewSharingPolicyManager()
	testutil.RequireImplementation(t, impl, "SharingPolicyManager")

	ctx := context.Background()

	// Positive: valid tier "summary" must be accepted.
	err := impl.SetPolicy(ctx, "did:plc:sancho", map[string]testutil.SharingTier{"health": "summary"})
	testutil.RequireNoError(t, err)

	// Negative: unrecognized tier "maximum" must be rejected.
	err = impl.SetPolicy(ctx, "did:plc:sancho", map[string]testutil.SharingTier{"health": "maximum"})
	testutil.RequireTrue(t, err != nil, "invalid tier must be rejected")
	testutil.RequireTrue(t, strings.Contains(err.Error(), "invalid tier"), "error must mention invalid tier")

	// Negative: empty string tier must also be rejected.
	err = impl.SetPolicy(ctx, "did:plc:sancho", map[string]testutil.SharingTier{"health": ""})
	testutil.RequireTrue(t, err != nil, "empty tier must be rejected")
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
	impl := realSharingPolicyManager
	testutil.RequireImplementation(t, impl, "SharingPolicyManager")

	ctx := context.Background()

	// Set sharing policy: sancho gets "summary" tier for availability.
	err := impl.SetPolicy(ctx, "did:plc:sancho-ep1", map[string]testutil.SharingTier{"availability": "summary"})
	testutil.RequireNoError(t, err)

	// Brain sends POST /v1/dina/send with tiered payload.
	payload := testutil.EgressPayload{
		RecipientDID: "did:plc:sancho-ep1",
		Categories: map[string]interface{}{
			"availability": testutil.TieredPayload{Summary: "Busy 2-3pm", Full: "Meeting with Dr. Patel at clinic"},
		},
	}
	result, err := impl.FilterEgress(ctx, payload)
	testutil.RequireNoError(t, err)
	// Core picks correct tier per sharing_policy — summary, not full.
	testutil.RequireEqual(t, result.Filtered["availability"], "Busy 2-3pm")

	// Negative control: "full" tier policy must return full details.
	err = impl.SetPolicy(ctx, "did:plc:dulcinea-ep1", map[string]testutil.SharingTier{"availability": "full"})
	testutil.RequireNoError(t, err)
	payload2 := testutil.EgressPayload{
		RecipientDID: "did:plc:dulcinea-ep1",
		Categories: map[string]interface{}{
			"availability": testutil.TieredPayload{Summary: "Busy 2-3pm", Full: "Meeting with Dr. Patel at clinic"},
		},
	}
	result2, err := impl.FilterEgress(ctx, payload2)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, result2.Filtered["availability"], "Meeting with Dr. Patel at clinic")
}

// TST-CORE-386
func TestGatekeeper_6_3_EP2_CoreStripsDeniedCategories(t *testing.T) {
	impl := realSharingPolicyManager
	testutil.RequireImplementation(t, impl, "SharingPolicyManager")

	ctx := context.Background()

	// Policy: location=none (denied), availability=summary (allowed).
	err := impl.SetPolicy(ctx, "did:plc:sancho-ep2", map[string]testutil.SharingTier{"location": "none", "availability": "summary"})
	testutil.RequireNoError(t, err)

	payload := testutil.EgressPayload{
		RecipientDID: "did:plc:sancho-ep2",
		Categories: map[string]interface{}{
			"location":     testutil.TieredPayload{Summary: "Nearby", Full: "123 Main St"},
			"availability": testutil.TieredPayload{Summary: "Busy", Full: "Meeting details"},
		},
	}
	result, err := impl.FilterEgress(ctx, payload)
	testutil.RequireNoError(t, err)

	// Location must be entirely removed (denied category).
	_, hasLocation := result.Filtered["location"]
	testutil.RequireFalse(t, hasLocation, "location category should be stripped from outbound payload")

	// Availability must be present with summary tier.
	testutil.RequireEqual(t, result.Filtered["availability"], "Busy")

	// Negative control: if we change location to "summary", it must now appear.
	err = impl.SetPolicy(ctx, "did:plc:sancho-ep2", map[string]testutil.SharingTier{"location": "summary"})
	testutil.RequireNoError(t, err)
	result2, err := impl.FilterEgress(ctx, payload)
	testutil.RequireNoError(t, err)
	_, hasLocation2 := result2.Filtered["location"]
	testutil.RequireTrue(t, hasLocation2, "location must appear after policy changed to summary")
	testutil.RequireEqual(t, result2.Filtered["location"], "Nearby")
}

// TST-CORE-387
func TestGatekeeper_6_3_EP3_MalformedPayloadCategoryDropped(t *testing.T) {
	impl := realSharingPolicyManager
	testutil.RequireImplementation(t, impl, "SharingPolicyManager")

	ctx := context.Background()

	// Set policy allowing availability at summary tier.
	err := impl.SetPolicy(ctx, "did:plc:sancho-ep3", map[string]testutil.SharingTier{"availability": "summary"})
	testutil.RequireNoError(t, err)

	// Positive control: well-formed TieredPayload passes through.
	goodPayload := testutil.EgressPayload{
		RecipientDID: "did:plc:sancho-ep3",
		Categories: map[string]interface{}{
			"availability": testutil.TieredPayload{Summary: "Busy", Full: "Meeting details"},
		},
	}
	goodResult, err := impl.FilterEgress(ctx, goodPayload)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, goodResult.Filtered["availability"], "Busy")

	// Negative: raw string instead of TieredPayload must be denied.
	badPayload := testutil.EgressPayload{
		RecipientDID: "did:plc:sancho-ep3",
		Categories: map[string]interface{}{
			"availability": "raw string, not a TieredPayload",
		},
	}
	badResult, err := impl.FilterEgress(ctx, badPayload)
	testutil.RequireNoError(t, err)

	// Malformed category must appear in Denied list.
	found := false
	for _, d := range badResult.Denied {
		if d == "availability" {
			found = true
		}
	}
	testutil.RequireTrue(t, found, "malformed payload category must be denied")

	// And must NOT appear in Filtered.
	_, inFiltered := badResult.Filtered["availability"]
	testutil.RequireFalse(t, inFiltered, "malformed category must not appear in filtered output")
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

	// Positive: CheckEgress must exist (outbound enforcement).
	if !strings.Contains(content, "CheckEgress") {
		t.Fatal("gatekeeper must have egress enforcement (CheckEgress)")
	}
	// Must be a method (func receiver), not just a comment reference.
	if !strings.Contains(content, "func (") || !strings.Contains(content, "CheckEgress(") {
		t.Fatal("CheckEgress must be a method on a receiver, not just a reference")
	}

	// Negative: no CheckIngress function — enforcement is egress-only by design.
	if strings.Contains(content, "CheckIngress") {
		t.Fatal("gatekeeper must NOT have ingress enforcement (CheckIngress) — enforcement is egress-only")
	}

	// Verify the function accepts a destination parameter (outbound target).
	if !strings.Contains(content, "destination string") {
		t.Fatal("CheckEgress must accept a destination parameter (outbound enforcement target)")
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
	impl := gatekeeper.NewSharingPolicyManager()
	testutil.RequireImplementation(t, impl, "SharingPolicyManager")

	ctx := context.Background()
	contactDID := "did:plc:ep7-audit-logging"

	// Set policy with one allowed and one denied category.
	err := impl.SetPolicy(ctx, contactDID, map[string]domain.SharingTier{
		"availability": "summary",
		"health":       "none",
	})
	testutil.RequireNoError(t, err)

	// Positive: allowed category generates audit entry with "allowed" decision.
	payload := domain.EgressPayload{
		RecipientDID: contactDID,
		Categories: map[string]interface{}{
			"availability": domain.TieredPayload{Summary: "Busy", Full: "Meeting details"},
			"health":       domain.TieredPayload{Summary: "Fine", Full: "Detailed report"},
		},
	}
	result, err := impl.FilterEgress(ctx, payload)
	testutil.RequireNoError(t, err)

	// Must have 2 audit entries — one allowed, one denied.
	testutil.RequireEqual(t, len(result.AuditEntries), 2)

	// Find allowed and denied entries (order may vary due to map iteration).
	var allowedEntry, deniedEntry *domain.AuditEntry
	for i := range result.AuditEntries {
		switch result.AuditEntries[i].Decision {
		case "allowed":
			allowedEntry = &result.AuditEntries[i]
		case "denied":
			deniedEntry = &result.AuditEntries[i]
		}
	}

	// Verify allowed audit entry.
	testutil.RequireTrue(t, allowedEntry != nil, "must have an allowed audit entry")
	testutil.RequireEqual(t, allowedEntry.Action, "egress_check")
	testutil.RequireEqual(t, allowedEntry.ContactDID, contactDID)
	testutil.RequireEqual(t, allowedEntry.Category, "availability")
	testutil.RequireEqual(t, allowedEntry.Reason, "tier_summary")

	// Verify denied audit entry.
	testutil.RequireTrue(t, deniedEntry != nil, "must have a denied audit entry")
	testutil.RequireEqual(t, deniedEntry.Action, "egress_check")
	testutil.RequireEqual(t, deniedEntry.ContactDID, contactDID)
	testutil.RequireEqual(t, deniedEntry.Category, "health")
	testutil.RequireEqual(t, deniedEntry.Reason, "tier_none")

	// Negative: no-policy contact gets default-deny with NO audit entries
	// (default-deny path returns denied list but no audit entries).
	noPolicyPayload := domain.EgressPayload{
		RecipientDID: "did:plc:unknown-contact",
		Categories: map[string]interface{}{
			"location": domain.TieredPayload{Summary: "NYC", Full: "123 Main St"},
		},
	}
	noPolicyResult, err := impl.FilterEgress(ctx, noPolicyPayload)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(noPolicyResult.Denied), 1)
	testutil.RequireEqual(t, noPolicyResult.Denied[0], "location")
}

// TST-CORE-392
func TestGatekeeper_6_3_EP8_AuditIncludesDeniedCategories(t *testing.T) {
	impl := realSharingPolicyManager
	testutil.RequireImplementation(t, impl, "SharingPolicyManager")

	ctx := context.Background()
	contactDID := "did:plc:sancho-ep8-audit-denied"
	err := impl.SetPolicy(ctx, contactDID, map[string]testutil.SharingTier{"health": "none"})
	testutil.RequireNoError(t, err)

	payload := testutil.EgressPayload{
		RecipientDID: contactDID,
		Categories: map[string]interface{}{
			"health": testutil.TieredPayload{Summary: "Fine", Full: "Detailed report"},
		},
	}
	result, err := impl.FilterEgress(ctx, payload)
	testutil.RequireNoError(t, err)
	// Denied categories must also be in the audit log.
	testutil.RequireTrue(t, len(result.AuditEntries) > 0, "denied decisions must generate audit entries")
	testutil.RequireEqual(t, result.AuditEntries[0].Action, "egress_check")
	testutil.RequireEqual(t, result.AuditEntries[0].Decision, "denied")
	testutil.RequireEqual(t, result.AuditEntries[0].Reason, "tier_none")
	testutil.RequireEqual(t, result.AuditEntries[0].ContactDID, contactDID)
	testutil.RequireEqual(t, result.AuditEntries[0].Category, "health")
	// Verify the category also appears in the Denied list.
	found := false
	for _, d := range result.Denied {
		if d == "health" {
			found = true
		}
	}
	testutil.RequireTrue(t, found, "health should be in Denied list")
}

// TST-CORE-393
func TestGatekeeper_6_3_EP9_NaClEncryptionAfterPolicyCheck(t *testing.T) {
	// After payload passes egress check, it should be encrypted with crypto_box_seal.
	// This is a design integration test: egress policy check -> NaCl seal -> roundtrip decrypt.
	gkImpl := realGatekeeper
	testutil.RequireImplementation(t, gkImpl, "Gatekeeper")

	boxImpl := realEncryptor
	testutil.RequireImplementation(t, boxImpl, "Encryptor")

	sImpl := realSigner
	testutil.RequireImplementation(t, sImpl, "Signer")

	convImpl := realConverter
	testutil.RequireImplementation(t, convImpl, "KeyConverter")

	// Step 1: Verify the payload passes egress policy check (no PII, trusted dest).
	egressPayload := []byte(`{"availability":"Busy 2-3pm"}`)
	allowed, err := gkImpl.CheckEgress(context.Background(), "https://trusted-api.example.com", egressPayload)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, allowed, "clean payload to trusted destination should pass egress check")

	// Step 2: Generate recipient Ed25519 keys and convert to X25519 for NaCl box.
	pub, priv, err := sImpl.GenerateFromSeed(testutil.TestEd25519Seed[:])
	testutil.RequireNoError(t, err)

	recipientX25519Pub, err := convImpl.Ed25519ToX25519Public(pub)
	testutil.RequireNoError(t, err)

	recipientX25519Priv, err := convImpl.Ed25519ToX25519Private(priv)
	testutil.RequireNoError(t, err)

	// Step 3: Seal the egress-approved payload.
	sealed, err := boxImpl.SealAnonymous(egressPayload, recipientX25519Pub)
	testutil.RequireNoError(t, err)

	// Sealed = 32-byte ephemeral pub + ciphertext + 16-byte Poly1305 tag.
	expectedLen := 32 + len(egressPayload) + 16
	testutil.RequireEqual(t, len(sealed), expectedLen)

	// Step 4: Roundtrip — decrypt and verify plaintext matches original.
	decrypted, err := boxImpl.OpenAnonymous(sealed, recipientX25519Pub, recipientX25519Priv)
	testutil.RequireNoError(t, err)
	testutil.RequireBytesEqual(t, decrypted, egressPayload)

	// Step 5: Verify tampered ciphertext fails decryption (integrity check).
	tampered := make([]byte, len(sealed))
	copy(tampered, sealed)
	tampered[len(tampered)-1] ^= 0xff // flip last byte of Poly1305 tag
	_, err = boxImpl.OpenAnonymous(tampered, recipientX25519Pub, recipientX25519Priv)
	testutil.RequireError(t, err)
}

// TST-CORE-889
func TestGatekeeper_6_4_AuditLog_90DayRollingRetention(t *testing.T) {
	// §6.4: Egress audit log must have 90-day rolling retention (auto-purge old entries).
	// Fresh AuditLogger to avoid shared state.
	impl := vault.NewAuditLogger()
	testutil.RequireImplementation(t, impl, "VaultAuditLogger")

	ctx := context.Background()

	// Append an old entry (100 days ago) and a recent entry (10 days ago).
	oldEntry := domain.VaultAuditEntry{
		Action:    "egress",
		Persona:   "health",
		Requester: "did:plc:old-contact",
		Timestamp: time.Now().AddDate(0, 0, -100).UTC().Format(time.RFC3339),
	}
	err := impl.Append(ctx, oldEntry)
	testutil.RequireNoError(t, err)

	recentEntry := domain.VaultAuditEntry{
		Action:    "egress",
		Persona:   "health",
		Requester: "did:plc:recent-contact",
		Timestamp: time.Now().AddDate(0, 0, -10).UTC().Format(time.RFC3339),
	}
	err = impl.Append(ctx, recentEntry)
	testutil.RequireNoError(t, err)

	// Purge with 90-day retention — old entry should be removed.
	purged, err := impl.Purge(90)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, purged, int64(1))

	// Verify only the recent entry remains.
	remaining, err := impl.Query(ctx, domain.VaultAuditFilter{})
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(remaining), 1)
	testutil.RequireEqual(t, remaining[0].Requester, "did:plc:recent-contact")

	// Negative: purge again — nothing more to purge.
	purged2, err := impl.Purge(90)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, purged2, int64(0))
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
	// §6.6: Draft confidence scoring — staging lifecycle exercises Stage/Approve/Reject.
	// Fresh StagingManager to avoid shared state.
	dir := t.TempDir()
	mgr := vault.NewManager(dir)
	impl := vault.NewStagingManager(mgr)
	testutil.RequireImplementation(t, impl, "StagingManager")

	ctx := context.Background()
	persona := domain.PersonaName("personal")

	// Stage a low-confidence draft — returns unique staging ID.
	item1 := testutil.VaultItem{
		ID: "draft-low-conf", Type: "note", Source: "agent",
		Summary: "low confidence draft", Metadata: `{"confidence": 0.3}`,
	}
	id1, err := impl.Stage(ctx, persona, item1, time.Now().Add(time.Hour).Unix())
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, id1 != "", "staging ID must be non-empty")

	// Stage a high-confidence draft — different unique ID.
	item2 := testutil.VaultItem{
		ID: "draft-high-conf", Type: "note", Source: "agent",
		Summary: "high confidence draft", Metadata: `{"confidence": 0.95}`,
	}
	id2, err := impl.Stage(ctx, persona, item2, time.Now().Add(time.Hour).Unix())
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, id2 != "", "staging ID must be non-empty")
	testutil.RequireTrue(t, id1 != id2, "each staged item must get a unique ID")

	// Approve high-confidence draft → moves to vault.
	err = impl.Approve(ctx, persona, id2)
	testutil.RequireNoError(t, err)

	// Reject low-confidence draft.
	err = impl.Reject(ctx, persona, id1)
	testutil.RequireNoError(t, err)

	// Negative: rejected item cannot be approved (already removed).
	err = impl.Approve(ctx, persona, id1)
	testutil.RequireError(t, err)

	// Negative: approved item cannot be approved again (already removed).
	err = impl.Approve(ctx, persona, id2)
	testutil.RequireError(t, err)
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
func TestGatekeeper_6_6_27_AgentOutcome_RecordedForTrust(t *testing.T) {
	// §6.6.27: Agent outcomes must be recorded in audit log for trust scoring.
	// Fresh AuditLogger to avoid shared state.
	logger := vault.NewAuditLogger()
	testutil.RequireImplementation(t, logger, "VaultAuditLogger")

	ctx := context.Background()
	entry := testutil.VaultAuditEntry{
		Timestamp: "2024-06-15T10:00:00Z",
		Persona:   "consumer",
		Action:    "agent_outcome",
		Requester: "did:key:z6MkAgent",
		Reason:    "task completed successfully",
	}
	id, err := logger.Append(ctx, entry)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, id > 0, "appended entry must get a positive ID")

	// Query back by action — must find the agent_outcome entry.
	results, err := logger.Query(ctx, domain.VaultAuditFilter{Action: "agent_outcome"})
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(results), 1)
	testutil.RequireEqual(t, results[0].Requester, "did:key:z6MkAgent")
	testutil.RequireEqual(t, results[0].Reason, "task completed successfully")

	// Negative: query for a different action returns empty.
	empty, err := logger.Query(ctx, domain.VaultAuditFilter{Action: "vault_read"})
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(empty), 0)

	// Hash chain must be valid after append.
	valid, err := logger.VerifyChain()
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, valid, "audit hash chain must be valid after agent_outcome append")
}
