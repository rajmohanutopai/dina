//go:build cgo

package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
)

func now() int64 {
	return time.Now().Unix()
}

// Compile-time interface check.
var _ port.WorkflowStore = (*WorkflowStore)(nil)

// WorkflowStore implements port.WorkflowStore using identity.sqlite.
type WorkflowStore struct {
	pool *Pool
}

// NewWorkflowStore returns a new SQLite-backed workflow store.
func NewWorkflowStore(pool *Pool) *WorkflowStore {
	return &WorkflowStore{pool: pool}
}

func (s *WorkflowStore) db() *sql.DB {
	return s.pool.DB("identity")
}

// ---------------------------------------------------------------------------
// Column list used by all SELECT queries — must match scanTask / scanTaskRow.
// ---------------------------------------------------------------------------

const taskColumns = `id, kind, state, correlation_id, parent_id, proposal_id,
	priority, description, payload, result, result_summary, policy,
	error, requested_runner, assigned_runner, agent_did, run_id,
	progress_note, lease_expires_at, origin, session_name,
	idempotency_key, expires_at, next_run_at, recurrence,
	internal_stash, created_at, updated_at`

const eventColumns = `event_id, task_id, at, event_kind, needs_delivery,
	delivery_attempts, next_delivery_at, delivering_until,
	delivered_at, acknowledged_at, delivery_failed, details`

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

