package internal

import (
	"database/sql"
	"errors"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

// Buffer limits.
const (
	MaxMessagesPerDID = 100
	MaxBytesPerDID    = 10 * 1024 * 1024 // 10 MiB
	MessageTTL        = 24 * time.Hour
)

var (
	ErrBufferFull  = errors.New("relay: buffer full for recipient")
	ErrMsgTooLarge = errors.New("relay: message exceeds max size")
)

// BufferedMsg is a pending message in the durable buffer.
type BufferedMsg struct {
	ID       string
	Payload  []byte
	StoredAt time.Time
}

// Buffer is a durable per-DID message queue backed by SQLite.
// When /forward returns 202, the message is durably stored.
// A relay restart does not lose queued messages.
type Buffer struct {
	db *sql.DB
}

// NewBuffer opens (or creates) the SQLite buffer at the given path.
// Use ":memory:" for testing only.
func NewBuffer(dbPath string) (*Buffer, error) {
	db, err := sql.Open("sqlite3", dbPath+"?_journal_mode=WAL&_busy_timeout=5000&_synchronous=NORMAL")
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
	return &Buffer{db: db}, nil
}

// Add durably stores a message for a DID. Returns ErrBufferFull if per-DID
// limits are exceeded. Idempotent by msg_id.
func (b *Buffer) Add(did, msgID string, payload []byte) error {
	// Idempotency check.
	var exists int
	b.db.QueryRow("SELECT 1 FROM messages WHERE id = ?", msgID).Scan(&exists)
	if exists == 1 {
		return nil
	}

	// Per-DID limits.
	var count int
	var totalSize int64
	b.db.QueryRow("SELECT COUNT(*), COALESCE(SUM(size),0) FROM messages WHERE recipient = ?", did).Scan(&count, &totalSize)
	if count >= MaxMessagesPerDID {
		return ErrBufferFull
	}
	if totalSize+int64(len(payload)) > MaxBytesPerDID {
		return ErrBufferFull
	}

	_, err := b.db.Exec(
		"INSERT OR IGNORE INTO messages (id, recipient, payload, size, stored_at) VALUES (?, ?, ?, ?, ?)",
		msgID, did, payload, len(payload), time.Now().Unix(),
	)
	return err
}

// Drain removes and returns all buffered messages for a DID, ordered by arrival.
func (b *Buffer) Drain(did string) []BufferedMsg {
	rows, err := b.db.Query(
		"SELECT id, payload, stored_at FROM messages WHERE recipient = ? ORDER BY stored_at ASC",
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
		if rows.Scan(&m.ID, &m.Payload, &ts) == nil {
			m.StoredAt = time.Unix(ts, 0)
			msgs = append(msgs, m)
		}
	}

	if len(msgs) > 0 {
		b.db.Exec("DELETE FROM messages WHERE recipient = ?", did)
	}
	return msgs
}

// Delete removes a single message by ID (used after recipient ACK).
func (b *Buffer) Delete(msgID string) {
	b.db.Exec("DELETE FROM messages WHERE id = ?", msgID)
}

// ExpireTTL removes messages older than MessageTTL. Returns count removed.
func (b *Buffer) ExpireTTL() int {
	cutoff := time.Now().Add(-MessageTTL).Unix()
	result, err := b.db.Exec("DELETE FROM messages WHERE stored_at < ?", cutoff)
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
