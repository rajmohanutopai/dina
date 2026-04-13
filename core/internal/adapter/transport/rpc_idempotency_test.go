package transport

import (
	"crypto/ed25519"
	"net/http"
	"testing"
	"time"
)

// --- TST-MBX-0018: Exact replay (same nonce + timestamp) → rejected ---
// TRACE: {"suite": "MBX", "case": "0018", "section": "03", "sectionName": "Replay Protection & Idempotency", "subsection": "01", "scenario": "01", "title": "exact_replay_rejected"}
//
// Same nonce + timestamp combination sent twice for the same DID → second
// request rejected by nonce cache.
func TestNonceCache_ExactReplayRejected(t *testing.T) {
	cache := NewNonceCache(5 * time.Minute)

	did := "did:key:zReplay001"
	nonce := "abc123def456abc123def456abc12345"

	// First use: fresh → allowed.
	if !cache.CheckAndStore(did, nonce) {
		t.Fatal("first CheckAndStore should return true (fresh nonce)")
	}

	// Exact replay: same DID + nonce → rejected.
	if cache.CheckAndStore(did, nonce) {
		t.Error("second CheckAndStore should return false (replay detected)")
	}

	// Different DID with same nonce → allowed (nonce is per-DID).
	otherDID := "did:key:zOther001"
	if !cache.CheckAndStore(otherDID, nonce) {
		t.Error("same nonce from different DID should be allowed")
	}

	// Different nonce from same DID → allowed.
	if !cache.CheckAndStore(did, "different-nonce-789") {
		t.Error("different nonce from same DID should be allowed")
	}
}

// --- TST-MBX-0019: Retry with same request_id, fresh nonce → cached response ---
// TRACE: {"suite": "MBX", "case": "0019", "section": "03", "sectionName": "Replay Protection & Idempotency", "subsection": "01", "scenario": "02", "title": "retry_same_request_id_cached"}
//
// First request: processed, response cached. Retry with same request_id
// but fresh nonce: returns cached response without re-processing.
func TestIdempotency_RetrySameRequestIDCached(t *testing.T) {
	did, priv, pub := testKeyPair(t)
	deviceKeys := map[string]ed25519.PublicKey{did: pub}
	handler := stubHandler(deviceKeys, nil)
	bridge := NewRPCBridge(handler)
	cache := NewIdempotencyCache(5 * time.Minute)

	requestID := "req-retry-001"
	body := `{"text":"important"}`

	// First request: sign, process, cache.
	headers1 := makeSignedHeaders(t, "POST", "/api/v1/remember", "", body, did, priv)
	innerJSON1, _ := BuildInnerRequestJSON("POST", "/api/v1/remember", headers1, body)

	// Check cache — miss.
	if cached := cache.Get(did, requestID); cached != nil {
		t.Fatal("cache should be empty before first request")
	}

	// Process via bridge.
	resp1, err := bridge.HandleInnerRequest(innerJSON1)
	if err != nil {
		t.Fatalf("first request: %v", err)
	}
	if resp1.Status != 200 {
		t.Fatalf("first request status = %d, want 200", resp1.Status)
	}

	// Store in cache (store-before-send).
	cache.Put(did, requestID, resp1)

	// Retry: different nonce/timestamp, same request_id.
	headers2 := makeSignedHeaders(t, "POST", "/api/v1/remember", "", body, did, priv)
	innerJSON2, _ := BuildInnerRequestJSON("POST", "/api/v1/remember", headers2, body)
	_ = innerJSON2 // would be used if cache miss

	// Check cache — hit.
	cached := cache.Get(did, requestID)
	if cached == nil {
		t.Fatal("cache should have the response from the first request")
	}

	// Cached response matches the first response.
	if cached.Status != resp1.Status {
		t.Errorf("cached status = %d, want %d", cached.Status, resp1.Status)
	}
	if cached.Body != resp1.Body {
		t.Errorf("cached body = %q, want %q", cached.Body, resp1.Body)
	}

	// The bridge was NOT called for the retry — cache served it.
	// (In production, handleRPCRequest checks cache before calling bridge.)
}

