package transport

import (
	"encoding/base64"
	"fmt"
	"testing"
)

// --- Mock implementations for testing ---

type mockDecryptor struct {
	// plaintext to return on successful decrypt
	plaintext []byte
	err       error
}

func (m *mockDecryptor) OpenAnonymous(ciphertext, recipientPub, recipientPriv []byte) ([]byte, error) {
	if m.err != nil {
		return nil, m.err
	}
	return m.plaintext, nil
}

func (m *mockDecryptor) SealAnonymous(plaintext, recipientPub []byte) ([]byte, error) {
	return plaintext, nil // mock: no-op seal
}

type mockKeyConverter struct{}

func (c *mockKeyConverter) Ed25519ToX25519Private(priv []byte) ([]byte, error) {
	if len(priv) != 64 {
		return nil, fmt.Errorf("bad key length: %d", len(priv))
	}
	return make([]byte, 32), nil // dummy X25519 private key
}

func (c *mockKeyConverter) Ed25519ToX25519Public(pub []byte) ([]byte, error) {
	if len(pub) != 32 {
		return nil, fmt.Errorf("bad key length: %d", len(pub))
	}
	return make([]byte, 32), nil // dummy X25519 public key
}

// --- MBX-021 Tests ---

func TestRPCDecryptor_DecryptSuccess(t *testing.T) {
	innerJSON := []byte(`{"method":"POST","path":"/api/v1/remember","headers":{},"body":"{}"}`)

	decryptor := &mockDecryptor{plaintext: innerJSON}
	converter := &mockKeyConverter{}

	ed25519Pub := make([]byte, 32)
	ed25519Priv := make([]byte, 64) // Ed25519 private key is 64 bytes

	d, err := NewRPCDecryptor(decryptor, converter, ed25519Pub, ed25519Priv)
	if err != nil {
		t.Fatal(err)
	}

	// Encode a dummy ciphertext in base64 (the mock ignores it).
	ciphertextB64 := base64.StdEncoding.EncodeToString([]byte("dummy-ciphertext-48-bytes-padded-to-minimum-size!"))

	result, err := d.DecryptCiphertext(ciphertextB64)
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if string(result) != string(innerJSON) {
		t.Errorf("result = %q, want %q", result, innerJSON)
	}
}

func TestRPCDecryptor_EmptyCiphertext(t *testing.T) {
	decryptor := &mockDecryptor{plaintext: []byte("{}")}
	converter := &mockKeyConverter{}

	d, _ := NewRPCDecryptor(decryptor, converter, make([]byte, 32), make([]byte, 64))

	_, err := d.DecryptCiphertext("")
	if err == nil {
		t.Fatal("empty ciphertext should fail")
	}
}

func TestRPCDecryptor_InvalidBase64(t *testing.T) {
	decryptor := &mockDecryptor{plaintext: []byte("{}")}
	converter := &mockKeyConverter{}

	d, _ := NewRPCDecryptor(decryptor, converter, make([]byte, 32), make([]byte, 64))

	_, err := d.DecryptCiphertext("not!valid!base64!!!")
	if err == nil {
		t.Fatal("invalid base64 should fail")
	}
}

func TestRPCDecryptor_NaClOpenFails(t *testing.T) {
	decryptor := &mockDecryptor{err: fmt.Errorf("nacl: decryption failed")}
	converter := &mockKeyConverter{}

	d, _ := NewRPCDecryptor(decryptor, converter, make([]byte, 32), make([]byte, 64))

	ciphertextB64 := base64.StdEncoding.EncodeToString([]byte("garbage-ciphertext-that-wont-decrypt-correctly!!!"))

	_, err := d.DecryptCiphertext(ciphertextB64)
	if err == nil {
		t.Fatal("NaCl open failure should propagate")
	}
}

func TestRPCDecryptor_EndToEndWithBridge(t *testing.T) {
	// Full chain: decrypt → parse inner → route through bridge.
	innerJSON := []byte(`{"method":"POST","path":"/api/v1/remember","headers":{"Content-Type":"application/json"},"body":"{\"text\":\"test\"}"}`)

	decryptor := &mockDecryptor{plaintext: innerJSON}
	converter := &mockKeyConverter{}

	d, _ := NewRPCDecryptor(decryptor, converter, make([]byte, 32), make([]byte, 64))

	ciphertextB64 := base64.StdEncoding.EncodeToString([]byte("encrypted-blob-placeholder-data-32bytes-minimum!!"))

	// Decrypt.
	decrypted, err := d.DecryptCiphertext(ciphertextB64)
	if err != nil {
		t.Fatal(err)
	}

	// Feed into RPC bridge (no auth handler — just verifies the chain works).
	bridge := NewRPCBridge(stubHandler(nil, nil))
	resp, err := bridge.HandleInnerRequest(decrypted)
	if err != nil {
		t.Fatalf("bridge: %v", err)
	}
	// The stub handler returns 401 (no device key registered) — but the
	// decrypt → bridge chain worked without error.
	if resp.Status == 0 {
		t.Error("response should have a status code")
	}
}
