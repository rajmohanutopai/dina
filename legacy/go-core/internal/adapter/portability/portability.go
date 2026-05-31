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
	"strings"
	"sync"
	"time"

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
	mu          sync.Mutex
	vaultPath   string // root path containing identity.sqlite and <persona>.sqlite files
	dinaVersion string // software version stamped into manifest
}

// NewExportManager returns a new ExportManager.
// vaultPath is the root directory containing identity.sqlite and <persona>.sqlite files
// (flat layout — same directory, per sqlite.Pool convention).
func NewExportManager(vaultPath string) *ExportManager {
	return &ExportManager{vaultPath: vaultPath}
}

// SetVersion sets the Dina software version stamped into every export manifest.
func (e *ExportManager) SetVersion(v string) {
	e.dinaVersion = v
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
	data, err := collectExportData(e.vaultPath, e.dinaVersion)
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
	mu        sync.Mutex
	vaultPath string // root path to restore vault files into
}

// NewImportManager returns a new ImportManager.
// vaultPath is the root directory where vault files will be restored.
// The hasExisting parameter is ignored — the ImportManager checks the actual
// filesystem for existing data. Kept for API compatibility.
func NewImportManager(vaultPath string, _ bool) *ImportManager {
	return &ImportManager{vaultPath: vaultPath}
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
	// Detect existing data by checking for identity.sqlite on disk.
	if m.vaultPath != "" && !opts.Force {
		identityPath := filepath.Join(m.vaultPath, "identity.sqlite")
		if _, err := os.Stat(identityPath); err == nil {
			return nil, errors.New("vault already populated — use --force to overwrite")
		}
	}

	// Restore data from decrypted payload.
	result, err := restoreData(plaintext, m.vaultPath)
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

// ValidateImport runs all pre-write validation: reads and decrypts the
// archive, checks the force/existing-data guard, validates checksums,
// validates path safety, and verifies identity.sqlite is present. It
// does NOT write any files.
//
// MigrationService calls this before closing identity so that any
// validation failure leaves identity still open (non-degraded).
func (m *ImportManager) ValidateImport(_ context.Context, opts ImportOptions) error {
	if opts.Passphrase == "" {
		return errors.New("passphrase is required")
	}

	archive, err := os.ReadFile(opts.ArchivePath)
	if err != nil {
		return fmt.Errorf("archive not found: %w", err)
	}

	plaintext, err := decryptArchive(archive, opts.Passphrase)
	if err != nil {
		return fmt.Errorf("portability: validation failed: %w", err)
	}

	// Force/existing-data guard.
	if m.vaultPath != "" && !opts.Force {
		identityPath := filepath.Join(m.vaultPath, "identity.sqlite")
		if _, err := os.Stat(identityPath); err == nil {
			return errors.New("vault already populated — use --force to overwrite")
		}
	}

	// Validate payload structure, checksums, path safety, identity.sqlite.
	return validatePayload(plaintext, m.vaultPath)
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

// collectExportData reads vault files from disk and serialises them as a
// JSON archive payload with SHA-256 checksums per file.
//
// Live layout (matches sqlite.Pool — flat, same directory):
//
//	vaultPath/identity.sqlite          (Tier 0: contacts, audit, kv_store, devices)
//	vaultPath/personal.sqlite          (persona vault)
//	vaultPath/health.sqlite            (persona vault)
//	vaultPath/config.json              (gatekeeper tiers, settings — optional)
func collectExportData(vaultPath string, dinaVersion string) ([]byte, error) {
	if vaultPath == "" {
		return nil, errors.New("vault path is required for export")
	}

	files := make(map[string][]byte)

	// 1. identity.sqlite — required.
	identityPath := filepath.Join(vaultPath, "identity.sqlite")
	identityData, err := os.ReadFile(identityPath)
	if err != nil {
		return nil, fmt.Errorf("read identity.sqlite: %w", err)
	}
	files["identity.sqlite"] = identityData

	// 2. Per-persona vault files — flat layout in vaultPath root.
	//    sqlite.Pool opens persona DBs as ${vaultPath}/${persona}.sqlite,
	//    so we scan for all *.sqlite files excluding identity.sqlite.
	entries, err := os.ReadDir(vaultPath)
	if err != nil {
		return nil, fmt.Errorf("read vault directory: %w", err)
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if filepath.Ext(name) != ".sqlite" {
			continue
		}
		if name == "identity.sqlite" {
			continue // already collected above
		}
		data, err := os.ReadFile(filepath.Join(vaultPath, name))
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", name, err)
		}
		files[name] = data
	}

	// 3. config.json — optional.
	configPath := filepath.Join(vaultPath, "config.json")
	if configData, err := os.ReadFile(configPath); err == nil {
		files["config.json"] = configData
	}

	// Build checksums.
	checksums := make(map[string]string, len(files))
	for name, content := range files {
		checksums[name] = hexHash(content)
	}

	payload := archivePayload{
		Manifest: ExportManifest{
			Version:     "2",
			DinaVersion: dinaVersion,
			Timestamp:   time.Now().UTC().Format(time.RFC3339),
			Checksums:   checksums,
		},
		Files: files,
	}

	return json.Marshal(payload)
}

// validatePayload runs all non-destructive validation on the decrypted
// archive payload: unmarshal, checksum verification, path safety, and
// identity.sqlite presence check. Called by ValidateImport (before
// closing identity) and again by restoreData (defense-in-depth).
func validatePayload(plaintext []byte, vaultPath string) error {
	if vaultPath == "" {
		return errors.New("vault path is required for import")
	}

	var payload archivePayload
	if err := json.Unmarshal(plaintext, &payload); err != nil {
		return fmt.Errorf("unmarshal import data: %w", err)
	}

	// Validate checksums.
	for name, content := range payload.Files {
		expected, ok := payload.Manifest.Checksums[name]
		if !ok {
			return fmt.Errorf("missing checksum for file: %s", name)
		}
		if hexHash(content) != expected {
			return fmt.Errorf("checksum mismatch for file: %s", name)
		}
	}

	// Validate all entry names for path traversal.
	absVault, err := filepath.Abs(vaultPath)
	if err != nil {
		return fmt.Errorf("resolve vault path: %w", err)
	}
	for name := range payload.Files {
		if err := validateArchiveEntry(name, absVault); err != nil {
			return err
		}
	}

	// Require identity.sqlite.
	if _, hasIdentity := payload.Files["identity.sqlite"]; !hasIdentity {
		return errors.New("archive missing identity.sqlite — cannot restore")
	}

	return nil
}

// restoreData deserialises the decrypted JSON payload, validates checksums
// and path safety, then writes vault files to the destination vault path.
//
// All archive entry names are validated against path traversal before any
// file is written. Only flat filenames (no directory separators) are allowed —
// matching the live sqlite.Pool layout where persona DBs sit directly in
// vaultPath as ${persona}.sqlite.
func restoreData(plaintext []byte, vaultPath string) (*ImportResult, error) {
	// Re-validate as defense-in-depth (ValidateImport already ran these).
	if err := validatePayload(plaintext, vaultPath); err != nil {
		return nil, err
	}

	var payload archivePayload
	// Unmarshal is safe to repeat — already validated above.
	json.Unmarshal(plaintext, &payload) //nolint:errcheck

	absVault, _ := filepath.Abs(vaultPath) //nolint:errcheck

	// Ensure vault path exists.
	if err := os.MkdirAll(vaultPath, 0700); err != nil {
		return nil, fmt.Errorf("create vault path: %w", err)
	}

	// Write files to disk (flat layout — all files in vaultPath root).
	personaCount := 0
	for name, content := range payload.Files {
		destFile := filepath.Join(absVault, filepath.Clean(name))

		// For SQLite files, remove stale WAL/SHM journal files before replacing.
		// The running process may have these open in WAL mode; after we overwrite
		// the main .sqlite file the old journals become incompatible and would
		// corrupt the database on next open.
		if filepath.Ext(name) == ".sqlite" {
			os.Remove(destFile + "-wal")
			os.Remove(destFile + "-shm")
		}

		if err := os.WriteFile(destFile, content, 0600); err != nil {
			return nil, fmt.Errorf("write %s: %w", name, err)
		}

		// Count persona SQLite files (anything except identity.sqlite and config.json).
		if filepath.Ext(name) == ".sqlite" && name != "identity.sqlite" {
			personaCount++
		}
	}

	return &ImportResult{
		FilesRestored:   len(payload.Files),
		PersonaCount:    personaCount,
		RequiresRepair:  true, // devices must always be re-paired after import
		RequiresRestart: true, // identity DB was closed; process must restart
	}, nil
}

// validateArchiveEntry rejects archive entry names that could escape the
// vault root via path traversal. Only flat filenames are allowed — no
// directory separators, no ".." components, no absolute paths.
func validateArchiveEntry(name, absVaultRoot string) error {
	if name == "" {
		return fmt.Errorf("archive contains empty filename")
	}

	// Reject absolute paths.
	if filepath.IsAbs(name) {
		return fmt.Errorf("archive entry %q: absolute paths not allowed", name)
	}

	// Reject any ".." component.
	cleaned := filepath.Clean(name)
	if strings.Contains(cleaned, "..") {
		return fmt.Errorf("archive entry %q: path traversal not allowed", name)
	}

	// Reject entries with directory separators — flat layout only.
	if strings.ContainsAny(cleaned, "/\\") {
		return fmt.Errorf("archive entry %q: subdirectories not allowed (flat vault layout)", name)
	}

	// Final containment check: resolved path must be inside vault root.
	resolved := filepath.Join(absVaultRoot, cleaned)
	rel, err := filepath.Rel(absVaultRoot, resolved)
	if err != nil || strings.HasPrefix(rel, "..") {
		return fmt.Errorf("archive entry %q: escapes vault root", name)
	}

	return nil
}

func hexHash(data []byte) string {
	h := sha256.Sum256(data)
	return hex.EncodeToString(h[:])
}