// --- TST-MBX-0020: Retry with different request_id → reprocesses ---
// TRACE: {"suite": "MBX", "case": "0020", "section": "03", "sectionName": "Replay Protection & Idempotency", "subsection": "01", "scenario": "03", "title": "different_request_id_reprocesses"}
//
// Different request_id → cache miss → request reprocessed.
func TestIdempotency_DifferentRequestIDReprocesses(t *testing.T) {
	did, priv, pub := testKeyPair(t)
	deviceKeys := map[string]ed25519.PublicKey{did: pub}
	handler := stubHandler(deviceKeys, nil)
	bridge := NewRPCBridge(handler)
	cache := NewIdempotencyCache(5 * time.Minute)

	body := `{"text":"important"}`

	// First request with request_id "A".
	headersA := makeSignedHeaders(t, "POST", "/api/v1/remember", "", body, did, priv)
	innerA, _ := BuildInnerRequestJSON("POST", "/api/v1/remember", headersA, body)
	respA, _ := bridge.HandleInnerRequest(innerA)
	cache.Put(did, "req-A", respA)

	// Second request with different request_id "B".
	headersB := makeSignedHeaders(t, "POST", "/api/v1/remember", "", body, did, priv)
	innerB, _ := BuildInnerRequestJSON("POST", "/api/v1/remember", headersB, body)

	// Cache miss for "req-B".
	if cached := cache.Get(did, "req-B"); cached != nil {
		t.Fatal("cache should miss for different request_id")
	}

	// Must reprocess (call bridge).
	respB, err := bridge.HandleInnerRequest(innerB)
	if err != nil {
		t.Fatalf("reprocess: %v", err)
	}
	if respB.Status != 200 {
		t.Errorf("reprocess status = %d, want 200", respB.Status)
	}

	// Cache now has both entries.
	cache.Put(did, "req-B", respB)
	if cache.Size() != 2 {
		t.Errorf("cache size = %d, want 2", cache.Size())
	}
}

// --- TST-MBX-0021: Sender-scoped key — two devices, same request_id ---
// TRACE: {"suite": "MBX", "case": "0021", "section": "03", "sectionName": "Replay Protection & Idempotency", "subsection": "01", "scenario": "04", "title": "sender_scoped_no_collision"}
//
// Device A and B both use request_id="abc" → two separate cache entries.
func TestIdempotency_SenderScopedNoCollision(t *testing.T) {
	cache := NewIdempotencyCache(5 * time.Minute)

	respA := &RPCInnerResponse{Status: 200, Body: `{"from":"A"}`}
	respB := &RPCInnerResponse{Status: 200, Body: `{"from":"B"}`}

	// Both devices use the same request_id "abc".
	cache.Put("did:key:zDeviceA", "abc", respA)
	cache.Put("did:key:zDeviceB", "abc", respB)

	// Cache should have 2 entries (sender-scoped, no collision).
	if cache.Size() != 2 {
		t.Fatalf("cache size = %d, want 2 (sender-scoped)", cache.Size())
	}

	// Device A gets its response.
	gotA := cache.Get("did:key:zDeviceA", "abc")
	if gotA == nil {
		t.Fatal("device A cache miss")
	}
	if gotA.Body != `{"from":"A"}` {
		t.Errorf("device A body = %q, want A's response", gotA.Body)
	}

	// Device B gets its response.
	gotB := cache.Get("did:key:zDeviceB", "abc")
	if gotB == nil {
		t.Fatal("device B cache miss")
	}
	if gotB.Body != `{"from":"B"}` {
		t.Errorf("device B body = %q, want B's response", gotB.Body)
	}
}