// Create inserts a new workflow task.
// Returns port.ErrDelegatedTaskExists on duplicate idempotency_key (reused
// sentinel for backward compatibility).
func (s *WorkflowStore) Create(ctx context.Context, task domain.WorkflowTask) error {
	ts := now()
	// Normalize empty idempotency_key to NULL so partial unique index doesn't
	// collide on empty strings. Convention: unset = NULL, set = non-empty.
	var idemKey interface{}
	if task.IdempotencyKey != "" {
		idemKey = task.IdempotencyKey
	}
	_, err := s.db().ExecContext(ctx,
		`INSERT INTO workflow_tasks (
			id, kind, state, correlation_id, parent_id, proposal_id,
			priority, description, payload, result, result_summary, policy,
			error, requested_runner, assigned_runner, agent_did, run_id,
			progress_note, lease_expires_at, origin, session_name,
			idempotency_key, expires_at, next_run_at, recurrence,
			internal_stash, created_at, updated_at
		) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		task.ID, task.Kind, task.Status, task.CorrelationID, task.ParentID,
		task.ProposalID, task.Priority, task.Description, task.Payload,
		task.Result, task.ResultSummary, task.Policy, task.Error,
		task.RequestedRunner, task.AssignedRunner, task.AgentDID, task.RunID,
		task.ProgressNote, task.LeaseExpiresAt, task.Origin, task.SessionName,
		idemKey, task.ExpiresAt, task.NextRunAt, task.Recurrence,
		nil, ts, ts,
	)
	if err != nil && (strings.Contains(err.Error(), "UNIQUE constraint") || strings.Contains(err.Error(), "PRIMARY KEY")) {
		return port.ErrDelegatedTaskExists
	}
	return err
}

// GetByID returns a task by primary key.
func (s *WorkflowStore) GetByID(ctx context.Context, id string) (*domain.WorkflowTask, error) {
	row := s.db().QueryRowContext(ctx,
		`SELECT `+taskColumns+` FROM workflow_tasks WHERE id = ?`, id)
	return s.scanTask(row)
}

// GetByProposalID returns the task linked to a proposal. Nil if none.
func (s *WorkflowStore) GetByProposalID(ctx context.Context, proposalID string) (*domain.WorkflowTask, error) {
	if proposalID == "" {
		return nil, nil
	}
	row := s.db().QueryRowContext(ctx,
		`SELECT `+taskColumns+` FROM workflow_tasks WHERE proposal_id = ? LIMIT 1`, proposalID)
	return s.scanTask(row)
}

// GetByIdempotencyKey returns the first task with a given idempotency key. Nil if none.
// Deprecated: use GetActiveByIdempotencyKey for service query dedupe — this method
// is ambiguous when terminal and active tasks share the same key.
func (s *WorkflowStore) GetByIdempotencyKey(ctx context.Context, key string) (*domain.WorkflowTask, error) {
	if key == "" {
		return nil, nil
	}
	row := s.db().QueryRowContext(ctx,
		`SELECT `+taskColumns+` FROM workflow_tasks WHERE idempotency_key = ? LIMIT 1`, key)
	return s.scanTask(row)
}

// GetActiveByIdempotencyKey returns a non-terminal task with this idempotency key, or nil.
// Used for service query dedupe: only deduplicates against active tasks, not terminal ones.
func (s *WorkflowStore) GetActiveByIdempotencyKey(ctx context.Context, key string) (*domain.WorkflowTask, error) {
	if key == "" {
		return nil, nil
	}
	row := s.db().QueryRowContext(ctx,
		`SELECT `+taskColumns+` FROM workflow_tasks
		 WHERE idempotency_key = ?
		   AND state NOT IN ('completed','failed','cancelled','recorded')
		 LIMIT 1`, key)
	return s.scanTask(row)
}

// GetByCorrelationID returns all tasks sharing a correlation ID.
func (s *WorkflowStore) GetByCorrelationID(ctx context.Context, corrID string) ([]domain.WorkflowTask, error) {
	if corrID == "" {
		return nil, nil
	}
	rows, err := s.db().QueryContext(ctx,
		`SELECT `+taskColumns+` FROM workflow_tasks WHERE correlation_id = ? ORDER BY created_at ASC`, corrID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return s.collectTasks(rows)
}

// FindServiceQueryTask finds running/created service_query tasks matching a strict
// (queryID, peerDID, capability) tuple. Returns nil if no match. Returns error
// if >1 match (data integrity violation — indicates an idempotency bug).
// Used for service.response authorization: task IS the sole authority.
// nowUnix is the caller's clock time (avoids SQLite wall-clock divergence under test).
//
// Note: payload matching is done in Go, not SQL, because go-sqlcipher bundles
// SQLite 3.33.0 which does not include the JSON1 extension (no json_extract).
func (s *WorkflowStore) FindServiceQueryTask(ctx context.Context, queryID, peerDID, capability string, nowUnix int64) (*domain.WorkflowTask, error) {
	if queryID == "" || peerDID == "" || capability == "" {
		return nil, nil
	}
	// SQL narrows by kind, correlation_id, state, and expiry.
	// Payload fields (to_did, capability) are checked in Go below.
	rows, err := s.db().QueryContext(ctx,
		`SELECT `+taskColumns+` FROM workflow_tasks
		 WHERE kind = 'service_query'
		   AND correlation_id = ?
		   AND state IN ('created', 'running')
		   AND expires_at > ?`,
		queryID, nowUnix)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	candidates, err := s.collectTasks(rows)
	if err != nil {
		return nil, err
	}

	// Filter by payload fields in Go (no json_extract in SQLite 3.33).
	var matched []domain.WorkflowTask
	for _, t := range candidates {
		var payload map[string]interface{}
		if json.Unmarshal([]byte(t.Payload), &payload) != nil {
			continue
		}
		toDID, _ := payload["to_did"].(string)
		cap, _ := payload["capability"].(string)
		if toDID == peerDID && cap == capability {
			matched = append(matched, t)
		}
	}

	switch len(matched) {
	case 0:
		return nil, nil
	case 1:
		return &matched[0], nil
	default:
		slog.Warn("workflow.find_service_query_task: >1 active match (data integrity violation)",
			"query_id", queryID, "peer_did", peerDID, "capability", capability, "count", len(matched))
		return nil, fmt.Errorf("multiple active service_query tasks for query_id %s (count=%d)", queryID, len(matched))
	}
}

// List returns tasks filtered by optional state(s), kind(s), and agent_did.
// Results are ordered newest-first.
func (s *WorkflowStore) List(ctx context.Context, states, kinds []string, agentDID string, limit int) ([]domain.WorkflowTask, error) {
	return s.ListOrdered(ctx, states, kinds, agentDID, limit, false)
}

// ListOrdered is like List but allows oldest-first ordering for reconciliation.
func (s *WorkflowStore) ListOrdered(ctx context.Context, states, kinds []string, agentDID string, limit int, oldestFirst bool) ([]domain.WorkflowTask, error) {
	if limit <= 0 {
		limit = 50
	}

	var clauses []string
	var args []interface{}

	if len(states) > 0 {
		placeholders := make([]string, len(states))
		for i, st := range states {
			placeholders[i] = "?"
			args = append(args, st)
		}
		clauses = append(clauses, "state IN ("+strings.Join(placeholders, ",")+")")
	}
	if len(kinds) > 0 {
		placeholders := make([]string, len(kinds))
		for i, k := range kinds {
			placeholders[i] = "?"
			args = append(args, k)
		}
		clauses = append(clauses, "kind IN ("+strings.Join(placeholders, ",")+")")
	}
	if agentDID != "" {
		clauses = append(clauses, "agent_did = ?")
		args = append(args, agentDID)
	}

	query := `SELECT ` + taskColumns + ` FROM workflow_tasks`
	if len(clauses) > 0 {
		query += " WHERE " + strings.Join(clauses, " AND ")
	}
	order := "DESC"
	if oldestFirst {
		order = "ASC"
	}
	query += " ORDER BY created_at " + order + " LIMIT ?"
	args = append(args, limit)

	rows, err := s.db().QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return s.collectTasks(rows)
}

// ---------------------------------------------------------------------------
// Delegation lifecycle
// ---------------------------------------------------------------------------

// Claim atomically grabs the oldest queued task.
// Uses a transaction (SQLite 3.33.0 lacks RETURNING).
func (s *WorkflowStore) Claim(ctx context.Context, agentDID string, leaseSec int, runnerFilter string) (*domain.WorkflowTask, error) {
	leaseExpires := now() + int64(leaseSec)
	ts := now()
	db := s.db()

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	// Find the oldest queued task, optionally filtered by runner.
	var taskID string
	if runnerFilter != "" {
		err = tx.QueryRowContext(ctx,
			`SELECT id FROM workflow_tasks
			 WHERE state = 'queued' AND kind = 'delegation'
			   AND (requested_runner = ? OR requested_runner = '' OR requested_runner = 'auto')
			 ORDER BY created_at ASC LIMIT 1`,
			runnerFilter,
		).Scan(&taskID)
	} else {
		err = tx.QueryRowContext(ctx,
			`SELECT id FROM workflow_tasks WHERE state = 'queued' AND kind = 'delegation' ORDER BY created_at ASC LIMIT 1`,
		).Scan(&taskID)
	}
	if err == sql.ErrNoRows {
		return nil, nil // no work available
	}
	if err != nil {
		return nil, err
	}

	// Claim it.
	sessionName := "task-" + taskID
	claimResult, err := tx.ExecContext(ctx,
		`UPDATE workflow_tasks
		 SET state = 'claimed', agent_did = ?, lease_expires_at = ?, updated_at = ?,
		     session_name = ?
		 WHERE id = ? AND state = 'queued'`,
		agentDID, leaseExpires, ts, sessionName, taskID,
	)
	if err != nil {
		return nil, err
	}
	claimN, _ := claimResult.RowsAffected()
	if claimN == 0 {
		// Another claimer won the race — no work available.
		return nil, nil
	}

	// Read back the full task.
	row := tx.QueryRowContext(ctx,
		`SELECT `+taskColumns+` FROM workflow_tasks WHERE id = ?`, taskID)
	task, err := s.scanTask(row)
	if err != nil {
		return nil, err
	}

	return task, tx.Commit()
}

// MarkRunning transitions claimed → running. Clears lease. Idempotent if
// already running with the same runID.
func (s *WorkflowStore) MarkRunning(ctx context.Context, id, agentDID, runID string) error {
	result, err := s.db().ExecContext(ctx,
		`UPDATE workflow_tasks SET state = 'running', run_id = ?, lease_expires_at = 0, updated_at = ?
		 WHERE id = ? AND agent_did = ? AND state = 'claimed'`,
		runID, now(), id, agentDID,
	)
	if err != nil {
		return err
	}
	n, _ := result.RowsAffected()
	if n > 0 {
		return nil
	}

	// Check if already running with same run_id (idempotent).
	var currentStatus, currentRunID string
	err = s.db().QueryRowContext(ctx,
		`SELECT state, run_id FROM workflow_tasks WHERE id = ? AND agent_did = ?`,
		id, agentDID,
	).Scan(&currentStatus, &currentRunID)
	if err != nil {
		return fmt.Errorf("task %s not found or not owned by %s", id, agentDID)
	}
	if currentStatus == "running" && currentRunID == runID {
		return nil // idempotent
	}
	return fmt.Errorf("task %s cannot transition to running (current status: %s)", id, currentStatus)
}

// SetAssignedRunner records which runner was used for a task.
func (s *WorkflowStore) SetAssignedRunner(ctx context.Context, id, runner string) error {
	_, err := s.db().ExecContext(ctx,
		`UPDATE workflow_tasks SET assigned_runner = ?, updated_at = ? WHERE id = ?`,
		runner, now(), id,
	)
	return err
}

// Heartbeat extends the lease for a claimed or running task.
func (s *WorkflowStore) Heartbeat(ctx context.Context, id, agentDID string, leaseSec int) error {
	leaseExpires := now() + int64(leaseSec)
	result, err := s.db().ExecContext(ctx,
		`UPDATE workflow_tasks SET lease_expires_at = ?, updated_at = ?
		 WHERE id = ? AND agent_did = ? AND state IN ('claimed', 'running')`,
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

// SetRunID sets run_id on a task without ownership check.
// Used as a crash-recovery marker for service respond.
func (s *WorkflowStore) SetRunID(ctx context.Context, id, runID string) error {
	_, err := s.db().ExecContext(ctx,
		`UPDATE workflow_tasks SET run_id = ?, updated_at = ? WHERE id = ?`,
		runID, now(), id)
	return err
}

// SetInternalStash stores recovery data in the internal_stash column (not exposed via API).
func (s *WorkflowStore) SetInternalStash(ctx context.Context, id, stash string) error {
	_, err := s.db().ExecContext(ctx,
		`UPDATE workflow_tasks SET internal_stash = ?, updated_at = ? WHERE id = ?`,
		stash, now(), id)
	return err
}

// UpdateProgress stores a progress note on an active task.
func (s *WorkflowStore) UpdateProgress(ctx context.Context, id, agentDID, message string) error {
	result, err := s.db().ExecContext(ctx,
		`UPDATE workflow_tasks SET progress_note = ?, updated_at = ?
		 WHERE id = ? AND agent_did = ? AND state IN ('claimed', 'running')`,
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

// ---------------------------------------------------------------------------
// Terminal transitions — atomic UPDATE + INSERT event
// ---------------------------------------------------------------------------

// Complete marks a task as completed and emits a notification event.
// Returns (eventID, nil). eventID=0 if already terminal (idempotent no-op).
func (s *WorkflowStore) Complete(ctx context.Context, id, agentDID, resultSummary string) (int64, error) {
	return s.terminalTransition(ctx, id, agentDID,
		"completed", "result_summary", resultSummary, "", "",
		[]string{"created", "claimed", "running", "awaiting"})
}

// Fail marks a task as failed and emits a notification event.
// Returns (eventID, nil). eventID=0 if already terminal (idempotent no-op).
func (s *WorkflowStore) Fail(ctx context.Context, id, agentDID, errMsg string) (int64, error) {
	return s.terminalTransition(ctx, id, agentDID,
		"failed", "error", errMsg, "", "",
		[]string{"created", "claimed", "running", "awaiting", "pending_approval"})
}

// Cancel marks a task as cancelled and emits a notification event.
// Returns (eventID, nil). eventID=0 if already terminal (idempotent no-op).
// Cancel does not require agent_did ownership — owner or system can cancel.
func (s *WorkflowStore) Cancel(ctx context.Context, id string) (int64, error) {
	return s.terminalTransition(ctx, id, "",
		"cancelled", "", "", "", "",
		[]string{"created", "pending", "queued", "claimed", "running", "awaiting", "pending_approval", "scheduled"})
}

// CompleteWithDetails completes a task with structured result + rich event details.
// resultJSON is persisted in workflow_tasks.result for later status/history fetches.
// eventDetails is used as the workflow_event details (Brain notification).
func (s *WorkflowStore) CompleteWithDetails(ctx context.Context, id, agentDID, resultSummary, resultJSON, eventDetails string) (int64, error) {
	return s.terminalTransition(ctx, id, agentDID,
		"completed", "result_summary", resultSummary, resultJSON, eventDetails,
		[]string{"created", "claimed", "running", "awaiting"})
}

// Transition performs a generic non-terminal state transition.
// No agent_did ownership check, no event emission. Validates against ValidTransitions.
// Used for created → running after successful service.query send, and
// queued → running for approval execution claim.
func (s *WorkflowStore) Transition(ctx context.Context, id string, from, to domain.WorkflowTaskState) error {
	if !domain.IsValidTransition(from, to) {
		return fmt.Errorf("invalid transition %s → %s", from, to)
	}
	result, err := s.db().ExecContext(ctx,
		`UPDATE workflow_tasks SET state = ?, updated_at = ? WHERE id = ? AND state = ?`,
		string(to), now(), id, string(from))
	if err != nil {
		return err
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		return fmt.Errorf("task %s not in state %s", id, from)
	}
	return nil
}

// terminalTransition is the shared helper for Complete/Fail/Cancel/CompleteWithDetails.
// It atomically updates the task state and inserts a notification event.
//
// Zero-row disambiguation: if the UPDATE affects 0 rows, we prefetch the task
// to distinguish "already terminal" (idempotent no-op) from "task not found"
// or "wrong state" (error). Race condition after prefetch also returns error.
//
// agentDID ownership: when agentDID is empty, the AND agent_did = ? clause is
// skipped (non-delegation tasks completed by Brain/admin have no agent ownership).
//
// resultJSON: if non-empty, also writes structured JSON to the result column.
// eventDetailsOverride: if non-empty, used as the workflow_event details JSON
// instead of the default {"state":..., "detail":...} format.
func (s *WorkflowStore) terminalTransition(ctx context.Context, id, agentDID, newState, detailCol, detailVal, resultJSON, eventDetailsOverride string, fromStates []string) (int64, error) {
	ts := now()
	db := s.db()

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	// Build the UPDATE SET clause and args list.
	setClauses := []string{"state = ?"}
	var setArgs []interface{}
	setArgs = append(setArgs, newState)

	if detailCol != "" {
		setClauses = append(setClauses, detailCol+" = ?")
		setArgs = append(setArgs, detailVal)
	}
	if resultJSON != "" {
		setClauses = append(setClauses, "result = ?")
		setArgs = append(setArgs, resultJSON)
	}
	setClauses = append(setClauses, "updated_at = ?")
	setArgs = append(setArgs, ts)

	updateSQL := `UPDATE workflow_tasks SET ` + strings.Join(setClauses, ", ") + ` WHERE id = ?`
	var updateArgs []interface{}
	updateArgs = append(updateArgs, setArgs...)
	updateArgs = append(updateArgs, id)

	// Add agent_did filter only when provided (delegation tasks).
	// Non-delegation tasks completed by Brain/admin pass agentDID="" —
	// no ownership check needed.
	if agentDID != "" {
		updateSQL += ` AND agent_did = ?`
		updateArgs = append(updateArgs, agentDID)
	}

	// Add state filter.
	placeholders := make([]string, len(fromStates))
	for i := range fromStates {
		placeholders[i] = "?"
		updateArgs = append(updateArgs, fromStates[i])
	}
	updateSQL += ` AND state IN (` + strings.Join(placeholders, ",") + `)`

	result, err := tx.ExecContext(ctx, updateSQL, updateArgs...)
	if err != nil {
		return 0, err
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		// Zero rows affected — disambiguate the cause.
		row := tx.QueryRowContext(ctx,
			`SELECT state, agent_did FROM workflow_tasks WHERE id = ?`, id)
		var currentState, currentAgent string
		if scanErr := row.Scan(&currentState, &currentAgent); scanErr == sql.ErrNoRows {
			return 0, fmt.Errorf("task %s not found", id)
		} else if scanErr != nil {
			return 0, scanErr
		}
		// Already terminal — idempotent no-op.
		if domain.IsTerminal(domain.WorkflowTaskState(currentState)) {
			return 0, nil
		}
		// Task exists but wrong state (not in fromStates).
		stateMatch := false
		for _, fs := range fromStates {
			if currentState == fs {
				stateMatch = true
				break
			}
		}
		if !stateMatch {
			return 0, fmt.Errorf("task %s cannot transition from %s to %s", id, currentState, newState)
		}
		// State matched but agent_did didn't — ownership mismatch.
		if agentDID != "" && currentAgent != agentDID {
			return 0, fmt.Errorf("task %s not owned by %s", id, agentDID)
		}
		// State and agent matched but UPDATE still got 0 rows — race condition.
		return 0, fmt.Errorf("task %s: concurrent modification detected", id)
	}

	// Build notification event details.
	var eventJSON string
	if eventDetailsOverride != "" {
		eventJSON = eventDetailsOverride
	} else {
		detailsMap := map[string]string{"state": newState}
		if detailVal != "" {
			detailsMap["detail"] = detailVal
		}
		detailsBytes, jsonErr := json.Marshal(detailsMap)
		if jsonErr != nil {
			return 0, fmt.Errorf("marshal event details: %w", jsonErr)
		}
		eventJSON = string(detailsBytes)
	}

	res, err := tx.ExecContext(ctx,
		`INSERT INTO workflow_events (task_id, at, event_kind, needs_delivery, details)
		 VALUES (?, ?, 'notification', 1, ?)`,
		id, ts, eventJSON,
	)
	if err != nil {
		return 0, err
	}
	eventID, _ := res.LastInsertId()

	return eventID, tx.Commit()
}

// ---------------------------------------------------------------------------
// Approval bridge
// ---------------------------------------------------------------------------

// QueueByProposalID transitions pending_approval → queued. Idempotent.
func (s *WorkflowStore) QueueByProposalID(ctx context.Context, proposalID string) error {
	if proposalID == "" {
		return nil
	}
	_, err := s.db().ExecContext(ctx,
		`UPDATE workflow_tasks SET state = 'queued', updated_at = ?
		 WHERE proposal_id = ? AND state = 'pending_approval'`,
		now(), proposalID,
	)
	return err
}

// Approve transitions pending_approval → queued and emits a workflow_event
// with the full task payload in the event details (so Brain can execute without
// a separate fetch). Returns (eventID, error).
func (s *WorkflowStore) Approve(ctx context.Context, id string) (int64, error) {
	ts := now()
	db := s.db()

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	// Read task payload before transition (for event details).
	var payload, taskID string
	err = tx.QueryRowContext(ctx,
		`SELECT id, payload FROM workflow_tasks WHERE id = ? AND kind = 'approval' AND state = 'pending_approval'`, id,
	).Scan(&taskID, &payload)
	if err != nil {
		return 0, fmt.Errorf("task %s not found or not pending_approval", id)
	}

	// Transition pending_approval → queued. Reject if already expired.
	result, err := tx.ExecContext(ctx,
		`UPDATE workflow_tasks SET state = 'queued', updated_at = ?
		 WHERE id = ? AND kind = 'approval' AND state = 'pending_approval'
		   AND (expires_at IS NULL OR expires_at = 0 OR expires_at > ?)`,
		ts, id, ts)
	if err != nil {
		return 0, err
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		return 0, fmt.Errorf("task %s: concurrent modification", id)
	}

	// Build event details with task_payload for Brain execution.
	detailsMap := map[string]interface{}{
		"state":        "queued",
		"reason":       "approved",
		"task_payload": json.RawMessage(payload),
	}
	detailsBytes, _ := json.Marshal(detailsMap)

	res, err := tx.ExecContext(ctx,
		`INSERT INTO workflow_events (task_id, at, event_kind, needs_delivery, details)
		 VALUES (?, ?, 'notification', 1, ?)`,
		id, ts, string(detailsBytes))
	if err != nil {
		return 0, err
	}
	eventID, _ := res.LastInsertId()

	return eventID, tx.Commit()
}

// ClaimApprovalForExecution atomically claims a queued approval task for execution.
// queued → running with expires_at extended. Used by both /v1/service/respond and
// expireApprovalTasks — single primitive, identical semantics, no drift.
func (s *WorkflowStore) ClaimApprovalForExecution(ctx context.Context, id string, extendSec int64) error {
	ts := now()
	// Only claim if not already logically expired. Prevents late execution
	// of tasks that the sweeper hasn't cleaned up yet.
	result, err := s.db().ExecContext(ctx,
		`UPDATE workflow_tasks
		 SET state = 'running', expires_at = ?, updated_at = ?
		 WHERE id = ? AND kind = 'approval' AND state = 'queued'
		   AND (expires_at IS NULL OR expires_at = 0 OR expires_at > ?)`,
		ts+extendSec, ts, id, ts)
	if err != nil {
		return err
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		return fmt.Errorf("task %s not claimable (not queued or not approval kind)", id)
	}
	return nil
}

// ListExpiringApprovalTasks returns approval tasks in queued or pending_approval
// state with past expires_at. Used by the sweeper to send "unavailable" before failing.
// Includes pending_approval because the common timeout path is "never approved."
func (s *WorkflowStore) ListExpiringApprovalTasks(ctx context.Context) ([]domain.WorkflowTask, error) {
	ts := now()
	rows, err := s.db().QueryContext(ctx,
		`SELECT `+taskColumns+` FROM workflow_tasks
		 WHERE kind = 'approval' AND state IN ('queued', 'pending_approval')
		   AND expires_at > 0 AND expires_at < ?`,
		ts)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return s.collectTasks(rows)
}

// ---------------------------------------------------------------------------
// Sweepers
// ---------------------------------------------------------------------------

// ExpireTasks fails tasks whose expires_at has passed.
// Each task is expired in its own transaction: UPDATE state + INSERT event.
// Returns the tasks that were expired (pre-transition snapshot for cleanup).
func (s *WorkflowStore) ExpireTasks(ctx context.Context) ([]domain.WorkflowTask, error) {
	ts := now()
	db := s.db()

	// Read candidates — tasks with a non-zero expires_at that have passed,
	// and are not already in a terminal state.
	rows, err := db.QueryContext(ctx,
		`SELECT `+taskColumns+` FROM workflow_tasks
		 WHERE expires_at > 0 AND expires_at < ?
		   AND state NOT IN ('completed','failed','cancelled','recorded')`,
		ts,
	)
	if err != nil {
		return nil, err
	}
	var candidates []domain.WorkflowTask
	for rows.Next() {
		t, scanErr := s.scanTaskRow(rows)
		if scanErr != nil {
			rows.Close()
			return nil, scanErr
		}
		candidates = append(candidates, *t)
	}
	rows.Close()

	// Expire each individually in its own transaction.
	var expired []domain.WorkflowTask
	for _, t := range candidates {
		tx, txErr := db.BeginTx(ctx, nil)
		if txErr != nil {
			slog.Warn("workflow.expire_tasks.begin_tx_failed", "task_id", t.ID, "error", txErr)
			continue // best-effort per task
		}

		// Build notification event details — kind-aware for service_query.
		detailsMap := map[string]string{"state": "failed", "reason": "expired", "task_id": t.ID}
		if t.Kind == string(domain.WFKindServiceQuery) && t.Payload != "" {
			var payload map[string]interface{}
			if json.Unmarshal([]byte(t.Payload), &payload) == nil {
				if sn, ok := payload["service_name"].(string); ok {
					detailsMap["service_name"] = sn
				}
				if cap, ok := payload["capability"].(string); ok {
					detailsMap["capability"] = cap
				}
				detailsMap["response_status"] = "expired"
			}
		}
		detailsBytes, _ := json.Marshal(detailsMap)

		// Issue #13: also persist structured result for service_query expiry.
		var resultUpdateSQL string
		var resultUpdateArgs []interface{}
		if t.Kind == string(domain.WFKindServiceQuery) {
			resultUpdateSQL = `UPDATE workflow_tasks SET state = 'failed', error = 'expired', result = ?, updated_at = ?
				WHERE id = ? AND expires_at = ? AND state NOT IN ('completed','failed','cancelled','recorded')`
			resultUpdateArgs = []interface{}{string(detailsBytes), ts, t.ID, t.ExpiresAt}
		} else {
			resultUpdateSQL = `UPDATE workflow_tasks SET state = 'failed', error = 'expired', updated_at = ?
				WHERE id = ? AND expires_at = ? AND state NOT IN ('completed','failed','cancelled','recorded')`
			resultUpdateArgs = []interface{}{ts, t.ID, t.ExpiresAt}
		}

		result, updErr := tx.ExecContext(ctx, resultUpdateSQL, resultUpdateArgs...)
		if updErr != nil {
			slog.Warn("workflow.expire_tasks.update_failed", "task_id", t.ID, "error", updErr)
			tx.Rollback()
			continue
		}
		n, _ := result.RowsAffected()
		if n == 0 {
			tx.Rollback()
			continue // concurrent transition — skip
		}
		_, evtErr := tx.ExecContext(ctx,
			`INSERT INTO workflow_events (task_id, at, event_kind, needs_delivery, details)
			 VALUES (?, ?, 'notification', 1, ?)`,
			t.ID, ts, string(detailsBytes),
		)
		if evtErr != nil {
			slog.Warn("workflow.expire_tasks.event_insert_failed", "task_id", t.ID, "error", evtErr)
			tx.Rollback()
			continue
		}

		if commitErr := tx.Commit(); commitErr != nil {
			slog.Warn("workflow.expire_tasks.commit_failed", "task_id", t.ID, "error", commitErr)
		} else {
			expired = append(expired, t)
		}
	}

	return expired, nil
}

// ExpireLeases requeues tasks with expired leases.
// Each task is handled in its own transaction: UPDATE state + INSERT event.
// Returns the pre-transition task snapshots (with agent_did/session_name) for
// session cleanup.
//
// Race safety: the per-ID UPDATE matches on lease_expires_at so a concurrent
// heartbeat that extended the lease causes the UPDATE to be a no-op.
func (s *WorkflowStore) ExpireLeases(ctx context.Context) ([]domain.WorkflowTask, error) {
	ts := now()
	db := s.db()

	// Read candidates.
	rows, err := db.QueryContext(ctx,
		`SELECT `+taskColumns+` FROM workflow_tasks
		 WHERE state = 'claimed' AND lease_expires_at > 0 AND lease_expires_at < ?`,
		ts,
	)
	if err != nil {
		return nil, err
	}

	var candidates []domain.WorkflowTask
	for rows.Next() {
		t, scanErr := s.scanTaskRow(rows)
		if scanErr != nil {
			rows.Close()
			return nil, scanErr
		}
		candidates = append(candidates, *t)
	}
	rows.Close()

	// Requeue each individually, matching on ID + lease_expires_at to avoid
	// racing with concurrent heartbeats.
	var expired []domain.WorkflowTask
	for _, t := range candidates {
		tx, txErr := db.BeginTx(ctx, nil)
		if txErr != nil {
			slog.Warn("workflow.expire_leases.begin_tx_failed", "task_id", t.ID, "error", txErr)
			continue // best-effort per task
		}

		result, updErr := tx.ExecContext(ctx,
			`UPDATE workflow_tasks
			 SET state = 'queued', agent_did = '', session_name = '', lease_expires_at = 0,
			     progress_note = '', run_id = '', updated_at = ?
			 WHERE id = ? AND lease_expires_at = ? AND state IN ('claimed', 'running')`,
			ts, t.ID, t.LeaseExpiresAt,
		)
		if updErr != nil {
			slog.Warn("workflow.expire_leases.update_failed", "task_id", t.ID, "error", updErr)
			tx.Rollback()
			continue
		}
		n, _ := result.RowsAffected()
		if n == 0 {
			tx.Rollback()
			continue // concurrent heartbeat extended the lease
		}

		// Build notification event details using json.Marshal.
		detailsMap := map[string]string{
			"state":      "queued",
			"reason":     "lease_expired",
			"task_id":    t.ID,
			"prev_agent": t.AgentDID,
		}
		detailsBytes, _ := json.Marshal(detailsMap)
		_, evtErr := tx.ExecContext(ctx,
			`INSERT INTO workflow_events (task_id, at, event_kind, needs_delivery, details)
			 VALUES (?, ?, 'notification', 1, ?)`,
			t.ID, ts, string(detailsBytes),
		)
		if evtErr != nil {
			slog.Warn("workflow.expire_leases.event_insert_failed", "task_id", t.ID, "error", evtErr)
			tx.Rollback()
			continue
		}

		if commitErr := tx.Commit(); commitErr != nil {
			slog.Warn("workflow.expire_leases.commit_failed", "task_id", t.ID, "error", commitErr)
		} else {
			expired = append(expired, t)
		}
	}

	return expired, nil
}

// ---------------------------------------------------------------------------
// Events + delivery tracking
// ---------------------------------------------------------------------------

// AppendEvent inserts a new event for a task.
func (s *WorkflowStore) AppendEvent(ctx context.Context, taskID, eventKind, details string, needsDelivery bool) (int64, error) {
	ts := now()
	nd := 0
	if needsDelivery {
		nd = 1
	}
	res, err := s.db().ExecContext(ctx,
		`INSERT INTO workflow_events (task_id, at, event_kind, needs_delivery, details)
		 VALUES (?, ?, ?, ?, ?)`,
		taskID, ts, eventKind, nd, details,
	)
	if err != nil {
		return 0, err
	}
	eventID, _ := res.LastInsertId()
	return eventID, nil
}

// ReserveEventForDelivery atomically marks an event as in-delivery for
// reserveSec seconds. Returns (true, nil) if reserved, (false, nil) if
// already reserved or not eligible.
func (s *WorkflowStore) ReserveEventForDelivery(ctx context.Context, eventID int64, reserveSec int) (bool, error) {
	ts := now()
	until := ts + int64(reserveSec)
	result, err := s.db().ExecContext(ctx,
		`UPDATE workflow_events
		 SET delivering_until = ?
		 WHERE event_id = ?
		   AND needs_delivery = 1
		   AND acknowledged_at IS NULL
		   AND delivery_failed = 0
		   AND (delivering_until IS NULL OR delivering_until < ?)`,
		until, eventID, ts,
	)
	if err != nil {
		return false, err
	}
	n, _ := result.RowsAffected()
	return n > 0, nil
}

// RecordDeliveryAttempt records the outcome of a delivery attempt.
// Always increments delivery_attempts and clears delivering_until.
//
// On success: sets delivered_at.
// On failure: sets next_delivery_at with backoff (30s, 120s, 300s).
// After 3 total attempts with no ACK: sets delivery_failed=1.
func (s *WorkflowStore) RecordDeliveryAttempt(ctx context.Context, eventID int64, succeeded bool) error {
	ts := now()
	db := s.db()

	if succeeded {
		_, err := db.ExecContext(ctx,
			`UPDATE workflow_events
			 SET delivery_attempts = delivery_attempts + 1,
			     delivering_until = NULL,
			     delivered_at = ?
			 WHERE event_id = ?`,
			ts, eventID,
		)
		if err != nil {
			return err
		}
	} else {
		// Failure path: read current attempt count to compute backoff.
		var attempts int
		err := db.QueryRowContext(ctx,
			`SELECT delivery_attempts FROM workflow_events WHERE event_id = ?`, eventID,
		).Scan(&attempts)
		if err != nil {
			return fmt.Errorf("event %d not found: %w", eventID, err)
		}

		newAttempts := attempts + 1

		// Backoff schedule: 30s, 120s, 300s (based on new attempt count).
		var backoffSec int64
		switch {
		case newAttempts == 1:
			backoffSec = 30
		case newAttempts == 2:
			backoffSec = 120
		default:
			backoffSec = 300
		}
		nextDelivery := ts + backoffSec

		_, err = db.ExecContext(ctx,
			`UPDATE workflow_events
			 SET delivery_attempts = ?,
			     delivering_until = NULL,
			     next_delivery_at = ?
			 WHERE event_id = ?`,
			newAttempts, nextDelivery, eventID,
		)
		if err != nil {
			return err
		}
	}

	// After incrementing delivery_attempts (both success and failure),
	// mark delivery_failed if we've hit 3 attempts with no ACK.
	_, err := db.ExecContext(ctx,
		`UPDATE workflow_events SET delivery_failed = 1
		 WHERE event_id = ? AND delivery_attempts >= 3 AND acknowledged_at IS NULL`,
		eventID,
	)
	return err
}

// MarkEventAcknowledged sets acknowledged_at and clears delivery_failed
// (late ACK recovery). Returns an error if the event does not exist.
func (s *WorkflowStore) MarkEventAcknowledged(ctx context.Context, eventID int64) error {
	ts := now()
	result, err := s.db().ExecContext(ctx,
		`UPDATE workflow_events
		 SET acknowledged_at = ?, delivery_failed = 0
		 WHERE event_id = ?`,
		ts, eventID,
	)
	if err != nil {
		return err
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		return fmt.Errorf("event %d not found", eventID)
	}
	return nil
}

// ListDeliverableEvents returns events that are eligible for delivery:
// needs_delivery=1, not acknowledged, not failed, under attempt limit,
// reservation expired, and backoff elapsed.
func (s *WorkflowStore) ListDeliverableEvents(ctx context.Context, limit int) ([]domain.WorkflowEvent, error) {
	if limit <= 0 {
		limit = 50
	}
	ts := now()
	rows, err := s.db().QueryContext(ctx,
		`SELECT `+eventColumns+`
		 FROM workflow_events
		 WHERE needs_delivery = 1
		   AND acknowledged_at IS NULL
		   AND delivery_failed = 0
		   AND delivery_attempts < 3
		   AND (delivering_until IS NULL OR delivering_until < ?)
		   AND (next_delivery_at IS NULL OR next_delivery_at <= ?)
		 ORDER BY next_delivery_at ASC
		 LIMIT ?`,
		ts, ts, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return s.collectEvents(rows)
}

// ListStashedServiceQueryTasks returns service_query tasks with stashed responses
// in internal_stash that need recovery. No limit — processes all.
func (s *WorkflowStore) ListStashedServiceQueryTasks(ctx context.Context) ([]domain.WorkflowTask, error) {
	rows, err := s.db().QueryContext(ctx,
		`SELECT `+taskColumns+` FROM workflow_tasks
		 WHERE kind = 'service_query'
		   AND state IN ('created', 'running')
		   AND internal_stash IS NOT NULL AND internal_stash != ''
		 ORDER BY created_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return s.collectTasks(rows)
}

// ListDeliverableEventsForTask returns deliverable events for a specific task.
// Same eligibility predicate as ListDeliverableEvents but scoped to one task_id.
func (s *WorkflowStore) ListDeliverableEventsForTask(ctx context.Context, taskID string, limit int) ([]domain.WorkflowEvent, error) {
	if limit <= 0 {
		limit = 10
	}
	ts := now()
	rows, err := s.db().QueryContext(ctx,
		`SELECT `+eventColumns+`
		 FROM workflow_events
		 WHERE task_id = ?
		   AND needs_delivery = 1
		   AND acknowledged_at IS NULL
		   AND delivery_failed = 0
		   AND delivery_attempts < 3
		   AND (delivering_until IS NULL OR delivering_until < ?)
		   AND (next_delivery_at IS NULL OR next_delivery_at <= ?)
		 ORDER BY next_delivery_at ASC
		 LIMIT ?`,
		taskID, ts, ts, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return s.collectEvents(rows)
}

// ListEvents returns all events for a task (audit/history), ordered oldest
// first.
func (s *WorkflowStore) ListEvents(ctx context.Context, taskID string) ([]domain.WorkflowEvent, error) {
	rows, err := s.db().QueryContext(ctx,
		`SELECT `+eventColumns+` FROM workflow_events WHERE task_id = ? ORDER BY at ASC`,
		taskID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return s.collectEvents(rows)
}

// ---------------------------------------------------------------------------
// Scan helpers — tasks
// ---------------------------------------------------------------------------

// scanInto scans a row's task columns into nullable holders, then copies to a WorkflowTask.
// Handles NULL columns (idempotency_key, correlation_id, parent_id, proposal_id,
// result, expires_at, next_run_at, recurrence, lease_expires_at) that Create()
// may store as NULL (e.g. empty idempotency_key normalized to NULL).
func scanInto(scanFn func(dest ...interface{}) error) (*domain.WorkflowTask, error) {
	var t domain.WorkflowTask
	var (
		correlationID  sql.NullString
		parentID       sql.NullString
		proposalID     sql.NullString
		result         sql.NullString
		idempotencyKey sql.NullString
		recurrence     sql.NullString
		internalStash  sql.NullString
		expiresAt      sql.NullInt64
		nextRunAt      sql.NullInt64
		leaseExpiresAt sql.NullInt64
	)
	err := scanFn(
		&t.ID, &t.Kind, &t.Status, &correlationID, &parentID,
		&proposalID, &t.Priority, &t.Description, &t.Payload,
		&result, &t.ResultSummary, &t.Policy, &t.Error,
		&t.RequestedRunner, &t.AssignedRunner, &t.AgentDID, &t.RunID,
		&t.ProgressNote, &leaseExpiresAt, &t.Origin, &t.SessionName,
		&idempotencyKey, &expiresAt, &nextRunAt, &recurrence,
		&internalStash, &t.CreatedAt, &t.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	t.CorrelationID = correlationID.String
	t.ParentID = parentID.String
	t.ProposalID = proposalID.String
	t.Result = result.String
	t.IdempotencyKey = idempotencyKey.String
	t.Recurrence = recurrence.String
	t.InternalStash = internalStash.String
	t.ExpiresAt = expiresAt.Int64
	t.NextRunAt = nextRunAt.Int64
	t.LeaseExpiresAt = leaseExpiresAt.Int64
	return &t, nil
}

// scanTask scans a single *sql.Row into a WorkflowTask.
// Returns (nil, nil) on sql.ErrNoRows for Get-style queries.
func (s *WorkflowStore) scanTask(row *sql.Row) (*domain.WorkflowTask, error) {
	t, err := scanInto(row.Scan)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return t, err
}

// scanTaskRow scans a single *sql.Rows row into a WorkflowTask.
func (s *WorkflowStore) scanTaskRow(rows *sql.Rows) (*domain.WorkflowTask, error) {
	return scanInto(rows.Scan)
}

// collectTasks drains rows into a slice of WorkflowTask.
func (s *WorkflowStore) collectTasks(rows *sql.Rows) ([]domain.WorkflowTask, error) {
	var tasks []domain.WorkflowTask
	for rows.Next() {
		t, err := s.scanTaskRow(rows)
		if err != nil {
			return nil, err
		}
		tasks = append(tasks, *t)
	}
	return tasks, rows.Err()
}

// ---------------------------------------------------------------------------
// Scan helpers — events
// ---------------------------------------------------------------------------

// scanEvent scans a single *sql.Rows row into a WorkflowEvent.
// SQLite stores booleans as INTEGER 0/1 and nullable int64 as NULL.
func (s *WorkflowStore) scanEvent(rows *sql.Rows) (*domain.WorkflowEvent, error) {
	var e domain.WorkflowEvent
	var needsDelivery int
	var deliveryFailed int
	var nextDeliveryAt sql.NullInt64
	var deliveringUntil sql.NullInt64
	var deliveredAt sql.NullInt64
	var acknowledgedAt sql.NullInt64

	err := rows.Scan(
		&e.EventID, &e.TaskID, &e.At, &e.EventKind, &needsDelivery,
		&e.DeliveryAttempts, &nextDeliveryAt, &deliveringUntil,
		&deliveredAt, &acknowledgedAt, &deliveryFailed, &e.Details,
	)
	if err != nil {
		return nil, err
	}
	e.NeedsDelivery = needsDelivery != 0
	e.DeliveryFailed = deliveryFailed != 0
	if nextDeliveryAt.Valid {
		e.NextDeliveryAt = nextDeliveryAt.Int64
	}
	if deliveringUntil.Valid {
		e.DeliveringUntil = deliveringUntil.Int64
	}
	if deliveredAt.Valid {
		e.DeliveredAt = deliveredAt.Int64
	}
	if acknowledgedAt.Valid {
		e.AcknowledgedAt = acknowledgedAt.Int64
	}
	return &e, nil
}

// collectEvents drains rows into a slice of WorkflowEvent.
func (s *WorkflowStore) collectEvents(rows *sql.Rows) ([]domain.WorkflowEvent, error) {
	var events []domain.WorkflowEvent
	for rows.Next() {
		e, err := s.scanEvent(rows)
		if err != nil {
			return nil, err
		}
		events = append(events, *e)
	}
	return events, rows.Err()
}
