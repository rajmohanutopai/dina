package transport_test

import (
	"github.com/rajmohanutopai/dina/core/internal/adapter/transport"
	"github.com/rajmohanutopai/dina/core/test/testutil"
)

// Compile-time interface compliance checks.
// These assertions verify that our adapter types satisfy the testutil contracts.
var (
	_ testutil.Transporter   = (*transport.Transporter)(nil)
	_ testutil.OutboxManager = (*transport.OutboxManager)(nil)
	_ testutil.InboxManager  = (*transport.InboxManager)(nil)
	_ testutil.DIDResolver   = (*transport.DIDResolver)(nil)
)
