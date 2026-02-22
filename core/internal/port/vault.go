package port

import (
	"context"

	"github.com/anthropics/dina/core/internal/domain"
)

// VaultReader provides read-only access to a persona's vault.
type VaultReader interface {
	Query(ctx context.Context, persona domain.PersonaName, q domain.SearchQuery) ([]domain.VaultItem, error)
	GetItem(ctx context.Context, persona domain.PersonaName, id string) (*domain.VaultItem, error)
	VectorSearch(ctx context.Context, persona domain.PersonaName, vector []float32, topK int) ([]domain.VaultItem, error)
}

// VaultWriter provides write access to a persona's vault.
type VaultWriter interface {
	Store(ctx context.Context, persona domain.PersonaName, item domain.VaultItem) (string, error)
	StoreBatch(ctx context.Context, persona domain.PersonaName, items []domain.VaultItem) ([]string, error)
	Delete(ctx context.Context, persona domain.PersonaName, id string) error
}

// VaultManager controls persona database lifecycle.
type VaultManager interface {
	Open(ctx context.Context, persona domain.PersonaName, dek []byte) error
	Close(persona domain.PersonaName) error
	IsOpen(persona domain.PersonaName) bool
	OpenPersonas() []domain.PersonaName
}

// ScratchpadManager handles cognitive checkpoint storage for the brain's multi-step reasoning.
type ScratchpadManager interface {
	Write(ctx context.Context, taskID string, step int, data []byte) error
	Read(ctx context.Context, taskID string) (step int, data []byte, err error)
	Delete(ctx context.Context, taskID string) error
}

// StagingManager handles temporary item approval workflows.
type StagingManager interface {
	Stage(ctx context.Context, persona domain.PersonaName, item domain.VaultItem, expiresAt int64) (string, error)
	Approve(ctx context.Context, persona domain.PersonaName, stagingID string) error
	Reject(ctx context.Context, persona domain.PersonaName, stagingID string) error
	Sweep(ctx context.Context) (int, error)
}

// SchemaInspector provides introspection of vault database schemas.
type SchemaInspector interface {
	TableColumns(dbName, tableName string) ([]string, error)
	IndexExists(dbName, indexName string) (bool, error)
	SchemaVersion(dbName string) (string, error)
}

// VaultAuditLogger manages the append-only audit log with hash chain integrity.
type VaultAuditLogger interface {
	Append(ctx context.Context, entry domain.VaultAuditEntry) (int64, error)
	Query(ctx context.Context, filter domain.VaultAuditFilter) ([]domain.VaultAuditEntry, error)
	VerifyChain() (bool, error)
	Purge(retentionDays int) (int64, error)
}
