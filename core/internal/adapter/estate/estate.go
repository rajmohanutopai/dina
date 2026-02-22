// Package estate provides an in-memory stub for digital estate planning.
package estate

import (
	"context"
	"errors"
	"sync"

	"github.com/anthropics/dina/core/internal/domain"
	"github.com/anthropics/dina/core/internal/port"
)

var _ port.EstateManager = (*EstateManager)(nil)

var (
	ErrNoPlan        = errors.New("estate: no estate plan stored")
	ErrNotActivated  = errors.New("estate: plan not activated")
)

// EstateManager is an in-memory stub for estate planning.
// Real Shamir-based key delivery is deferred to the estate phase.
type EstateManager struct {
	mu   sync.Mutex
	plan *domain.EstatePlan
}

// NewEstateManager returns a new in-memory EstateManager.
func NewEstateManager() *EstateManager {
	return &EstateManager{}
}

func (m *EstateManager) StorePlan(_ context.Context, plan domain.EstatePlan) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.plan = &plan
	return nil
}

func (m *EstateManager) GetPlan(_ context.Context) (*domain.EstatePlan, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.plan == nil {
		return nil, ErrNoPlan
	}
	p := *m.plan
	return &p, nil
}

func (m *EstateManager) Activate(_ context.Context, _ string, _ [][]byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.plan == nil {
		return ErrNoPlan
	}
	return nil
}

func (m *EstateManager) DeliverKeys(_ context.Context, _ string) error {
	return ErrNotActivated
}

func (m *EstateManager) NotifyContacts(_ context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.plan == nil {
		return ErrNoPlan
	}
	return nil
}
