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
	ID        string
	Type      string
	Message   string
	TriggerAt int64
	Fired     bool
}
