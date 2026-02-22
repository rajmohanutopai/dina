package ws_test

import (
	"github.com/anthropics/dina/core/internal/adapter/ws"
	"github.com/anthropics/dina/core/test/testutil"
)

// Compile-time interface compliance checks.
// These assertions verify that our adapter types satisfy the testutil contracts.
var (
	_ testutil.WSHub            = (*ws.WSHub)(nil)
	_ testutil.WSHandler        = (*ws.WSHandler)(nil)
	_ testutil.HeartbeatManager = (*ws.HeartbeatManager)(nil)
	_ testutil.MessageBuffer    = (*ws.MessageBuffer)(nil)
)
