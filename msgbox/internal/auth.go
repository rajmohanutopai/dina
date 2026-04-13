package internal

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// Auth frame types.
const (
	AuthChallengeType = "auth_challenge"
	AuthResponseType  = "auth_response"
)

// AuthChallenge is sent by the msgbox on new WebSocket connections.
type AuthChallenge struct {
	Type  string `json:"type"`
	Nonce string `json:"nonce"`
	TS    int64  `json:"ts"`
}

// AuthResponse is sent by the home node to prove DID ownership.
type AuthResponse struct {
	Type string `json:"type"`
	DID  string `json:"did"`
	Sig  string `json:"sig"` // hex-encoded Ed25519 signature
	Pub  string `json:"pub"` // hex-encoded 32-byte Ed25519 public key
}

// AuthTimeout is how long the msgbox waits for a valid auth response.
const AuthTimeout = 5 * time.Second

// Authenticate performs the challenge-response handshake on a new WebSocket.
// For did:key DIDs, the public key is self-certifying. For did:plc DIDs,
// pass a PLCResolver via AuthenticateWithResolver for full verification.
// Without a resolver, did:plc verification is deferred (the signature is
// still verified, but the key is not cross-checked against the PLC document).
func Authenticate(ctx context.Context, ws *websocket.Conn) (string, error) {
	return AuthenticateWithResolver(ctx, ws, nil)
}

// verifyDIDKeyDirect verifies that a did:key DID encodes the given public key.
// did:key is self-certifying: the DID IS the public key.
func verifyDIDKeyDirect(did string, pubKey []byte) error {
	expected := deriveDIDKey(pubKey)
	if did != expected {
		return fmt.Errorf("did:key mismatch: claimed %s, key derives %s", did, expected)
	}
	return nil
}

// PLCResolver fetches PLC documents for did:plc verification.
// Implementations: real HTTP fetcher (production), mock (tests).
type PLCResolver interface {
	// Resolve fetches the PLC document and returns the Ed25519 public key
	// from the #dina_signing verification method. Returns error if the
	// document cannot be fetched or has no #dina_signing key.
	ResolveDinaSigningKey(ctx context.Context, did string) (ed25519.PublicKey, error)
}

// CachingPLCResolver wraps a PLCResolver with a TTL-based in-memory cache.
// Thread-safe. Injectable clock for testing.
type CachingPLCResolver struct {
	inner PLCResolver
	ttl   time.Duration
	now   func() time.Time // injectable clock; defaults to time.Now

	mu    sync.Mutex
	cache map[string]plcCacheEntry
}

type plcCacheEntry struct {
	key       ed25519.PublicKey
	fetchedAt time.Time
}

// NewCachingPLCResolver creates a caching resolver with the given TTL.
func NewCachingPLCResolver(inner PLCResolver, ttl time.Duration) *CachingPLCResolver {
	return &CachingPLCResolver{
		inner: inner,
		ttl:   ttl,
		now:   time.Now,
		cache: make(map[string]plcCacheEntry),
	}
}

// ResolveDinaSigningKey returns the cached key if still valid, otherwise fetches
// from the inner resolver and caches the result.
func (c *CachingPLCResolver) ResolveDinaSigningKey(ctx context.Context, did string) (ed25519.PublicKey, error) {
	c.mu.Lock()
	entry, ok := c.cache[did]
	if ok && c.now().Sub(entry.fetchedAt) < c.ttl {
		c.mu.Unlock()
		return entry.key, nil
	}
	c.mu.Unlock()

	// Cache miss or expired — fetch from inner resolver.
	key, err := c.inner.ResolveDinaSigningKey(ctx, did)
	if err != nil {
		return nil, err
	}

	c.mu.Lock()
	c.cache[did] = plcCacheEntry{key: key, fetchedAt: c.now()}
	c.mu.Unlock()

	return key, nil
}

// FetchCount returns how many times the inner resolver was actually called.
// Only used for testing — not part of PLCResolver interface.
// This requires the inner resolver to track calls (see countingPLCResolver in tests).