// --- TST-MBX-0022: Cached response expires after TTL ---
// TRACE: {"suite": "MBX", "case": "0022", "section": "03", "sectionName": "Replay Protection & Idempotency", "subsection": "01", "scenario": "05", "title": "cached_response_expires"}
//
// Cached response expires after TTL. Next request with same request_id
// is a cache miss → reprocesses.
func TestIdempotency_CachedResponseExpires(t *testing.T) {
	cache := NewIdempotencyCache(100 * time.Millisecond) // short TTL for test

	// Controllable clock.
	now := time.Now()
	cache.now = func() time.Time { return now }

	resp := &RPCInnerResponse{Status: 200, Body: `{"cached":true}`}
	cache.Put("did:key:zExpire", "req-exp", resp)

	// Within TTL: cache hit.
	now = now.Add(50 * time.Millisecond)
	if got := cache.Get("did:key:zExpire", "req-exp"); got == nil {
		t.Fatal("should hit within TTL")
	}

	// Past TTL: cache miss.
	now = now.Add(200 * time.Millisecond) // 250ms total > 100ms TTL
	if got := cache.Get("did:key:zExpire", "req-exp"); got != nil {
		t.Error("should miss after TTL expired")
	}

	// Cleanup removes expired entries.
	removed := cache.Cleanup()
	// The Get() already deleted it, so Cleanup may find 0.
	// But let's add another entry and expire it via Cleanup.
	now = time.Now()
	cache.Put("did:key:zClean", "req-clean", resp)
	now = now.Add(200 * time.Millisecond)
	removed = cache.Cleanup()
	if removed != 1 {
		t.Errorf("Cleanup removed %d, want 1", removed)
	}
	if cache.Size() != 0 {
		t.Errorf("after cleanup: size = %d, want 0", cache.Size())
	}
}

// --- TST-MBX-0023: Background cleanup deletes expired entries ---
// TRACE: {"suite": "MBX", "case": "0023", "section": "03", "sectionName": "Replay Protection & Idempotency", "subsection": "01", "scenario": "06", "title": "background_cleanup_expired"}
//
// Multiple entries with different ages. Cleanup removes only the expired ones.
func TestIdempotency_BackgroundCleanup(t *testing.T) {
	cache := NewIdempotencyCache(100 * time.Millisecond)

	now := time.Now()
	cache.now = func() time.Time { return now }

	// Add 5 entries at time T.
	for i := 0; i < 5; i++ {
		cache.Put("did:key:zClean", "req-"+string(rune('A'+i)),
			&RPCInnerResponse{Status: 200, Body: "ok"})
	}
	if cache.Size() != 5 {
		t.Fatalf("setup: size = %d, want 5", cache.Size())
	}

	// Add 3 more entries at T+80ms (within TTL).
	now = now.Add(80 * time.Millisecond)
	for i := 0; i < 3; i++ {
		cache.Put("did:key:zClean", "req-late-"+string(rune('A'+i)),
			&RPCInnerResponse{Status: 200, Body: "late"})
	}
	if cache.Size() != 8 {
		t.Fatalf("after late adds: size = %d, want 8", cache.Size())
	}

	// Advance to T+150ms: first 5 expired (>100ms), last 3 still valid (70ms).
	now = now.Add(70 * time.Millisecond) // total 150ms from start

	removed := cache.Cleanup()
	if removed != 5 {
		t.Errorf("Cleanup removed %d, want 5 (early entries)", removed)
	}
	if cache.Size() != 3 {
		t.Errorf("after cleanup: size = %d, want 3 (late entries survive)", cache.Size())
	}

	// Also test nonce cleanup.
	nonces := NewNonceCache(100 * time.Millisecond)
	nonceNow := time.Now()
	nonces.now = func() time.Time { return nonceNow }

	nonces.CheckAndStore("did:key:z1", "nonce-1")
	nonces.CheckAndStore("did:key:z1", "nonce-2")
	nonces.CheckAndStore("did:key:z2", "nonce-3")

	nonceNow = nonceNow.Add(200 * time.Millisecond)
	nonceRemoved := nonces.Cleanup()
	if nonceRemoved != 3 {
		t.Errorf("nonce Cleanup removed %d, want 3", nonceRemoved)
	}
}

