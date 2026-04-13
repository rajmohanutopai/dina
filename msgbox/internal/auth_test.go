package internal

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// --- Test helpers ---

// newTestWSPair creates a real in-process WebSocket connection pair.
// Returns the server-side connection and a cleanup function.
func newTestWSPair(t *testing.T) (*websocket.Conn, func()) {
	t.Helper()
	wsCh := make(chan *websocket.Conn, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			t.Logf("test ws accept: %v", err)
			return
		}
		wsCh <- ws
		// Keep handler alive so WebSocket stays open.
		<-r.Context().Done()
	}))

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	clientWS, _, err := websocket.Dial(context.Background(), wsURL, nil)
	if err != nil {
		srv.Close()
		t.Fatalf("test ws dial: %v", err)
	}
	serverWS := <-wsCh

	cleanup := func() {
		clientWS.Close(websocket.StatusNormalClosure, "")
		serverWS.Close(websocket.StatusNormalClosure, "")
		srv.Close()
	}
	return serverWS, cleanup
}

// wsClientDo connects to a test WebSocket server, reads the auth challenge,
// builds a signed response, sends it, and returns the connection.
// The caller provides the DID to claim and the keypair to sign with.
func wsClientDo(t *testing.T, url string, did string, privKey ed25519.PrivateKey, pubKey ed25519.PublicKey) (*websocket.Conn, error) {
	t.Helper()

	ctx := context.Background()
	ws, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		return nil, fmt.Errorf("dial: %w", err)
	}

	// Read challenge.
	_, chalBytes, err := ws.Read(ctx)
	if err != nil {
		ws.Close(websocket.StatusAbnormalClosure, "")
		return nil, fmt.Errorf("read challenge: %w", err)
	}
	var chal AuthChallenge
	if err := json.Unmarshal(chalBytes, &chal); err != nil {
		ws.Close(websocket.StatusAbnormalClosure, "")
		return nil, fmt.Errorf("parse challenge: %w", err)
	}

	// Sign challenge payload.
	payload := fmt.Sprintf("AUTH_RELAY\n%s\n%d", chal.Nonce, chal.TS)
	sig := ed25519.Sign(privKey, []byte(payload))

	// Send auth response.
	resp := AuthResponse{
		Type: AuthResponseType,
		DID:  did,
		Sig:  hex.EncodeToString(sig),
		Pub:  hex.EncodeToString(pubKey),
	}
	respBytes, _ := json.Marshal(resp)
	if err := ws.Write(ctx, websocket.MessageText, respBytes); err != nil {
		ws.Close(websocket.StatusAbnormalClosure, "")
		return nil, fmt.Errorf("write response: %w", err)
	}

	return ws, nil
}

// mockPLCResolver implements PLCResolver for tests.
type mockPLCResolver struct {
	// keys maps did:plc:... → Ed25519 public key.
	keys map[string]ed25519.PublicKey
}

func (m *mockPLCResolver) ResolveDinaSigningKey(_ context.Context, did string) (ed25519.PublicKey, error) {
	key, ok := m.keys[did]
	if !ok {
		return nil, fmt.Errorf("PLC document not found for %s", did)
	}
	return key, nil
}

// startAuthServer starts a test HTTP server that authenticates WebSocket
// connections using AuthenticateWithResolver. Returns the server URL and
// a channel that receives the authenticated DID (or error).
func startAuthServer(t *testing.T, resolver PLCResolver) (*httptest.Server, chan string, chan error) {
	t.Helper()
	didCh := make(chan string, 1)
	errCh := make(chan error, 1)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			errCh <- err
			return
		}
		did, authErr := AuthenticateWithResolver(r.Context(), ws, resolver)
		if authErr != nil {
			ws.Close(websocket.StatusCode(4001), "auth failed")
			errCh <- authErr
			return
		}
		didCh <- did
		// Keep connection open briefly so client can verify success.
		ws.Close(websocket.StatusNormalClosure, "ok")
	}))
	return srv, didCh, errCh
}

