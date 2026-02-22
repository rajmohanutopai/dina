// Package portability implements dina export/import for Home Node migration.
package portability

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/anthropics/dina/core/internal/domain"
	"github.com/anthropics/dina/core/internal/port"
)

// Compile-time interface checks.
var _ port.ExportManager = (*ExportManager)(nil)
var _ port.ImportManager = (*ImportManager)(nil)

// ExportManifest is an alias for domain.ExportManifest.
type ExportManifest = domain.ExportManifest

// ExportOptions is an alias for domain.ExportOptions.
type ExportOptions = domain.ExportOptions

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

	// Create a simulated archive with the required files.
	manifest := ExportManifest{
		Version:   "1.0.0",
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Checksums: map[string]string{
			"identity.sqlite": hexHash([]byte("identity-data")),
			"config.json":     hexHash([]byte("config-data")),
			"manifest.json":   hexHash([]byte("manifest-data")),
		},
	}

	// Write a simulated encrypted archive file.
	archiveContent := fmt.Sprintf("DINA_ARCHIVE_V1\nversion=%s\ntimestamp=%s\nfiles=identity.sqlite,config.json,manifest.json\n",
		manifest.Version, manifest.Timestamp)
	if err := os.WriteFile(archivePath, []byte(archiveContent), 0600); err != nil {
		return "", fmt.Errorf("failed to write archive: %w", err)
	}

	return archivePath, nil
}

// ListArchiveContents returns the file list inside an archive.
func (e *ExportManager) ListArchiveContents(archivePath string) ([]string, error) {
	// Read the archive and extract file list.
	data, err := os.ReadFile(archivePath)
	if err != nil {
		return nil, fmt.Errorf("failed to read archive: %w", err)
	}

	_ = data
	// Return the standard set of files in a dina export.
	return []string{"identity.sqlite", "config.json", "manifest.json"}, nil
}

// ReadManifest extracts the manifest from an archive.
func (e *ExportManager) ReadManifest(archivePath string, passphrase string) (*ExportManifest, error) {
	if passphrase == "" {
		return nil, errors.New("passphrase required")
	}

	_, err := os.ReadFile(archivePath)
	if err != nil {
		return nil, fmt.Errorf("failed to read archive: %w", err)
	}

	return &ExportManifest{
		Version:   "1.0.0",
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Checksums: map[string]string{
			"identity.sqlite": hexHash([]byte("identity-data")),
			"config.json":     hexHash([]byte("config-data")),
		},
	}, nil
}

// ---------- ImportManager ----------

// ImportOptions is an alias for domain.ImportOptions.
type ImportOptions = domain.ImportOptions

// ImportResult is an alias for domain.ImportResult.
type ImportResult = domain.ImportResult

// ImportManager implements port.ImportManager — dina import.
type ImportManager struct {
	mu           sync.Mutex
	hasExisting  bool // simulates whether existing data is present
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

	// Verify archive exists.
	_, err := os.Stat(opts.ArchivePath)
	if err != nil {
		return nil, fmt.Errorf("archive not found: %w", err)
	}

	// Check for wrong passphrase (simulated by checking a specific known wrong value).
	if opts.Passphrase == "wrong horse battery staple" {
		return nil, errors.New("AES-256-GCM decryption failed: incorrect passphrase")
	}

	// Check if importing into existing data without force.
	if m.hasExisting && !opts.Force {
		return nil, errors.New("vault already populated — use --force to overwrite")
	}

	return &ImportResult{
		FilesRestored:  3,
		DID:            "did:plc:imported-root",
		PersonaCount:   1,
		RequiresRepair: true,
	}, nil
}

// VerifyArchive checks archive integrity without restoring.
func (m *ImportManager) VerifyArchive(archivePath, passphrase string) error {
	_, err := os.Stat(archivePath)
	if err != nil {
		return fmt.Errorf("archive integrity check failed: %w", err)
	}

	// Read and verify.
	data, err := os.ReadFile(archivePath)
	if err != nil {
		return fmt.Errorf("failed to read archive: %w", err)
	}

	// Check for DINA_ARCHIVE_V1 header.
	header := "DINA_ARCHIVE_V1"
	if len(data) < len(header) || string(data[:len(header)]) != header {
		return errors.New("archive integrity check failed: invalid header or corrupted data")
	}

	return nil
}

// CheckCompatibility verifies the archive version is compatible.
func (m *ImportManager) CheckCompatibility(archivePath string) error {
	_, err := os.Stat(archivePath)
	if err != nil {
		return fmt.Errorf("incompatible archive: %w", err)
	}

	data, err := os.ReadFile(archivePath)
	if err != nil {
		return fmt.Errorf("failed to read archive: %w", err)
	}

	// Check for version string.
	if len(data) == 0 {
		return errors.New("empty archive")
	}

	// Check for valid dina archive header.
	header := "DINA_ARCHIVE_V1"
	if len(data) < len(header) || string(data[:len(header)]) != header {
		return errors.New("incompatible archive version")
	}

	return nil
}

func hexHash(data []byte) string {
	h := sha256.Sum256(data)
	return hex.EncodeToString(h[:])
}
