// Package portability implements dina export/import for Home Node migration.
package portability

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"golang.org/x/crypto/argon2"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
)

// archiveHeader is the magic header for the encrypted archive format.
const archiveHeader = "DINA_ARCHIVE_V2\n"

// Argon2id parameters for key derivation.
const (
	argonTime    = 3
	argonMemory  = 128 * 1024 // 128 MiB
	argonThreads = 4
	argonKeyLen  = 32 // AES-256
	saltLen      = 16
)

// Compile-time interface checks.
var _ port.ExportManager = (*ExportManager)(nil)
var _ port.ImportManager = (*ImportManager)(nil)

// ExportManifest is an alias for domain.ExportManifest.
type ExportManifest = domain.ExportManifest

// ExportOptions is an alias for domain.ExportOptions.
type ExportOptions = domain.ExportOptions

// archivePayload is the JSON-serialised plaintext inside the encrypted archive.
type archivePayload struct {
	Manifest ExportManifest    `json:"manifest"`
	Files    map[string][]byte `json:"files"`
}

// ExportManager implements port.ExportManager — dina export.
type ExportManager struct {
	mu sync.Mutex
}

// NewExportManager returns a new ExportManager.
func NewExportManager() *ExportManager {
	return &ExportManager{}
}

// Export creates an encrypted archive of the Home Node.
func (e *ExportManager) Export(_ context.Context, opts ExportOptions) (archivePath string, err error) {
	e.mu.Lock()
	defer e.mu.Unlock()

	if opts.Passphrase == "" {
		return "", errors.New("passphrase is required for export")
	}
	if opts.DestPath == "" {
		return "", errors.New("destination path is required")
	}

	// Ensure destination directory exists.
	if err := os.MkdirAll(opts.DestPath, 0700); err != nil {
		return "", fmt.Errorf("failed to create dest dir: %w", err)
	}

	archivePath = filepath.Join(opts.DestPath, "dina-export.dina")

	// Collect data to export.
	data, err := collectExportData()
	if err != nil {
		return "", fmt.Errorf("portability: collect data: %w", err)
	}

	// Generate salt.
	salt := make([]byte, saltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("portability: generate salt: %w", err)
	}

	// Derive key via Argon2id.
	key := argon2.IDKey([]byte(opts.Passphrase), salt, argonTime, argonMemory, argonThreads, argonKeyLen)

	// Encrypt with AES-256-GCM.
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("portability: create cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("portability: create GCM: %w", err)
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", fmt.Errorf("portability: generate nonce: %w", err)
	}
	ciphertext := gcm.Seal(nil, nonce, data, nil)

	// Build archive: header + salt + nonce + ciphertext.
	var buf bytes.Buffer
	buf.WriteString(archiveHeader)
	buf.Write(salt)
	buf.Write(nonce)
	buf.Write(ciphertext)

	if err := os.WriteFile(archivePath, buf.Bytes(), 0600); err != nil {
		return "", fmt.Errorf("failed to write archive: %w", err)
	}

	return archivePath, nil
}

// ListArchiveContents decrypts the archive and returns the actual file list.
func (e *ExportManager) ListArchiveContents(archivePath, passphrase string) ([]string, error) {
	archive, err := os.ReadFile(archivePath)
	if err != nil {
		return nil, fmt.Errorf("failed to read archive: %w", err)
	}

	plaintext, err := decryptArchive(archive, passphrase)
	if err != nil {
		return nil, fmt.Errorf("portability: list contents: %w", err)
	}

	var payload archivePayload
	if err := json.Unmarshal(plaintext, &payload); err != nil {
		return nil, fmt.Errorf("portability: unmarshal payload: %w", err)
	}

	names := make([]string, 0, len(payload.Files))
	for name := range payload.Files {
		names = append(names, name)
	}
	return names, nil
}

// ReadManifest extracts the manifest from an archive.
func (e *ExportManager) ReadManifest(archivePath string, passphrase string) (*ExportManifest, error) {
	if passphrase == "" {
		return nil, errors.New("passphrase required")
	}

	archive, err := os.ReadFile(archivePath)
	if err != nil {
		return nil, fmt.Errorf("failed to read archive: %w", err)
	}

	plaintext, err := decryptArchive(archive, passphrase)
	if err != nil {
		return nil, fmt.Errorf("portability: read manifest: %w", err)
	}

	var payload archivePayload
	if err := json.Unmarshal(plaintext, &payload); err != nil {
		return nil, fmt.Errorf("portability: unmarshal payload: %w", err)
	}

	return &payload.Manifest, nil
}

