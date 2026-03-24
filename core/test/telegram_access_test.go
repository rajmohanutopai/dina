package test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/adapter/identity"
	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/middleware"
	"github.com/rajmohanutopai/dina/core/internal/port"
	"github.com/rajmohanutopai/dina/core/internal/service"
	"github.com/rajmohanutopai/dina/core/test/testutil"
)

// ==========================================================================
// Telegram Full Access Model — User-Originated Requests
//
// When Brain sends a vault request with user_origin=telegram in the signed
// body, Core treats the request as user-originated. This enables:
//   - Sensitive personas: auto-approved (no session grant needed)
//   - Auto-unlock: closed sensitive vaults are opened automatically
//   - Locked personas: still denied (passphrase required)
//   - Non-Brain callers: user_origin is ignored (cannot impersonate)
// ==========================================================================

// --- Helper: build context with caller type and optional user-origin flags ---

func telBrainCtx() context.Context {
	ctx := context.Background()
	ctx = context.WithValue(ctx, middleware.CallerTypeKey, "brain")
	ctx = context.WithValue(ctx, middleware.AgentDIDKey, "brain-service")
	return ctx
}

func telBrainUserOriginCtx(origin string) context.Context {
	ctx := telBrainCtx()
	ctx = context.WithValue(ctx, middleware.UserOriginatedKey, true)
	ctx = context.WithValue(ctx, middleware.UserOriginKey, origin)
	return ctx
}

func telAgentCtx() context.Context {
	ctx := context.Background()
	ctx = context.WithValue(ctx, middleware.CallerTypeKey, "agent")
	ctx = context.WithValue(ctx, middleware.AgentDIDKey, "did:key:z6MkTestAgent")
	return ctx
}

func telUserCtx() context.Context {
	ctx := context.Background()
	ctx = context.WithValue(ctx, middleware.CallerTypeKey, "user")
	ctx = context.WithValue(ctx, middleware.AgentDIDKey, "admin-user")
	return ctx
}

// --- Mock gatekeeper (allow-all) for VaultService tests ---

type telAllowGatekeeper struct{}

func (g *telAllowGatekeeper) EvaluateIntent(_ context.Context, _ domain.Intent) (domain.Decision, error) {
	return domain.Decision{Allowed: true}, nil
}

func (g *telAllowGatekeeper) CheckEgress(_ context.Context, _ string, _ []byte) (bool, error) {
	return true, nil
}

var _ port.Gatekeeper = (*telAllowGatekeeper)(nil)

// --- Mock clock ---

type telClock struct{}

func (c *telClock) Now() time.Time                         { return time.Unix(1000000, 0) }
func (c *telClock) After(d time.Duration) <-chan time.Time  { return time.After(d) }
func (c *telClock) NewTicker(d time.Duration) *time.Ticker { return time.NewTicker(d) }

var _ port.Clock = (*telClock)(nil)

// --- Mock vault manager/reader/writer ---

type telVaultMgr struct {
	open     map[domain.PersonaName]bool
	openedBy []domain.PersonaName
}

func newTelVaultMgr() *telVaultMgr {
	return &telVaultMgr{open: make(map[domain.PersonaName]bool)}
}

func (m *telVaultMgr) Open(_ context.Context, p domain.PersonaName, _ []byte) error {
	m.open[p] = true
	m.openedBy = append(m.openedBy, p)
	return nil
}
func (m *telVaultMgr) Close(p domain.PersonaName) error { delete(m.open, p); return nil }
func (m *telVaultMgr) IsOpen(p domain.PersonaName) bool { return m.open[p] }
func (m *telVaultMgr) OpenPersonas() []domain.PersonaName {
	var out []domain.PersonaName
	for p := range m.open {
		out = append(out, p)
	}
	return out
}

func (m *telVaultMgr) Query(_ context.Context, _ domain.PersonaName, _ domain.SearchQuery) ([]domain.VaultItem, error) {
	return nil, nil
}
func (m *telVaultMgr) GetItem(_ context.Context, _ domain.PersonaName, _ string) (*domain.VaultItem, error) {
	return nil, fmt.Errorf("not found")
}
func (m *telVaultMgr) VectorSearch(_ context.Context, _ domain.PersonaName, _ []float32, _ int) ([]domain.VaultItem, error) {
	return nil, nil
}
func (m *telVaultMgr) Store(_ context.Context, _ domain.PersonaName, _ domain.VaultItem) (string, error) {
	return "test-id", nil
}
func (m *telVaultMgr) StoreBatch(_ context.Context, _ domain.PersonaName, items []domain.VaultItem) ([]string, error) {
	ids := make([]string, len(items))
	for i := range items {
		ids[i] = fmt.Sprintf("test-id-%d", i)
	}
	return ids, nil
}
func (m *telVaultMgr) Delete(_ context.Context, _ domain.PersonaName, _ string) error { return nil }
func (m *telVaultMgr) ClearAll(_ context.Context, _ domain.PersonaName) (int, error)  { return 0, nil }
func (m *telVaultMgr) Checkpoint(_ domain.PersonaName) error                          { return nil }

