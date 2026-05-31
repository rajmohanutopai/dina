package service

import (
	"context"
	"fmt"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
)

// MigrationService coordinates data export, import, and archive verification.
// It orchestrates the backup manager for pre-flight safety and the export/import
// managers for .dina archive portability.
type MigrationService struct {
	export     port.ExportManager
	import_    port.ImportManager
	backup     port.BackupManager
	vault      port.VaultManager
	personaMgr port.PersonaManager // optional — tier-aware export checks
	clock      port.Clock
}

// NewMigrationService constructs a MigrationService with all required dependencies.
func NewMigrationService(
	export port.ExportManager,
	import_ port.ImportManager,
	backup port.BackupManager,
	vault port.VaultManager,
	personaMgr port.PersonaManager,
	clock port.Clock,
) *MigrationService {
	return &MigrationService{
		export:     export,
		import_:    import_,
		backup:     backup,
		vault:      vault,
		personaMgr: personaMgr,
		clock:      clock,
	}
}

// Export creates a portable .dina archive containing the user's data. Before
// exporting, it verifies that all referenced personas are closed to ensure
// data consistency. Returns the path to the created archive file.
func (s *MigrationService) Export(ctx context.Context, opts domain.ExportOptions) (string, error) {
	if opts.Passphrase == "" {
		return "", fmt.Errorf("migration: %w: passphrase is required for export", domain.ErrInvalidInput)
	}
	if opts.DestPath == "" {
		return "", fmt.Errorf("migration: %w: destination path is required", domain.ErrInvalidInput)
	}

	// Verify no lockable personas are open to ensure data consistency.
	// Skip: "identity" (infrastructure DB, always open, read-only during export)
	// and default/standard tier personas (always open by design, cannot be locked).
	openPersonas := s.vault.OpenPersonas()
	lockableOpen := 0
	for _, p := range openPersonas {
		name := p.String()
		if name == "identity" {
			continue
		}
		// Default and standard tier personas are always open — safe to export.
		if s.personaMgr != nil {
			tier, err := s.personaMgr.GetTier(ctx, name)
			if err == nil && (tier == "default" || tier == "standard") {
				continue
			}
		}
		lockableOpen++
	}
	if lockableOpen > 0 {
		return "", fmt.Errorf("migration: %w: close all personas before export (%d open)", domain.ErrPersonaLocked, lockableOpen)
	}

	// Checkpoint ALL open persona WALs before reading raw .sqlite bytes.
	// SQLite WAL mode keeps recent writes in the -wal file. Without
	// checkpointing, os.ReadFile(*.sqlite) misses that data.
	// Identity is always open; default/standard personas are always open too.
	for _, p := range s.vault.OpenPersonas() {
		if err := s.vault.Checkpoint(p); err != nil {
			return "", fmt.Errorf("migration: checkpoint %s: %w", p, err)
		}
	}

	archivePath, err := s.export.Export(ctx, opts)
	if err != nil {
		return "", fmt.Errorf("migration: export: %w", err)
	}

	return archivePath, nil
}

// Import restores data from a .dina archive. It verifies the archive integrity
// and compatibility before proceeding with the actual import. Returns a summary
// of what was restored.
func (s *MigrationService) Import(ctx context.Context, opts domain.ImportOptions) (*domain.ImportResult, error) {
	if opts.ArchivePath == "" {
		return nil, fmt.Errorf("migration: %w: archive path is required", domain.ErrInvalidInput)
	}
	if opts.Passphrase == "" {
		return nil, fmt.Errorf("migration: %w: passphrase is required for import", domain.ErrInvalidInput)
	}

	// Verify no user personas are open to prevent conflicts during restore.
	// Identity DB (always open) is excluded — it's infrastructure, not a user persona.
	openPersonas := s.vault.OpenPersonas()
	userOpen := 0
	for _, p := range openPersonas {
		if p.String() != "identity" {
			userOpen++
		}
	}
	if userOpen > 0 {
		return nil, fmt.Errorf("migration: %w: close all personas before import (%d open)", domain.ErrPersonaLocked, userOpen)
	}

	// Check archive compatibility before attempting import.
	if err := s.import_.CheckCompatibility(opts.ArchivePath); err != nil {
		return nil, fmt.Errorf("migration: compatibility check: %w", err)
	}

	// Verify archive integrity.
	if err := s.import_.VerifyArchive(opts.ArchivePath, opts.Passphrase); err != nil {
		return nil, fmt.Errorf("migration: verify archive: %w", err)
	}

	// Validate all pre-write checks (force guard, checksums, path safety,
	// identity.sqlite presence) BEFORE closing identity. This ensures that
	// validation failures don't leave the process with identity closed.
	// After this succeeds, the only remaining failure modes are actual disk
	// write errors — catastrophic regardless of identity state.
	if err := s.import_.ValidateImport(ctx, opts); err != nil {
		return nil, fmt.Errorf("migration: pre-write validation: %w", err)
	}

	// Close identity DB before overwriting its .sqlite file.
	// identity.sqlite runs in WAL mode and is always open — importing
	// overwrites the file on disk while the connection holds WAL/SHM
	// files. Closing first ensures a clean handoff. The imported
	// identity.sqlite will be opened on next restart; the result's
	// RequiresRestart flag signals this to the caller.
	if err := s.vault.Close("identity"); err != nil {
		return nil, fmt.Errorf("migration: close identity before import: %w", err)
	}

	result, err := s.import_.Import(ctx, opts)
	if err != nil {
		return nil, fmt.Errorf("migration: import: %w", err)
	}

	return result, nil
}

// VerifyArchive validates a .dina archive's integrity and checksums without
// actually importing any data. This is useful for pre-flight checks.
func (s *MigrationService) VerifyArchive(archivePath, passphrase string) error {
	if archivePath == "" {
		return fmt.Errorf("migration: %w: archive path is required", domain.ErrInvalidInput)
	}
	if passphrase == "" {
		return fmt.Errorf("migration: %w: passphrase is required for verification", domain.ErrInvalidInput)
	}

	if err := s.import_.VerifyArchive(archivePath, passphrase); err != nil {
		return fmt.Errorf("migration: verify archive: %w", err)
	}

	return nil
}
