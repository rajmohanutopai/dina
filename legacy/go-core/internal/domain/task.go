package domain

// TaskStatus enumerates the lifecycle states of a queued task.
type TaskStatus string

const (
	TaskPending   TaskStatus = "pending"
	TaskRunning   TaskStatus = "running"
	TaskCompleted TaskStatus = "completed"
	TaskFailed    TaskStatus = "failed"
	TaskDead      TaskStatus = "dead"
	TaskCancelled TaskStatus = "cancelled"
)

// Task represents an async task in the persistent task queue.
type Task struct {
	ID        string
	Type      string
	Priority  int
	Payload   []byte
	Status    TaskStatus
	Retries   int
	Error      string
	TimeoutAt  int64
	NextRetry  int64 // Unix timestamp for next retry (exponential backoff)
	MaxRetries int   // Maximum retries before dead letter (default 5)
}

// Reminder represents a scheduled reminder stored in the task queue.
type Reminder struct {
	ID           string `json:"id"`
	Type         string `json:"type"`
	Message      string `json:"message"`
	TriggerAt    int64  `json:"trigger_at"`
	Fired        bool   `json:"fired"`
	Metadata     string `json:"metadata"`       // JSON blob (legacy compat)
	SourceItemID string `json:"source_item_id"` // vault item that created this reminder
	Source       string `json:"source"`          // gmail, calendar, etc.
	Persona      string `json:"persona"`         // which persona vault the source lives in
	Timezone     string `json:"timezone"`
	Kind         string `json:"kind"`            // payment_due, appointment, birthday
	Status       string `json:"status"`          // pending, done, dismissed
}