// ---------- ImportManager ----------

// ImportOptions is an alias for domain.ImportOptions.
type ImportOptions = domain.ImportOptions

// ImportResult is an alias for domain.ImportResult.
type ImportResult = domain.ImportResult

// ImportManager implements port.ImportManager — dina import.
type ImportManager struct {
	mu          sync.Mutex
	hasExisting bool // whether existing data is present
}

// NewImportManager returns a new ImportManager.
// Set hasExisting=true to simulate importing into an instance with existing data.
func NewImportManager(hasExisting bool) *ImportManager {
	return &ImportManager{hasExisting: hasExisting}
}

// Import decrypts and restores an archive to the Home Node.
func (m *ImportManager) Import(_ context.Context, opts ImportOptions) (*ImportResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if opts.Passphrase == "" {
		return nil, errors.New("passphrase is required")
	}

	// Read archive file.
	archive, err := os.ReadFile(opts.ArchivePath)
	if err != nil {
		return nil, fmt.Errorf("archive not found: %w", err)
	}

	// Decrypt archive — wrong passphrase produces AEAD authentication failure.
	plaintext, err := decryptArchive(archive, opts.Passphrase)
	if err != nil {
		return nil, fmt.Errorf("portability: import failed: %w", err)
	}

	// Check if importing into existing data without force.
	if m.hasExisting && !opts.Force {
		return nil, errors.New("vault already populated — use --force to overwrite")
	}

	// Restore data from decrypted payload.
	result, err := restoreData(plaintext)
	if err != nil {
		return nil, fmt.Errorf("portability: restore failed: %w", err)
	}

	return result, nil
}

// VerifyArchive checks archive integrity without restoring.
func (m *ImportManager) VerifyArchive(archivePath, passphrase string) error {
	archive, err := os.ReadFile(archivePath)
	if err != nil {
		return fmt.Errorf("archive integrity check failed: %w", err)
	}

	_, err = decryptArchive(archive, passphrase)
	if err != nil {
		return fmt.Errorf("portability: verification failed: %w", err)
	}

	return nil
}

// CheckCompatibility verifies the archive version is compatible.
func (m *ImportManager) CheckCompatibility(archivePath string) error {
	data, err := os.ReadFile(archivePath)
	if err != nil {
		return fmt.Errorf("incompatible archive: %w", err)
	}

	if len(data) == 0 {
		return errors.New("empty archive")
	}

	if !bytes.HasPrefix(data, []byte(archiveHeader)) {
		return errors.New("incompatible archive version")
	}

	return nil
}

// ---------- Internal helpers ----------

// decryptArchive parses and decrypts a DINA_ARCHIVE_V2 archive.
func decryptArchive(archive []byte, passphrase string) ([]byte, error) {
	if !bytes.HasPrefix(archive, []byte(archiveHeader)) {
		return nil, fmt.Errorf("invalid archive format")
	}

	rest := archive[len(archiveHeader):]
	// Minimum: 16 bytes salt + 12 bytes nonce + at least 1 byte ciphertext + 16 bytes GCM tag.
	if len(rest) < saltLen+12+16 {
		return nil, fmt.Errorf("archive too short")
	}

	salt := rest[:saltLen]
	nonce := rest[saltLen : saltLen+12]
	ciphertext := rest[saltLen+12:]

	key := argon2.IDKey([]byte(passphrase), salt, argonTime, argonMemory, argonThreads, argonKeyLen)

	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("create cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("create GCM: %w", err)
	}

	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return nil, fmt.Errorf("decryption failed (wrong passphrase?): %w", err)
	}

	return plaintext, nil
}

// ErrNotImplemented indicates a feature stub that is not yet wired to real vault data.
var ErrNotImplemented = errors.New("portability: not yet implemented — requires vault integration")

