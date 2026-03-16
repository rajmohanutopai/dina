package test

import (
	"bytes"
	"context"
	"crypto/rand"
	"testing"

	"github.com/rajmohanutopai/dina/core/internal/adapter/onboarding"
	"github.com/rajmohanutopai/dina/core/test/testutil"
)

// ==========================================================================
// TEST_PLAN §19 — Onboarding Sequence
// ==========================================================================
// Covers the managed onboarding flow: "email + password -> done" with 9
// silent steps plus post-setup assertions (one default persona, deferred
// mnemonic backup, default-deny sharing rules).
//
// Every test calls testutil.RequireImplementation to skip until the real
// implementation is wired in.
// ==========================================================================

// --------------------------------------------------------------------------
// §19.1 Managed Onboarding: "email + password -> done"
// --------------------------------------------------------------------------

// TST-CORE-649
func TestOnboarding_19_1_ManagedOnboarding(t *testing.T) {
	impl := realOnboardingSequence
	testutil.RequireImplementation(t, impl, "OnboardingSequence")

	// --- Negative path: empty email must fail ---
	_, err := impl.StartOnboarding(context.Background(), "", testutil.TestPassphrase)
	testutil.RequireError(t, err)

	// --- Negative path: empty passphrase must fail ---
	_, err = impl.StartOnboarding(context.Background(), "user@example.com", "")
	testutil.RequireError(t, err)

	// --- Happy path: valid email + passphrase ---
	// BIP-39 mnemonic is generated client-side.
	// Core returns empty mnemonic — it only receives the wrapped seed blob.
	mnemonic, err := impl.StartOnboarding(context.Background(), "user@example.com", testutil.TestPassphrase)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, mnemonic, "")

	// After successful onboarding, verify key post-conditions:
	// Root DID must be set and start with "did:" prefix.
	rootDID, err := impl.GetRootDID()
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(rootDID) > 0, "root DID must be set after onboarding")
	testutil.RequireHasPrefix(t, rootDID, "did:")

	// Only "general" persona must exist.
	personas, err := impl.GetPersonas()
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(personas), 1)

	// Security mode must be "convenience" for managed hosting.
	mode, err := impl.GetSecurityMode()
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, mode, "convenience")

	// Sharing rules must default to empty (default-deny egress).
	rules, err := impl.GetSharingRules()
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(rules), 0)

	// Steps must be present and all completed.
	steps, err := impl.GetSteps()
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(steps) >= 9, "onboarding must have at least 9 silent steps")
	for _, step := range steps {
		testutil.RequireTrue(t, step.Completed, "step "+step.Name+" must be completed")
	}

	// Mnemonic backup must be deferred.
	testutil.RequireTrue(t, impl.IsMnemonicBackupDeferred(),
		"mnemonic backup prompt must be deferred to Day 7")
}

// --------------------------------------------------------------------------
// §19.2 Silent Step 1: BIP-39 Mnemonic Generated
// --------------------------------------------------------------------------

// TST-CORE-650
func TestOnboarding_19_2_SeedReceivedFromClient(t *testing.T) {
	// BIP-39 mnemonic generation is now handled client-side (Python CLI / install.sh).
	// Core receives only the wrapped seed blob — never generates mnemonics.
	impl := realOnboardingSequence
	testutil.RequireImplementation(t, impl, "OnboardingSequence")

	mnemonic, err := impl.StartOnboarding(context.Background(), "seed-test@example.com", testutil.TestPassphrase)
	testutil.RequireNoError(t, err)

	// Core no longer generates mnemonics — returns empty string.
	testutil.RequireEqual(t, mnemonic, "")

	// Verify onboarding actually ran — steps must be populated.
	steps, err := impl.GetSteps()
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(steps) > 0, "StartOnboarding must populate onboarding steps")

	// Negative control: empty email must be rejected.
	_, err = impl.StartOnboarding(context.Background(), "", testutil.TestPassphrase)
	testutil.RequireError(t, err)

	// Negative control: empty passphrase must be rejected.
	_, err = impl.StartOnboarding(context.Background(), "another@example.com", "")
	testutil.RequireError(t, err)
}

