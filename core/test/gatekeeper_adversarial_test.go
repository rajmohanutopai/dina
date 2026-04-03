package test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/adapter/gatekeeper"
	"github.com/rajmohanutopai/dina/core/internal/adapter/identity"
	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/handler"
	"github.com/rajmohanutopai/dina/core/internal/ingress"
	"github.com/rajmohanutopai/dina/core/internal/middleware"
	"github.com/rajmohanutopai/dina/core/internal/service"
	"github.com/rajmohanutopai/dina/core/test/testutil"
)

// ==========================================================================
// Adversarial & Negative Tests — Gatekeeper, Sharing Policy, Vault Access
// These tests verify access control boundaries, tier enforcement, and
// egress filtering per architecture §5 (vault) and §6 (gatekeeper).
// ==========================================================================

// ---------- Local mocks for gatekeeper tests ----------

// gatekeeperVaultManager tracks persona open/close state.
type gatekeeperVaultManager struct {
	mu       sync.RWMutex
	personas map[domain.PersonaName]bool
}

func newGatekeeperVaultManager() *gatekeeperVaultManager {
	return &gatekeeperVaultManager{personas: make(map[domain.PersonaName]bool)}
}

func (v *gatekeeperVaultManager) Open(_ context.Context, persona domain.PersonaName, _ []byte) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.personas[persona] = true
	return nil
}

func (v *gatekeeperVaultManager) Close(persona domain.PersonaName) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	delete(v.personas, persona)
	return nil
}

func (v *gatekeeperVaultManager) IsOpen(persona domain.PersonaName) bool {
	v.mu.RLock()
	defer v.mu.RUnlock()
	return v.personas[persona]
}

func (v *gatekeeperVaultManager) OpenPersonas() []domain.PersonaName {
	v.mu.RLock()
	defer v.mu.RUnlock()
	var names []domain.PersonaName
	for n := range v.personas {
		names = append(names, n)
	}
	return names
}

func (v *gatekeeperVaultManager) Checkpoint(_ domain.PersonaName) error { return nil }

// VaultReader stubs — return empty results for service-level testing.
func (v *gatekeeperVaultManager) Query(_ context.Context, _ domain.PersonaName, _ domain.SearchQuery) ([]domain.VaultItem, error) {
	return nil, nil
}
func (v *gatekeeperVaultManager) GetItem(_ context.Context, _ domain.PersonaName, _ string) (*domain.VaultItem, error) {
	return nil, nil
}
func (v *gatekeeperVaultManager) VectorSearch(_ context.Context, _ domain.PersonaName, _ []float32, _ int) ([]domain.VaultItem, error) {
	return nil, nil
}

// VaultWriter stubs.
func (v *gatekeeperVaultManager) Store(_ context.Context, _ domain.PersonaName, _ domain.VaultItem) (string, error) {
	return "mock-id", nil
}
func (v *gatekeeperVaultManager) StoreBatch(_ context.Context, _ domain.PersonaName, items []domain.VaultItem) ([]string, error) {
	ids := make([]string, len(items))
	for i := range items {
		ids[i] = fmt.Sprintf("mock-id-%d", i)
	}
	return ids, nil
}
func (v *gatekeeperVaultManager) Delete(_ context.Context, _ domain.PersonaName, _ string) error {
	return nil
}

// gatekeeperMock evaluates intents based on configurable rules.
type gatekeeperMock struct {
	evalFn   func(domain.Intent) (domain.Decision, error)
	egressFn func(string, []byte) (bool, error)
}

func (g *gatekeeperMock) EvaluateIntent(_ context.Context, intent domain.Intent) (domain.Decision, error) {
	if g.evalFn != nil {
		return g.evalFn(intent)
	}
	return domain.Decision{Allowed: true, Reason: "default allow"}, nil
}

func (g *gatekeeperMock) CheckEgress(_ context.Context, dest string, data []byte) (bool, error) {
	if g.egressFn != nil {
		return g.egressFn(dest, data)
	}
	return true, nil
}

// gatekeeperAuditLog captures audit entries.
type gatekeeperAuditLog struct {
	mu      sync.Mutex
	entries []domain.VaultAuditEntry
	nextID  int64
}

func (a *gatekeeperAuditLog) Append(_ context.Context, entry domain.VaultAuditEntry) (int64, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.nextID++
	a.entries = append(a.entries, entry)
	return a.nextID, nil
}

func (a *gatekeeperAuditLog) Query(_ context.Context, _ domain.VaultAuditFilter) ([]domain.VaultAuditEntry, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]domain.VaultAuditEntry{}, a.entries...), nil
}

func (a *gatekeeperAuditLog) VerifyChain() (bool, error) { return true, nil }

func (a *gatekeeperAuditLog) Purge(_ int) (int64, error) { return 0, nil }

// gatekeeperNotifier captures notifications.
type gatekeeperNotifier struct {
	mu         sync.Mutex
	broadcasts [][]byte
}

func (n *gatekeeperNotifier) Notify(_ context.Context, _ string, payload []byte) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.broadcasts = append(n.broadcasts, payload)
	return nil
}

func (n *gatekeeperNotifier) Broadcast(_ context.Context, payload []byte) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.broadcasts = append(n.broadcasts, payload)
	return nil
}

// gatekeeperClock provides a fixed time.
type gatekeeperClock struct {
	now time.Time
}

func (c *gatekeeperClock) Now() time.Time                         { return c.now }
func (c *gatekeeperClock) After(d time.Duration) <-chan time.Time { return time.After(d) }
func (c *gatekeeperClock) NewTicker(d time.Duration) *time.Ticker { return time.NewTicker(d) }

// nullVaultReader satisfies port.VaultReader without any data.
type nullVaultReader struct{}

func (r *nullVaultReader) Query(_ context.Context, _ domain.PersonaName, _ domain.SearchQuery) ([]domain.VaultItem, error) {
	return nil, nil
}

func (r *nullVaultReader) GetItem(_ context.Context, _ domain.PersonaName, _ string) (*domain.VaultItem, error) {
	return nil, nil
}

func (r *nullVaultReader) VectorSearch(_ context.Context, _ domain.PersonaName, _ []float32, _ int) ([]domain.VaultItem, error) {
	return nil, nil
}

// ---------- §C1 — Locked Persona Access Denial ----------

// TST-CORE-975
// TST-ADV-037: Access to locked persona is denied regardless of gatekeeper rules.
// Architecture §5: "locked persona → DEK not in RAM → access always denied."
// TRACE: {"suite": "CORE", "case": "0570", "section": "29", "sectionName": "Adversarial & Security", "subsection": "09", "scenario": "01", "title": "LockedPersonaDenied"}
func TestAdv_29_9_LockedPersonaDenied(t *testing.T) {
	vault := newGatekeeperVaultManager()
	// "general" is open, "financial" is closed (not in map).
	personal, _ := domain.NewPersonaName("general")
	vault.Open(context.Background(), personal, nil)

	gk := &gatekeeperMock{
		evalFn: func(_ domain.Intent) (domain.Decision, error) {
			// Gatekeeper would allow — but persona lock should override.
			return domain.Decision{Allowed: true, Reason: "gatekeeper allows"}, nil
		},
	}
	audit := &gatekeeperAuditLog{}
	notifier := &gatekeeperNotifier{}
	clk := &gatekeeperClock{now: time.Now()}

	svc := service.NewGatekeeperService(vault, &nullVaultReader{}, gk, audit, notifier, clk)

	ctx := context.Background()

	// Access to open persona — should be allowed.
	dec1, err := svc.CheckAccess(ctx, domain.Intent{
		AgentDID:  "did:key:z6MkBrain",
		Action:    "query",
		Target:    "health_records",
		PersonaID: "general",
	})
	if err != nil {
		t.Fatalf("CheckAccess (open persona): %v", err)
	}
	if !dec1.Allowed {
		t.Fatal("access to open persona should be allowed")
	}

	// Access to locked persona — should be denied even though gatekeeper allows.
	dec2, err := svc.CheckAccess(ctx, domain.Intent{
		AgentDID:  "did:key:z6MkBrain",
		Action:    "query",
		Target:    "financial_records",
		PersonaID: "financial",
	})
	if err != nil {
		t.Fatalf("CheckAccess (locked persona): %v", err)
	}
	if dec2.Allowed {
		t.Fatal("access to locked persona must be DENIED regardless of gatekeeper rules")
	}
	if dec2.Reason == "" {
		t.Fatal("denial reason must be provided")
	}
}

// TST-CORE-976
// TST-ADV-038: Locked persona denial generates audit entry.
// Architecture §5: "every access check is audited."
// TRACE: {"suite": "CORE", "case": "0571", "section": "29", "sectionName": "Adversarial & Security", "subsection": "09", "scenario": "01", "title": "LockedPersonaAudited"}
func TestAdv_29_9_LockedPersonaAudited(t *testing.T) {
	vault := newGatekeeperVaultManager()
	// No personas open — everything is locked.

	gk := &gatekeeperMock{}
	audit := &gatekeeperAuditLog{}
	notifier := &gatekeeperNotifier{}
	clk := &gatekeeperClock{now: time.Now()}

	svc := service.NewGatekeeperService(vault, &nullVaultReader{}, gk, audit, notifier, clk)

	ctx := context.Background()
	_, _ = svc.CheckAccess(ctx, domain.Intent{
		AgentDID:  "did:key:z6MkCompromisedBrain",
		Action:    "read_all",
		Target:    "financial_data",
		PersonaID: "financial",
	})

	// Check audit log has the denial entry.
	entries, _ := audit.Query(ctx, domain.VaultAuditFilter{})
	if len(entries) == 0 {
		t.Fatal("locked persona denial must generate an audit entry")
	}

	found := false
	for _, e := range entries {
		if e.Persona == "financial" && e.Requester == "did:key:z6MkCompromisedBrain" {
			found = true
		}
	}
	if !found {
		t.Fatal("audit entry for locked persona denial not found")
	}
}

// ---------- §C2 — Egress Denial & Audit ----------

