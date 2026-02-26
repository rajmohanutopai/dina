package port

import (
	"context"

	"github.com/anthropics/dina/core/internal/domain"
)

// TaskQueue provides persistent task queuing with priority ordering.
type TaskQueue interface {
	Enqueue(ctx context.Context, task domain.Task) (string, error)
	Dequeue(ctx context.Context) (*domain.Task, error)
	Acknowledge(ctx context.Context, taskID string) (*domain.Task, error)
	Complete(ctx context.Context, taskID string) error
	Fail(ctx context.Context, taskID, reason string) error
	Retry(ctx context.Context, taskID string) error
	Cancel(ctx context.Context, taskID string) error
	RecoverRunning(ctx context.Context) (int, error)
	GetByID(ctx context.Context, taskID string) (*domain.Task, error)
	SetMaxRetries(n int)
}

// TaskWorker processes tasks from the queue.
type TaskWorker interface {
	Process(ctx context.Context, task domain.Task) error
}

// WatchdogRunner scans for timed-out tasks and resets them.
type WatchdogRunner interface {
	ScanTimedOut(ctx context.Context) ([]domain.Task, error)
	ResetTask(ctx context.Context, taskID string) error
}

// ReminderScheduler manages scheduled reminders.
type ReminderScheduler interface {
	StoreReminder(ctx context.Context, r domain.Reminder) (string, error)
	NextPending(ctx context.Context) (*domain.Reminder, error)
	MarkFired(ctx context.Context, reminderID string) error
}
