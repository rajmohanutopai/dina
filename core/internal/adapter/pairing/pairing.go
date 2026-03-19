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
	"crypto/subtle"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/mr-tron/base58"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
)

// ---------------------------------------------------------------------------
// Sentinel errors
// ---------------------------------------------------------------------------

var (
	ErrInvalidCode         = errors.New("pairing: invalid or expired pairing code")
	ErrCodeUsed            = errors.New("pairing: pairing code already used")
	ErrDeviceNotFound      = errors.New("pairing: device not found")
	ErrDeviceRevoked       = errors.New("pairing: device already revoked")
	ErrTooManyPendingCodes = errors.New("pairing: too many pending codes")
	ErrCodeCollision       = errors.New("pairing: failed to generate unique code after retries")
)

// maxPendingCodes is the hard cap on pending pairing codes (SEC-MED-13).
const maxPendingCodes = 100

// maxCodeRetries is the maximum number of attempts to generate a unique
// 6-digit code before returning ErrCodeCollision. With a 900,000-code
// space and maxPendingCodes=100, collision is unlikely but non-trivial.
const maxCodeRetries = 5

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
	tokenHash []byte            // present for token-auth devices
	publicKey ed25519.PublicKey // present for signature-auth devices
	did       string            // did:key:z6Mk... for signature-auth devices
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
	mu          sync.Mutex
	codes       map[string]*pairingCode // code -> pending pairing
	devices     []deviceRecord
	codeTTL     time.Duration
	nodeDID     string
	wsURL       string
	nextID      int
	persistPath string // JSON file for device persistence across restarts
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

	// SEC-MED-13: Hard cap on pending pairing codes.
	if len(pm.codes) >= maxPendingCodes {
		return "", nil, ErrTooManyPendingCodes
	}

	// Retry loop: generate a unique 6-digit code, checking for collisions
	// with existing live (non-expired, non-used) codes in pm.codes.
	for attempt := 0; attempt < maxCodeRetries; attempt++ {
		// Generate a cryptographically random secret (32 bytes = 256-bit entropy).
		secret := make([]byte, SecretLength)
		if _, err := rand.Read(secret); err != nil {
			return "", nil, fmt.Errorf("pairing: failed to generate secret: %w", err)
		}

		// Derive a 6-digit numeric pairing code from the secret.
		// Architecture §10: "Core generates 6-digit pairing code (expires in 5 minutes)".
		// The code is a short-lived physical proximity proof (100000–999999).
		// The 32-byte secret remains the cryptographic material for key derivation.
		hash := sha256.Sum256(secret)
		num := binary.BigEndian.Uint32(hash[:4])
		code := fmt.Sprintf("%06d", 100000+(num%900000))

		// Check for collision with an existing live code.
		if existing, ok := pm.codes[code]; ok {
			if !existing.used && time.Since(existing.createdAt) <= pm.codeTTL {
				// Live collision — retry with a fresh secret.
				continue
			}
			// Expired or used entry — safe to overwrite.
		}

		pc := &pairingCode{
			code:      code,
			secret:    secret,
			createdAt: time.Now(),
			used:      false,
		}
		pm.codes[code] = pc

		return code, secret, nil
	}

	return "", nil, ErrCodeCollision
}

// CompletePairing verifies the code and registers the device.
// Returns the CLIENT_TOKEN hex string and the token ID atomically.
func (pm *PairingManager) CompletePairing(_ context.Context, code string, deviceName string) (string, string, error) {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	pc, ok := pm.codes[code]
	if !ok {
		return "", "", ErrInvalidCode
	}

	// Check if already used (single-use codes).
	if pc.used {
		return "", "", ErrCodeUsed
	}

	// Check TTL expiry.
	if time.Since(pc.createdAt) > pm.codeTTL {
		delete(pm.codes, code)
		return "", "", ErrInvalidCode
	}

	// Mark as used and delete immediately (SEC-MED-13).
	pc.used = true
	delete(pm.codes, code)

	// Generate CLIENT_TOKEN (32 bytes = 64 hex chars).
	tokenBytes := make([]byte, TokenLength)
	if _, err := rand.Read(tokenBytes); err != nil {
		return "", "", fmt.Errorf("pairing: failed to generate CLIENT_TOKEN: %w", err)
	}
	clientToken := hex.EncodeToString(tokenBytes)

	// Compute token hash for storage.
	tokenHash := sha256.Sum256(tokenBytes)

	// SEC-HIGH-02: Generate token ID atomically within the same critical section
	// to prevent TOCTOU race between CompletePairing and CompletePairingFull.
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
	pm.persistDevices()

	return clientToken, tokenID, nil
}

// CompletePairingFull verifies the code and returns full pair response.
func (pm *PairingManager) CompletePairingFull(ctx context.Context, code string, deviceName string) (*PairResponse, error) {
	// SEC-HIGH-02: tokenID is now returned atomically from CompletePairing,
	// eliminating the TOCTOU race of re-reading pm.devices[n-1].
	clientToken, tokenID, err := pm.CompletePairing(ctx, code, deviceName)
	if err != nil {
		return nil, err
	}

	pm.mu.Lock()
	nodeDID := pm.nodeDID
	wsURL := pm.wsURL
	pm.mu.Unlock()

	return &PairResponse{
		ClientToken: clientToken,
		TokenID:     tokenID,
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
	delete(pm.codes, code) // SEC-MED-13: immediate cleanup

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
	pm.persistDevices()

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
			pm.persistDevices()
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
		if len(d.tokenHash) == len(tokenHash) && subtle.ConstantTimeCompare(d.tokenHash, tokenHash[:]) == 1 {
			return d.tokenID, d.name, nil
		}
	}
	return "", "", errors.New("pairing: token not found or revoked")
}
