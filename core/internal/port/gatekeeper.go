package port

import (
	"context"

	"github.com/rajmohanutopai/dina/core/internal/domain"
)

// Gatekeeper is the safety layer for autonomous agents.
// Any agent acting on behalf of the user submits intent to the gatekeeper first.
// Safe tasks pass silently; risky actions require approval.
type Gatekeeper interface {
	EvaluateIntent(ctx context.Context, intent domain.Intent) (domain.Decision, error)
	CheckEgress(ctx context.Context, destination string, data []byte) (bool, error)
}

// SharingPolicyManager controls per-contact data sharing tiers.
type SharingPolicyManager interface {
	GetPolicy(ctx context.Context, contactDID string) (*domain.SharingPolicy, error)
	SetPolicy(ctx context.Context, contactDID string, categories map[string]domain.SharingTier) error
	FilterEgress(ctx context.Context, payload domain.EgressPayload) (*domain.EgressResult, error)
}
