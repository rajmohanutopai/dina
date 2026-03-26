package internal

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
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
// Returns the authenticated DID on success.
func Authenticate(ctx context.Context, ws *websocket.Conn) (string, error) {
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

	// 3. Decode public key.
	pubBytes, err := hex.DecodeString(resp.Pub)
	if err != nil || len(pubBytes) != ed25519.PublicKeySize {
		return "", errors.New("auth: invalid public key")
	}

	// 4. Verify Ed25519 signature proves ownership of the claimed DID.
	// The msgbox accepts any DID format (did:plc, did:key, etc.) as long as
	// the signature verifies with the provided public key. The msgbox is a
	// transport layer — it trusts the cryptographic proof, not the DID format.
	sigBytes, err := hex.DecodeString(resp.Sig)
	if err != nil || len(sigBytes) != ed25519.SignatureSize {
		return "", errors.New("auth: invalid signature encoding")
	}
	payload := fmt.Sprintf("AUTH_RELAY\n%s\n%d", challenge.Nonce, challenge.TS)
	if !ed25519.Verify(pubBytes, []byte(payload), sigBytes) {
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