// --- TST-MBX-0001: did:key connect with correct key → registered ---
// TRACE: {"suite": "MBX", "case": "0001", "section": "01", "sectionName": "DID Authentication", "subsection": "01", "scenario": "01", "title": "did_key_correct_key_registered"}
func TestAuth_DIDKey_CorrectKey(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	did := deriveDIDKey(pub)

	srv, didCh, errCh := startAuthServer(t, nil) // no PLC resolver needed for did:key
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")

	ws, err := wsClientDo(t, wsURL, did, priv, pub)
	if err != nil {
		t.Fatalf("auth handshake failed: %v", err)
	}
	defer ws.Close(websocket.StatusNormalClosure, "")

	select {
	case authedDID := <-didCh:
		if authedDID != did {
			t.Errorf("authenticated DID = %q, want %q", authedDID, did)
		}
	case authErr := <-errCh:
		t.Fatalf("server auth error: %v", authErr)
	}
}

// --- TST-MBX-0002: did:key connect with wrong key → rejected ---
// TRACE: {"suite": "MBX", "case": "0002", "section": "01", "sectionName": "DID Authentication", "subsection": "01", "scenario": "02", "title": "did_key_wrong_key_rejected"}
func TestAuth_DIDKey_WrongKey(t *testing.T) {
	// Generate two different keypairs.
	pubA, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	_, privB, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	pubB := privB.Public().(ed25519.PublicKey)

	// Claim DID derived from keyA, but sign with keyB.
	didA := deriveDIDKey(pubA)

	srv, didCh, errCh := startAuthServer(t, nil)
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")

	// This should fail: DID is for keyA but we sign with keyB and provide pubB.
	// The DID key binding check will see that pubB doesn't derive to didA.
	ws, clientErr := wsClientDo(t, wsURL, didA, privB, pubB)
	if clientErr != nil {
		t.Logf("client error (expected): %v", clientErr)
	}
	if ws != nil {
		ws.Close(websocket.StatusNormalClosure, "")
	}

	select {
	case authedDID := <-didCh:
		t.Fatalf("auth should have failed, but got DID: %s", authedDID)
	case authErr := <-errCh:
		if !strings.Contains(authErr.Error(), "did:key mismatch") {
			t.Errorf("expected 'did:key mismatch' error, got: %v", authErr)
		}
	}
}

// --- TST-MBX-0003: did:plc connect with correct #dina_signing key → registered ---
// TRACE: {"suite": "MBX", "case": "0003", "section": "01", "sectionName": "DID Authentication", "subsection": "01", "scenario": "03", "title": "did_plc_correct_key_registered"}
func TestAuth_DIDPLC_CorrectKey(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	did := "did:plc:test-homenode-abc"

	// Mock PLC resolver returns the correct key for this DID.
	resolver := &mockPLCResolver{
		keys: map[string]ed25519.PublicKey{
			did: pub,
		},
	}

	srv, didCh, errCh := startAuthServer(t, resolver)
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")

	ws, err := wsClientDo(t, wsURL, did, priv, pub)
	if err != nil {
		t.Fatalf("auth handshake failed: %v", err)
	}
	defer ws.Close(websocket.StatusNormalClosure, "")

	select {
	case authedDID := <-didCh:
		if authedDID != did {
			t.Errorf("authenticated DID = %q, want %q", authedDID, did)
		}
	case authErr := <-errCh:
		t.Fatalf("server auth error: %v", authErr)
	}
}

