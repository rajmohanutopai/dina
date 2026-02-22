package service

import (
	"context"
	"fmt"

	"github.com/anthropics/dina/core/internal/domain"
	"github.com/anthropics/dina/core/internal/port"
)

// OnboardingService orchestrates the first-run setup wizard.
// It coordinates identity bootstrap, vault creation, and initial persona setup.
// This is the entry point for the entire onboarding flow:
//
//	email + passphrase -> mnemonic -> DID -> DEKs -> databases -> ready
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
	// Mnemonic is the BIP-39 recovery phrase. Shown once, never stored.
	Mnemonic string

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
//  1. Validate inputs (email, passphrase).
//  2. Bootstrap identity (mnemonic, DID, persona DEKs) via IdentityService.
//  3. Verify the default vault is open and operational.
//  4. Return the mnemonic for one-time backup display.
//
// The email is used for contact bootstrapping and recovery association.
// The passphrase protects the master seed via Argon2id-derived KEK.
func (s *OnboardingService) RunOnboarding(ctx context.Context, email, passphrase string) (*OnboardingResult, error) {
	var steps []domain.OnboardingStep

	// Step 1: Validate inputs.
	if email == "" {
		return nil, fmt.Errorf("onboarding: %w: email must not be empty", domain.ErrInvalidInput)
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
	setupResult, err := s.identity.Setup(ctx, passphrase)
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
	defaultPersona, err := domain.NewPersonaName("personal")
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
			"persona":   "personal",
			"timestamp": s.clock.Now().Unix(),
		},
	})

	return &OnboardingResult{
		Mnemonic:    setupResult.Mnemonic,
		RootDID:     setupResult.RootDID,
		WrappedSeed: setupResult.WrappedSeed,
		Personas:    setupResult.Personas,
		Steps:       steps,
	}, nil
}