// AuthenticateWithResolver performs challenge-response with full DID verification.
// For did:key: self-certifying (public key is the DID).
// For did:plc: fetches PLC document via resolver, verifies #dina_signing key.
func AuthenticateWithResolver(ctx context.Context, ws *websocket.Conn, resolver PLCResolver) (string, error) {
	authCtx, cancel := context.WithTimeout(ctx, AuthTimeout)
	defer cancel()

	// 1. Generate and send challenge.
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		return "", fmt.Errorf("auth: generate nonce: %w", err)
	}
	ts := time.Now().Unix()
	challenge := AuthChallenge{
		Type:  AuthChallengeType,
		Nonce: hex.EncodeToString(nonce),
		TS:    ts,
	}
	chalBytes, _ := json.Marshal(challenge)
	if err := ws.Write(authCtx, websocket.MessageText, chalBytes); err != nil {
		return "", fmt.Errorf("auth: write challenge: %w", err)
	}

	// 2. Read response.
	_, respBytes, err := ws.Read(authCtx)
	if err != nil {
		return "", fmt.Errorf("auth: read response: %w", err)
	}
	var resp AuthResponse
	if err := json.Unmarshal(respBytes, &resp); err != nil {
		return "", fmt.Errorf("auth: parse response: %w", err)
	}
	if resp.Type != AuthResponseType {
		return "", errors.New("auth: unexpected frame type")
	}
	if resp.DID == "" || resp.Sig == "" || resp.Pub == "" {
		return "", errors.New("auth: missing required fields")
	}

	// 3. Decode provided public key.
	pubBytes, err := hex.DecodeString(resp.Pub)
	if err != nil || len(pubBytes) != ed25519.PublicKeySize {
		return "", errors.New("auth: invalid public key")
	}

	// 4. Verify the public key is bound to the claimed DID.
	switch {
	case strings.HasPrefix(resp.DID, "did:key:"):
		// Self-certifying: derive did:key from provided pubkey, must match.
		if err := verifyDIDKeyDirect(resp.DID, pubBytes); err != nil {
			return "", fmt.Errorf("auth: %w", err)
		}
	case strings.HasPrefix(resp.DID, "did:plc:"):
		// Fetch PLC document, extract #dina_signing key, compare to provided key.
		if resolver == nil {
			// No resolver: accept with signature-only verification.
			// The node proves key ownership but we can't verify DID-to-key binding.
			// Production should always pass a resolver; nil is for backward compat.
			break
		}
		plcKey, err := resolver.ResolveDinaSigningKey(authCtx, resp.DID)
		if err != nil {
			return "", fmt.Errorf("auth: resolve PLC document: %w", err)
		}
		if !ed25519.PublicKey(pubBytes).Equal(plcKey) {
			return "", errors.New("auth: public key does not match #dina_signing in PLC document")
		}
	default:
		return "", fmt.Errorf("auth: unsupported DID method: %s", resp.DID)
	}

	// 5. Verify Ed25519 signature over challenge payload.
	sigBytes, err := hex.DecodeString(resp.Sig)
	if err != nil || len(sigBytes) != ed25519.SignatureSize {
		return "", errors.New("auth: invalid signature encoding")
	}
	challengePayload := fmt.Sprintf("AUTH_RELAY\n%s\n%d", challenge.Nonce, challenge.TS)
	if !ed25519.Verify(pubBytes, []byte(challengePayload), sigBytes) {
		return "", errors.New("auth: signature verification failed")
	}

	return resp.DID, nil
}

// deriveDIDKey computes did:key:z... from a raw Ed25519 public key.
func deriveDIDKey(pub []byte) string {
	// Multicodec prefix for Ed25519: 0xed 0x01
	multicodec := append([]byte{0xed, 0x01}, pub...)
	return "did:key:z" + base58Encode(multicodec)
}

// base58Encode encodes bytes to Bitcoin base58 (no check).
func base58Encode(data []byte) string {
	const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
	// Convert to big integer.
	var result []byte
	for _, b := range data {
		carry := int(b)
		for i := len(result) - 1; i >= 0; i-- {
			carry += int(result[i]) * 256
			result[i] = byte(carry % 58)
			carry /= 58
		}
		for carry > 0 {
			result = append([]byte{byte(carry % 58)}, result...)
			carry /= 58
		}
	}
	// Leading zeros.
	for _, b := range data {
		if b != 0 {
			break
		}
		result = append([]byte{0}, result...)
	}
	// Map to alphabet.
	out := make([]byte, len(result))
	for i, b := range result {
		out[i] = alphabet[b]
	}
	return string(out)
}
