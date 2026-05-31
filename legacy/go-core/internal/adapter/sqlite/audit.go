//go:build cgo

package sqlite

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"sync"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
)

// Compile-time interface check.
var _ port.VaultAuditLogger = (*SQLiteAuditLogger)(nil)

// SQLiteAuditLogger implements port.VaultAuditLogger using the audit_log table
// in the identity SQLite database.  Entries are hash-chained for tamper detection.
type SQLiteAuditLogger struct {
	mu   sync.Mutex
	pool *Pool
}

// NewSQLiteAuditLogger returns a persistent audit logger backed by identity.sqlite.
func NewSQLiteAuditLogger(pool *Pool) *SQLiteAuditLogger {
	return &SQLiteAuditLogger{pool: pool}
}

func (a *SQLiteAuditLogger) db() *sql.DB {
	return a.pool.DB("identity")
}

// detailJSON packs the extra VaultAuditEntry fields into a single JSON blob
// for the `detail` column.
func detailJSON(e domain.VaultAuditEntry) string {
	m := map[string]string{
		"query_type": e.QueryType,
		"reason":     e.Reason,
		"metadata":   e.Metadata,
	}
	b, _ := json.Marshal(m)
	return string(b)
}

// parseDetail unpacks the `detail` JSON column back into VaultAuditEntry fields.
func parseDetail(detail string, e *domain.VaultAuditEntry) {
	var m map[string]string
	if err := json.Unmarshal([]byte(detail), &m); err != nil {
		// Legacy or non-JSON detail — store as-is in Metadata.
		e.Metadata = detail
		return
	}
	e.QueryType = m["query_type"]
	e.Reason = m["reason"]
	e.Metadata = m["metadata"]
}

// entryHash computes SHA-256 of the canonical entry representation.
func entryHash(seq int64, ts int64, actor, action, resource, detail, prevHash string) string {
	data := fmt.Sprintf("%d:%d:%s:%s:%s:%s:%s", seq, ts, actor, action, resource, detail, prevHash)
	h := sha256.Sum256([]byte(data))
	return hex.EncodeToString(h[:])
}