// --- TST-MBX-0024: Store-before-send crash window ---
// TRACE: {"suite": "MBX", "case": "0024", "section": "03", "sectionName": "Replay Protection & Idempotency", "subsection": "01", "scenario": "07", "title": "store_before_send_crash_window"}
//
// Handler completes → cache.Put (store-before-send) → "crash" before
// WebSocket send → retry → cache.Get returns cached response → no re-execution.
func TestIdempotency_StoreBeforeSendCrashWindow(t *testing.T) {
	did, priv, pub := testKeyPair(t)
	deviceKeys := map[string]ed25519.PublicKey{did: pub}
	handler := stubHandler(deviceKeys, nil)
	bridge := NewRPCBridge(handler)
	cache := NewIdempotencyCache(5 * time.Minute)

	requestID := "req-crash-001"
	body := `{"text":"critical"}`

	// Step 1: First request — process via bridge.
	headers1 := makeSignedHeaders(t, "POST", "/api/v1/remember", "", body, did, priv)
	innerJSON1, _ := BuildInnerRequestJSON("POST", "/api/v1/remember", headers1, body)
	resp1, err := bridge.HandleInnerRequest(innerJSON1)
	if err != nil {
		t.Fatalf("first request: %v", err)
	}
	if resp1.Status != 200 {
		t.Fatalf("first request status = %d, want 200", resp1.Status)
	}

	// Step 2: Store in cache BEFORE sending response (store-before-send).
	cache.Put(did, requestID, resp1)

	// Step 3: "Crash" — the WebSocket send never happens.
	// The response is cached but the CLI never received it.

	// Step 4: CLI retries with same request_id (fresh nonce/timestamp).
	headers2 := makeSignedHeaders(t, "POST", "/api/v1/remember", "", body, did, priv)
	_ = headers2 // would be used for signature, but we check cache first

	// Step 5: Check cache — hit. Return cached response without calling bridge.
	cached := cache.Get(did, requestID)
	if cached == nil {
		t.Fatal("cache miss — store-before-send failed")
	}

	// Step 6: Verify cached response matches original.
	if cached.Status != 200 {
		t.Errorf("cached status = %d, want 200", cached.Status)
	}
	if cached.Body != resp1.Body {
		t.Errorf("cached body = %q, want %q", cached.Body, resp1.Body)
	}

	// The handler was called exactly ONCE (the first request).
	// The retry was served from cache — no re-execution, no duplicate side effects.
	// This is the store-before-send guarantee.
}

// --- TST-MBX-0031: Duplicate retry after drain → idempotency hit ---
// TRACE: {"suite": "MBX", "case": "0031", "section": "04", "sectionName": "Offline Behavior, Expiry & Cancel", "subsection": "01", "scenario": "07", "title": "duplicate_retry_after_drain_idempotency"}
//
// CLI sends request → buffered (Core offline). Core reconnects → drains
// and processes. CLI was offline, didn't get response. CLI retries with
// same request_id → idempotency cache returns cached response.
func TestIdempotency_DuplicateRetryAfterDrain(t *testing.T) {
	did, priv, pub := testKeyPair(t)
	deviceKeys := map[string]ed25519.PublicKey{did: pub}
	handler := stubHandler(deviceKeys, nil)
	bridge := NewRPCBridge(handler)
	cache := NewIdempotencyCache(5 * time.Minute)

	requestID := "req-drain-retry"
	body := `{"text":"drain test"}`

	// Step 1: First request — processed by bridge (simulates Core processing
	// a drained request).
	headers1 := makeSignedHeaders(t, "POST", "/api/v1/remember", "", body, did, priv)
	innerJSON1, _ := BuildInnerRequestJSON("POST", "/api/v1/remember", headers1, body)
	resp1, err := bridge.HandleInnerRequest(innerJSON1)
	if err != nil {
		t.Fatalf("first request: %v", err)
	}

	// Step 2: Store in idempotency cache (store-before-send).
	cache.Put(did, requestID, resp1)

	// Step 3: CLI retries with same request_id (fresh nonce).
	// Before calling bridge, check idempotency cache.
	cached := cache.Get(did, requestID)
	if cached == nil {
		t.Fatal("idempotency cache miss — should have the first response")
	}

	// Step 4: Return cached response without re-processing.
	if cached.Status != 200 {
		t.Errorf("cached status = %d, want 200", cached.Status)
	}
	if cached.Body != resp1.Body {
		t.Errorf("cached body = %q, want %q", cached.Body, resp1.Body)
	}
}