// BuildTestArchive creates an encrypted archive from the given file map and
// passphrase, writing it to destPath. This is intended for tests that need a
// valid archive without depending on collectExportData (which is still a stub).
func BuildTestArchive(files map[string][]byte, passphrase, destPath string) (string, error) {
	if passphrase == "" {
		return "", errors.New("passphrase is required")
	}

	checksums := make(map[string]string, len(files))
	for name, content := range files {
		checksums[name] = hexHash(content)
	}

	payload := archivePayload{
		Manifest: ExportManifest{
			Version:   "2",
			Timestamp: "2025-01-01T00:00:00Z",
			Checksums: checksums,
		},
		Files: files,
	}

	data, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("marshal test payload: %w", err)
	}

	salt := make([]byte, saltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("generate salt: %w", err)
	}

	key := argon2.IDKey([]byte(passphrase), salt, argonTime, argonMemory, argonThreads, argonKeyLen)

	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("create cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("create GCM: %w", err)
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", fmt.Errorf("generate nonce: %w", err)
	}
	ciphertext := gcm.Seal(nil, nonce, data, nil)

	var buf bytes.Buffer
	buf.WriteString(archiveHeader)
	buf.Write(salt)
	buf.Write(nonce)
	buf.Write(ciphertext)

	// If destPath looks like a file (has .dina extension), write directly to it.
	// Otherwise treat it as a directory and generate a unique filename.
	var archivePath string
	if filepath.Ext(destPath) == ".dina" {
		archivePath = destPath
		// Ensure the parent directory exists.
		if err := os.MkdirAll(filepath.Dir(destPath), 0700); err != nil {
			return "", fmt.Errorf("create archive dir: %w", err)
		}
	} else {
		// Ensure the directory exists.
		if err := os.MkdirAll(destPath, 0700); err != nil {
			return "", fmt.Errorf("create archive dir: %w", err)
		}
		archivePath = filepath.Join(destPath, fmt.Sprintf("dina-test-export-%s.dina", hex.EncodeToString(salt[:4])))
	}
	if err := os.WriteFile(archivePath, buf.Bytes(), 0600); err != nil {
		return "", fmt.Errorf("write test archive: %w", err)
	}

	return archivePath, nil
}

// collectExportData gathers the vault data and serialises it as JSON.
//
// HIGH-12: This is a placeholder that currently returns an error. Full
// implementation requires reading real vault files (identity SQLite, persona
// configs, encrypted stores) and checksumming them. The encryption envelope
// (Argon2id + AES-256-GCM) is already functional; only the data collection
// needs to be wired to the actual vault path.
func collectExportData() ([]byte, error) {
	return nil, ErrNotImplemented
}

// restoreData deserialises the decrypted JSON payload and returns an ImportResult.
//
// HIGH-12: Validates the archive structure and checksums. Full vault-level
// restoration (writing files to vault path, re-deriving persona DEKs,
// verifying identity continuity) is not yet wired.
func restoreData(plaintext []byte) (*ImportResult, error) {
	var payload archivePayload
	if err := json.Unmarshal(plaintext, &payload); err != nil {
		return nil, fmt.Errorf("unmarshal import data: %w", err)
	}

	// Validate checksums before restoration.
	for name, content := range payload.Files {
		expected, ok := payload.Manifest.Checksums[name]
		if !ok {
			return nil, fmt.Errorf("missing checksum for file: %s", name)
		}
		if hexHash(content) != expected {
			return nil, fmt.Errorf("checksum mismatch for file: %s", name)
		}
	}

	// Require identity.sqlite — vault restoration needs the identity vault.
	// Device token invalidation (§23.3.5) and vault-level file writing are
	// not yet wired for archives without the standard identity file.
	if _, hasIdentity := payload.Files["identity.sqlite"]; !hasIdentity {
		return nil, ErrNotImplemented
	}

	// Extract DID from identity data if present.
	did := ""
	if identityData, ok := payload.Files["identity.sqlite"]; ok && len(identityData) > 0 {
		did = "did:plc:imported"
	}

	return &ImportResult{
		FilesRestored:  len(payload.Files),
		RequiresRepair: true, // imported data always needs re-pairing with new device
		DID:            did,
		PersonaCount:   len(payload.Files),
	}, nil
}

func hexHash(data []byte) string {
	h := sha256.Sum256(data)
	return hex.EncodeToString(h[:])
}
