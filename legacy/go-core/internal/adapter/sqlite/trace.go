package sqlite

import (
	"context"
	"database/sql"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/port"
)

// TraceStore implements port.TraceStore using identity.sqlite.
type TraceStore struct {
	db *sql.DB
}

// NewTraceStore returns a TraceStore backed by the given database connection.
// The request_trace table must already exist (created by pool.go migration).
func NewTraceStore(db *sql.DB) *TraceStore {
	return &TraceStore{db: db}
}

// Append writes a trace event with millisecond timestamp.
func (s *TraceStore) Append(reqID, step, component, detail string) error {
	if s.db == nil {
		return nil
	}
	tsMs := time.Now().UnixMilli()
	_, err := s.db.Exec(
		`INSERT INTO request_trace (req_id, ts_ms, step, component, detail)
		 VALUES (?, ?, ?, ?, ?)`,
		reqID, tsMs, step, component, detail,
	)
	return err
}

// Query returns all trace events for a request ID, ordered by (ts_ms, id).
func (s *TraceStore) Query(ctx context.Context, reqID string) ([]port.TraceEvent, error) {
	if s.db == nil {
		return nil, nil
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, req_id, ts_ms, step, component, detail
		 FROM request_trace
		 WHERE req_id = ?
		 ORDER BY ts_ms ASC, id ASC`,
		reqID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var events []port.TraceEvent
	for rows.Next() {
		var e port.TraceEvent
		if err := rows.Scan(&e.ID, &e.ReqID, &e.TsMs, &e.Step, &e.Component, &e.Detail); err != nil {
			return nil, err
		}
		events = append(events, e)
	}
	return events, rows.Err()
}

// Purge deletes trace events older than maxAgeSeconds.
func (s *TraceStore) Purge(ctx context.Context, maxAgeSeconds int64) (int, error) {
	if s.db == nil {
		return 0, nil
	}
	cutoffMs := time.Now().Add(-time.Duration(maxAgeSeconds) * time.Second).UnixMilli()
	result, err := s.db.ExecContext(ctx,
		`DELETE FROM request_trace WHERE ts_ms < ?`, cutoffMs,
	)
	if err != nil {
		return 0, err
	}
	n, _ := result.RowsAffected()
	return int(n), nil
}
