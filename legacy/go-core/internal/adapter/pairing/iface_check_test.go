package pairing_test

import (
	"github.com/rajmohanutopai/dina/core/internal/adapter/pairing"
	"github.com/rajmohanutopai/dina/core/test/testutil"
)

// Compile-time interface compliance checks.
// These assertions verify that our adapter types satisfy the testutil contracts.
var _ testutil.PairingManager = (*pairing.PairingManager)(nil)
