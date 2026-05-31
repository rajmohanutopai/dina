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

// Compile-time interface check.
var _ port.ReminderScheduler = (*SQLiteReminderScheduler)(nil)

// SQLiteReminderScheduler implements port.ReminderScheduler using the reminders
// table in the identity SQLite database.
type SQLiteReminderScheduler struct {
	pool *Pool
}

// NewSQLiteReminderScheduler returns a persistent reminder scheduler backed by
// identity.sqlite.
func NewSQLiteReminderScheduler(pool *Pool) *SQLiteReminderScheduler {
	return &SQLiteReminderScheduler{pool: pool}
}

func (s *SQLiteReminderScheduler) db() *sql.DB {
	return s.pool.DB("identity")
}

// StoreReminder inserts a reminder. Dedup is enforced via a unique index on
// (source_item_id, kind, due_at, persona) — ON CONFLICT DO NOTHING prevents
// duplicates from connectors that re-sync the same calendar event.
// Returns the reminder ID (or empty string if deduped).
func (s *SQLiteReminderScheduler) StoreReminder(ctx context.Context, r domain.Reminder) (string, error) {
	db := s.db()
	if db == nil {
		return "", fmt.Errorf("sqlite reminders: identity database not open")
	}

	if r.ID == "" {
		id, err := reminderID()
		if err != nil {
			return "", fmt.Errorf("sqlite reminders: generate id: %w", err)
		}
		r.ID = id
	}

	now := time.Now().Unix()
	if r.Status == "" {
		r.Status = "pending"
	}

	// Type maps to the 'recurring' column (recurrence pattern: '', 'daily', 'weekly', 'monthly').
	// Kind is the event type (payment_due, appointment, birthday) — stored in the 'kind' column.
	recurring := r.Type
	if recurring != "" && recurring != "daily" && recurring != "weekly" && recurring != "monthly" {
		recurring = "" // Only valid recurrence patterns allowed.
	}

	res, err := db.ExecContext(ctx,
		`INSERT INTO reminders (id, message, due_at, recurring, completed, created_at,
		                        source_item_id, source, persona, timezone, kind, status)
		 VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT DO NOTHING`,
		r.ID, r.Message, r.TriggerAt, recurring, now,
		r.SourceItemID, r.Source, r.Persona, r.Timezone, r.Kind, r.Status,
	)
	if err != nil {
		return "", fmt.Errorf("sqlite reminders: store: %w", err)
	}

	// If the row was deduped (conflict), RowsAffected == 0.
	n, _ := res.RowsAffected()
	if n == 0 {
		return "", nil
	}
	return r.ID, nil
}

// NextPending returns the earliest unfired reminder with status='pending'.
func (s *SQLiteReminderScheduler) NextPending(ctx context.Context) (*domain.Reminder, error) {
	db := s.db()
	if db == nil {
		return nil, fmt.Errorf("sqlite reminders: identity database not open")
	}

	row := db.QueryRowContext(ctx,
		`SELECT id, message, due_at, recurring, completed, created_at,
		        COALESCE(source_item_id, ''), COALESCE(source, ''),
		        COALESCE(persona, ''), COALESCE(timezone, ''),
		        COALESCE(kind, ''), COALESCE(status, 'pending')
		 FROM reminders
		 WHERE completed = 0 AND COALESCE(status, 'pending') = 'pending'
		 ORDER BY due_at ASC
		 LIMIT 1`,
	)

	r, err := scanReminder(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("sqlite reminders: next pending: %w", err)
	}
	return r, nil
}

