//go:build cgo

package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port" // for port.ErrDelegatedTaskExists
)

// Compile-time interface check.
var _ port.DelegatedTaskStore = (*DelegatedTaskStore)(nil)

// DelegatedTaskStore implements port.DelegatedTaskStore using identity.sqlite.
type DelegatedTaskStore struct {
	pool *Pool
}

// NewDelegatedTaskStore returns a new SQLite-backed delegated task store.
func NewDelegatedTaskStore(pool *Pool) *DelegatedTaskStore {
	return &DelegatedTaskStore{pool: pool}
}

func (s *DelegatedTaskStore) db() *sql.DB {
	return s.pool.DB("identity")
}

func now() int64 {
	return time.Now().Unix()
}

// Create inserts a new delegated task. Returns port.ErrDelegatedTaskExists on duplicate ID.
func (s *DelegatedTaskStore) Create(ctx context.Context, task domain.DelegatedTask) error {
	_, err := s.db().ExecContext(ctx,
		`INSERT INTO delegated_tasks (id, proposal_id, description, origin, status, idempotency_key, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		task.ID, task.ProposalID, task.Description, task.Origin,
		string(task.Status), task.IdempotencyKey, now(), now(),
	)
	if err != nil && (strings.Contains(err.Error(), "UNIQUE constraint") || strings.Contains(err.Error(), "PRIMARY KEY")) {
		return port.ErrDelegatedTaskExists
	}
	return err
}

// GetByID returns a task by its ID.
func (s *DelegatedTaskStore) GetByID(ctx context.Context, id string) (*domain.DelegatedTask, error) {
	return s.scanOne(s.db().QueryRowContext(ctx,
		`SELECT id, proposal_id, session_name, description, origin, status, agent_did,
		        lease_expires_at, run_id, idempotency_key, result_summary, progress_note,
		        error, created_at, updated_at
		 FROM delegated_tasks WHERE id = ?`, id))
}

// GetByProposalID returns a task linked to a proposal.
func (s *DelegatedTaskStore) GetByProposalID(ctx context.Context, proposalID string) (*domain.DelegatedTask, error) {
	if proposalID == "" {
		return nil, nil
	}
	return s.scanOne(s.db().QueryRowContext(ctx,
		`SELECT id, proposal_id, session_name, description, origin, status, agent_did,
		        lease_expires_at, run_id, idempotency_key, result_summary, progress_note,
		        error, created_at, updated_at
		 FROM delegated_tasks WHERE proposal_id = ? LIMIT 1`, proposalID))
}

// List returns tasks filtered by status.
func (s *DelegatedTaskStore) List(ctx context.Context, status string, limit int) ([]domain.DelegatedTask, error) {
	if limit <= 0 {
		limit = 50
	}
	var rows *sql.Rows
	var err error
	if status != "" {
		rows, err = s.db().QueryContext(ctx,
			`SELECT id, proposal_id, session_name, description, origin, status, agent_did,
			        lease_expires_at, run_id, idempotency_key, result_summary, progress_note,
			        error, created_at, updated_at
			 FROM delegated_tasks WHERE status = ? ORDER BY created_at DESC LIMIT ?`,
			status, limit)
	} else {
		rows, err = s.db().QueryContext(ctx,
			`SELECT id, proposal_id, session_name, description, origin, status, agent_did,
			        lease_expires_at, run_id, idempotency_key, result_summary, progress_note,
			        error, created_at, updated_at
			 FROM delegated_tasks ORDER BY created_at DESC LIMIT ?`,
			limit)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var tasks []domain.DelegatedTask
	for rows.Next() {
		t, err := s.scanRow(rows)
		if err != nil {
			return nil, err
		}
		tasks = append(tasks, *t)
	}
	return tasks, rows.Err()
}

// Claim atomically grabs the oldest queued task.
func (s *DelegatedTaskStore) Claim(ctx context.Context, agentDID string, leaseSec int) (*domain.DelegatedTask, error) {
	leaseExpires := now() + int64(leaseSec)
	ts := now()

	row := s.db().QueryRowContext(ctx,
		`UPDATE delegated_tasks
		 SET status = 'claimed', agent_did = ?, lease_expires_at = ?, updated_at = ?,
		     session_name = 'task-' || id
		 WHERE id = (
		     SELECT id FROM delegated_tasks
		     WHERE status = 'queued'
		     ORDER BY created_at ASC
		     LIMIT 1
		 )
		 RETURNING id, proposal_id, session_name, description, origin, status, agent_did,
		           lease_expires_at, run_id, idempotency_key, result_summary, progress_note,
		           error, created_at, updated_at`,
		agentDID, leaseExpires, ts,
	)

	task, err := s.scanOne(row)
	if err == sql.ErrNoRows {
		return nil, nil // no work available
	}
	return task, err
}

// Heartbeat extends the lease for a claimed task.
func (s *DelegatedTaskStore) Heartbeat(ctx context.Context, id, agentDID string, leaseSec int) error {
	leaseExpires := now() + int64(leaseSec)
	result, err := s.db().ExecContext(ctx,
		`UPDATE delegated_tasks SET lease_expires_at = ?, updated_at = ?
		 WHERE id = ? AND agent_did = ? AND status IN ('claimed', 'running')`,
		leaseExpires, now(), id, agentDID,
	)
	if err != nil {
		return err
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		return fmt.Errorf("task %s not found or not owned by %s", id, agentDID)
	}
	return nil
}

// UpdateProgress stores a progress note.
func (s *DelegatedTaskStore) UpdateProgress(ctx context.Context, id, agentDID, message string) error {
	result, err := s.db().ExecContext(ctx,
		`UPDATE delegated_tasks SET progress_note = ?, updated_at = ?
		 WHERE id = ? AND agent_did = ? AND status IN ('claimed', 'running')`,
		message, now(), id, agentDID,
	)
	if err != nil {
		return err
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		return fmt.Errorf("task %s not found or not owned by %s", id, agentDID)
	}
	return nil
}

// Complete marks a task as completed.
func (s *DelegatedTaskStore) Complete(ctx context.Context, id, agentDID, result string) error {
	res, err := s.db().ExecContext(ctx,
		`UPDATE delegated_tasks SET status = 'completed', result_summary = ?, updated_at = ?
		 WHERE id = ? AND agent_did = ? AND status IN ('claimed', 'running')`,
		result, now(), id, agentDID,
	)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("task %s not found or not owned by %s", id, agentDID)
	}
	return nil
}

// Fail marks a task as failed.
func (s *DelegatedTaskStore) Fail(ctx context.Context, id, agentDID, errMsg string) error {
	res, err := s.db().ExecContext(ctx,
		`UPDATE delegated_tasks SET status = 'failed', error = ?, updated_at = ?
		 WHERE id = ? AND agent_did = ? AND status IN ('claimed', 'running')`,
		errMsg, now(), id, agentDID,
	)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("task %s not found or not owned by %s", id, agentDID)
	}
	return nil
}

// QueueByProposalID transitions a task from pending_approval to queued.
// Idempotent: already queued+ = no-op. No linked task = no-op.
func (s *DelegatedTaskStore) QueueByProposalID(ctx context.Context, proposalID string) error {
	if proposalID == "" {
		return nil
	}
	_, err := s.db().ExecContext(ctx,
		`UPDATE delegated_tasks SET status = 'queued', updated_at = ?
		 WHERE proposal_id = ? AND status = 'pending_approval'`,
		now(), proposalID,
	)
	return err
}

// ExpireLeases requeues tasks with expired leases and returns the old task
// state (with agent_did/session_name) for session cleanup.
//
// Race safety: each task is updated individually by ID, and only if it still
// has the expected lease_expires_at. If a concurrent heartbeat extended the
// lease between our read and update, the per-ID UPDATE is a no-op and the
// task is correctly excluded from the returned list.
func (s *DelegatedTaskStore) ExpireLeases(ctx context.Context) ([]domain.DelegatedTask, error) {
	ts := now()
	db := s.db()

	// Read candidates.
	rows, err := db.QueryContext(ctx,
		`SELECT id, proposal_id, session_name, description, origin, status, agent_did,
		        lease_expires_at, run_id, idempotency_key, result_summary, progress_note,
		        error, created_at, updated_at
		 FROM delegated_tasks
		 WHERE status IN ('claimed', 'running') AND lease_expires_at > 0 AND lease_expires_at < ?`,
		ts,
	)
	if err != nil {
		return nil, err
	}

	var candidates []domain.DelegatedTask
	for rows.Next() {
		t, scanErr := s.scanRow(rows)
		if scanErr != nil {
			rows.Close()
			return nil, scanErr
		}
		candidates = append(candidates, *t)
	}
	rows.Close()

	// Requeue each individually, matching on ID + lease_expires_at to avoid
	// racing with concurrent heartbeats.
	var expired []domain.DelegatedTask
	for _, t := range candidates {
		result, err := db.ExecContext(ctx,
			`UPDATE delegated_tasks
			 SET status = 'queued', agent_did = '', session_name = '', lease_expires_at = 0,
			     progress_note = '', updated_at = ?
			 WHERE id = ? AND lease_expires_at = ? AND status IN ('claimed', 'running')`,
			ts, t.ID, t.LeaseExpiresAt,
		)
		if err != nil {
			continue // best-effort per task
		}
		n, _ := result.RowsAffected()
		if n > 0 {
			expired = append(expired, t) // only include actually requeued tasks
		}
	}

	return expired, nil
}

// --- scan helpers ---

func (s *DelegatedTaskStore) scanOne(row *sql.Row) (*domain.DelegatedTask, error) {
	var t domain.DelegatedTask
	var status string
	err := row.Scan(
		&t.ID, &t.ProposalID, &t.SessionName, &t.Description, &t.Origin,
		&status, &t.AgentDID, &t.LeaseExpiresAt, &t.RunID, &t.IdempotencyKey,
		&t.ResultSummary, &t.ProgressNote, &t.Error, &t.CreatedAt, &t.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	t.Status = domain.DelegatedTaskStatus(status)
	return &t, nil
}

func (s *DelegatedTaskStore) scanRow(rows *sql.Rows) (*domain.DelegatedTask, error) {
	var t domain.DelegatedTask
	var status string
	err := rows.Scan(
		&t.ID, &t.ProposalID, &t.SessionName, &t.Description, &t.Origin,
		&status, &t.AgentDID, &t.LeaseExpiresAt, &t.RunID, &t.IdempotencyKey,
		&t.ResultSummary, &t.ProgressNote, &t.Error, &t.CreatedAt, &t.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	t.Status = domain.DelegatedTaskStatus(status)
	return &t, nil
}