// ---------------------------------------------------------------------------
// §1 AccessPersona with UserOriginated flag
// ---------------------------------------------------------------------------

// TST-TEL-001: UserOriginated=true allows brain access to sensitive persona.
func TestTelegram_AccessPersona_SensitiveAutoApproved(t *testing.T) {
	pm := identity.NewPersonaManager()
	_, err := pm.Create(context.Background(), "health", "sensitive")
	testutil.RequireNoError(t, err)

	// Brain without user_origin: denied (requires approval)
	err = pm.AccessPersona(telBrainCtx(), "health")
	if err == nil {
		t.Fatal("sensitive tier should deny brain without user_origin")
	}
	var approvalErr *identity.ErrApprovalRequired
	if !errors.As(err, &approvalErr) {
		t.Fatalf("expected ErrApprovalRequired, got: %v", err)
	}

	// Brain with user_origin=telegram: auto-approved
	err = pm.AccessPersona(telBrainUserOriginCtx("telegram"), "health")
	testutil.RequireNoError(t, err)
}

// TST-TEL-002: UserOriginated=false preserves existing behavior.
func TestTelegram_AccessPersona_NoUserOrigin_ExistingBehavior(t *testing.T) {
	pm := identity.NewPersonaManager()
	_, err := pm.Create(context.Background(), "medical", "sensitive")
	testutil.RequireNoError(t, err)

	// Brain: denied
	err = pm.AccessPersona(telBrainCtx(), "medical")
	if err == nil {
		t.Fatal("sensitive tier should deny brain without user_origin")
	}

	// Agent: denied
	err = pm.AccessPersona(telAgentCtx(), "medical")
	if err == nil {
		t.Fatal("sensitive tier should deny agent")
	}

	// User: allowed
	err = pm.AccessPersona(telUserCtx(), "medical")
	testutil.RequireNoError(t, err)
}

// TST-TEL-003: Non-Brain callers cannot use UserOriginated to gain access.
func TestTelegram_AccessPersona_NonBrainCallerIgnoresUserOrigin(t *testing.T) {
	pm := identity.NewPersonaManager()
	_, err := pm.Create(context.Background(), "secrets", "sensitive")
	testutil.RequireNoError(t, err)

	// Connector/agent with user_origin flags set — should be ignored
	ctx := context.Background()
	ctx = context.WithValue(ctx, middleware.CallerTypeKey, "agent")
	ctx = context.WithValue(ctx, middleware.AgentDIDKey, "connector-service")
	ctx = context.WithValue(ctx, middleware.UserOriginatedKey, true)
	ctx = context.WithValue(ctx, middleware.UserOriginKey, "telegram")

	err = pm.AccessPersona(ctx, "secrets")
	if err == nil {
		t.Fatal("non-brain caller should not benefit from UserOriginated flag")
	}
}

// TST-TEL-004: Locked persona still denied even with UserOriginated=true.
func TestTelegram_AccessPersona_LockedStillDenied(t *testing.T) {
	pm := identity.NewPersonaManager()
	pm.VerifyPassphrase = func(storedHash, passphrase string) (bool, error) {
		return passphrase == "correct-pass", nil
	}
	_, err := pm.Create(context.Background(), "finance", "locked", "hashedpass")
	testutil.RequireNoError(t, err)

	// User-originated brain: still denied (locked = passphrase required)
	err = pm.AccessPersona(telBrainUserOriginCtx("telegram"), "finance")
	if err == nil {
		t.Fatal("locked tier should deny even with user_origin=telegram")
	}
	if !errors.Is(err, domain.ErrPersonaLocked) {
		t.Fatalf("expected ErrPersonaLocked, got: %v", err)
	}
}

// TST-TEL-005: Default tier allows all callers regardless of user_origin.
func TestTelegram_AccessPersona_DefaultTierAlwaysAllowed(t *testing.T) {
	pm := identity.NewPersonaManager()
	_, err := pm.Create(context.Background(), "general", "default")
	testutil.RequireNoError(t, err)

	// Agent needs an active session — even for default tier.
	_, err = pm.StartSession(context.Background(), "did:key:z6MkTestAgent", "tel-default-test")
	testutil.RequireNoError(t, err)
	agentWithSession := telAgentCtx()
	agentWithSession = context.WithValue(agentWithSession, middleware.SessionNameKey, "tel-default-test")

	for _, ctx := range []context.Context{
		telBrainCtx(),
		telBrainUserOriginCtx("telegram"),
		agentWithSession,
		telUserCtx(),
	} {
		err = pm.AccessPersona(ctx, "general")
		testutil.RequireNoError(t, err)
	}
}

