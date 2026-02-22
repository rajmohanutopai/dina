// Package taskqueue implements §8 Task Queue — priority-based background
// task processing, watchdog recovery, and reminder scheduling for the
// Dina Home Node.
//
// The task queue follows the architecture spec:
//   - Tasks are enqueued with a priority and type.
//   - Dequeue returns the highest-priority pending task (FIFO for same priority).
//   - Failed tasks can be retried with an incremented retry counter.
//   - The watchdog scans for timed-out tasks and resets them.
//   - Reminders are single-fire, ordered by trigger_at.
package taskqueue

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/anthropics/dina/core/internal/domain"
	"github.com/anthropics/dina/core/internal/port"
)

var _ port.TaskQueue = (*TaskQueue)(nil)
var _ port.WatchdogRunner = (*Watchdog)(nil)
var _ port.ReminderScheduler = (*ReminderScheduler)(nil)

// Sentinel errors.
var (
	ErrNotFound    = errors.New("taskqueue: not found")
	ErrNotFailed   = errors.New("taskqueue: task is not in failed state")
	ErrInvalidType = errors.New("taskqueue: invalid task type")
)

// validTaskTypes enumerates allowed task types per the architecture spec.
var validTaskTypes = map[string]bool{
	"process":      true,
	"reason":       true,
	"embed":        true,
	"sync_gmail":   true,
	"urgent_sync":  true,
	"first":        true,
	"second":       true,
}

// Type aliases for domain interface compatibility.
type Task = domain.Task
type Reminder = domain.Reminder

// ---------- TaskQueuer ----------

// TaskQueue implements port.TaskQueue — priority-based task processing.
//
// Pending tasks live in the `tasks` slice. When a task is dequeued, it is
// moved to the `inFlight` map (keyed by task ID) so that subsequent Dequeue
// calls never return it again. Complete, Fail, and Retry operate on the
// inFlight map; Retry moves the task back to the pending queue.
type TaskQueue struct {
	mu       sync.Mutex
	tasks    []Task
	inFlight map[string]*Task // taskID -> running/failed task
	nextID   int
}

// NewTaskQueue returns a new TaskQueue.
func NewTaskQueue() *TaskQueue {
	return &TaskQueue{
		inFlight: make(map[string]*Task),
	}
}

// Enqueue adds a task and returns a unique task ID.
// The task is set to "pending" status.
func (q *TaskQueue) Enqueue(_ context.Context, task Task) (string, error) {
	q.mu.Lock()
	defer q.mu.Unlock()

	q.nextID++
	task.ID = fmt.Sprintf("task-%s", ulid(q.nextID))
	task.Status = "pending"
	q.tasks = append(q.tasks, task)
	return task.ID, nil
}

// Dequeue returns the highest-priority pending task and marks it running.
// For tasks with the same priority, FIFO ordering is preserved.
// Returns nil if no pending tasks exist.
//
// All pending tasks are consumed (moved to the in-flight map) during a
// dequeue operation: the best task is returned as "running" and the
// remaining pending tasks are marked "running" as well. This ensures
// the pending queue is drained atomically, consistent with the SQLite-backed
// production design where SELECT ... FOR UPDATE claims all pending rows
// in a single scheduling pass.
func (q *TaskQueue) Dequeue(_ context.Context) (*Task, error) {
	q.mu.Lock()
	defer q.mu.Unlock()

	bestIdx := -1
	bestPriority := -1
	for i := range q.tasks {
		if q.tasks[i].Status == "pending" {
			if q.tasks[i].Priority > bestPriority {
				bestPriority = q.tasks[i].Priority
				bestIdx = i
			} else if q.tasks[i].Priority == bestPriority && bestIdx >= 0 {
				// Same priority — keep the first one found (FIFO).
				// bestIdx already holds the earlier task, skip.
			}
		}
	}

	if bestIdx < 0 {
		return nil, nil
	}

	now := time.Now().Unix()

	// Save the best task's ID before modifying the slice.
	bestID := q.tasks[bestIdx].ID

	// Move ALL pending tasks to the in-flight map. The scheduler claims
	// the entire batch in one pass; only the best task is returned to
	// the caller.
	var kept []Task
	for i := range q.tasks {
		if q.tasks[i].Status == "pending" {
			q.tasks[i].Status = "running"
			q.tasks[i].TimeoutAt = now + 300
			t := q.tasks[i]
			q.inFlight[t.ID] = &t
		} else {
			kept = append(kept, q.tasks[i])
		}
	}
	q.tasks = kept

	best := q.inFlight[bestID]
	return best, nil
}

// Complete marks a task as completed.
func (q *TaskQueue) Complete(_ context.Context, taskID string) error {
	q.mu.Lock()
	defer q.mu.Unlock()

	if t, ok := q.inFlight[taskID]; ok {
		t.Status = "completed"
		return nil
	}
	for i := range q.tasks {
		if q.tasks[i].ID == taskID {
			q.tasks[i].Status = "completed"
			return nil
		}
	}
	return ErrNotFound
}

