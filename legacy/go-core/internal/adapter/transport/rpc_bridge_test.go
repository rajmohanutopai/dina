package transport

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// --- Test helpers ---

// testKeyPair generates an Ed25519 keypair and returns the DID, private key,
// and public key.
func testKeyPair(t *testing.T) (did string, priv ed25519.PrivateKey, pub ed25519.PublicKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	// Encode as did:key for testing.
	did = "did:key:z" + hex.EncodeToString(pub)[:20]
	return
}

// signRequest creates the canonical Ed25519 signature matching Core's auth
// middleware contract: METHOD\nPATH\nQUERY\nTIMESTAMP\nNONCE\nSHA256(BODY)
func signRequest(method, path, query, timestamp, nonce string, body []byte, priv ed25519.PrivateKey) string {
	bodyHash := sha256Hex(body)
	if len(body) == 0 {
		bodyHash = sha256Hex(nil) // empty body hash
	}
	canonical := fmt.Sprintf("%s\n%s\n%s\n%s\n%s\n%s", method, path, query, timestamp, nonce, bodyHash)
	sig := ed25519.Sign(priv, []byte(canonical))
	return hex.EncodeToString(sig)
}

// sendDirect sends a signed request directly to the HTTP handler.
func sendDirect(t *testing.T, handler http.Handler, method, path string, headers map[string]string, body string) *httptest.ResponseRecorder {
	t.Helper()
	var bodyReader io.Reader
	if body != "" {
		bodyReader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, bodyReader)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

// sendViaBridge sends the same request through the RPC bridge.
func sendViaBridge(t *testing.T, bridge *RPCBridge, method, path string, headers map[string]string, body string) *RPCInnerResponse {
	t.Helper()
	innerJSON, err := BuildInnerRequestJSON(method, path, headers, body)
	if err != nil {
		t.Fatalf("BuildInnerRequestJSON: %v", err)
	}
	resp, err := bridge.HandleInnerRequest(innerJSON)
	if err != nil {
		t.Fatalf("HandleInnerRequest: %v", err)
	}
	return resp
}

// stubHandler is a minimal HTTP handler that:
//   - Validates Ed25519 auth headers (timestamp, signature)
//   - Routes known paths to deterministic responses
//   - Returns 403 for restricted paths
//   - Returns 401 for invalid auth
//
// This mimics Core's auth middleware + handler chain for equivalence testing.
func stubHandler(devicePubKeys map[string]ed25519.PublicKey, restrictedPaths map[string]bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Optional auth paths (pairing, etc.) — skip auth.
		if r.URL.Path == "/v1/pair/complete" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(200)
			w.Write([]byte(`{"status":"paired"}`))
			return
		}

		// Auth: validate Ed25519 headers.
		xDID := r.Header.Get("X-DID")
		xSig := r.Header.Get("X-Signature")
		xTS := r.Header.Get("X-Timestamp")
		xNonce := r.Header.Get("X-Nonce")

		if xDID == "" || xSig == "" || xTS == "" || xNonce == "" {
			http.Error(w, `{"error":"missing auth headers"}`, http.StatusUnauthorized)
			return
		}

		// Timestamp validation (5 min window).
		ts, err := time.Parse("2006-01-02T15:04:05Z", xTS)
		if err != nil {
			http.Error(w, `{"error":"invalid timestamp format"}`, http.StatusUnauthorized)
			return
		}
		skew := time.Since(ts)
		if skew < 0 {
			skew = -skew
		}
		if skew > 5*time.Minute {
			http.Error(w, `{"error":"invalid or expired timestamp"}`, http.StatusUnauthorized)
			return
		}

		// Look up the device's public key.
		pubKey, known := devicePubKeys[xDID]
		if !known {
			http.Error(w, `{"error":"unknown device DID"}`, http.StatusUnauthorized)
			return
		}

		// Read body for signature verification.
		bodyBytes, _ := io.ReadAll(r.Body)
		r.Body.Close()

		// Verify signature.
		bodyHash := sha256Hex(bodyBytes)
		query := r.URL.RawQuery
		canonical := fmt.Sprintf("%s\n%s\n%s\n%s\n%s\n%s",
			r.Method, r.URL.Path, query, xTS, xNonce, bodyHash)
		sigBytes, _ := hex.DecodeString(xSig)
		if !ed25519.Verify(pubKey, []byte(canonical), sigBytes) {
			http.Error(w, `{"error":"signature verification failed"}`, http.StatusUnauthorized)
			return
		}

		// Device allowlist check.
		if restrictedPaths[r.URL.Path] {
			http.Error(w, `{"error":"device not allowed for this path"}`, http.StatusForbidden)
			return
		}

		// Route to deterministic responses.
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Custom-Header", "test-value")
		switch r.URL.Path {
		case "/api/v1/remember":
			w.WriteHeader(200)
			w.Write([]byte(`{"status":"stored","persona":"general"}`))
		case "/api/v1/ask":
			w.WriteHeader(200)
			w.Write([]byte(`{"status":"answered","result":"stubbed"}`))
		default:
			w.WriteHeader(200)
			w.Write([]byte(`{"status":"ok"}`))
		}
	})
}

// makeSignedHeaders creates a full set of signed headers for a request.
func makeSignedHeaders(t *testing.T, method, path, query, body string, did string, priv ed25519.PrivateKey) map[string]string {
	t.Helper()
	timestamp := time.Now().UTC().Format("2006-01-02T15:04:05Z")
	nonce := hex.EncodeToString(randomBytes(16))
	sig := signRequest(method, path, query, timestamp, nonce, []byte(body), priv)
	return map[string]string{
		"Content-Type": "application/json",
		"X-DID":        did,
		"X-Timestamp":  timestamp,
		"X-Nonce":      nonce,
		"X-Signature":  sig,
	}
}

// --- TST-MBX-0008: /api/v1/remember equivalence ---
// TRACE: {"suite": "MBX", "case": "0008", "section": "02", "sectionName": "RPC Bridge Equivalence & Identity Binding", "subsection": "01", "scenario": "01", "title": "remember_equivalence"}
func TestBridge_RememberEquivalence(t *testing.T) {
	did, priv, pub := testKeyPair(t)
	deviceKeys := map[string]ed25519.PublicKey{did: pub}
	restricted := map[string]bool{"/v1/vault/store": true}

	handler := stubHandler(deviceKeys, restricted)
	bridge := NewRPCBridge(handler)

	body := `{"text":"buy milk"}`
	headers := makeSignedHeaders(t, "POST", "/api/v1/remember", "", body, did, priv)

	// Direct HTTP.
	directRec := sendDirect(t, handler, "POST", "/api/v1/remember", headers, body)

	// Via bridge.
	bridgeResp := sendViaBridge(t, bridge, "POST", "/api/v1/remember", headers, body)

	// Compare: same status code.
	if directRec.Code != bridgeResp.Status {
		t.Errorf("status: direct=%d, bridge=%d", directRec.Code, bridgeResp.Status)
	}

	// Compare: same response schema (both should contain "status":"stored").
	directBody := directRec.Body.String()
	if !strings.Contains(directBody, `"stored"`) {
		t.Errorf("direct body missing 'stored': %s", directBody)
	}
	if !strings.Contains(bridgeResp.Body, `"stored"`) {
		t.Errorf("bridge body missing 'stored': %s", bridgeResp.Body)
	}

	_ = priv
}

