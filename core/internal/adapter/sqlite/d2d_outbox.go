//go:build cgo

package sqlite

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"fmt"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
)

// D2DOutboxManager is a durable SQLite implementation of port.OutboxManager
// backed by the d2d_outbox table in identity.sqlite.
// Messages survive Core restarts and are retried with exponential backoff.
type D2DOutboxManager struct {
	pool *Pool
}

// Compile-time check.
var _ port.OutboxManager = (*D2DOutboxManager)(nil)

// NewD2DOutboxManager creates an OutboxManager backed by identity.sqlite.
func NewD2DOutboxManager(pool *Pool) *D2DOutboxManager {
	return &D2DOutboxManager{pool: pool}
}

func (o *D2DOutboxManager) db() *sql.DB {
	return o.pool.DB("identity")
}

// generateMsgID generates a cryptographically random 16-byte hex ID.
func generateMsgID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("d2d_outbox: generate ID: %w", err)
	}
	return "out-" + hex.EncodeToString(b), nil
}

// Enqueue adds a message to the outbox. Returns the message ID.
// If msg.ID is empty, a random ID is generated.
// Uses INSERT OR IGNORE for idempotent delivery (same ID = no-op).
func (o *D2DOutboxManager) Enqueue(ctx context.Context, msg domain.OutboxMessage) (string, error) {
	db := o.db()
	if db == nil {
		return "", fmt.Errorf("d2d_outbox: identity database not open")
	}

	if msg.ID == "" {
		id, err := generateMsgID()
		if err != nil {
			return "", err
		}
		msg.ID = id
	}

	now := time.Now().Unix()
	if msg.CreatedAt == 0 {
		msg.CreatedAt = now
	}
	if msg.Priority == 0 {
		msg.Priority = int(domain.PriorityNormal)
	}
	if msg.Status == "" {
		msg.Status = string(domain.OutboxPending)
	}
	// Coerce nil slices to empty — SQLite treats nil []byte as NULL,
	// which would violate the NOT NULL constraint and silently skip the
	// INSERT OR IGNORE.
	if msg.Sig == nil {
		msg.Sig = []byte{}
	}
	if msg.Payload == nil {
		msg.Payload = []byte{}
	}

	_, err := db.ExecContext(ctx,
		`INSERT OR IGNORE INTO d2d_outbox
			(id, to_did, msg_type, payload, sig, status, approval_id, priority, retries, next_retry, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		msg.ID, msg.ToDID, "", msg.Payload, msg.Sig,
		msg.Status, msg.ApprovalID,
		msg.Priority, msg.Retries, msg.NextRetry,
		msg.CreatedAt, now,
	)
	if err != nil {
		return "", fmt.Errorf("d2d_outbox: enqueue: %w", err)
	}
	return msg.ID, nil
}

// ListPending returns all pending and retryable-failed messages whose retry
// time has elapsed. Excludes pending_approval (those wait for owner approval).
func (o *D2DOutboxManager) ListPending(ctx context.Context) ([]domain.OutboxMessage, error) {
	db := o.db()
	if db == nil {
		return nil, fmt.Errorf("d2d_outbox: identity database not open")
	}

	now := time.Now().Unix()
	rows, err := db.QueryContext(ctx,
		`SELECT id, to_did, msg_type, payload, sig, status, approval_id, priority, retries, next_retry, created_at
		 FROM d2d_outbox
		 WHERE (status='pending' OR status='failed')
		   AND next_retry <= ?
		   AND retries < 5
		 ORDER BY priority DESC, created_at ASC`,
		now,
	)
	if err != nil {
		return nil, fmt.Errorf("d2d_outbox: list pending: %w", err)
	}
	defer rows.Close()

	var msgs []domain.OutboxMessage
	for rows.Next() {
		var m domain.OutboxMessage
		var msgType string
		if err := rows.Scan(
			&m.ID, &m.ToDID, &msgType, &m.Payload, &m.Sig,
			&m.Status, &m.ApprovalID, &m.Priority, &m.Retries, &m.NextRetry, &m.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("d2d_outbox: scan: %w", err)
		}
		msgs = append(msgs, m)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("d2d_outbox: rows: %w", err)
	}
	return msgs, nil
}

// MarkDelivered marks a message as delivered.
func (o *D2DOutboxManager) MarkDelivered(ctx context.Context, msgID string) error {
	db := o.db()
	if db == nil {
		return fmt.Errorf("d2d_outbox: identity database not open")
	}

	now := time.Now().Unix()
	res, err := db.ExecContext(ctx,
		`UPDATE d2d_outbox SET status='delivered', updated_at=? WHERE id=?`,
		now, msgID,
	)
	if err != nil {
		return fmt.Errorf("d2d_outbox: mark delivered: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("d2d_outbox: message not found: %s", msgID)
	}
	return nil
}

// MarkFailed marks a message as failed and schedules exponential backoff retry.
// Backoff formula: 30s * 2^retries (30s, 60s, 120s, 240s, 480s).
func (o *D2DOutboxManager) MarkFailed(ctx context.Context, msgID string) error {
	db := o.db()
	if db == nil {
		return fmt.Errorf("d2d_outbox: identity database not open")
	}

	now := time.Now().Unix()
	// Fetch current retry count to compute backoff.
	var retries int
	err := db.QueryRowContext(ctx,
		`SELECT retries FROM d2d_outbox WHERE id=?`, msgID,
	).Scan(&retries)
	if err == sql.ErrNoRows {
		return fmt.Errorf("d2d_outbox: message not found: %s", msgID)
	}
	if err != nil {
		return fmt.Errorf("d2d_outbox: mark failed fetch: %w", err)
	}

	retries++
	backoff := int64(30) << uint(retries) // 30*2^retries seconds
	nextRetry := now + backoff

	_, err = db.ExecContext(ctx,
		`UPDATE d2d_outbox SET status='failed', retries=?, next_retry=?, updated_at=? WHERE id=?`,
		retries, nextRetry, now, msgID,
	)
	if err != nil {
		return fmt.Errorf("d2d_outbox: mark failed: %w", err)
	}
	return nil
}

// Requeue resets a message to pending with zero retries for manual re-delivery.
func (o *D2DOutboxManager) Requeue(ctx context.Context, msgID string) error {
	db := o.db()
	if db == nil {
		return fmt.Errorf("d2d_outbox: identity database not open")
	}

	now := time.Now().Unix()
	res, err := db.ExecContext(ctx,
		`UPDATE d2d_outbox SET status='pending', retries=0, next_retry=0, updated_at=?
		 WHERE id=? AND status='failed'`,
		now, msgID,
	)
	if err != nil {
		return fmt.Errorf("d2d_outbox: requeue: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("d2d_outbox: message not found or not in failed state: %s", msgID)
	}
	return nil
}

// PendingCount returns the number of pending messages (excludes pending_approval).
func (o *D2DOutboxManager) PendingCount(ctx context.Context) (int, error) {
	db := o.db()
	if db == nil {
		return 0, fmt.Errorf("d2d_outbox: identity database not open")
	}

	var count int
	err := db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM d2d_outbox WHERE status='pending'`,
	).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("d2d_outbox: pending count: %w", err)
	}
	return count, nil
}

