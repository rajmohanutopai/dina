// Package pairing implements device pairing via QR code / numeric PIN (section 10).
//
// Provides the PairingManager, which handles:
//   - Generating pairing codes with cryptographic secrets
//   - Completing pairing to register devices and issue CLIENT_TOKENs
//   - Listing and revoking paired devices
//   - Full pairing response (client_token, node_did, ws_url)
package pairing

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/mr-tron/base58"

	"github.com/anthropics/dina/core/internal/domain"
	"github.com/anthropics/dina/core/internal/port"
)

// ---------------------------------------------------------------------------
// Sentinel errors
// ---------------------------------------------------------------------------

var (
	ErrInvalidCode    = errors.New("pairing: invalid or expired pairing code")
	ErrCodeUsed       = errors.New("pairing: pairing code already used")
	ErrDeviceNotFound = errors.New("pairing: device not found")
	ErrDeviceRevoked  = errors.New("pairing: device already revoked")
)

// Protocol constants.
const (
	SecretLength   = 32
	TokenLength    = 32
	DefaultCodeTTL = 5 * time.Minute
)

// Compile-time interface check.
var _ port.DevicePairer = (*PairingManager)(nil)

// Type aliases for domain type compatibility.
type PairResponse = domain.PairResponse
type PairedDevice = domain.PairedDevice

// pairingCode stores a pending pairing code and its metadata.
type pairingCode struct {
	code      string
	secret    []byte
	createdAt time.Time
	used      bool
}

// deviceRecord stores a registered device.
type deviceRecord struct {
	tokenID   string
	name      string
	tokenHash []byte             // nil for signature-auth devices
	publicKey ed25519.PublicKey   // nil for legacy token devices
	did       string             // did:key:z6Mk... (empty for legacy)
	createdAt int64
	lastSeen  int64
	revoked   bool
}

// ---------------------------------------------------------------------------
// PairingManager
// ---------------------------------------------------------------------------

// PairingManager handles device pairing via QR code / numeric PIN.
// It satisfies testutil.PairingManager.
type PairingManager struct {
	mu      sync.Mutex
	codes   map[string]*pairingCode // code -> pending pairing
	devices []deviceRecord
	codeTTL time.Duration
	nodeDID string
	wsURL   string
	nextID  int
}

// Config configures the PairingManager.
type Config struct {
	CodeTTL time.Duration // how long pairing codes are valid
	NodeDID string        // the Home Node's DID (returned in pair response)
	WsURL   string        // the WebSocket URL (returned in pair response)
}

// DefaultConfig returns sensible defaults.
func DefaultConfig() Config {
	return Config{
		CodeTTL: DefaultCodeTTL,
		NodeDID: "did:plc:homenode",
		WsURL:   "wss://dina.local:8100/ws",
	}
}

// NewManager returns a new PairingManager.
func NewManager(cfg Config) *PairingManager {
	if cfg.CodeTTL == 0 {
		cfg.CodeTTL = DefaultCodeTTL
	}
	if cfg.NodeDID == "" {
		cfg.NodeDID = "did:plc:homenode"
	}
	if cfg.WsURL == "" {
		cfg.WsURL = "wss://dina.local:8100/ws"
	}
	return &PairingManager{
		codes:   make(map[string]*pairingCode),
		codeTTL: cfg.CodeTTL,
		nodeDID: cfg.NodeDID,
		wsURL:   cfg.WsURL,
	}
}

// GenerateCode creates a new pairing code (QR or numeric).
// Returns the code string, the cryptographic secret, and any error.
func (pm *PairingManager) GenerateCode(_ context.Context) (string, []byte, error) {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	// Generate a cryptographically random secret (32 bytes = 256-bit entropy).
	secret := make([]byte, SecretLength)
	if _, err := rand.Read(secret); err != nil {
		return "", nil, fmt.Errorf("pairing: failed to generate secret: %w", err)
	}

	// Derive the pairing code from the secret.
	// Use first 16 bytes of SHA-256(secret) as a hex code.
	hash := sha256.Sum256(secret)
	code := hex.EncodeToString(hash[:16])

	pc := &pairingCode{
		code:      code,
		secret:    secret,
		createdAt: time.Now(),
		used:      false,
	}
	pm.codes[code] = pc

	return code, secret, nil
}

// CompletePairing verifies the code and registers the device.
// Returns the CLIENT_TOKEN hex string.
func (pm *PairingManager) CompletePairing(_ context.Context, code string, deviceName string) (string, error) {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	pc, ok := pm.codes[code]
	if !ok {
		return "", ErrInvalidCode
	}

	// Check if already used (single-use codes).
	if pc.used {
		return "", ErrCodeUsed
	}

	// Check TTL expiry.
	if time.Since(pc.createdAt) > pm.codeTTL {
		delete(pm.codes, code)
		return "", ErrInvalidCode
	}

	// Mark as used.
	pc.used = true

	// Generate CLIENT_TOKEN (32 bytes = 64 hex chars).
	tokenBytes := make([]byte, TokenLength)
	if _, err := rand.Read(tokenBytes); err != nil {
		return "", fmt.Errorf("pairing: failed to generate CLIENT_TOKEN: %w", err)
	}
	clientToken := hex.EncodeToString(tokenBytes)

	// Compute token hash for storage.
	tokenHash := sha256.Sum256(tokenBytes)

	// Generate token ID.
	pm.nextID++
	tokenID := fmt.Sprintf("tok-%d", pm.nextID)

	// Register the device.
	now := time.Now().Unix()
	pm.devices = append(pm.devices, deviceRecord{
		tokenID:   tokenID,
		name:      deviceName,
		tokenHash: tokenHash[:],
		createdAt: now,
		lastSeen:  now,
		revoked:   false,
	})

	return clientToken, nil
}

