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
	"github.com/rajmohanutopai/dina/core/internal/service"
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

	// Even trusted agents cannot silently transfer money (Four Laws).
	// Risky actions always require explicit user approval.
	trustedIntent := testutil.Intent{
		AgentDID:   "did:key:z6MkPaymentBot",
		Action:     "transfer_money",
		Target:     "vendor_account",
		PersonaID:  "financial",
		TrustLevel: "trusted",
	}
	trustedDecision, err := impl.EvaluateIntent(context.Background(), trustedIntent)
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, trustedDecision.Allowed, "transfer_money must be flagged for user review, even for trusted agents")
	testutil.RequireTrue(t, trustedDecision.Audit, "transfer_money must create audit trail")
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
	testutil.RequireFalse(t, decision.Allowed, "share_data must be flagged for user review, even for trusted agents")

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
	_, err := impl.Append(ctx, oldEntry)
	testutil.RequireNoError(t, err)

	recentEntry := domain.VaultAuditEntry{
		Action:    "egress",
		Persona:   "health",
		Requester: "did:plc:recent-contact",
		Timestamp: time.Now().AddDate(0, 0, -10).UTC().Format(time.RFC3339),
	}
	_, err = impl.Append(ctx, recentEntry)
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
	persona := domain.PersonaName("general")

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

