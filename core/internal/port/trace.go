package port

import "context"

// TraceEvent represents a single step in a request trace.
type TraceEvent struct {
	ID        int64  `json:"id"`
	ReqID     string `json:"req_id"`
	TsMs      int64  `json:"ts_ms"`
	Step      string `json:"step"`
	Component string `json:"component"`
	Detail    string `json:"detail"` // JSON object string
}

// TraceStore persists request trace events for debugging.
// Events are ephemeral — auto-purged after a retention period.
type TraceStore interface {
	// Append writes a trace event. Called from middleware/handlers.
	Append(reqID, step, component, detail string) error

	// Query returns all trace events for a request ID, ordered by (ts_ms, id).
	Query(ctx context.Context, reqID string) ([]TraceEvent, error)

	// Purge deletes trace events older than maxAgeSeconds.
	Purge(ctx context.Context, maxAgeSeconds int64) (int, error)
}