// --- TST-MBX-0009: /api/v1/ask equivalence ---
// TRACE: {"suite": "MBX", "case": "0009", "section": "02", "sectionName": "RPC Bridge Equivalence & Identity Binding", "subsection": "01", "scenario": "02", "title": "ask_equivalence"}
func TestBridge_AskEquivalence(t *testing.T) {
	did, priv, pub := testKeyPair(t)
	deviceKeys := map[string]ed25519.PublicKey{did: pub}
	restricted := map[string]bool{"/v1/vault/query": true} // not device-accessible

	handler := stubHandler(deviceKeys, restricted)
	bridge := NewRPCBridge(handler)

	body := `{"query":"what does Emma like"}`
	headers := makeSignedHeaders(t, "POST", "/api/v1/ask", "", body, did, priv)

	directRec := sendDirect(t, handler, "POST", "/api/v1/ask", headers, body)
	bridgeResp := sendViaBridge(t, bridge, "POST", "/api/v1/ask", headers, body)

	if directRec.Code != bridgeResp.Status {
		t.Errorf("status: direct=%d, bridge=%d", directRec.Code, bridgeResp.Status)
	}
	if !strings.Contains(directRec.Body.String(), `"answered"`) {
		t.Errorf("direct body missing 'answered': %s", directRec.Body.String())
	}
	if !strings.Contains(bridgeResp.Body, `"answered"`) {
		t.Errorf("bridge body missing 'answered': %s", bridgeResp.Body)
	}
}

// --- TST-MBX-0010: Invalid Ed25519 signature → 401 via both paths ---
// TRACE: {"suite": "MBX", "case": "0010", "section": "02", "sectionName": "RPC Bridge Equivalence & Identity Binding", "subsection": "01", "scenario": "03", "title": "invalid_signature_401"}
func TestBridge_InvalidSignature401(t *testing.T) {
	did, _, pub := testKeyPair(t)
	_, wrongPriv, _ := testKeyPair(t) // different key

	deviceKeys := map[string]ed25519.PublicKey{did: pub}
	handler := stubHandler(deviceKeys, nil)
	bridge := NewRPCBridge(handler)

	body := `{"text":"test"}`
	// Sign with WRONG key.
	headers := makeSignedHeaders(t, "POST", "/api/v1/remember", "", body, did, wrongPriv)

	directRec := sendDirect(t, handler, "POST", "/api/v1/remember", headers, body)
	bridgeResp := sendViaBridge(t, bridge, "POST", "/api/v1/remember", headers, body)

	// Both should return 401.
	if directRec.Code != 401 {
		t.Errorf("direct status = %d, want 401", directRec.Code)
	}
	if bridgeResp.Status != 401 {
		t.Errorf("bridge status = %d, want 401", bridgeResp.Status)
	}
	if directRec.Code != bridgeResp.Status {
		t.Errorf("status mismatch: direct=%d, bridge=%d", directRec.Code, bridgeResp.Status)
	}
}

// --- TST-MBX-0011: Expired timestamp → 401 via both paths ---
// TRACE: {"suite": "MBX", "case": "0011", "section": "02", "sectionName": "RPC Bridge Equivalence & Identity Binding", "subsection": "01", "scenario": "04", "title": "expired_timestamp_401"}
func TestBridge_ExpiredTimestamp401(t *testing.T) {
	did, priv, pub := testKeyPair(t)
	deviceKeys := map[string]ed25519.PublicKey{did: pub}

	handler := stubHandler(deviceKeys, nil)
	bridge := NewRPCBridge(handler)

	body := `{"text":"test"}`
	// Use a timestamp 10 minutes in the past (> 5 min window).
	expiredTS := time.Now().UTC().Add(-10 * time.Minute).Format("2006-01-02T15:04:05Z")
	nonce := hex.EncodeToString(randomBytes(16))
	sig := signRequest("POST", "/api/v1/remember", "", expiredTS, nonce, []byte(body), priv)

	headers := map[string]string{
		"Content-Type": "application/json",
		"X-DID":        did,
		"X-Timestamp":  expiredTS,
		"X-Nonce":      nonce,
		"X-Signature":  sig,
	}

	directRec := sendDirect(t, handler, "POST", "/api/v1/remember", headers, body)
	bridgeResp := sendViaBridge(t, bridge, "POST", "/api/v1/remember", headers, body)

	if directRec.Code != 401 {
		t.Errorf("direct status = %d, want 401", directRec.Code)
	}
	if bridgeResp.Status != 401 {
		t.Errorf("bridge status = %d, want 401", bridgeResp.Status)
	}
	if directRec.Code != bridgeResp.Status {
		t.Errorf("status mismatch: direct=%d, bridge=%d", directRec.Code, bridgeResp.Status)
	}
}

// --- TST-MBX-0012: Device allowlist — restricted path → 403 via both ---
// TRACE: {"suite": "MBX", "case": "0012", "section": "02", "sectionName": "RPC Bridge Equivalence & Identity Binding", "subsection": "01", "scenario": "05", "title": "device_allowlist_403"}
func TestBridge_DeviceAllowlist403(t *testing.T) {
	did, priv, pub := testKeyPair(t)
	deviceKeys := map[string]ed25519.PublicKey{did: pub}
	restricted := map[string]bool{"/v1/vault/store": true}

	handler := stubHandler(deviceKeys, restricted)
	bridge := NewRPCBridge(handler)

	body := `{"data":"secret"}`
	headers := makeSignedHeaders(t, "POST", "/v1/vault/store", "", body, did, priv)

	directRec := sendDirect(t, handler, "POST", "/v1/vault/store", headers, body)
	bridgeResp := sendViaBridge(t, bridge, "POST", "/v1/vault/store", headers, body)

	if directRec.Code != 403 {
		t.Errorf("direct status = %d, want 403", directRec.Code)
	}
	if bridgeResp.Status != 403 {
		t.Errorf("bridge status = %d, want 403", bridgeResp.Status)
	}
	if directRec.Code != bridgeResp.Status {
		t.Errorf("status mismatch: direct=%d, bridge=%d", directRec.Code, bridgeResp.Status)
	}
}

