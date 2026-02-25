//go:build cgo

package sqlite

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	"github.com/anthropics/dina/core/internal/domain"
	"github.com/anthropics/dina/core/internal/port"
)

// Compile-time interface checks.
var _ port.VaultManager = (*VaultAdapter)(nil)
var _ port.VaultReader = (*VaultAdapter)(nil)
var _ port.VaultWriter = (*VaultAdapter)(nil)

// VaultAdapter wraps a SQLCipher Pool to implement the port.VaultManager,
// port.VaultReader, and port.VaultWriter interfaces using real database storage.
type VaultAdapter struct {
	pool *Pool
}

// NewVaultAdapter creates a new Pool rooted at dir and returns a VaultAdapter.
func NewVaultAdapter(dir string) *VaultAdapter {
	return &VaultAdapter{pool: NewPool(dir)}
}

// ---------------------------------------------------------------------------
// VaultManager
// ---------------------------------------------------------------------------

// Open delegates to Pool.Open, converting PersonaName to string.
func (a *VaultAdapter) Open(_ context.Context, persona domain.PersonaName, dek []byte) error {
	return a.pool.Open(persona.String(), dek)
}

// Close delegates to Pool.Close.
func (a *VaultAdapter) Close(persona domain.PersonaName) error {
	return a.pool.Close(persona.String())
}

// IsOpen delegates to Pool.IsOpen.
func (a *VaultAdapter) IsOpen(persona domain.PersonaName) bool {
	return a.pool.IsOpen(persona.String())
}

// OpenPersonas delegates to Pool.OpenPersonas, converting []string to []PersonaName.
func (a *VaultAdapter) OpenPersonas() []domain.PersonaName {
	raw := a.pool.OpenPersonas()
	names := make([]domain.PersonaName, len(raw))
	for i, s := range raw {
		names[i] = domain.PersonaName(s)
	}
	return names
}

// CloseAll delegates to Pool.CloseAll.
func (a *VaultAdapter) CloseAll() error {
	return a.pool.CloseAll()
}

// ---------------------------------------------------------------------------
// VaultWriter
// ---------------------------------------------------------------------------

// Store inserts or upserts a VaultItem into the persona's vault_items table.
// If item.ID is empty a random hex ID is generated. Returns the item ID.
func (a *VaultAdapter) Store(ctx context.Context, persona domain.PersonaName, item domain.VaultItem) (string, error) {
	db := a.pool.DB(persona.String())
	if db == nil {
		return "", fmt.Errorf("sqlite: persona %q not open", persona)
	}

	if item.ID == "" {
		id, err := randomID()
		if err != nil {
			return "", fmt.Errorf("sqlite: generate id: %w", err)
		}
		item.ID = id
	}

	now := time.Now().Unix()
	if item.Timestamp == 0 {
		item.Timestamp = now
	}
	if item.Metadata == "" {
		item.Metadata = "{}"
	}

	const q = `INSERT INTO vault_items (id, type, source, source_id, summary, body, metadata, timestamp, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
    type       = excluded.type,
    source     = excluded.source,
    source_id  = excluded.source_id,
    summary    = excluded.summary,
    body       = excluded.body,
    metadata   = excluded.metadata,
    timestamp  = excluded.timestamp,
    updated_at = excluded.updated_at`

	_, err := db.ExecContext(ctx, q,
		item.ID,
		item.Type,
		item.Source,
		item.SourceID,
		item.Summary,
		item.BodyText,
		item.Metadata,
		item.Timestamp,
		now, // created_at
		now, // updated_at
	)
	if err != nil {
		return "", fmt.Errorf("sqlite: store item: %w", err)
	}
	return item.ID, nil
}