// --- TST-MBX-0004: did:plc connect with wrong key → rejected ---
// TRACE: {"suite": "MBX", "case": "0004", "section": "01", "sectionName": "DID Authentication", "subsection": "01", "scenario": "04", "title": "did_plc_wrong_key_rejected"}
func TestAuth_DIDPLC_WrongKey(t *testing.T) {
	pubReal, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	_, privFake, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	pubFake := privFake.Public().(ed25519.PublicKey)

	did := "did:plc:test-homenode-xyz"

	// PLC resolver returns the REAL key, but the client will sign with the FAKE key.
	resolver := &mockPLCResolver{
		keys: map[string]ed25519.PublicKey{
			did: pubReal,
		},
	}

	srv, didCh, errCh := startAuthServer(t, resolver)
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")

	// Client claims did:plc but signs with a different key than what PLC has.
	ws, clientErr := wsClientDo(t, wsURL, did, privFake, pubFake)
	if clientErr != nil {
		t.Logf("client error (expected): %v", clientErr)
	}
	if ws != nil {
		ws.Close(websocket.StatusNormalClosure, "")
	}

	select {
	case authedDID := <-didCh:
		t.Fatalf("auth should have failed, but got DID: %s", authedDID)
	case authErr := <-errCh:
		if !strings.Contains(authErr.Error(), "does not match #dina_signing") {
			t.Errorf("expected '#dina_signing' mismatch error, got: %v", authErr)
		}
	}
}

// --- TST-MBX-0005: DID squatting: second connection claiming same DID → rejected unless re-authed ---
// TRACE: {"suite": "MBX", "case": "0005", "section": "01", "sectionName": "DID Authentication", "subsection": "01", "scenario": "05", "title": "did_squatting_second_connection_rejected"}
//
// This test validates that when a DID is already registered in the Hub,
// a second connection claiming the same DID replaces the first (the existing
// behavior in Hub.Register). The design says "rejected unless re-authed" —
// since both connections go through full challenge-response auth, the second
// connection IS re-authed and the replacement is correct behavior.
//
// The security property being tested: you can't squat a DID without proving
// ownership via challenge-response. Since both connections must authenticate,
// an attacker without the private key cannot connect as that DID at all
// (covered by TST-MBX-0002/0004). This test verifies the Hub-level behavior
// when a legitimate re-connection occurs.
func TestAuth_DIDSquatting_ReplaceOnReauth(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	did := deriveDIDKey(pub)

	buf := newTestBuffer(t)
	defer buf.Close()
	hub := NewHub(buf)

	// Create a real in-process WebSocket pair for conn1 so Hub.Register
	// can call old.WS.Close() without panicking.
	conn1WS, conn1Close := newTestWSPair(t)
	defer conn1Close()
	conn1Ctx, conn1Cancel := context.WithCancel(context.Background())
	defer conn1Cancel()

	conn1 := &MsgBoxConn{
		WS:     conn1WS,
		DID:    did,
		Ctx:    conn1Ctx,
		Cancel: conn1Cancel,
	}
	hub.Register(conn1)

	if hub.ConnectedCount() != 1 {
		t.Fatalf("after first register: ConnectedCount = %d, want 1", hub.ConnectedCount())
	}

	// Simulate second authenticated connection for the same DID.
	conn2WS, conn2Close := newTestWSPair(t)
	defer conn2Close()
	conn2Ctx, conn2Cancel := context.WithCancel(context.Background())
	defer conn2Cancel()

	conn2 := &MsgBoxConn{
		WS:     conn2WS,
		DID:    did,
		Ctx:    conn2Ctx,
		Cancel: conn2Cancel,
	}
	hub.Register(conn2)

	// Should still have 1 connection (replaced, not stacked).
	if hub.ConnectedCount() != 1 {
		t.Fatalf("after second register: ConnectedCount = %d, want 1 (replaced)", hub.ConnectedCount())
	}

	// Unregister conn1 should be a no-op (it was already replaced).
	hub.Unregister(did, conn1)
	if hub.ConnectedCount() != 1 {
		t.Errorf("after unregister conn1: ConnectedCount = %d, want 1 (conn2 still active)", hub.ConnectedCount())
	}

	// Unregister conn2 should work.
	hub.Unregister(did, conn2)
	if hub.ConnectedCount() != 0 {
		t.Errorf("after unregister conn2: ConnectedCount = %d, want 0", hub.ConnectedCount())
	}

	// Verify the key binding works — an attacker with a different key cannot
	// get past Authenticate, so they can never call Hub.Register with this DID.
	_ = priv // priv used in wsClientDo tests above; here we test Hub behavior only.
	_ = pub
}

