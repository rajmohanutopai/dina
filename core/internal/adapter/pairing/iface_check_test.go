package pairing_test

import (
	"github.com/anthropics/dina/core/internal/adapter/pairing"
	"github.com/anthropics/dina/core/test/testutil"
)

// Compile-time interface compliance checks.
// These assertions verify that our adapter types satisfy the testutil contracts.
var _ testutil.PairingManager = (*pairing.PairingManager)(nil)
