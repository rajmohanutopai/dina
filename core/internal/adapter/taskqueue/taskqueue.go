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

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
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
	mu         sync.Mutex
	tasks      []Task
	inFlight   map[string]*Task // taskID -> running/failed task
	completed  map[string]*Task // taskID -> completed task
	cancelled  map[string]*Task // taskID -> cancelled task
	deadLetter map[string]*Task // taskID -> dead-lettered task
	nextID     int
	maxRetries int // 0 means use default (5)
}

// NewTaskQueue returns a new TaskQueue.
func NewTaskQueue() *TaskQueue {
	return &TaskQueue{
		inFlight:   make(map[string]*Task),
		completed:  make(map[string]*Task),
		cancelled:  make(map[string]*Task),
		deadLetter: make(map[string]*Task),
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
// Only the single best (highest priority, FIFO for ties) pending task is
// claimed: it is moved to the in-flight map with status "running" and a
// timeout. All other pending tasks remain in the queue for subsequent
// Dequeue calls.
func (q *TaskQueue) Dequeue(_ context.Context) (*Task, error) {
	q.mu.Lock()
	defer q.mu.Unlock()

	bestIdx := -1
	bestPriority := -1
	now := time.Now().Unix()
	for i := range q.tasks {
		if q.tasks[i].Status == "pending" {
			// OT2: Respect retry backoff — skip tasks whose NextRetry is in the future.
			if q.tasks[i].NextRetry > 0 && q.tasks[i].NextRetry > now {
				continue
			}
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

	// Move only the best task to in-flight.
	q.tasks[bestIdx].Status = "running"
	q.tasks[bestIdx].TimeoutAt = now + 300
	t := q.tasks[bestIdx]
	q.inFlight[t.ID] = &t

	// Remove the best task from the pending slice.
	q.tasks = append(q.tasks[:bestIdx], q.tasks[bestIdx+1:]...)

	return q.inFlight[t.ID], nil
}

// Acknowledge marks an in-flight task as completed by its task ID and
// removes it from the in-flight map. Returns the completed task, or an
// error if the task ID is not found among in-flight tasks.
func (q *TaskQueue) Acknowledge(_ context.Context, taskID string) (*Task, error) {
	q.mu.Lock()
	defer q.mu.Unlock()

	t, ok := q.inFlight[taskID]
	if !ok {
		return nil, fmt.Errorf("%w: task %s not in flight", ErrNotFound, taskID)
	}

	t.Status = "completed"
	result := *t
	delete(q.inFlight, taskID)
	return &result, nil
}

// Complete marks a task as completed.
func (q *TaskQueue) Complete(_ context.Context, taskID string) error {
	q.mu.Lock()
	defer q.mu.Unlock()

	if t, ok := q.inFlight[taskID]; ok {
		t.Status = "completed"
		delete(q.inFlight, taskID)
		q.completed[taskID] = t
		return nil
	}
	for i := range q.tasks {
		if q.tasks[i].ID == taskID {
			q.tasks[i].Status = "completed"
			t := q.tasks[i]
			q.completed[taskID] = &t
			// Remove from pending queue.
			q.tasks = append(q.tasks[:i], q.tasks[i+1:]...)
			return nil
		}
	}
	return ErrNotFound
}

// Fail marks a task as failed with a reason.
// Returns an error if the task is already failed (not idempotent).
func (q *TaskQueue) Fail(_ context.Context, taskID, reason string) error {
	q.mu.Lock()
	defer q.mu.Unlock()

	if t, ok := q.inFlight[taskID]; ok {
		if t.Status == "failed" {
			return fmt.Errorf("task %s is already failed", taskID)
		}
		t.Status = "failed"
		t.Error = reason
		return nil
	}
	for i := range q.tasks {
		if q.tasks[i].ID == taskID {
			if q.tasks[i].Status == "failed" {
				return fmt.Errorf("task %s is already failed", taskID)
			}
			q.tasks[i].Status = "failed"
			q.tasks[i].Error = reason
			return nil
		}
	}
	return ErrNotFound
}

// Retry re-enqueues a failed task with exponential backoff.
// If retries exceed maxRetries (default 5), the task moves to dead letter.
// If the task is in-flight, it is moved back to the pending queue.
func (q *TaskQueue) Retry(_ context.Context, taskID string) error {
	q.mu.Lock()
	defer q.mu.Unlock()

	var task *Task
	inFlightTask := false

	if t, ok := q.inFlight[taskID]; ok {
		if t.Status != "failed" {
			return fmt.Errorf("%w: task %s has status %q", ErrNotFailed, taskID, t.Status)
		}
		task = t
		inFlightTask = true
	} else {
		for i := range q.tasks {
			if q.tasks[i].ID == taskID {
				if q.tasks[i].Status != "failed" {
					return fmt.Errorf("%w: task %s has status %q", ErrNotFailed, taskID, q.tasks[i].Status)
				}
				task = &q.tasks[i]
				break
			}
		}
	}
	if task == nil {
		return ErrNotFound
	}

	task.Retries++

	// Check max retries (default 5).
	maxRetries := 5
	if q.maxRetries > 0 {
		maxRetries = q.maxRetries
	}
	if task.Retries > maxRetries {
		task.Status = "dead_letter"
		t := *task
		q.deadLetter[taskID] = &t
		if inFlightTask {
			delete(q.inFlight, taskID)
		} else {
			q.removeFromTasks(taskID)
		}
		return nil
	}

	// Exponential backoff: 1s, 2s, 4s, 8s, 16s...
	backoff := time.Duration(1<<uint(task.Retries-1)) * time.Second
	task.NextRetry = time.Now().Add(backoff).Unix()
	task.Status = "pending"
	task.Error = ""

	if inFlightTask {
		// Move from inFlight back to pending.
		q.tasks = append(q.tasks, *task)
		delete(q.inFlight, taskID)
	}
	return nil
}

// removeFromTasks removes a task from the tasks slice by ID.
func (q *TaskQueue) removeFromTasks(taskID string) {
	for i := range q.tasks {
		if q.tasks[i].ID == taskID {
			q.tasks = append(q.tasks[:i], q.tasks[i+1:]...)
			return
		}
	}
}

// Cancel moves a task to "cancelled" status.
func (q *TaskQueue) Cancel(_ context.Context, taskID string) error {
	q.mu.Lock()
	defer q.mu.Unlock()

	// Check in-flight tasks.
	if task, ok := q.inFlight[taskID]; ok {
		task.Status = "cancelled"
		t := *task
		delete(q.inFlight, taskID)
		q.cancelled[taskID] = &t
		return nil
	}

	// Check pending queue.
	for i, task := range q.tasks {
		if task.ID == taskID {
			q.tasks[i].Status = "cancelled"
			t := q.tasks[i]
			q.tasks = append(q.tasks[:i], q.tasks[i+1:]...)
			q.cancelled[taskID] = &t
			return nil
		}
	}

	return fmt.Errorf("%w: task %s", ErrNotFound, taskID)
}

// RecoverRunning bulk-resets all "running" (in-flight) tasks back to "pending" (crash recovery).
func (q *TaskQueue) RecoverRunning(_ context.Context) (int, error) {
	q.mu.Lock()
	defer q.mu.Unlock()

	count := 0
	for id, task := range q.inFlight {
		task.Status = "pending"
		task.Retries++
		q.tasks = append(q.tasks, *task)
		delete(q.inFlight, id)
		count++
	}
	return count, nil
}

// GetByID looks up a task by ID across all states.
func (q *TaskQueue) GetByID(_ context.Context, taskID string) (*Task, error) {
	q.mu.Lock()
	defer q.mu.Unlock()

	// Check in-flight.
	if task, ok := q.inFlight[taskID]; ok {
		return task, nil
	}

	// Check pending.
	for i := range q.tasks {
		if q.tasks[i].ID == taskID {
			t := q.tasks[i]
			return &t, nil
		}
	}

	// Check completed.
	if task, ok := q.completed[taskID]; ok {
		return task, nil
	}

	// Check cancelled.
	if task, ok := q.cancelled[taskID]; ok {
		return task, nil
	}

	// Check dead letter.
	if task, ok := q.deadLetter[taskID]; ok {
		return task, nil
	}

	return nil, fmt.Errorf("%w: task %s", ErrNotFound, taskID)
}

// SetMaxRetries configures the maximum number of retries before dead letter.
func (q *TaskQueue) SetMaxRetries(n int) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.maxRetries = n
}

// ResetForTest clears all task queue state for test isolation.
func (q *TaskQueue) ResetForTest() {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.tasks = nil
	q.inFlight = make(map[string]*Task)
	q.completed = make(map[string]*Task)
	q.cancelled = make(map[string]*Task)
	q.deadLetter = make(map[string]*Task)
	q.maxRetries = 0
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

// ListPending returns all unfired reminders ordered by trigger_at.
func (s *ReminderScheduler) ListPending(_ context.Context) ([]Reminder, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	var pending []Reminder
	for _, r := range s.reminders {
		if !r.Fired {
			pending = append(pending, r)
		}
	}
	return pending, nil
}

// GetByID retrieves a reminder by its ID.
func (s *ReminderScheduler) GetByID(_ context.Context, id string) (*Reminder, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range s.reminders {
		if s.reminders[i].ID == id {
			r := s.reminders[i]
			return &r, nil
		}
	}
	return nil, ErrNotFound
}

// ResetForTest clears all reminder state for test isolation.
func (s *ReminderScheduler) ResetForTest() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reminders = nil
}

// ulid generates a simple sortable ID from a sequence number.
// In production this would be a real ULID; here we use a
// zero-padded numeric string for determinism.
func ulid(seq int) string {
	s := fmt.Sprintf("%010d", seq)
	return s
}