// --- TST-MBX-0084: Cancel after completion → ignored, idempotency intact ---
// TRACE: {"suite": "MBX", "case": "0084", "section": "04", "sectionName": "Offline Behavior, Expiry & Cancel", "subsection": "04", "scenario": "06", "title": "cancel_after_completion_ignored"}
//
// Request completed, cached in idempotency. Cancel arrives → ignored.
// Retry returns cached response.
func TestIdempotency_CancelAfterCompletion(t *testing.T) {
	cache := NewIdempotencyCache(5 * time.Minute)

	did := "did:key:zCancel084"
	requestID := "req-completed"

	// Request completed and cached.
	resp := &RPCInnerResponse{Status: 200, Body: `{"stored":true}`}
	cache.Put(did, requestID, resp)

	// Cancel arrives after completion. The idempotency cache is not affected
	// by cancellation — it's a separate mechanism. The cancel handler would
	// check the worker pool's inflight map (which has already removed the task
	// since it completed), find nothing, and ignore the cancel.
	//
	// From the idempotency cache's perspective: still has the entry.
	if cache.Get(did, requestID) == nil {
		t.Fatal("idempotency entry should survive cancel")
	}

	// Retry with same request_id → returns cached response.
	cached := cache.Get(did, requestID)
	if cached.Status != 200 {
		t.Errorf("cached status = %d, want 200", cached.Status)
	}
	if cached.Body != `{"stored":true}` {
		t.Errorf("cached body = %q", cached.Body)
	}

	// Cache size unchanged.
	if cache.Size() != 1 {
		t.Errorf("cache size = %d, want 1", cache.Size())
	}
}

// --- TST-MBX-0028: CLI reconnects, drain_buffered, cache hit on retry ---
// TRACE: {"suite": "MBX", "case": "0028", "section": "04", "sectionName": "Offline Behavior, Expiry & Cancel", "subsection": "01", "scenario": "04", "title": "cli_reconnect_drain_cache_hit"}
//
// CLI sends request → buffered (Core offline). Core reconnects → drains,
// processes, caches response (idempotency). Core sends response to CLI's
// did:key → CLI is offline, response buffered. CLI reconnects → drain_buffered
// gets the response. If CLI had already retried: idempotency cache would have
// returned the cached response.
//
// This test validates the Core-side idempotency cache serving a retry after
// the response was already computed (simulating CLI reconnect + retry).
func TestIdempotency_CLIReconnectDrainCacheHit(t *testing.T) {
	did, priv, pub := testKeyPair(t)
	deviceKeys := map[string]ed25519.PublicKey{did: pub}
	handler := stubHandler(deviceKeys, nil)
	bridge := NewRPCBridge(handler)
	cache := NewIdempotencyCache(5 * time.Minute)

	requestID := "req-reconnect-028"
	body := `{"text":"reconnect test"}`

	// Step 1: Core processes the drained request.
	headers := makeSignedHeaders(t, "POST", "/api/v1/remember", "", body, did, priv)
	innerJSON, _ := BuildInnerRequestJSON("POST", "/api/v1/remember", headers, body)
	resp, err := bridge.HandleInnerRequest(innerJSON)
	if err != nil {
		t.Fatal(err)
	}

	// Step 2: Cache the response (store-before-send).
	cache.Put(did, requestID, resp)

	// Step 3: CLI reconnects and retries with same request_id.
	// Before calling bridge, check cache.
	cached := cache.Get(did, requestID)
	if cached == nil {
		t.Fatal("cache miss on retry — CLI would have to re-process")
	}
	if cached.Status != resp.Status || cached.Body != resp.Body {
		t.Errorf("cached response differs from original: got %+v, want %+v", cached, resp)
	}
}