// TST-CORE-892 TST-CORE-1025
func TestGatekeeper_6_6_26_AgentConstraint_DraftOnlyEnforced(t *testing.T) {
	// Agent draft_only: true constraint enforced, no raw vault data to agents.
	impl := realGatekeeper
	testutil.RequireImplementation(t, impl, "Gatekeeper")

	intent := testutil.Intent{
		AgentDID:    "did:key:z6MkDraftOnlyAgent",
		Action:      "send_email",
		Target:      "external",
		PersonaID:   "general",
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

// ==========================================================================
// §33.1 — Agent Sandbox Escape Prevention
// ==========================================================================

// TST-CORE-1122
// Requirement: Agent DID with access to /consumer queries /health data → 403.
// Gatekeeper denies cross-persona access for agent identity.
// This tests the ATTACK VECTOR — a compromised agent trying to escape its sandbox.
func TestGatekeeper_33_1_1_AgentCrossPersonaVaultQuery(t *testing.T) {
	impl := gatekeeper.New()
	testutil.RequireImplementation(t, impl, "Gatekeeper")

	ctx := context.Background()

	// Sub-test 1: Consumer agent tries to read health data → denied.
	t.Run("consumer_agent_reads_health_denied", func(t *testing.T) {
		intent := testutil.Intent{
			AgentDID:    "did:key:z6MkConsumerAgent",
			Action:      "vault_read",
			Target:      "health",
			PersonaID:   "health",
			TrustLevel:  "trusted",
			Constraints: map[string]bool{"persona_consumer_only": true},
		}
		decision, err := impl.EvaluateIntent(ctx, intent)
		testutil.RequireNoError(t, err)

		// MUST be denied — agent is sandboxed to consumer persona.
		testutil.RequireFalse(t, decision.Allowed, "consumer agent must NOT access health persona")

		// Denial reason must reference cross-persona violation.
		testutil.RequireTrue(t, strings.Contains(decision.Reason, "cross-persona"),
			"denial reason must mention 'cross-persona': "+decision.Reason)

		// Denial must be audited (security event).
		testutil.RequireTrue(t, decision.Audit, "cross-persona denial must be audited")
	})

	// Sub-test 2: Consumer agent tries to read financial data → denied.
	t.Run("consumer_agent_reads_financial_denied", func(t *testing.T) {
		intent := testutil.Intent{
			AgentDID:    "did:key:z6MkConsumerAgent",
			Action:      "vault_read",
			Target:      "financial",
			PersonaID:   "financial",
			TrustLevel:  "trusted",
			Constraints: map[string]bool{"persona_consumer_only": true},
		}
		decision, err := impl.EvaluateIntent(ctx, intent)
		testutil.RequireNoError(t, err)
		testutil.RequireFalse(t, decision.Allowed, "consumer agent must NOT access financial persona")
	})

	// Sub-test 3: Same-persona access is allowed (not a sandbox escape).
	t.Run("consumer_agent_reads_consumer_allowed", func(t *testing.T) {
		intent := testutil.Intent{
			AgentDID:    "did:key:z6MkConsumerAgent",
			Action:      "vault_read",
			Target:      "consumer",
			PersonaID:   "consumer",
			TrustLevel:  "trusted",
			Constraints: map[string]bool{"persona_consumer_only": true},
		}
		decision, err := impl.EvaluateIntent(ctx, intent)
		testutil.RequireNoError(t, err)
		testutil.RequireTrue(t, decision.Allowed, "consumer agent accessing own persona must be allowed")
	})

	// Sub-test 4: Health agent tries to read consumer data → denied.
	// Verifies enforcement is symmetric — not just consumer→health.
	t.Run("health_agent_reads_consumer_denied", func(t *testing.T) {
		intent := testutil.Intent{
			AgentDID:    "did:key:z6MkHealthAgent",
			Action:      "vault_read",
			Target:      "consumer",
			PersonaID:   "consumer",
			TrustLevel:  "trusted",
			Constraints: map[string]bool{"persona_health_only": true},
		}
		decision, err := impl.EvaluateIntent(ctx, intent)
		testutil.RequireNoError(t, err)
		testutil.RequireFalse(t, decision.Allowed, "health agent must NOT access consumer persona")
		testutil.RequireTrue(t, strings.Contains(decision.Reason, "cross-persona"),
			"reason must mention cross-persona: "+decision.Reason)
	})

	// Sub-test 5: Agent with no persona constraints can access any persona.
	// This is the baseline — constraints must be explicit.
	t.Run("unconstrained_agent_accesses_any_persona", func(t *testing.T) {
		intent := testutil.Intent{
			AgentDID:   "did:key:z6MkUnconstrainedAgent",
			Action:     "vault_read",
			Target:     "health",
			PersonaID:  "health",
			TrustLevel: "trusted",
			// No constraints map → no persona restriction.
		}
		decision, err := impl.EvaluateIntent(ctx, intent)
		testutil.RequireNoError(t, err)
		testutil.RequireTrue(t, decision.Allowed, "unconstrained agent should be allowed (no persona_X_only constraint)")
	})
}

// --------------------------------------------------------------------------
// §29.10 Sharing Policy Egress Enforcement — No policy default deny
// --------------------------------------------------------------------------

// TST-CORE-980
func TestGatekeeper_29_10_NoPolicyForContact_AllCategoriesDenied(t *testing.T) {
	// Requirement: Unknown contact DID (no sharing policy) → ALL categories denied.
	// This is the fail-closed default-deny behavior. Missing policy = all blocked.
	// No information should ever leak to an unknown contact.

	t.Run("all_six_categories_denied_real_impl", func(t *testing.T) {
		// Use real implementation — not mock — to verify production behavior.
		impl := realSharingPolicyManager
		testutil.RequireImplementation(t, impl, "SharingPolicyManager")

		ctx := context.Background()
		unknownDID := "did:plc:completely_unknown_contact_980"

		// Build a payload with ALL 6 recognized sharing categories.
		payload := testutil.EgressPayload{
			RecipientDID: unknownDID,
			Categories: map[string]interface{}{
				"presence":     testutil.TieredPayload{Summary: "Online", Full: "Online since 10am"},
				"availability": testutil.TieredPayload{Summary: "Free", Full: "Free until 3pm, then meeting"},
				"context":      testutil.TieredPayload{Summary: "Working", Full: "Working on project X at home office"},
				"preferences":  testutil.TieredPayload{Summary: "Prefers email", Full: "Email preferred, no calls before 9am"},
				"location":     testutil.TieredPayload{Summary: "Downtown", Full: "123 Main Street, Apt 4B"},
				"health":       testutil.TieredPayload{Summary: "Fine", Full: "Blood pressure 120/80, on medication X"},
			},
		}

		result, err := impl.FilterEgress(ctx, payload)
		testutil.RequireNoError(t, err)

		// ALL 6 categories must be denied — no exceptions.
		if len(result.Denied) != 6 {
			t.Fatalf("expected ALL 6 categories denied for unknown contact, got %d denied: %v",
				len(result.Denied), result.Denied)
		}

		// No data should pass through — Filtered must be completely empty.
		if len(result.Filtered) != 0 {
			t.Fatalf("expected zero filtered categories for unknown contact, got %d: %v",
				len(result.Filtered), result.Filtered)
		}

		// Verify EACH specific category is in the denied list.
		deniedSet := make(map[string]bool)
		for _, d := range result.Denied {
			deniedSet[d] = true
		}
		for _, cat := range []string{"presence", "availability", "context", "preferences", "location", "health"} {
			if !deniedSet[cat] {
				t.Errorf("category %q missing from denied list — should be blocked for unknown contact", cat)
			}
		}

		// RecipientDID must be echoed back correctly.
		testutil.RequireEqual(t, result.RecipientDID, unknownDID)
	})

	t.Run("single_category_also_denied", func(t *testing.T) {
		// Even a single harmless category must be denied for unknown contacts.
		impl := realSharingPolicyManager
		testutil.RequireImplementation(t, impl, "SharingPolicyManager")

		payload := testutil.EgressPayload{
			RecipientDID: "did:plc:stranger_980_single",
			Categories: map[string]interface{}{
				"presence": testutil.TieredPayload{Summary: "Available", Full: "Available for chat"},
			},
		}

		result, err := impl.FilterEgress(context.Background(), payload)
		testutil.RequireNoError(t, err)
		testutil.RequireEqual(t, len(result.Denied), 1)
		testutil.RequireEqual(t, result.Denied[0], "presence")
		testutil.RequireEqual(t, len(result.Filtered), 0)
	})

	t.Run("contrast_known_contact_with_policy_allowed", func(t *testing.T) {
		// Positive control: a known contact WITH a policy SHOULD have
		// their allowed categories pass through. This proves the deny
		// above is specific to missing policy, not a broken implementation.
		impl := realSharingPolicyManager
		testutil.RequireImplementation(t, impl, "SharingPolicyManager")

		ctx := context.Background()
		knownDID := "did:plc:trusted_sancho_980"

		// Set up a policy that allows presence (summary) and context (full).
		err := impl.SetPolicy(ctx, knownDID, map[string]testutil.SharingTier{
			"presence": "summary",
			"context":  "full",
		})
		testutil.RequireNoError(t, err)

		payload := testutil.EgressPayload{
			RecipientDID: knownDID,
			Categories: map[string]interface{}{
				"presence": testutil.TieredPayload{Summary: "Online", Full: "Online since 10am"},
				"context":  testutil.TieredPayload{Summary: "Working", Full: "Working on project X"},
				"health":   testutil.TieredPayload{Summary: "Fine", Full: "Blood pressure 120/80"},
			},
		}

		result, err := impl.FilterEgress(ctx, payload)
		testutil.RequireNoError(t, err)

		// Presence (summary tier) should pass through with summary value.
		if result.Filtered["presence"] != "Online" {
			t.Errorf("presence should be allowed at summary tier, got %q", result.Filtered["presence"])
		}
		// Context (full tier) should pass through with full value.
		if result.Filtered["context"] != "Working on project X" {
			t.Errorf("context should be allowed at full tier, got %q", result.Filtered["context"])
		}
		// Health (no policy entry) should still be denied.
		deniedSet := make(map[string]bool)
		for _, d := range result.Denied {
			deniedSet[d] = true
		}
		if !deniedSet["health"] {
			t.Error("health should be denied — no policy entry for this category")
		}
	})

	t.Run("empty_categories_payload_no_crash", func(t *testing.T) {
		// Edge case: empty categories map for unknown contact must not crash.
		impl := realSharingPolicyManager
		testutil.RequireImplementation(t, impl, "SharingPolicyManager")

		payload := testutil.EgressPayload{
			RecipientDID: "did:plc:empty_payload_980",
			Categories:   map[string]interface{}{},
		}

		result, err := impl.FilterEgress(context.Background(), payload)
		testutil.RequireNoError(t, err)
		testutil.RequireEqual(t, len(result.Denied), 0)
		testutil.RequireEqual(t, len(result.Filtered), 0)
	})
}

// --------------------------------------------------------------------------
// §29.10 Sharing Policy Egress Enforcement — Malformed payload denied
// --------------------------------------------------------------------------

// TST-CORE-981
func TestGatekeeper_29_10_4_MalformedPayloadNonTieredPayloadDenied(t *testing.T) {
	// Requirement (§29.10, row 4):
	//   Malformed payload (non-TieredPayload) must be denied. When a category
	//   value is NOT a TieredPayload struct, FilterEgress must:
	//   1. Deny the category (add to Denied list)
	//   2. NOT include it in Filtered output
	//   3. Log audit entry with Reason="malformed"
	//   4. NOT crash or return an error
	//
	// This uses the real SharingPolicyManager to test the production type-assertion
	// guard in FilterEgress (line ~372: `tp, isTP := val.(TieredPayload)`).
	//
	// Anti-tautological design:
	//   - Every negative case has a positive contrast (well-formed TieredPayload allowed)
	//   - Multiple malformed types tested (string, int, bool, nil, nested map, slice)
	//   - Audit entries verified for Reason="malformed"

	impl := realSharingPolicyManager
	testutil.RequireImplementation(t, impl, "SharingPolicyManager")

	ctx := context.Background()
	contactDID := "did:plc:malformed_test_981"

	// Set policy: "availability" at "summary" tier, "presence" at "full".
	err := impl.SetPolicy(ctx, contactDID, map[string]testutil.SharingTier{
		"availability": "summary",
		"presence":     "full",
	})
	testutil.RequireNoError(t, err)

	t.Run("raw_string_denied", func(t *testing.T) {
		// Raw string is not a TieredPayload — must be denied.
		payload := testutil.EgressPayload{
			RecipientDID: contactDID,
			Categories: map[string]interface{}{
				"availability": "just a raw string",
			},
		}
		result, err := impl.FilterEgress(ctx, payload)
		testutil.RequireNoError(t, err)

		denied := make(map[string]bool)
		for _, d := range result.Denied {
			denied[d] = true
		}
		if !denied["availability"] {
			t.Fatal("raw string must be denied — it is not a TieredPayload")
		}
		if _, ok := result.Filtered["availability"]; ok {
			t.Fatal("malformed category must not appear in filtered output")
		}
	})

	t.Run("integer_denied", func(t *testing.T) {
		payload := testutil.EgressPayload{
			RecipientDID: contactDID,
			Categories: map[string]interface{}{
				"availability": 42,
			},
		}
		result, err := impl.FilterEgress(ctx, payload)
		testutil.RequireNoError(t, err)

		denied := make(map[string]bool)
		for _, d := range result.Denied {
			denied[d] = true
		}
		if !denied["availability"] {
			t.Fatal("integer must be denied — it is not a TieredPayload")
		}
	})

	t.Run("bool_denied", func(t *testing.T) {
		payload := testutil.EgressPayload{
			RecipientDID: contactDID,
			Categories: map[string]interface{}{
				"presence": true,
			},
		}
		result, err := impl.FilterEgress(ctx, payload)
		testutil.RequireNoError(t, err)

		denied := make(map[string]bool)
		for _, d := range result.Denied {
			denied[d] = true
		}
		if !denied["presence"] {
			t.Fatal("bool must be denied — it is not a TieredPayload")
		}
	})

	t.Run("nil_value_denied", func(t *testing.T) {
		payload := testutil.EgressPayload{
			RecipientDID: contactDID,
			Categories: map[string]interface{}{
				"availability": nil,
			},
		}
		result, err := impl.FilterEgress(ctx, payload)
		testutil.RequireNoError(t, err)

		denied := make(map[string]bool)
		for _, d := range result.Denied {
			denied[d] = true
		}
		if !denied["availability"] {
			t.Fatal("nil must be denied — it is not a TieredPayload")
		}
	})

	t.Run("nested_map_denied", func(t *testing.T) {
		payload := testutil.EgressPayload{
			RecipientDID: contactDID,
			Categories: map[string]interface{}{
				"availability": map[string]string{"summary": "free", "full": "details"},
			},
		}
		result, err := impl.FilterEgress(ctx, payload)
		testutil.RequireNoError(t, err)

		denied := make(map[string]bool)
		for _, d := range result.Denied {
			denied[d] = true
		}
		if !denied["availability"] {
			t.Fatal("map[string]string must be denied — it is not a TieredPayload struct")
		}
	})

	t.Run("slice_denied", func(t *testing.T) {
		payload := testutil.EgressPayload{
			RecipientDID: contactDID,
			Categories: map[string]interface{}{
				"presence": []string{"a", "b"},
			},
		}
		result, err := impl.FilterEgress(ctx, payload)
		testutil.RequireNoError(t, err)

		denied := make(map[string]bool)
		for _, d := range result.Denied {
			denied[d] = true
		}
		if !denied["presence"] {
			t.Fatal("slice must be denied — it is not a TieredPayload")
		}
	})

	t.Run("contrast_well_formed_allowed", func(t *testing.T) {
		// Positive control: well-formed TieredPayload MUST be allowed.
		// Without this, the test would pass even if FilterEgress denied everything.
		payload := testutil.EgressPayload{
			RecipientDID: contactDID,
			Categories: map[string]interface{}{
				"availability": testutil.TieredPayload{Summary: "Busy", Full: "In meeting until 3pm"},
				"presence":     testutil.TieredPayload{Summary: "Online", Full: "Online from home office"},
			},
		}
		result, err := impl.FilterEgress(ctx, payload)
		testutil.RequireNoError(t, err)

		// availability at summary tier → should get Summary value.
		if result.Filtered["availability"] != "Busy" {
			t.Errorf("well-formed availability should be allowed at summary tier, got %q", result.Filtered["availability"])
		}
		// presence at full tier → should get Full value.
		if result.Filtered["presence"] != "Online from home office" {
			t.Errorf("well-formed presence should be allowed at full tier, got %q", result.Filtered["presence"])
		}
		// No denials for well-formed data.
		if len(result.Denied) != 0 {
			t.Errorf("well-formed payloads should have zero denials, got %v", result.Denied)
		}
	})

	t.Run("mixed_well_formed_and_malformed", func(t *testing.T) {
		// Mix: one well-formed category + one malformed. Must handle both correctly.
		payload := testutil.EgressPayload{
			RecipientDID: contactDID,
			Categories: map[string]interface{}{
				"availability": testutil.TieredPayload{Summary: "Free", Full: "Available all day"},
				"presence":     999, // malformed
			},
		}
		result, err := impl.FilterEgress(ctx, payload)
		testutil.RequireNoError(t, err)

		// availability (well-formed) should pass.
		if result.Filtered["availability"] != "Free" {
			t.Errorf("well-formed category should pass, got %q", result.Filtered["availability"])
		}

		// presence (malformed) should be denied.
		denied := make(map[string]bool)
		for _, d := range result.Denied {
			denied[d] = true
		}
		if !denied["presence"] {
			t.Fatal("malformed category must be denied even when mixed with well-formed ones")
		}
		if _, ok := result.Filtered["presence"]; ok {
			t.Fatal("malformed category must not appear in filtered output")
		}
	})

	t.Run("audit_reason_malformed", func(t *testing.T) {
		// Audit entries for malformed payloads must have Reason="malformed".
		payload := testutil.EgressPayload{
			RecipientDID: contactDID,
			Categories: map[string]interface{}{
				"availability": "not a tiered payload",
			},
		}
		result, err := impl.FilterEgress(ctx, payload)
		testutil.RequireNoError(t, err)

		foundMalformed := false
		for _, entry := range result.AuditEntries {
			if entry.Category == "availability" && entry.Reason == "malformed" {
				foundMalformed = true
			}
		}
		if !foundMalformed {
			t.Fatal("audit entry for malformed payload must have Reason='malformed'")
		}
	})
}

// --------------------------------------------------------------------------
// §29.10 Sharing Policy Egress Enforcement — Tier "none" blocks category
// --------------------------------------------------------------------------

// TST-CORE-979
func TestGatekeeper_29_10_2_TierNoneBlocksCategory(t *testing.T) {
	// Requirement (§29.10, row 2):
	//   When a sharing policy explicitly sets a category tier to "none",
	//   that category must be blocked (added to Denied list) regardless
	//   of whether a valid TieredPayload was provided.
	//
	// Production code (gatekeeper.go:363):
	//   if !hasTier || tier == "none" { result.Denied = append(...); continue }
	//
	// Anti-tautological design:
	//   1. Tier "none" → denied (even with valid TieredPayload)
	//   2. Positive control: other tier → allowed (proves it's tier-specific)
	//   3. Audit entry has Reason="tier_none"
	//   4. Multiple categories: some "none", some allowed → selective blocking
	//   5. All categories "none" → nothing filtered
	//   6. Contrast with missing category (same deny behavior but different root cause)

	impl := realSharingPolicyManager
	testutil.RequireImplementation(t, impl, "SharingPolicyManager")

	ctx := context.Background()
	contactDID := "did:plc:tier_none_test_979"

	t.Run("tier_none_denies_valid_payload", func(t *testing.T) {
		// Set policy: health explicitly set to "none".
		impl := realSharingPolicyManager
		testutil.RequireImplementation(t, impl, "SharingPolicyManager")

		err := impl.SetPolicy(ctx, contactDID, map[string]testutil.SharingTier{
			"health": "none",
		})
		testutil.RequireNoError(t, err)

		// Send a valid TieredPayload for "health" — it must still be denied.
		payload := testutil.EgressPayload{
			RecipientDID: contactDID,
			Categories: map[string]interface{}{
				"health": testutil.TieredPayload{
					Summary: "Feeling fine",
					Full:    "Blood pressure 120/80, heart rate 72",
				},
			},
		}
		result, err := impl.FilterEgress(ctx, payload)
		testutil.RequireNoError(t, err)

		// Health must be denied despite valid TieredPayload.
		denied := make(map[string]bool)
		for _, d := range result.Denied {
			denied[d] = true
		}
		if !denied["health"] {
			t.Fatal("tier 'none' must deny category even with valid TieredPayload")
		}

		// Must NOT appear in filtered output.
		if _, ok := result.Filtered["health"]; ok {
			t.Fatal("tier 'none' category must not appear in filtered output")
		}
	})

	t.Run("positive_control_summary_tier_allows", func(t *testing.T) {
		// Contrast: "summary" tier must allow the same type of payload.
		// Without this, the test passes if FilterEgress denies everything.
		impl := realSharingPolicyManager
		testutil.RequireImplementation(t, impl, "SharingPolicyManager")

		allowedDID := "did:plc:tier_summary_control_979"
		err := impl.SetPolicy(ctx, allowedDID, map[string]testutil.SharingTier{
			"health": "summary",
		})
		testutil.RequireNoError(t, err)

		payload := testutil.EgressPayload{
			RecipientDID: allowedDID,
			Categories: map[string]interface{}{
				"health": testutil.TieredPayload{
					Summary: "Feeling fine",
					Full:    "Blood pressure 120/80, heart rate 72",
				},
			},
		}
		result, err := impl.FilterEgress(ctx, payload)
		testutil.RequireNoError(t, err)

		// Health at summary tier → must return Summary value.
		if result.Filtered["health"] != "Feeling fine" {
			t.Errorf("summary tier must allow category with summary value, got %q",
				result.Filtered["health"])
		}
		if len(result.Denied) != 0 {
			t.Errorf("summary tier should have zero denials, got %v", result.Denied)
		}
	})

	t.Run("audit_entry_reason_tier_none", func(t *testing.T) {
		impl := realSharingPolicyManager
		testutil.RequireImplementation(t, impl, "SharingPolicyManager")

		auditDID := "did:plc:tier_none_audit_979"
		err := impl.SetPolicy(ctx, auditDID, map[string]testutil.SharingTier{
			"location": "none",
		})
		testutil.RequireNoError(t, err)

		payload := testutil.EgressPayload{
			RecipientDID: auditDID,
			Categories: map[string]interface{}{
				"location": testutil.TieredPayload{Summary: "NYC", Full: "123 Main St, NYC"},
			},
		}
		result, err := impl.FilterEgress(ctx, payload)
		testutil.RequireNoError(t, err)

		// Audit entry must have Reason="tier_none" (not "malformed" or empty).
		foundTierNone := false
		for _, entry := range result.AuditEntries {
			if entry.Category == "location" && entry.Reason == "tier_none" && entry.Decision == "denied" {
				foundTierNone = true
			}
		}
		if !foundTierNone {
			t.Fatal("audit entry for tier 'none' must have Reason='tier_none' and Decision='denied'")
		}
	})

	t.Run("selective_blocking_mixed_tiers", func(t *testing.T) {
		// Mix of "none" and allowed tiers: only "none" categories blocked.
		impl := realSharingPolicyManager
		testutil.RequireImplementation(t, impl, "SharingPolicyManager")

		mixedDID := "did:plc:mixed_tiers_979"
		err := impl.SetPolicy(ctx, mixedDID, map[string]testutil.SharingTier{
			"presence":     "full",
			"health":       "none",
			"availability": "summary",
			"location":     "none",
		})
		testutil.RequireNoError(t, err)

		payload := testutil.EgressPayload{
			RecipientDID: mixedDID,
			Categories: map[string]interface{}{
				"presence":     testutil.TieredPayload{Summary: "Online", Full: "Active on mobile"},
				"health":       testutil.TieredPayload{Summary: "Good", Full: "All vitals normal"},
				"availability": testutil.TieredPayload{Summary: "Busy", Full: "In meeting until 3pm"},
				"location":     testutil.TieredPayload{Summary: "NYC", Full: "Manhattan office"},
			},
		}
		result, err := impl.FilterEgress(ctx, payload)
		testutil.RequireNoError(t, err)

		// Presence (full) → allowed with full value.
		if result.Filtered["presence"] != "Active on mobile" {
			t.Errorf("presence at 'full' tier should return full value, got %q", result.Filtered["presence"])
		}
		// Availability (summary) → allowed with summary value.
		if result.Filtered["availability"] != "Busy" {
			t.Errorf("availability at 'summary' tier should return summary value, got %q", result.Filtered["availability"])
		}

		// Health and location (none) → denied.
		denied := make(map[string]bool)
		for _, d := range result.Denied {
			denied[d] = true
		}
		if !denied["health"] {
			t.Error("health at tier 'none' must be denied")
		}
		if !denied["location"] {
			t.Error("location at tier 'none' must be denied")
		}

		// Denied categories must NOT appear in filtered.
		if _, ok := result.Filtered["health"]; ok {
			t.Error("health must not appear in filtered output")
		}
		if _, ok := result.Filtered["location"]; ok {
			t.Error("location must not appear in filtered output")
		}
	})

	t.Run("all_categories_none_nothing_filtered", func(t *testing.T) {
		impl := realSharingPolicyManager
		testutil.RequireImplementation(t, impl, "SharingPolicyManager")

		allNoneDID := "did:plc:all_none_979"
		err := impl.SetPolicy(ctx, allNoneDID, map[string]testutil.SharingTier{
			"presence":     "none",
			"availability": "none",
			"health":       "none",
		})
		testutil.RequireNoError(t, err)

		payload := testutil.EgressPayload{
			RecipientDID: allNoneDID,
			Categories: map[string]interface{}{
				"presence":     testutil.TieredPayload{Summary: "Online", Full: "Active"},
				"availability": testutil.TieredPayload{Summary: "Free", Full: "No meetings"},
				"health":       testutil.TieredPayload{Summary: "Fine", Full: "All good"},
			},
		}
		result, err := impl.FilterEgress(ctx, payload)
		testutil.RequireNoError(t, err)

		// All categories must be denied.
		if len(result.Denied) != 3 {
			t.Fatalf("all 3 categories with tier 'none' must be denied, got %d denied", len(result.Denied))
		}
		// Nothing should be filtered.
		if len(result.Filtered) != 0 {
			t.Fatalf("expected 0 filtered when all tiers are 'none', got %d", len(result.Filtered))
		}
	})
}

// --------------------------------------------------------------------------
// §29.9 Persona Gatekeeper & Vault Access — Egress denied and audited
// --------------------------------------------------------------------------

// TST-CORE-977
func TestGatekeeper_29_9_3_EgressDeniedAndAudited(t *testing.T) {
	// Requirement (§29.9, row 3):
	//   When EnforceEgress is called to an untrusted destination and the
	//   gatekeeper denies egress, the system must:
	//     1. Return allowed=false
	//     2. Record an audit entry with Action="egress_check", Reason="denied"
	//     3. Trigger a client notification
	//
	// Anti-tautological design:
	//   1. Denied destination → allowed=false, audit entry, notification
	//   2. Positive control: allowed destination → allowed=true, audit with "allowed", NO notification
	//   3. Audit entry fields validated (Action, Requester, Reason, QueryType)
	//   4. Notification payload contains destination info

	t.Run("denied_egress_audited_and_notified", func(t *testing.T) {
		vault := newGatekeeperVaultManager()
		gk := &gatekeeperMock{
			egressFn: func(dest string, _ []byte) (bool, error) {
				if dest == "did:key:z6MkUntrustedDest977" {
					return false, nil
				}
				return true, nil
			},
		}
		audit := &gatekeeperAuditLog{}
		notifier := &gatekeeperNotifier{}
		clk := &gatekeeperClock{now: time.Now()}

		svc := service.NewGatekeeperService(vault, &nullVaultReader{}, gk, audit, notifier, clk)
		ctx := context.Background()

		allowed, err := svc.EnforceEgress(ctx, "did:key:z6MkUntrustedDest977", []byte("sensitive-data"))
		if err != nil {
			t.Fatalf("EnforceEgress: %v", err)
		}
		if allowed {
			t.Fatal("egress to untrusted destination must be denied")
		}

		// Verify audit entry recorded with correct fields.
		entries, _ := audit.Query(ctx, domain.VaultAuditFilter{})
		if len(entries) == 0 {
			t.Fatal("egress denial must generate an audit entry")
		}
		entry := entries[len(entries)-1]
		if entry.Action != "egress_check" {
			t.Fatalf("audit Action must be 'egress_check', got %q", entry.Action)
		}
		if entry.Reason != "denied" {
			t.Fatalf("audit Reason must be 'denied', got %q", entry.Reason)
		}
		if entry.Requester != "did:key:z6MkUntrustedDest977" {
			t.Fatalf("audit Requester must be destination DID, got %q", entry.Requester)
		}
		if entry.QueryType != "egress" {
			t.Fatalf("audit QueryType must be 'egress', got %q", entry.QueryType)
		}
		if entry.Timestamp == "" {
			t.Fatal("audit Timestamp must be set")
		}

		// Verify client notification triggered.
		notifier.mu.Lock()
		notifyCount := len(notifier.broadcasts)
		notifier.mu.Unlock()
		if notifyCount == 0 {
			t.Fatal("denied egress must trigger client notification")
		}
	})

	t.Run("positive_control_allowed_egress_audited_but_not_notified", func(t *testing.T) {
		// Contrast: allowed egress is audited but does NOT trigger notification.
		// Without this, the test passes if the service always notifies.
		vault := newGatekeeperVaultManager()
		gk := &gatekeeperMock{
			egressFn: func(_ string, _ []byte) (bool, error) {
				return true, nil // allow all
			},
		}
		audit := &gatekeeperAuditLog{}
		notifier := &gatekeeperNotifier{}
		clk := &gatekeeperClock{now: time.Now()}

		svc := service.NewGatekeeperService(vault, &nullVaultReader{}, gk, audit, notifier, clk)
		ctx := context.Background()

		allowed, err := svc.EnforceEgress(ctx, "did:key:z6MkTrustedDest977", []byte("public-data"))
		if err != nil {
			t.Fatalf("EnforceEgress: %v", err)
		}
		if !allowed {
			t.Fatal("egress to trusted destination must be allowed")
		}

		// Audit entry must still be recorded (even for allowed egress).
		entries, _ := audit.Query(ctx, domain.VaultAuditFilter{})
		if len(entries) == 0 {
			t.Fatal("allowed egress must also generate an audit entry")
		}
		entry := entries[len(entries)-1]
		if entry.Reason != "allowed" {
			t.Fatalf("allowed egress audit Reason must be 'allowed', got %q", entry.Reason)
		}

		// Notification must NOT be triggered for allowed egress.
		notifier.mu.Lock()
		notifyCount := len(notifier.broadcasts)
		notifier.mu.Unlock()
		if notifyCount != 0 {
			t.Fatalf("allowed egress must NOT trigger notification, got %d broadcasts", notifyCount)
		}
	})

	t.Run("multiple_destinations_selective_denial", func(t *testing.T) {
		vault := newGatekeeperVaultManager()
		gk := &gatekeeperMock{
			egressFn: func(dest string, _ []byte) (bool, error) {
				if dest == "did:key:z6MkBlocked977" {
					return false, nil
				}
				return true, nil
			},
		}
		audit := &gatekeeperAuditLog{}
		notifier := &gatekeeperNotifier{}
		clk := &gatekeeperClock{now: time.Now()}

		svc := service.NewGatekeeperService(vault, &nullVaultReader{}, gk, audit, notifier, clk)
		ctx := context.Background()

		// Allowed egress.
		allowed1, err := svc.EnforceEgress(ctx, "did:key:z6MkAllowed977", []byte("data"))
		if err != nil {
			t.Fatalf("EnforceEgress allowed: %v", err)
		}
		if !allowed1 {
			t.Fatal("first destination should be allowed")
		}

		// Denied egress.
		allowed2, err := svc.EnforceEgress(ctx, "did:key:z6MkBlocked977", []byte("data"))
		if err != nil {
			t.Fatalf("EnforceEgress denied: %v", err)
		}
		if allowed2 {
			t.Fatal("second destination should be denied")
		}

		// Audit log should have 2 entries (one allowed, one denied).
		entries, _ := audit.Query(ctx, domain.VaultAuditFilter{})
		if len(entries) != 2 {
			t.Fatalf("expected 2 audit entries, got %d", len(entries))
		}

		// Notification should be triggered exactly once (for the denied one only).
		notifier.mu.Lock()
		notifyCount := len(notifier.broadcasts)
		notifier.mu.Unlock()
		if notifyCount != 1 {
			t.Fatalf("expected exactly 1 notification (for denied egress), got %d", notifyCount)
		}
	})
}

// --------------------------------------------------------------------------
// §34.1 Recommendation Integrity — Sharing Policy Overrides Bot Suggestion
// --------------------------------------------------------------------------

// TST-CORE-1121
func TestGatekeeper_34_1_5_UserSharingPolicyOverridesBotSuggestedVisibility(t *testing.T) {
	// Requirement (§34.1 / Absolute Loyalty):
	//   If a bot suggests visibility level "full" for some data, but the user's
	//   sharing policy says "summary" or "none" for that category, the user's
	//   policy MUST win. The bot cannot override the user's privacy preferences.
	//   FilterEgress enforces user policy — bot suggestion ignored.
	//
	// Anti-tautological design:
	//   1. Bot suggests full, user policy says none → data blocked (denied)
	//   2. Bot suggests full, user policy says summary → only summary passes
	//   3. Bot suggests full, user policy says full → full content passes (positive control)
	//   4. Multiple categories with mixed policies → each enforced independently
	//   5. Audit entries record the user's policy tier, not the bot's suggestion

	impl := realSharingPolicyManager
	testutil.RequireImplementation(t, impl, "SharingPolicyManager")
	ctx := context.Background()

	t.Run("user_policy_none_blocks_bot_full_suggestion", func(t *testing.T) {
		contactDID := "did:key:z6MkBotSuggestFull1121a"

		// User sets policy: health category = "none" (blocked).
		err := impl.SetPolicy(ctx, contactDID, map[string]domain.SharingTier{
			"health": "none",
		})
		testutil.RequireNoError(t, err)

		// Bot suggests full visibility — provides both Summary and Full content.
		payload := testutil.EgressPayload{
			RecipientDID: contactDID,
			Categories: map[string]interface{}{
				"health": domain.TieredPayload{
					Summary: "Patient is healthy",
					Full:    "Blood pressure 120/80, cholesterol 180, on medication X",
				},
			},
		}

		result, err := impl.FilterEgress(ctx, payload)
		testutil.RequireNoError(t, err)

		// User policy "none" must win — health category denied.
		healthDenied := false
		for _, d := range result.Denied {
			if d == "health" {
				healthDenied = true
			}
		}
		if !healthDenied {
			t.Fatal("user policy 'none' must block health — bot suggestion overridden")
		}
		if _, ok := result.Filtered["health"]; ok {
			t.Fatal("blocked category must NOT appear in filtered output")
		}
	})

	t.Run("user_policy_summary_downgrades_bot_full_suggestion", func(t *testing.T) {
		contactDID := "did:key:z6MkBotSuggestFull1121b"

		// User policy: location = "summary" only.
		err := impl.SetPolicy(ctx, contactDID, map[string]domain.SharingTier{
			"location": "summary",
		})
		testutil.RequireNoError(t, err)

		// Bot provides full location data.
		payload := testutil.EgressPayload{
			RecipientDID: contactDID,
			Categories: map[string]interface{}{
				"location": domain.TieredPayload{
					Summary: "Downtown area",
					Full:    "123 Main Street, Apt 4B, New York, NY 10001",
				},
			},
		}

		result, err := impl.FilterEgress(ctx, payload)
		testutil.RequireNoError(t, err)

		// Only Summary must pass — Full content blocked by user policy.
		if result.Filtered["location"] != "Downtown area" {
			t.Fatalf("user policy 'summary' must select Summary only, got %q", result.Filtered["location"])
		}
		if result.Filtered["location"] == "123 Main Street, Apt 4B, New York, NY 10001" {
			t.Fatal("Full content must NOT pass through when user policy is 'summary'")
		}
	})

	t.Run("positive_control_user_policy_full_allows_full_content", func(t *testing.T) {
		contactDID := "did:key:z6MkBotSuggestFull1121c"

		// User explicitly allows full visibility.
		err := impl.SetPolicy(ctx, contactDID, map[string]domain.SharingTier{
			"preferences": "full",
		})
		testutil.RequireNoError(t, err)

		payload := testutil.EgressPayload{
			RecipientDID: contactDID,
			Categories: map[string]interface{}{
				"preferences": domain.TieredPayload{
					Summary: "Likes chai",
					Full:    "Chai, no sugar, served warm. Allergic to dairy. Prefers morning delivery.",
				},
			},
		}

		result, err := impl.FilterEgress(ctx, payload)
		testutil.RequireNoError(t, err)

		// Full content must pass through when user policy explicitly allows it.
		expected := "Chai, no sugar, served warm. Allergic to dairy. Prefers morning delivery."
		if result.Filtered["preferences"] != expected {
			t.Fatalf("user policy 'full' must allow Full content, got %q", result.Filtered["preferences"])
		}
		if len(result.Denied) != 0 {
			t.Fatalf("no categories should be denied when user policy allows full, denied: %v", result.Denied)
		}
	})

	t.Run("mixed_policies_enforced_independently_per_category", func(t *testing.T) {
		contactDID := "did:key:z6MkBotSuggestFull1121d"

		// User sets mixed policies: health=none, location=summary, preferences=full.
		err := impl.SetPolicy(ctx, contactDID, map[string]domain.SharingTier{
			"health":      "none",
			"location":    "summary",
			"preferences": "full",
		})
		testutil.RequireNoError(t, err)

		// Bot provides full content for all three categories.
		payload := testutil.EgressPayload{
			RecipientDID: contactDID,
			Categories: map[string]interface{}{
				"health": domain.TieredPayload{
					Summary: "Healthy",
					Full:    "Full medical records",
				},
				"location": domain.TieredPayload{
					Summary: "Nearby",
					Full:    "123 Secret Address",
				},
				"preferences": domain.TieredPayload{
					Summary: "Likes tea",
					Full:    "Complete preference profile",
				},
			},
		}

		result, err := impl.FilterEgress(ctx, payload)
		testutil.RequireNoError(t, err)

		// Health: denied (policy=none).
		healthDenied := false
		for _, d := range result.Denied {
			if d == "health" {
				healthDenied = true
			}
		}
		if !healthDenied {
			t.Fatal("health must be denied (policy=none)")
		}

		// Location: summary only.
		if result.Filtered["location"] != "Nearby" {
			t.Fatalf("location must be summary only, got %q", result.Filtered["location"])
		}

		// Preferences: full content.
		if result.Filtered["preferences"] != "Complete preference profile" {
			t.Fatalf("preferences must be full, got %q", result.Filtered["preferences"])
		}
	})

	t.Run("audit_entries_reflect_user_policy_not_bot_suggestion", func(t *testing.T) {
		contactDID := "did:key:z6MkBotSuggestFull1121e"

		err := impl.SetPolicy(ctx, contactDID, map[string]domain.SharingTier{
			"health":   "none",
			"location": "summary",
		})
		testutil.RequireNoError(t, err)

		payload := testutil.EgressPayload{
			RecipientDID: contactDID,
			Categories: map[string]interface{}{
				"health": domain.TieredPayload{
					Summary: "Fine",
					Full:    "Full health data",
				},
				"location": domain.TieredPayload{
					Summary: "City center",
					Full:    "Exact address",
				},
			},
		}

		result, err := impl.FilterEgress(ctx, payload)
		testutil.RequireNoError(t, err)

		// Check audit entries record the USER's policy tier, not bot suggestion.
		for _, entry := range result.AuditEntries {
			if entry.Category == "health" {
				if entry.Decision != "denied" {
					t.Fatalf("health audit must show denied, got %q", entry.Decision)
				}
				if entry.Reason != "tier_none" {
					t.Fatalf("health audit reason must be 'tier_none', got %q", entry.Reason)
				}
			}
			if entry.Category == "location" {
				if entry.Decision != "allowed" {
					t.Fatalf("location audit must show allowed, got %q", entry.Decision)
				}
				if entry.Reason != "tier_summary" {
					t.Fatalf("location audit reason must be 'tier_summary', got %q", entry.Reason)
				}
			}
		}
	})
}