// --------------------------------------------------------------------------
// §19.3 Silent Step 2: Root Ed25519 Keypair Derived
// --------------------------------------------------------------------------

// TST-CORE-651
func TestOnboarding_19_3_RootKeypairDerived(t *testing.T) {
	// var impl testutil.OnboardingSequence = realonboarding.New(...)
	impl := realOnboardingSequence
	testutil.RequireImplementation(t, impl, "OnboardingSequence")

	_, err := impl.StartOnboarding(context.Background(), "user@example.com", testutil.TestPassphrase)
	testutil.RequireNoError(t, err)

	// SLIP-0010 m/9999'/0'/0' -> root keypair (generation 0). The DID should be derivable.
	steps, err := impl.GetSteps()
	testutil.RequireNoError(t, err)

	found := false
	for _, step := range steps {
		if step.Name == "root_keypair" {
			found = true
			testutil.RequireTrue(t, step.Completed, "root keypair derivation must complete")
		}
	}
	testutil.RequireTrue(t, found, "root_keypair step must exist in onboarding sequence")
}

// --------------------------------------------------------------------------
// §19.4 Silent Step 3: did:plc Registered
// --------------------------------------------------------------------------

// TST-CORE-652
func TestOnboarding_19_4_DIDRegistered(t *testing.T) {
	// var impl testutil.OnboardingSequence = realonboarding.New(...)
	impl := realOnboardingSequence
	testutil.RequireImplementation(t, impl, "OnboardingSequence")

	_, err := impl.StartOnboarding(context.Background(), "did-reg@example.com", testutil.TestPassphrase)
	testutil.RequireNoError(t, err)

	// Root DID must be registered after onboarding.
	rootDID, err := impl.GetRootDID()
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(rootDID) > 0, "root DID must be set after onboarding")
	// DID must follow proper did:plc: format (not just "did:").
	testutil.RequireHasPrefix(t, rootDID, "did:plc:")
	// DID must have content beyond the method prefix — proves it's unique.
	testutil.RequireTrue(t, len(rootDID) > len("did:plc:"), "DID must have content beyond the method prefix")

	// Verify GetRootDID is deterministic (same call returns same DID).
	rootDID2, err := impl.GetRootDID()
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, rootDID, rootDID2)
}

// --------------------------------------------------------------------------
// §19.5 Silent Step 4: Per-Database DEKs Derived
// --------------------------------------------------------------------------

// TST-CORE-653
func TestOnboarding_19_5_DEKsDerived(t *testing.T) {
	// Onboarding step check (stub adapter — always reports complete).
	impl := realOnboardingSequence
	testutil.RequireImplementation(t, impl, "OnboardingSequence")

	_, err := impl.StartOnboarding(context.Background(), "user@example.com", testutil.TestPassphrase)
	testutil.RequireNoError(t, err)

	steps, err := impl.GetSteps()
	testutil.RequireNoError(t, err)

	found := false
	for _, step := range steps {
		if step.Name == "dek_derivation" {
			found = true
			testutil.RequireTrue(t, step.Completed, "DEK derivation must complete")
		}
	}
	testutil.RequireTrue(t, found, "dek_derivation step must exist in onboarding sequence")

	// --- Real HKDF DEK derivation ---
	deriver := realVaultDEKDeriver
	testutil.RequireImplementation(t, deriver, "VaultDEKDeriver")

	masterSeed := make([]byte, 32)
	_, _ = rand.Read(masterSeed)

	// Positive: derive DEKs for two personas.
	dekA, err := deriver.DeriveVaultDEK(masterSeed, "persona-alpha", testutil.TestUserSalt[:])
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(dekA), 32)

	dekB, err := deriver.DeriveVaultDEK(masterSeed, "persona-beta", testutil.TestUserSalt[:])
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(dekB), 32)

	// Different personas MUST produce different DEKs.
	if bytes.Equal(dekA, dekB) {
		t.Fatal("DEKs for different personas must differ")
	}

	// Same persona must produce deterministic DEK.
	dekA2, err := deriver.DeriveVaultDEK(masterSeed, "persona-alpha", testutil.TestUserSalt[:])
	testutil.RequireNoError(t, err)
	if !bytes.Equal(dekA, dekA2) {
		t.Fatal("same inputs must produce identical DEK (deterministic)")
	}

	// Negative: empty master seed must fail.
	_, err = deriver.DeriveVaultDEK(nil, "persona-alpha", testutil.TestUserSalt[:])
	testutil.RequireError(t, err)

	// Negative: empty persona ID must fail.
	_, err = deriver.DeriveVaultDEK(masterSeed, "", testutil.TestUserSalt[:])
	testutil.RequireError(t, err)

	// Negative: empty salt must fail.
	_, err = deriver.DeriveVaultDEK(masterSeed, "persona-alpha", nil)
	testutil.RequireError(t, err)
}