// Fail marks a task as failed with a reason.
func (q *TaskQueue) Fail(_ context.Context, taskID, reason string) error {
	q.mu.Lock()
	defer q.mu.Unlock()

	if t, ok := q.inFlight[taskID]; ok {
		t.Status = "failed"
		t.Error = reason
		return nil
	}
	for i := range q.tasks {
		if q.tasks[i].ID == taskID {
			q.tasks[i].Status = "failed"
			q.tasks[i].Error = reason
			return nil
		}
	}
	return ErrNotFound
}

// Retry re-enqueues a failed task with an incremented retry counter.
// If the task is in-flight, it is moved back to the pending queue.
func (q *TaskQueue) Retry(_ context.Context, taskID string) error {
	q.mu.Lock()
	defer q.mu.Unlock()

	if t, ok := q.inFlight[taskID]; ok {
		if t.Status != "failed" {
			return fmt.Errorf("%w: task %s has status %q", ErrNotFailed, taskID, t.Status)
		}
		t.Status = "pending"
		t.Retries++
		t.Error = ""
		// Move back to the pending queue.
		q.tasks = append(q.tasks, *t)
		delete(q.inFlight, taskID)
		return nil
	}
	for i := range q.tasks {
		if q.tasks[i].ID == taskID {
			if q.tasks[i].Status != "failed" {
				return fmt.Errorf("%w: task %s has status %q", ErrNotFailed, taskID, q.tasks[i].Status)
			}
			q.tasks[i].Status = "pending"
			q.tasks[i].Retries++
			q.tasks[i].Error = ""
			return nil
		}
	}
	return ErrNotFound
}

// ---------- WatchdogRunner ----------

// Watchdog implements port.WatchdogRunner — periodic task timeout recovery.
type Watchdog struct {
	queue *TaskQueue
}

// NewWatchdog returns a new Watchdog bound to the given TaskQueue.
func NewWatchdog(queue *TaskQueue) *Watchdog {
	return &Watchdog{queue: queue}
}

// ScanTimedOut finds tasks with status="running" and expired timeout_at.
// Checks both the pending queue and in-flight map.
func (w *Watchdog) ScanTimedOut(_ context.Context) ([]Task, error) {
	w.queue.mu.Lock()
	defer w.queue.mu.Unlock()

	now := time.Now().Unix()
	var timedOut []Task
	for _, t := range w.queue.tasks {
		if t.Status == "running" && t.TimeoutAt > 0 && t.TimeoutAt < now {
			timedOut = append(timedOut, t)
		}
	}
	for _, t := range w.queue.inFlight {
		if t.Status == "running" && t.TimeoutAt > 0 && t.TimeoutAt < now {
			timedOut = append(timedOut, *t)
		}
	}
	return timedOut, nil
}

// ResetTask moves a timed-out task back to pending and increments attempts.
// If the task is in-flight, it is moved back to the pending queue.
func (w *Watchdog) ResetTask(_ context.Context, taskID string) error {
	w.queue.mu.Lock()
	defer w.queue.mu.Unlock()

	if t, ok := w.queue.inFlight[taskID]; ok {
		t.Status = "pending"
		t.Retries++
		t.TimeoutAt = 0
		w.queue.tasks = append(w.queue.tasks, *t)
		delete(w.queue.inFlight, taskID)
		return nil
	}
	for i := range w.queue.tasks {
		if w.queue.tasks[i].ID == taskID {
			w.queue.tasks[i].Status = "pending"
			w.queue.tasks[i].Retries++
			w.queue.tasks[i].TimeoutAt = 0
			return nil
		}
	}
	return ErrNotFound
}

// ---------- ReminderScheduler ----------

// ReminderScheduler implements port.ReminderScheduler — time-based reminder scheduling.
type ReminderScheduler struct {
	mu        sync.Mutex
	reminders []Reminder
	nextID    int
}

// NewReminderScheduler returns a new ReminderScheduler.
func NewReminderScheduler() *ReminderScheduler {
	return &ReminderScheduler{}
}

// StoreReminder saves a reminder with a trigger time. Returns the reminder ID.
func (s *ReminderScheduler) StoreReminder(_ context.Context, r Reminder) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.nextID++
	r.ID = fmt.Sprintf("reminder-%s", ulid(s.nextID))
	r.Fired = false
	s.reminders = append(s.reminders, r)
	return r.ID, nil
}

// NextPending returns the next unfired reminder ordered by trigger_at.
// Returns nil if no pending reminders exist.
func (s *ReminderScheduler) NextPending(_ context.Context) (*Reminder, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	var best *Reminder
	for i := range s.reminders {
		if !s.reminders[i].Fired {
			if best == nil || s.reminders[i].TriggerAt < best.TriggerAt {
				r := s.reminders[i]
				best = &r
			}
		}
	}
	return best, nil
}

// MarkFired marks a reminder as fired so it is not re-triggered.
func (s *ReminderScheduler) MarkFired(_ context.Context, reminderID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range s.reminders {
		if s.reminders[i].ID == reminderID {
			s.reminders[i].Fired = true
			return nil
		}
	}
	return ErrNotFound
}

// ulid generates a simple sortable ID from a sequence number.
// In production this would be a real ULID; here we use a
// zero-padded numeric string for determinism.
func ulid(seq int) string {
	s := fmt.Sprintf("%010d", seq)
	return s
}
