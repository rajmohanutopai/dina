package internal

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func forwardRequest(t *testing.T, handler http.Handler, senderDID, recipientDID string, pub ed25519.PublicKey, priv ed25519.PrivateKey, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	ts := time.Now().UTC().Format("2006-01-02T15:04:05Z")
	nonceBytes := make([]byte, 16)
	rand.Read(nonceBytes)
	nonce := hex.EncodeToString(nonceBytes)
	bodyHash := fmt.Sprintf("%x", sha256.Sum256(body))
	canonical := fmt.Sprintf("POST\n/forward\n%s\n%s\n%s\n%s", recipientDID, ts, nonce, bodyHash)
	sig := ed25519.Sign(priv, []byte(canonical))

	req := httptest.NewRequest("POST", "/forward", strings.NewReader(string(body)))
	req.Header.Set("X-Recipient-DID", recipientDID)
	req.Header.Set("X-Sender-DID", senderDID)
	req.Header.Set("X-Timestamp", ts)
	req.Header.Set("X-Nonce", nonce)
	req.Header.Set("X-Signature", hex.EncodeToString(sig))
	req.Header.Set("X-Sender-Pub", hex.EncodeToString(pub))

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func TestHandleForward_ValidRequest(t *testing.T) {
	buf := newTestBuffer(t)
	defer buf.Close()
	hub := NewHub(buf)
	h := NewHandler(hub)

	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	senderDID := deriveDIDKey(pub)

	rec := forwardRequest(t, http.HandlerFunc(h.HandleForward),
		senderDID, "did:plc:recipient", pub, priv, []byte("hello"))

	if rec.Code != 202 {
		t.Errorf("status = %d, want 202 (body: %s)", rec.Code, rec.Body.String())
	}
	if buf.TotalCount() != 1 {
		t.Errorf("buffer = %d, want 1", buf.TotalCount())
	}

	// Verify /forward wraps the body in a D2D envelope.
	msgs := buf.Peek("did:plc:recipient")
	if len(msgs) != 1 {
		t.Fatalf("peek = %d, want 1", len(msgs))
	}
	var env struct {
		Type       string `json:"type"`
		Ciphertext string `json:"ciphertext"`
		FromDID    string `json:"from_did"`
		ToDID      string `json:"to_did"`
	}
	if err := json.Unmarshal(msgs[0].Payload, &env); err != nil {
		t.Fatalf("stored payload not a JSON envelope: %v", err)
	}
	if env.Type != "d2d" {
		t.Errorf("envelope.type = %q, want d2d", env.Type)
	}
	if env.Ciphertext != "hello" {
		t.Errorf("envelope.ciphertext = %q, want original body", env.Ciphertext)
	}
	if env.FromDID != senderDID {
		t.Errorf("envelope.from_did = %q, want %q", env.FromDID, senderDID)
	}
}

func TestHandleForward_MissingHeaders(t *testing.T) {
	buf := newTestBuffer(t)
	defer buf.Close()
	h := NewHandler(NewHub(buf))

	req := httptest.NewRequest("POST", "/forward", strings.NewReader("body"))
	req.Header.Set("X-Recipient-DID", "did:plc:target")
	// Missing auth headers.

	rec := httptest.NewRecorder()
	h.HandleForward(rec, req)

	if rec.Code != 401 {
		t.Errorf("status = %d, want 401", rec.Code)
	}
}

func TestHandleForward_BadSignature(t *testing.T) {
	buf := newTestBuffer(t)
	defer buf.Close()
	h := NewHandler(NewHub(buf))

	pub, _, _ := ed25519.GenerateKey(rand.Reader)
	_, wrongPriv, _ := ed25519.GenerateKey(rand.Reader)
	senderDID := deriveDIDKey(pub)

	rec := forwardRequest(t, http.HandlerFunc(h.HandleForward),
		senderDID, "did:plc:target", pub, wrongPriv, []byte("hello"))

	if rec.Code != 401 {
		t.Errorf("status = %d, want 401 (bad signature)", rec.Code)
	}
}

func TestHandleForward_DIDKeySpoofing(t *testing.T) {
	buf := newTestBuffer(t)
	defer buf.Close()
	h := NewHandler(NewHub(buf))

	// Attacker signs with their own key but claims a different did:key.
	_, attackerPriv, _ := ed25519.GenerateKey(rand.Reader)
	attackerPub := attackerPriv.Public().(ed25519.PublicKey)
	victimPub, _, _ := ed25519.GenerateKey(rand.Reader)
	victimDID := deriveDIDKey(victimPub)

	// Sign with attacker key, claim victim DID, provide attacker pub.
	rec := forwardRequest(t, http.HandlerFunc(h.HandleForward),
		victimDID, "did:plc:target", attackerPub, attackerPriv, []byte("spoofed"))

	if rec.Code != 401 {
		t.Errorf("status = %d, want 401 (DID-key binding should reject spoofed sender)", rec.Code)
	}
	if buf.TotalCount() != 0 {
		t.Errorf("buffer = %d, want 0 (spoofed message should not be buffered)", buf.TotalCount())
	}
}

func TestHandleForward_ExpiredTimestamp(t *testing.T) {
	buf := newTestBuffer(t)
	defer buf.Close()
	h := NewHandler(NewHub(buf))

	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	senderDID := deriveDIDKey(pub)

	// Build request with expired timestamp.
	expiredTS := time.Now().UTC().Add(-10 * time.Minute).Format("2006-01-02T15:04:05Z")
	nonce := hex.EncodeToString(make([]byte, 16))
	body := []byte("expired")
	bodyHash := fmt.Sprintf("%x", sha256.Sum256(body))
	canonical := fmt.Sprintf("POST\n/forward\n\n%s\n%s\n%s", expiredTS, nonce, bodyHash)
	sig := ed25519.Sign(priv, []byte(canonical))

	req := httptest.NewRequest("POST", "/forward", strings.NewReader(string(body)))
	req.Header.Set("X-Recipient-DID", "did:plc:target")
	req.Header.Set("X-Sender-DID", senderDID)
	req.Header.Set("X-Timestamp", expiredTS)
	req.Header.Set("X-Nonce", nonce)
	req.Header.Set("X-Signature", hex.EncodeToString(sig))
	req.Header.Set("X-Sender-Pub", hex.EncodeToString(pub))

	rec := httptest.NewRecorder()
	h.HandleForward(rec, req)

	if rec.Code != 401 {
		t.Errorf("status = %d, want 401 (expired timestamp)", rec.Code)
	}
}

func TestHandleForward_OversizedPayload(t *testing.T) {
	buf := newTestBuffer(t)
	defer buf.Close()
	h := NewHandler(NewHub(buf))

	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	senderDID := deriveDIDKey(pub)

	bigBody := make([]byte, MaxPayloadSize+1)
	rec := forwardRequest(t, http.HandlerFunc(h.HandleForward),
		senderDID, "did:plc:target", pub, priv, bigBody)

	if rec.Code != 413 {
		t.Errorf("status = %d, want 413 (payload too large)", rec.Code)
	}
}

// --- Nonce replay: same signed request replayed → 401 ---
// TRACE: {"suite": "MBX", "case": "0139", "section": "05", "sectionName": "Idempotency & Replay Protection", "subsection": "02", "scenario": "01", "title": "forward_nonce_replay_rejected"}
//
// A valid signed /forward request is submitted twice with the EXACT same
// timestamp, nonce, body, and signature. The first succeeds (202). The
// second is rejected (401) because the nonce was already seen.
func TestHandleForward_NonceReplay(t *testing.T) {
	buf := newTestBuffer(t)
	defer buf.Close()
	h := NewHandler(NewHub(buf))

	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	senderDID := deriveDIDKey(pub)
	recipientDID := "did:plc:recipient"
	body := []byte("replay-me")

	// Build a signed request manually (so we can replay the exact same bytes).
	ts := time.Now().UTC().Format("2006-01-02T15:04:05Z")
	nonceBytes := make([]byte, 16)
	rand.Read(nonceBytes)
	nonce := hex.EncodeToString(nonceBytes)
	bodyHash := fmt.Sprintf("%x", sha256.Sum256(body))
	canonical := fmt.Sprintf("POST\n/forward\n%s\n%s\n%s\n%s", recipientDID, ts, nonce, bodyHash)
	sig := ed25519.Sign(priv, []byte(canonical))

	buildReq := func() *http.Request {
		req := httptest.NewRequest("POST", "/forward", strings.NewReader(string(body)))
		req.Header.Set("X-Recipient-DID", recipientDID)
		req.Header.Set("X-Sender-DID", senderDID)
		req.Header.Set("X-Timestamp", ts)
		req.Header.Set("X-Nonce", nonce)
		req.Header.Set("X-Signature", hex.EncodeToString(sig))
		req.Header.Set("X-Sender-Pub", hex.EncodeToString(pub))
		return req
	}

	// First request: should succeed.
	rec1 := httptest.NewRecorder()
	h.HandleForward(rec1, buildReq())
	if rec1.Code != 202 {
		t.Fatalf("first request: status = %d, want 202 (body: %s)", rec1.Code, rec1.Body.String())
	}

	// Second request (exact replay): should fail with 401 (nonce replay).
	rec2 := httptest.NewRecorder()
	h.HandleForward(rec2, buildReq())
	if rec2.Code != 401 {
		t.Errorf("replay request: status = %d, want 401 (nonce replay)", rec2.Code)
	}
	if !strings.Contains(rec2.Body.String(), "nonce replay") {
		t.Errorf("replay body = %q, want 'nonce replay' message", rec2.Body.String())
	}

	// Buffer should have exactly 1 message (the original, not the replay).
	if buf.TotalCount() != 1 {
		t.Errorf("buffer = %d, want 1 (replay should not be buffered)", buf.TotalCount())
	}
}

// --- Different nonce, same sender → accepted (not a replay) ---
// TRACE: {"suite": "MBX", "case": "0140", "section": "05", "sectionName": "Idempotency & Replay Protection", "subsection": "02", "scenario": "02", "title": "forward_different_nonce_accepted"}
func TestHandleForward_DifferentNonceAccepted(t *testing.T) {
	buf := newTestBuffer(t)
	defer buf.Close()
	h := NewHandler(NewHub(buf))

	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	senderDID := deriveDIDKey(pub)

	// Two separate requests with different nonces — both should succeed.
	rec1 := forwardRequest(t, http.HandlerFunc(h.HandleForward),
		senderDID, "did:plc:target", pub, priv, []byte("msg-1"))
	if rec1.Code != 202 {
		t.Fatalf("request 1: status = %d, want 202", rec1.Code)
	}

	rec2 := forwardRequest(t, http.HandlerFunc(h.HandleForward),
		senderDID, "did:plc:target", pub, priv, []byte("msg-2"))
	if rec2.Code != 202 {
		t.Errorf("request 2: status = %d, want 202 (different nonce, not a replay)", rec2.Code)
	}

	if buf.TotalCount() != 2 {
		t.Errorf("buffer = %d, want 2", buf.TotalCount())
	}
}

func TestDeleteForRecipient_OwnershipCheck(t *testing.T) {
	buf := newTestBuffer(t)
	defer buf.Close()

	// Buffer a message for recipient A.
	buf.Add("did:plc:recipientA", "msg-for-A", []byte("secret-data"))

	// Recipient B tries to delete it via ACK — should fail.
	if buf.DeleteForRecipient("msg-for-A", "did:plc:recipientB") {
		t.Error("DeleteForRecipient should reject — message belongs to recipientA, not recipientB")
	}

	// Message should still exist.
	if buf.TotalCount() != 1 {
		t.Errorf("buffer = %d, want 1 (message should survive unauthorized delete)", buf.TotalCount())
	}

	// Recipient A deletes it — should succeed.
	if !buf.DeleteForRecipient("msg-for-A", "did:plc:recipientA") {
		t.Error("DeleteForRecipient should succeed for the actual recipient")
	}

	if buf.TotalCount() != 0 {
		t.Errorf("buffer = %d, want 0", buf.TotalCount())
	}
}