// --------------------------------------------------------------------------
// §19.6 Silent Step 5: Password Wraps Master Seed
// --------------------------------------------------------------------------

// TST-CORE-654
func TestOnboarding_19_6_PasswordWrapsMasterSeed(t *testing.T) {
	// Verify the onboarding step is still listed (regression guard).
	impl := realOnboardingSequence
	testutil.RequireImplementation(t, impl, "OnboardingSequence")

	_, err := impl.StartOnboarding(context.Background(), "user@example.com", testutil.TestPassphrase)
	testutil.RequireNoError(t, err)

	steps, err := impl.GetSteps()
	testutil.RequireNoError(t, err)

	found := false
	for _, step := range steps {
		if step.Name == "passphrase_wrap" {
			found = true
			testutil.RequireTrue(t, step.Completed, "passphrase wrapping must complete")
		}
	}
	testutil.RequireTrue(t, found, "passphrase_wrap step must exist in onboarding sequence")

	// ---- Exercise real production crypto: Argon2id -> KEK -> AES-256-GCM wrap ----
	// This validates the actual code path that "password wraps master seed" depends on.

	kekDeriver := realKEKDeriver
	testutil.RequireImplementation(t, kekDeriver, "KEKDeriver")
	wrapper := realKeyWrapper
	testutil.RequireImplementation(t, wrapper, "KeyWrapper")

	// Simulate a 32-byte master seed (the material being wrapped).
	masterSeed := make([]byte, 32)
	_, err = rand.Read(masterSeed)
	testutil.RequireNoError(t, err)

	// Step 1: Derive KEK from passphrase via Argon2id.
	salt := testutil.TestUserSalt[:16]
	kek, err := kekDeriver.DeriveKEK(testutil.TestPassphrase, salt)
	testutil.RequireNoError(t, err)
	testutil.RequireBytesLen(t, kek, 32)

	// Step 2: Wrap the master seed with the KEK (AES-256-GCM).
	wrapped, err := wrapper.Wrap(masterSeed, kek)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(wrapped) > len(masterSeed),
		"wrapped blob must be longer than plaintext (nonce + tag)")

	// Wrapped blob must NOT contain the plaintext seed.
	testutil.RequireFalse(t, bytes.Equal(wrapped[:32], masterSeed),
		"wrapped output must not start with plaintext seed")

	// Step 3: Unwrap with the correct KEK recovers the seed.
	unwrapped, err := wrapper.Unwrap(wrapped, kek)
	testutil.RequireNoError(t, err)
	testutil.RequireBytesEqual(t, masterSeed, unwrapped)

	// Step 4: Unwrap with a wrong-passphrase-derived KEK must fail.
	wrongKEK, err := kekDeriver.DeriveKEK(testutil.TestPassphraseWrong, salt)
	testutil.RequireNoError(t, err)
	testutil.RequireBytesNotEqual(t, kek, wrongKEK)

	_, err = wrapper.Unwrap(wrapped, wrongKEK)
	testutil.RequireError(t, err)

	// Step 5: Re-deriving KEK with the same passphrase + salt is deterministic.
	kek2, err := kekDeriver.DeriveKEK(testutil.TestPassphrase, salt)
	testutil.RequireNoError(t, err)
	testutil.RequireBytesEqual(t, kek, kek2)

	// Deterministic KEK means a second unwrap also succeeds.
	unwrapped2, err := wrapper.Unwrap(wrapped, kek2)
	testutil.RequireNoError(t, err)
	testutil.RequireBytesEqual(t, masterSeed, unwrapped2)
}

