package port

import (
	"context"

	"github.com/rajmohanutopai/dina/core/internal/domain"
)

// Server is the HTTP server that hosts all API endpoints.
type Server interface {
	ListenAndServe(addr string) error
	Shutdown(ctx context.Context) error
	Routes() []string
}

// BootSequencer manages the startup sequence including vault unlock.
type BootSequencer interface {
	Boot(ctx context.Context, cfg domain.BootConfig) error
	UnlockVault(ctx context.Context, personaID string) error
	IsVaultOpen(personaID string) (bool, error)
	OpenPersonas() ([]string, error)
	NotifyBrain(ctx context.Context) error
	CurrentMode() string
}

// OnboardingSequence manages the first-run setup wizard.
type OnboardingSequence interface {
	StartOnboarding(ctx context.Context, email, passphrase string) (mnemonic string, err error)
	GetSteps() ([]domain.OnboardingStep, error)
}