// DeleteExpired removes delivered/failed messages older than ttlSeconds.
// Returns the count of deleted rows.
func (o *D2DOutboxManager) DeleteExpired(ctx context.Context, ttlSeconds int64) (int, error) {
	db := o.db()
	if db == nil {
		return 0, fmt.Errorf("d2d_outbox: identity database not open")
	}

	cutoff := time.Now().Unix() - ttlSeconds
	res, err := db.ExecContext(ctx,
		`DELETE FROM d2d_outbox
		 WHERE created_at < ?
		   AND (status='delivered' OR status='failed')`,
		cutoff,
	)
	if err != nil {
		return 0, fmt.Errorf("d2d_outbox: delete expired: %w", err)
	}
	n, _ := res.RowsAffected()
	return int(n), nil
}

// ResumeAfterApproval transitions a pending_approval message to pending
// so the outbox scheduler picks it up on the next tick.
func (o *D2DOutboxManager) ResumeAfterApproval(ctx context.Context, msgID string) error {
	db := o.db()
	if db == nil {
		return fmt.Errorf("d2d_outbox: identity database not open")
	}

	now := time.Now().Unix()
	res, err := db.ExecContext(ctx,
		`UPDATE d2d_outbox SET status='pending', next_retry=0, updated_at=?
		 WHERE id=? AND status='pending_approval'`,
		now, msgID,
	)
	if err != nil {
		return fmt.Errorf("d2d_outbox: resume after approval: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("d2d_outbox: message not found or not in pending_approval state: %s", msgID)
	}
	return nil
}