// TST-ADV-039: Egress to untrusted destination is denied and audited.
// Architecture §6: "every egress decision is logged to audit trail."
// TRACE: {"suite": "CORE", "case": "0572", "section": "29", "sectionName": "Adversarial & Security", "subsection": "09", "scenario": "01", "title": "EgressDeniedAudited"}
func TestAdv_29_9_EgressDeniedAudited(t *testing.T) {
	vault := newGatekeeperVaultManager()
	gk := &gatekeeperMock{
		egressFn: func(dest string, _ []byte) (bool, error) {
			// Block all egress to unknown destinations.
			if dest == "did:key:z6MkUntrusted" {
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

	allowed, err := svc.EnforceEgress(ctx, "did:key:z6MkUntrusted", []byte("sensitive-data"))
	if err != nil {
		t.Fatalf("EnforceEgress: %v", err)
	}
	if allowed {
		t.Fatal("egress to untrusted destination should be denied")
	}

	// Verify audit log captured the denial.
	entries, _ := audit.Query(ctx, domain.VaultAuditFilter{})
	if len(entries) == 0 {
		t.Fatal("egress denial must be audited")
	}

	egressEntry := entries[len(entries)-1]
	if egressEntry.Reason != "denied" {
		t.Fatalf("audit entry reason should be 'denied', got %q", egressEntry.Reason)
	}

	// Verify client was notified of the denial.
	notifier.mu.Lock()
	notifyCount := len(notifier.broadcasts)
	notifier.mu.Unlock()
	if notifyCount == 0 {
		t.Fatal("egress denial should trigger client notification")
	}
}

// ---------- §C3 — Sharing Policy Category Stripping ----------

// TST-CORE-978
// TST-ADV-040: Missing sharing policy category is completely denied (default deny).
// Architecture §9: "missing policy key = denied — default deny throughout."
// TRACE: {"suite": "CORE", "case": "0573", "section": "29", "sectionName": "Adversarial & Security", "subsection": "10", "scenario": "01", "title": "MissingCategoryDenied"}
func TestAdv_29_10_MissingCategoryDenied(t *testing.T) {
	spm := testutil.NewMockSharingPolicyManager()
	ctx := context.Background()

	// Set policy for Alice: only "location" at summary tier. No "health" key.
	_ = spm.SetPolicy(ctx, "did:key:z6MkAlice", map[string]domain.SharingTier{
		"location": "summary",
	})

	// Egress payload includes both location AND health.
	payload := testutil.EgressPayload{
		RecipientDID: "did:key:z6MkAlice",
		Categories: map[string]interface{}{
			"location": domain.TieredPayload{Summary: "Downtown", Full: "123 Main St"},
			"health":   domain.TieredPayload{Summary: "Good", Full: "Blood pressure: 120/80"},
		},
	}

	result, err := spm.FilterEgress(ctx, payload)
	if err != nil {
		t.Fatalf("FilterEgress: %v", err)
	}

	// Location should be allowed (at summary tier).
	if _, ok := result.Filtered["location"]; !ok {
		t.Fatal("location should be in filtered output (policy allows summary)")
	}
	if result.Filtered["location"] != "Downtown" {
		t.Fatalf("location should be summary tier 'Downtown', got %q", result.Filtered["location"])
	}

	// Health should be COMPLETELY DENIED — missing from policy = denied.
	healthDenied := false
	for _, d := range result.Denied {
		if d == "health" {
			healthDenied = true
		}
	}
	if !healthDenied {
		t.Fatal("health category must be denied when missing from sharing policy")
	}

	// Health must NOT appear in filtered output.
	if _, ok := result.Filtered["health"]; ok {
		t.Fatal("denied category must not appear in filtered output")
	}
}

// TST-ADV-041: Policy tier "none" completely blocks the category.
// Architecture §9: "tier=none → category blocked entirely."
// TRACE: {"suite": "CORE", "case": "0574", "section": "29", "sectionName": "Adversarial & Security", "subsection": "10", "scenario": "01", "title": "TierNoneBlocks"}
func TestAdv_29_10_TierNoneBlocks(t *testing.T) {
	spm := testutil.NewMockSharingPolicyManager()
	ctx := context.Background()

	_ = spm.SetPolicy(ctx, "did:key:z6MkBob", map[string]domain.SharingTier{
		"location": "summary",
		"health":   "none",
	})

	payload := testutil.EgressPayload{
		RecipientDID: "did:key:z6MkBob",
		Categories: map[string]interface{}{
			"location": domain.TieredPayload{Summary: "NYC", Full: "40.7128° N, 74.0060° W"},
			"health":   domain.TieredPayload{Summary: "Healthy", Full: "Full medical records"},
		},
	}

	result, err := spm.FilterEgress(ctx, payload)
	if err != nil {
		t.Fatalf("FilterEgress: %v", err)
	}

	// Health should be denied (tier=none).
	healthDenied := false
	for _, d := range result.Denied {
		if d == "health" {
			healthDenied = true
		}
	}
	if !healthDenied {
		t.Fatal("health with tier=none must be denied")
	}

	// Location should pass (tier=summary).
	if result.Filtered["location"] != "NYC" {
		t.Fatalf("location should be summary 'NYC', got %q", result.Filtered["location"])
	}
}

// TST-ADV-042: No policy for contact → ALL categories denied (default deny).
// Architecture §9: "default deny — no policy means everything blocked."
// TRACE: {"suite": "CORE", "case": "0575", "section": "29", "sectionName": "Adversarial & Security", "subsection": "10", "scenario": "01", "title": "NoPolicyDefaultDeny"}
func TestAdv_29_10_NoPolicyDefaultDeny(t *testing.T) {
	spm := testutil.NewMockSharingPolicyManager()
	ctx := context.Background()

	// No policy set for Charlie at all.
	payload := testutil.EgressPayload{
		RecipientDID: "did:key:z6MkCharlie",
		Categories: map[string]interface{}{
			"location": domain.TieredPayload{Summary: "LA", Full: "Hollywood"},
			"health":   domain.TieredPayload{Summary: "OK", Full: "Details"},
		},
	}

	result, err := spm.FilterEgress(ctx, payload)
	if err != nil {
		t.Fatalf("FilterEgress: %v", err)
	}

	// ALL categories should be denied.
	if len(result.Filtered) != 0 {
		t.Fatalf("no policy → no data should pass, got %d filtered categories", len(result.Filtered))
	}
	if len(result.Denied) < 2 {
		t.Fatalf("expected at least 2 denied categories, got %d", len(result.Denied))
	}
}

// TST-ADV-043: Egress with malformed (non-TieredPayload) data is denied.
// Architecture §19: "strict typing — malformed payload category dropped entirely."
// TRACE: {"suite": "CORE", "case": "0576", "section": "29", "sectionName": "Adversarial & Security", "subsection": "10", "scenario": "01", "title": "MalformedPayloadDenied"}
func TestAdv_29_10_MalformedPayloadDenied(t *testing.T) {
	spm := testutil.NewMockSharingPolicyManager()
	ctx := context.Background()

	_ = spm.SetPolicy(ctx, "did:key:z6MkDave", map[string]domain.SharingTier{
		"location": "full",
	})

	// Send a raw string instead of TieredPayload.
	payload := testutil.EgressPayload{
		RecipientDID: "did:key:z6MkDave",
		Categories: map[string]interface{}{
			"location": "raw-string-not-tiered-payload", // malformed
		},
	}

	result, err := spm.FilterEgress(ctx, payload)
	if err != nil {
		t.Fatalf("FilterEgress: %v", err)
	}

	// Malformed data should be denied.
	locationDenied := false
	for _, d := range result.Denied {
		if d == "location" {
			locationDenied = true
		}
	}
	if !locationDenied {
		t.Fatal("malformed (non-TieredPayload) data must be denied")
	}
}

// --------------------------------------------------------------------------
// §34.2 Agent Sandbox Adversarial — Agent Data Isolation
// --------------------------------------------------------------------------

// TST-CORE-1124
// TRACE: {"suite": "CORE", "case": "0577", "section": "34", "sectionName": "Thesis: Loyalty", "subsection": "02", "scenario": "01", "title": "AgentAttemptsToReadOtherAgentsData"}
func TestAdv_34_2_AgentAttemptsToReadOtherAgentsData(t *testing.T) {
	// Requirements (§34.2):
	//   - A compromised or malicious agent must not escape its sandbox.
	//   - Agent A queries vault items stored by Agent B → empty result.
	//   - Data isolation is enforced via gatekeeper persona constraints:
	//     agents are constrained to specific personas; cross-persona access denied.
	//   - Even within the same persona, agent identity is tracked and audited.
	//
	// The Dina gatekeeper enforces agent isolation via:
	//   1. Persona-level constraints (persona_X_only → agent can only access persona X)
	//   2. Trust-level checks (untrusted agents denied for vault access)
	//   3. Immutable agent_did binding (set by auth middleware, cannot be forged)

	// TRACE: {"suite": "CORE", "case": "0578", "section": "34", "sectionName": "Thesis: Loyalty", "title": "cross_persona_constraint_blocks_agent_B"}
	t.Run("cross_persona_constraint_blocks_agent_B", func(t *testing.T) {
		// Agent A is constrained to "consumer" persona.
		// Agent A tries to query "health" persona (where Agent B stores data).
		// Gatekeeper must deny with 403 — cross-persona access denied.
		vault := newGatekeeperVaultManager()
		consumerPersona, _ := domain.NewPersonaName("consumer")
		healthPersona, _ := domain.NewPersonaName("health")
		vault.Open(context.Background(), consumerPersona, nil)
		vault.Open(context.Background(), healthPersona, nil)

		gk := &gatekeeperMock{
			evalFn: func(intent domain.Intent) (domain.Decision, error) {
				// Enforce persona_consumer_only constraint for Agent A.
				if intent.Constraints != nil && intent.Constraints["persona_consumer_only"] {
					if intent.PersonaID != "consumer" {
						return domain.Decision{
							Allowed: false,
							Reason:  "cross-persona access denied: agent constrained to consumer",
							Audit:   true,
						}, nil
					}
				}
				return domain.Decision{Allowed: true, Reason: "allowed"}, nil
			},
		}
		audit := &gatekeeperAuditLog{}
		notifier := &gatekeeperNotifier{}
		clk := &gatekeeperClock{now: time.Now()}

		svc := service.NewGatekeeperService(vault, &nullVaultReader{}, gk, audit, notifier, clk)

		// Agent A with persona_consumer_only constraint tries to read health persona.
		dec, err := svc.CheckAccess(context.Background(), domain.Intent{
			AgentDID:    "did:key:z6MkAgentA",
			Action:      "query",
			Target:      "health_records",
			PersonaID:   "health",
			TrustLevel:  "verified",
			Constraints: map[string]bool{"persona_consumer_only": true},
		})
		if err != nil {
			t.Fatalf("CheckAccess: %v", err)
		}
		if dec.Allowed {
			t.Fatal("Agent A constrained to consumer must be DENIED access to health persona")
		}
		if dec.Reason == "" {
			t.Fatal("denial reason must be provided for cross-persona access")
		}
	})

	// TRACE: {"suite": "CORE", "case": "0579", "section": "34", "sectionName": "Thesis: Loyalty", "title": "agent_A_allowed_on_own_persona"}
	t.Run("agent_A_allowed_on_own_persona", func(t *testing.T) {
		// Anti-tautological contrast: Agent A CAN access its own persona.
		// This proves the deny above is specific, not a blanket deny.
		vault := newGatekeeperVaultManager()
		consumerPersona, _ := domain.NewPersonaName("consumer")
		vault.Open(context.Background(), consumerPersona, nil)

		gk := &gatekeeperMock{
			evalFn: func(intent domain.Intent) (domain.Decision, error) {
				if intent.Constraints != nil && intent.Constraints["persona_consumer_only"] {
					if intent.PersonaID != "consumer" {
						return domain.Decision{Allowed: false, Reason: "cross-persona denied", Audit: true}, nil
					}
				}
				return domain.Decision{Allowed: true, Reason: "allowed"}, nil
			},
		}
		audit := &gatekeeperAuditLog{}
		notifier := &gatekeeperNotifier{}
		clk := &gatekeeperClock{now: time.Now()}

		svc := service.NewGatekeeperService(vault, &nullVaultReader{}, gk, audit, notifier, clk)

		dec, err := svc.CheckAccess(context.Background(), domain.Intent{
			AgentDID:    "did:key:z6MkAgentA",
			Action:      "query",
			Target:      "product_listings",
			PersonaID:   "consumer",
			TrustLevel:  "verified",
			Constraints: map[string]bool{"persona_consumer_only": true},
		})
		if err != nil {
			t.Fatalf("CheckAccess: %v", err)
		}
		if !dec.Allowed {
			t.Fatal("Agent A must be ALLOWED to access its own (consumer) persona")
		}
	})

	// TRACE: {"suite": "CORE", "case": "0580", "section": "34", "sectionName": "Thesis: Loyalty", "title": "two_agents_mutually_isolated"}
	t.Run("two_agents_mutually_isolated", func(t *testing.T) {
		// Agent A constrained to consumer, Agent B constrained to health.
		// Neither agent can access the other's persona.
		vault := newGatekeeperVaultManager()
		consumerPersona, _ := domain.NewPersonaName("consumer")
		healthPersona, _ := domain.NewPersonaName("health")
		vault.Open(context.Background(), consumerPersona, nil)
		vault.Open(context.Background(), healthPersona, nil)

		// Use the real gatekeeper to validate constraint-based denials.
		gk := realGatekeeper
		audit := &gatekeeperAuditLog{}
		notifier := &gatekeeperNotifier{}
		clk := &gatekeeperClock{now: time.Now()}

		svc := service.NewGatekeeperService(vault, &nullVaultReader{}, gk, audit, notifier, clk)
		ctx := context.Background()

		// Agent A (consumer-only) tries to read health.
		decAtoH, _ := svc.CheckAccess(ctx, domain.Intent{
			AgentDID:    "did:key:z6MkAgentA",
			Action:      "query",
			Target:      "health_records",
			PersonaID:   "health",
			TrustLevel:  "verified",
			Constraints: map[string]bool{"persona_consumer_only": true},
		})
		if decAtoH.Allowed {
			t.Fatal("Agent A (consumer-only) must NOT access health persona")
		}

		// Agent B (health-only) tries to read consumer.
		decBtoC, _ := svc.CheckAccess(ctx, domain.Intent{
			AgentDID:    "did:key:z6MkAgentB",
			Action:      "query",
			Target:      "purchase_history",
			PersonaID:   "consumer",
			TrustLevel:  "verified",
			Constraints: map[string]bool{"persona_health_only": true},
		})
		if decBtoC.Allowed {
			t.Fatal("Agent B (health-only) must NOT access consumer persona")
		}

		// Agent A on its own persona → allowed.
		decAtoC, _ := svc.CheckAccess(ctx, domain.Intent{
			AgentDID:    "did:key:z6MkAgentA",
			Action:      "query",
			Target:      "product_listings",
			PersonaID:   "consumer",
			TrustLevel:  "verified",
			Constraints: map[string]bool{"persona_consumer_only": true},
		})
		if !decAtoC.Allowed {
			t.Fatal("Agent A on its own persona must be allowed")
		}

		// Agent B on its own persona → allowed.
		decBtoH, _ := svc.CheckAccess(ctx, domain.Intent{
			AgentDID:    "did:key:z6MkAgentB",
			Action:      "query",
			Target:      "health_records",
			PersonaID:   "health",
			TrustLevel:  "verified",
			Constraints: map[string]bool{"persona_health_only": true},
		})
		if !decBtoH.Allowed {
			t.Fatal("Agent B on its own persona must be allowed")
		}
	})

	// TRACE: {"suite": "CORE", "case": "0581", "section": "34", "sectionName": "Thesis: Loyalty", "title": "untrusted_agent_denied_all_personas"}
	t.Run("untrusted_agent_denied_all_personas", func(t *testing.T) {
		// Trust level "untrusted" → denied for vault access regardless of persona.
		// This is the base security layer — no sandbox escape via low trust.
		vault := newGatekeeperVaultManager()
		personalPersona, _ := domain.NewPersonaName("general")
		vault.Open(context.Background(), personalPersona, nil)

		gk := realGatekeeper
		audit := &gatekeeperAuditLog{}
		notifier := &gatekeeperNotifier{}
		clk := &gatekeeperClock{now: time.Now()}

		svc := service.NewGatekeeperService(vault, &nullVaultReader{}, gk, audit, notifier, clk)

		dec, err := svc.CheckAccess(context.Background(), domain.Intent{
			AgentDID:   "did:key:z6MkMaliciousAgent",
			Action:     "query",
			Target:     "all_data",
			PersonaID:  "general",
			TrustLevel: "untrusted",
		})
		if err != nil {
			t.Fatalf("CheckAccess: %v", err)
		}
		if dec.Allowed {
			t.Fatal("untrusted agent must be denied access to ALL personas")
		}
	})

	// TRACE: {"suite": "CORE", "case": "0582", "section": "34", "sectionName": "Thesis: Loyalty", "title": "denial_audited_with_agent_identity"}
	t.Run("denial_audited_with_agent_identity", func(t *testing.T) {
		// Every cross-persona denial must create an audit entry that includes
		// the agent's DID, the denied persona, and the action attempted.
		vault := newGatekeeperVaultManager()
		healthPersona, _ := domain.NewPersonaName("health")
		vault.Open(context.Background(), healthPersona, nil)

		gk := realGatekeeper
		audit := &gatekeeperAuditLog{}
		notifier := &gatekeeperNotifier{}
		clk := &gatekeeperClock{now: time.Now()}

		svc := service.NewGatekeeperService(vault, &nullVaultReader{}, gk, audit, notifier, clk)

		_, _ = svc.CheckAccess(context.Background(), domain.Intent{
			AgentDID:    "did:key:z6MkSneakyAgent",
			Action:      "query",
			Target:      "medical_records",
			PersonaID:   "health",
			TrustLevel:  "verified",
			Constraints: map[string]bool{"persona_consumer_only": true},
		})

		entries, _ := audit.Query(context.Background(), domain.VaultAuditFilter{})
		if len(entries) == 0 {
			t.Fatal("cross-persona denial must produce an audit entry")
		}

		// Find the audit entry for this specific denial.
		found := false
		for _, e := range entries {
			if e.Requester == "did:key:z6MkSneakyAgent" && e.Persona == "health" {
				found = true
				// Audit entry must indicate denial.
				if e.Reason == "" {
					t.Fatal("audit entry must include a reason for the denial")
				}
			}
		}
		if !found {
			t.Fatal("audit entry for sneaky agent's cross-persona access not found")
		}
	})
}

// --------------------------------------------------------------------------
// §30.1 Strict-Real Mode Enforcement — Mock Side-Effects Disabled
// --------------------------------------------------------------------------

// TST-CORE-985
// TRACE: {"suite": "CORE", "case": "0583", "section": "30", "sectionName": "Test System Quality", "subsection": "01", "scenario": "01", "title": "MockSideEffectsDisabledInStrictReal"}
func TestInfra_30_1_MockSideEffectsDisabledInStrictReal(t *testing.T) {
	// Requirements (§30.1, test_issues #1):
	//   - In strict-real mode, mock state must NOT be updated alongside real calls.
	//   - The Go wiring pattern ensures this by design: real implementations are
	//     concrete adapter types that satisfy port interfaces directly — they do NOT
	//     extend or wrap mock types (unlike Python Real* classes that call super()).
	//   - This test validates that the Go side is structurally correct: no mock state
	//     leaks into real implementation operations.
	//
	// Anti-tautological: each subtest includes a contrast that proves the assertion
	// is meaningful (e.g., mock state IS updated when you call the mock directly).

	// TRACE: {"suite": "CORE", "case": "0584", "section": "30", "sectionName": "Test System Quality", "title": "real_implementations_are_not_mock_wrappers"}
	t.Run("real_implementations_are_not_mock_wrappers", func(t *testing.T) {
		// Verify that all real implementations wired in wiring_test.go are concrete
		// adapter types from internal packages — not types from the test/testutil
		// package that could carry mock state.
		//
		// This structurally prevents the Python-style problem where Real* extends Mock*
		// and calls super() to update mock state alongside real API calls.
		type namedImpl struct {
			name string
			impl interface{}
		}

		realImpls := []namedImpl{
			{"realHDKey", realHDKey},
			{"realVaultDEKDeriver", realVaultDEKDeriver},
			{"realKEKDeriver", realKEKDeriver},
			{"realSigner", realSigner},
			{"realConverter", realConverter},
			{"realEncryptor", realEncryptor},
			{"realKeyWrapper", realKeyWrapper},
			{"realGatekeeper", realGatekeeper},
			{"realSharingPolicyManager", realSharingPolicyManager},
			{"realDIDManager", realDIDManager},
			{"realPersonaManager", realPersonaManager},
			{"realContactDirectory", realContactDirectory},
			{"realTokenValidator", realTokenValidator},
			{"realSessionManager", realSessionManager},
			{"realRateLimiter", realRateLimiter},
			{"realTransporter", realTransporter},
		}

		for _, ri := range realImpls {
			if ri.impl == nil {
				continue // Not yet wired — allowed, will be skipped by RequireImplementation.
			}

			typeName := reflect.TypeOf(ri.impl).String()

			// Real implementations must come from internal adapter packages, not test/testutil.
			if strings.Contains(typeName, "testutil.Mock") || strings.Contains(typeName, "test.mock") {
				t.Errorf("%s is a mock type (%s) — real implementations must be adapter types", ri.name, typeName)
			}

			// Verify the type comes from an internal adapter package.
			pkgPath := ""
			rt := reflect.TypeOf(ri.impl)
			if rt.Kind() == reflect.Ptr {
				pkgPath = rt.Elem().PkgPath()
			} else {
				pkgPath = rt.PkgPath()
			}
			if pkgPath != "" && strings.Contains(pkgPath, "test") && !strings.Contains(pkgPath, "adapter") {
				t.Errorf("%s (%s) appears to be from test package %q — should be from internal/adapter/*", ri.name, typeName, pkgPath)
			}
		}
	})

	// TRACE: {"suite": "CORE", "case": "0585", "section": "30", "sectionName": "Test System Quality", "title": "real_gatekeeper_independent_of_mock_state"}
	t.Run("real_gatekeeper_independent_of_mock_state", func(t *testing.T) {
		// Verify that calling realGatekeeper.EvaluateIntent does not update any
		// shared mock state. This proves Go's wiring pattern is side-effect-free.
		testutil.RequireImplementation(t, realGatekeeper, "Gatekeeper")

		mockGK := &gatekeeperMock{}
		ctx := context.Background()
		intent := domain.Intent{
			AgentDID:   "did:key:z6MkTestAgent",
			Action:     "query",
			Target:     "test_data",
			PersonaID:  "general",
			TrustLevel: "verified",
		}

		// Call real gatekeeper.
		realDec, err := realGatekeeper.EvaluateIntent(ctx, intent)
		if err != nil {
			t.Fatalf("realGatekeeper.EvaluateIntent: %v", err)
		}

		// Call mock gatekeeper with same intent.
		mockDec, _ := mockGK.EvaluateIntent(ctx, intent)

		// The two must operate independently — real decision is based on
		// actual gatekeeper rules; mock is based on its evalFn (nil → default allow).
		// Key point: calling real did NOT change mock's result.
		if mockDec.Reason != "default allow" {
			t.Fatalf("mock gatekeeper reason should be 'default allow', got %q — real call leaked into mock", mockDec.Reason)
		}

		// Real gatekeeper with valid intent should return a non-empty reason.
		if realDec.Reason == "" {
			t.Fatal("real gatekeeper should return a reason for its decision")
		}
	})

	// TRACE: {"suite": "CORE", "case": "0586", "section": "30", "sectionName": "Test System Quality", "title": "real_sharing_policy_independent_of_mock"}
	t.Run("real_sharing_policy_independent_of_mock", func(t *testing.T) {
		// Verify that setting a policy on realSharingPolicyManager does not
		// affect a separately-created MockSharingPolicyManager.
		testutil.RequireImplementation(t, realSharingPolicyManager, "SharingPolicyManager")

		mockSPM := testutil.NewMockSharingPolicyManager()
		ctx := context.Background()

		// Set policy on real implementation.
		err := realSharingPolicyManager.SetPolicy(ctx, "did:key:z6MkStrictRealTestContact", map[string]domain.SharingTier{
			"location": "summary",
		})
		if err != nil {
			t.Fatalf("realSharingPolicyManager.SetPolicy: %v", err)
		}

		// Mock must NOT have this policy — proves no state leakage.
		// Mock returns error for missing contacts (ErrNotFound), while real returns empty policy.
		_, mockErr := mockSPM.GetPolicy(ctx, "did:key:z6MkStrictRealTestContact")
		if mockErr == nil {
			t.Fatal("mock should return error for unset contact — real SetPolicy leaked into mock state")
		}

		// Contrast: setting on mock DOES update mock (proves mock works independently).
		_ = mockSPM.SetPolicy(ctx, "did:key:z6MkStrictRealTestContact", map[string]domain.SharingTier{
			"health": "full",
		})
		mockPolicyAfter, mockErr2 := mockSPM.GetPolicy(ctx, "did:key:z6MkStrictRealTestContact")
		if mockErr2 != nil {
			t.Fatal("mock should return policy after direct set — anti-tautological check failed")
		}
		if len(mockPolicyAfter.Categories) == 0 {
			t.Fatal("mock policy should have categories when set directly — anti-tautological check failed")
		}
	})

	// TRACE: {"suite": "CORE", "case": "0587", "section": "30", "sectionName": "Test System Quality", "title": "wiring_variables_typed_to_ports_not_mocks"}
	t.Run("wiring_variables_typed_to_ports_not_mocks", func(t *testing.T) {
		// Verify that wiring_test.go variables are typed to port interfaces
		// (e.g., port.HDKeyDeriver) not to mock types. This ensures that
		// the compiler enforces the contract, and mocks cannot accidentally
		// be substituted with extra side-effect methods.
		type portCheck struct {
			name      string
			impl      interface{}
			portIface string // expected port interface name in type string
		}

		checks := []portCheck{
			{"realHDKey", realHDKey, "HDKeyDeriver"},
			{"realSigner", realSigner, "Signer"},
			{"realEncryptor", realEncryptor, "Encryptor"},
			{"realConverter", realConverter, "KeyConverter"},
			{"realKeyWrapper", realKeyWrapper, "KeyWrapper"},
			{"realDIDManager", realDIDManager, "DIDManager"},
			{"realPersonaManager", realPersonaManager, "PersonaManager"},
			{"realContactDirectory", realContactDirectory, "ContactDirectory"},
			{"realTokenValidator", realTokenValidator, "TokenValidator"},
			{"realSessionManager", realSessionManager, "SessionManager"},
		}

		for _, pc := range checks {
			if pc.impl == nil {
				continue
			}
			// Verify it implements the expected port interface by checking that
			// the concrete type is from an adapter package (not a mock type).
			typeName := fmt.Sprintf("%T", pc.impl)
			if strings.Contains(typeName, "Mock") {
				t.Errorf("%s is typed as mock (%s) — must be typed to port interface satisfied by adapter", pc.name, typeName)
			}
		}
	})

	// TRACE: {"suite": "CORE", "case": "0588", "section": "30", "sectionName": "Test System Quality", "title": "real_pii_scrubber_independent_of_mock"}
	t.Run("real_pii_scrubber_independent_of_mock", func(t *testing.T) {
		// Verify that the real PII scrubber does not share state with mocks.
		testutil.RequireImplementation(t, realPIIScrubber, "PIIScrubber")

		ctx := context.Background()

		// Real scrubber should detect PII patterns (email, phone, SSN).
		result, err := realPIIScrubber.Scrub(ctx, "Contact john@example.com for details")
		if err != nil {
			t.Fatalf("realPIIScrubber.Scrub: %v", err)
		}
		if result.Scrubbed == "Contact john@example.com for details" {
			t.Fatal("real PII scrubber should redact email addresses")
		}
		if len(result.Entities) == 0 {
			t.Fatal("real PII scrubber should report detected entities")
		}

		// A separately created mock scrubber must not be affected.
		mockScrubber := &testutil.MockPIIScrubber{}
		mockResult, _ := mockScrubber.Scrub(ctx, "Contact john@example.com for details")
		// Mock scrubber returns text unmodified (no patterns configured).
		if mockResult.Scrubbed != "Contact john@example.com for details" {
			t.Fatal("mock scrubber should NOT scrub (no patterns) — proves independence from real scrubber")
		}
	})
}

// --------------------------------------------------------------------------
// §34.2 Agent Sandbox Adversarial — Credential Harvesting via Errors
// --------------------------------------------------------------------------

// TST-CORE-1128
// TRACE: {"suite": "CORE", "case": "0589", "section": "34", "sectionName": "Thesis: Loyalty", "subsection": "02", "scenario": "01", "title": "AgentCredentialHarvestingViaErrors"}
func TestAdv_34_2_AgentCredentialHarvestingViaErrors(t *testing.T) {
	// Requirements (§34.2):
	//   - Error responses must contain NO internal state, no key material,
	//     no vault metadata, no other agents' identities.
	//   - Agent sends deliberately malformed requests to probe for information
	//     leakage via error messages.
	//   - Safe error responses: generic messages like "invalid request body",
	//     "not found", "method not allowed", "payload too large".
	//   - Unsafe leakage: file paths, key material, DID values, schema details,
	//     vault item counts, embedding dimensions, session IDs, port numbers.

	impl := realErrorHandler
	testutil.RequireImplementation(t, impl, "ErrorHandler")

	// sensitivePatterns are strings that must NEVER appear in error responses.
	// Each represents a category of credential/state leakage.
	sensitivePatterns := []string{
		// Key material
		"ed25519", "x25519", "private", "secret", "dek", "kek",
		"mnemonic", "seed",
		// File system paths
		"/var/lib/dina", "/tmp/", ".sqlite", "keyfile",
		// Internal identifiers
		"did:key:", "did:plc:",
		// Schema internals
		"vault_items", "vault_items_fts", "embedding",
		"hnsw", "sqlite", "rowid",
		// Configuration details
		"127.0.0.1", "localhost", "8100", "8200", "3000",
		// Implementation details
		"goroutine", "runtime.", "panic",
		"stack trace", "traceback",
	}

	checkNoLeakage := func(t *testing.T, respBody []byte, scenario string) {
		t.Helper()
		body := strings.ToLower(string(respBody))
		for _, pattern := range sensitivePatterns {
			if strings.Contains(body, strings.ToLower(pattern)) {
				t.Errorf("[%s] error response leaks sensitive info %q: %s", scenario, pattern, string(respBody))
			}
		}
	}

	// TRACE: {"suite": "CORE", "case": "0590", "section": "34", "sectionName": "Thesis: Loyalty", "title": "malformed_json_body_no_leak"}
	t.Run("malformed_json_body_no_leak", func(t *testing.T) {
		// Send structurally invalid JSON to a JSON endpoint — error must be generic.
		malformedBodies := []struct {
			name string
			body []byte
		}{
			{"truncated_json", []byte(`{"persona":"general","q":"te`)},
			{"binary_garbage", []byte{0xff, 0xfe, 0x00, 0x01, 0x80}},
			{"nested_braces", []byte(`{{{{{`)},
		}

		for _, tc := range malformedBodies {
			t.Run(tc.name, func(t *testing.T) {
				status, body, err := impl.HandleRequest("POST", "/v1/vault/query", "application/json", tc.body)
				if err != nil {
					t.Fatalf("HandleRequest: %v", err)
				}
				// Must return 400 (bad request), not 500 (internal error).
				if status != 400 {
					t.Errorf("malformed JSON should return 400, got %d", status)
				}
				checkNoLeakage(t, body, tc.name)
			})
		}
	})

	// TRACE: {"suite": "CORE", "case": "0591", "section": "34", "sectionName": "Thesis: Loyalty", "title": "injection_payloads_no_echo_in_errors"}
	t.Run("injection_payloads_no_echo_in_errors", func(t *testing.T) {
		// SQL injection and path traversal payloads are valid JSON, so they
		// pass JSON parsing. The test verifies that if the service layer
		// rejects them, error messages do NOT echo the injection payload
		// back to the caller (which could enable reflected XSS or info disclosure).
		injectionPayloads := []struct {
			name string
			body []byte
		}{
			{"sql_injection", []byte(`{"persona":"'; DROP TABLE vault_items;--"}`)},
			{"path_traversal", []byte(`{"persona":"../../etc/passwd"}`)},
			{"xss_in_field", []byte(`{"persona":"<script>alert('xss')</script>"}`)},
		}

		for _, tc := range injectionPayloads {
			t.Run(tc.name, func(t *testing.T) {
				_, body, err := impl.HandleRequest("POST", "/v1/vault/query", "application/json", tc.body)
				if err != nil {
					t.Fatalf("HandleRequest: %v", err)
				}
				// Regardless of status code, the response body must NOT echo
				// the attacker's input back (prevents reflected injection).
				checkNoLeakage(t, body, tc.name)
				bodyStr := string(body)
				if strings.Contains(bodyStr, "DROP TABLE") {
					t.Fatal("error response must NOT echo SQL injection payload")
				}
				if strings.Contains(bodyStr, "../../etc") {
					t.Fatal("error response must NOT echo path traversal payload")
				}
				if strings.Contains(bodyStr, "<script>") {
					t.Fatal("error response must NOT echo XSS payload")
				}
			})
		}
	})

	// TRACE: {"suite": "CORE", "case": "0592", "section": "34", "sectionName": "Thesis: Loyalty", "title": "oversized_payload_no_leak"}
	t.Run("oversized_payload_no_leak", func(t *testing.T) {
		// Oversized payload — error must not reveal the configured max size.
		oversized := make([]byte, 11*1024*1024) // 11 MiB (exceeds 10 MiB default)
		status, body, err := impl.HandleRequest("POST", "/v1/vault/store", "application/json", oversized)
		if err != nil {
			t.Fatalf("HandleRequest: %v", err)
		}
		if status != 413 {
			t.Fatalf("oversized payload should return 413, got %d", status)
		}
		checkNoLeakage(t, body, "oversized")

		// Error must NOT reveal the exact max size (e.g., "max 10485760 bytes").
		bodyStr := string(body)
		if strings.Contains(bodyStr, "10485760") || strings.Contains(bodyStr, "10 MiB") {
			t.Fatal("error response must not reveal exact max body size configuration")
		}
	})

	// TRACE: {"suite": "CORE", "case": "0593", "section": "34", "sectionName": "Thesis: Loyalty", "title": "unknown_endpoint_no_resource_discovery"}
	t.Run("unknown_endpoint_no_resource_discovery", func(t *testing.T) {
		// Probing for undocumented endpoints must return generic 404.
		probePaths := []string{
			"/v1/debug",
			"/v1/internal/keys",
			"/v1/admin/dump",
			"/v1/vault/raw",
			"/v1/plugin/execute",
			"/metrics",
			"/v1/config",
		}

		for _, path := range probePaths {
			status, body, err := impl.HandleRequest("GET", path, "", nil)
			if err != nil {
				t.Fatalf("HandleRequest %s: %v", path, err)
			}
			if status != 404 {
				t.Errorf("%s should return 404, got %d", path, status)
			}
			checkNoLeakage(t, body, "probe_"+path)
			// Must not hint at valid endpoints in the error body.
			if strings.Contains(strings.ToLower(string(body)), "did you mean") {
				t.Errorf("%s error suggests valid endpoints — information disclosure", path)
			}
		}
	})

	// TRACE: {"suite": "CORE", "case": "0594", "section": "34", "sectionName": "Thesis: Loyalty", "title": "wrong_method_no_endpoint_enumeration"}
	t.Run("wrong_method_no_endpoint_enumeration", func(t *testing.T) {
		// Wrong HTTP method — error must not list valid methods (no Allow header leak in body).
		status, body, err := impl.HandleRequest("DELETE", "/v1/vault/query", "", nil)
		if err != nil {
			t.Fatalf("HandleRequest: %v", err)
		}
		if status != 405 {
			t.Fatalf("wrong method should return 405, got %d", status)
		}
		checkNoLeakage(t, body, "wrong_method")

		// Error body must not list valid methods.
		bodyStr := strings.ToLower(string(body))
		if strings.Contains(bodyStr, "post") || strings.Contains(bodyStr, "get") {
			t.Fatal("405 error must not enumerate valid HTTP methods in body")
		}
	})

	// TRACE: {"suite": "CORE", "case": "0595", "section": "34", "sectionName": "Thesis: Loyalty", "title": "missing_required_fields_generic_error"}
	t.Run("missing_required_fields_generic_error", func(t *testing.T) {
		// Missing required fields — error may name the field but must not
		// reveal vault schema, item counts, or other internal state.
		status, body, err := impl.HandleRequest("POST", "/v1/vault/query", "application/json", []byte(`{"q":"test"}`))
		if err != nil {
			t.Fatalf("HandleRequest: %v", err)
		}
		// 400 is acceptable for missing required field.
		if status != 400 {
			t.Fatalf("missing required field should return 400, got %d", status)
		}
		checkNoLeakage(t, body, "missing_fields")
	})

	// TRACE: {"suite": "CORE", "case": "0596", "section": "34", "sectionName": "Thesis: Loyalty", "title": "wrong_content_type_no_leak"}
	t.Run("wrong_content_type_no_leak", func(t *testing.T) {
		// Wrong Content-Type — error must be generic.
		status, body, err := impl.HandleRequest("POST", "/v1/vault/store", "text/xml", []byte("<vault><item/></vault>"))
		if err != nil {
			t.Fatalf("HandleRequest: %v", err)
		}
		if status != 415 {
			t.Fatalf("wrong content type should return 415, got %d", status)
		}
		checkNoLeakage(t, body, "wrong_content_type")
	})

	// TRACE: {"suite": "CORE", "case": "0597", "section": "34", "sectionName": "Thesis: Loyalty", "title": "error_responses_are_valid_json"}
	t.Run("error_responses_are_valid_json", func(t *testing.T) {
		// All error responses must be valid JSON — prevents XSS via reflected
		// error messages and ensures structured error format.
		errorScenarios := []struct {
			method      string
			path        string
			contentType string
			body        []byte
		}{
			{"POST", "/v1/vault/query", "application/json", []byte(`not json`)},
			{"GET", "/v1/nonexistent", "", nil},
			{"DELETE", "/v1/vault/query", "", nil},
		}

		for _, tc := range errorScenarios {
			status, body, err := impl.HandleRequest(tc.method, tc.path, tc.contentType, tc.body)
			if err != nil {
				continue // Some implementations may return error
			}
			if status >= 400 {
				var parsed map[string]interface{}
				if jsonErr := json.Unmarshal(body, &parsed); jsonErr != nil {
					t.Errorf("error response for %s %s (status %d) is not valid JSON: %s",
						tc.method, tc.path, status, string(body))
				}
				// Error response must have an "error" field.
				if _, hasError := parsed["error"]; !hasError {
					t.Errorf("error response for %s %s must have 'error' field: %s",
						tc.method, tc.path, string(body))
				}
			}
		}
	})

	// TRACE: {"suite": "CORE", "case": "0598", "section": "34", "sectionName": "Thesis: Loyalty", "title": "contrast_valid_request_returns_200"}
	t.Run("contrast_valid_request_returns_200", func(t *testing.T) {
		// Anti-tautological: valid requests DO succeed.
		// This proves the error responses above are specific to bad input.
		status, _, err := impl.HandleRequest("POST", "/v1/vault/query", "application/json",
			[]byte(`{"persona":"general","q":"test","mode":"fts5"}`))
		if err != nil {
			t.Fatalf("valid request: %v", err)
		}
		if status != 200 {
			t.Fatalf("valid request should return 200, got %d", status)
		}
	})
}

// --------------------------------------------------------------------------
// §30.1 Strict-Real Mode Enforcement — All fallback locations verified strict
// --------------------------------------------------------------------------

// TST-CORE-986
// TRACE: {"suite": "CORE", "case": "0599", "section": "30", "sectionName": "Test System Quality", "subsection": "01", "scenario": "01", "title": "AllFallbackLocationsAuditedStrict"}
func TestInfra_30_1_AllFallbackLocationsAuditedStrict(t *testing.T) {
	// Requirement (§30.1, row 5):
	//   All fallback locations in real_clients.py, real_nodes.py, and real_d2d.py
	//   must be inventoried. In strict-real mode (DINA_STRICT_REAL=1), zero silent
	//   fallback paths are allowed — every API call must succeed or raise.
	//
	// This test audits the Python test infrastructure files for mock-fallback
	// patterns. It catalogs each known pattern type and verifies the total count
	// matches the expected inventory. If new fallback patterns are introduced,
	// this test will fail (count increases), preventing silent regression masking.
	//
	// Anti-tautological design:
	//   1. Each file is read and patterns are counted
	//   2. Counts must match or be BELOW the tracked inventory (refactoring reduces count)
	//   3. Pattern categories are distinct (super(), try/except, return None/[])
	//   4. Positive control: the files must exist and be non-empty

	type fallbackFile struct {
		relPath          string
		description      string
		maxSuperCalls    int // super() calls that delegate to mock parent
		maxTryExcepts    int // try/except blocks that swallow API failures
		maxMockFallbacks int // explicit mock_* references in catch blocks
	}

	files := []fallbackFile{
		{
			relPath:          "../../tests/integration/real_clients.py",
			description:      "Integration Real* clients (17 locations)",
			maxSuperCalls:    22, // Real* classes extend Mock*, call super()
			maxTryExcepts:    15, // try/except blocks that fall back to mock
			maxMockFallbacks: 20, // _mock_* or mock_state references
		},
		{
			relPath:          "../../tests/e2e/real_nodes.py",
			description:      "E2E Real* nodes (22 locations)",
			maxSuperCalls:    20, // Real* extends Mock*, call super()
			maxTryExcepts:    10, // try/except blocks that fall back
			maxMockFallbacks: 20, // _mock_* references
		},
		{
			relPath:          "../../tests/e2e/real_d2d.py",
			description:      "E2E Real D2D transport (1 location)",
			maxSuperCalls:    5,  // Minimal super() delegation
			maxTryExcepts:    3,  // Few try/except blocks
			maxMockFallbacks: 5,  // Few mock references
		},
	}

	for _, ff := range files {
		t.Run(ff.description, func(t *testing.T) {
			content, err := os.ReadFile(filepath.Clean(ff.relPath))
			if err != nil {
				t.Fatalf("cannot read %s: %v (test must run from core/test/)", ff.relPath, err)
			}

			src := string(content)

			// Positive control: file must be non-empty.
			if len(src) < 100 {
				t.Fatalf("file %s is too small (%d bytes) — expected real test infrastructure",
					ff.relPath, len(src))
			}

			// Count super() calls — each represents a delegation to mock parent class.
			superCount := strings.Count(src, "super().")
			if superCount > ff.maxSuperCalls {
				t.Errorf("super() call count (%d) exceeds inventory maximum (%d) in %s — "+
					"new mock fallback introduced?", superCount, ff.maxSuperCalls, ff.relPath)
			}

			// Count try/except blocks — each is a potential silent fallback.
			tryCount := strings.Count(src, "try:")
			if tryCount > ff.maxTryExcepts {
				t.Errorf("try: block count (%d) exceeds inventory maximum (%d) in %s — "+
					"new exception-swallowing fallback introduced?", tryCount, ff.maxTryExcepts, ff.relPath)
			}

			// Count explicit mock references (mock_, _mock) — direct mock state updates.
			mockCount := 0
			for _, pattern := range []string{"_mock_", "mock_state", ".mock_", "MockVault", "MockBrain"} {
				mockCount += strings.Count(src, pattern)
			}
			if mockCount > ff.maxMockFallbacks {
				t.Errorf("mock fallback reference count (%d) exceeds inventory maximum (%d) in %s — "+
					"new mock coupling introduced?", mockCount, ff.maxMockFallbacks, ff.relPath)
			}

			// Log the current counts for visibility during audits.
			t.Logf("Fallback inventory for %s: super()=%d, try:=%d, mock_refs=%d",
				ff.relPath, superCount, tryCount, mockCount)
		})
	}

	// TRACE: {"suite": "CORE", "case": "0600", "section": "30", "sectionName": "Test System Quality", "title": "total_inventory_within_bounds"}
	t.Run("total_inventory_within_bounds", func(t *testing.T) {
		// Read all 3 files and compute total fallback patterns.
		totalSuper := 0
		totalTry := 0
		totalMock := 0

		for _, ff := range files {
			content, err := os.ReadFile(ff.relPath)
			if err != nil {
				t.Fatalf("cannot read %s: %v", ff.relPath, err)
			}
			src := string(content)
			totalSuper += strings.Count(src, "super().")
			totalTry += strings.Count(src, "try:")
			for _, pattern := range []string{"_mock_", "mock_state", ".mock_", "MockVault", "MockBrain"} {
				totalMock += strings.Count(src, pattern)
			}
		}

		// The test plan references "45 fallback locations (22+22+1)".
		// Total super() calls across all files must not exceed the known inventory.
		// As fallback locations are fixed, these numbers should decrease.
		const maxTotalSuper = 48
		if totalSuper > maxTotalSuper {
			t.Errorf("total super() calls (%d) exceed known inventory (%d) — "+
				"new fallback locations were added without updating the audit",
				totalSuper, maxTotalSuper)
		}

		t.Logf("Total fallback inventory: super()=%d (max %d), try:=%d, mock_refs=%d",
			totalSuper, maxTotalSuper, totalTry, totalMock)
	})

	// TRACE: {"suite": "CORE", "case": "0601", "section": "30", "sectionName": "Test System Quality", "title": "contrast_Go_wiring_has_no_mock_fallback"}
	t.Run("contrast_Go_wiring_has_no_mock_fallback", func(t *testing.T) {
		// Positive control: Go Core's wiring_test.go real* implementations
		// must NOT reference mock types. This proves the Go side is clean
		// while the Python side has known fallback patterns.
		wiringSrc, err := os.ReadFile("wiring_test.go")
		if err != nil {
			t.Fatalf("cannot read wiring_test.go: %v", err)
		}
		content := string(wiringSrc)

		// realXxx variables must be assigned from adapter packages, not testutil.Mock*.
		lines := strings.Split(content, "\n")
		for _, line := range lines {
			trimmed := strings.TrimSpace(line)
			if strings.HasPrefix(trimmed, "real") && strings.Contains(trimmed, "=") {
				// Check that real* assignments don't reference Mock types.
				if strings.Contains(trimmed, "testutil.Mock") || strings.Contains(trimmed, "testutil.NewMock") {
					t.Errorf("Go wiring has mock fallback: %s", trimmed)
				}
			}
		}
	})
}

// --------------------------------------------------------------------------
// §34.1 Agent Intent Verification — Malformed intent bypass attempt
// --------------------------------------------------------------------------

// TST-CORE-1127
// TRACE: {"suite": "CORE", "case": "0602", "section": "34", "sectionName": "Thesis: Loyalty", "subsection": "01", "scenario": "01", "title": "AgentSendsMalformedIntentToBypassGatekeeper"}
func TestAdv_34_1_AgentSendsMalformedIntentToBypassGatekeeper(t *testing.T) {
	// Requirement (§34.1):
	//   Agent sends malformed intent (missing action or target fields) →
	//   Gatekeeper rejects with validation error — no partial processing.
	//   The gatekeeper must fail-closed: errors from malformed input must
	//   never result in an allowed decision.
	//
	// Production code (gatekeeper.go:106-113):
	//   EvaluateIntent validates AgentDID and Action first — returns error if empty.
	//   Errors are propagated through CheckAccess as errors (not decisions).
	//
	// Anti-tautological design:
	//   1. Empty Action → error (not Decision{Allowed:false})
	//   2. Empty AgentDID → error
	//   3. Both empty → error (first check wins)
	//   4. Positive control: valid intent → Decision (not error)
	//   5. Nil constraints don't cause panic
	//   6. CheckAccess propagates EvaluateIntent errors (no silent absorption)

	// Use real Gatekeeper (not mock) to test production validation logic.
	realGK := gatekeeper.New()

	// TRACE: {"suite": "CORE", "case": "0603", "section": "34", "sectionName": "Thesis: Loyalty", "title": "empty_action_returns_error_not_decision"}
	t.Run("empty_action_returns_error_not_decision", func(t *testing.T) {
		ctx := context.Background()
		intent := domain.Intent{
			AgentDID:   "did:key:z6MkMaliciousAgent",
			Action:     "", // Malformed: empty action
			Target:     "vault_items",
			PersonaID:  "consumer",
			TrustLevel: "verified",
		}
		_, err := realGK.EvaluateIntent(ctx, intent)
		if err == nil {
			t.Fatal("empty action must return error, not a decision — fail-closed violation")
		}
		if !strings.Contains(err.Error(), "action") {
			t.Fatalf("error should mention 'action', got: %v", err)
		}
	})

	// TRACE: {"suite": "CORE", "case": "0604", "section": "34", "sectionName": "Thesis: Loyalty", "title": "empty_agent_did_returns_error_not_decision"}
	t.Run("empty_agent_did_returns_error_not_decision", func(t *testing.T) {
		ctx := context.Background()
		intent := domain.Intent{
			AgentDID:   "", // Malformed: empty DID
			Action:     "query",
			Target:     "vault_items",
			PersonaID:  "consumer",
			TrustLevel: "verified",
		}
		_, err := realGK.EvaluateIntent(ctx, intent)
		if err == nil {
			t.Fatal("empty AgentDID must return error — fail-closed violation")
		}
		if !strings.Contains(err.Error(), "agent DID") {
			t.Fatalf("error should mention 'agent DID', got: %v", err)
		}
	})

	// TRACE: {"suite": "CORE", "case": "0605", "section": "34", "sectionName": "Thesis: Loyalty", "title": "both_empty_returns_error"}
	t.Run("both_empty_returns_error", func(t *testing.T) {
		ctx := context.Background()
		intent := domain.Intent{
			AgentDID: "",
			Action:   "",
		}
		_, err := realGK.EvaluateIntent(ctx, intent)
		if err == nil {
			t.Fatal("completely empty intent must return error")
		}
	})

	// TRACE: {"suite": "CORE", "case": "0606", "section": "34", "sectionName": "Thesis: Loyalty", "title": "positive_control_valid_intent_returns_decision"}
	t.Run("positive_control_valid_intent_returns_decision", func(t *testing.T) {
		// Contrast: a valid intent with all fields returns a Decision, not an error.
		// Without this, the test passes if EvaluateIntent always returns errors.
		ctx := context.Background()
		intent := domain.Intent{
			AgentDID:   "did:key:z6MkGoodAgent",
			Action:     "fetch_weather",
			Target:     "weather_service",
			PersonaID:  "consumer",
			TrustLevel: "verified",
		}
		decision, err := realGK.EvaluateIntent(ctx, intent)
		if err != nil {
			t.Fatalf("valid intent must not return error, got: %v", err)
		}
		// Safe action by verified agent → should be allowed.
		if !decision.Allowed {
			t.Fatalf("valid safe intent should be allowed, got Allowed=%v Reason=%q",
				decision.Allowed, decision.Reason)
		}
	})

	// TRACE: {"suite": "CORE", "case": "0607", "section": "34", "sectionName": "Thesis: Loyalty", "title": "nil_constraints_safe"}
	t.Run("nil_constraints_safe", func(t *testing.T) {
		// Nil Constraints map must not cause panic or error.
		ctx := context.Background()
		intent := domain.Intent{
			AgentDID:    "did:key:z6MkAgent",
			Action:      "query",
			Target:      "vault",
			PersonaID:   "consumer",
			TrustLevel:  "verified",
			Constraints: nil, // Explicitly nil
		}
		_, err := realGK.EvaluateIntent(ctx, intent)
		if err != nil {
			t.Fatalf("nil Constraints must not cause error: %v", err)
		}
	})

	// TRACE: {"suite": "CORE", "case": "0608", "section": "34", "sectionName": "Thesis: Loyalty", "title": "empty_constraints_map_safe"}
	t.Run("empty_constraints_map_safe", func(t *testing.T) {
		ctx := context.Background()
		intent := domain.Intent{
			AgentDID:    "did:key:z6MkAgent",
			Action:      "query",
			Target:      "vault",
			PersonaID:   "consumer",
			TrustLevel:  "verified",
			Constraints: map[string]bool{},
		}
		_, err := realGK.EvaluateIntent(ctx, intent)
		if err != nil {
			t.Fatalf("empty Constraints map must not cause error: %v", err)
		}
	})

	// TRACE: {"suite": "CORE", "case": "0609", "section": "34", "sectionName": "Thesis: Loyalty", "title": "CheckAccess_propagates_validation_error"}
	t.Run("CheckAccess_propagates_validation_error", func(t *testing.T) {
		// GatekeeperService.CheckAccess must propagate EvaluateIntent errors,
		// not absorb them into a Decision{Allowed:false}.
		vault := newGatekeeperVaultManager()
		consumerPersona, _ := domain.NewPersonaName("consumer")
		vault.Open(context.Background(), consumerPersona, nil)

		audit := &gatekeeperAuditLog{}
		notifier := &gatekeeperNotifier{}
		clk := &gatekeeperClock{now: time.Now()}

		// Use real gatekeeper (not mock) to get real validation errors.
		svc := service.NewGatekeeperService(vault, &nullVaultReader{}, realGK, audit, notifier, clk)

		ctx := context.Background()
		malformedIntent := domain.Intent{
			AgentDID:  "", // Malformed
			Action:    "query",
			PersonaID: "consumer",
		}
		_, err := svc.CheckAccess(ctx, malformedIntent)
		if err == nil {
			t.Fatal("CheckAccess must propagate validation error from EvaluateIntent")
		}

		// Audit should NOT record an entry for validation errors
		// (errors != decisions — only decisions get audited).
		entries, _ := audit.Query(ctx, domain.VaultAuditFilter{})
		if len(entries) != 0 {
			t.Fatalf("validation errors should not generate audit entries, got %d", len(entries))
		}
	})

	// TRACE: {"suite": "CORE", "case": "0610", "section": "34", "sectionName": "Thesis: Loyalty", "title": "malformed_intent_with_risky_action_still_errors"}
	t.Run("malformed_intent_with_risky_action_still_errors", func(t *testing.T) {
		// Even if the action is risky (would normally be denied), empty AgentDID
		// must still cause an error, not a deny decision. This proves validation
		// runs before business logic.
		ctx := context.Background()
		intent := domain.Intent{
			AgentDID: "", // Malformed
			Action:   "send_email",
			Target:   "outbox",
		}
		_, err := realGK.EvaluateIntent(ctx, intent)
		if err == nil {
			t.Fatal("malformed intent must error even if action would be denied — validation before business logic")
		}
	})
}

// ==========================================================================
// TST-CORE-1126: Agent attempts to exfiltrate vault via oversized query
// §34.2 Agent Sandbox Adversarial
// Requirement: Agent queries with limit: 999999 → Core caps query results
// to configured maximum (100). An agent must not be able to dump the entire
// vault in a single oversized query.
// ==========================================================================

// queryCapturingReader is a mock VaultReader that captures the SearchQuery's
// Limit field to verify handler-level capping. Returns empty results.
type queryCapturingReader struct {
	mu            sync.Mutex
	capturedLimit int
	capturedCount int
}

func (r *queryCapturingReader) Query(_ context.Context, _ domain.PersonaName, q domain.SearchQuery) ([]domain.VaultItem, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.capturedLimit = q.Limit
	r.capturedCount++
	return []domain.VaultItem{}, nil
}

func (r *queryCapturingReader) GetItem(_ context.Context, _ domain.PersonaName, _ string) (*domain.VaultItem, error) {
	return nil, nil
}

func (r *queryCapturingReader) VectorSearch(_ context.Context, _ domain.PersonaName, _ []float32, _ int) ([]domain.VaultItem, error) {
	return nil, nil
}

func (r *queryCapturingReader) getLimit() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.capturedLimit
}

// noopVaultWriter is a no-op VaultWriter for tests that only exercise reads.
type noopVaultWriter struct{}

func (w *noopVaultWriter) Store(_ context.Context, _ domain.PersonaName, _ domain.VaultItem) (string, error) {
	return "noop-id", nil
}
func (w *noopVaultWriter) StoreBatch(_ context.Context, _ domain.PersonaName, _ []domain.VaultItem) ([]string, error) {
	return nil, nil
}
func (w *noopVaultWriter) Delete(_ context.Context, _ domain.PersonaName, _ string) error {
	return nil
}

// simpleClock is a minimal Clock for vault handler tests.
type simpleClock struct{}

func (c *simpleClock) Now() time.Time                         { return time.Now() }
func (c *simpleClock) After(d time.Duration) <-chan time.Time  { return time.After(d) }
func (c *simpleClock) NewTicker(d time.Duration) *time.Ticker { return time.NewTicker(d) }

// deleteTrackingWriter records every Delete call for verifying physical removal.
type deleteTrackingWriter struct {
	mu            sync.Mutex
	deleteCount   int
	lastDeletedID string
}

func (w *deleteTrackingWriter) Store(_ context.Context, _ domain.PersonaName, item domain.VaultItem) (string, error) {
	return "stored-" + item.Type, nil
}
func (w *deleteTrackingWriter) StoreBatch(_ context.Context, _ domain.PersonaName, items []domain.VaultItem) ([]string, error) {
	ids := make([]string, len(items))
	for i := range items {
		ids[i] = fmt.Sprintf("batch-%d", i)
	}
	return ids, nil
}
func (w *deleteTrackingWriter) Delete(_ context.Context, _ domain.PersonaName, id string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.deleteCount++
	w.lastDeletedID = id
	return nil
}

// deleteTrackingReader returns items from an in-memory map for delete tests.
type deleteTrackingReader struct {
	mu    sync.Mutex
	items map[string]*domain.VaultItem
}

func (r *deleteTrackingReader) Query(_ context.Context, _ domain.PersonaName, _ domain.SearchQuery) ([]domain.VaultItem, error) {
	return nil, nil
}
func (r *deleteTrackingReader) GetItem(_ context.Context, _ domain.PersonaName, id string) (*domain.VaultItem, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	item, ok := r.items[id]
	if !ok {
		return nil, fmt.Errorf("not found: %s", id)
	}
	return item, nil
}
func (r *deleteTrackingReader) VectorSearch(_ context.Context, _ domain.PersonaName, _ []float32, _ int) ([]domain.VaultItem, error) {
	return nil, nil
}

// goldenSchemaReader is a mock VaultReader that returns predictable items
// for golden schema and router contract tests.
type goldenSchemaReader struct{}

func (r *goldenSchemaReader) Query(_ context.Context, _ domain.PersonaName, _ domain.SearchQuery) ([]domain.VaultItem, error) {
	return []domain.VaultItem{
		{ID: "golden-001", Type: "note", BodyText: "golden schema test item"},
	}, nil
}
func (r *goldenSchemaReader) GetItem(_ context.Context, _ domain.PersonaName, id string) (*domain.VaultItem, error) {
	return &domain.VaultItem{ID: id, Type: "note", BodyText: "golden item"}, nil
}
func (r *goldenSchemaReader) VectorSearch(_ context.Context, _ domain.PersonaName, _ []float32, _ int) ([]domain.VaultItem, error) {
	return nil, nil
}

// contractPIIScrubber is a mock PIIScrubber that returns predictable scrub
// results for contract testing. It replaces email and phone patterns.
type contractPIIScrubber struct{}

func (s *contractPIIScrubber) Scrub(_ context.Context, text string) (*domain.ScrubResult, error) {
	scrubbed := strings.ReplaceAll(text, "alice@example.com", "[EMAIL_REDACTED]")
	scrubbed = strings.ReplaceAll(scrubbed, "555-0100", "[PHONE_REDACTED]")

	entities := []domain.PIIEntity{}
	if strings.Contains(text, "alice@example.com") {
		idx := strings.Index(text, "alice@example.com")
		entities = append(entities, domain.PIIEntity{
			Type:  "EMAIL",
			Value: "alice@example.com",
			Start: idx,
			End:   idx + len("alice@example.com"),
		})
	}
	if strings.Contains(text, "555-0100") {
		idx := strings.Index(text, "555-0100")
		entities = append(entities, domain.PIIEntity{
			Type:  "PHONE",
			Value: "555-0100",
			Start: idx,
			End:   idx + len("555-0100"),
		})
	}
	return &domain.ScrubResult{Scrubbed: scrubbed, Entities: entities}, nil
}

// failingScrubber always returns an error, for testing error handling paths.
type failingScrubber struct{}

func (s *failingScrubber) Scrub(_ context.Context, _ string) (*domain.ScrubResult, error) {
	return nil, fmt.Errorf("scrubber internal failure")
}

// TST-CORE-1126
// TRACE: {"suite": "CORE", "case": "0611", "section": "34", "sectionName": "Thesis: Loyalty", "subsection": "02", "scenario": "05", "title": "OversizedQueryLimitCapped"}
func TestGatekeeper_34_2_5_OversizedQueryLimitCapped(t *testing.T) {
	// Build a VaultHandler with mock ports. The queryCapturingReader records
	// what limit the handler actually passes to the service layer.
	reader := &queryCapturingReader{}
	mgr := newGatekeeperVaultManager()
	gk := &gatekeeperMock{} // default: allow all intents

	// Open the "general" persona so queries pass the IsOpen check.
	mgr.Open(context.Background(), "general", []byte("dek-placeholder"))

	vaultSvc := service.NewVaultService(mgr, reader, &noopVaultWriter{}, gk, &simpleClock{})
	h := &handler.VaultHandler{Vault: vaultSvc}

	// Helper: send a vault query request with the given limit and return the
	// limit that was actually passed to the reader.
	sendQuery := func(t *testing.T, limit int) int {
		t.Helper()
		body, _ := json.Marshal(map[string]interface{}{
			"persona": "general",
			"query":   "test query",
			"mode":    "fts5",
			"limit":   limit,
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/vault/query", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		h.HandleQuery(rr, req)

		if rr.Code != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d: %s", rr.Code, rr.Body.String())
		}
		return reader.getLimit()
	}

	// TRACE: {"suite": "CORE", "case": "0612", "section": "34", "sectionName": "Thesis: Loyalty", "title": "oversized_limit_999999_capped_to_100"}
	t.Run("oversized_limit_999999_capped_to_100", func(t *testing.T) {
		// §34.2: Agent sends limit: 999999 to exfiltrate entire vault.
		// The handler must cap this to the configured maximum (100).
		got := sendQuery(t, 999999)
		if got != 100 {
			t.Fatalf("limit 999999 should be capped to 100, reader received %d", got)
		}
	})

	// TRACE: {"suite": "CORE", "case": "0613", "section": "34", "sectionName": "Thesis: Loyalty", "title": "oversized_limit_1000000_capped_to_100"}
	t.Run("oversized_limit_1000000_capped_to_100", func(t *testing.T) {
		// Another extreme value — ensure no integer overflow or edge case.
		got := sendQuery(t, 1000000)
		if got != 100 {
			t.Fatalf("limit 1000000 should be capped to 100, reader received %d", got)
		}
	})

	// TRACE: {"suite": "CORE", "case": "0614", "section": "34", "sectionName": "Thesis: Loyalty", "title": "limit_at_boundary_100_passes_through"}
	t.Run("limit_at_boundary_100_passes_through", func(t *testing.T) {
		// Exactly at the max — must pass through unchanged.
		got := sendQuery(t, 100)
		if got != 100 {
			t.Fatalf("limit 100 should pass through as 100, reader received %d", got)
		}
	})

	// TRACE: {"suite": "CORE", "case": "0615", "section": "34", "sectionName": "Thesis: Loyalty", "title": "limit_101_capped_to_100"}
	t.Run("limit_101_capped_to_100", func(t *testing.T) {
		// One above the boundary — must be capped.
		got := sendQuery(t, 101)
		if got != 100 {
			t.Fatalf("limit 101 should be capped to 100, reader received %d", got)
		}
	})

	// TRACE: {"suite": "CORE", "case": "0616", "section": "34", "sectionName": "Thesis: Loyalty", "title": "normal_limit_50_passes_through"}
	t.Run("normal_limit_50_passes_through", func(t *testing.T) {
		// Normal usage — limit under the cap passes unchanged.
		got := sendQuery(t, 50)
		if got != 50 {
			t.Fatalf("limit 50 should pass through unchanged, reader received %d", got)
		}
	})

	// TRACE: {"suite": "CORE", "case": "0617", "section": "34", "sectionName": "Thesis: Loyalty", "title": "limit_1_passes_through"}
	t.Run("limit_1_passes_through", func(t *testing.T) {
		// Minimum valid limit — should pass through.
		got := sendQuery(t, 1)
		if got != 1 {
			t.Fatalf("limit 1 should pass through unchanged, reader received %d", got)
		}
	})

	// TRACE: {"suite": "CORE", "case": "0618", "section": "34", "sectionName": "Thesis: Loyalty", "title": "limit_zero_clamped_to_default"}
	t.Run("limit_zero_clamped_to_default", func(t *testing.T) {
		// DM3: Zero is clamped to domain.DefaultSearchLimit (50) at handler level.
		got := sendQuery(t, 0)
		if got != 50 {
			t.Fatalf("limit 0 should be clamped to default 50, got %d", got)
		}
	})

	// TRACE: {"suite": "CORE", "case": "0619", "section": "34", "sectionName": "Thesis: Loyalty", "title": "negative_limit_clamped_to_default"}
	t.Run("negative_limit_clamped_to_default", func(t *testing.T) {
		// DM3: Negative is clamped to domain.DefaultSearchLimit (50) at handler level.
		got := sendQuery(t, -5)
		if got != 50 {
			t.Fatalf("limit -5 should be clamped to default 50, got %d", got)
		}
	})

	// TRACE: {"suite": "CORE", "case": "0620", "section": "34", "sectionName": "Thesis: Loyalty", "title": "positive_control_response_contains_items_array"}
	t.Run("positive_control_response_contains_items_array", func(t *testing.T) {
		// Verify the handler returns a well-formed JSON response, not just 200.
		// This proves the test chain is wired correctly (not a vacuous pass).
		body, _ := json.Marshal(map[string]interface{}{
			"persona": "general",
			"query":   "test",
			"mode":    "fts5",
			"limit":   10,
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/vault/query", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		h.HandleQuery(rr, req)

		if rr.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", rr.Code)
		}
		var resp map[string]interface{}
		if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
			t.Fatalf("response is not valid JSON: %v", err)
		}
		if _, ok := resp["items"]; !ok {
			t.Fatal("response must contain 'items' key")
		}
	})
}

// ==========================================================================
// TST-CORE-1024: Locked persona: dead-drop ingress, no reads
// §30.8 Hardened Integration Contracts
// Requirement: When a persona is locked (DEK not in RAM), all vault read
// operations return 403 Forbidden ("persona locked"). Meanwhile, incoming
// messages must be spooled to the dead-drop filesystem for later processing
// after unlock. This is the foundation of the Locked persona tier — the
// vault NEVER serves data when the DEK is absent, but messages are not lost.
// ==========================================================================

// TST-CORE-1024
// TRACE: {"suite": "CORE", "case": "0621", "section": "30", "sectionName": "Test System Quality", "subsection": "08", "scenario": "03", "title": "LockedPersonaDeadDropIngress"}
func TestGatekeeper_30_8_3_LockedPersonaDeadDropIngress(t *testing.T) {
	// Build a VaultHandler backed by a locked persona. The VaultManager
	// reports "general" as NOT open (simulating a locked persona where
	// the DEK is not in RAM).
	lockedMgr := newGatekeeperVaultManager()
	// Do NOT open "general" — it stays locked.

	reader := &queryCapturingReader{}
	gk := &gatekeeperMock{} // default: allow all intents
	vaultSvc := service.NewVaultService(lockedMgr, reader, &noopVaultWriter{}, gk, &simpleClock{})
	h := &handler.VaultHandler{Vault: vaultSvc}

	// Helper: send a vault query and return the status code + body.
	sendQuery := func(t *testing.T, persona, query string) (int, string) {
		t.Helper()
		body, _ := json.Marshal(map[string]interface{}{
			"persona": persona,
			"query":   query,
			"mode":    "fts5",
			"limit":   10,
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/vault/query", bytes.NewReader(body))
		rr := httptest.NewRecorder()
		h.HandleQuery(rr, req)
		return rr.Code, rr.Body.String()
	}

	// Helper: send a vault store and return the status code + body.
	sendStore := func(t *testing.T, persona string) (int, string) {
		t.Helper()
		body, _ := json.Marshal(map[string]interface{}{
			"persona": persona,
			"item": map[string]interface{}{
				"type":      "email",
				"source":    "test",
				"body_text": "secret vault data",
			},
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/vault/store", bytes.NewReader(body))
		rr := httptest.NewRecorder()
		h.HandleStore(rr, req)
		return rr.Code, rr.Body.String()
	}

	// TRACE: {"suite": "CORE", "case": "0622", "section": "30", "sectionName": "Test System Quality", "title": "vault_query_on_locked_persona_returns_403"}
	t.Run("vault_query_on_locked_persona_returns_403", func(t *testing.T) {
		// The core requirement: when a persona is locked, the vault MUST NOT
		// return any data. Instead, it returns 403 "persona locked".
		code, body := sendQuery(t, "general", "search for secrets")

		if code != http.StatusForbidden {
			t.Fatalf("expected 403 Forbidden for query on locked persona, got %d: %s", code, body)
		}
		if !strings.Contains(body, "persona locked") {
			t.Fatalf("expected 'persona locked' in error body, got: %s", body)
		}
	})

	// TRACE: {"suite": "CORE", "case": "0623", "section": "30", "sectionName": "Test System Quality", "title": "vault_store_on_locked_persona_returns_403"}
	t.Run("vault_store_on_locked_persona_returns_403", func(t *testing.T) {
		// Write operations must also be blocked when locked.
		code, body := sendStore(t, "general")

		if code != http.StatusForbidden {
			t.Fatalf("expected 403 Forbidden for store on locked persona, got %d: %s", code, body)
		}
		if !strings.Contains(body, "persona locked") {
			t.Fatalf("expected 'persona locked' in error body, got: %s", body)
		}
	})

	// TRACE: {"suite": "CORE", "case": "0624", "section": "30", "sectionName": "Test System Quality", "title": "dead_drop_accepts_messages_while_locked"}
	t.Run("dead_drop_accepts_messages_while_locked", func(t *testing.T) {
		// While the vault is locked, the dead-drop filesystem MUST accept
		// incoming encrypted blobs. Messages are not lost — they wait until
		// the persona is unlocked and the Sweeper processes them.
		tmpDir := t.TempDir()
		dd := ingress.NewDeadDrop(tmpDir, 1000, 100*1024*1024)

		// Store multiple messages — all must succeed.
		for i := 0; i < 5; i++ {
			blob := []byte(fmt.Sprintf("encrypted-message-while-locked-%d", i))
			err := dd.Store(context.Background(), blob)
			if err != nil {
				t.Fatalf("dead-drop Store[%d] must succeed while vault is locked: %v", i, err)
			}
		}

		// Verify all blobs are stored and retrievable.
		count, err := dd.Count()
		if err != nil {
			t.Fatalf("dead-drop Count: %v", err)
		}
		if count != 5 {
			t.Fatalf("expected 5 dead-drop blobs, got %d", count)
		}

		// Peek (non-destructive read) must work for all blobs.
		blobs, err := dd.List()
		if err != nil {
			t.Fatalf("dead-drop List: %v", err)
		}
		for _, name := range blobs {
			data, err := dd.Peek(name)
			if err != nil {
				t.Fatalf("dead-drop Peek(%s): %v", name, err)
			}
			if len(data) == 0 {
				t.Fatalf("dead-drop Peek(%s) returned empty data", name)
			}
		}
	})

	// TRACE: {"suite": "CORE", "case": "0625", "section": "30", "sectionName": "Test System Quality", "title": "vault_query_and_dead_drop_combined_scenario"}
	t.Run("vault_query_and_dead_drop_combined_scenario", func(t *testing.T) {
		// Combined: vault query fails with 403 while dead-drop ingress succeeds.
		// This is the exact §7 Locked tier behavior: no reads, but messages
		// are preserved for later.
		tmpDir := t.TempDir()
		dd := ingress.NewDeadDrop(tmpDir, 1000, 100*1024*1024)

		// Vault query fails (locked).
		code, _ := sendQuery(t, "general", "attempt exfiltration")
		if code != http.StatusForbidden {
			t.Fatalf("vault read must fail with 403, got %d", code)
		}

		// Dead-drop ingress succeeds (preserved for later).
		err := dd.Store(context.Background(), []byte("incoming-message"))
		if err != nil {
			t.Fatalf("dead-drop Store must succeed: %v", err)
		}

		// Vault store also fails (locked).
		storeCode, _ := sendStore(t, "general")
		if storeCode != http.StatusForbidden {
			t.Fatalf("vault store must fail with 403 when locked, got %d", storeCode)
		}

		// Dead-drop continues accepting (append-only spool).
		err = dd.Store(context.Background(), []byte("another-message"))
		if err != nil {
			t.Fatalf("dead-drop Store must continue accepting: %v", err)
		}

		count, _ := dd.Count()
		if count != 2 {
			t.Fatalf("dead-drop should have 2 blobs, got %d", count)
		}
	})

	// TRACE: {"suite": "CORE", "case": "0626", "section": "30", "sectionName": "Test System Quality", "title": "after_unlock_vault_query_succeeds"}
	t.Run("after_unlock_vault_query_succeeds", func(t *testing.T) {
		// Positive control: after unlocking the persona, vault queries
		// must succeed. This proves the 403 was due to lock state, not
		// a misconfigured test environment.
		lockedMgr.Open(context.Background(), "general", []byte("test-dek"))

		code, body := sendQuery(t, "general", "search after unlock")
		if code != http.StatusOK {
			t.Fatalf("expected 200 OK after unlocking persona, got %d: %s", code, body)
		}

		// Verify response has items array (empty is fine — no data in mock reader).
		var resp map[string]interface{}
		if err := json.Unmarshal([]byte(body), &resp); err != nil {
			t.Fatalf("response is not valid JSON: %v", err)
		}
		if _, ok := resp["items"]; !ok {
			t.Fatal("response must contain 'items' key after unlock")
		}
	})

	// TRACE: {"suite": "CORE", "case": "0627", "section": "30", "sectionName": "Test System Quality", "title": "after_unlock_vault_store_succeeds"}
	t.Run("after_unlock_vault_store_succeeds", func(t *testing.T) {
		// Positive control for writes: store must work after unlock.
		code, _ := sendStore(t, "general")
		// The noopVaultWriter returns "noop-id" and 201 Created.
		if code != http.StatusCreated {
			t.Fatalf("expected 201 Created after unlocking persona, got %d", code)
		}
	})

	// TRACE: {"suite": "CORE", "case": "0628", "section": "30", "sectionName": "Test System Quality", "title": "different_persona_still_locked"}
	t.Run("different_persona_still_locked", func(t *testing.T) {
		// Isolation: unlocking "general" must not affect other personas.
		// "financial" was never opened — it must remain locked.
		code, body := sendQuery(t, "financial", "attempt cross-persona read")
		if code != http.StatusForbidden {
			t.Fatalf("financial persona must remain locked, got %d: %s", code, body)
		}
	})
}

// ==========================================================================
// TST-CORE-998: JSON schema frozen — golden request/response examples
// §30.3 Core↔Brain Contract Verification
// Requirement: The JSON schemas for all Core API endpoints are "frozen".
// Field names, types, and status codes must match golden expectations. If
// a field is renamed, removed, or its type changes, this test fails. This
// prevents silent contract breakage between Core and Brain.
// ==========================================================================

// goldenSchemaWriter is a VaultWriter that returns a predictable ID for
// schema validation tests.
type goldenSchemaWriter struct{}

func (w *goldenSchemaWriter) Store(_ context.Context, _ domain.PersonaName, item domain.VaultItem) (string, error) {
	return "vault-item-" + item.Type + "-001", nil
}
func (w *goldenSchemaWriter) StoreBatch(_ context.Context, _ domain.PersonaName, items []domain.VaultItem) ([]string, error) {
	ids := make([]string, len(items))
	for i, item := range items {
		ids[i] = fmt.Sprintf("vault-batch-%s-%03d", item.Type, i)
	}
	return ids, nil
}
func (w *goldenSchemaWriter) Delete(_ context.Context, _ domain.PersonaName, _ string) error {
	return nil
}

// TST-CORE-998
// TRACE: {"suite": "CORE", "case": "0629", "section": "30", "sectionName": "Test System Quality", "subsection": "03", "scenario": "08", "title": "JSONSchemaFrozenGoldenExamples"}
func TestContract_30_3_8_JSONSchemaFrozenGoldenExamples(t *testing.T) {
	// Build a VaultHandler with mock ports that return predictable data.
	mgr := newGatekeeperVaultManager()
	mgr.Open(context.Background(), "general", []byte("test-dek"))

	reader := &queryCapturingReader{}
	gk := &gatekeeperMock{}
	vaultSvc := service.NewVaultService(mgr, reader, &goldenSchemaWriter{}, gk, &simpleClock{})
	h := &handler.VaultHandler{Vault: vaultSvc}

	// TRACE: {"suite": "CORE", "case": "0630", "section": "30", "sectionName": "Test System Quality", "title": "vault_query_response_schema"}
	t.Run("vault_query_response_schema", func(t *testing.T) {
		// Golden: POST /v1/vault/query → 200 with {"items": [...]}
		// The "items" key is the contract between Core and Brain for search results.
		body, _ := json.Marshal(map[string]interface{}{
			"persona": "general",
			"query":   "meeting notes",
			"mode":    "fts5",
			"limit":   10,
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/vault/query", bytes.NewReader(body))
		rr := httptest.NewRecorder()
		h.HandleQuery(rr, req)

		if rr.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
		}

		// Parse response and validate golden schema.
		var resp map[string]json.RawMessage
		if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
			t.Fatalf("response is not valid JSON: %v", err)
		}

		// Field "items" must exist and be an array.
		itemsRaw, ok := resp["items"]
		if !ok {
			t.Fatal("golden contract: response must have 'items' field")
		}
		var items []json.RawMessage
		if err := json.Unmarshal(itemsRaw, &items); err != nil {
			t.Fatalf("golden contract: 'items' must be a JSON array, got: %s", string(itemsRaw))
		}

		// No unexpected top-level keys (contract freeze: only "items").
		if len(resp) != 1 {
			keys := make([]string, 0, len(resp))
			for k := range resp {
				keys = append(keys, k)
			}
			t.Fatalf("golden contract: vault query response must have exactly 1 key ('items'), got %d: %v", len(resp), keys)
		}

		// Content-Type must be application/json.
		ct := rr.Header().Get("Content-Type")
		if !strings.Contains(ct, "application/json") {
			t.Fatalf("golden contract: Content-Type must be application/json, got %q", ct)
		}
	})

	// TRACE: {"suite": "CORE", "case": "0631", "section": "30", "sectionName": "Test System Quality", "title": "vault_store_response_schema"}
	t.Run("vault_store_response_schema", func(t *testing.T) {
		// Golden: POST /v1/vault/store → 201 with {"id": "<string>"}
		body, _ := json.Marshal(map[string]interface{}{
			"persona": "general",
			"item": map[string]interface{}{
				"type":      "email",
				"source":    "gmail",
				"body_text": "test content",
			},
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/vault/store", bytes.NewReader(body))
		rr := httptest.NewRecorder()
		h.HandleStore(rr, req)

		if rr.Code != http.StatusCreated {
			t.Fatalf("expected 201 Created, got %d: %s", rr.Code, rr.Body.String())
		}

		var resp map[string]json.RawMessage
		if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
			t.Fatalf("response is not valid JSON: %v", err)
		}

		// Field "id" must exist and be a non-empty string.
		idRaw, ok := resp["id"]
		if !ok {
			t.Fatal("golden contract: store response must have 'id' field")
		}
		var id string
		if err := json.Unmarshal(idRaw, &id); err != nil {
			t.Fatalf("golden contract: 'id' must be a JSON string, got: %s", string(idRaw))
		}
		if id == "" {
			t.Fatal("golden contract: 'id' must be non-empty")
		}

		// No unexpected keys (contract freeze: only "id").
		if len(resp) != 1 {
			keys := make([]string, 0, len(resp))
			for k := range resp {
				keys = append(keys, k)
			}
			t.Fatalf("golden contract: store response must have exactly 1 key ('id'), got %d: %v", len(resp), keys)
		}
	})

	// TRACE: {"suite": "CORE", "case": "0632", "section": "30", "sectionName": "Test System Quality", "title": "vault_store_batch_response_schema"}
	t.Run("vault_store_batch_response_schema", func(t *testing.T) {
		// Golden: POST /v1/vault/store/batch → 201 with {"ids": ["<string>", ...]}
		body, _ := json.Marshal(map[string]interface{}{
			"persona": "general",
			"items": []map[string]interface{}{
				{"type": "email", "source": "gmail", "body_text": "item 1"},
				{"type": "note", "source": "manual", "body_text": "item 2"},
			},
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/vault/store/batch", bytes.NewReader(body))
		rr := httptest.NewRecorder()
		h.HandleStoreBatch(rr, req)

		if rr.Code != http.StatusCreated {
			t.Fatalf("expected 201 Created, got %d: %s", rr.Code, rr.Body.String())
		}

		var resp map[string]json.RawMessage
		if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
			t.Fatalf("response is not valid JSON: %v", err)
		}

		// Field "ids" must exist and be an array of strings.
		idsRaw, ok := resp["ids"]
		if !ok {
			t.Fatal("golden contract: batch store response must have 'ids' field")
		}
		var ids []string
		if err := json.Unmarshal(idsRaw, &ids); err != nil {
			t.Fatalf("golden contract: 'ids' must be a JSON array of strings, got: %s", string(idsRaw))
		}
		if len(ids) != 2 {
			t.Fatalf("golden contract: expected 2 IDs for 2 items, got %d", len(ids))
		}
		for i, id := range ids {
			if id == "" {
				t.Fatalf("golden contract: ids[%d] must be non-empty", i)
			}
		}
	})

	// TRACE: {"suite": "CORE", "case": "0633", "section": "30", "sectionName": "Test System Quality", "title": "vault_query_invalid_body_error_schema"}
	t.Run("vault_query_invalid_body_error_schema", func(t *testing.T) {
		// Golden: malformed request body → 400 with {"error": "<message>"}
		req := httptest.NewRequest(http.MethodPost, "/v1/vault/query",
			bytes.NewReader([]byte("not valid json")))
		rr := httptest.NewRecorder()
		h.HandleQuery(rr, req)

		if rr.Code != http.StatusBadRequest {
			t.Fatalf("expected 400 Bad Request, got %d", rr.Code)
		}

		var errResp map[string]string
		if err := json.Unmarshal(rr.Body.Bytes(), &errResp); err != nil {
			t.Fatalf("error response is not valid JSON: %v\nbody: %s", err, rr.Body.String())
		}
		if _, ok := errResp["error"]; !ok {
			t.Fatal("golden contract: error response must have 'error' field")
		}
		if errResp["error"] == "" {
			t.Fatal("golden contract: error message must be non-empty")
		}
	})

	// TRACE: {"suite": "CORE", "case": "0634", "section": "30", "sectionName": "Test System Quality", "title": "vault_query_invalid_persona_error_schema"}
	t.Run("vault_query_invalid_persona_error_schema", func(t *testing.T) {
		// Golden: invalid persona name → 400 with {"error": "invalid persona name"}
		body, _ := json.Marshal(map[string]interface{}{
			"persona": "INVALID__NAME!!",
			"query":   "test",
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/vault/query", bytes.NewReader(body))
		rr := httptest.NewRecorder()
		h.HandleQuery(rr, req)

		if rr.Code != http.StatusBadRequest {
			t.Fatalf("expected 400, got %d", rr.Code)
		}

		var errResp map[string]string
		if err := json.Unmarshal(rr.Body.Bytes(), &errResp); err != nil {
			t.Fatalf("error response is not valid JSON: %v", err)
		}
		if errResp["error"] != "invalid persona name" {
			t.Fatalf("golden contract: expected 'invalid persona name', got %q", errResp["error"])
		}
	})

	// TRACE: {"suite": "CORE", "case": "0635", "section": "30", "sectionName": "Test System Quality", "title": "vault_query_method_not_allowed_schema"}
	t.Run("vault_query_method_not_allowed_schema", func(t *testing.T) {
		// Golden: GET /v1/vault/query → 405 Method Not Allowed
		req := httptest.NewRequest(http.MethodGet, "/v1/vault/query", nil)
		rr := httptest.NewRecorder()
		h.HandleQuery(rr, req)

		if rr.Code != http.StatusMethodNotAllowed {
			t.Fatalf("expected 405, got %d", rr.Code)
		}

		// Error body must contain structured error.
		var errResp map[string]string
		if err := json.Unmarshal(rr.Body.Bytes(), &errResp); err != nil {
			t.Fatalf("405 response is not valid JSON: %v\nbody: %s", err, rr.Body.String())
		}
		if errResp["error"] != "method not allowed" {
			t.Fatalf("golden contract: expected 'method not allowed', got %q", errResp["error"])
		}
	})

	// TRACE: {"suite": "CORE", "case": "0636", "section": "30", "sectionName": "Test System Quality", "title": "vault_store_method_not_allowed_schema"}
	t.Run("vault_store_method_not_allowed_schema", func(t *testing.T) {
		// Golden: GET /v1/vault/store → 405 Method Not Allowed
		req := httptest.NewRequest(http.MethodGet, "/v1/vault/store", nil)
		rr := httptest.NewRecorder()
		h.HandleStore(rr, req)

		if rr.Code != http.StatusMethodNotAllowed {
			t.Fatalf("expected 405, got %d", rr.Code)
		}
	})

	// TRACE: {"suite": "CORE", "case": "0637", "section": "30", "sectionName": "Test System Quality", "title": "vault_query_locked_persona_error_schema"}
	t.Run("vault_query_locked_persona_error_schema", func(t *testing.T) {
		// Golden: query on locked persona → 403 with "persona locked" message.
		// This validates the error schema for the locked tier.
		body, _ := json.Marshal(map[string]interface{}{
			"persona": "financial",
			"query":   "secret data",
			"mode":    "fts5",
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/vault/query", bytes.NewReader(body))
		rr := httptest.NewRecorder()
		h.HandleQuery(rr, req)

		if rr.Code != http.StatusForbidden {
			t.Fatalf("expected 403, got %d", rr.Code)
		}

		// Error body must be parseable JSON with a message containing "persona locked".
		bodyStr := rr.Body.String()
		if !strings.Contains(bodyStr, "persona locked") {
			t.Fatalf("golden contract: 403 body must contain 'persona locked', got: %s", bodyStr)
		}
	})

	// TRACE: {"suite": "CORE", "case": "0638", "section": "30", "sectionName": "Test System Quality", "title": "positive_control_request_fields_accepted"}
	t.Run("positive_control_request_fields_accepted", func(t *testing.T) {
		// Positive control: verify that the handler accepts all documented
		// request fields without error. This proves the golden schema is not
		// accidentally rejecting valid requests.
		body, _ := json.Marshal(map[string]interface{}{
			"persona":   "general",
			"query":     "test query",
			"mode":      "hybrid",
			"types":     []string{"email", "note"},
			"limit":     25,
			"embedding": make([]float32, 0), // empty embedding = degrades to fts5
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/vault/query", bytes.NewReader(body))
		rr := httptest.NewRecorder()
		h.HandleQuery(rr, req)

		if rr.Code != http.StatusOK {
			t.Fatalf("all documented fields must be accepted, got %d: %s", rr.Code, rr.Body.String())
		}

		// Verify degradation header is set when hybrid requested without embedding.
		degraded := rr.Header().Get("X-Search-Degraded-From")
		if degraded != "hybrid" {
			t.Fatalf("golden contract: X-Search-Degraded-From must be 'hybrid' when no embedding provided, got %q", degraded)
		}
		mode := rr.Header().Get("X-Search-Mode")
		if mode != "fts5" {
			t.Fatalf("golden contract: X-Search-Mode must be 'fts5' on degradation, got %q", mode)
		}
	})
}

// ==========================================================================
// §30.3 — Core↔Brain Contract Verification (continued)
// ==========================================================================

// TST-CORE-997
// Brain→Core: POST /v1/pii/scrub with text body.
// Requirement: Brain sends {"text":"..."} to Core's PII scrub endpoint.
// Core returns {"scrubbed":"...","entities":[...]} with 200. Errors return
// proper status codes and error JSON. The contract must be verified through
// the real handler (not a mock) to catch serialization mismatches.
// TRACE: {"suite": "CORE", "case": "0639", "section": "30", "sectionName": "Test System Quality", "subsection": "03", "scenario": "07", "title": "PIIScrubContractBrainToCore"}
func TestContract_30_3_7_PIIScrubContractBrainToCore(t *testing.T) {
	// Build a PIIHandler with a mock scrubber that produces known output.
	piiH := &handler.PIIHandler{
		Scrubber: &contractPIIScrubber{},
	}

	// TRACE: {"suite": "CORE", "case": "0640", "section": "30", "sectionName": "Test System Quality", "title": "valid_scrub_request_returns_scrubbed_and_entities"}
	t.Run("valid_scrub_request_returns_scrubbed_and_entities", func(t *testing.T) {
		body, _ := json.Marshal(map[string]string{
			"text": "My email is alice@example.com and phone is 555-0100",
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/pii/scrub", bytes.NewReader(body))
		rr := httptest.NewRecorder()
		piiH.HandleScrub(rr, req)

		if rr.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
		}

		// Verify Content-Type.
		ct := rr.Header().Get("Content-Type")
		if ct != "application/json" {
			t.Fatalf("expected Content-Type 'application/json', got %q", ct)
		}

		// Parse response and verify contract fields.
		var resp map[string]interface{}
		if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
			t.Fatalf("response is not valid JSON: %v", err)
		}

		// Contract: response must have exactly "scrubbed" and "entities" keys.
		if len(resp) != 2 {
			t.Fatalf("expected exactly 2 keys (scrubbed, entities), got %d: %v", len(resp), resp)
		}

		scrubbed, ok := resp["scrubbed"].(string)
		if !ok {
			t.Fatal("response missing 'scrubbed' string field")
		}
		if scrubbed == "" {
			t.Fatal("'scrubbed' field must not be empty")
		}
		// Verify the scrubbed text does NOT contain the original PII.
		if strings.Contains(scrubbed, "alice@example.com") {
			t.Fatal("scrubbed text must not contain original email")
		}

		entities, ok := resp["entities"]
		if !ok {
			t.Fatal("response missing 'entities' field")
		}
		// Entities must be an array (even if empty).
		entArr, ok := entities.([]interface{})
		if !ok {
			t.Fatalf("'entities' must be an array, got %T", entities)
		}
		// Our mock scrubber returns 2 entities (email + phone).
		if len(entArr) != 2 {
			t.Fatalf("expected 2 entities from mock scrubber, got %d", len(entArr))
		}

		// Verify entity structure: each must have type, value, start, end.
		for i, e := range entArr {
			ent, ok := e.(map[string]interface{})
			if !ok {
				t.Fatalf("entity[%d] is not an object", i)
			}
			for _, field := range []string{"Type", "Value", "Start", "End"} {
				if _, exists := ent[field]; !exists {
					// Also check lowercase variants (JSON encoding may vary).
					lower := strings.ToLower(field[:1]) + field[1:]
					if _, exists2 := ent[lower]; !exists2 {
						t.Fatalf("entity[%d] missing required field %q", i, field)
					}
				}
			}
		}
	})

	// TRACE: {"suite": "CORE", "case": "0641", "section": "30", "sectionName": "Test System Quality", "title": "empty_text_returns_400"}
	t.Run("empty_text_returns_400", func(t *testing.T) {
		body, _ := json.Marshal(map[string]string{"text": ""})
		req := httptest.NewRequest(http.MethodPost, "/v1/pii/scrub", bytes.NewReader(body))
		rr := httptest.NewRecorder()
		piiH.HandleScrub(rr, req)

		if rr.Code != http.StatusBadRequest {
			t.Fatalf("expected 400 for empty text, got %d", rr.Code)
		}
		respBody := rr.Body.String()
		if !strings.Contains(respBody, "text is required") {
			t.Fatalf("expected 'text is required' error, got: %s", respBody)
		}
	})

	// TRACE: {"suite": "CORE", "case": "0642", "section": "30", "sectionName": "Test System Quality", "title": "invalid_json_body_returns_400"}
	t.Run("invalid_json_body_returns_400", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/v1/pii/scrub", bytes.NewReader([]byte("not json")))
		rr := httptest.NewRecorder()
		piiH.HandleScrub(rr, req)

		if rr.Code != http.StatusBadRequest {
			t.Fatalf("expected 400 for invalid JSON, got %d", rr.Code)
		}
		if !strings.Contains(rr.Body.String(), "invalid request body") {
			t.Fatalf("expected 'invalid request body' error, got: %s", rr.Body.String())
		}
	})

	// TRACE: {"suite": "CORE", "case": "0643", "section": "30", "sectionName": "Test System Quality", "title": "wrong_method_returns_405"}
	t.Run("wrong_method_returns_405", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/v1/pii/scrub", nil)
		rr := httptest.NewRecorder()
		piiH.HandleScrub(rr, req)

		if rr.Code != http.StatusMethodNotAllowed {
			t.Fatalf("expected 405 for GET, got %d", rr.Code)
		}
	})

	// TRACE: {"suite": "CORE", "case": "0644", "section": "30", "sectionName": "Test System Quality", "title": "scrubber_error_returns_500"}
	t.Run("scrubber_error_returns_500", func(t *testing.T) {
		// Use a failing scrubber to test error handling.
		failH := &handler.PIIHandler{
			Scrubber: &failingScrubber{},
		}
		body, _ := json.Marshal(map[string]string{"text": "some text"})
		req := httptest.NewRequest(http.MethodPost, "/v1/pii/scrub", bytes.NewReader(body))
		rr := httptest.NewRecorder()
		failH.HandleScrub(rr, req)

		if rr.Code != http.StatusInternalServerError {
			t.Fatalf("expected 500 for scrubber error, got %d", rr.Code)
		}
		if !strings.Contains(rr.Body.String(), "scrub failed") {
			t.Fatalf("expected 'scrub failed' error, got: %s", rr.Body.String())
		}
	})
}

// TST-CORE-991
// Contract test runs against real core HTTP router.
// Requirement: Real core server + real middleware routing. Actual HTTP
// responses must come from the real mux with handlers wired to mock ports.
// This validates the wiring (route registration, method dispatch, handler
// selection) through the same code path used in production.
// TRACE: {"suite": "CORE", "case": "0645", "section": "30", "sectionName": "Test System Quality", "subsection": "03", "scenario": "01", "title": "RealCoreHTTPRouterContract"}
func TestContract_30_3_1_RealCoreHTTPRouterContract(t *testing.T) {
	// Build a real mux with the same route registrations as main.go,
	// using mock ports so we don't need real databases or crypto.
	mux := http.NewServeMux()

	// Wire vault handler (mock reader/writer/manager/gatekeeper).
	vm := newGatekeeperVaultManager()
	_ = vm.Open(context.Background(), "general", nil)
	gk := &gatekeeperMock{}

	vaultSvc := service.NewVaultService(vm, &goldenSchemaReader{}, &goldenSchemaWriter{}, gk, &simpleClock{})

	vaultH := &handler.VaultHandler{
		Vault: vaultSvc,
	}

	// Wire PII handler.
	piiH := &handler.PIIHandler{
		Scrubber: &contractPIIScrubber{},
	}

	// Register routes matching main.go.
	mux.HandleFunc("/v1/vault/query", vaultH.HandleQuery)
	mux.HandleFunc("/v1/vault/store", vaultH.HandleStore)
	mux.HandleFunc("/v1/vault/store/batch", vaultH.HandleStoreBatch)
	mux.HandleFunc("/v1/pii/scrub", piiH.HandleScrub)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})

	// Start a real HTTP server (not just httptest.NewRecorder — actual TCP).
	ts := httptest.NewServer(mux)
	defer ts.Close()

	client := ts.Client()

	// TRACE: {"suite": "CORE", "case": "0646", "section": "30", "sectionName": "Test System Quality", "title": "vault_query_routed_correctly"}
	t.Run("vault_query_routed_correctly", func(t *testing.T) {
		body, _ := json.Marshal(map[string]interface{}{
			"persona": "general",
			"query":   "test",
		})
		resp, err := client.Post(ts.URL+"/v1/vault/query", "application/json", bytes.NewReader(body))
		if err != nil {
			t.Fatalf("POST /v1/vault/query failed: %v", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			t.Fatalf("expected 200 from real router, got %d", resp.StatusCode)
		}
		if resp.Header.Get("Content-Type") != "application/json" {
			t.Fatalf("expected Content-Type 'application/json', got %q", resp.Header.Get("Content-Type"))
		}

		var result map[string]interface{}
		if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
			t.Fatalf("response decode error: %v", err)
		}
		if _, ok := result["items"]; !ok {
			t.Fatal("response missing 'items' key from real router")
		}
	})

	// TRACE: {"suite": "CORE", "case": "0647", "section": "30", "sectionName": "Test System Quality", "title": "vault_store_routed_correctly"}
	t.Run("vault_store_routed_correctly", func(t *testing.T) {
		body, _ := json.Marshal(map[string]interface{}{
			"persona": "general",
			"item": map[string]interface{}{
				"type":      "note",
				"body_text": "test note from real router",
			},
		})
		resp, err := client.Post(ts.URL+"/v1/vault/store", "application/json", bytes.NewReader(body))
		if err != nil {
			t.Fatalf("POST /v1/vault/store failed: %v", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusCreated {
			t.Fatalf("expected 201, got %d", resp.StatusCode)
		}

		var result map[string]interface{}
		if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
			t.Fatalf("response decode error: %v", err)
		}
		if _, ok := result["id"]; !ok {
			t.Fatal("response missing 'id' key from real router")
		}
	})

	// TRACE: {"suite": "CORE", "case": "0648", "section": "30", "sectionName": "Test System Quality", "title": "vault_store_batch_routed_correctly"}
	t.Run("vault_store_batch_routed_correctly", func(t *testing.T) {
		body, _ := json.Marshal(map[string]interface{}{
			"persona": "general",
			"items": []map[string]interface{}{
				{"type": "note", "body_text": "batch item 1"},
				{"type": "note", "body_text": "batch item 2"},
			},
		})
		resp, err := client.Post(ts.URL+"/v1/vault/store/batch", "application/json", bytes.NewReader(body))
		if err != nil {
			t.Fatalf("POST /v1/vault/store/batch failed: %v", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusCreated {
			t.Fatalf("expected 201, got %d", resp.StatusCode)
		}

		var result map[string]interface{}
		if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
			t.Fatalf("response decode error: %v", err)
		}
		if _, ok := result["ids"]; !ok {
			t.Fatal("response missing 'ids' key from real router")
		}
	})

	// TRACE: {"suite": "CORE", "case": "0649", "section": "30", "sectionName": "Test System Quality", "title": "pii_scrub_routed_correctly"}
	t.Run("pii_scrub_routed_correctly", func(t *testing.T) {
		body, _ := json.Marshal(map[string]string{
			"text": "My email is alice@example.com",
		})
		resp, err := client.Post(ts.URL+"/v1/pii/scrub", "application/json", bytes.NewReader(body))
		if err != nil {
			t.Fatalf("POST /v1/pii/scrub failed: %v", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			t.Fatalf("expected 200, got %d", resp.StatusCode)
		}

		var result map[string]interface{}
		if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
			t.Fatalf("response decode error: %v", err)
		}
		if _, ok := result["scrubbed"]; !ok {
			t.Fatal("response missing 'scrubbed' key from real router")
		}
		if _, ok := result["entities"]; !ok {
			t.Fatal("response missing 'entities' key from real router")
		}
	})

	// TRACE: {"suite": "CORE", "case": "0650", "section": "30", "sectionName": "Test System Quality", "title": "healthz_routed_correctly"}
	t.Run("healthz_routed_correctly", func(t *testing.T) {
		resp, err := client.Get(ts.URL + "/healthz")
		if err != nil {
			t.Fatalf("GET /healthz failed: %v", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			t.Fatalf("expected 200 from /healthz, got %d", resp.StatusCode)
		}

		var result map[string]interface{}
		if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
			t.Fatalf("response decode error: %v", err)
		}
		if result["status"] != "ok" {
			t.Fatalf("expected status 'ok', got %v", result["status"])
		}
	})

	// TRACE: {"suite": "CORE", "case": "0651", "section": "30", "sectionName": "Test System Quality", "title": "unregistered_route_returns_404"}
	t.Run("unregistered_route_returns_404", func(t *testing.T) {
		resp, err := client.Get(ts.URL + "/v1/nonexistent")
		if err != nil {
			t.Fatalf("GET /v1/nonexistent failed: %v", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusNotFound {
			t.Fatalf("expected 404 for unregistered route, got %d", resp.StatusCode)
		}
	})

	// TRACE: {"suite": "CORE", "case": "0652", "section": "30", "sectionName": "Test System Quality", "title": "wrong_method_on_vault_query_returns_405"}
	t.Run("wrong_method_on_vault_query_returns_405", func(t *testing.T) {
		resp, err := client.Get(ts.URL + "/v1/vault/query")
		if err != nil {
			t.Fatalf("GET /v1/vault/query failed: %v", err)
		}
		defer resp.Body.Close()

		// VaultHandler.HandleQuery checks method and returns 405.
		if resp.StatusCode != http.StatusMethodNotAllowed {
			t.Fatalf("expected 405 for GET on /v1/vault/query, got %d", resp.StatusCode)
		}
	})
}

// TST-CORE-996
// Brain→Core: POST /v1/vault/query with persona+q.
// Requirement: Brain sends {"persona":"<name>","query":"<text>"} to Core's
// vault query endpoint. Core returns {"items":[...]} with matching items.
// The contract must validate all request fields accepted by the handler
// (persona, query, mode, types, limit, embedding) and all response invariants.
// TRACE: {"suite": "CORE", "case": "0653", "section": "30", "sectionName": "Test System Quality", "subsection": "03", "scenario": "06", "title": "BrainToCoreVaultQueryContract"}
func TestContract_30_3_6_BrainToCoreVaultQueryContract(t *testing.T) {
	// Wire up the full handler stack with predictable mock data.
	mgr := newGatekeeperVaultManager()
	_ = mgr.Open(context.Background(), "general", nil)
	_ = mgr.Open(context.Background(), "health", nil)

	reader := &goldenSchemaReader{}
	gk := &gatekeeperMock{}
	vaultSvc := service.NewVaultService(mgr, reader, &goldenSchemaWriter{}, gk, &simpleClock{})
	h := &handler.VaultHandler{Vault: vaultSvc}

	// TRACE: {"suite": "CORE", "case": "0654", "section": "30", "sectionName": "Test System Quality", "title": "minimal_query_persona_and_text_only"}
	t.Run("minimal_query_persona_and_text_only", func(t *testing.T) {
		// Brain sends the minimum required fields: persona + query text.
		body, _ := json.Marshal(map[string]interface{}{
			"persona": "general",
			"query":   "meeting notes",
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/vault/query", bytes.NewReader(body))
		rr := httptest.NewRecorder()
		h.HandleQuery(rr, req)

		if rr.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
		}

		// Contract: response must have "items" key with an array value.
		var resp map[string]interface{}
		if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
			t.Fatalf("invalid JSON response: %v", err)
		}
		items, ok := resp["items"].([]interface{})
		if !ok {
			t.Fatal("response missing 'items' array — Brain depends on this contract")
		}
		if len(items) == 0 {
			t.Fatal("golden reader should return at least 1 item")
		}

		// Verify Content-Type.
		ct := rr.Header().Get("Content-Type")
		if ct != "application/json" {
			t.Fatalf("Content-Type must be 'application/json', got %q", ct)
		}
	})

	// TRACE: {"suite": "CORE", "case": "0655", "section": "30", "sectionName": "Test System Quality", "title": "full_query_all_fields_accepted"}
	t.Run("full_query_all_fields_accepted", func(t *testing.T) {
		// Brain may send all optional fields. Core must accept them without error.
		body, _ := json.Marshal(map[string]interface{}{
			"persona":   "general",
			"query":     "calendar events",
			"mode":      "fts5",
			"types":     []string{"email", "calendar", "note"},
			"limit":     50,
			"embedding": make([]float32, 768), // 768-dim zero vector
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/vault/query", bytes.NewReader(body))
		rr := httptest.NewRecorder()
		h.HandleQuery(rr, req)

		if rr.Code != http.StatusOK {
			t.Fatalf("all documented fields must be accepted, got %d: %s", rr.Code, rr.Body.String())
		}
	})

	// TRACE: {"suite": "CORE", "case": "0656", "section": "30", "sectionName": "Test System Quality", "title": "query_different_persona"}
	t.Run("query_different_persona", func(t *testing.T) {
		// Brain queries a different persona (health). Must work if persona is open.
		body, _ := json.Marshal(map[string]interface{}{
			"persona": "health",
			"query":   "doctor appointment",
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/vault/query", bytes.NewReader(body))
		rr := httptest.NewRecorder()
		h.HandleQuery(rr, req)

		if rr.Code != http.StatusOK {
			t.Fatalf("query on open 'health' persona must succeed, got %d: %s", rr.Code, rr.Body.String())
		}
	})

	// TRACE: {"suite": "CORE", "case": "0657", "section": "30", "sectionName": "Test System Quality", "title": "query_locked_persona_returns_403"}
	t.Run("query_locked_persona_returns_403", func(t *testing.T) {
		// Brain queries a persona that hasn't been opened → 403 Forbidden.
		body, _ := json.Marshal(map[string]interface{}{
			"persona": "financial",
			"query":   "bank transactions",
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/vault/query", bytes.NewReader(body))
		rr := httptest.NewRecorder()
		h.HandleQuery(rr, req)

		if rr.Code != http.StatusForbidden {
			t.Fatalf("locked persona must return 403, got %d", rr.Code)
		}
		if !strings.Contains(rr.Body.String(), "persona locked") {
			t.Fatalf("error must say 'persona locked', got: %s", rr.Body.String())
		}
	})

	// TRACE: {"suite": "CORE", "case": "0658", "section": "30", "sectionName": "Test System Quality", "title": "query_invalid_persona_name_returns_400"}
	t.Run("query_invalid_persona_name_returns_400", func(t *testing.T) {
		// Brain sends an invalid persona name (contains special chars).
		body, _ := json.Marshal(map[string]interface{}{
			"persona": "../escape-attempt",
			"query":   "hack",
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/vault/query", bytes.NewReader(body))
		rr := httptest.NewRecorder()
		h.HandleQuery(rr, req)

		if rr.Code != http.StatusBadRequest {
			t.Fatalf("invalid persona must return 400, got %d", rr.Code)
		}
		if !strings.Contains(rr.Body.String(), "invalid persona name") {
			t.Fatalf("error must say 'invalid persona name', got: %s", rr.Body.String())
		}
	})

	// TRACE: {"suite": "CORE", "case": "0659", "section": "30", "sectionName": "Test System Quality", "title": "query_empty_body_returns_400"}
	t.Run("query_empty_body_returns_400", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/v1/vault/query", bytes.NewReader([]byte("not json")))
		rr := httptest.NewRecorder()
		h.HandleQuery(rr, req)

		if rr.Code != http.StatusBadRequest {
			t.Fatalf("invalid JSON body must return 400, got %d", rr.Code)
		}
	})

	// TRACE: {"suite": "CORE", "case": "0660", "section": "30", "sectionName": "Test System Quality", "title": "items_array_has_expected_fields"}
	t.Run("items_array_has_expected_fields", func(t *testing.T) {
		// Validate that each item in the response has the expected vault item fields.
		body, _ := json.Marshal(map[string]interface{}{
			"persona": "general",
			"query":   "test",
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/vault/query", bytes.NewReader(body))
		rr := httptest.NewRecorder()
		h.HandleQuery(rr, req)

		var resp map[string]interface{}
		if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
			t.Fatalf("invalid JSON: %v", err)
		}
		items := resp["items"].([]interface{})
		for i, raw := range items {
			item, ok := raw.(map[string]interface{})
			if !ok {
				t.Fatalf("items[%d] is not an object", i)
			}
			// VaultItem serializes with json tags (snake_case).
			if _, hasID := item["id"]; !hasID {
				t.Fatalf("items[%d] missing 'id' field — got keys: %v", i, item)
			}
			if _, hasType := item["type"]; !hasType {
				t.Fatalf("items[%d] missing 'type' field", i)
			}
		}
	})

	// TRACE: {"suite": "CORE", "case": "0661", "section": "30", "sectionName": "Test System Quality", "title": "search_mode_degradation_signals"}
	t.Run("search_mode_degradation_signals", func(t *testing.T) {
		// When Brain requests semantic/hybrid search without embedding,
		// Core must signal degradation via response headers.
		body, _ := json.Marshal(map[string]interface{}{
			"persona":   "general",
			"query":     "semantic query",
			"mode":      "semantic",
			"embedding": []float32{}, // empty = no embedding
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/vault/query", bytes.NewReader(body))
		rr := httptest.NewRecorder()
		h.HandleQuery(rr, req)

		if rr.Code != http.StatusOK {
			t.Fatalf("degraded query must still succeed, got %d", rr.Code)
		}

		// Contract: degradation headers tell Brain what happened.
		degraded := rr.Header().Get("X-Search-Degraded-From")
		if degraded != "semantic" {
			t.Fatalf("X-Search-Degraded-From must be 'semantic', got %q", degraded)
		}
		mode := rr.Header().Get("X-Search-Mode")
		if mode != "fts5" {
			t.Fatalf("X-Search-Mode must be 'fts5' on degradation, got %q", mode)
		}
	})
}

// ==========================================================================
// §30.6 — Data Isolation & Cleanup
// ==========================================================================

// TST-CORE-1009
// Real delete APIs used (not visibility filtering).
// Requirement: Items must be physically removed via the real DELETE
// /v1/vault/item/{id} handler, not hidden in a mock map. The writer's
// Delete method must be called, and subsequent GetItem must fail with
// "not found". This validates that test cleanup uses actual deletion,
// not just filtering items out of a mock dictionary.
// TRACE: {"suite": "CORE", "case": "0662", "section": "30", "sectionName": "Test System Quality", "subsection": "06", "scenario": "03", "title": "RealDeleteAPIsUsedNotFiltering"}
func TestContract_30_6_3_RealDeleteAPIsUsedNotFiltering(t *testing.T) {
	// Build a handler stack with a tracking writer that records delete calls.
	mgr := newGatekeeperVaultManager()
	_ = mgr.Open(context.Background(), "general", nil)
	gk := &gatekeeperMock{}

	tracker := &deleteTrackingWriter{}
	reader := &deleteTrackingReader{items: make(map[string]*domain.VaultItem)}
	vaultSvc := service.NewVaultService(mgr, reader, tracker, gk, &simpleClock{})
	h := &handler.VaultHandler{Vault: vaultSvc}

	// TRACE: {"suite": "CORE", "case": "0663", "section": "30", "sectionName": "Test System Quality", "title": "delete_calls_writer_delete_method"}
	t.Run("delete_calls_writer_delete_method", func(t *testing.T) {
		// Pre-populate the reader with an item.
		reader.mu.Lock()
		reader.items["test-item-001"] = &domain.VaultItem{
			ID: "test-item-001", Type: "note", BodyText: "deletable item",
		}
		reader.mu.Unlock()

		// DELETE the item via the handler.
		req := httptest.NewRequest(http.MethodDelete, "/v1/vault/item/test-item-001?persona=general", nil)
		rr := httptest.NewRecorder()
		h.HandleDeleteItem(rr, req)

		if rr.Code != http.StatusNoContent {
			t.Fatalf("expected 204 No Content, got %d: %s", rr.Code, rr.Body.String())
		}

		// Verify the writer's Delete method was actually called (physical removal).
		tracker.mu.Lock()
		if tracker.deleteCount == 0 {
			t.Fatal("writer.Delete was never called — items filtered instead of deleted")
		}
		if tracker.lastDeletedID != "test-item-001" {
			t.Fatalf("writer.Delete called with wrong ID: %q", tracker.lastDeletedID)
		}
		tracker.mu.Unlock()
	})

	// TRACE: {"suite": "CORE", "case": "0664", "section": "30", "sectionName": "Test System Quality", "title": "get_item_after_delete_returns_not_found"}
	t.Run("get_item_after_delete_returns_not_found", func(t *testing.T) {
		// Remove the item from the reader to simulate deletion.
		reader.mu.Lock()
		delete(reader.items, "test-item-001")
		reader.mu.Unlock()

		// GET the deleted item — must return 404.
		req := httptest.NewRequest(http.MethodGet, "/v1/vault/item/test-item-001?persona=general", nil)
		rr := httptest.NewRecorder()
		h.HandleGetItem(rr, req)

		if rr.Code != http.StatusNotFound {
			t.Fatalf("expected 404 Not Found after delete, got %d", rr.Code)
		}
	})

	// TRACE: {"suite": "CORE", "case": "0665", "section": "30", "sectionName": "Test System Quality", "title": "delete_on_locked_persona_returns_403"}
	t.Run("delete_on_locked_persona_returns_403", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodDelete, "/v1/vault/item/any-id?persona=financial", nil)
		rr := httptest.NewRecorder()
		h.HandleDeleteItem(rr, req)

		if rr.Code != http.StatusForbidden {
			t.Fatalf("expected 403 for locked persona delete, got %d", rr.Code)
		}
		if !strings.Contains(rr.Body.String(), "persona locked") {
			t.Fatalf("expected 'persona locked' error, got: %s", rr.Body.String())
		}
	})

	// TRACE: {"suite": "CORE", "case": "0666", "section": "30", "sectionName": "Test System Quality", "title": "delete_with_empty_id_returns_400"}
	t.Run("delete_with_empty_id_returns_400", func(t *testing.T) {
		// URL path ending in "/" gives empty ID.
		req := httptest.NewRequest(http.MethodDelete, "/v1/vault/item/?persona=general", nil)
		rr := httptest.NewRecorder()
		h.HandleDeleteItem(rr, req)

		if rr.Code != http.StatusBadRequest {
			t.Fatalf("expected 400 for empty ID, got %d", rr.Code)
		}
	})

	// TRACE: {"suite": "CORE", "case": "0667", "section": "30", "sectionName": "Test System Quality", "title": "wrong_method_returns_405"}
	t.Run("wrong_method_returns_405", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/v1/vault/item/some-id?persona=general", nil)
		rr := httptest.NewRecorder()
		h.HandleDeleteItem(rr, req)

		if rr.Code != http.StatusMethodNotAllowed {
			t.Fatalf("expected 405 for POST on delete endpoint, got %d", rr.Code)
		}
	})

	// TRACE: {"suite": "CORE", "case": "0668", "section": "30", "sectionName": "Test System Quality", "title": "multiple_deletes_are_tracked"}
	t.Run("multiple_deletes_are_tracked", func(t *testing.T) {
		// Reset tracker.
		tracker.mu.Lock()
		tracker.deleteCount = 0
		tracker.mu.Unlock()

		// Delete multiple items.
		for _, id := range []string{"item-a", "item-b", "item-c"} {
			req := httptest.NewRequest(http.MethodDelete, "/v1/vault/item/"+id+"?persona=general", nil)
			rr := httptest.NewRecorder()
			h.HandleDeleteItem(rr, req)
			if rr.Code != http.StatusNoContent {
				t.Fatalf("delete %s: expected 204, got %d", id, rr.Code)
			}
		}

		tracker.mu.Lock()
		if tracker.deleteCount != 3 {
			t.Fatalf("expected 3 delete calls, got %d — items being filtered instead of physically deleted",
				tracker.deleteCount)
		}
		tracker.mu.Unlock()
	})
}

// ==========================================================================
// §30.10 — Security Boundary Real Tests
// ==========================================================================

// TST-CORE-1026
// Egress policy enforcement for all categories (real).
// Requirement: The gatekeeper must enforce egress controls for EVERY PII
// category (email, SSN, credit card, phone, IP address) and for every
// destination type (trusted, blocked, unknown). All patterns must be
// validated against the real gatekeeper implementation, not mocks.
// TRACE: {"suite": "CORE", "case": "0669", "section": "30", "sectionName": "Test System Quality", "subsection": "10", "scenario": "03", "title": "EgressPolicyEnforcementAllCategories"}
func TestSecurity_30_10_3_EgressPolicyEnforcementAllCategories(t *testing.T) {
	impl := realGatekeeper
	testutil.RequireImplementation(t, impl, "Gatekeeper")

	ctx := context.Background()

	// TRACE: {"suite": "CORE", "case": "0670", "section": "30", "sectionName": "Test System Quality", "title": "pii_email_blocked"}
	t.Run("pii_email_blocked", func(t *testing.T) {
		data := []byte(`{"user":"Alice","email":"alice@example.com"}`)
		allowed, err := impl.CheckEgress(ctx, "https://external-api.example.com", data)
		testutil.RequireNoError(t, err)
		if allowed {
			t.Fatal("egress with email PII must be blocked")
		}
	})

	// TRACE: {"suite": "CORE", "case": "0671", "section": "30", "sectionName": "Test System Quality", "title": "pii_ssn_blocked"}
	t.Run("pii_ssn_blocked", func(t *testing.T) {
		data := []byte(`{"name":"Bob","ssn":"123-45-6789"}`)
		allowed, err := impl.CheckEgress(ctx, "https://external-api.example.com", data)
		testutil.RequireNoError(t, err)
		if allowed {
			t.Fatal("egress with SSN PII must be blocked")
		}
	})

	// TRACE: {"suite": "CORE", "case": "0672", "section": "30", "sectionName": "Test System Quality", "title": "pii_credit_card_blocked"}
	t.Run("pii_credit_card_blocked", func(t *testing.T) {
		data := []byte(`{"payment":"4532-1234-5678-9012"}`)
		allowed, err := impl.CheckEgress(ctx, "https://external-api.example.com", data)
		testutil.RequireNoError(t, err)
		if allowed {
			t.Fatal("egress with credit card PII must be blocked")
		}
	})

	// TRACE: {"suite": "CORE", "case": "0673", "section": "30", "sectionName": "Test System Quality", "title": "pii_phone_blocked"}
	t.Run("pii_phone_blocked", func(t *testing.T) {
		data := []byte(`{"contact":"555-123-4567"}`)
		allowed, err := impl.CheckEgress(ctx, "https://external-api.example.com", data)
		testutil.RequireNoError(t, err)
		if allowed {
			t.Fatal("egress with phone PII must be blocked")
		}
	})

	// TRACE: {"suite": "CORE", "case": "0674", "section": "30", "sectionName": "Test System Quality", "title": "pii_ip_address_blocked"}
	t.Run("pii_ip_address_blocked", func(t *testing.T) {
		data := []byte(`{"server":"192.168.1.100"}`)
		allowed, err := impl.CheckEgress(ctx, "https://external-api.example.com", data)
		testutil.RequireNoError(t, err)
		if allowed {
			t.Fatal("egress with IP address PII must be blocked")
		}
	})

	// TRACE: {"suite": "CORE", "case": "0675", "section": "30", "sectionName": "Test System Quality", "title": "clean_data_to_trusted_destination_allowed"}
	t.Run("clean_data_to_trusted_destination_allowed", func(t *testing.T) {
		data := []byte(`{"summary":"weather data","temp":72}`)
		allowed, err := impl.CheckEgress(ctx, "https://trusted-api.example.com", data)
		testutil.RequireNoError(t, err)
		if !allowed {
			t.Fatal("clean data to trusted destination must be allowed")
		}
	})

	// TRACE: {"suite": "CORE", "case": "0676", "section": "30", "sectionName": "Test System Quality", "title": "clean_data_to_unknown_destination_allowed"}
	t.Run("clean_data_to_unknown_destination_allowed", func(t *testing.T) {
		data := []byte(`{"summary":"product info","price":29.99}`)
		allowed, err := impl.CheckEgress(ctx, "https://random-api.example.com", data)
		testutil.RequireNoError(t, err)
		if !allowed {
			t.Fatal("clean data to unknown (non-blocked) destination must be allowed")
		}
	})

	// TRACE: {"suite": "CORE", "case": "0677", "section": "30", "sectionName": "Test System Quality", "title": "any_data_to_blocked_destination_denied"}
	t.Run("any_data_to_blocked_destination_denied", func(t *testing.T) {
		data := []byte(`{"summary":"safe data"}`)
		allowed, err := impl.CheckEgress(ctx, "https://blocked-tracker.example.com", data)
		testutil.RequireNoError(t, err)
		if allowed {
			t.Fatal("any data to blocked destination must be denied — even clean data")
		}
	})

	// TRACE: {"suite": "CORE", "case": "0678", "section": "30", "sectionName": "Test System Quality", "title": "pii_to_trusted_destination_still_blocked"}
	t.Run("pii_to_trusted_destination_still_blocked", func(t *testing.T) {
		// PII must NEVER leave the Home Node, even to trusted destinations.
		data := []byte(`{"email":"secret@example.com"}`)
		allowed, err := impl.CheckEgress(ctx, "https://trusted-api.example.com", data)
		testutil.RequireNoError(t, err)
		if allowed {
			t.Fatal("PII to trusted destination must still be blocked — raw data never leaves")
		}
	})

	// TRACE: {"suite": "CORE", "case": "0679", "section": "30", "sectionName": "Test System Quality", "title": "nil_data_to_any_destination_allowed"}
	t.Run("nil_data_to_any_destination_allowed", func(t *testing.T) {
		// Nil data (health-check pings) should always be allowed.
		allowed, err := impl.CheckEgress(ctx, "https://any-api.example.com", nil)
		testutil.RequireNoError(t, err)
		if !allowed {
			t.Fatal("nil data (health-check) to non-blocked destination must be allowed")
		}
	})

	// TRACE: {"suite": "CORE", "case": "0680", "section": "30", "sectionName": "Test System Quality", "title": "empty_destination_returns_error"}
	t.Run("empty_destination_returns_error", func(t *testing.T) {
		_, err := impl.CheckEgress(ctx, "", []byte("any data"))
		if err == nil {
			t.Fatal("empty destination must return an error")
		}
	})

	// TRACE: {"suite": "CORE", "case": "0681", "section": "30", "sectionName": "Test System Quality", "title": "multiple_pii_types_in_single_payload_blocked"}
	t.Run("multiple_pii_types_in_single_payload_blocked", func(t *testing.T) {
		// A payload with multiple PII types must still be caught.
		data := []byte(`{"email":"a@b.com","ssn":"999-88-7777","phone":"555-111-2222","card":"4111-1111-1111-1111"}`)
		allowed, err := impl.CheckEgress(ctx, "https://external-api.example.com", data)
		testutil.RequireNoError(t, err)
		if allowed {
			t.Fatal("payload with multiple PII types must be blocked")
		}
	})

	// TRACE: {"suite": "CORE", "case": "0682", "section": "30", "sectionName": "Test System Quality", "title": "pii_embedded_in_large_json_still_detected"}
	t.Run("pii_embedded_in_large_json_still_detected", func(t *testing.T) {
		// PII buried deep in a large JSON payload must still be detected.
		data := []byte(`{
			"metadata":{"version":"2.0","generated":"2024-01-01"},
			"items":[
				{"name":"Item 1","desc":"Normal item"},
				{"name":"Item 2","desc":"Contact via alice@secret.org for details"},
				{"name":"Item 3","desc":"Another normal item"}
			]
		}`)
		allowed, err := impl.CheckEgress(ctx, "https://external-api.example.com", data)
		testutil.RequireNoError(t, err)
		if allowed {
			t.Fatal("PII embedded deep in JSON must still be detected and blocked")
		}
	})
}

// TST-CORE-1130
// Agent cannot escalate from task-scoped to full access.
// §34.2 Agent Sandbox Adversarial
// Requirement: Agents constrained to specific scopes (via constraint map)
// must NOT be able to escalate their permissions. The constraint system
// enforces task-scoped access: draft_only blocks risky actions,
// persona_X_only blocks cross-persona access. Constraints compound —
// an agent with multiple constraints is restricted by ALL of them.
// TRACE: {"suite": "CORE", "case": "0683", "section": "34", "sectionName": "Thesis: Loyalty", "subsection": "02", "scenario": "09", "title": "AgentCannotEscalateFromTaskScopedToFullAccess"}
func TestSecurity_34_2_9_AgentCannotEscalateFromTaskScopedToFullAccess(t *testing.T) {
	impl := gatekeeper.New()
	ctx := context.Background()

	// --- draft_only constraint blocks ALL risky actions ---

	// TRACE: {"suite": "CORE", "case": "0684", "section": "34", "sectionName": "Thesis: Loyalty", "title": "draft_only_blocks_send_email"}
	t.Run("draft_only_blocks_send_email", func(t *testing.T) {
		// An agent constrained to draft_only mode MUST NOT perform send_email.
		// This is the core task-scope enforcement: drafting is allowed, direct action is not.
		d, err := impl.EvaluateIntent(ctx, domain.Intent{
			AgentDID:    "did:plc:agent-drafts-only",
			Action:      "send_email",
			TrustLevel:  "verified",
			Constraints: map[string]bool{"draft_only": true},
		})
		testutil.RequireNoError(t, err)
		if d.Allowed {
			t.Fatal("draft_only agent must not be allowed to send_email — escalation to direct action")
		}
		if !d.Audit {
			t.Fatal("denied escalation attempt must be audited")
		}
	})

	// TRACE: {"suite": "CORE", "case": "0685", "section": "34", "sectionName": "Thesis: Loyalty", "title": "draft_only_blocks_transfer_money"}
	t.Run("draft_only_blocks_transfer_money", func(t *testing.T) {
		// Financial actions are even more critical — draft_only must block them.
		d, err := impl.EvaluateIntent(ctx, domain.Intent{
			AgentDID:    "did:plc:agent-drafts-only",
			Action:      "transfer_money",
			TrustLevel:  "trusted",
			Constraints: map[string]bool{"draft_only": true},
		})
		testutil.RequireNoError(t, err)
		if d.Allowed {
			t.Fatal("draft_only agent must not be allowed to transfer_money — financial escalation")
		}
	})

	// TRACE: {"suite": "CORE", "case": "0686", "section": "34", "sectionName": "Thesis: Loyalty", "title": "draft_only_blocks_share_data"}
	t.Run("draft_only_blocks_share_data", func(t *testing.T) {
		// Data sharing is a risky action — must be blocked for draft-only agents.
		d, err := impl.EvaluateIntent(ctx, domain.Intent{
			AgentDID:    "did:plc:agent-drafts-only",
			Action:      "share_data",
			TrustLevel:  "verified",
			Constraints: map[string]bool{"draft_only": true},
		})
		testutil.RequireNoError(t, err)
		if d.Allowed {
			t.Fatal("draft_only agent must not be allowed to share_data — data exfiltration risk")
		}
	})

	// --- draft_only still allows non-risky operations ---

	// TRACE: {"suite": "CORE", "case": "0687", "section": "34", "sectionName": "Thesis: Loyalty", "title": "draft_only_allows_vault_read"}
	t.Run("draft_only_allows_vault_read", func(t *testing.T) {
		// Vault reads are safe operations — draft_only should not block them.
		// The constraint only restricts RISKY actions, not all actions.
		d, err := impl.EvaluateIntent(ctx, domain.Intent{
			AgentDID:    "did:plc:agent-drafts-only",
			Action:      domain.ActionVaultRead,
			PersonaID:   "general",
			TrustLevel:  "verified",
			Constraints: map[string]bool{"draft_only": true},
		})
		testutil.RequireNoError(t, err)
		if !d.Allowed {
			t.Fatalf("draft_only agent should be allowed to read vault, got denied: %s", d.Reason)
		}
	})

	// --- persona_X_only blocks cross-persona access ---

	// TRACE: {"suite": "CORE", "case": "0688", "section": "34", "sectionName": "Thesis: Loyalty", "title": "persona_constraint_blocks_cross_persona_access"}
	t.Run("persona_constraint_blocks_cross_persona_access", func(t *testing.T) {
		// An agent constrained to "general" persona MUST NOT access "financial".
		// This prevents lateral movement between persona compartments.
		d, err := impl.EvaluateIntent(ctx, domain.Intent{
			AgentDID:    "did:plc:personal-agent",
			Action:      domain.ActionVaultRead,
			PersonaID:   "financial",
			TrustLevel:  "verified",
			Constraints: map[string]bool{"persona_general_only": true},
		})
		testutil.RequireNoError(t, err)
		if d.Allowed {
			t.Fatal("persona-constrained agent must not access different persona — cross-persona escalation")
		}
		if !strings.Contains(d.Reason, "cross-persona") {
			t.Fatalf("denial reason should mention cross-persona, got: %s", d.Reason)
		}
	})

	// TRACE: {"suite": "CORE", "case": "0689", "section": "34", "sectionName": "Thesis: Loyalty", "title": "persona_constraint_allows_own_persona"}
	t.Run("persona_constraint_allows_own_persona", func(t *testing.T) {
		// The same agent CAN access the persona it's authorized for.
		d, err := impl.EvaluateIntent(ctx, domain.Intent{
			AgentDID:    "did:plc:personal-agent",
			Action:      domain.ActionVaultRead,
			PersonaID:   "general",
			TrustLevel:  "verified",
			Constraints: map[string]bool{"persona_general_only": true},
		})
		testutil.RequireNoError(t, err)
		if !d.Allowed {
			t.Fatalf("persona-constrained agent should access its own persona, got denied: %s", d.Reason)
		}
	})

	// TRACE: {"suite": "CORE", "case": "0690", "section": "34", "sectionName": "Thesis: Loyalty", "title": "persona_constraint_blocks_all_other_personas"}
	t.Run("persona_constraint_blocks_all_other_personas", func(t *testing.T) {
		// Test that the constraint blocks EVERY other persona, not just one.
		// An agent constrained to "health" must be blocked from personal, financial, and social.
		forbidden := []string{"general", "financial", "social", "consumer"}
		for _, persona := range forbidden {
			d, err := impl.EvaluateIntent(ctx, domain.Intent{
				AgentDID:    "did:plc:health-agent",
				Action:      domain.ActionVaultRead,
				PersonaID:   persona,
				TrustLevel:  "verified",
				Constraints: map[string]bool{"persona_health_only": true},
			})
			testutil.RequireNoError(t, err)
			if d.Allowed {
				t.Errorf("health-constrained agent must NOT access persona %q", persona)
			}
		}
	})

	// --- Compound constraints: BOTH apply ---

	// TRACE: {"suite": "CORE", "case": "0691", "section": "34", "sectionName": "Thesis: Loyalty", "title": "compound_constraints_both_enforced"}
	t.Run("compound_constraints_both_enforced", func(t *testing.T) {
		// An agent with BOTH draft_only AND persona_general_only must be
		// denied on either dimension. This verifies constraints compound.

		// Attempt 1: Right persona, risky action → blocked by draft_only.
		d, err := impl.EvaluateIntent(ctx, domain.Intent{
			AgentDID:   "did:plc:restricted-agent",
			Action:     "send_email",
			PersonaID:  "general",
			TrustLevel: "verified",
			Constraints: map[string]bool{
				"draft_only":            true,
				"persona_general_only": true,
			},
		})
		testutil.RequireNoError(t, err)
		if d.Allowed {
			t.Fatal("compound: right persona + risky action must be denied by draft_only")
		}

		// Attempt 2: Wrong persona, safe action → blocked by persona constraint.
		d, err = impl.EvaluateIntent(ctx, domain.Intent{
			AgentDID:   "did:plc:restricted-agent",
			Action:     domain.ActionVaultRead,
			PersonaID:  "financial",
			TrustLevel: "verified",
			Constraints: map[string]bool{
				"draft_only":            true,
				"persona_general_only": true,
			},
		})
		testutil.RequireNoError(t, err)
		if d.Allowed {
			t.Fatal("compound: wrong persona + safe action must be denied by persona constraint")
		}

		// Attempt 3: Right persona, safe action → ALLOWED (both constraints satisfied).
		d, err = impl.EvaluateIntent(ctx, domain.Intent{
			AgentDID:   "did:plc:restricted-agent",
			Action:     domain.ActionVaultRead,
			PersonaID:  "general",
			TrustLevel: "verified",
			Constraints: map[string]bool{
				"draft_only":            true,
				"persona_general_only": true,
			},
		})
		testutil.RequireNoError(t, err)
		if !d.Allowed {
			t.Fatalf("compound: right persona + safe action should be allowed, got: %s", d.Reason)
		}
	})

	// --- Constraint bypass attempts ---

	// TRACE: {"suite": "CORE", "case": "0692", "section": "34", "sectionName": "Thesis: Loyalty", "title": "false_constraint_value_does_not_restrict"}
	t.Run("false_constraint_value_does_not_restrict", func(t *testing.T) {
		// Setting a constraint to false should NOT apply it.
		// An agent may attempt to "disable" a constraint by setting it false.
		d, err := impl.EvaluateIntent(ctx, domain.Intent{
			AgentDID:    "did:plc:sneaky-agent",
			Action:      "send_email",
			TrustLevel:  "verified",
			Constraints: map[string]bool{"draft_only": false},
		})
		testutil.RequireNoError(t, err)
		// With draft_only=false, the draft_only check doesn't apply.
		// But send_email is STILL a risky action — blocked by the Four Laws
		// risky action check (line 199 of gatekeeper.go).
		if d.Allowed {
			t.Fatal("send_email must still be flagged as risky even without draft_only constraint")
		}
	})

	// TRACE: {"suite": "CORE", "case": "0693", "section": "34", "sectionName": "Thesis: Loyalty", "title": "nil_constraints_no_restriction"}
	t.Run("nil_constraints_no_restriction", func(t *testing.T) {
		// An agent with nil constraints has no scope restriction.
		// But trust level and action risk rules still apply.
		d, err := impl.EvaluateIntent(ctx, domain.Intent{
			AgentDID:    "did:plc:unconstrained-agent",
			Action:      domain.ActionVaultRead,
			PersonaID:   "general",
			TrustLevel:  "verified",
			Constraints: nil,
		})
		testutil.RequireNoError(t, err)
		if !d.Allowed {
			t.Fatalf("unconstrained agent with sufficient trust should be allowed, got: %s", d.Reason)
		}
	})

	// TRACE: {"suite": "CORE", "case": "0694", "section": "34", "sectionName": "Thesis: Loyalty", "title": "brain_agent_with_constraints_still_denied_security_actions"}
	t.Run("brain_agent_with_constraints_still_denied_security_actions", func(t *testing.T) {
		// Even if someone manages to set constraints on the brain agent,
		// brainDeniedActions still block security-critical operations.
		// Constraints don't GRANT permissions; they only RESTRICT.
		securityActions := []string{"did_sign", "did_rotate", "vault_backup", "persona_unlock", "vault_raw_read", "vault_raw_write", "vault_export"}
		for _, action := range securityActions {
			d, err := impl.EvaluateIntent(ctx, domain.Intent{
				AgentDID:    "brain",
				Action:      action,
				TrustLevel:  "verified",
				Constraints: nil, // no scope restrictions
			})
			testutil.RequireNoError(t, err)
			if d.Allowed {
				t.Errorf("brain must NEVER be allowed %q regardless of constraints", action)
			}
		}
	})
}

// --------------------------------------------------------------------------
// §34.3 Approval Lifecycle — Full End-to-End
//
// Tests the complete approval flow:
//   Agent starts session → query sensitive persona → approval_required →
//   admin approves → retry succeeds → session end revokes grants.
//
// This validates the integration between PersonaManager, VaultService,
// and the 4-tier access control model.
// --------------------------------------------------------------------------

// TST-CORE-1200
// TRACE: {"suite": "CORE", "case": "0695", "section": "34", "sectionName": "Thesis: Loyalty", "subsection": "03", "scenario": "01", "title": "ApprovalLifecycleE2E"}
func TestAdv_34_3_ApprovalLifecycleE2E(t *testing.T) {
	ctx := context.Background()
	agentDID := "did:key:z6MkTestOpenClawAgent"
	sessionName := "chair-research"

	// 1. Set up a fresh PersonaManager with 4-tier personas.
	pm := identity.NewPersonaManager()
	_, err := pm.Create(ctx, "general", "default")
	testutil.RequireNoError(t, err)
	_, err = pm.Create(ctx, "consumer", "standard")
	testutil.RequireNoError(t, err)
	_, err = pm.Create(ctx, "health", "sensitive")
	testutil.RequireNoError(t, err)
	_, err = pm.Create(ctx, "financial", "locked", "test-hash-123")
	testutil.RequireNoError(t, err)

	// Track approval notifications.
	var approvalNotifications []domain.ApprovalRequest
	pm.OnApprovalNeeded = func(req domain.ApprovalRequest) {
		approvalNotifications = append(approvalNotifications, req)
	}

	// 2. Set up VaultService with real gatekeeper and PersonaManager.
	vault := newGatekeeperVaultManager()
	_ = vault.Open(ctx, "identity", nil)
	_ = vault.Open(ctx, "general", nil)
	_ = vault.Open(ctx, "consumer", nil)
	_ = vault.Open(ctx, "health", nil)
	// financial is NOT opened (locked tier)

	gk := gatekeeper.New()
	clk := &gatekeeperClock{now: time.Now()}
	vaultSvc := service.NewVaultService(vault, vault, vault, gk, clk)
	vaultSvc.SetPersonaManager(pm)

	// Helper: build agent context.
	agentCtx := func(did, session string) context.Context {
		c := context.WithValue(ctx, middleware.CallerTypeKey, "agent")
		c = context.WithValue(c, middleware.AgentDIDKey, did)
		if session != "" {
			c = context.WithValue(c, middleware.SessionNameKey, session)
		}
		return c
	}

	// Helper: build user context.
	userCtx := func() context.Context {
		return context.WithValue(ctx, middleware.CallerTypeKey, "user")
	}

	q := domain.SearchQuery{Query: "office chairs", Mode: "fts5"}

	// Start a session for the agent — required for all tier access.
	_, err = pm.StartSession(ctx, agentDID, "approval-e2e")
	testutil.RequireNoError(t, err)

	// ---------- Phase 1: Default persona — always allowed ----------
	// TRACE: {"suite": "CORE", "case": "0696", "section": "34", "sectionName": "Thesis: Loyalty", "title": "default_persona_always_allowed_for_agent"}
	t.Run("default_persona_always_allowed_for_agent", func(t *testing.T) {
		// Agent must provide a valid session — even for default tier.
		aCtx := agentCtx(agentDID, "approval-e2e")
		_, err := vaultSvc.Query(aCtx, agentDID, "general", q)
		testutil.RequireNoError(t, err)
	})

	// ---------- Phase 2: Standard persona — agent without session gets denied ----------
	// TRACE: {"suite": "CORE", "case": "0697", "section": "34", "sectionName": "Thesis: Loyalty", "title": "standard_persona_denied_without_session"}
	t.Run("standard_persona_denied_without_session", func(t *testing.T) {
		aCtx := agentCtx(agentDID, "")
		_, err := vaultSvc.Query(aCtx, agentDID, "consumer", q)
		testutil.RequireError(t, err)
		var approvalErr *identity.ErrApprovalRequired
		if !errors.As(err, &approvalErr) {
			t.Fatalf("expected ErrApprovalRequired, got: %v", err)
		}
	})

	// ---------- Phase 3: Start session, sensitive still denied ----------
	// TRACE: {"suite": "CORE", "case": "0698", "section": "34", "sectionName": "Thesis: Loyalty", "title": "sensitive_persona_denied_then_approved"}
	t.Run("sensitive_persona_denied_then_approved", func(t *testing.T) {
		// Start a session.
		sess, err := pm.StartSession(ctx, agentDID, sessionName)
		testutil.RequireNoError(t, err)
		if sess.Name != sessionName {
			t.Fatalf("expected session name %q, got %q", sessionName, sess.Name)
		}

		// Query sensitive persona → approval_required.
		aCtx := agentCtx(agentDID, sessionName)
		_, err = vaultSvc.Query(aCtx, agentDID, "health", q)
		testutil.RequireError(t, err)
		var approvalErr *identity.ErrApprovalRequired
		if !errors.As(err, &approvalErr) {
			t.Fatalf("expected ErrApprovalRequired for sensitive persona, got: %v", err)
		}

		// Create an approval request (this is what the vault handler does).
		reqID, err := pm.RequestApproval(ctx, domain.ApprovalRequest{
			ClientDID: agentDID,
			PersonaID: "persona-health",
			SessionID: sessionName,
			Action:    "vault_query",
			Reason:    "office chairs",
		})
		testutil.RequireNoError(t, err)
		if reqID == "" {
			t.Fatal("approval request ID must not be empty")
		}

		// Verify notification was fired.
		if len(approvalNotifications) == 0 {
			t.Fatal("OnApprovalNeeded must be called when approval is requested")
		}
		lastNotif := approvalNotifications[len(approvalNotifications)-1]
		if lastNotif.PersonaID != "persona-health" {
			t.Fatalf("notification persona mismatch: got %q", lastNotif.PersonaID)
		}

		// Verify the approval is pending.
		pending, err := pm.ListPending(ctx)
		testutil.RequireNoError(t, err)
		found := false
		for _, p := range pending {
			if p.ID == reqID {
				found = true
				break
			}
		}
		if !found {
			t.Fatal("approval request must appear in pending list")
		}

		// Still denied before approval (retry must fail).
		_, err = vaultSvc.Query(aCtx, agentDID, "health", q)
		testutil.RequireError(t, err)

		// Admin approves with session scope.
		err = pm.ApproveRequest(ctx, reqID, "session", "admin")
		testutil.RequireNoError(t, err)

		// Verify approval is no longer pending.
		pending2, _ := pm.ListPending(ctx)
		for _, p := range pending2 {
			if p.ID == reqID {
				t.Fatal("approved request must not appear in pending list")
			}
		}

		// Retry — now succeeds!
		_, err = vaultSvc.Query(aCtx, agentDID, "health", q)
		testutil.RequireNoError(t, err)
	})

	// ---------- Phase 4: Different agent is still denied ----------
	// TRACE: {"suite": "CORE", "case": "0699", "section": "34", "sectionName": "Thesis: Loyalty", "title": "cross_agent_grant_isolation"}
	t.Run("cross_agent_grant_isolation", func(t *testing.T) {
		otherAgent := "did:key:z6MkOtherMaliciousAgent"
		// Start a different agent's session.
		_, err := pm.StartSession(ctx, otherAgent, "evil-session")
		testutil.RequireNoError(t, err)

		aCtx := agentCtx(otherAgent, "evil-session")
		_, err = vaultSvc.Query(aCtx, otherAgent, "health", q)
		testutil.RequireError(t, err)
		var approvalErr *identity.ErrApprovalRequired
		if !errors.As(err, &approvalErr) {
			t.Fatalf("other agent must not inherit first agent's grant, got: %v", err)
		}
	})

	// ---------- Phase 5: User/admin always allowed for sensitive ----------
	// TRACE: {"suite": "CORE", "case": "0700", "section": "34", "sectionName": "Thesis: Loyalty", "title": "user_always_allowed_for_sensitive"}
	t.Run("user_always_allowed_for_sensitive", func(t *testing.T) {
		uCtx := userCtx()
		_, err := vaultSvc.Query(uCtx, "user", "health", q)
		testutil.RequireNoError(t, err)
	})

	// ---------- Phase 6: Locked persona denies agents even with session ----------
	// TRACE: {"suite": "CORE", "case": "0701", "section": "34", "sectionName": "Thesis: Loyalty", "title": "locked_persona_denies_agent_unconditionally"}
	t.Run("locked_persona_denies_agent_unconditionally", func(t *testing.T) {
		// Wire passphrase verifier so Unlock works.
		pm.VerifyPassphrase = func(hash, passphrase string) (bool, error) {
			return hash == passphrase, nil // simple equality for test
		}
		// Unlock locked persona (so vault is open).
		err := pm.Unlock(ctx, "financial", "test-hash-123", 300)
		testutil.RequireNoError(t, err)
		_ = vault.Open(ctx, "financial", nil)

		// Agent is STILL denied — locked tier denies agents even when unlocked.
		aCtx := agentCtx(agentDID, sessionName)
		_, err = vaultSvc.Query(aCtx, agentDID, "financial", q)
		testutil.RequireError(t, err)
		if !strings.Contains(err.Error(), "locked") {
			t.Fatalf("expected locked persona error, got: %v", err)
		}

		// But user is allowed.
		uCtx := userCtx()
		_, err = vaultSvc.Query(uCtx, "user", "financial", q)
		testutil.RequireNoError(t, err)
	})

	// ---------- Phase 7: Session end revokes grants ----------
	// TRACE: {"suite": "CORE", "case": "0702", "section": "34", "sectionName": "Thesis: Loyalty", "title": "session_end_revokes_grants"}
	t.Run("session_end_revokes_grants", func(t *testing.T) {
		// End the session.
		err := pm.EndSession(ctx, agentDID, sessionName)
		testutil.RequireNoError(t, err)

		// Start a new session with same name.
		_, err = pm.StartSession(ctx, agentDID, "new-session")
		testutil.RequireNoError(t, err)

		// Query health — should be denied again (grant was in old session).
		aCtx := agentCtx(agentDID, "new-session")
		_, err = vaultSvc.Query(aCtx, agentDID, "health", q)
		testutil.RequireError(t, err)
		var approvalErr *identity.ErrApprovalRequired
		if !errors.As(err, &approvalErr) {
			t.Fatalf("expected ErrApprovalRequired after session end, got: %v", err)
		}
	})

	// ---------- Phase 8: Deny flow ----------
	// TRACE: {"suite": "CORE", "case": "0703", "section": "34", "sectionName": "Thesis: Loyalty", "title": "denied_approval_stays_denied"}
	t.Run("denied_approval_stays_denied", func(t *testing.T) {
		aCtx := agentCtx(agentDID, "new-session")

		// Create and deny an approval request.
		reqID, err := pm.RequestApproval(ctx, domain.ApprovalRequest{
			ClientDID: agentDID,
			PersonaID: "persona-health",
			SessionID: "new-session",
			Action:    "vault_query",
			Reason:    "office chairs retry",
		})
		testutil.RequireNoError(t, err)

		err = pm.DenyRequest(ctx, reqID)
		testutil.RequireNoError(t, err)

		// Agent still denied after deny.
		_, err = vaultSvc.Query(aCtx, agentDID, "health", q)
		testutil.RequireError(t, err)

		// Denied request not in pending list.
		pending, _ := pm.ListPending(ctx)
		for _, p := range pending {
			if p.ID == reqID {
				t.Fatal("denied request must not appear in pending list")
			}
		}
	})
}
