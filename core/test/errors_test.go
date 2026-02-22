package test

import (
	"context"
	"testing"

	"github.com/anthropics/dina/core/internal/domain"
	"github.com/anthropics/dina/core/test/testutil"
)

// ==========================================================================
// TEST_PLAN §16 — Error Handling & Edge Cases
// ==========================================================================
// Covers malformed input, oversized payloads, unknown endpoints, wrong HTTP
// methods, content-type enforcement, concurrent writes, disk-full scenarios,
// vault corruption, graceful shutdown, and panic recovery.
//
// Every test calls testutil.RequireImplementation to skip until the real
// implementation is wired in.
// ==========================================================================

// --------------------------------------------------------------------------
// §16.1 Malformed JSON Body
// --------------------------------------------------------------------------

// TST-CORE-601
func TestErrors_16_1_MalformedJSON(t *testing.T) {
	// var impl testutil.ErrorHandler = realhandler.New(...)
	impl := realErrorHandler
	testutil.RequireImplementation(t, impl, "ErrorHandler")

	// Send an invalid JSON body. Expect 400 Bad Request with parse error.
	body := []byte(`{invalid json`)
	statusCode, respBody, err := impl.HandleRequest("POST", "/v1/vault/store", "application/json", body)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, statusCode, 400)
	testutil.RequireContains(t, string(respBody), "parse")
}

// --------------------------------------------------------------------------
// §16.2 Request Body Too Large
// --------------------------------------------------------------------------

// TST-CORE-602
func TestErrors_16_2_RequestBodyTooLarge(t *testing.T) {
	// var impl testutil.ErrorHandler = realhandler.New(...)
	impl := realErrorHandler
	testutil.RequireImplementation(t, impl, "ErrorHandler")

	// Body exceeding 10 MiB must be rejected with 413 Payload Too Large.
	maxSize := impl.MaxBodySize()
	if maxSize <= 0 {
		maxSize = 10 * 1024 * 1024 // 10 MiB default
	}
	oversizedBody := make([]byte, maxSize+1)
	for i := range oversizedBody {
		oversizedBody[i] = 'x'
	}

	statusCode, _, err := impl.HandleRequest("POST", "/v1/vault/store", "application/json", oversizedBody)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, statusCode, 413)
}

// --------------------------------------------------------------------------
// §16.3 Unknown Endpoint
// --------------------------------------------------------------------------

// TST-CORE-603
func TestErrors_16_3_UnknownEndpoint(t *testing.T) {
	// var impl testutil.ErrorHandler = realhandler.New(...)
	impl := realErrorHandler
	testutil.RequireImplementation(t, impl, "ErrorHandler")

	// GET /v1/nonexistent must return 404 Not Found.
	statusCode, _, err := impl.HandleRequest("GET", "/v1/nonexistent", "", nil)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, statusCode, 404)
}

// --------------------------------------------------------------------------
// §16.4 Method Not Allowed
// --------------------------------------------------------------------------

// TST-CORE-604
func TestErrors_16_4_MethodNotAllowed(t *testing.T) {
	// var impl testutil.ErrorHandler = realhandler.New(...)
	impl := realErrorHandler
	testutil.RequireImplementation(t, impl, "ErrorHandler")

	// DELETE on a GET-only endpoint must return 405 Method Not Allowed.
	statusCode, _, err := impl.HandleRequest("DELETE", "/healthz", "", nil)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, statusCode, 405)
}

// --------------------------------------------------------------------------
// §16.5 Content-Type Enforcement
// --------------------------------------------------------------------------

// TST-CORE-605
func TestErrors_16_5_ContentTypeEnforcement(t *testing.T) {
	// var impl testutil.ErrorHandler = realhandler.New(...)
	impl := realErrorHandler
	testutil.RequireImplementation(t, impl, "ErrorHandler")

	// POST without Content-Type: application/json must return 415.
	body := []byte(`{"type": "email"}`)
	statusCode, _, err := impl.HandleRequest("POST", "/v1/vault/store", "text/plain", body)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, statusCode, 415)
}

// --------------------------------------------------------------------------
// §16.6 Concurrent Vault Writes
// --------------------------------------------------------------------------

// TST-CORE-606
func TestErrors_16_6_ConcurrentVaultWrites(t *testing.T) {
	// var impl testutil.VaultManager = realvault.New(...)
	impl := realVaultManager
	testutil.RequireImplementation(t, impl, "VaultManager")

	// Two simultaneous writes to the same persona vault must both succeed
	// (WAL mode) or one retries gracefully — no corruption.
	vaultCtx := context.Background()
	personaID := "persona-concurrent-test"
	dek := testutil.TestDEK[:]
	err := impl.Open(vaultCtx, domain.PersonaName(personaID), dek)
	testutil.RequireNoError(t, err)
	defer func() {
		_ = impl.Close(domain.PersonaName(personaID))
	}()

	item1 := testutil.TestVaultItem()
	item1.ID = "concurrent-item-001"
	item2 := testutil.TestVaultItem()
	item2.ID = "concurrent-item-002"

	errCh := make(chan error, 2)
	go func() {
		_, err := impl.Store(vaultCtx, domain.PersonaName(personaID), item1)
		errCh <- err
	}()
	go func() {
		_, err := impl.Store(vaultCtx, domain.PersonaName(personaID), item2)
		errCh <- err
	}()

	err1 := <-errCh
	err2 := <-errCh
	// Both must succeed or at least not return corruption errors.
	testutil.RequireNoError(t, err1)
	testutil.RequireNoError(t, err2)
}

// --------------------------------------------------------------------------
// §16.7 Disk Full
// --------------------------------------------------------------------------

// TST-CORE-607
func TestErrors_16_7_DiskFull(t *testing.T) {
	t.Skip("disk-full simulation requires OS-level mocking or a full tmpfs — integration test")
	// Vault write when disk is full must return a graceful error with no corruption.
	// This test would mount a tiny tmpfs, fill it, and attempt a vault write.
}

// --------------------------------------------------------------------------
// §16.8 Vault File Corruption
// --------------------------------------------------------------------------

// TST-CORE-608
func TestErrors_16_8_VaultFileCorruption(t *testing.T) {
	t.Skip("vault corruption detection requires writing a truncated SQLCipher file — integration test")
	// A truncated or corrupted SQLCipher file must be detected on open, and
	// the error must be reported cleanly without panics.
}

// --------------------------------------------------------------------------
// §16.9 Graceful Shutdown
// --------------------------------------------------------------------------

// TST-CORE-609
func TestErrors_16_9_GracefulShutdown(t *testing.T) {
	// var impl testutil.Server = realserver.New(...)
	impl := realServer
	testutil.RequireImplementation(t, impl, "Server")

	// SIGTERM received: in-flight requests must complete, outbox flushed,
	// connections closed. Shutdown() must return without error.
	err := impl.Shutdown()
	testutil.RequireNoError(t, err)
}

// --------------------------------------------------------------------------
// §16.10 Panic Recovery
// --------------------------------------------------------------------------

// TST-CORE-610
func TestErrors_16_10_PanicRecovery(t *testing.T) {
	// var impl testutil.ErrorHandler = realhandler.New(...)
	impl := realErrorHandler
	testutil.RequireImplementation(t, impl, "ErrorHandler")

	// If a goroutine panics, the middleware must recover and return 500,
	// not crash the server process.
	recovers := impl.RecoverFromPanic()
	testutil.RequireTrue(t, recovers, "server must recover from handler panics via middleware")
}
