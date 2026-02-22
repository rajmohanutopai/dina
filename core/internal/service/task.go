package service

import (
	"context"
	"fmt"

	"github.com/anthropics/dina/core/internal/domain"
	"github.com/anthropics/dina/core/internal/port"
)

// TaskService coordinates task submission, processing, and timeout recovery.
// It dequeues tasks from the persistent queue and dispatches them to the
// brain sidecar for execution, with watchdog-based timeout scanning.
type TaskService struct {
	queue    port.TaskQueue
	watchdog port.WatchdogRunner
	brain    port.BrainClient
	clock    port.Clock
}

// NewTaskService constructs a TaskService with all required dependencies.
func NewTaskService(
	queue port.TaskQueue,
	watchdog port.WatchdogRunner,
	brain port.BrainClient,
	clock port.Clock,
) *TaskService {
	return &TaskService{
		queue:    queue,
		watchdog: watchdog,
		brain:    brain,
		clock:    clock,
	}
}

// Submit enqueues a new task into the persistent task queue. The task is
// assigned a timestamp and placed in pending status for later processing.
func (s *TaskService) Submit(ctx context.Context, task domain.Task) (string, error) {
	if task.Type == "" {
		return "", fmt.Errorf("task: %w: task type is required", domain.ErrInvalidInput)
	}

	// Set the timeout relative to the current clock if not already set.
	if task.TimeoutAt == 0 {
		// Default timeout: 5 minutes from now.
		task.TimeoutAt = s.clock.Now().Add(5 * 60 * 1e9).Unix()
	}

	task.Status = domain.TaskPending

	id, err := s.queue.Enqueue(ctx, task)
	if err != nil {
		return "", fmt.Errorf("task: enqueue: %w", err)
	}

	return id, nil
}

// ProcessNext dequeues the next pending task and dispatches it to the brain
// sidecar for execution. If the brain returns an error, the task is marked
// as failed with the error reason. Returns the processed task or nil if the
// queue is empty.
func (s *TaskService) ProcessNext(ctx context.Context) (*domain.Task, error) {
	task, err := s.queue.Dequeue(ctx)
	if err != nil {
		return nil, fmt.Errorf("task: dequeue: %w", err)
	}

	// Queue is empty.
	if task == nil {
		return nil, nil
	}

	// Build the task event for the brain.
	event := domain.TaskEvent{
		TaskID:  task.ID,
		Type:    task.Type,
		Payload: map[string]interface{}{"data": string(task.Payload)},
	}

	// Dispatch to the brain sidecar.
	if err := s.brain.Process(ctx, event); err != nil {
		// Mark the task as failed but do not lose the error.
		failErr := s.queue.Fail(ctx, task.ID, err.Error())
		if failErr != nil {
			return task, fmt.Errorf("task: mark failed after brain error: %w (brain error: %v)", failErr, err)
		}
		return task, fmt.Errorf("task: brain processing: %w", err)
	}

	// Mark the task as completed.
	if err := s.queue.Complete(ctx, task.ID); err != nil {
		return task, fmt.Errorf("task: mark complete: %w", err)
	}

	return task, nil
}

// RunWatchdog scans for timed-out tasks and resets them for retry. Tasks that
// have exceeded their timeout are returned to pending status so they can be
// reprocessed. Returns the number of tasks that were reset.
func (s *TaskService) RunWatchdog(ctx context.Context) (int, error) {
	timedOut, err := s.watchdog.ScanTimedOut(ctx)
	if err != nil {
		return 0, fmt.Errorf("task: scan timed out: %w", err)
	}

	resetCount := 0
	for _, task := range timedOut {
		select {
		case <-ctx.Done():
			return resetCount, ctx.Err()
		default:
		}

		if err := s.watchdog.ResetTask(ctx, task.ID); err != nil {
			// Log but continue processing remaining tasks.
			continue
		}
		resetCount++
	}

	return resetCount, nil
}