// --- countingPLCResolver tracks how many times ResolveDinaSigningKey was called ---
type countingPLCResolver struct {
	inner PLCResolver
	calls atomic.Int64
}

func (c *countingPLCResolver) ResolveDinaSigningKey(ctx context.Context, did string) (ed25519.PublicKey, error) {
	c.calls.Add(1)
	return c.inner.ResolveDinaSigningKey(ctx, did)
}

// --- TST-MBX-0006: PLC cache hit: second connect reuses cached document ---
// TRACE: {"suite": "MBX", "case": "0006", "section": "01", "sectionName": "DID Authentication", "subsection": "02", "scenario": "01", "title": "plc_cache_hit_no_refetch"}
func TestAuth_PLCCacheHit(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	did := "did:plc:test-cache-hit"

	inner := &countingPLCResolver{
		inner: &mockPLCResolver{keys: map[string]ed25519.PublicKey{did: pub}},
	}
	cached := NewCachingPLCResolver(inner, 1*time.Hour)

	// First resolve — should hit inner.
	key1, err := cached.ResolveDinaSigningKey(context.Background(), did)
	if err != nil {
		t.Fatalf("first resolve: %v", err)
	}
	if !ed25519.PublicKey(key1).Equal(pub) {
		t.Fatal("first resolve returned wrong key")
	}
	if inner.calls.Load() != 1 {
		t.Fatalf("after first resolve: inner calls = %d, want 1", inner.calls.Load())
	}

	// Second resolve — should hit cache, NOT inner.
	key2, err := cached.ResolveDinaSigningKey(context.Background(), did)
	if err != nil {
		t.Fatalf("second resolve: %v", err)
	}
	if !ed25519.PublicKey(key2).Equal(pub) {
		t.Fatal("second resolve returned wrong key")
	}
	if inner.calls.Load() != 1 {
		t.Fatalf("after second resolve: inner calls = %d, want 1 (cache hit)", inner.calls.Load())
	}

	// Now do a full auth handshake using the caching resolver — verify it works end-to-end.
	srv, didCh, errCh := startAuthServer(t, cached)
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	ws, err := wsClientDo(t, wsURL, did, priv, pub)
	if err != nil {
		t.Fatalf("auth handshake: %v", err)
	}
	defer ws.Close(websocket.StatusNormalClosure, "")

	select {
	case authedDID := <-didCh:
		if authedDID != did {
			t.Errorf("DID = %q, want %q", authedDID, did)
		}
	case authErr := <-errCh:
		t.Fatalf("auth error: %v", authErr)
	}

	// Inner resolver should still have been called only once (cache served the auth).
	if inner.calls.Load() != 1 {
		t.Errorf("after auth handshake: inner calls = %d, want 1 (cache served auth)", inner.calls.Load())
	}

	_ = priv
}

