package pairing

import (
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
)

// persistedDevice is the JSON-serializable form of deviceRecord.
type persistedDevice struct {
	TokenID      string `json:"token_id"`
	Name         string `json:"name"`
	TokenHashHex string `json:"token_hash,omitempty"` // hex-encoded SHA-256
	PublicKeyHex string `json:"public_key,omitempty"` // hex-encoded Ed25519 public key
	DID          string `json:"did,omitempty"`
	Role         string `json:"role,omitempty"` // "user" or "agent"
	CreatedAt    int64  `json:"created_at"`
	LastSeen     int64  `json:"last_seen"`
	Revoked      bool   `json:"revoked"`
}

// SetPersistPath sets the file path for device persistence.
// Loads existing devices from the file if it exists.
// Must be called before any pairing operations.
func (pm *PairingManager) SetPersistPath(path string) error {
	pm.mu.Lock()
	defer pm.mu.Unlock()
	pm.persistPath = path

	if _, err := os.Stat(path); os.IsNotExist(err) {
		return nil // no file yet — will be created on first pair
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if len(data) == 0 {
		return nil
	}

	var records []persistedDevice
	if err := json.Unmarshal(data, &records); err != nil {
		return err
	}

	for _, r := range records {
		role := r.Role
		if role == "" {
			role = "user" // default for devices persisted before role was added
		}
		d := deviceRecord{
			tokenID:   r.TokenID,
			name:      r.Name,
			did:       r.DID,
			role:      role,
			createdAt: r.CreatedAt,
			lastSeen:  r.LastSeen,
			revoked:   r.Revoked,
		}
		if r.TokenHashHex != "" {
			d.tokenHash, _ = hex.DecodeString(r.TokenHashHex)
		}
		if r.PublicKeyHex != "" {
			keyBytes, _ := hex.DecodeString(r.PublicKeyHex)
			if len(keyBytes) == ed25519.PublicKeySize {
				d.publicKey = ed25519.PublicKey(keyBytes)
			}
		}
		pm.devices = append(pm.devices, d)
		if pm.nextID <= len(pm.devices) {
			pm.nextID = len(pm.devices)
		}
	}

	slog.Info("pairing: loaded devices from disk", "count", len(records), "path", path)
	return nil
}

// persistDevices writes the current device list to disk.
// Called after every mutation (pair, revoke).
func (pm *PairingManager) persistDevices() {
	if pm.persistPath == "" {
		return
	}

	records := make([]persistedDevice, len(pm.devices))
	for i, d := range pm.devices {
		r := persistedDevice{
			TokenID:   d.tokenID,
			Name:      d.name,
			DID:       d.did,
			Role:      d.role,
			CreatedAt: d.createdAt,
			LastSeen:  d.lastSeen,
			Revoked:   d.revoked,
		}
		if len(d.tokenHash) > 0 {
			r.TokenHashHex = hex.EncodeToString(d.tokenHash)
		}
		if len(d.publicKey) > 0 {
			r.PublicKeyHex = hex.EncodeToString(d.publicKey)
		}
		records[i] = r
	}

	data, err := json.MarshalIndent(records, "", "  ")
	if err != nil {
		slog.Warn("pairing: failed to marshal devices", "error", err)
		return
	}

	dir := filepath.Dir(pm.persistPath)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		slog.Warn("pairing: failed to create persist dir", "error", err)
		return
	}

	tmp := pm.persistPath + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		slog.Warn("pairing: failed to write devices", "error", err)
		return
	}
	if err := os.Rename(tmp, pm.persistPath); err != nil {
		slog.Warn("pairing: failed to rename devices file", "error", err)
	}
}