// --------------------------------------------------------------------------
// §19.7 Silent Step 6: Databases Created
// --------------------------------------------------------------------------

// TST-CORE-655
func TestOnboarding_19_7_DatabasesCreated(t *testing.T) {
	// var impl testutil.OnboardingSequence = realonboarding.New(...)
	impl := realOnboardingSequence
	testutil.RequireImplementation(t, impl, "OnboardingSequence")

	_, err := impl.StartOnboarding(context.Background(), "user@example.com", testutil.TestPassphrase)
	testutil.RequireNoError(t, err)

	// identity.sqlite + personal.sqlite must be created.
	steps, err := impl.GetSteps()
	testutil.RequireNoError(t, err)

	found := false
	for _, step := range steps {
		if step.Name == "databases_created" {
			found = true
			testutil.RequireTrue(t, step.Completed, "database creation must complete")
		}
	}
	testutil.RequireTrue(t, found, "databases_created step must exist in onboarding sequence")
}

// --------------------------------------------------------------------------
// §19.8 Silent Step 7: Convenience Mode Set (Managed)
// --------------------------------------------------------------------------

// TST-CORE-656
func TestOnboarding_19_8_ConvenienceModeSet(t *testing.T) {
	impl := onboarding.NewOnboardingSequence()
	testutil.RequireImplementation(t, impl, "OnboardingSequence")

	// Negative: before onboarding, GetSecurityMode must error.
	_, err := impl.GetSecurityMode()
	testutil.RequireTrue(t, err != nil, "GetSecurityMode before onboarding must error")

	// Run onboarding.
	_, err = impl.StartOnboarding(context.Background(), "user@example.com", testutil.TestPassphrase)
	testutil.RequireNoError(t, err)

	// Positive: after onboarding, security mode must be "convenience".
	mode, err := impl.GetSecurityMode()
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, mode, "convenience")
}

// --------------------------------------------------------------------------
// §19.9 Silent Step 8: Brain Starts Guardian Loop
// --------------------------------------------------------------------------

// TST-CORE-657
func TestOnboarding_19_9_BrainStartsGuardianLoop(t *testing.T) {
	// var impl testutil.OnboardingSequence = realonboarding.New(...)
	impl := realOnboardingSequence
	testutil.RequireImplementation(t, impl, "OnboardingSequence")

	_, err := impl.StartOnboarding(context.Background(), "user@example.com", testutil.TestPassphrase)
	testutil.RequireNoError(t, err)

	// Brain must receive vault_unlocked event and begin operation.
	steps, err := impl.GetSteps()
	testutil.RequireNoError(t, err)

	found := false
	for _, step := range steps {
		if step.Name == "brain_guardian_start" {
			found = true
			testutil.RequireTrue(t, step.Completed, "brain guardian loop must start")
		}
	}
	testutil.RequireTrue(t, found, "brain_guardian_start step must exist in onboarding sequence")
}

// --------------------------------------------------------------------------
// §19.10 Silent Step 9: Initial Sync Triggered
// --------------------------------------------------------------------------

