package test

import (
	"context"
	"testing"

	"github.com/anthropics/dina/core/test/testutil"
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
	// var impl testutil.OnboardingSequence = realonboarding.New(...)
	impl := realOnboardingSequence
	testutil.RequireImplementation(t, impl, "OnboardingSequence")

	// User enters email + passphrase. Full silent setup completes,
	// Dina starts ingesting.
	mnemonic, err := impl.StartOnboarding(context.Background(), "user@example.com", testutil.TestPassphrase)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(mnemonic) > 0, "mnemonic must be generated")
}

// --------------------------------------------------------------------------
// §19.2 Silent Step 1: BIP-39 Mnemonic Generated
// --------------------------------------------------------------------------

// TST-CORE-650
func TestOnboarding_19_2_MnemonicGenerated(t *testing.T) {
	// var impl testutil.OnboardingSequence = realonboarding.New(...)
	impl := realOnboardingSequence
	testutil.RequireImplementation(t, impl, "OnboardingSequence")

	_, err := impl.StartOnboarding(context.Background(), "user@example.com", testutil.TestPassphrase)
	testutil.RequireNoError(t, err)

	// 24-word mnemonic, 512-bit master seed.
	mnemonic, err := impl.GetMnemonic()
	testutil.RequireNoError(t, err)

	// Count words in mnemonic.
	wordCount := 1
	for i := 0; i < len(mnemonic); i++ {
		if mnemonic[i] == ' ' {
			wordCount++
		}
	}
	testutil.RequireEqual(t, wordCount, 24)
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

	// SLIP-0010 m/9999'/0' -> root keypair. The DID should be derivable.
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

	_, err := impl.StartOnboarding(context.Background(), "user@example.com", testutil.TestPassphrase)
	testutil.RequireNoError(t, err)

	// Root DID must be registered with plc.directory.
	rootDID, err := impl.GetRootDID()
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(rootDID) > 0, "root DID must be set after onboarding")
	// DID should start with "did:" prefix.
	testutil.RequireHasPrefix(t, rootDID, "did:")
}

// --------------------------------------------------------------------------
// §19.5 Silent Step 4: Per-Database DEKs Derived
// --------------------------------------------------------------------------

// TST-CORE-653
func TestOnboarding_19_5_DEKsDerived(t *testing.T) {
	// var impl testutil.OnboardingSequence = realonboarding.New(...)
	impl := realOnboardingSequence
	testutil.RequireImplementation(t, impl, "OnboardingSequence")

	_, err := impl.StartOnboarding(context.Background(), "user@example.com", testutil.TestPassphrase)
	testutil.RequireNoError(t, err)

	// HKDF with persona-specific info strings must produce per-database DEKs.
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
}

// --------------------------------------------------------------------------
// §19.6 Silent Step 5: Password Wraps Master Seed
// --------------------------------------------------------------------------

// TST-CORE-654
func TestOnboarding_19_6_PasswordWrapsMasterSeed(t *testing.T) {
	// var impl testutil.OnboardingSequence = realonboarding.New(...)
	impl := realOnboardingSequence
	testutil.RequireImplementation(t, impl, "OnboardingSequence")

	_, err := impl.StartOnboarding(context.Background(), "user@example.com", testutil.TestPassphrase)
	testutil.RequireNoError(t, err)

	// Argon2id -> KEK -> AES-256-GCM wrap (key wrapping, not derivation).
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
	// var impl testutil.OnboardingSequence = realonboarding.New(...)
	impl := realOnboardingSequence
	testutil.RequireImplementation(t, impl, "OnboardingSequence")

	_, err := impl.StartOnboarding(context.Background(), "user@example.com", testutil.TestPassphrase)
	testutil.RequireNoError(t, err)

	// Managed hosting: master seed written to keyfile, chmod 600.
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
	// var impl testutil.OnboardingSequence = realonboarding.New(...)
	impl := realOnboardingSequence
	testutil.RequireImplementation(t, impl, "OnboardingSequence")

	_, err := impl.StartOnboarding(context.Background(), "user@example.com", testutil.TestPassphrase)
	testutil.RequireNoError(t, err)

	// After setup, only /personal persona should exist.
	// No /health, /financial, /citizen at this stage.
	personas, err := impl.GetPersonas()
	testutil.RequireNoError(t, err)
	testutil.RequireLen(t, len(personas), 1)

	// The single persona should be "personal".
	found := false
	for _, p := range personas {
		if p == "personal" || p == "/personal" || p == "persona-personal" {
			found = true
		}
	}
	testutil.RequireTrue(t, found, "only /personal persona must exist after onboarding")
}

// --------------------------------------------------------------------------
// §19.12 Mnemonic Backup Deferred to Day 7
// --------------------------------------------------------------------------

// TST-CORE-660
func TestOnboarding_19_12_MnemonicBackupDeferred(t *testing.T) {
	// var impl testutil.OnboardingSequence = realonboarding.New(...)
	impl := realOnboardingSequence
	testutil.RequireImplementation(t, impl, "OnboardingSequence")

	_, err := impl.StartOnboarding(context.Background(), "user@example.com", testutil.TestPassphrase)
	testutil.RequireNoError(t, err)

	// Mnemonic backup must be deferred to Day 7 after setup.
	// "Write down these 24 words" is NOT shown during onboarding.
	deferred := impl.IsMnemonicBackupDeferred()
	testutil.RequireTrue(t, deferred,
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