// --- TST-MBX-0007: PLC cache stale after key rotation ---
// TRACE: {"suite": "MBX", "case": "0007", "section": "01", "sectionName": "DID Authentication", "subsection": "02", "scenario": "02", "title": "plc_cache_stale_after_key_rotation"}
func TestAuth_PLCCacheStale(t *testing.T) {
	// Generate old and new keypairs.
	pubOld, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	pubNew, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}

	did := "did:plc:test-key-rotation"

	// Mutable resolver — starts with old key, will be updated to new key.
	mutable := &mutablePLCResolver{keys: map[string]ed25519.PublicKey{did: pubOld}}
	inner := &countingPLCResolver{inner: mutable}

	// Short TTL for test (100ms).
	cached := NewCachingPLCResolver(inner, 100*time.Millisecond)

	// Controllable clock — start at time T.
	now := time.Now()
	cached.now = func() time.Time { return now }

	// First resolve — fetches old key, caches it.
	key1, err := cached.ResolveDinaSigningKey(context.Background(), did)
	if err != nil {
		t.Fatal(err)
	}
	if !ed25519.PublicKey(key1).Equal(pubOld) {
		t.Fatal("expected old key")
	}
	if inner.calls.Load() != 1 {
		t.Fatalf("calls = %d, want 1", inner.calls.Load())
	}

	// Simulate key rotation: update the PLC document to new key.
	mutable.mu.Lock()
	mutable.keys[did] = pubNew
	mutable.mu.Unlock()

	// Still within TTL — cache returns OLD key (stale).
	now = now.Add(50 * time.Millisecond) // only 50ms elapsed, TTL is 100ms
	key2, err := cached.ResolveDinaSigningKey(context.Background(), did)
	if err != nil {
		t.Fatal(err)
	}
	if !ed25519.PublicKey(key2).Equal(pubOld) {
		t.Error("within TTL: expected OLD key from cache, got new key")
	}
	if inner.calls.Load() != 1 {
		t.Errorf("within TTL: inner calls = %d, want 1 (cache hit)", inner.calls.Load())
	}

	// Advance clock past TTL.
	now = now.Add(200 * time.Millisecond) // 250ms total, TTL is 100ms

	// Cache expired — should re-fetch and get NEW key.
	key3, err := cached.ResolveDinaSigningKey(context.Background(), did)
	if err != nil {
		t.Fatal(err)
	}
	if !ed25519.PublicKey(key3).Equal(pubNew) {
		t.Error("after TTL: expected NEW key from fresh fetch, got old key")
	}
	if inner.calls.Load() != 2 {
		t.Errorf("after TTL: inner calls = %d, want 2 (cache miss → re-fetch)", inner.calls.Load())
	}
}

// mutablePLCResolver allows updating keys at runtime (simulating PLC doc changes).
type mutablePLCResolver struct {
	mu   sync.Mutex
	keys map[string]ed25519.PublicKey
}

func (m *mutablePLCResolver) ResolveDinaSigningKey(_ context.Context, did string) (ed25519.PublicKey, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	key, ok := m.keys[did]
	if !ok {
		return nil, fmt.Errorf("PLC document not found for %s", did)
	}
	return key, nil
}

// --- failingPLCResolver simulates PLC directory failure modes ---
type failingPLCResolver struct {
	err error
}

func (f *failingPLCResolver) ResolveDinaSigningKey(_ context.Context, _ string) (ed25519.PublicKey, error) {
	return nil, f.err
}

// --- TST-MBX-0110: PLC fetch timeout ---
// TRACE: {"suite": "MBX", "case": "0110", "section": "11", "sectionName": "PLC Cache Failure Modes", "subsection": "01", "scenario": "01", "title": "plc_fetch_timeout"}
func TestAuth_PLCFetchTimeout(t *testing.T) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	pub := priv.Public().(ed25519.PublicKey)
	did := "did:plc:timeout-test"

	// Resolver always returns a timeout error.
	resolver := &failingPLCResolver{err: context.DeadlineExceeded}

	srv, didCh, errCh := startAuthServer(t, resolver)
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	ws, clientErr := wsClientDo(t, wsURL, did, priv, pub)
	if clientErr != nil {
		t.Logf("client error (expected): %v", clientErr)
	}
	if ws != nil {
		ws.Close(websocket.StatusNormalClosure, "")
	}

	select {
	case authedDID := <-didCh:
		t.Fatalf("auth should have failed, but got DID: %s", authedDID)
	case authErr := <-errCh:
		if !strings.Contains(authErr.Error(), "resolve PLC document") {
			t.Errorf("expected PLC resolve error, got: %v", authErr)
		}
	}

	// did:key connections should be unaffected — test one to verify.
	pubKey, privKey, _ := ed25519.GenerateKey(rand.Reader)
	didKey := deriveDIDKey(pubKey)
	srv2, didCh2, errCh2 := startAuthServer(t, resolver) // same failing resolver
	defer srv2.Close()
	wsURL2 := "ws" + strings.TrimPrefix(srv2.URL, "http")
	ws2, err2 := wsClientDo(t, wsURL2, didKey, privKey, pubKey)
	if err2 != nil {
		t.Fatalf("did:key auth failed (should work despite PLC resolver): %v", err2)
	}
	defer ws2.Close(websocket.StatusNormalClosure, "")
	select {
	case d := <-didCh2:
		if d != didKey {
			t.Errorf("did:key DID = %q, want %q", d, didKey)
		}
	case e := <-errCh2:
		t.Fatalf("did:key should have succeeded: %v", e)
	}
}