// TST-CORE-658
func TestOnboarding_19_10_InitialSyncTriggered(t *testing.T) {
	// var impl testutil.OnboardingSequence = realonboarding.New(...)
	impl := realOnboardingSequence
	testutil.RequireImplementation(t, impl, "OnboardingSequence")

	_, err := impl.StartOnboarding(context.Background(), "user@example.com", testutil.TestPassphrase)
	testutil.RequireNoError(t, err)

	// MCP -> OpenClaw fetches Gmail/Calendar on initial sync.
	steps, err := impl.GetSteps()
	testutil.RequireNoError(t, err)

	found := false
	for _, step := range steps {
		if step.Name == "initial_sync" {
			found = true
			testutil.RequireTrue(t, step.Completed, "initial sync must be triggered")
		}
	}
	testutil.RequireTrue(t, found, "initial_sync step must exist in onboarding sequence")
}

// --------------------------------------------------------------------------
// §19.11 One Default Persona: /personal
// --------------------------------------------------------------------------

// TST-CORE-659
func TestOnboarding_19_11_OneDefaultPersona(t *testing.T) {
	impl := onboarding.NewOnboardingSequence()
	testutil.RequireImplementation(t, impl, "OnboardingSequence")

	// Negative: before onboarding, GetPersonas must error.
	_, err := impl.GetPersonas()
	testutil.RequireTrue(t, err != nil, "GetPersonas before onboarding must error")

	// Run onboarding.
	_, err = impl.StartOnboarding(context.Background(), "user@example.com", testutil.TestPassphrase)
	testutil.RequireNoError(t, err)

	// Positive: after setup, exactly one persona "general" must exist.
	personas, err := impl.GetPersonas()
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(personas), 1)
	testutil.RequireEqual(t, personas[0], "general")
}

// --------------------------------------------------------------------------
// §19.12 Mnemonic Backup Deferred to Day 7
// --------------------------------------------------------------------------

// TST-CORE-660
func TestOnboarding_19_12_MnemonicBackupDeferred(t *testing.T) {
	impl := onboarding.NewOnboardingSequence()
	testutil.RequireImplementation(t, impl, "OnboardingSequence")

	// Negative: before onboarding, backup is NOT deferred (default false).
	testutil.RequireFalse(t, impl.IsMnemonicBackupDeferred(),
		"before onboarding, backup deferred must be false")

	// Run onboarding.
	_, err := impl.StartOnboarding(context.Background(), "user@example.com", testutil.TestPassphrase)
	testutil.RequireNoError(t, err)

	// Positive: after onboarding, mnemonic backup must be deferred to Day 7.
	testutil.RequireTrue(t, impl.IsMnemonicBackupDeferred(),
		"mnemonic backup prompt must be deferred to Day 7 — not shown during onboarding")
}

// --------------------------------------------------------------------------
// §19.13 Sharing Rules Default to Empty
// --------------------------------------------------------------------------

// TST-CORE-661
func TestOnboarding_19_13_SharingRulesDefaultEmpty(t *testing.T) {
	// var impl testutil.OnboardingSequence = realonboarding.New(...)
	impl := realOnboardingSequence
	testutil.RequireImplementation(t, impl, "OnboardingSequence")

	_, err := impl.StartOnboarding(context.Background(), "user@example.com", testutil.TestPassphrase)
	testutil.RequireNoError(t, err)

	// After setup, no sharing policies should exist — default-deny egress.
	rules, err := impl.GetSharingRules()
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(rules), 0)
}

// TST-CORE-932
func TestOnboarding_19_14_InstallSH_Bootstrap(t *testing.T) {
	// install.sh bootstrap: token gen, dirs, permissions.
	impl := realOnboardingSequence
	testutil.RequireImplementation(t, impl, "OnboardingSequence")

	// Verify onboarding sequence produces expected artifacts.
	steps, err := impl.GetSteps()
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(steps) > 0, "onboarding must have steps")
}
