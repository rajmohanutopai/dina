package handler

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/mr-tron/base58"

	"github.com/rajmohanutopai/dina/core/internal/domain"
)

// ---------------------------------------------------------------------------
// Mock DIDManager for verify tests
// ---------------------------------------------------------------------------

type mockDIDManager struct {
	doc []byte // raw JSON to return from Resolve
	did domain.DID
}

func (m *mockDIDManager) Create(_ context.Context, _ []byte) (domain.DID, error) {
	return m.did, nil
}

func (m *mockDIDManager) Resolve(_ context.Context, _ domain.DID) ([]byte, error) {
	return m.doc, nil
}

func (m *mockDIDManager) Rotate(_ context.Context, _ domain.DID, _, _ []byte) error {
	return nil
}

// ---------------------------------------------------------------------------
// Mock IdentitySigner for handler construction
// ---------------------------------------------------------------------------

type mockSigner struct {
	privKey ed25519.PrivateKey
}

func (s *mockSigner) Sign(_ context.Context, data []byte) ([]byte, error) {
	return ed25519.Sign(s.privKey, data), nil
}

func (s *mockSigner) PublicKey() ed25519.PublicKey {
	return s.privKey.Public().(ed25519.PublicKey)
}

// ---------------------------------------------------------------------------
// Helper: build a DID document JSON with multibase-encoded public key
// ---------------------------------------------------------------------------

func buildDIDDocument(pubKey ed25519.PublicKey) []byte {
	// multibase = "z" + base58btc(0xed, 0x01, pubkey_bytes)
	multicodecBytes := append([]byte{0xed, 0x01}, pubKey...)
	multibase := "z" + base58.Encode(multicodecBytes)

	doc := domain.DIDDocument{
		Context: []string{"https://www.w3.org/ns/did/v1"},
		ID:      "did:key:z" + base58.Encode(multicodecBytes),
		VerificationMethod: []domain.VerificationMethod{
			{
				ID:                 "did:key:z" + base58.Encode(multicodecBytes) + "#key-1",
				Type:               "Multikey",
				Controller:         "did:key:z" + base58.Encode(multicodecBytes),
				PublicKeyMultibase: multibase,
			},
		},
	}

	b, _ := json.Marshal(doc)
	return b
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// TestHandleVerify_ValidSignature generates an Ed25519 keypair, signs data,
// and verifies that HandleVerify returns valid=true.
func TestHandleVerify_ValidSignature(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}

	data := []byte("hello, dina")
	sig := ed25519.Sign(priv, data)

	doc := buildDIDDocument(pub)

	// Construct the multibase DID string for the request.
	multicodecBytes := append([]byte{0xed, 0x01}, pub...)
	didStr := "did:key:z" + base58.Encode(multicodecBytes)

	dm := &mockDIDManager{doc: doc, did: domain.DID(didStr)}
	ms := &mockSigner{privKey: priv}

	h := &IdentityHandler{
		DID:    dm,
		Signer: ms,
	}

	body, _ := json.Marshal(verifyRequest{
		Data:      hex.EncodeToString(data),
		Signature: hex.EncodeToString(sig),
		DID:       didStr,
	})

	req := httptest.NewRequest(http.MethodPost, "/v1/did/verify", bytes.NewReader(body))
	rec := httptest.NewRecorder()

	h.HandleVerify(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var resp map[string]bool
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if !resp["valid"] {
		t.Fatal("expected valid=true for correct signature")
	}
}

// TestHandleVerify_TamperedSignature verifies that a tampered signature
// returns valid=false.
func TestHandleVerify_TamperedSignature(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}

	data := []byte("hello, dina")
	sig := ed25519.Sign(priv, data)

	// Tamper with the signature by flipping a byte.
	sig[0] ^= 0xff

	doc := buildDIDDocument(pub)

	multicodecBytes := append([]byte{0xed, 0x01}, pub...)
	didStr := "did:key:z" + base58.Encode(multicodecBytes)

	dm := &mockDIDManager{doc: doc, did: domain.DID(didStr)}
	ms := &mockSigner{privKey: priv}

	h := &IdentityHandler{
		DID:    dm,
		Signer: ms,
	}

	body, _ := json.Marshal(verifyRequest{
		Data:      hex.EncodeToString(data),
		Signature: hex.EncodeToString(sig),
		DID:       didStr,
	})

	req := httptest.NewRequest(http.MethodPost, "/v1/did/verify", bytes.NewReader(body))
	rec := httptest.NewRecorder()

	h.HandleVerify(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var resp map[string]bool
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if resp["valid"] {
		t.Fatal("expected valid=false for tampered signature")
	}
}

// TestHandleVerify_WrongData verifies that signing one message but verifying
// against different data returns valid=false.
func TestHandleVerify_WrongData(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}

	data := []byte("original data")
	sig := ed25519.Sign(priv, data)

	doc := buildDIDDocument(pub)

	multicodecBytes := append([]byte{0xed, 0x01}, pub...)
	didStr := "did:key:z" + base58.Encode(multicodecBytes)

	dm := &mockDIDManager{doc: doc, did: domain.DID(didStr)}
	ms := &mockSigner{privKey: priv}

	h := &IdentityHandler{
		DID:    dm,
		Signer: ms,
	}

	// Send different data for verification.
	body, _ := json.Marshal(verifyRequest{
		Data:      hex.EncodeToString([]byte("tampered data")),
		Signature: hex.EncodeToString(sig),
		DID:       didStr,
	})

	req := httptest.NewRequest(http.MethodPost, "/v1/did/verify", bytes.NewReader(body))
	rec := httptest.NewRecorder()

	h.HandleVerify(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var resp map[string]bool
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if resp["valid"] {
		t.Fatal("expected valid=false when data does not match signature")
	}
}

// TestHandleVerify_NoVerificationMethod verifies that a DID document with
// no verification methods returns an error.
func TestHandleVerify_NoVerificationMethod(t *testing.T) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}

	// Build a DID document with no verification methods.
	doc, _ := json.Marshal(domain.DIDDocument{
		Context: []string{"https://www.w3.org/ns/did/v1"},
		ID:      "did:key:z6MkTest",
	})

	dm := &mockDIDManager{doc: doc, did: "did:key:z6MkTest"}
	ms := &mockSigner{privKey: priv}

	h := &IdentityHandler{
		DID:    dm,
		Signer: ms,
	}

	data := []byte("test")
	sig := ed25519.Sign(priv, data)

	body, _ := json.Marshal(verifyRequest{
		Data:      hex.EncodeToString(data),
		Signature: hex.EncodeToString(sig),
		DID:       "did:key:z6MkTest",
	})

	req := httptest.NewRequest(http.MethodPost, "/v1/did/verify", bytes.NewReader(body))
	rec := httptest.NewRecorder()

	h.HandleVerify(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected status 400, got %d: %s", rec.Code, rec.Body.String())
	}
}