// MarkFired marks a reminder as fired (completed=1, status='done').
func (s *SQLiteReminderScheduler) MarkFired(ctx context.Context, reminderID string) error {
	db := s.db()
	if db == nil {
		return fmt.Errorf("sqlite reminders: identity database not open")
	}

	res, err := db.ExecContext(ctx,
		`UPDATE reminders SET completed = 1, status = 'done' WHERE id = ?`,
		reminderID,
	)
	if err != nil {
		return fmt.Errorf("sqlite reminders: mark fired: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("sqlite reminders: reminder %q not found", reminderID)
	}
	return nil
}

// DeleteReminder removes a reminder by ID.
func (s *SQLiteReminderScheduler) DeleteReminder(ctx context.Context, id string) error {
	db := s.db()
	if db == nil {
		return fmt.Errorf("sqlite reminders: identity database not open")
	}
	res, err := db.ExecContext(ctx, `DELETE FROM reminders WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("sqlite reminders: delete: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("sqlite reminders: reminder %q not found", id)
	}
	return nil
}

// ListPending returns all unfired reminders with status='pending', ordered by due_at.
func (s *SQLiteReminderScheduler) ListPending(ctx context.Context) ([]domain.Reminder, error) {
	db := s.db()
	if db == nil {
		return nil, fmt.Errorf("sqlite reminders: identity database not open")
	}

	rows, err := db.QueryContext(ctx,
		`SELECT id, message, due_at, recurring, completed, created_at,
		        COALESCE(source_item_id, ''), COALESCE(source, ''),
		        COALESCE(persona, ''), COALESCE(timezone, ''),
		        COALESCE(kind, ''), COALESCE(status, 'pending')
		 FROM reminders
		 WHERE completed = 0 AND COALESCE(status, 'pending') = 'pending'
		 ORDER BY due_at ASC`,
	)
	if err != nil {
		return nil, fmt.Errorf("sqlite reminders: list pending: %w", err)
	}
	defer rows.Close()

	var reminders []domain.Reminder
	for rows.Next() {
		var r domain.Reminder
		var recurring string
		var completed int
		var createdAt int64
		if err := rows.Scan(
			&r.ID, &r.Message, &r.TriggerAt, &recurring, &completed, &createdAt,
			&r.SourceItemID, &r.Source, &r.Persona, &r.Timezone, &r.Kind, &r.Status,
		); err != nil {
			return nil, fmt.Errorf("sqlite reminders: scan: %w", err)
		}
		r.Type = recurring
		r.Fired = completed != 0
		reminders = append(reminders, r)
	}
	return reminders, rows.Err()
}

// GetByID retrieves a single reminder by its ID.
func (s *SQLiteReminderScheduler) GetByID(ctx context.Context, id string) (*domain.Reminder, error) {
	db := s.db()
	if db == nil {
		return nil, fmt.Errorf("sqlite reminders: identity database not open")
	}

	row := db.QueryRowContext(ctx,
		`SELECT id, message, due_at, recurring, completed, created_at,
		        COALESCE(source_item_id, ''), COALESCE(source, ''),
		        COALESCE(persona, ''), COALESCE(timezone, ''),
		        COALESCE(kind, ''), COALESCE(status, 'pending')
		 FROM reminders
		 WHERE id = ?`,
		id,
	)

	r, err := scanReminder(row)
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("sqlite reminders: reminder %q not found", id)
	}
	if err != nil {
		return nil, fmt.Errorf("sqlite reminders: get by id: %w", err)
	}
	return r, nil
}

// scanReminder scans a single row into a domain.Reminder.
func scanReminder(row *sql.Row) (*domain.Reminder, error) {
	var r domain.Reminder
	var recurring string
	var completed int
	var createdAt int64
	err := row.Scan(
		&r.ID, &r.Message, &r.TriggerAt, &recurring, &completed, &createdAt,
		&r.SourceItemID, &r.Source, &r.Persona, &r.Timezone, &r.Kind, &r.Status,
	)
	if err != nil {
		return nil, err
	}
	r.Type = recurring
	r.Fired = completed != 0
	return &r, nil
}

// reminderID generates a unique reminder ID.
func reminderID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return "rem-" + hex.EncodeToString(b), nil
}