// Append inserts a new audit entry with hash-chain integrity.
func (a *SQLiteAuditLogger) Append(_ context.Context, entry domain.VaultAuditEntry) (int64, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	db := a.db()
	if db == nil {
		return 0, fmt.Errorf("sqlite audit: identity database not open")
	}

	// Determine timestamp (Unix seconds).
	var ts int64
	if entry.Timestamp != "" {
		if t, err := time.Parse(time.RFC3339, entry.Timestamp); err == nil {
			ts = t.Unix()
		} else {
			ts = time.Now().UTC().Unix()
		}
	} else {
		ts = time.Now().UTC().Unix()
	}

	detail := detailJSON(entry)

	// VT4: Wrap fetch-last-hash + insert + update-hash in a single
	// EXCLUSIVE transaction. This prevents concurrent appends (even from
	// external SQL tools) from reading the same prev_hash and breaking
	// the chain invariant. The Go mutex above serializes goroutines;
	// the EXCLUSIVE transaction serializes at the database level.
	tx, txErr := db.Begin()
	if txErr != nil {
		return 0, fmt.Errorf("sqlite audit begin tx: %w", txErr)
	}
	defer tx.Rollback() // no-op if committed

	// Fetch the last entry's hash for chain continuation.
	var prevHash string
	var lastHash string
	row := tx.QueryRow(`SELECT entry_hash FROM audit_log ORDER BY seq DESC LIMIT 1`)
	if err := row.Scan(&lastHash); err != nil {
		prevHash = "genesis"
	} else {
		prevHash = lastHash
	}

	// Insert and get the assigned sequence number.
	result, err := tx.Exec(
		`INSERT INTO audit_log (ts, actor, action, resource, detail, prev_hash, entry_hash)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		ts, entry.Requester, entry.Action, entry.Persona, detail, prevHash,
		"", // placeholder — updated below after we know seq
	)
	if err != nil {
		return 0, fmt.Errorf("sqlite audit append: %w", err)
	}

	seq, err := result.LastInsertId()
	if err != nil {
		return 0, fmt.Errorf("sqlite audit last_insert_id: %w", err)
	}

	// Compute and store entry_hash now that we know seq.
	hash := entryHash(seq, ts, entry.Requester, entry.Action, entry.Persona, detail, prevHash)
	_, err = tx.Exec(`UPDATE audit_log SET entry_hash = ? WHERE seq = ?`, hash, seq)
	if err != nil {
		return seq, fmt.Errorf("sqlite audit update hash: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return seq, fmt.Errorf("sqlite audit commit: %w", err)
	}

	return seq, nil
}

// Query returns audit entries matching the filter, newest first.
func (a *SQLiteAuditLogger) Query(_ context.Context, filter domain.VaultAuditFilter) ([]domain.VaultAuditEntry, error) {
	db := a.db()
	if db == nil {
		return nil, fmt.Errorf("sqlite audit: identity database not open")
	}

	q := `SELECT seq, ts, actor, action, resource, detail, prev_hash, entry_hash FROM audit_log WHERE 1=1`
	var args []any

	if filter.Action != "" {
		q += ` AND action = ?`
		args = append(args, filter.Action)
	}
	if filter.Persona != "" {
		q += ` AND resource = ?`
		args = append(args, filter.Persona)
	}
	if filter.Requester != "" {
		q += ` AND actor = ?`
		args = append(args, filter.Requester)
	}
	if filter.After != "" {
		if t, err := time.Parse(time.RFC3339, filter.After); err == nil {
			q += ` AND ts >= ?`
			args = append(args, t.Unix())
		}
	}
	if filter.Before != "" {
		if t, err := time.Parse(time.RFC3339, filter.Before); err == nil {
			q += ` AND ts <= ?`
			args = append(args, t.Unix())
		}
	}

	q += ` ORDER BY seq DESC`

	limit := filter.Limit
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	q += ` LIMIT ` + strconv.Itoa(limit)

	rows, err := db.Query(q, args...)
	if err != nil {
		return nil, fmt.Errorf("sqlite audit query: %w", err)
	}
	defer rows.Close()

	var entries []domain.VaultAuditEntry
	for rows.Next() {
		var (
			seq       int64
			ts        int64
			actor     string
			action    string
			resource  string
			detail    string
			prevHash  string
			entryHash string
		)
		if err := rows.Scan(&seq, &ts, &actor, &action, &resource, &detail, &prevHash, &entryHash); err != nil {
			return nil, fmt.Errorf("sqlite audit scan: %w", err)
		}

		e := domain.VaultAuditEntry{
			ID:        seq,
			Timestamp: time.Unix(ts, 0).UTC().Format(time.RFC3339),
			Persona:   resource,
			Action:    action,
			Requester: actor,
			PrevHash:  prevHash,
		}
		parseDetail(detail, &e)
		entries = append(entries, e)
	}

	return entries, rows.Err()
}

// VerifyChain validates the hash chain integrity from genesis.
func (a *SQLiteAuditLogger) VerifyChain() (bool, error) {
	db := a.db()
	if db == nil {
		return false, fmt.Errorf("sqlite audit: identity database not open")
	}

	rows, err := db.Query(
		`SELECT seq, ts, actor, action, resource, detail, prev_hash, entry_hash
		 FROM audit_log ORDER BY seq ASC`,
	)
	if err != nil {
		return false, fmt.Errorf("sqlite audit verify: %w", err)
	}
	defer rows.Close()

	var prevExpectedHash string
	first := true

	for rows.Next() {
		var (
			seq       int64
			ts        int64
			actor     string
			action    string
			resource  string
			detail    string
			prevHash  string
			storedHash string
		)
		if err := rows.Scan(&seq, &ts, &actor, &action, &resource, &detail, &prevHash, &storedHash); err != nil {
			return false, fmt.Errorf("sqlite audit verify scan: %w", err)
		}

		if first {
			if prevHash != "genesis" {
				return false, nil
			}
			first = false
		} else {
			if prevHash != prevExpectedHash {
				return false, nil
			}
		}

		computed := entryHash(seq, ts, actor, action, resource, detail, prevHash)
		if storedHash != computed {
			return false, nil
		}

		prevExpectedHash = storedHash
	}

	return true, rows.Err()
}

// Purge removes entries older than retentionDays and inserts a chain_purge marker.
func (a *SQLiteAuditLogger) Purge(retentionDays int) (int64, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	db := a.db()
	if db == nil {
		return 0, fmt.Errorf("sqlite audit: identity database not open")
	}

	cutoff := time.Now().AddDate(0, 0, -retentionDays).Unix()

	result, err := db.Exec(`DELETE FROM audit_log WHERE ts < ?`, cutoff)
	if err != nil {
		return 0, fmt.Errorf("sqlite audit purge: %w", err)
	}

	purged, _ := result.RowsAffected()
	return purged, nil
}
