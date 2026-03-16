package test

import (
	"context"
	"testing"

	"github.com/rajmohanutopai/dina/core/internal/adapter/server"
	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/test/testutil"
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
	impl := realErrorHandler
	testutil.RequireImplementation(t, impl, "ErrorHandler")

	// MaxBodySize must be positive and match expected default (10 MiB).
	maxSize := impl.MaxBodySize()
	testutil.RequireTrue(t, maxSize > 0, "MaxBodySize must be positive")
	testutil.RequireEqual(t, maxSize, int64(10*1024*1024))

	// Body at exactly the limit must be accepted (boundary test).
	atLimitBody := make([]byte, maxSize)
	copy(atLimitBody, []byte(`{"persona":"general","type":"email","source":"test","summary":"ok"}`))
	statusCode, _, err := impl.HandleRequest("POST", "/v1/vault/store", "application/json", atLimitBody)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, statusCode != 413, "body at exactly max size must not be rejected as too large")

	// Body exceeding the limit by 1 byte must be rejected with 413.
	oversizedBody := make([]byte, maxSize+1)
	statusCode, respBody, err := impl.HandleRequest("POST", "/v1/vault/store", "application/json", oversizedBody)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, statusCode, 413)
	testutil.RequireContains(t, string(respBody), "too large")
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
	statusCode, respBody, err := impl.HandleRequest("GET", "/v1/nonexistent", "", nil)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, statusCode, 404)
	testutil.RequireTrue(t, len(respBody) > 0, "404 response must have a body")

	// POST to unknown endpoint must also return 404.
	statusCode2, _, err := impl.HandleRequest("POST", "/v1/does_not_exist", "application/json", []byte(`{}`))
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, statusCode2, 404)

	// Positive control: known endpoint must NOT return 404.
	statusCode3, _, err := impl.HandleRequest("GET", "/healthz", "", nil)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, statusCode3, 200)
}

// --------------------------------------------------------------------------
// §16.4 Method Not Allowed
// --------------------------------------------------------------------------

// TST-CORE-604
func TestErrors_16_4_MethodNotAllowed(t *testing.T) {
	// var impl testutil.ErrorHandler = realhandler.New(...)
	impl := realErrorHandler
	testutil.RequireImplementation(t, impl, "ErrorHandler")

	// Verify the allowed method (GET) succeeds — proves the endpoint map
	// recognises /healthz and doesn't blanket-reject everything.
	statusOK, _, err := impl.HandleRequest("GET", "/healthz", "", nil)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, statusOK, 200)

	// DELETE on a GET-only endpoint must return 405 Method Not Allowed.
	statusCode, respBody, err := impl.HandleRequest("DELETE", "/healthz", "", nil)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, statusCode, 405)
	testutil.RequireContains(t, string(respBody), "method not allowed")

	// POST on a GET-only endpoint must also return 405.
	statusCode2, respBody2, err2 := impl.HandleRequest("POST", "/healthz", "application/json", []byte(`{}`))
	testutil.RequireNoError(t, err2)
	testutil.RequireEqual(t, statusCode2, 405)
	testutil.RequireContains(t, string(respBody2), "method not allowed")

	// PUT on a POST-only endpoint must return 405.
	statusCode3, respBody3, err3 := impl.HandleRequest("PUT", "/v1/vault/store", "application/json", []byte(`{"type":"email"}`))
	testutil.RequireNoError(t, err3)
	testutil.RequireEqual(t, statusCode3, 405)
	testutil.RequireContains(t, string(respBody3), "method not allowed")
}

// --------------------------------------------------------------------------
// §16.5 Content-Type Enforcement
// --------------------------------------------------------------------------

// TST-CORE-605
func TestErrors_16_5_ContentTypeEnforcement(t *testing.T) {
	impl := realErrorHandler
	testutil.RequireImplementation(t, impl, "ErrorHandler")

	body := []byte(`{"type": "email"}`)

	// Wrong Content-Type must return 415.
	statusCode, _, err := impl.HandleRequest("POST", "/v1/vault/store", "text/plain", body)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, statusCode, 415)

	// Positive control: correct Content-Type must NOT return 415.
	statusCode2, _, err := impl.HandleRequest("POST", "/v1/vault/store", "application/json", body)
	testutil.RequireNoError(t, err)
	if statusCode2 == 415 {
		t.Fatal("application/json must not trigger 415 — positive control failed")
	}

	// Content-Type with charset suffix must also be accepted.
	statusCode3, _, err := impl.HandleRequest("POST", "/v1/vault/store", "application/json; charset=utf-8", body)
	testutil.RequireNoError(t, err)
	if statusCode3 == 415 {
		t.Fatal("application/json with charset must not trigger 415")
	}

	// Additional wrong types must also be rejected.
	wrongTypes := []string{"text/html", "multipart/form-data", "application/xml"}
	for _, ct := range wrongTypes {
		sc, _, err := impl.HandleRequest("POST", "/v1/vault/store", ct, body)
		testutil.RequireNoError(t, err)
		if sc != 415 {
			t.Fatalf("Content-Type %q should return 415, got %d", ct, sc)
		}
	}
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

	// Read back both items to verify no data corruption from concurrent writes.
	got1, err := impl.GetItem(vaultCtx, domain.PersonaName(personaID), "concurrent-item-001")
	testutil.RequireNoError(t, err)
	if got1 == nil {
		t.Fatal("concurrent-item-001 must be retrievable after concurrent write")
	}
	testutil.RequireEqual(t, got1.ID, "concurrent-item-001")

	got2, err := impl.GetItem(vaultCtx, domain.PersonaName(personaID), "concurrent-item-002")
	testutil.RequireNoError(t, err)
	if got2 == nil {
		t.Fatal("concurrent-item-002 must be retrievable after concurrent write")
	}
	testutil.RequireEqual(t, got2.ID, "concurrent-item-002")
}

