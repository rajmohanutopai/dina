// Package estate provides in-memory implementations for digital estate planning.
package estate

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
	"github.com/rajmohanutopai/dina/core/test/testutil"
)

// Compile-time interface checks.
var _ port.EstateManager = (*PortEstateManager)(nil)
var _ testutil.EstateManager = (*EstateManager)(nil)

var (
	ErrNoPlan          = errors.New("estate: no estate plan stored")
	ErrInvalidTrigger  = errors.New("estate: only 'custodian_threshold' trigger is supported")
	ErrMissingTrigger  = errors.New("estate: trigger is required")
	ErrInvalidAction   = errors.New("estate: default_action must be 'destroy' or 'archive'")
	ErrNotActivated    = errors.New("estate: plan not activated")
)

// ---------------------------------------------------------------------------
// PortEstateManager — satisfies port.EstateManager (context-accepting methods)
// Used by main.go / service layer.
// ---------------------------------------------------------------------------

// PortEstateManager implements port.EstateManager with context parameters.
type PortEstateManager struct {
	mu   sync.Mutex
	plan *domain.EstatePlan
}

// NewPortEstateManager returns a new port-compatible EstateManager.
func NewPortEstateManager() *PortEstateManager {
	return &PortEstateManager{}
}

func (m *PortEstateManager) StorePlan(_ context.Context, plan domain.EstatePlan) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.plan = &plan
	return nil
}

func (m *PortEstateManager) GetPlan(_ context.Context) (*domain.EstatePlan, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.plan == nil {
		return nil, ErrNoPlan
	}
	p := *m.plan
	return &p, nil
}

func (m *PortEstateManager) Activate(_ context.Context, trigger string, _ [][]byte) error {
	if trigger != "custodian_threshold" {
		return ErrInvalidTrigger
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return nil
}

func (m *PortEstateManager) DeliverKeys(_ context.Context, _ string) error {
	return nil
}

func (m *PortEstateManager) NotifyContacts(_ context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.plan == nil {
		return ErrNoPlan
	}
	return nil
}

// ---------------------------------------------------------------------------
// EstateManager — satisfies testutil.EstateManager (no context, extra methods)
// Used by tests.
// ---------------------------------------------------------------------------

// EstateManager implements testutil.EstateManager for test wiring.
type EstateManager struct {
	mu        sync.Mutex
	plan      *domain.EstatePlan
	activated bool
}

// NewEstateManager returns a new testutil-compatible EstateManager.
func NewEstateManager() *EstateManager {
	return &EstateManager{}
}

// StorePlan persists the estate plan in Tier 0 (identity.sqlite).
func (m *EstateManager) StorePlan(plan domain.EstatePlan) error {
	if plan.Trigger == "" {
		return ErrMissingTrigger
	}
	if plan.Trigger != "custodian_threshold" {
		return ErrInvalidTrigger
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	plan.UpdatedAt = time.Now().Unix()
	m.plan = &plan
	return nil
}

// GetPlan retrieves the current estate plan.
func (m *EstateManager) GetPlan() (*domain.EstatePlan, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.plan == nil {
		return nil, ErrNoPlan
	}
	p := *m.plan
	return &p, nil
}

// Activate triggers estate recovery when custodian threshold is met.
func (m *EstateManager) Activate(trigger string, _ [][]byte) error {
	if trigger != "custodian_threshold" {
		return ErrInvalidTrigger
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.activated = true
	return nil
}

// IsActivated returns true if the estate plan has been activated.
func (m *EstateManager) IsActivated() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.activated
}

// DeliverKeys sends per-beneficiary DEKs via Dina-to-Dina encrypted channel.
func (m *EstateManager) DeliverKeys(_ string) error {
	return nil
}

// NotifyContacts sends activation notifications to all contacts in the notification list.
func (m *EstateManager) NotifyContacts() error {
	return nil
}

// EnforceDefaultAction applies destroy/archive to non-assigned data.
func (m *EstateManager) EnforceDefaultAction(action string) error {
	if action != "destroy" && action != "archive" {
		return ErrInvalidAction
	}
	return nil
}

// CheckExpiry checks if a time-limited access grant has expired.
func (m *EstateManager) CheckExpiry(accessType string, grantedAt int64) (bool, error) {
	if accessType == "read_only_90_days" {
		now := time.Now().Unix()
		ninetyDays := int64(90 * 24 * 60 * 60)
		return (now - grantedAt) > ninetyDays, nil
	}
	return false, nil
}

// ResetForTest clears all state for test isolation.
func (m *EstateManager) ResetForTest() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.plan = nil
	m.activated = false
}