// TestHandleVerify_InvalidMultibasePrefix verifies that a DID document
// with a non-'z' multibase prefix returns an error.
func TestHandleVerify_InvalidMultibasePrefix(t *testing.T) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}

	// Build a DID document with invalid multibase prefix.
	doc, _ := json.Marshal(domain.DIDDocument{
		Context: []string{"https://www.w3.org/ns/did/v1"},
		ID:      "did:key:z6MkTest",
		VerificationMethod: []domain.VerificationMethod{
			{
				ID:                 "did:key:z6MkTest#key-1",
				Type:               "Multikey",
				Controller:         "did:key:z6MkTest",
				PublicKeyMultibase: "fInvalidBase16", // 'f' prefix = base16, not supported
			},
		},
	})

	dm := &mockDIDManager{doc: doc, did: "did:key:z6MkTest"}
	ms := &mockSigner{privKey: priv}

	h := &IdentityHandler{
		DID:    dm,
		Signer: ms,
	}

	data := []byte("test")
	sig := ed25519.Sign(priv, data)

	body, _ := json.Marshal(verifyRequest{
		Data:      hex.EncodeToString(data),
		Signature: hex.EncodeToString(sig),
		DID:       "did:key:z6MkTest",
	})

	req := httptest.NewRequest(http.MethodPost, "/v1/did/verify", bytes.NewReader(body))
	rec := httptest.NewRecorder()

	h.HandleVerify(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected status 400, got %d: %s", rec.Code, rec.Body.String())
	}
}

// TestHandleVerify_InvalidMulticodecPrefix verifies that a DID document
// with wrong multicodec prefix bytes returns an error.
func TestHandleVerify_InvalidMulticodecPrefix(t *testing.T) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}

	// Build a DID document with wrong multicodec prefix (0x00, 0x00 instead of 0xed, 0x01).
	wrongPrefix := append([]byte{0x00, 0x00}, make([]byte, 32)...)
	multibase := "z" + base58.Encode(wrongPrefix)

	doc, _ := json.Marshal(domain.DIDDocument{
		Context: []string{"https://www.w3.org/ns/did/v1"},
		ID:      "did:key:z6MkTest",
		VerificationMethod: []domain.VerificationMethod{
			{
				ID:                 "did:key:z6MkTest#key-1",
				Type:               "Multikey",
				Controller:         "did:key:z6MkTest",
				PublicKeyMultibase: multibase,
			},
		},
	})

	dm := &mockDIDManager{doc: doc, did: "did:key:z6MkTest"}
	ms := &mockSigner{privKey: priv}

	h := &IdentityHandler{
		DID:    dm,
		Signer: ms,
	}

	data := []byte("test")
	sig := ed25519.Sign(priv, data)

	body, _ := json.Marshal(verifyRequest{
		Data:      hex.EncodeToString(data),
		Signature: hex.EncodeToString(sig),
		DID:       "did:key:z6MkTest",
	})

	req := httptest.NewRequest(http.MethodPost, "/v1/did/verify", bytes.NewReader(body))
	rec := httptest.NewRecorder()

	h.HandleVerify(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected status 400, got %d: %s", rec.Code, rec.Body.String())
	}
}

// TestHandleVerify_InvalidDID verifies that an invalid DID string returns
// a 400 error.
func TestHandleVerify_InvalidDID(t *testing.T) {
	_, priv, _ := ed25519.GenerateKey(rand.Reader)

	ms := &mockSigner{privKey: priv}
	dm := &mockDIDManager{}

	h := &IdentityHandler{
		DID:    dm,
		Signer: ms,
	}

	body, _ := json.Marshal(verifyRequest{
		Data:      hex.EncodeToString([]byte("test")),
		Signature: hex.EncodeToString(make([]byte, 64)),
		DID:       "not-a-valid-did",
	})

	req := httptest.NewRequest(http.MethodPost, "/v1/did/verify", bytes.NewReader(body))
	rec := httptest.NewRecorder()

	h.HandleVerify(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected status 400, got %d: %s", rec.Code, rec.Body.String())
	}
}
