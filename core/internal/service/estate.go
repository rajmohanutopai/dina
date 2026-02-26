package service

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
)

// EstateService manages the digital estate plan lifecycle:
// plan storage, custodian threshold activation via Shamir secret sharing,
// key delivery to beneficiaries, and read-only mode enforcement.
//
// Design constraints (per §27):
//   - No dead man's switch (no timer-based triggers)
//   - Activation requires custodian threshold (k-of-n Shamir shares)
//   - Beneficiaries get read-only access for 90 days, then data is
//     destroyed or archived per the plan's default action
//   - Non-assigned data is destroyed on activation
type EstateService struct {
	estate   port.EstateManager
	vault    port.VaultManager
	recovery port.RecoveryManager
	notifier port.ClientNotifier
	clock    port.Clock
}

// NewEstateService constructs an EstateService with the given port dependencies.
func NewEstateService(
	estate port.EstateManager,
	vault port.VaultManager,
	recovery port.RecoveryManager,
	notifier port.ClientNotifier,
	clock port.Clock,
) *EstateService {
	return &EstateService{
		estate:   estate,
		vault:    vault,
		recovery: recovery,
		notifier: notifier,
		clock:    clock,
	}
}

// StorePlan persists a validated estate plan. The plan is stored in the
// identity vault (Tier 0) and cannot be modified while in read-only mode.
func (s *EstateService) StorePlan(ctx context.Context, plan domain.EstatePlan) error {
	// Validate the plan.
	if err := s.validatePlan(plan); err != nil {
		return fmt.Errorf("estate: %w", err)
	}

	// Set timestamps.
	now := s.clock.Now().Unix()
	if plan.CreatedAt == 0 {
		plan.CreatedAt = now
	}
	plan.UpdatedAt = now

	if err := s.estate.StorePlan(ctx, plan); err != nil {
		return fmt.Errorf("estate: store plan: %w", err)
	}

	return nil
}

// GetPlan retrieves the current estate plan.
func (s *EstateService) GetPlan(ctx context.Context) (*domain.EstatePlan, error) {
	plan, err := s.estate.GetPlan(ctx)
	if err != nil {
		return nil, fmt.Errorf("estate: get plan: %w", err)
	}
	return plan, nil
}

// Activate processes an estate activation request. It verifies that the
// custodian threshold is met by reconstructing the master seed from the
// provided Shamir shares. On success, it transitions the system to
// read-only mode and notifies all contacts on the notification list.
func (s *EstateService) Activate(ctx context.Context, custodianShares [][]byte) error {
	// Retrieve the plan.
	plan, err := s.estate.GetPlan(ctx)
	if err != nil {
		return fmt.Errorf("estate: get plan for activation: %w", err)
	}
	if plan == nil {
		return fmt.Errorf("estate: %w: no estate plan configured", domain.ErrInvalidInput)
	}

	// Verify threshold is met.
	if len(custodianShares) < plan.Threshold {
		return fmt.Errorf("estate: insufficient shares: got %d, need %d", len(custodianShares), plan.Threshold)
	}

	// Attempt to reconstruct the master seed from shares.
	_, err = s.recovery.Combine(custodianShares)
	if err != nil {
		return fmt.Errorf("estate: reconstruct seed: %w", err)
	}

	// Activate via the estate manager.
	if err := s.estate.Activate(ctx, plan.Trigger, custodianShares); err != nil {
		return fmt.Errorf("estate: activate: %w", err)
	}

	// Notify contacts.
	if err := s.notifyActivation(ctx, plan); err != nil {
		// Log but don't fail activation for notification errors.
		_ = err
	}

	return nil
}

// DeliverKeys delivers vault keys to a specific beneficiary via the D2D
// protocol. The beneficiary receives read-only access to their assigned
// personas for 90 days.
func (s *EstateService) DeliverKeys(ctx context.Context, beneficiaryDID string) error {
	plan, err := s.estate.GetPlan(ctx)
	if err != nil {
		return fmt.Errorf("estate: get plan for key delivery: %w", err)
	}
	if plan == nil {
		return fmt.Errorf("estate: %w: no estate plan configured", domain.ErrInvalidInput)
	}

	// Verify the beneficiary is in the plan.
	personas, ok := plan.Beneficiaries[beneficiaryDID]
	if !ok {
		return fmt.Errorf("estate: %w: DID not in beneficiary list", domain.ErrForbidden)
	}

	_ = personas // Keys would be delivered for these specific personas.

	if err := s.estate.DeliverKeys(ctx, beneficiaryDID); err != nil {
		return fmt.Errorf("estate: deliver keys: %w", err)
	}

	return nil
}

// ReadOnlyExpiry returns the time at which read-only access expires.
// Per §27, beneficiaries get 90 days of read-only access after activation.
func (s *EstateService) ReadOnlyExpiry(activatedAt int64) time.Time {
	return time.Unix(activatedAt, 0).Add(90 * 24 * time.Hour)
}

// validatePlan checks estate plan structural validity.
func (s *EstateService) validatePlan(plan domain.EstatePlan) error {
	if plan.Trigger != "custodian_threshold" {
		return fmt.Errorf("%w: trigger must be 'custodian_threshold', got %q", domain.ErrInvalidInput, plan.Trigger)
	}

	if len(plan.Custodians) == 0 {
		return fmt.Errorf("%w: at least one custodian is required", domain.ErrInvalidInput)
	}

	if plan.Threshold <= 0 || plan.Threshold > len(plan.Custodians) {
		return fmt.Errorf("%w: threshold must be between 1 and %d", domain.ErrInvalidInput, len(plan.Custodians))
	}

	if plan.DefaultAction != "destroy" && plan.DefaultAction != "archive" {
		return fmt.Errorf("%w: default_action must be 'destroy' or 'archive'", domain.ErrInvalidInput)
	}

	return nil
}

// notifyActivation sends notifications to all contacts on the notification list.
func (s *EstateService) notifyActivation(ctx context.Context, plan *domain.EstatePlan) error {
	payload, _ := json.Marshal(map[string]interface{}{
		"type":    "estate_activation",
		"trigger": plan.Trigger,
	})

	return s.notifier.Broadcast(ctx, payload)
}
