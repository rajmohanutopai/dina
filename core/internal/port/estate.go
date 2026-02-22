package port

import (
	"context"

	"github.com/anthropics/dina/core/internal/domain"
)

// EstateManager handles digital estate planning (Shamir-based key delivery).
type EstateManager interface {
	StorePlan(ctx context.Context, plan domain.EstatePlan) error
	GetPlan(ctx context.Context) (*domain.EstatePlan, error)
	Activate(ctx context.Context, trigger string, custodianShares [][]byte) error
	DeliverKeys(ctx context.Context, beneficiaryDID string) error
	NotifyContacts(ctx context.Context) error
}
