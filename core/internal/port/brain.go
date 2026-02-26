package port

import (
	"context"

	"github.com/rajmohanutopai/dina/core/internal/domain"
)

// BrainClient is how core communicates with the Python brain sidecar.
type BrainClient interface {
	Process(ctx context.Context, event domain.TaskEvent) error
	Reason(ctx context.Context, query string) (*domain.ReasonResult, error)
	IsHealthy(ctx context.Context) bool
}
