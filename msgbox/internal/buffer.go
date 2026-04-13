package internal

import (
	"database/sql"
	"errors"
	"fmt"
	"sync/atomic"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

// memCounter generates unique names for in-memory databases so each
// NewBuffer(":memory:") gets its own isolated shared-cache database.
var memCounter atomic.Int64

// Buffer limits.
const (
	MaxMessagesPerDID = 100
	MaxBytesPerDID    = 10 * 1024 * 1024 // 10 MiB
	MessageTTL        = 24 * time.Hour
)

var (
	ErrBufferFull  = errors.New("msgbox: buffer full for recipient")
	ErrMsgTooLarge = errors.New("msgbox: message exceeds max size")
)

// BufferedMsg is a pending message in the durable buffer.
type BufferedMsg struct {
	ID        string
	Payload   []byte
	StoredAt  time.Time
	Sender    string // from_did of the sender (empty for legacy D2D)
	ExpiresAt *int64 // unix timestamp; nil = no expiry (legacy D2D default)
}

// Buffer is a durable per-DID message queue backed by SQLite.
// When /forward returns 202, the message is durably stored.
// A msgbox restart does not lose queued messages.
type Buffer struct {
	db *sql.DB
}

// NewBuffer opens (or creates) the SQLite buffer at the given path.
// Use ":memory:" for testing only.
func NewBuffer(dbPath string) (*Buffer, error) {
	var dsn string
	if dbPath == ":memory:" {
		// SQLite :memory: is per-connection — each sql.DB connection gets its
		// own empty database. Fix: use file: URI with shared cache and a unique
		// name per NewBuffer call. This gives each buffer its own isolated
		// in-memory database that is shared across all connections in the pool.
		id := memCounter.Add(1)
		dsn = fmt.Sprintf("file:memdb_%d?mode=memory&cache=shared&_busy_timeout=5000", id)
	} else {
		dsn = dbPath + "?_journal_mode=WAL&_busy_timeout=5000&_synchronous=NORMAL"
	}
	db, err := sql.Open("sqlite3", dsn)
	if err != nil {
		return nil, err
	}
	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS messages (
			id         TEXT PRIMARY KEY,
			recipient  TEXT NOT NULL,
			payload    BLOB NOT NULL,
			size       INTEGER NOT NULL,
			stored_at  INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient);
		CREATE INDEX IF NOT EXISTS idx_messages_stored_at ON messages(stored_at);
	`); err != nil {
		db.Close()
		return nil, err
	}
	// MBX-009: Add sender and expires_at columns (idempotent migration).
	// Existing rows get sender="" and expires_at=NULL via defaults.
	db.Exec("ALTER TABLE messages ADD COLUMN sender TEXT NOT NULL DEFAULT ''")
	db.Exec("ALTER TABLE messages ADD COLUMN expires_at INTEGER")
	return &Buffer{db: db}, nil
}

// Add durably stores a message for a DID. Returns ErrBufferFull if per-DID
// limits are exceeded. Idempotent by msg_id.
// sender and expiresAt are optional: pass "" and nil for legacy D2D messages.
func (b *Buffer) Add(did, msgID string, payload []byte, opts ...AddOption) error {
	var o addOptions
	for _, opt := range opts {
		opt(&o)
	}

	// Idempotency check (fast path — avoids the heavier INSERT below).
	var exists int
	b.db.QueryRow("SELECT 1 FROM messages WHERE id = ?", msgID).Scan(&exists)
	if exists == 1 {
		return nil
	}

	// Atomic insert with per-DID limit enforcement in a single statement.
	// The subquery WHERE clause checks count and size limits at INSERT time,
	// eliminating the TOCTOU race between separate SELECT COUNT(*) and INSERT.
	// SQLite evaluates the entire statement atomically — no concurrent writer
	// can insert between the subquery check and the INSERT.
	result, err := b.db.Exec(
		`INSERT OR IGNORE INTO messages (id, recipient, payload, size, stored_at, sender, expires_at)
		 SELECT ?, ?, ?, ?, ?, ?, ?
		 WHERE (SELECT COUNT(*) FROM messages WHERE recipient = ?) < ?
		   AND (SELECT COALESCE(SUM(size), 0) FROM messages WHERE recipient = ?) + ? <= ?`,
		msgID, did, payload, len(payload), time.Now().Unix(), o.sender, o.expiresAt,
		did, MaxMessagesPerDID,
		did, int64(len(payload)), int64(MaxBytesPerDID),
	)
	if err != nil {
		return err
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		// Zero rows affected: either duplicate (OR IGNORE) or limit exceeded.
		// Re-check existence to distinguish.
		b.db.QueryRow("SELECT 1 FROM messages WHERE id = ?", msgID).Scan(&exists)
		if exists == 1 {
			return nil // idempotent — already stored (possibly by concurrent Add)
		}
		return ErrBufferFull
	}
	return nil
}

// AddOption configures optional fields for Buffer.Add.
type AddOption func(*addOptions)

type addOptions struct {
	sender    string
	expiresAt *int64
}

// WithSender sets the sender DID for the buffered message.
func WithSender(sender string) AddOption {
	return func(o *addOptions) { o.sender = sender }
}

// WithExpiresAt sets the expiry unix timestamp.
func WithExpiresAt(ts int64) AddOption {
	return func(o *addOptions) { o.expiresAt = &ts }
}

// Drain removes and returns all buffered messages for a DID, ordered by arrival.
// For production drain loops, use Peek + per-message Delete (delete-on-ack, MBX-066).
// Drain is a convenience for tests and one-shot consumption where atomicity isn't needed.
func (b *Buffer) Drain(did string) []BufferedMsg {
	msgs := b.Peek(did)
	if len(msgs) > 0 {
		b.db.Exec("DELETE FROM messages WHERE recipient = ?", did)
	}
	return msgs
}

// Peek returns all buffered messages for a DID WITHOUT deleting them.
// Messages are ordered by arrival time (FIFO). The caller is responsible
// for deleting each message individually after successful delivery via
// Delete() or DeleteIfExists(). This enables delete-on-ack semantics:
// on partial delivery failure, undelivered messages remain in the buffer.
func (b *Buffer) Peek(did string) []BufferedMsg {
	rows, err := b.db.Query(
		"SELECT id, payload, stored_at, sender, expires_at FROM messages WHERE recipient = ? ORDER BY stored_at ASC",
		did,
	)
	if err != nil {
		return nil
	}
	defer rows.Close()

	var msgs []BufferedMsg
	for rows.Next() {
		var m BufferedMsg
		var ts int64
		if rows.Scan(&m.ID, &m.Payload, &ts, &m.Sender, &m.ExpiresAt) == nil {
			m.StoredAt = time.Unix(ts, 0)
			msgs = append(msgs, m)
		}
	}
	return msgs
}

// Delete removes a single message by ID. No ownership check — for
// internal use only (drain loop, cancel). Use DeleteForRecipient
// if the caller is client-facing.
func (b *Buffer) Delete(msgID string) {
	b.DeleteIfExists(msgID)
}

// DeleteForRecipient removes a message only if it belongs to the specified
// recipient DID. Returns true if found and deleted, false otherwise.
// This prevents a client from deleting another DID's buffered messages.
func (b *Buffer) DeleteForRecipient(msgID, recipientDID string) bool {
	result, err := b.db.Exec(
		"DELETE FROM messages WHERE id = ? AND recipient = ?", msgID, recipientDID)
	if err != nil {
		return false
	}
	n, _ := result.RowsAffected()
	return n > 0
}

// DeleteIfExists removes a single message by ID and reports whether a row
// was actually deleted. Returns true if the message existed and was removed,
// false if it was not found (already delivered, already deleted, or never
// buffered). Used by routeCancel to decide whether to relay cancel to Core.
func (b *Buffer) DeleteIfExists(msgID string) bool {
	result, err := b.db.Exec("DELETE FROM messages WHERE id = ?", msgID)
	if err != nil {
		return false
	}
	n, err := result.RowsAffected()
	if err != nil {
		return false
	}
	return n > 0
}

// ExpireTTL removes messages that have exceeded the generic 24h TTL OR
// whose per-message expires_at has passed. Returns count removed.
func (b *Buffer) ExpireTTL() int {
	now := time.Now().Unix()
	cutoff := now - int64(MessageTTL.Seconds())
	result, err := b.db.Exec(
		"DELETE FROM messages WHERE stored_at < ? OR (expires_at IS NOT NULL AND expires_at < ?)",
		cutoff, now,
	)
	if err != nil {
		return 0
	}
	n, _ := result.RowsAffected()
	return int(n)
}

// TotalCount returns the total number of buffered messages across all DIDs.
func (b *Buffer) TotalCount() int {
	var count int
	b.db.QueryRow("SELECT COUNT(*) FROM messages").Scan(&count)
	return count
}

// Close closes the underlying database.
func (b *Buffer) Close() error {
	return b.db.Close()
}
