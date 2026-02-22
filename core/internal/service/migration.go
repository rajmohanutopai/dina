package service

import (
	"context"
	"fmt"

	"github.com/anthropics/dina/core/internal/domain"
	"github.com/anthropics/dina/core/internal/port"
)

// MigrationService coordinates data export, import, and archive verification.
// It orchestrates the backup manager for pre-flight safety and the export/import
// managers for .dina archive portability.
type MigrationService struct {
	export  port.ExportManager
	import_ port.ImportManager
	backup  port.BackupManager
	vault   port.VaultManager
	clock   port.Clock
}

// NewMigrationService constructs a MigrationService with all required dependencies.
func NewMigrationService(
	export port.ExportManager,
	import_ port.ImportManager,
	backup port.BackupManager,
	vault port.VaultManager,
	clock port.Clock,
) *MigrationService {
	return &MigrationService{
		export:  export,
		import_: import_,
		backup:  backup,
		vault:   vault,
		clock:   clock,
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

	// Verify no personas are open to ensure data consistency.
	openPersonas := s.vault.OpenPersonas()
	if len(openPersonas) > 0 {
		return "", fmt.Errorf("migration: %w: close all personas before export (%d open)", domain.ErrPersonaLocked, len(openPersonas))
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

	// Verify no personas are open to prevent conflicts during restore.
	openPersonas := s.vault.OpenPersonas()
	if len(openPersonas) > 0 {
		return nil, fmt.Errorf("migration: %w: close all personas before import (%d open)", domain.ErrPersonaLocked, len(openPersonas))
	}

	// Check archive compatibility before attempting import.
	if err := s.import_.CheckCompatibility(opts.ArchivePath); err != nil {
		return nil, fmt.Errorf("migration: compatibility check: %w", err)
	}

	// Verify archive integrity.
	if err := s.import_.VerifyArchive(opts.ArchivePath, opts.Passphrase); err != nil {
		return nil, fmt.Errorf("migration: verify archive: %w", err)
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