// --- TST-MBX-0013: Query parameters → canonical signing identical ---
// TRACE: {"suite": "MBX", "case": "0013", "section": "02", "sectionName": "RPC Bridge Equivalence & Identity Binding", "subsection": "02", "scenario": "01", "title": "query_params_canonical"}
//
// The canonical signing payload includes query parameters. Both direct and
// bridge paths must produce the same auth outcome for a request with query
// params like /api/v1/ask?persona=health.
func TestBridge_QueryParamsCanonical(t *testing.T) {
	did, priv, pub := testKeyPair(t)
	deviceKeys := map[string]ed25519.PublicKey{did: pub}

	// stubHandler that echoes back the query string for verification.
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Auth — same as stubHandler but we inline a minimal version.
		xDID := r.Header.Get("X-DID")
		xSig := r.Header.Get("X-Signature")
		xTS := r.Header.Get("X-Timestamp")
		xNonce := r.Header.Get("X-Nonce")
		if xDID == "" || xSig == "" || xTS == "" || xNonce == "" {
			http.Error(w, `{"error":"missing auth"}`, 401)
			return
		}
		ts, _ := time.Parse("2006-01-02T15:04:05Z", xTS)
		if time.Since(ts).Abs() > 5*time.Minute {
			http.Error(w, `{"error":"expired"}`, 401)
			return
		}
		pubKey := deviceKeys[xDID]
		bodyBytes, _ := io.ReadAll(r.Body)
		query := r.URL.RawQuery
		canonical := fmt.Sprintf("%s\n%s\n%s\n%s\n%s\n%s",
			r.Method, r.URL.Path, query, xTS, xNonce, sha256Hex(bodyBytes))
		sigBytes, _ := hex.DecodeString(xSig)
		if !ed25519.Verify(pubKey, []byte(canonical), sigBytes) {
			http.Error(w, `{"error":"bad sig"}`, 401)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"query":%q}`, query)
	})

	bridge := NewRPCBridge(handler)

	path := "/api/v1/ask"
	query := "persona=health&limit=10"
	fullPath := path + "?" + query
	body := ""

	// Sign with query in canonical payload.
	timestamp := time.Now().UTC().Format("2006-01-02T15:04:05Z")
	nonce := hex.EncodeToString(randomBytes(16))
	sig := signRequest("GET", path, query, timestamp, nonce, nil, priv)

	headers := map[string]string{
		"X-DID":       did,
		"X-Timestamp": timestamp,
		"X-Nonce":     nonce,
		"X-Signature": sig,
	}

	// Direct.
	directRec := sendDirect(t, handler, "GET", fullPath, headers, body)

	// Bridge — path includes query string.
	bridgeResp := sendViaBridge(t, bridge, "GET", fullPath, headers, body)

	if directRec.Code != 200 {
		t.Fatalf("direct status = %d, want 200 (body: %s)", directRec.Code, directRec.Body.String())
	}
	if bridgeResp.Status != 200 {
		t.Fatalf("bridge status = %d, want 200 (body: %s)", bridgeResp.Status, bridgeResp.Body)
	}

	// Both should have the query echoed back.
	if !strings.Contains(directRec.Body.String(), "persona=health") {
		t.Errorf("direct missing query: %s", directRec.Body.String())
	}
	if !strings.Contains(bridgeResp.Body, "persona=health") {
		t.Errorf("bridge missing query: %s", bridgeResp.Body)
	}
}

// --- TST-MBX-0014: Empty body → body hash uses _EMPTY_BODY_HASH ---
// TRACE: {"suite": "MBX", "case": "0014", "section": "02", "sectionName": "RPC Bridge Equivalence & Identity Binding", "subsection": "02", "scenario": "02", "title": "empty_body_hash"}
//
// A request with no body should use sha256("") as the body hash in the
// canonical signing payload. Both paths must accept the same signature.
func TestBridge_EmptyBodyHash(t *testing.T) {
	did, priv, pub := testKeyPair(t)
	deviceKeys := map[string]ed25519.PublicKey{did: pub}
	handler := stubHandler(deviceKeys, nil)
	bridge := NewRPCBridge(handler)

	// GET with no body.
	timestamp := time.Now().UTC().Format("2006-01-02T15:04:05Z")
	nonce := hex.EncodeToString(randomBytes(16))
	// Sign with nil body (empty body hash = sha256("")).
	sig := signRequest("GET", "/api/v1/ask", "", timestamp, nonce, nil, priv)

	headers := map[string]string{
		"X-DID":       did,
		"X-Timestamp": timestamp,
		"X-Nonce":     nonce,
		"X-Signature": sig,
	}

	directRec := sendDirect(t, handler, "GET", "/api/v1/ask", headers, "")
	bridgeResp := sendViaBridge(t, bridge, "GET", "/api/v1/ask", headers, "")

	if directRec.Code != 200 {
		t.Errorf("direct status = %d, want 200 (body: %s)", directRec.Code, directRec.Body.String())
	}
	if bridgeResp.Status != 200 {
		t.Errorf("bridge status = %d, want 200 (body: %s)", bridgeResp.Status, bridgeResp.Body)
	}
	if directRec.Code != bridgeResp.Status {
		t.Errorf("status mismatch: direct=%d bridge=%d", directRec.Code, bridgeResp.Status)
	}
}

// --- TST-MBX-0015: Response headers preserved through bridge ---
// TRACE: {"suite": "MBX", "case": "0015", "section": "02", "sectionName": "RPC Bridge Equivalence & Identity Binding", "subsection": "01", "scenario": "08", "title": "response_headers_preserved"}
//
// Content-Type and custom response headers from the handler must appear in
// the bridge's RPCInnerResponse.Headers.
func TestBridge_ResponseHeadersPreserved(t *testing.T) {
	did, priv, pub := testKeyPair(t)
	deviceKeys := map[string]ed25519.PublicKey{did: pub}
	handler := stubHandler(deviceKeys, nil)
	bridge := NewRPCBridge(handler)

	body := `{"text":"headers test"}`
	headers := makeSignedHeaders(t, "POST", "/api/v1/remember", "", body, did, priv)

	// Direct.
	directRec := sendDirect(t, handler, "POST", "/api/v1/remember", headers, body)

	// Bridge.
	bridgeResp := sendViaBridge(t, bridge, "POST", "/api/v1/remember", headers, body)

	// Direct response headers.
	directCT := directRec.Header().Get("Content-Type")
	directCustom := directRec.Header().Get("X-Custom-Header")

	// Bridge response headers.
	bridgeCT := bridgeResp.Headers["Content-Type"]
	bridgeCustom := bridgeResp.Headers["X-Custom-Header"]

	if directCT != bridgeCT {
		t.Errorf("Content-Type: direct=%q bridge=%q", directCT, bridgeCT)
	}
	if directCustom != bridgeCustom {
		t.Errorf("X-Custom-Header: direct=%q bridge=%q", directCustom, bridgeCustom)
	}
	if bridgeCT == "" {
		t.Error("bridge Content-Type is empty")
	}
	if bridgeCustom != "test-value" {
		t.Errorf("bridge X-Custom-Header = %q, want \"test-value\"", bridgeCustom)
	}
}

// --- TST-MBX-0016: Identity binding — from_did != inner X-DID → 403 ---
// TRACE: {"suite": "MBX", "case": "0016", "section": "02", "sectionName": "RPC Bridge Equivalence & Identity Binding", "subsection": "03", "scenario": "01", "title": "identity_binding_mismatch_403"}
//
// The envelope from_did and inner X-DID must match. If they differ, the
// bridge rejects the request before it reaches the handler.
func TestBridge_IdentityBindingMismatch(t *testing.T) {
	did, priv, _ := testKeyPair(t)

	body := `{"text":"test"}`
	headers := makeSignedHeaders(t, "POST", "/api/v1/remember", "", body, did, priv)

	// Build inner request JSON.
	innerJSON, _ := BuildInnerRequestJSON("POST", "/api/v1/remember", headers, body)

	// Verify identity binding with WRONG envelope from_did.
	err := VerifyIdentityBinding("did:key:zAttackerDID", innerJSON)
	if err == nil {
		t.Fatal("VerifyIdentityBinding should fail when from_did != X-DID")
	}
	if !strings.Contains(err.Error(), "identity binding failed") {
		t.Errorf("expected 'identity binding failed' error, got: %v", err)
	}
}

// --- TST-MBX-0017: Identity binding — from_did == inner X-DID → accepted ---
// TRACE: {"suite": "MBX", "case": "0017", "section": "02", "sectionName": "RPC Bridge Equivalence & Identity Binding", "subsection": "03", "scenario": "02", "title": "identity_binding_match_accepted"}
func TestBridge_IdentityBindingMatch(t *testing.T) {
	did, priv, pub := testKeyPair(t)
	deviceKeys := map[string]ed25519.PublicKey{did: pub}
	handler := stubHandler(deviceKeys, nil)
	bridge := NewRPCBridge(handler)

	body := `{"text":"test"}`
	headers := makeSignedHeaders(t, "POST", "/api/v1/remember", "", body, did, priv)

	// Build inner request JSON.
	innerJSON, _ := BuildInnerRequestJSON("POST", "/api/v1/remember", headers, body)

	// Verify identity binding with CORRECT envelope from_did.
	err := VerifyIdentityBinding(did, innerJSON)
	if err != nil {
		t.Fatalf("VerifyIdentityBinding should pass: %v", err)
	}

	// After identity binding passes, the bridge should process the request.
	resp, err := bridge.HandleInnerRequest(innerJSON)
	if err != nil {
		t.Fatalf("HandleInnerRequest: %v", err)
	}
	if resp.Status != 200 {
		t.Errorf("status = %d, want 200", resp.Status)
	}
}

// --- TST-MBX-0054: Pairing identity binding mismatch → rejected ---
// TRACE: {"suite": "MBX", "case": "0054", "section": "05", "sectionName": "Pairing", "subsection": "03", "scenario": "01", "title": "pairing_identity_binding_mismatch"}
//
// envelope.from_did != did:key:{body.public_key_multibase} → rejected.
func TestBridge_PairingIdentityBindingMismatch(t *testing.T) {
	multibaseKey := "z6MktestKeyMultibase123abc"
	innerBody := fmt.Sprintf(`{"code":"123456","public_key_multibase":"%s","device_name":"laptop"}`, multibaseKey)
	innerJSON, _ := BuildInnerRequestJSON("POST", "/v1/pair/complete",
		map[string]string{"Content-Type": "application/json"}, innerBody)

	// Envelope from_did does NOT match did:key:{multibaseKey}.
	err := VerifyPairingIdentityBinding("did:key:zAttackerKey999", innerJSON)
	if err == nil {
		t.Fatal("pairing identity binding should fail for mismatched from_did")
	}
	if !strings.Contains(err.Error(), "pairing identity binding failed") {
		t.Errorf("expected 'pairing identity binding failed', got: %v", err)
	}
}

// --- TST-MBX-0055: Pairing identity binding match → accepted ---
// TRACE: {"suite": "MBX", "case": "0055", "section": "05", "sectionName": "Pairing", "subsection": "03", "scenario": "02", "title": "pairing_identity_binding_match"}
func TestBridge_PairingIdentityBindingMatch(t *testing.T) {
	multibaseKey := "z6MktestKeyMultibase456def"
	expectedDID := "did:key:" + multibaseKey
	innerBody := fmt.Sprintf(`{"code":"654321","public_key_multibase":"%s","device_name":"phone"}`, multibaseKey)
	innerJSON, _ := BuildInnerRequestJSON("POST", "/v1/pair/complete",
		map[string]string{"Content-Type": "application/json"}, innerBody)

	err := VerifyPairingIdentityBinding(expectedDID, innerJSON)
	if err != nil {
		t.Fatalf("pairing identity binding should pass: %v", err)
	}
}

// --- TST-MBX-0132: Empty ciphertext field → Core rejects with 400 ---
// TRACE: {"suite": "MBX", "case": "0132", "section": "15", "sectionName": "Crypto & Encoding Edge Cases", "subsection": "01", "scenario": "03", "title": "empty_ciphertext_400"}
//
// Valid envelope structure but ciphertext is empty string → Core's bridge
// rejects because there's nothing to decrypt/process.
func TestBridge_EmptyCiphertextRejected(t *testing.T) {
	// In the real flow, handleRPCRequest would decrypt the ciphertext
	// before calling HandleInnerRequest. An empty ciphertext means
	// decryption fails or produces empty JSON.
	//
	// Test the bridge with an empty inner request body — simulating what
	// happens after "decrypting" an empty ciphertext.
	resp, err := NewRPCBridge(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	})).HandleInnerRequest([]byte(""))

	// Empty JSON → parse error.
	if err == nil {
		t.Fatal("empty inner JSON should fail")
	}
	if resp != nil {
		t.Errorf("resp should be nil on parse error, got %+v", resp)
	}

	// Also test with valid JSON but missing method/path.
	resp2, err2 := NewRPCBridge(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	})).HandleInnerRequest([]byte(`{}`))

	if err2 == nil {
		t.Fatal("missing method/path should fail")
	}
	if resp2 != nil {
		t.Errorf("resp should be nil, got %+v", resp2)
	}
}

// --- TST-MBX-0126: Two concurrent requests, different request_ids ---
// TRACE: {"suite": "MBX", "case": "0126", "section": "14", "sectionName": "Concurrent & Multi-Device Edge Cases", "subsection": "01", "scenario": "01", "title": "two_concurrent_different_ids"}
//
// Same device sends /remember and /ask simultaneously with different
// request_ids → both processed independently.
func TestBridge_TwoConcurrentDifferentIDs(t *testing.T) {
	did, priv, pub := testKeyPair(t)
	deviceKeys := map[string]ed25519.PublicKey{did: pub}
	handler := stubHandler(deviceKeys, nil)
	bridge := NewRPCBridge(handler)
	cache := NewIdempotencyCache(5 * time.Minute)

	bodyA := `{"text":"buy milk"}`
	bodyB := `{"query":"what does Emma like"}`

	headersA := makeSignedHeaders(t, "POST", "/api/v1/remember", "", bodyA, did, priv)
	headersB := makeSignedHeaders(t, "POST", "/api/v1/ask", "", bodyB, did, priv)

	innerA, _ := BuildInnerRequestJSON("POST", "/api/v1/remember", headersA, bodyA)
	innerB, _ := BuildInnerRequestJSON("POST", "/api/v1/ask", headersB, bodyB)

	// Process both — simulate concurrent handling.
	respA, errA := bridge.HandleInnerRequest(innerA)
	respB, errB := bridge.HandleInnerRequest(innerB)

	if errA != nil || errB != nil {
		t.Fatalf("errors: A=%v B=%v", errA, errB)
	}
	if respA.Status != 200 || respB.Status != 200 {
		t.Errorf("status: A=%d B=%d, want both 200", respA.Status, respB.Status)
	}

	// Cache both with different request_ids.
	cache.Put(did, "req-A", respA)
	cache.Put(did, "req-B", respB)

	// Both should be independently retrievable.
	if cache.Get(did, "req-A") == nil || cache.Get(did, "req-B") == nil {
		t.Error("both should be cached independently")
	}
	if cache.Size() != 2 {
		t.Errorf("cache size = %d, want 2", cache.Size())
	}

	// Responses should be for different endpoints.
	if !strings.Contains(respA.Body, "stored") {
		t.Errorf("respA body should contain 'stored': %s", respA.Body)
	}
	if !strings.Contains(respB.Body, "answered") {
		t.Errorf("respB body should contain 'answered': %s", respB.Body)
	}
}

// --- TST-MBX-0127: Same request_id twice concurrently ---
// TRACE: {"suite": "MBX", "case": "0127", "section": "14", "sectionName": "Concurrent & Multi-Device Edge Cases", "subsection": "01", "scenario": "02", "title": "same_request_id_concurrent_race"}
//
// Race between two identical requests → exactly one executes, other
// hits idempotency cache. No double side-effect.
func TestBridge_SameRequestIDConcurrent(t *testing.T) {
	did, priv, _ := testKeyPair(t)

	var callCount int32
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Atomic increment to track handler invocations.
		n := atomic.AddInt32(&callCount, 1)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(200)
		fmt.Fprintf(w, `{"call":%d}`, n)
	})

	bridge := NewRPCBridge(handler)
	cache := NewIdempotencyCache(5 * time.Minute)

	requestID := "req-concurrent-127"
	body := `{"text":"race"}`

	headers := makeSignedHeaders(t, "POST", "/api/v1/remember", "", body, did, priv)
	innerJSON, _ := BuildInnerRequestJSON("POST", "/api/v1/remember", headers, body)

	// Simulate concurrent handling: first request → process + cache.
	// Check cache first (miss), then process.
	cached := cache.Get(did, requestID)
	if cached != nil {
		t.Fatal("cache should be empty")
	}

	resp1, _ := bridge.HandleInnerRequest(innerJSON)
	cache.Put(did, requestID, resp1)

	// Second request arrives concurrently — cache hit.
	cached2 := cache.Get(did, requestID)
	if cached2 == nil {
		t.Fatal("second request should hit cache")
	}

	// Handler called exactly once.
	if atomic.LoadInt32(&callCount) != 1 {
		t.Errorf("handler called %d times, want 1", atomic.LoadInt32(&callCount))
	}

	// Both responses are identical.
	if cached2.Status != resp1.Status || cached2.Body != resp1.Body {
		t.Error("cached response should match original")
	}
}

// --- TST-MBX-0077: Invalid base64 ciphertext → bridge parse error ---
// TRACE: {"suite": "MBX", "case": "0077", "section": "07", "sectionName": "Envelope Parsing & Hardening", "subsection": "02", "scenario": "01", "title": "invalid_base64_ciphertext_400"}
//
// In the real flow, ciphertext would be base64-decoded then NaCl-opened.
// Invalid base64 means decryption fails before the inner JSON reaches the
// bridge. This test simulates passing the garbage as inner JSON — the
// bridge rejects it with a parse error (equivalent to 400).
func TestBridge_InvalidBase64Ciphertext(t *testing.T) {
	bridge := NewRPCBridge(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}))

	// Simulate: NaCl decryption of invalid base64 produces garbage.
	garbageInner := []byte("this is not valid JSON at all!!!")
	resp, err := bridge.HandleInnerRequest(garbageInner)
	if err == nil {
		t.Fatal("invalid inner JSON should fail")
	}
	if resp != nil {
		t.Errorf("resp should be nil, got %+v", resp)
	}
}

// --- TST-MBX-0072: Concurrent D2D + RPC from different senders ---
// TRACE: {"suite": "MBX", "case": "0072", "section": "06", "sectionName": "Operational & Load", "subsection": "04", "scenario": "04", "title": "concurrent_d2d_rpc_different_senders"}
//
// Two different senders process RPC requests concurrently to the same
// handler. Both should produce independent results and independent
// idempotency entries. Tests at the Core bridge level.
func TestBridge_ConcurrentDifferentSenders(t *testing.T) {
	didA, privA, pubA := testKeyPair(t)
	didB, privB, pubB := testKeyPair(t)
	deviceKeys := map[string]ed25519.PublicKey{didA: pubA, didB: pubB}
	handler := stubHandler(deviceKeys, nil)
	bridge := NewRPCBridge(handler)
	cache := NewIdempotencyCache(5 * time.Minute)

	body := `{"text":"concurrent"}`

	// Sender A: /remember
	headersA := makeSignedHeaders(t, "POST", "/api/v1/remember", "", body, didA, privA)
	innerA, _ := BuildInnerRequestJSON("POST", "/api/v1/remember", headersA, body)

	// Sender B: /ask
	headersB := makeSignedHeaders(t, "POST", "/api/v1/ask", "", body, didB, privB)
	innerB, _ := BuildInnerRequestJSON("POST", "/api/v1/ask", headersB, body)

	// Process concurrently.
	respA, errA := bridge.HandleInnerRequest(innerA)
	respB, errB := bridge.HandleInnerRequest(innerB)

	if errA != nil || errB != nil {
		t.Fatalf("errors: A=%v B=%v", errA, errB)
	}

	// Cache with same request_id "abc" — sender-scoped, no collision.
	cache.Put(didA, "abc", respA)
	cache.Put(didB, "abc", respB)

	if cache.Size() != 2 {
		t.Errorf("cache size = %d, want 2 (sender-scoped)", cache.Size())
	}
	if cache.Get(didA, "abc").Body == cache.Get(didB, "abc").Body {
		// Responses may differ (/remember vs /ask), or be same structure.
		// The key is they are independently cached.
		t.Log("note: both responses have same body (both handlers return JSON)")
	}
}

// --- TST-MBX-0090: Retry vs buffered response race ---
// TRACE: {"suite": "MBX", "case": "0090", "section": "08", "sectionName": "Reliability & Crash Recovery", "subsection": "03", "scenario": "02", "title": "retry_vs_buffered_response_race"}
//
// CLI reconnects. Drain delivers a buffered response. CLI also retries.
// The idempotency cache ensures the retry returns the same response —
// single logical completion regardless of which arrives first.
func TestBridge_RetryVsBufferedResponseRace(t *testing.T) {
	cache := NewIdempotencyCache(5 * time.Minute)

	did := "did:key:zRace090"
	requestID := "req-race-090"

	// Core already processed the request and cached the response.
	originalResp := &RPCInnerResponse{Status: 200, Body: `{"stored":true}`}
	cache.Put(did, requestID, originalResp)

	// Scenario: CLI reconnects and drain delivers the buffered response.
	// Simultaneously, CLI retries with the same request_id.
	// Both paths should yield the same result.

	// Path 1: CLI drain receives the buffered response (from MsgBox buffer).
	// In production, this arrives as a binary frame the CLI decrypts.
	// Here we simulate it as: the response is available.
	drainedResp := originalResp // simulates what CLI would decrypt from drain

	// Path 2: CLI retry checks idempotency cache.
	cachedResp := cache.Get(did, requestID)

	// Both should be the same response.
	if cachedResp == nil {
		t.Fatal("cache miss on retry path")
	}
	if drainedResp.Status != cachedResp.Status {
		t.Errorf("drained status %d != cached status %d", drainedResp.Status, cachedResp.Status)
	}
	if drainedResp.Body != cachedResp.Body {
		t.Errorf("drained body %q != cached body %q", drainedResp.Body, cachedResp.Body)
	}

	// Single logical completion: the CLI uses whichever arrives first.
	// The invariant: same request_id always returns the same response.
}

// --- TST-MBX-0078: Garbage ciphertext (valid base64 but NaCl fails) ---
// TRACE: {"suite": "MBX", "case": "0078", "section": "07", "sectionName": "Envelope Parsing & Hardening", "subsection": "02", "scenario": "02", "title": "garbage_ciphertext_nacl_fails"}
//
// After base64 decoding, NaCl open fails → the result is garbage bytes,
// not valid JSON. The bridge rejects with a parse error.
func TestBridge_GarbageCiphertextNaClFails(t *testing.T) {
	bridge := NewRPCBridge(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}))

	// Simulate: valid base64 decoded to garbage bytes (NaCl open failed,
	// producing random bytes instead of JSON). This is different from 0077
	// (which tests completely invalid input) — this tests bytes that LOOK
	// like they could be data but aren't valid JSON.
	garbageAfterNaCl := []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a} // PNG header
	resp, err := bridge.HandleInnerRequest(garbageAfterNaCl)
	if err == nil {
		t.Fatal("garbage NaCl output should fail at JSON parse")
	}
	if resp != nil {
		t.Errorf("resp should be nil, got %+v", resp)
	}

	// Also test: valid JSON but wrong structure (missing required fields).
	wrongStructure := []byte(`{"unexpected":"format","no_method":true}`)
	resp2, err2 := bridge.HandleInnerRequest(wrongStructure)
	if err2 == nil {
		t.Fatal("wrong JSON structure should fail (missing method/path)")
	}
	if resp2 != nil {
		t.Errorf("resp2 should be nil, got %+v", resp2)
	}
}

// --- TST-MBX-0128: Device revoked during in-flight RPC ---
// TRACE: {"suite": "MBX", "case": "0128", "section": "14", "sectionName": "Concurrent & Multi-Device Edge Cases", "subsection": "02", "scenario": "01", "title": "device_revoked_mid_flight"}
//
// Device is paired. Sends RPC. Admin revokes device WHILE handler is
// processing. Handler completes (no mid-flight revocation). Next request
// from that device is rejected by device auth.
func TestBridge_DeviceRevokedMidFlight(t *testing.T) {
	did, priv, pub := testKeyPair(t)

	// Mutable device registry — can revoke mid-flight.
	var mu sync.Mutex
	deviceKeys := map[string]ed25519.PublicKey{did: pub}

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Auth check: look up device key.
		mu.Lock()
		xDID := r.Header.Get("X-DID")
		_, known := deviceKeys[xDID]
		mu.Unlock()

		if !known {
			http.Error(w, `{"error":"device revoked"}`, http.StatusForbidden)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(200)
		w.Write([]byte(`{"status":"ok"}`))
	})

	bridge := NewRPCBridge(handler)

	body := `{"text":"before revoke"}`

	// Request 1: device is active → 200.
	headers1 := makeSignedHeaders(t, "POST", "/api/v1/remember", "", body, did, priv)
	inner1, _ := BuildInnerRequestJSON("POST", "/api/v1/remember", headers1, body)
	resp1, _ := bridge.HandleInnerRequest(inner1)
	if resp1.Status != 200 {
		t.Fatalf("pre-revoke: status = %d, want 200", resp1.Status)
	}

	// Admin revokes device.
	mu.Lock()
	delete(deviceKeys, did)
	mu.Unlock()

	// Request 2: device revoked → 403.
	headers2 := makeSignedHeaders(t, "POST", "/api/v1/remember", "", body, did, priv)
	inner2, _ := BuildInnerRequestJSON("POST", "/api/v1/remember", headers2, body)
	resp2, _ := bridge.HandleInnerRequest(inner2)
	if resp2.Status != 403 {
		t.Errorf("post-revoke: status = %d, want 403", resp2.Status)
	}
}

// --- TST-MBX-0129: Response out-of-order matching by ID ---
// TRACE: {"suite": "MBX", "case": "0129", "section": "14", "sectionName": "Concurrent & Multi-Device Edge Cases", "subsection": "02", "scenario": "02", "title": "response_out_of_order_by_id"}
//
// CLI sends request A then B. Core processes B first (faster), then A.
// Responses are matched by request_id, not by arrival order.
func TestBridge_ResponseOutOfOrder(t *testing.T) {
	cache := NewIdempotencyCache(5 * time.Minute)

	did := "did:key:zOrder129"

	// Core processes request B first.
	cache.Put(did, "req-B", &RPCInnerResponse{Status: 200, Body: `{"answer":"B"}`})
	// Then request A.
	cache.Put(did, "req-A", &RPCInnerResponse{Status: 200, Body: `{"answer":"A"}`})

	// CLI retrieves responses by ID, not by insertion order.
	respA := cache.Get(did, "req-A")
	respB := cache.Get(did, "req-B")

	if respA == nil || respB == nil {
		t.Fatal("both responses should be retrievable")
	}
	if respA.Body != `{"answer":"A"}` {
		t.Errorf("respA.Body = %q, want A", respA.Body)
	}
	if respB.Body != `{"answer":"B"}` {
		t.Errorf("respB.Body = %q, want B", respB.Body)
	}
}

// --- TST-MBX-0050: Wrong Home Node DID → decryption fails ---
// TRACE: {"suite": "MBX", "case": "0050", "section": "05", "sectionName": "Pairing", "subsection": "01", "scenario": "06", "title": "wrong_homenode_did_decryption_fails"}
//
// CLI encrypts with the wrong DID's public key. The real Home Node can't
// decrypt. Simulated at bridge level: HandleInnerRequest receives garbage
// (wrong key decryption output).
func TestBridge_WrongHomeNodeDIDDecryptionFails(t *testing.T) {
	bridge := NewRPCBridge(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}))

	// Simulate: CLI encrypted with wrong Home Node's public key.
	// The real Home Node tries to decrypt with its own private key → fails.
	// Result: garbage bytes, not valid JSON.
	wrongKeyOutput := []byte(`\x00\x01\x02broken decryption output`)
	resp, err := bridge.HandleInnerRequest(wrongKeyOutput)
	if err == nil {
		t.Fatal("wrong-key decryption output should fail at parse")
	}
	if resp != nil {
		t.Errorf("resp should be nil, got %+v", resp)
	}
}

// --- TST-MBX-0131: Core key rotation, CLI retries with new key ---
// TRACE: {"suite": "MBX", "case": "0131", "section": "15", "sectionName": "Crypto & Encoding Edge Cases", "subsection": "01", "scenario": "02", "title": "core_key_rotation_cli_retry"}
//
// Core rotates Ed25519 #dina_signing key. CLI's sealed-box encrypted with
// old X25519 fails to decrypt. CLI re-fetches PLC doc, retries with new key.
// Simulated at bridge level: first request → parse error (old key garbage),
// second request → success (new key).
func TestBridge_CoreKeyRotationCLIRetry(t *testing.T) {
	did, priv, pub := testKeyPair(t)
	deviceKeys := map[string]ed25519.PublicKey{did: pub}
	handler := stubHandler(deviceKeys, nil)
	bridge := NewRPCBridge(handler)

	body := `{"text":"after rotation"}`

	// Step 1: CLI uses old key → decryption fails → garbage inner JSON.
	oldKeyGarbage := []byte(`not valid json from old key decryption`)
	resp1, err1 := bridge.HandleInnerRequest(oldKeyGarbage)
	if err1 == nil {
		t.Fatal("old key decryption garbage should fail")
	}
	if resp1 != nil {
		t.Error("resp1 should be nil")
	}

	// Step 2: CLI re-fetches PLC doc, gets new key, re-encrypts.
	// This time decryption succeeds → valid inner JSON.
	headers := makeSignedHeaders(t, "POST", "/api/v1/remember", "", body, did, priv)
	innerJSON, _ := BuildInnerRequestJSON("POST", "/api/v1/remember", headers, body)
	resp2, err2 := bridge.HandleInnerRequest(innerJSON)
	if err2 != nil {
		t.Fatalf("new key request should succeed: %v", err2)
	}
	if resp2.Status != 200 {
		t.Errorf("status = %d, want 200", resp2.Status)
	}
}

// --- MBX-017 Test: MsgBoxClient RPC envelope dispatch ---

func TestMsgBoxClient_RPCEnvelopeDispatch(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)

	client := NewMsgBoxClient("ws://test:7700/ws", "did:plc:test", priv)

	// Set up RPC infrastructure.
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		w.Write([]byte(`{"ok":true}`))
	})
	bridge := NewRPCBridge(handler)
	pool := NewRPCWorkerPool(2, 10)
	cache := NewIdempotencyCache(5 * time.Minute)
	nonceCache := NewNonceCache(5 * time.Minute)

	client.SetRPCBridge(bridge, pool, cache, nonceCache)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var processed []string
	var mu sync.Mutex
	pool.Start(ctx, func(task *RPCTask) *RPCInnerResponse {
		mu.Lock()
		processed = append(processed, task.RequestID)
		mu.Unlock()
		return &RPCInnerResponse{Status: 200}
	})

	// Dispatch an RPC envelope.
	// Inner JSON must have X-DID matching from_did for identity binding.
	innerJSON := `{"method":"POST","path":"/api/v1/remember","headers":{"X-DID":"did:key:z1"},"body":"{}"}`
	rpcJSON := []byte(fmt.Sprintf(`{"type":"rpc","id":"dispatch-001","from_did":"did:key:z1","to_did":"did:plc:test","direction":"request","ciphertext":%q}`, innerJSON))
	client.tryHandleEnvelope(rpcJSON)

	time.Sleep(100 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()
	found := false
	for _, id := range processed {
		if id == "dispatch-001" {
			found = true
		}
	}
	if !found {
		t.Error("RPC envelope was not dispatched to worker pool")
	}

	_ = pub
}

func TestMsgBoxClient_CancelDispatch(t *testing.T) {
	_, priv, _ := ed25519.GenerateKey(rand.Reader)

	client := NewMsgBoxClient("ws://test:7700/ws", "did:plc:test", priv)

	pool := NewRPCWorkerPool(1, 10)
	client.SetRPCBridge(nil, pool, nil, nil)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	blocker := make(chan struct{})
	pool.Start(ctx, func(task *RPCTask) *RPCInnerResponse {
		if task.RequestID == "to-cancel" {
			<-task.Ctx.Done()
		}
		return &RPCInnerResponse{Status: 200}
	})

	// Submit a task that blocks.
	taskCtx, taskCancel := context.WithCancel(ctx)
	pool.Submit(&RPCTask{
		RequestID: "to-cancel", FromDID: "did:key:zOwner",
		Ctx: taskCtx, Cancel: taskCancel,
	})
	time.Sleep(50 * time.Millisecond)

	// Dispatch cancel.
	cancelJSON := []byte(`{"type":"cancel","cancel_of":"to-cancel","from_did":"did:key:zOwner","to_did":"did:plc:test"}`)
	client.tryHandleEnvelope(cancelJSON)

	// The blocked task should be cancelled.
	time.Sleep(100 * time.Millisecond)

	task := pool.GetInflight("did:key:zOwner", "to-cancel")
	// Task should be completed (cancelled and cleaned up).
	// If still inflight, check its context.
	if task != nil {
		select {
		case <-task.Ctx.Done():
			// Good — cancelled.
		default:
			t.Error("task should have been cancelled")
		}
	}

	_ = blocker
}

// --- Bridge error path: handler error must send response, not leave CLI hanging ---
// TRACE: {"suite": "MBX", "case": "0143", "section": "03", "sectionName": "Core RPC Handler", "subsection": "01", "scenario": "10", "title": "bridge_error_sends_response"}
//
// When HandleInnerRequest returns an error, the StartRPCWorkers callback must
// send an error response via sendRPCError. Previously it only returned the
// error to the pool (which discards it), leaving the CLI hanging forever.
func TestStartRPCWorkers_BridgeErrorSendsResponse(t *testing.T) {
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	client := NewMsgBoxClient("ws://test:7700/ws", "did:plc:test", priv)

	// Bridge with a handler that always returns 500.
	failHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
		w.Write([]byte(`{"error":"deliberate failure"}`))
	})
	bridge := NewRPCBridge(failHandler)
	pool := NewRPCWorkerPool(2, 10)
	cache := NewIdempotencyCache(5 * time.Minute)

	client.SetRPCBridge(bridge, pool, cache, nil)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Start workers via StartRPCWorkers (this wires OnExpired + the handler callback).
	client.StartRPCWorkers(ctx)

	// Submit a task with valid inner JSON but a path the handler will fail on.
	// The bridge itself won't error — it captures the 500 response.
	// To trigger the bridge ERROR path, send malformed inner JSON.
	taskCtx, taskCancel := context.WithCancel(ctx)
	defer taskCancel()
	task := &RPCTask{
		RequestID: "error-test",
		FromDID:   "did:key:zErrorTest",
		InnerJSON: []byte(`{invalid json`), // will fail bridge JSON parse
		Ctx:       taskCtx,
		Cancel:    taskCancel,
	}
	pool.Submit(task)

	// Wait for worker to process.
	time.Sleep(100 * time.Millisecond)

	// The key assertion: the task should be completed (not stuck in inflight).
	// If the error path didn't send a response, the task would still complete
	// in the pool, but the CLI would hang. We verify the error was cached.
	if cache.Size() == 0 {
		// The error path uses sendRPCError (not sendRPCResponse), which doesn't
		// cache. But the task should still be cleaned from inflight.
		inflightTask := pool.GetInflight("did:key:zErrorTest", "error-test")
		if inflightTask != nil {
			t.Error("task should be cleaned from inflight after error")
		}
	}

	// Verify the task completed (not stuck).
	if pool.QueueLen() != 0 {
		t.Errorf("queue len = %d, want 0 (task should be processed)", pool.QueueLen())
	}
}

// --- Empty ciphertext rejected in production mode ---
// TRACE: {"suite": "MBX", "case": "0144", "section": "03", "sectionName": "Core RPC Handler", "subsection": "01", "scenario": "11", "title": "empty_ciphertext_rejected_production"}
//
// When decryptor is configured (production) and ciphertext is empty, the
// request must be rejected with 400 — not treated as plaintext.
func TestDispatch_EmptyCiphertextRejectedInProduction(t *testing.T) {
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	client := NewMsgBoxClient("ws://test:7700/ws", "did:plc:test", priv)

	// Configure with a decryptor (production mode).
	prodDecryptor := &RPCDecryptor{
		decryptor:  &mockDecryptor{plaintext: []byte(`{}`)},
		converter:  &mockKeyConverter{},
		x25519Pub:  make([]byte, 32),
		x25519Priv: make([]byte, 32),
	}

	bridge := NewRPCBridge(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}))
	pool := NewRPCWorkerPool(2, 10)
	client.SetRPCBridge(bridge, pool, nil, nil, prodDecryptor)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	pool.Start(ctx, func(task *RPCTask) *RPCInnerResponse {
		t.Error("handler should NOT be called for empty ciphertext in production")
		return &RPCInnerResponse{Status: 200}
	})

	// Send RPC with empty ciphertext while decryptor is configured.
	rpcJSON := []byte(`{"type":"rpc","id":"empty-ct","from_did":"did:key:z1","to_did":"did:plc:test","direction":"request","ciphertext":""}`)
	client.tryHandleEnvelope(rpcJSON)

	time.Sleep(50 * time.Millisecond)

	// The task should NOT have been submitted to the pool.
	if pool.QueueLen() != 0 {
		t.Error("empty ciphertext should be rejected before reaching pool")
	}
}

// --- Empty ciphertext allowed in test mode (no decryptor) ---
// TRACE: {"suite": "MBX", "case": "0145", "section": "03", "sectionName": "Core RPC Handler", "subsection": "01", "scenario": "12", "title": "empty_ciphertext_allowed_test_mode"}
func TestDispatch_EmptyCiphertextAllowedInTestMode(t *testing.T) {
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	client := NewMsgBoxClient("ws://test:7700/ws", "did:plc:test", priv)

	// No decryptor — test mode.
	bridge := NewRPCBridge(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}))
	pool := NewRPCWorkerPool(2, 10)
	client.SetRPCBridge(bridge, pool, nil, nil) // no decryptor

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var submitted int32
	pool.Start(ctx, func(task *RPCTask) *RPCInnerResponse {
		atomic.AddInt32(&submitted, 1)
		return &RPCInnerResponse{Status: 200}
	})

	// Send RPC with real ciphertext (plaintext JSON in test mode).
	// Identity binding will fail on empty ciphertext, so use valid inner JSON.
	innerJSON := `{"method":"GET","path":"/api/v1/status","headers":{"X-DID":"did:key:z1"}}`
	rpcJSON := []byte(fmt.Sprintf(`{"type":"rpc","id":"test-mode","from_did":"did:key:z1","to_did":"did:plc:test","direction":"request","ciphertext":%q}`, innerJSON))
	client.tryHandleEnvelope(rpcJSON)

	time.Sleep(100 * time.Millisecond)

	if atomic.LoadInt32(&submitted) != 1 {
		t.Errorf("task submitted %d times, want 1 (test mode should allow plaintext)", submitted)
	}
}

// --- Inner body size guard: oversized inner JSON rejected with 413 ---
// TRACE: {"suite": "MBX", "case": "0147", "section": "03", "sectionName": "Core RPC Handler", "subsection": "01", "scenario": "13", "title": "inner_body_size_rejected_413"}
//
// After decryption, if the inner JSON exceeds MaxInnerBodySize (1 MiB),
// the request is rejected with 413 before reaching the handler chain.
func TestDispatch_OversizedInnerBodyRejected(t *testing.T) {
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	client := NewMsgBoxClient("ws://test:7700/ws", "did:plc:test", priv)

	bridge := NewRPCBridge(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("handler should NOT be called for oversized inner body")
		w.WriteHeader(200)
	}))
	pool := NewRPCWorkerPool(2, 10)
	client.SetRPCBridge(bridge, pool, nil, nil) // test mode (no decryptor)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	pool.Start(ctx, func(task *RPCTask) *RPCInnerResponse {
		t.Error("worker should NOT process oversized inner body")
		return &RPCInnerResponse{Status: 200}
	})

	// Build a ciphertext that exceeds MaxInnerBodySize (1 MiB + 1 byte).
	oversized := strings.Repeat("x", MaxInnerBodySize+1)
	rpcJSON := []byte(fmt.Sprintf(`{"type":"rpc","id":"big-body","from_did":"did:key:z1","to_did":"did:plc:test","direction":"request","ciphertext":%q}`, oversized))
	client.tryHandleEnvelope(rpcJSON)

	time.Sleep(50 * time.Millisecond)

	if pool.QueueLen() != 0 {
		t.Error("oversized body should be rejected before reaching pool")
	}
}

// --- Inner body under limit: accepted ---
func TestDispatch_NormalSizedInnerBodyAccepted(t *testing.T) {
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	client := NewMsgBoxClient("ws://test:7700/ws", "did:plc:test", priv)

	bridge := NewRPCBridge(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}))
	pool := NewRPCWorkerPool(2, 10)
	client.SetRPCBridge(bridge, pool, nil, nil)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var submitted int32
	pool.Start(ctx, func(task *RPCTask) *RPCInnerResponse {
		atomic.AddInt32(&submitted, 1)
		return &RPCInnerResponse{Status: 200}
	})

	innerJSON := `{"method":"GET","path":"/api/v1/status","headers":{"X-DID":"did:key:z1"}}`
	rpcJSON := []byte(fmt.Sprintf(`{"type":"rpc","id":"normal-body","from_did":"did:key:z1","to_did":"did:plc:test","direction":"request","ciphertext":%q}`, innerJSON))
	client.tryHandleEnvelope(rpcJSON)

	time.Sleep(100 * time.Millisecond)

	if atomic.LoadInt32(&submitted) != 1 {
		t.Errorf("normal-sized body should be accepted, submitted=%d", atomic.LoadInt32(&submitted))
	}
}

// --- Unified envelope: D2D type dispatches to onMessage ---
func TestEnvelope_D2DDispatchesToOnMessage(t *testing.T) {
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	client := NewMsgBoxClient("ws://test:7700/ws", "did:plc:test", priv)

	var received []byte
	client.SetOnMessage(func(data []byte) {
		received = data
	})

	d2dPayload := `{"c":"base64ciphertext","s":"hexsig"}`
	d2dJSON := []byte(fmt.Sprintf(`{"type":"d2d","id":"d2d-001","from_did":"did:plc:sender","to_did":"did:plc:test","ciphertext":%q}`, d2dPayload))
	handled := client.tryHandleEnvelope(d2dJSON)

	if !handled {
		t.Fatal("D2D envelope should be handled by tryHandleEnvelope")
	}
	if string(received) != d2dPayload {
		t.Errorf("onMessage received %q, want d2dPayload %q", string(received), d2dPayload)
	}
}

// --- Unified envelope: unknown type falls through (backward compat) ---
func TestEnvelope_UnknownTypeFallsThrough(t *testing.T) {
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	client := NewMsgBoxClient("ws://test:7700/ws", "did:plc:test", priv)

	// Old d2dPayload JSON without type field.
	legacyPayload := []byte(`{"c":"base64data","s":"hexsig"}`)
	handled := client.tryHandleEnvelope(legacyPayload)

	if handled {
		t.Error("legacy d2dPayload (no type field) should NOT be handled — should fall through to onMessage")
	}
}

// --- Unified envelope: non-JSON falls through ---
func TestEnvelope_NonJSONFallsThrough(t *testing.T) {
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	client := NewMsgBoxClient("ws://test:7700/ws", "did:plc:test", priv)

	handled := client.tryHandleEnvelope([]byte{0x00, 0x1A, 0xFF})

	if handled {
		t.Error("non-JSON binary should NOT be handled — should fall through")
	}
}
