package main

import (
	"context"
	"fmt"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
)

// vaultBackend is a combined interface that both the in-memory Manager and
// the SQLCipher VaultAdapter satisfy.  Used by the build-tag factory so
// main.go can use either backend transparently.
type vaultBackend interface {
	// VaultManager
	Open(ctx context.Context, persona domain.PersonaName, dek []byte) error
	Close(persona domain.PersonaName) error
	IsOpen(persona domain.PersonaName) bool
	OpenPersonas() []domain.PersonaName
	Checkpoint(persona domain.PersonaName) error

	// VaultReader
	Query(ctx context.Context, persona domain.PersonaName, q domain.SearchQuery) ([]domain.VaultItem, error)
	GetItem(ctx context.Context, persona domain.PersonaName, id string) (*domain.VaultItem, error)
	VectorSearch(ctx context.Context, persona domain.PersonaName, vector []float32, topK int) ([]domain.VaultItem, error)

	// VaultWriter
	Store(ctx context.Context, persona domain.PersonaName, item domain.VaultItem) (string, error)
	StoreBatch(ctx context.Context, persona domain.PersonaName, items []domain.VaultItem) ([]string, error)
	Delete(ctx context.Context, persona domain.PersonaName, id string) error

	// Test mode
	ClearAll(ctx context.Context, persona domain.PersonaName) (int, error)
}

// contactDirectoryFull combines port.ContactDirectory and port.ContactLookup.
// Both the in-memory and SQLite contact directories satisfy this combined
// interface. Used by the build-tag factory so main.go can pass the same value
// to both handler.ContactHandler (needs ContactDirectory) and
// service.NewTrustService (needs ContactLookup).
type contactDirectoryFull interface {
	port.ContactDirectory
	port.ContactLookup
}

// sqliteBackupStub is a placeholder backup manager for CGO builds.
// Real SQLCipher backup (using sqlite3_backup API or file copy) will be
// implemented when the migration service is fully wired.
type sqliteBackupStub struct{}

func (s *sqliteBackupStub) Backup(_ context.Context, personaID, destPath string) error {
	return fmt.Errorf("sqlite backup not yet implemented for persona %q → %s", personaID, destPath)
}

func (s *sqliteBackupStub) Restore(_ context.Context, personaID, srcPath string) error {
	return fmt.Errorf("sqlite restore not yet implemented for persona %q ← %s", personaID, srcPath)
}
