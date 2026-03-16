package service

import (
	"context"
	"fmt"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
)

// OnboardingService orchestrates the first-run setup wizard.
// It coordinates identity bootstrap, vault creation, and initial persona setup.
// BIP-39 mnemonic generation is handled client-side (Python CLI / install.sh).
// Core receives the pre-existing seed and passphrase:
//
//	seed + passphrase -> DID -> DEKs -> databases -> ready
type OnboardingService struct {
	identity *IdentityService
	vault    port.VaultManager
	clock    port.Clock
}

// NewOnboardingService constructs an OnboardingService with the given dependencies.
func NewOnboardingService(
	identity *IdentityService,
	vault port.VaultManager,
	clock port.Clock,
) *OnboardingService {
	return &OnboardingService{
		identity: identity,
		vault:    vault,
		clock:    clock,
	}
}

// OnboardingResult holds the outputs of the first-run setup.
type OnboardingResult struct {
	// RootDID is the user's root decentralized identifier.
	RootDID domain.DID

	// WrappedSeed is the AES-256-GCM encrypted master seed for persistence.
	WrappedSeed []byte

	// Personas lists the names of personas created during onboarding.
	Personas []string

	// Steps records the completed onboarding steps for progress tracking.
	Steps []domain.OnboardingStep
}

// RunOnboarding performs the complete first-run setup:
//  1. Validate inputs (email, seed, passphrase).
//  2. Bootstrap identity (DID, persona DEKs) via IdentityService.
//  3. Verify the default vault is open and operational.
//
// The seed must be generated and shown as mnemonic client-side (Python CLI
// or install.sh) before calling this method. Core never generates mnemonics.
// The email is used for contact bootstrapping and recovery association.
// The passphrase protects the master seed via Argon2id-derived KEK.
func (s *OnboardingService) RunOnboarding(ctx context.Context, email string, seed []byte, passphrase string) (*OnboardingResult, error) {
	var steps []domain.OnboardingStep

	// Step 1: Validate inputs.
	if email == "" {
		return nil, fmt.Errorf("onboarding: %w: email must not be empty", domain.ErrInvalidInput)
	}
	if len(seed) != 32 {
		return nil, fmt.Errorf("onboarding: %w: seed must be 32 bytes", domain.ErrInvalidInput)
	}
	if passphrase == "" {
		return nil, fmt.Errorf("onboarding: %w: passphrase must not be empty", domain.ErrInvalidInput)
	}

	steps = append(steps, domain.OnboardingStep{
		Name:      "validate_inputs",
		Completed: true,
		Data:      map[string]interface{}{"email": email},
	})

	// Step 2: Bootstrap identity.
	setupResult, err := s.identity.Setup(ctx, seed, passphrase)
	if err != nil {
		return nil, fmt.Errorf("onboarding: identity setup failed: %w", err)
	}

	steps = append(steps, domain.OnboardingStep{
		Name:      "identity_bootstrap",
		Completed: true,
		Data: map[string]interface{}{
			"root_did": setupResult.RootDID.String(),
			"personas": setupResult.Personas,
		},
	})

	// Step 3: Verify the default persona vault is open.
	defaultPersona, err := domain.NewPersonaName("general")
	if err != nil {
		return nil, fmt.Errorf("onboarding: %w", err)
	}
	if !s.vault.IsOpen(defaultPersona) {
		return nil, fmt.Errorf("onboarding: %w: default persona vault did not open", domain.ErrPersonaLocked)
	}

	steps = append(steps, domain.OnboardingStep{
		Name:      "vault_ready",
		Completed: true,
		Data: map[string]interface{}{
			"persona":   "general",
			"timestamp": s.clock.Now().Unix(),
		},
	})

	return &OnboardingResult{
		RootDID:     setupResult.RootDID,
		WrappedSeed: setupResult.WrappedSeed,
		Personas:    setupResult.Personas,
		Steps:       steps,
	}, nil
}