// CompletePairingFull verifies the code and returns full pair response.
func (pm *PairingManager) CompletePairingFull(ctx context.Context, code string, deviceName string) (*PairResponse, error) {
	clientToken, err := pm.CompletePairing(ctx, code, deviceName)
	if err != nil {
		return nil, err
	}

	pm.mu.Lock()
	nodeDID := pm.nodeDID
	wsURL := pm.wsURL
	pm.mu.Unlock()

	return &PairResponse{
		ClientToken: clientToken,
		NodeDID:     nodeDID,
		WsURL:       wsURL,
	}, nil
}

// CompletePairingWithKey verifies the code and registers a device using an
// Ed25519 public key (signature-based auth). No CLIENT_TOKEN is generated.
// Returns (deviceID, nodeDID, error).
func (pm *PairingManager) CompletePairingWithKey(
	_ context.Context, code, deviceName, publicKeyMultibase string,
) (string, string, error) {
	// Decode the multibase public key: strip "z" prefix, base58btc decode,
	// strip 2-byte multicodec prefix (0xed01).
	if len(publicKeyMultibase) < 2 || publicKeyMultibase[0] != 'z' {
		return "", "", errors.New("pairing: invalid multibase encoding (expected z-prefix)")
	}
	raw, err := base58.Decode(publicKeyMultibase[1:])
	if err != nil {
		return "", "", fmt.Errorf("pairing: invalid base58btc encoding: %w", err)
	}
	if len(raw) != 34 || raw[0] != 0xed || raw[1] != 0x01 {
		return "", "", errors.New("pairing: invalid Ed25519 multicodec prefix (expected 0xed01 + 32 bytes)")
	}
	pubKeyBytes := raw[2:]
	pubKey := ed25519.PublicKey(pubKeyBytes)

	pm.mu.Lock()
	defer pm.mu.Unlock()

	pc, ok := pm.codes[code]
	if !ok {
		return "", "", ErrInvalidCode
	}
	if pc.used {
		return "", "", ErrCodeUsed
	}
	if time.Since(pc.createdAt) > pm.codeTTL {
		delete(pm.codes, code)
		return "", "", ErrInvalidCode
	}
	pc.used = true

	pm.nextID++
	tokenID := fmt.Sprintf("tok-%d", pm.nextID)
	did := "did:key:" + publicKeyMultibase

	now := time.Now().Unix()
	pm.devices = append(pm.devices, deviceRecord{
		tokenID:   tokenID,
		name:      deviceName,
		publicKey: pubKey,
		did:       did,
		createdAt: now,
		lastSeen:  now,
		revoked:   false,
	})

	return tokenID, pm.nodeDID, nil
}

// ListDevices returns all paired devices.
func (pm *PairingManager) ListDevices(_ context.Context) ([]PairedDevice, error) {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	result := make([]PairedDevice, len(pm.devices))
	for i, d := range pm.devices {
		authType := "token"
		if d.publicKey != nil {
			authType = "ed25519"
		}
		result[i] = PairedDevice{
			TokenID:   d.tokenID,
			Name:      d.name,
			DID:       d.did,
			AuthType:  authType,
			LastSeen:  d.lastSeen,
			CreatedAt: d.createdAt,
			Revoked:   d.revoked,
		}
	}
	return result, nil
}

// RevokeDevice disables a device by token ID.
func (pm *PairingManager) RevokeDevice(_ context.Context, tokenID string) error {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	for i := range pm.devices {
		if pm.devices[i].tokenID == tokenID {
			if pm.devices[i].revoked {
				return ErrDeviceRevoked
			}
			pm.devices[i].revoked = true
			return nil
		}
	}
	return ErrDeviceNotFound
}

// PurgeExpiredCodes removes expired pairing codes from memory.
func (pm *PairingManager) PurgeExpiredCodes() int {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	purged := 0
	for code, pc := range pm.codes {
		if time.Since(pc.createdAt) > pm.codeTTL {
			delete(pm.codes, code)
			purged++
		}
	}
	return purged
}

// UpdateLastSeen updates the last_seen timestamp for a device.
func (pm *PairingManager) UpdateLastSeen(tokenID string) error {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	for i := range pm.devices {
		if pm.devices[i].tokenID == tokenID {
			pm.devices[i].lastSeen = time.Now().Unix()
			return nil
		}
	}
	return ErrDeviceNotFound
}

// ValidateToken checks a CLIENT_TOKEN against stored hashes.
// Returns (tokenID, deviceName, nil) on success.
func (pm *PairingManager) ValidateToken(token string) (string, string, error) {
	tokenBytes, err := hex.DecodeString(token)
	if err != nil {
		return "", "", errors.New("pairing: invalid token format")
	}

	tokenHash := sha256.Sum256(tokenBytes)

	pm.mu.Lock()
	defer pm.mu.Unlock()

	for _, d := range pm.devices {
		if d.revoked {
			continue
		}
		if len(d.tokenHash) == len(tokenHash) {
			match := true
			for j := range d.tokenHash {
				if d.tokenHash[j] != tokenHash[j] {
					match = false
					break
				}
			}
			if match {
				return d.tokenID, d.name, nil
			}
		}
	}
	return "", "", errors.New("pairing: token not found or revoked")
}