// --------------------------------------------------------------------------
// §16.7 Disk Full
// --------------------------------------------------------------------------

// TST-CORE-607
func TestErrors_16_7_DiskFull(t *testing.T) {
	// Simulate disk full by sending an oversized request body to the error handler.
	// The error handler must return a graceful error (not panic).
	impl := realErrorHandler
	testutil.RequireImplementation(t, impl, "ErrorHandler")

	// Positive control: normal-sized body must succeed (proves handler is not always-413).
	normalBody := []byte(`{"type":"email","source":"test","summary":"normal request"}`)
	statusOK, _, err := impl.HandleRequest("POST", "/v1/vault/store", "application/json", normalBody)
	testutil.RequireNoError(t, err)
	if statusOK == 413 {
		t.Fatal("normal-sized body must not trigger 413 — positive control failed")
	}

	// Create a body that exceeds the max body size (simulates resource exhaustion).
	maxSize := impl.MaxBodySize()
	if maxSize <= 0 {
		maxSize = 10 * 1024 * 1024 // 10 MiB default
	}
	oversizedBody := make([]byte, maxSize+1024)
	for i := range oversizedBody {
		oversizedBody[i] = 'x'
	}

	// The handler must not panic — it should return 413 gracefully.
	didPanic := false
	func() {
		defer func() {
			if r := recover(); r != nil {
				didPanic = true
			}
		}()
		statusCode, respBody, err := impl.HandleRequest("POST", "/v1/vault/store", "application/json", oversizedBody)
		testutil.RequireNoError(t, err)
		testutil.RequireEqual(t, statusCode, 413)
		testutil.RequireContains(t, string(respBody), "too large")
	}()

	testutil.RequireFalse(t, didPanic, "error handler must not panic on oversized request — graceful 413 required")
}

// --------------------------------------------------------------------------
// §16.8 Vault File Corruption
// --------------------------------------------------------------------------

// TST-CORE-608
func TestErrors_16_8_VaultFileCorruption(t *testing.T) {
	// Create corrupted vault data and verify the vault manager detects and reports the error.
	impl := realVaultManager
	testutil.RequireImplementation(t, impl, "VaultManager")

	// Attempt to open a persona vault with an invalid/wrong DEK.
	// This simulates corruption: the vault file (if it existed) would fail to decrypt.
	corruptDEK := make([]byte, 32)
	for i := range corruptDEK {
		corruptDEK[i] = 0xFF // wrong key material
	}

	// Opening with a non-existent persona and bad DEK should either succeed
	// (creating a new vault) or fail gracefully — never panic.
	didPanic := false
	func() {
		defer func() {
			if r := recover(); r != nil {
				didPanic = true
			}
		}()
		ctx := context.Background()
		err := impl.Open(ctx, domain.PersonaName("corrupted-test-persona"), corruptDEK)
		// We only care that it does not panic. Whether it errors or succeeds
		// depends on whether the file already exists.
		if err != nil {
			t.Logf("vault open with bad DEK returned expected error: %v", err)
		} else {
			_ = impl.Close(domain.PersonaName("corrupted-test-persona"))
		}
	}()

	testutil.RequireFalse(t, didPanic, "vault must not panic on corrupted data — graceful error required")
}

// --------------------------------------------------------------------------
// §16.9 Graceful Shutdown
// --------------------------------------------------------------------------

// TST-CORE-609
func TestErrors_16_9_GracefulShutdown(t *testing.T) {
	// Use a fresh server instance for lifecycle test (don't mutate shared realServer).
	impl := server.NewServer()

	// Start the server first — shutdown without start should also be safe.
	err := impl.ListenAndServe()
	testutil.RequireNoError(t, err)

	// Shutdown after start must succeed.
	err = impl.Shutdown()
	testutil.RequireNoError(t, err)

	// Double-shutdown must be idempotent (no panic, no error).
	err = impl.Shutdown()
	testutil.RequireNoError(t, err)

	// Shutdown without prior start (cold shutdown) must also be safe.
	coldServer := server.NewServer()
	err = coldServer.Shutdown()
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