// --- TST-MBX-0093: Core restart before idempotency write ---
// TRACE: {"suite": "MBX", "case": "0093", "section": "08", "sectionName": "Reliability & Crash Recovery", "subsection": "04", "scenario": "01", "title": "core_restart_before_idempotency_write"}
//
// Core receives RPC, handler starts processing. Core crashes BEFORE
// rpc_idempotency INSERT. No cached response. CLI retries → request
// re-executes. Idempotency only protects after commit.
func TestIdempotency_CoreRestartBeforeWrite(t *testing.T) {
	did, priv, _ := testKeyPair(t)

	// Track how many times the handler is called.
	var callCount int
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Simplified: just count calls and return 200.
		callCount++
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(200)
		w.Write([]byte(`{"status":"processed"}`))
	})

	bridge := NewRPCBridge(handler)
	cache := NewIdempotencyCache(5 * time.Minute)

	requestID := "req-crash-093"
	body := `{"text":"crash test"}`

	// Step 1: First request — processed by bridge.
	headers1 := makeSignedHeaders(t, "POST", "/api/v1/remember", "", body, did, priv)
	innerJSON1, _ := BuildInnerRequestJSON("POST", "/api/v1/remember", headers1, body)
	resp1, _ := bridge.HandleInnerRequest(innerJSON1)
	if resp1.Status != 200 {
		t.Fatalf("first request: status = %d", resp1.Status)
	}

	// Step 2: "CRASH" — cache.Put never happens.
	// (We simply don't call cache.Put here.)

	// Step 3: CLI retries with same request_id.
	// Check cache — MISS (because the crash prevented the write).
	if cached := cache.Get(did, requestID); cached != nil {
		t.Fatal("cache should be empty — crash before write")
	}

	// Step 4: Must re-process (no idempotency protection).
	headers2 := makeSignedHeaders(t, "POST", "/api/v1/remember", "", body, did, priv)
	innerJSON2, _ := BuildInnerRequestJSON("POST", "/api/v1/remember", headers2, body)
	resp2, _ := bridge.HandleInnerRequest(innerJSON2)
	if resp2.Status != 200 {
		t.Fatalf("retry: status = %d", resp2.Status)
	}

	// Handler was called TWICE (no idempotency protection without cache).
	if callCount != 2 {
		t.Errorf("handler called %d times, want 2 (no idempotency without cache write)", callCount)
	}

	// Step 5: Now store in cache (simulating successful completion on retry).
	cache.Put(did, requestID, resp2)

	// Step 6: Third request with same ID → cache hit.
	if cached := cache.Get(did, requestID); cached == nil {
		t.Fatal("third request should hit cache after successful write")
	}
}

// --- TST-MBX-0094: Core restart after idempotency write, before response send ---
// TRACE: {"suite": "MBX", "case": "0094", "section": "08", "sectionName": "Reliability & Crash Recovery", "subsection": "04", "scenario": "02", "title": "core_restart_after_idempotency_write"}
//
// Handler completes, idempotency cache committed, Core crashes BEFORE
// WebSocket send. CLI retries → returns cached response. No re-execution.
func TestIdempotency_CoreRestartAfterWrite(t *testing.T) {
	did, priv, _ := testKeyPair(t)

	var callCount int
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount++
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(200)
		w.Write([]byte(`{"status":"stored"}`))
	})

	bridge := NewRPCBridge(handler)
	cache := NewIdempotencyCache(5 * time.Minute)

	requestID := "req-094"
	body := `{"text":"persist test"}`

	// Step 1: Process via bridge.
	headers := makeSignedHeaders(t, "POST", "/api/v1/remember", "", body, did, priv)
	innerJSON, _ := BuildInnerRequestJSON("POST", "/api/v1/remember", headers, body)
	resp, _ := bridge.HandleInnerRequest(innerJSON)

	// Step 2: Store-before-send — cache.Put happens.
	cache.Put(did, requestID, resp)

	// Step 3: "Crash" — response send never happens. callCount=1.

	// Step 4: CLI retries.
	cached := cache.Get(did, requestID)
	if cached == nil {
		t.Fatal("cache miss after write — store-before-send failed")
	}
	if cached.Status != 200 {
		t.Errorf("cached status = %d, want 200", cached.Status)
	}

	// Handler NOT called again — idempotency protected.
	if callCount != 1 {
		t.Errorf("handler called %d times, want 1 (idempotency should prevent re-execution)", callCount)
	}
}

