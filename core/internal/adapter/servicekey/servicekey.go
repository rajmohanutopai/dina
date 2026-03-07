// Package servicekey manages Ed25519 keypairs for service-to-service authentication.
//
// Keys are provisioned at install time (seed-derived via SLIP-0010). At runtime,
// each service loads its existing keypair — no key generation occurs.
// Private keys live in {keyDir}/private/ — each container bind-mounts a
// different host directory here, so private keys are never in the peer's
// filesystem namespace. Public keys live in {keyDir}/public/ — a shared
// read-only directory both containers can read.
//
// Signing uses the same canonical payload format as CLI device auth:
//
//	{METHOD}\n{PATH}\n{QUERY}\n{TIMESTAMP}\n{SHA256_HEX(BODY)}
package servicekey

import (
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// ServiceKey manages an Ed25519 keypair for service-to-service authentication.
type ServiceKey struct {
	privateKey ed25519.PrivateKey
	publicKey  ed25519.PublicKey
	did        string
	keyDir     string
}

// New returns a ServiceKey that stores keys in keyDir.
func New(keyDir string) *ServiceKey {
	return &ServiceKey{keyDir: keyDir}
}

// EnsureExistingKey loads an existing keypair for serviceName and fails if the
// private key file is missing. Keys are provisioned at install time — this
// method never generates new key material.
//
// Layout (isolation enforced by separate Docker bind mounts):
//
//	{keyDir}/private/{serviceName}_ed25519_private.pem  (0600, own container only)
//	{keyDir}/public/{serviceName}_ed25519_public.pem    (0644, shared)
func (sk *ServiceKey) EnsureExistingKey(serviceName string) error {
	privDir := filepath.Join(sk.keyDir, "private")
	pubDir := filepath.Join(sk.keyDir, "public")
	privPath := filepath.Join(privDir, serviceName+"_ed25519_private.pem")
	pubPath := filepath.Join(pubDir, serviceName+"_ed25519_public.pem")

	if _, err := os.Stat(privPath); err != nil {
		return fmt.Errorf("servicekey: missing private key %q (run install.sh to provision)", privPath)
	}
	return sk.loadKey(privPath, pubPath)
}

// LoadPeerKey reads a peer service's public key from the shared public directory.
// Returns the raw public key bytes (32 bytes), the did:key string, and any error.
func (sk *ServiceKey) LoadPeerKey(peerName string) (ed25519.PublicKey, string, error) {
	pubPath := filepath.Join(sk.keyDir, "public", peerName+"_ed25519_public.pem")
	pemData, err := os.ReadFile(pubPath)
	if err != nil {
		return nil, "", fmt.Errorf("servicekey: read peer key %q: %w", peerName, err)
	}
	pub, err := parsePublicKey(pemData)
	if err != nil {
		return nil, "", fmt.Errorf("servicekey: parse peer key %q: %w", peerName, err)
	}
	return pub, deriveDID(pub), nil
}

// SignRequest signs an HTTP request using the CLI canonical payload format.
// Returns (did, timestamp, signatureHex).
func (sk *ServiceKey) SignRequest(method, path, query string, body []byte) (string, string, string) {
	timestamp := time.Now().UTC().Format("2006-01-02T15:04:05Z")
	bodyHash := sha256Hex(body)
	payload := fmt.Sprintf("%s\n%s\n%s\n%s\n%s", method, path, query, timestamp, bodyHash)
	sig := ed25519.Sign(sk.privateKey, []byte(payload))
	return sk.did, timestamp, hex.EncodeToString(sig)
}

// DID returns the did:key identifier for this service.
func (sk *ServiceKey) DID() string {
	return sk.did
}

// PublicKey returns the raw Ed25519 public key.
func (sk *ServiceKey) PublicKey() ed25519.PublicKey {
	return sk.publicKey
}

// RawPublicKey returns the 32-byte raw public key for registration.
func (sk *ServiceKey) RawPublicKey() []byte {
	return []byte(sk.publicKey)
}

// --- internal helpers ---

func (sk *ServiceKey) loadKey(privPath, pubPath string) error {
	privPEM, err := os.ReadFile(privPath)
	if err != nil {
		return fmt.Errorf("servicekey: read private key: %w", err)
	}
	priv, err := parsePrivateKey(privPEM)
	if err != nil {
		return fmt.Errorf("servicekey: parse private key: %w", err)
	}
	sk.privateKey = priv
	sk.publicKey = priv.Public().(ed25519.PublicKey)
	sk.did = deriveDID(sk.publicKey)

	// Fail-closed: require matching public key file so tampering/partial state
	// does not silently proceed at runtime.
	pubPEM, err := os.ReadFile(pubPath)
	if err != nil {
		return fmt.Errorf("servicekey: read public key: %w", err)
	}
	pub, err := parsePublicKey(pubPEM)
	if err != nil {
		return fmt.Errorf("servicekey: parse public key: %w", err)
	}
	if len(pub) != len(sk.publicKey) {
		return fmt.Errorf("servicekey: public key length mismatch")
	}
	for i := range pub {
		if pub[i] != sk.publicKey[i] {
			return fmt.Errorf("servicekey: public key mismatch with private key")
		}
	}

	return nil
}

func marshalPrivateKey(key ed25519.PrivateKey) ([]byte, error) {
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, fmt.Errorf("servicekey: marshal private key: %w", err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), nil
}

func marshalPublicKey(key ed25519.PublicKey) ([]byte, error) {
	der, err := x509.MarshalPKIXPublicKey(key)
	if err != nil {
		return nil, fmt.Errorf("servicekey: marshal public key: %w", err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}), nil
}

func parsePrivateKey(pemData []byte) (ed25519.PrivateKey, error) {
	block, _ := pem.Decode(pemData)
	if block == nil {
		return nil, fmt.Errorf("servicekey: no PEM block found")
	}
	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("servicekey: parse PKCS8: %w", err)
	}
	edKey, ok := key.(ed25519.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("servicekey: not an Ed25519 key")
	}
	return edKey, nil
}

