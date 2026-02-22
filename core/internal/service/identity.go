package service

import (
	"context"
	"fmt"

	"github.com/anthropics/dina/core/internal/domain"
	"github.com/anthropics/dina/core/internal/port"
)

// IdentityService orchestrates the full identity lifecycle:
// mnemonic generation, HD key derivation, DID creation, persona management,
// and vault unlocking. It composes port interfaces without depending on adapters.
type IdentityService struct {
	mnemonic port.MnemonicGenerator
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
	mnemonic port.MnemonicGenerator,
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
		mnemonic: mnemonic,
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
	Mnemonic    string
	RootDID     domain.DID
	WrappedSeed []byte
	Personas    []string
}

// Setup performs the complete first-run identity bootstrap:
//  1. Generate a BIP-39 mnemonic and derive the master seed.
//  2. Derive a KEK from the passphrase and wrap the master seed.
//  3. Derive the root signing key via SLIP-0010 and create the root DID.
//  4. Create the default persona ("personal") and derive its DEK.
//  5. Open the persona vault with the derived DEK.
//
// The mnemonic is returned to the caller exactly once for backup.
// The wrapped seed is persisted; the raw seed is never stored.
func (s *IdentityService) Setup(ctx context.Context, passphrase string) (*SetupResult, error) {
	if passphrase == "" {
		return nil, fmt.Errorf("identity setup: %w: passphrase must not be empty", domain.ErrInvalidInput)
	}

	// Step 1: Generate mnemonic and seed.
	mnemonic, seed, err := s.mnemonic.Generate()
	if err != nil {
		return nil, fmt.Errorf("identity setup: mnemonic generation failed: %w", err)
	}

	// Step 2: Derive KEK from passphrase and wrap the seed.
	// Use first 16 bytes of seed as salt for KEK derivation.
	salt := seed[:16]
	kekBytes, err := s.kek.DeriveKEK(passphrase, salt)
	if err != nil {
		return nil, fmt.Errorf("identity setup: KEK derivation failed: %w", err)
	}

	wrappedSeed, err := s.wrapper.Wrap(seed, kekBytes)
	if err != nil {
		return nil, fmt.Errorf("identity setup: seed wrapping failed: %w", err)
	}

	// Step 3: Derive root signing key and create root DID.
	// SLIP-0010 path for Dina root key: m/44'/60'/0'/0'/0'
	rootPub, _, err := s.hd.DerivePath(seed, "m/44'/60'/0'/0'/0'")
	if err != nil {
		return nil, fmt.Errorf("identity setup: root key derivation failed: %w", err)
	}

	rootDID, err := s.did.Create(ctx, rootPub)
	if err != nil {
		return nil, fmt.Errorf("identity setup: DID creation failed: %w", err)
	}

	// Step 4: Create the default "personal" persona.
	const defaultPersona = "personal"
	_, err = s.personas.Create(ctx, defaultPersona, string(domain.TierOpen))
	if err != nil {
		return nil, fmt.Errorf("identity setup: persona creation failed: %w", err)
	}

	// Step 5: Derive persona DEK and open the vault.
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
		Mnemonic:    mnemonic,
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

	dek, err := s.deriver.DerivePersonaDEK(seed, personaName)
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
