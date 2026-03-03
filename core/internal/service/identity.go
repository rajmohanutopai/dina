package service

import (
	"context"
	"fmt"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
)

// IdentityService orchestrates the identity lifecycle:
// HD key derivation, DID creation, persona management, and vault unlocking.
// BIP-39 mnemonic generation is handled client-side (Python CLI / install.sh).
// Core receives only the wrapped seed blob — never the raw seed or mnemonic.
type IdentityService struct {
	hd       port.HDKeyDeriver
	deriver  port.KeyDeriver
	did      port.DIDManager
	personas port.PersonaManager
	wrapper  port.KeyWrapper
	kek      port.KEKDeriver
	vault    port.VaultManager
	clock    port.Clock
}

// NewIdentityService constructs an IdentityService with the given port dependencies.
func NewIdentityService(
	hd port.HDKeyDeriver,
	deriver port.KeyDeriver,
	did port.DIDManager,
	personas port.PersonaManager,
	wrapper port.KeyWrapper,
	kek port.KEKDeriver,
	vault port.VaultManager,
	clock port.Clock,
) *IdentityService {
	return &IdentityService{
		hd:       hd,
		deriver:  deriver,
		did:      did,
		personas: personas,
		wrapper:  wrapper,
		kek:      kek,
		vault:    vault,
		clock:    clock,
	}
}

// SetupResult holds the outputs of the identity setup workflow.
type SetupResult struct {
	RootDID     domain.DID
	WrappedSeed []byte
	Personas    []string
}

// Setup performs identity bootstrap from a pre-existing seed:
//  1. Derive a KEK from the passphrase and wrap the master seed.
//  2. Derive the root signing key via SLIP-0010 and create the root DID.
//  3. Create the default persona ("personal") and derive its DEK.
//  4. Open the persona vault with the derived DEK.
//
// The seed must be generated and shown as mnemonic client-side (Python CLI
// or install.sh) before calling this method. Core never generates mnemonics.
func (s *IdentityService) Setup(ctx context.Context, seed []byte, passphrase string) (*SetupResult, error) {
	if passphrase == "" {
		return nil, fmt.Errorf("identity setup: %w: passphrase must not be empty", domain.ErrInvalidInput)
	}
	if len(seed) != 32 {
		return nil, fmt.Errorf("identity setup: %w: seed must be 32 bytes", domain.ErrInvalidInput)
	}

	// Step 1: Derive KEK from passphrase and wrap the seed.
	salt := seed[:16]
	kekBytes, err := s.kek.DeriveKEK(passphrase, salt)
	if err != nil {
		return nil, fmt.Errorf("identity setup: KEK derivation failed: %w", err)
	}

	wrappedSeed, err := s.wrapper.Wrap(seed, kekBytes)
	if err != nil {
		return nil, fmt.Errorf("identity setup: seed wrapping failed: %w", err)
	}

	// Step 2: Derive root signing key and create root DID.
	rootPub, _, err := s.hd.DerivePath(seed, "m/44'/60'/0'/0'/0'")
	if err != nil {
		return nil, fmt.Errorf("identity setup: root key derivation failed: %w", err)
	}

	rootDID, err := s.did.Create(ctx, rootPub)
	if err != nil {
		return nil, fmt.Errorf("identity setup: DID creation failed: %w", err)
	}

	// Step 3: Create the default "personal" persona.
	const defaultPersona = "personal"
	_, err = s.personas.Create(ctx, defaultPersona, string(domain.TierOpen))
	if err != nil {
		return nil, fmt.Errorf("identity setup: persona creation failed: %w", err)
	}

	// Step 4: Derive persona DEK and open the vault.
	personaName, err := domain.NewPersonaName(defaultPersona)
	if err != nil {
		return nil, fmt.Errorf("identity setup: %w", err)
	}

	dek, err := s.deriver.DerivePersonaDEK(seed, personaName)
	if err != nil {
		return nil, fmt.Errorf("identity setup: DEK derivation failed: %w", err)
	}

	if err := s.vault.Open(ctx, personaName, dek); err != nil {
		return nil, fmt.Errorf("identity setup: vault open failed: %w", err)
	}

	return &SetupResult{
		RootDID:     rootDID,
		WrappedSeed: wrappedSeed,
		Personas:    []string{defaultPersona},
	}, nil
}

// DerivePersonaDEK derives the Data Encryption Key for a named persona
// from the master seed. The DEK is deterministic: same seed + persona
// always produces the same key.
func (s *IdentityService) DerivePersonaDEK(seed []byte, persona domain.PersonaName) ([]byte, error) {
	dek, err := s.deriver.DerivePersonaDEK(seed, persona)
	if err != nil {
		return nil, fmt.Errorf("derive persona DEK: %w", err)
	}
	return dek, nil
}

// CreatePersona creates a new persona with the given name and tier,
// derives its DEK from the master seed, and opens the vault.
func (s *IdentityService) CreatePersona(ctx context.Context, seed []byte, name, tier string) (string, error) {
	personaName, err := domain.NewPersonaName(name)
	if err != nil {
		return "", fmt.Errorf("create persona: %w", err)
	}

	personaID, err := s.personas.Create(ctx, name, tier)
	if err != nil {
		return "", fmt.Errorf("create persona: %w", err)
	}

	// LOW-15: Derive DEK using the persona's recorded version.
	// Post-create, GetDEKVersion must succeed — hard fail on error.
	dekVersion, dekErr := s.personas.GetDEKVersion(ctx, personaID)
	if dekErr != nil {
		return "", fmt.Errorf("create persona: get DEK version: %w", dekErr)
	}
	if dekVersion == 0 {
		dekVersion = 1
	}
	dek, err := s.deriver.DerivePersonaDEKVersioned(seed, personaName, dekVersion)
	if err != nil {
		return "", fmt.Errorf("create persona: DEK derivation failed: %w", err)
	}

	if err := s.vault.Open(ctx, personaName, dek); err != nil {
		return "", fmt.Errorf("create persona: vault open failed: %w", err)
	}

	return personaID, nil
}

// ListPersonas returns the names of all registered personas.
func (s *IdentityService) ListPersonas(ctx context.Context) ([]string, error) {
	personas, err := s.personas.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("list personas: %w", err)
	}
	return personas, nil
}
