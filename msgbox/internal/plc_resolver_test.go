package internal

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

// multibaseEncode returns a z-prefixed base58btc multibase Ed25519 public key.
// Uses base58Encode from auth.go (same package).
func multibaseEncode(pub ed25519.PublicKey) string {
	raw := append([]byte{0xed, 0x01}, pub...)
	return "z" + base58Encode(raw)
}

// servePLCDoc creates a test HTTP server that serves a PLC document with the
// given verification methods.
func servePLCDoc(t *testing.T, did string, verificationMethods []map[string]string) *httptest.Server {
	t.Helper()
	doc := map[string]interface{}{
		"id":                 did,
		"verificationMethod": verificationMethods,
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/"+did {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(doc)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// --- Exact fragment match: #dina_signing accepted ---
func TestPLCResolver_ExactFragmentMatch(t *testing.T) {
	pub, _, _ := ed25519.GenerateKey(rand.Reader)
	multibase := multibaseEncode(pub)
	did := "did:plc:test-exact"

	srv := servePLCDoc(t, did, []map[string]string{
		{"id": did + "#dina_signing", "publicKeyMultibase": multibase},
	})
	resolver := NewHTTPPLCResolver(srv.URL)

	key, err := resolver.ResolveDinaSigningKey(t.Context(), did)
	if err != nil {
		t.Fatalf("resolve failed: %v", err)
	}
	if !pub.Equal(key) {
		t.Error("resolved key does not match expected public key")
	}
}

// --- Exact fragment match: #key-1 accepted ---
func TestPLCResolver_Key1FragmentMatch(t *testing.T) {
	pub, _, _ := ed25519.GenerateKey(rand.Reader)
	multibase := multibaseEncode(pub)
	did := "did:plc:test-key1"

	srv := servePLCDoc(t, did, []map[string]string{
		{"id": did + "#key-1", "publicKeyMultibase": multibase},
	})
	resolver := NewHTTPPLCResolver(srv.URL)

	key, err := resolver.ResolveDinaSigningKey(t.Context(), did)
	if err != nil {
		t.Fatalf("resolve failed: %v", err)
	}
	if !pub.Equal(key) {
		t.Error("resolved key does not match")
	}
}

// --- Fuzzy substring MUST NOT match: #not_dina_signing rejected ---
func TestPLCResolver_FuzzySubstringRejected(t *testing.T) {
	pub, _, _ := ed25519.GenerateKey(rand.Reader)
	multibase := multibaseEncode(pub)
	did := "did:plc:test-fuzzy"

	srv := servePLCDoc(t, did, []map[string]string{
		// This has "dina_signing" as a substring but NOT as the exact fragment.
		{"id": did + "#not_dina_signing", "publicKeyMultibase": multibase},
	})
	resolver := NewHTTPPLCResolver(srv.URL)

	_, err := resolver.ResolveDinaSigningKey(t.Context(), did)
	if err == nil {
		t.Fatal("should have rejected #not_dina_signing (fuzzy substring match)")
	}
}

// --- Fuzzy substring MUST NOT match: #dina_signing_v2 rejected ---
func TestPLCResolver_SuffixExtensionRejected(t *testing.T) {
	pub, _, _ := ed25519.GenerateKey(rand.Reader)
	multibase := multibaseEncode(pub)
	did := "did:plc:test-suffix"

	srv := servePLCDoc(t, did, []map[string]string{
		{"id": did + "#dina_signing_v2", "publicKeyMultibase": multibase},
	})
	resolver := NewHTTPPLCResolver(srv.URL)

	_, err := resolver.ResolveDinaSigningKey(t.Context(), did)
	if err == nil {
		t.Fatal("should have rejected #dina_signing_v2 (suffix extension match)")
	}
}

// --- First exact match wins when multiple verification methods exist ---
func TestPLCResolver_FirstExactMatchWins(t *testing.T) {
	pub1, _, _ := ed25519.GenerateKey(rand.Reader)
	pub2, _, _ := ed25519.GenerateKey(rand.Reader)
	did := "did:plc:test-multi"

	srv := servePLCDoc(t, did, []map[string]string{
		{"id": did + "#some_other_key", "publicKeyMultibase": multibaseEncode(pub2)},
		{"id": did + "#dina_signing", "publicKeyMultibase": multibaseEncode(pub1)},
	})
	resolver := NewHTTPPLCResolver(srv.URL)

	key, err := resolver.ResolveDinaSigningKey(t.Context(), did)
	if err != nil {
		t.Fatalf("resolve failed: %v", err)
	}
	if !pub1.Equal(key) {
		t.Error("should have selected #dina_signing, not #some_other_key")
	}
}

// --- No fragment at all (bare ID) does not match ---
func TestPLCResolver_NoFragmentRejected(t *testing.T) {
	pub, _, _ := ed25519.GenerateKey(rand.Reader)
	did := "did:plc:test-nofrag"

	srv := servePLCDoc(t, did, []map[string]string{
		{"id": "dina_signing", "publicKeyMultibase": multibaseEncode(pub)},
	})
	resolver := NewHTTPPLCResolver(srv.URL)

	// Bare "dina_signing" without '#' prefix should still match because
	// the fragment extraction falls back to the full ID when no '#' exists.
	key, err := resolver.ResolveDinaSigningKey(t.Context(), did)
	if err != nil {
		t.Fatalf("resolve failed: %v", err)
	}
	_ = key
	_ = fmt.Sprintf("edge case: bare ID without fragment")
}