// TST-TEL-006: Standard tier — brain always allowed, agent still needs grant.
func TestTelegram_AccessPersona_StandardTierBrainAllowed(t *testing.T) {
	pm := identity.NewPersonaManager()
	_, err := pm.Create(context.Background(), "social", "standard")
	testutil.RequireNoError(t, err)

	// Brain without user_origin: allowed (standard allows brain)
	testutil.RequireNoError(t, pm.AccessPersona(telBrainCtx(), "social"))

	// Brain with user_origin=telegram: also allowed
	testutil.RequireNoError(t, pm.AccessPersona(telBrainUserOriginCtx("telegram"), "social"))

	// Agent without session grant: denied
	err = pm.AccessPersona(telAgentCtx(), "social")
	if err == nil {
		t.Fatal("standard tier should deny agent without session grant")
	}
}

// ---------------------------------------------------------------------------
// §2 VaultService.ensureOpen with autoUnlock
// ---------------------------------------------------------------------------

// TST-TEL-007: Auto-unlock fires when vault is closed and request is user-originated.
func TestTelegram_EnsureOpen_AutoUnlockCalled(t *testing.T) {
	mgr := newTelVaultMgr()
	vs := service.NewVaultService(mgr, mgr, mgr, &telAllowGatekeeper{}, &telClock{})

	autoUnlockCalled := false
	vs.SetAutoUnlock(func(ctx context.Context, persona domain.PersonaName) error {
		autoUnlockCalled = true
		mgr.open[persona] = true
		return nil
	})

	persona, _ := domain.NewPersonaName("health")
	_, err := vs.Query(telBrainUserOriginCtx("telegram"), "brain-service", persona, domain.SearchQuery{Mode: domain.SearchFTS5})
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, autoUnlockCalled, "autoUnlock should have been called")
}

// TST-TEL-008: Auto-unlock NOT called when vault is already open.
func TestTelegram_EnsureOpen_AlreadyOpen_NoAutoUnlock(t *testing.T) {
	mgr := newTelVaultMgr()
	vs := service.NewVaultService(mgr, mgr, mgr, &telAllowGatekeeper{}, &telClock{})

	autoUnlockCalled := false
	vs.SetAutoUnlock(func(ctx context.Context, persona domain.PersonaName) error {
		autoUnlockCalled = true
		return nil
	})

	persona, _ := domain.NewPersonaName("health")
	mgr.open[persona] = true // Already open

	_, err := vs.Query(telBrainUserOriginCtx("telegram"), "brain-service", persona, domain.SearchQuery{Mode: domain.SearchFTS5})
	testutil.RequireNoError(t, err)
	testutil.RequireFalse(t, autoUnlockCalled, "autoUnlock should NOT be called when vault is already open")
}

// TST-TEL-009: Auto-unlock NOT called for non-user-originated → ErrPersonaLocked.
func TestTelegram_EnsureOpen_NonUserOriginated_AutoOpens(t *testing.T) {
	// v1 model: sensitive personas auto-open for any authorized request.
	// ensureOpen no longer checks UserOriginated — AccessPersona gates access.
	mgr := newTelVaultMgr()
	vs := service.NewVaultService(mgr, mgr, mgr, &telAllowGatekeeper{}, &telClock{})

	autoUnlockCalled := false
	vs.SetAutoUnlock(func(ctx context.Context, persona domain.PersonaName) error {
		autoUnlockCalled = true
		mgr.open[persona] = true
		return nil
	})

	persona, _ := domain.NewPersonaName("health")
	_, err := vs.Query(telBrainCtx(), "brain-service", persona, domain.SearchQuery{Mode: domain.SearchFTS5})
	if err != nil {
		t.Fatalf("v1: authorized request should auto-open sensitive vault, got: %v", err)
	}
	testutil.RequireTrue(t, autoUnlockCalled, "autoUnlock should fire for authorized request")
}

// TST-TEL-010: Auto-unlock propagates through Store().
func TestTelegram_EnsureOpen_Store_AutoUnlock(t *testing.T) {
	mgr := newTelVaultMgr()
	vs := service.NewVaultService(mgr, mgr, mgr, &telAllowGatekeeper{}, &telClock{})

	autoUnlockCalled := false
	vs.SetAutoUnlock(func(ctx context.Context, persona domain.PersonaName) error {
		autoUnlockCalled = true
		mgr.open[persona] = true
		return nil
	})

	persona, _ := domain.NewPersonaName("health")
	_, err := vs.Store(telBrainUserOriginCtx("telegram"), "brain-service", persona, domain.VaultItem{Type: "note"})
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, autoUnlockCalled, "autoUnlock should fire for Store()")
}

