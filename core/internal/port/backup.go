package port

import (
	"context"

	"github.com/anthropics/dina/core/internal/domain"
)

// BackupManager handles encrypted vault backups via sqlcipher_export (NOT VACUUM INTO).
type BackupManager interface {
	Backup(ctx context.Context, personaID, destPath string) error
	Restore(ctx context.Context, personaID, srcPath string) error
}

// MigrationSafety provides pre-flight and rollback for schema migrations.
type MigrationSafety interface {
	PreFlightBackup(ctx context.Context, dbName string) (backupPath string, err error)
	IntegrityCheck(ctx context.Context, dbName string) (string, error)
	CommitMigration(ctx context.Context, dbName string) error
	RollbackMigration(ctx context.Context, dbName, backupPath string) error
}

// ExportManager handles .dina archive exports for portability.
type ExportManager interface {
	Export(ctx context.Context, opts domain.ExportOptions) (archivePath string, err error)
	ListArchiveContents(archivePath string) ([]string, error)
	ReadManifest(archivePath, passphrase string) (*domain.ExportManifest, error)
}

// ImportManager handles .dina archive imports for portability.
type ImportManager interface {
	Import(ctx context.Context, opts domain.ImportOptions) (*domain.ImportResult, error)
	VerifyArchive(archivePath, passphrase string) error
	CheckCompatibility(archivePath string) error
}
