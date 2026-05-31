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

// ScenarioPolicyManager controls per-contact, per-scenario D2D send/receive policy.
// Policies survive restarts — backed by the identity.sqlite scenario_policies table.
type ScenarioPolicyManager interface {
	// GetScenarioTier returns the policy tier for a contact+scenario pair.
	// Returns ScenarioDenyByDefault if no explicit policy has been set.
	GetScenarioTier(ctx context.Context, contactDID, scenario string) (domain.ScenarioTier, error)

	// SetScenarioPolicy sets (or replaces) the tier for a contact+scenario pair.
	SetScenarioPolicy(ctx context.Context, contactDID, scenario string, tier domain.ScenarioTier) error

	// ListPolicies returns all scenario→tier mappings for a contact.
	// Returns an empty map (not an error) when no policies have been set.
	ListPolicies(ctx context.Context, contactDID string) (map[string]domain.ScenarioTier, error)

	// SetDefaultPolicies inserts the six v1 default policies for a new contact.
	// Existing policies are not overwritten (INSERT OR IGNORE semantics).
	SetDefaultPolicies(ctx context.Context, contactDID string) error
}
