package crypto

import (
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/bluesky-social/indigo/atproto/atcrypto"
)

const (
	// k256KeyFile is the filename for the persisted k256 rotation key.
	k256KeyFile = "rotation_key_k256.bin"

	// k256KeySize is the expected size of a raw k256 private key in bytes.
	k256KeySize = 32

	// identityDirName is the subdirectory under dataDir where keys are stored.
	identityDirName = "identity"

	// identityDirPerm is the permission mode for the identity directory.
	identityDirPerm = 0700

	// keyFilePerm is the permission mode for private key files.
	keyFilePerm = 0600
)

// K256KeyManager generates, persists, and loads secp256k1 (k256) rotation keys
// for PLC directory operations. The rotation key authorizes DID updates.
//
// All methods that access the private key are safe for concurrent use.
type K256KeyManager struct {
	mu      sync.Mutex
	dataDir string
	privKey *atcrypto.PrivateKeyK256
}

// NewK256KeyManager creates a key manager that persists keys to the given
// dataDir. The actual key file is stored at {dataDir}/identity/rotation_key_k256.bin.
func NewK256KeyManager(dataDir string) *K256KeyManager {
	return &K256KeyManager{
		dataDir: dataDir,
	}
}

// keyPath returns the full filesystem path to the k256 key file.
func (m *K256KeyManager) keyPath() string {
	return filepath.Join(m.dataDir, identityDirName, k256KeyFile)
}

// identityDir returns the full filesystem path to the identity directory.
func (m *K256KeyManager) identityDir() string {
	return filepath.Join(m.dataDir, identityDirName)
}

// GenerateOrLoad returns the k256 private key, loading from disk if it exists
// or generating a new one if not. The loaded key is cached so subsequent calls
// return immediately without disk I/O.
func (m *K256KeyManager) GenerateOrLoad() (*atcrypto.PrivateKeyK256, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	// Return cached key if already loaded.
	if m.privKey != nil {
		return m.privKey, nil
	}

	// Try loading from disk first.
	if err := m.loadLocked(); err == nil {
		return m.privKey, nil
	}

	// Key does not exist or is unreadable — generate a new one.
	if err := m.generateLocked(); err != nil {
		return nil, fmt.Errorf("k256: generate or load: %w", err)
	}

	return m.privKey, nil
}

// Generate creates a new k256 rotation key and persists it to disk. If a key
// already exists on disk it will be overwritten. The new key is cached in
// memory.
func (m *K256KeyManager) Generate() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.generateLocked()
}

// generateLocked performs key generation without acquiring the mutex.
// The caller must hold m.mu.
func (m *K256KeyManager) generateLocked() error {
	key, err := atcrypto.GeneratePrivateKeyK256()
	if err != nil {
		return fmt.Errorf("k256: generate key: %w", err)
	}

	raw := key.Bytes()
	if len(raw) != k256KeySize {
		return fmt.Errorf("k256: generated key has unexpected size %d (want %d)", len(raw), k256KeySize)
	}

	// Ensure the identity directory exists.
	dir := m.identityDir()
	if err := os.MkdirAll(dir, identityDirPerm); err != nil {
		return fmt.Errorf("k256: create identity dir %s: %w", dir, err)
	}

	// Write the key file atomically: write to a temp file then rename.
	path := m.keyPath()
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, keyFilePerm); err != nil {
		return fmt.Errorf("k256: write temp key file: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		// Clean up the temp file on rename failure.
		_ = os.Remove(tmp)
		return fmt.Errorf("k256: rename key file: %w", err)
	}

	m.privKey = key
	return nil
}

// Load reads a persisted k256 key from disk and caches it. Returns an error if
// the key file does not exist, is the wrong size, or cannot be parsed.
func (m *K256KeyManager) Load() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.loadLocked()
}

// loadLocked performs the disk read without acquiring the mutex.
// The caller must hold m.mu.
func (m *K256KeyManager) loadLocked() error {
	path := m.keyPath()

	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("k256: key file not found at %s", path)
		}
		return fmt.Errorf("k256: read key file %s: %w", path, err)
	}

	if len(data) != k256KeySize {
		return fmt.Errorf("k256: corrupt key file %s: expected %d bytes, got %d", path, k256KeySize, len(data))
	}

	key, err := atcrypto.ParsePrivateBytesK256(data)
	if err != nil {
		return fmt.Errorf("k256: parse key from %s: %w", path, err)
	}

	m.privKey = key
	return nil
}

// PrivateKey returns the loaded private key, or nil if no key has been loaded
// or generated yet.
func (m *K256KeyManager) PrivateKey() *atcrypto.PrivateKeyK256 {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.privKey
}

// PublicDIDKey returns the did:key string for the rotation key's public key.
// Returns an error if no key has been loaded or generated.
func (m *K256KeyManager) PublicDIDKey() (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.privKey == nil {
		return "", fmt.Errorf("k256: no private key loaded; call GenerateOrLoad or Load first")
	}

	pub, err := m.privKey.PublicKey()
	if err != nil {
		return "", fmt.Errorf("k256: derive public key: %w", err)
	}

	return pub.DIDKey(), nil
}

// PrivateKeyHex returns the hex-encoded private key bytes. This is the format
// expected by PDS environment configuration (PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX).
// Returns an error if no key has been loaded or generated.
func (m *K256KeyManager) PrivateKeyHex() (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.privKey == nil {
		return "", fmt.Errorf("k256: no private key loaded; call GenerateOrLoad or Load first")
	}

	raw := m.privKey.Bytes()
	if len(raw) != k256KeySize {
		return "", fmt.Errorf("k256: private key has unexpected size %d (want %d)", len(raw), k256KeySize)
	}

	return hex.EncodeToString(raw), nil
}