// StoreBatch stores multiple items inside a single transaction.
func (a *VaultAdapter) StoreBatch(ctx context.Context, persona domain.PersonaName, items []domain.VaultItem) ([]string, error) {
	db := a.pool.DB(persona.String())
	if db == nil {
		return nil, fmt.Errorf("sqlite: persona %q not open", persona)
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("sqlite: begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	const q = `INSERT INTO vault_items (id, type, source, source_id, summary, body, metadata, timestamp, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
    type       = excluded.type,
    source     = excluded.source,
    source_id  = excluded.source_id,
    summary    = excluded.summary,
    body       = excluded.body,
    metadata   = excluded.metadata,
    timestamp  = excluded.timestamp,
    updated_at = excluded.updated_at`

	stmt, err := tx.PrepareContext(ctx, q)
	if err != nil {
		return nil, fmt.Errorf("sqlite: prepare: %w", err)
	}
	defer stmt.Close()

	now := time.Now().Unix()
	ids := make([]string, len(items))

	for i, item := range items {
		if item.ID == "" {
			id, err := randomID()
			if err != nil {
				return nil, fmt.Errorf("sqlite: generate id: %w", err)
			}
			item.ID = id
		}
		if item.Timestamp == 0 {
			item.Timestamp = now
		}
		if item.Metadata == "" {
			item.Metadata = "{}"
		}

		_, err := stmt.ExecContext(ctx,
			item.ID,
			item.Type,
			item.Source,
			item.SourceID,
			item.Summary,
			item.BodyText,
			item.Metadata,
			item.Timestamp,
			now,
			now,
		)
		if err != nil {
			return nil, fmt.Errorf("sqlite: store batch item %d: %w", i, err)
		}
		ids[i] = item.ID
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("sqlite: commit batch: %w", err)
	}
	return ids, nil
}

// Delete soft-deletes a vault item by setting deleted=1.
func (a *VaultAdapter) Delete(ctx context.Context, persona domain.PersonaName, id string) error {
	db := a.pool.DB(persona.String())
	if db == nil {
		return fmt.Errorf("sqlite: persona %q not open", persona)
	}

	_, err := db.ExecContext(ctx,
		`UPDATE vault_items SET deleted = 1, updated_at = ? WHERE id = ?`,
		time.Now().Unix(), id,
	)
	if err != nil {
		return fmt.Errorf("sqlite: delete item: %w", err)
	}
	return nil
}

// ---------------------------------------------------------------------------
// VaultReader
// ---------------------------------------------------------------------------

// GetItem retrieves a single non-deleted vault item by ID.
func (a *VaultAdapter) GetItem(ctx context.Context, persona domain.PersonaName, id string) (*domain.VaultItem, error) {
	db := a.pool.DB(persona.String())
	if db == nil {
		return nil, fmt.Errorf("sqlite: persona %q not open", persona)
	}

	row := db.QueryRowContext(ctx,
		`SELECT id, type, source, source_id, summary, body, metadata, timestamp, created_at
		 FROM vault_items WHERE id = ? AND deleted = 0`, id)

	var item domain.VaultItem
	err := row.Scan(
		&item.ID,
		&item.Type,
		&item.Source,
		&item.SourceID,
		&item.Summary,
		&item.BodyText,
		&item.Metadata,
		&item.Timestamp,
		&item.IngestedAt,
	)
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("sqlite: item %q not found", id)
	}
	if err != nil {
		return nil, fmt.Errorf("sqlite: get item: %w", err)
	}
	return &item, nil
}

// Query performs a search against vault_items.
//
// For FTS5 mode the query is run against vault_items_fts with MATCH and JOINed
// back to vault_items. Semantic and hybrid modes return empty results because
// sqlite-vec is not yet loaded.
func (a *VaultAdapter) Query(ctx context.Context, persona domain.PersonaName, q domain.SearchQuery) ([]domain.VaultItem, error) {
	db := a.pool.DB(persona.String())
	if db == nil {
		return nil, fmt.Errorf("sqlite: persona %q not open", persona)
	}

	// Semantic and hybrid modes require sqlite-vec which is not yet available.
	if q.Mode == domain.SearchSemantic || q.Mode == domain.SearchHybrid {
		return nil, nil
	}

	// Build the query.
	var (
		sqlBuf strings.Builder
		args   []interface{}
	)

	if q.Mode == domain.SearchFTS5 && q.Query != "" {
		// FTS5 search: join vault_items_fts with vault_items.
		// Sanitize the query to prevent FTS5 operator interpretation
		// (e.g. hyphens being treated as NOT operators).
		ftsQuery := sanitizeFTS5Query(q.Query)
		sqlBuf.WriteString(`SELECT v.id, v.type, v.source, v.source_id, v.summary, v.body, v.metadata, v.timestamp, v.created_at
FROM vault_items_fts f
JOIN vault_items v ON v.rowid = f.rowid
WHERE vault_items_fts MATCH ? AND v.deleted = 0`)
		args = append(args, ftsQuery)
	} else {
		// Plain listing / filtering without FTS.
		sqlBuf.WriteString(`SELECT id, type, source, source_id, summary, body, metadata, timestamp, created_at
FROM vault_items WHERE deleted = 0`)
	}

	// Type filter.
	if len(q.Types) > 0 {
		placeholders := make([]string, len(q.Types))
		for i, t := range q.Types {
			placeholders[i] = "?"
			args = append(args, t)
		}
		if q.Mode == domain.SearchFTS5 && q.Query != "" {
			sqlBuf.WriteString(` AND v.type IN (` + strings.Join(placeholders, ",") + `)`)
		} else {
			sqlBuf.WriteString(` AND type IN (` + strings.Join(placeholders, ",") + `)`)
		}
	}

	// Time range filters.
	col := "timestamp"
	if q.Mode == domain.SearchFTS5 && q.Query != "" {
		col = "v.timestamp"
	}
	if q.After > 0 {
		sqlBuf.WriteString(fmt.Sprintf(` AND %s >= ?`, col))
		args = append(args, q.After)
	}
	if q.Before > 0 {
		sqlBuf.WriteString(fmt.Sprintf(` AND %s <= ?`, col))
		args = append(args, q.Before)
	}

	// Order by timestamp descending.
	if q.Mode == domain.SearchFTS5 && q.Query != "" {
		sqlBuf.WriteString(` ORDER BY v.timestamp DESC`)
	} else {
		sqlBuf.WriteString(` ORDER BY timestamp DESC`)
	}

	// Limit and offset.
	if q.Limit > 0 {
		sqlBuf.WriteString(` LIMIT ?`)
		args = append(args, q.Limit)
	}
	if q.Offset > 0 {
		sqlBuf.WriteString(` OFFSET ?`)
		args = append(args, q.Offset)
	}

	rows, err := db.QueryContext(ctx, sqlBuf.String(), args...)
	if err != nil {
		return nil, fmt.Errorf("sqlite: query: %w", err)
	}
	defer rows.Close()

	var items []domain.VaultItem
	for rows.Next() {
		var item domain.VaultItem
		if err := rows.Scan(
			&item.ID,
			&item.Type,
			&item.Source,
			&item.SourceID,
			&item.Summary,
			&item.BodyText,
			&item.Metadata,
			&item.Timestamp,
			&item.IngestedAt,
		); err != nil {
			return nil, fmt.Errorf("sqlite: scan row: %w", err)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("sqlite: rows: %w", err)
	}
	return items, nil
}

// VectorSearch is a stub — requires the sqlite-vec extension which is not yet loaded.
func (a *VaultAdapter) VectorSearch(_ context.Context, _ domain.PersonaName, _ []float32, _ int) ([]domain.VaultItem, error) {
	return nil, nil
}

// ---------------------------------------------------------------------------
// ClearAll — test-mode support
// ---------------------------------------------------------------------------

// ClearAll hard-deletes all non-deleted vault items and returns the count removed.
// Intended for test teardown only; production code must not call this.
func (a *VaultAdapter) ClearAll(ctx context.Context, persona domain.PersonaName) (int, error) {
	db := a.pool.DB(persona.String())
	if db == nil {
		return 0, fmt.Errorf("sqlite: persona %q not open", persona)
	}

	res, err := db.ExecContext(ctx, `DELETE FROM vault_items WHERE deleted = 0`)
	if err != nil {
		return 0, fmt.Errorf("sqlite: clear all: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("sqlite: rows affected: %w", err)
	}
	return int(n), nil
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// sanitizeFTS5Query wraps each whitespace-separated term in double quotes
// to prevent FTS5 operator interpretation (e.g. hyphens as NOT, colons as
// column filters). Plain search terms like "pre-existing" become
// "\"pre-existing\"" which FTS5 treats as a literal phrase.
func sanitizeFTS5Query(q string) string {
	terms := strings.Fields(q)
	if len(terms) == 0 {
		return q
	}
	for i, t := range terms {
		// Already quoted — leave as-is.
		if strings.HasPrefix(t, `"`) && strings.HasSuffix(t, `"`) {
			continue
		}
		// Escape any embedded double quotes, then wrap.
		t = strings.ReplaceAll(t, `"`, `""`)
		terms[i] = `"` + t + `"`
	}
	return strings.Join(terms, " ")
}

// randomID generates a 32-character hex string from 16 random bytes.
func randomID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
