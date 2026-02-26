package test

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/domain"
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

// TST-ADV-037: Access to locked persona is denied regardless of gatekeeper rules.
// Architecture §5: "locked persona → DEK not in RAM → access always denied."
func TestAdv_29_9_LockedPersonaDenied(t *testing.T) {
	vault := newGatekeeperVaultManager()
	// "personal" is open, "financial" is closed (not in map).
	personal, _ := domain.NewPersonaName("personal")
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
		PersonaID: "personal",
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

// TST-ADV-038: Locked persona denial generates audit entry.
// Architecture §5: "every access check is audited."
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

// TST-ADV-040: Missing sharing policy category is completely denied (default deny).
// Architecture §9: "missing policy key = denied — default deny throughout."
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