// TST-TEL-011: Auto-unlock propagates through Delete().
func TestTelegram_EnsureOpen_Delete_AutoUnlock(t *testing.T) {
	mgr := newTelVaultMgr()
	vs := service.NewVaultService(mgr, mgr, mgr, &telAllowGatekeeper{}, &telClock{})

	autoUnlockCalled := false
	vs.SetAutoUnlock(func(ctx context.Context, persona domain.PersonaName) error {
		autoUnlockCalled = true
		mgr.open[persona] = true
		return nil
	})

	persona, _ := domain.NewPersonaName("health")
	err := vs.Delete(telBrainUserOriginCtx("telegram"), "brain-service", persona, "item-1")
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, autoUnlockCalled, "autoUnlock should fire for Delete()")
}

// TST-TEL-012: Auto-unlock propagates through StoreBatch().
func TestTelegram_EnsureOpen_StoreBatch_AutoUnlock(t *testing.T) {
	mgr := newTelVaultMgr()
	vs := service.NewVaultService(mgr, mgr, mgr, &telAllowGatekeeper{}, &telClock{})

	autoUnlockCalled := false
	vs.SetAutoUnlock(func(ctx context.Context, persona domain.PersonaName) error {
		autoUnlockCalled = true
		mgr.open[persona] = true
		return nil
	})

	persona, _ := domain.NewPersonaName("health")
	items := []domain.VaultItem{{Type: "note", Summary: "a"}, {Type: "note", Summary: "b"}}
	_, err := vs.StoreBatch(telBrainUserOriginCtx("telegram"), "brain-service", persona, items)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, autoUnlockCalled, "autoUnlock should fire for StoreBatch()")
}

// ---------------------------------------------------------------------------
// §3 Audit trail includes user_origin
// ---------------------------------------------------------------------------

// TST-TEL-013: Audit entry for sensitive persona includes user_via_telegram.
func TestTelegram_AuditIncludesUserOrigin(t *testing.T) {
	pm := identity.NewPersonaManager()
	_, err := pm.Create(context.Background(), "health", "sensitive")
	testutil.RequireNoError(t, err)

	// Access with user_origin=telegram
	err = pm.AccessPersona(telBrainUserOriginCtx("telegram"), "health")
	testutil.RequireNoError(t, err)

	entries, _ := pm.AuditLog(context.Background(), "persona-health")
	found := false
	for _, e := range entries {
		if e.Action == "access_sensitive" && strings.Contains(e.Details, "user_via_telegram") {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("audit log should contain 'user_via_telegram' for Telegram-originated sensitive access")
	}
}

// ---------------------------------------------------------------------------
// §4 Default/standard personas cannot be locked
// ---------------------------------------------------------------------------

// TST-TEL-014: Default tier persona cannot be locked.
func TestTelegram_DefaultPersonaCannotBeLocked(t *testing.T) {
	pm := identity.NewPersonaManager()
	_, err := pm.Create(context.Background(), "general", "default")
	testutil.RequireNoError(t, err)

	err = pm.Lock(context.Background(), "general")
	if err == nil {
		t.Fatal("default tier persona must not be lockable")
	}
	if !errors.Is(err, identity.ErrCannotLockDefaultTier) {
		t.Fatalf("expected ErrCannotLockDefaultTier, got: %v", err)
	}
}

// TST-TEL-015: Standard tier persona cannot be locked.
func TestTelegram_StandardPersonaCannotBeLocked(t *testing.T) {
	pm := identity.NewPersonaManager()
	_, err := pm.Create(context.Background(), "consumer", "standard")
	testutil.RequireNoError(t, err)

	err = pm.Lock(context.Background(), "consumer")
	if err == nil {
		t.Fatal("standard tier persona must not be lockable")
	}
}

// TST-TEL-016: Sensitive tier persona CAN be locked.
func TestTelegram_SensitivePersonaCanBeLocked(t *testing.T) {
	pm := identity.NewPersonaManager()
	_, err := pm.Create(context.Background(), "health", "sensitive")
	testutil.RequireNoError(t, err)

	err = pm.Lock(context.Background(), "health")
	testutil.RequireNoError(t, err)
}

// TST-TEL-017: Default persona state forced unlocked on load.
func TestTelegram_DefaultPersonaForcedUnlockedOnLoad(t *testing.T) {
	pm := identity.NewPersonaManager()
	_, err := pm.Create(context.Background(), "general", "default")
	testutil.RequireNoError(t, err)

	// Verify it's not locked
	locked, _ := pm.IsLocked("general")
	testutil.RequireFalse(t, locked, "default persona should never be locked")
}
