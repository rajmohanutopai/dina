//go:build cgo

package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
)

// Compile-time interface check.
var _ port.ContactAliasStore = (*SQLiteContactAliasStore)(nil)

// SQLiteContactAliasStore implements port.ContactAliasStore using the
// contact_aliases table in identity.sqlite.
type SQLiteContactAliasStore struct {
	pool *Pool
}

// NewSQLiteContactAliasStore returns an alias store backed by identity.sqlite.
func NewSQLiteContactAliasStore(pool *Pool) *SQLiteContactAliasStore {
	return &SQLiteContactAliasStore{pool: pool}
}

func (s *SQLiteContactAliasStore) db() *sql.DB {
	return s.pool.DB("identity")
}

// AddAlias inserts an alias for a contact. Rejects if:
//   - alias fails validation (too short, pronoun, etc.)
//   - normalized alias matches any contact's display_name
//   - normalized alias already belongs to another contact
func (s *SQLiteContactAliasStore) AddAlias(ctx context.Context, did, alias string) error {
	db := s.db()
	if db == nil {
		return fmt.Errorf("alias store: identity database not open")
	}

	if msg := domain.ValidateAlias(alias); msg != "" {
		return fmt.Errorf("alias store: %s", msg)
	}

	normalized := domain.NormalizeAlias(alias)

	// Verify the contact DID exists.
	var contactExists int
	err := db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM contacts WHERE did = ?`, did,
	).Scan(&contactExists)
	if err != nil || contactExists == 0 {
		return fmt.Errorf("alias store: contact %q not found", did)
	}

	// Check collision with contact display_names (bidirectional uniqueness).
	var nameCount int
	err = db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM contacts WHERE LOWER(display_name) = ?`, normalized,
	).Scan(&nameCount)
	if err != nil {
		return fmt.Errorf("alias store: name collision check: %w", err)
	}
	if nameCount > 0 {
		return fmt.Errorf("alias store: '%s' conflicts with an existing contact name", alias)
	}

	// Check collision with other contacts' aliases (unique index will also catch this,
	// but we give a better error message).
	var existingDID string
	err = db.QueryRowContext(ctx,
		`SELECT contact_did FROM contact_aliases WHERE normalized_alias = ?`, normalized,
	).Scan(&existingDID)
	if err == nil && existingDID != did {
		return fmt.Errorf("alias store: '%s' already belongs to another contact", alias)
	}
	if err == nil && existingDID == did {
		return nil // Idempotent: alias already exists for this contact.
	}

	now := time.Now().Unix()
	_, err = db.ExecContext(ctx,
		`INSERT INTO contact_aliases (contact_did, alias, normalized_alias, source, created_at)
		 VALUES (?, ?, ?, 'manual', ?)`,
		did, alias, normalized, now,
	)
	if err != nil {
		return fmt.Errorf("alias store: add: %w", err)
	}
	return nil
}

// RemoveAlias deletes an alias for a contact.
func (s *SQLiteContactAliasStore) RemoveAlias(ctx context.Context, did, alias string) error {
	db := s.db()
	if db == nil {
		return fmt.Errorf("alias store: identity database not open")
	}

	normalized := domain.NormalizeAlias(alias)
	res, err := db.ExecContext(ctx,
		`DELETE FROM contact_aliases WHERE contact_did = ? AND normalized_alias = ?`,
		did, normalized,
	)
	if err != nil {
		return fmt.Errorf("alias store: remove: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("alias store: alias '%s' not found for this contact", alias)
	}
	return nil
}

// ListAliases returns all aliases for a single contact.
func (s *SQLiteContactAliasStore) ListAliases(ctx context.Context, did string) ([]string, error) {
	db := s.db()
	if db == nil {
		return nil, fmt.Errorf("alias store: identity database not open")
	}

	rows, err := db.QueryContext(ctx,
		`SELECT alias FROM contact_aliases WHERE contact_did = ? ORDER BY created_at`, did,
	)
	if err != nil {
		return nil, fmt.Errorf("alias store: list: %w", err)
	}
	defer rows.Close()

	var aliases []string
	for rows.Next() {
		var a string
		if err := rows.Scan(&a); err != nil {
			return nil, fmt.Errorf("alias store: scan: %w", err)
		}
		aliases = append(aliases, a)
	}
	return aliases, rows.Err()
}

// ResolveAlias looks up a normalized alias and returns the owning contact DID.
func (s *SQLiteContactAliasStore) ResolveAlias(ctx context.Context, alias string) (string, error) {
	db := s.db()
	if db == nil {
		return "", fmt.Errorf("alias store: identity database not open")
	}

	normalized := domain.NormalizeAlias(alias)
	var did string
	err := db.QueryRowContext(ctx,
		`SELECT contact_did FROM contact_aliases WHERE normalized_alias = ?`, normalized,
	).Scan(&did)
	if err == sql.ErrNoRows {
		return "", fmt.Errorf("alias store: alias '%s' not found", alias)
	}
	if err != nil {
		return "", fmt.Errorf("alias store: resolve: %w", err)
	}
	return did, nil
}

// ListAllAliases returns all aliases grouped by contact DID.
func (s *SQLiteContactAliasStore) ListAllAliases(ctx context.Context) (map[string][]string, error) {
	db := s.db()
	if db == nil {
		return nil, fmt.Errorf("alias store: identity database not open")
	}

	rows, err := db.QueryContext(ctx,
		`SELECT contact_did, alias FROM contact_aliases ORDER BY contact_did, created_at`,
	)
	if err != nil {
		return nil, fmt.Errorf("alias store: list all: %w", err)
	}
	defer rows.Close()

	result := make(map[string][]string)
	for rows.Next() {
		var did, alias string
		if err := rows.Scan(&did, &alias); err != nil {
			return nil, fmt.Errorf("alias store: scan: %w", err)
		}
		result[did] = append(result[did], alias)
	}
	return result, rows.Err()
}

// DeleteAllForContact removes all aliases for a contact.
// Called as part of transactional contact deletion.
func (s *SQLiteContactAliasStore) DeleteAllForContact(ctx context.Context, did string) error {
	db := s.db()
	if db == nil {
		return fmt.Errorf("alias store: identity database not open")
	}

	_, err := db.ExecContext(ctx,
		`DELETE FROM contact_aliases WHERE contact_did = ?`, did,
	)
	if err != nil {
		return fmt.Errorf("alias store: delete all: %w", err)
	}
	return nil
}

// DeleteContactWithAliases removes a contact and all its aliases in a single
// transaction. If either delete fails, both are rolled back.
func (s *SQLiteContactAliasStore) DeleteContactWithAliases(ctx context.Context, did string) error {
	db := s.db()
	if db == nil {
		return fmt.Errorf("alias store: identity database not open")
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("alias store: begin tx: %w", err)
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx, `DELETE FROM contact_aliases WHERE contact_did = ?`, did); err != nil {
		return fmt.Errorf("alias store: delete aliases in tx: %w", err)
	}
	res, err := tx.ExecContext(ctx, `DELETE FROM contacts WHERE did = ?`, did)
	if err != nil {
		return fmt.Errorf("alias store: delete contact in tx: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("alias store: contact %q not found", did)
	}

	return tx.Commit()
}