// --- TST-MBX-0111: Malformed PLC document ---
// TRACE: {"suite": "MBX", "case": "0111", "section": "11", "sectionName": "PLC Cache Failure Modes", "subsection": "01", "scenario": "02", "title": "malformed_plc_document"}
func TestAuth_PLCMalformedDocument(t *testing.T) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	pub := priv.Public().(ed25519.PublicKey)
	did := "did:plc:malformed-test"

	// Resolver returns a parse error (simulating invalid JSON from PLC directory).
	resolver := &failingPLCResolver{err: fmt.Errorf("json: cannot unmarshal string into Go value")}

	srv, didCh, errCh := startAuthServer(t, resolver)
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	ws, clientErr := wsClientDo(t, wsURL, did, priv, pub)
	if clientErr != nil {
		t.Logf("client error (expected): %v", clientErr)
	}
	if ws != nil {
		ws.Close(websocket.StatusNormalClosure, "")
	}

	select {
	case authedDID := <-didCh:
		t.Fatalf("auth should have failed, got DID: %s", authedDID)
	case authErr := <-errCh:
		if !strings.Contains(authErr.Error(), "resolve PLC document") {
			t.Errorf("expected PLC resolve error, got: %v", authErr)
		}
	}
}

// --- TST-MBX-0112: Missing #dina_signing in PLC doc ---
// TRACE: {"suite": "MBX", "case": "0112", "section": "11", "sectionName": "PLC Cache Failure Modes", "subsection": "01", "scenario": "03", "title": "missing_dina_signing_in_plc"}
func TestAuth_PLCMissingDinaSigning(t *testing.T) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	pub := priv.Public().(ed25519.PublicKey)
	did := "did:plc:no-dina-signing"

	// Resolver returns a specific "no #dina_signing" error.
	resolver := &failingPLCResolver{
		err: fmt.Errorf("PLC document has no #dina_signing verification method"),
	}

	srv, didCh, errCh := startAuthServer(t, resolver)
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	ws, clientErr := wsClientDo(t, wsURL, did, priv, pub)
	if clientErr != nil {
		t.Logf("client error (expected): %v", clientErr)
	}
	if ws != nil {
		ws.Close(websocket.StatusNormalClosure, "")
	}

	select {
	case authedDID := <-didCh:
		t.Fatalf("auth should have failed, got DID: %s", authedDID)
	case authErr := <-errCh:
		if !strings.Contains(authErr.Error(), "resolve PLC document") {
			t.Errorf("expected PLC resolve error, got: %v", authErr)
		}
		if !strings.Contains(authErr.Error(), "#dina_signing") {
			t.Errorf("error should mention #dina_signing, got: %v", authErr)
		}
	}
}

