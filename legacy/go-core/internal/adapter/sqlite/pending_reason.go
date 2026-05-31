package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
)

// PendingReasonStore is a SQLite implementation of port.PendingReasonStore
// backed by the identity.sqlite database.
type PendingReasonStore struct {
	pool *Pool
}

// Compile-time check.
var _ port.PendingReasonStore = (*PendingReasonStore)(nil)

// NewPendingReasonStore creates a store backed by identity.sqlite.
func NewPendingReasonStore(pool *Pool) *PendingReasonStore {
	return &PendingReasonStore{pool: pool}
}

func (s *PendingReasonStore) db() *sql.DB {
	return s.pool.DB("identity")
}

// Create stores a new pending reason record.
func (s *PendingReasonStore) Create(ctx context.Context, record domain.PendingReasonRecord) error {
	db := s.db()
	if db == nil {
		return fmt.Errorf("pending_reason: identity database not open")
	}

	_, err := db.ExecContext(ctx,
		`INSERT INTO pending_reason (request_id, caller_did, session_name, approval_id,
			status, request_meta, result, error, created_at, updated_at, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?, '', '', ?, ?, ?)`,
		record.RequestID, record.CallerDID, record.SessionName, record.ApprovalID,
		record.Status, record.RequestMeta,
		record.CreatedAt, record.UpdatedAt, record.ExpiresAt,
	)
	return err
}

// GetByID retrieves a pending reason by request_id.
// Enforces caller binding: returns error if callerDID doesn't match.
func (s *PendingReasonStore) GetByID(ctx context.Context, requestID, callerDID string) (*domain.PendingReasonRecord, error) {
	db := s.db()
	if db == nil {
		return nil, fmt.Errorf("pending_reason: identity database not open")
	}

	var r domain.PendingReasonRecord
	err := db.QueryRowContext(ctx,
		`SELECT request_id, caller_did, session_name, approval_id, status,
		        request_meta, result, error, created_at, updated_at, expires_at
		 FROM pending_reason WHERE request_id = ?`, requestID,
	).Scan(&r.RequestID, &r.CallerDID, &r.SessionName, &r.ApprovalID,
		&r.Status, &r.RequestMeta, &r.Result, &r.Error,
		&r.CreatedAt, &r.UpdatedAt, &r.ExpiresAt)

	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	// Caller binding: only the original caller can read the result.
	if callerDID != "" && r.CallerDID != callerDID {
		return nil, fmt.Errorf("pending_reason: access denied (caller mismatch)")
	}

	return &r, nil
}

// GetByApprovalID finds all pending reason records for an approval.
func (s *PendingReasonStore) GetByApprovalID(ctx context.Context, approvalID string) ([]domain.PendingReasonRecord, error) {
	db := s.db()
	if db == nil {
		return nil, fmt.Errorf("pending_reason: identity database not open")
	}

	rows, err := db.QueryContext(ctx,
		`SELECT request_id, caller_did, session_name, approval_id, status,
		        request_meta, result, error, created_at, updated_at, expires_at
		 FROM pending_reason WHERE approval_id = ? AND status = 'pending_approval'`,
		approvalID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var records []domain.PendingReasonRecord
	for rows.Next() {
		var r domain.PendingReasonRecord
		if err := rows.Scan(&r.RequestID, &r.CallerDID, &r.SessionName, &r.ApprovalID,
			&r.Status, &r.RequestMeta, &r.Result, &r.Error,
			&r.CreatedAt, &r.UpdatedAt, &r.ExpiresAt); err != nil {
			return nil, err
		}
		records = append(records, r)
	}
	return records, nil
}

// UpdateStatus updates the status (and optionally result/error) of a record.
func (s *PendingReasonStore) UpdateStatus(ctx context.Context, requestID, status, result, errMsg string) error {
	db := s.db()
	if db == nil {
		return fmt.Errorf("pending_reason: identity database not open")
	}

	now := time.Now().Unix()
	_, err := db.ExecContext(ctx,
		`UPDATE pending_reason SET status = ?, result = ?, error = ?, updated_at = ?
		 WHERE request_id = ?`,
		status, result, errMsg, now, requestID,
	)
	return err
}

// UpdateApprovalID updates the approval_id for a second-approval cycle.
// Also extends expires_at to give the new approval a full TTL window.
func (s *PendingReasonStore) UpdateApprovalID(ctx context.Context, requestID, approvalID string) error {
	db := s.db()
	if db == nil {
		return fmt.Errorf("pending_reason: identity database not open")
	}
	now := time.Now().Unix()
	newExpiry := now + int64(domain.DefaultPendingReasonTTL)
	_, err := db.ExecContext(ctx,
		`UPDATE pending_reason SET approval_id = ?, updated_at = ?, expires_at = ? WHERE request_id = ?`,
		approvalID, now, newExpiry, requestID,
	)
	return err
}

// Sweep deletes expired entries. Returns count cleaned.
func (s *PendingReasonStore) Sweep(ctx context.Context) (int, error) {
	db := s.db()
	if db == nil {
		return 0, fmt.Errorf("pending_reason: identity database not open")
	}

	now := time.Now().Unix()
	count := 0

	// Delete completed/denied/failed entries older than retention period.
	retentionCutoff := now - int64(domain.CompletedReasonRetention)
	res, err := db.ExecContext(ctx,
		`DELETE FROM pending_reason WHERE updated_at < ?
		 AND status IN ('complete', 'denied', 'failed', 'expired')`, retentionCutoff)
	if err == nil {
		if n, _ := res.RowsAffected(); n > 0 {
			count += int(n)
		}
	}

	// Mark pending entries past TTL as expired.
	res, err = db.ExecContext(ctx,
		`UPDATE pending_reason SET status = 'expired', updated_at = ?
		 WHERE expires_at > 0 AND expires_at < ?
		 AND status IN ('pending_approval', 'resuming')`,
		now, now)
	if err == nil {
		if n, _ := res.RowsAffected(); n > 0 {
			count += int(n)
		}
	}

	return count, nil
}