func parsePublicKey(pemData []byte) (ed25519.PublicKey, error) {
	block, _ := pem.Decode(pemData)
	if block == nil {
		return nil, fmt.Errorf("servicekey: no PEM block found")
	}
	key, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("servicekey: parse PKIX: %w", err)
	}
	edKey, ok := key.(ed25519.PublicKey)
	if !ok {
		return nil, fmt.Errorf("servicekey: not an Ed25519 key")
	}
	return edKey, nil
}

// deriveDID produces a did:key:z... identifier from an Ed25519 public key.
// Format: did:key:z{base58btc(0xed01 + raw_32byte_pubkey)}
func deriveDID(pub ed25519.PublicKey) string {
	// Multicodec prefix for Ed25519: 0xed 0x01
	multicodec := append([]byte{0xed, 0x01}, pub...)
	return "did:key:z" + base58Encode(multicodec)
}

func sha256Hex(data []byte) string {
	h := sha256.Sum256(data)
	return hex.EncodeToString(h[:])
}

// base58Encode encodes data using Bitcoin's base58 alphabet.
// Minimal implementation — no external dependency.
func base58Encode(data []byte) string {
	const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

	// Count leading zero bytes.
	var leadingZeros int
	for _, b := range data {
		if b != 0 {
			break
		}
		leadingZeros++
	}

	// Convert big-endian bytes to base58.
	// Work on a copy to avoid mutating input.
	buf := make([]byte, len(data))
	copy(buf, data)

	var encoded []byte
	for {
		allZero := true
		var carry int
		for i := range buf {
			carry = carry*256 + int(buf[i])
			buf[i] = byte(carry / 58)
			carry %= 58
			if buf[i] != 0 {
				allZero = false
			}
		}
		encoded = append([]byte{alphabet[carry]}, encoded...)
		if allZero {
			break
		}
	}

	// Add leading '1's for each leading zero byte.
	for i := 0; i < leadingZeros; i++ {
		encoded = append([]byte{alphabet[0]}, encoded...)
	}

	return string(encoded)
}