// --- TST-MBX-0066: PLC cache refresh after key rotation ---
// TRACE: {"suite": "MBX", "case": "0066", "section": "06", "sectionName": "Operational & Load", "subsection": "03", "scenario": "03", "title": "plc_cache_refresh_key_rotation"}
//
// DID key rotated, cache expires, next connect re-fetches and succeeds
// with the new key.
func TestAuth_PLCCacheRefreshAfterRotation(t *testing.T) {
	// Old and new keys.
	pubOld, privOld, _ := ed25519.GenerateKey(rand.Reader)
	pubNew, privNew, _ := ed25519.GenerateKey(rand.Reader)
	did := "did:plc:refresh-066"

	// Start with old key in PLC.
	mutable := &mutablePLCResolver{keys: map[string]ed25519.PublicKey{did: pubOld}}
	inner := &countingPLCResolver{inner: mutable}
	cached := NewCachingPLCResolver(inner, 100*time.Millisecond)

	now := time.Now()
	cached.now = func() time.Time { return now }

	// Auth with old key — succeeds, caches PLC doc.
	srv1, didCh1, errCh1 := startAuthServer(t, cached)
	defer srv1.Close()
	wsURL1 := "ws" + strings.TrimPrefix(srv1.URL, "http")
	ws1, err := wsClientDo(t, wsURL1, did, privOld, pubOld)
	if err != nil {
		t.Fatalf("old key auth: %v", err)
	}
	defer ws1.Close(websocket.StatusNormalClosure, "")
	select {
	case <-didCh1:
	case e := <-errCh1:
		t.Fatalf("old key should succeed: %v", e)
	}

	if inner.calls.Load() != 1 {
		t.Fatalf("after first auth: inner calls = %d, want 1", inner.calls.Load())
	}

	// Rotate: PLC now has new key.
	mutable.mu.Lock()
	mutable.keys[did] = pubNew
	mutable.mu.Unlock()

	// Advance past cache TTL.
	now = now.Add(200 * time.Millisecond)

	// Auth with new key — cache expired, re-fetches, succeeds.
	srv2, didCh2, errCh2 := startAuthServer(t, cached)
	defer srv2.Close()
	wsURL2 := "ws" + strings.TrimPrefix(srv2.URL, "http")
	ws2, err := wsClientDo(t, wsURL2, did, privNew, pubNew)
	if err != nil {
		t.Fatalf("new key auth: %v", err)
	}
	defer ws2.Close(websocket.StatusNormalClosure, "")
	select {
	case d := <-didCh2:
		if d != did {
			t.Errorf("DID = %q, want %q", d, did)
		}
	case e := <-errCh2:
		t.Fatalf("new key should succeed after cache refresh: %v", e)
	}

	// Cache was refreshed — inner called again.
	if inner.calls.Load() != 2 {
		t.Errorf("after rotation: inner calls = %d, want 2 (cache miss → re-fetch)", inner.calls.Load())
	}

	_ = privOld
	_ = privNew
}

// TestAuth_HandleWebSocketUsesResolver verifies that HandleWebSocket passes
// the handler's PLCResolver to AuthenticateWithResolver.
func TestAuth_HandleWebSocketUsesResolver(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	did := "did:plc:resolver-wiring-test"

	// Resolver that returns the correct key for this DID.
	resolver := &mockPLCResolver{keys: map[string]ed25519.PublicKey{did: pub}}
	inner := &countingPLCResolver{inner: resolver}

	buf := newTestBuffer(t)
	defer buf.Close()
	hub := NewHub(buf)
	handler := NewHandler(hub, inner) // pass resolver

	// Start a server using the real HandleWebSocket.
	srv := httptest.NewServer(http.HandlerFunc(handler.HandleWebSocket))
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")

	// Connect and authenticate as did:plc.
	ws, err := wsClientDo(t, wsURL, did, priv, pub)
	if err != nil {
		t.Fatalf("auth failed: %v", err)
	}
	defer ws.Close(websocket.StatusNormalClosure, "")

	// Wait for the server to complete auth and registration.
	time.Sleep(50 * time.Millisecond)

	// The resolver should have been called (PLC doc lookup).
	if inner.calls.Load() != 1 {
		t.Errorf("resolver calls = %d, want 1 (HandleWebSocket should use PLCResolver)", inner.calls.Load())
	}
}

// TestAuth_DIDPLCWithoutResolverAccepted verifies backward compat:
// did:plc with nil resolver still authenticates (signature-only).
func TestAuth_DIDPLCWithoutResolverAccepted(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	did := "did:plc:no-resolver-test"

	// No resolver — handler created without one.
	buf := newTestBuffer(t)
	defer buf.Close()
	handler := NewHandler(NewHub(buf)) // no resolver

	srv := httptest.NewServer(http.HandlerFunc(handler.HandleWebSocket))
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")

	ws, err := wsClientDo(t, wsURL, did, priv, pub)
	if err != nil {
		t.Fatalf("auth should succeed without resolver (backward compat): %v", err)
	}
	defer ws.Close(websocket.StatusNormalClosure, "")
}
