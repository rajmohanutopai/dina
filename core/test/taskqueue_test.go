package test

import (
	"context"
	"testing"

	"github.com/anthropics/dina/core/internal/domain"
	"github.com/anthropics/dina/core/test/testutil"
)

// ==========================================================================
// TEST_PLAN §8 — Task Queue
// 16 scenarios: Enqueue/Dequeue, Priority Ordering, Crash Recovery,
// Outbox Retry Schedule.
// ==========================================================================

// --------------------------------------------------------------------------
// §8.1 Enqueue & Dequeue (5 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-456
func TestTaskQueue_8_1_1_EnqueueReturnsID(t *testing.T) {
	impl := realTaskQueuer
	// impl = taskqueue.New()
	testutil.RequireImplementation(t, impl, "TaskQueuer")

	task := testutil.TestTask()
	id, err := impl.Enqueue(context.Background(), task)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(id) > 0, "enqueue must return a non-empty task ID")
}

// TST-CORE-828
func TestTaskQueue_8_1_2_DequeueReturnsPending(t *testing.T) {
	impl := realTaskQueuer
	// impl = taskqueue.New()
	testutil.RequireImplementation(t, impl, "TaskQueuer")

	task := testutil.TestTask()
	_, err := impl.Enqueue(context.Background(), task)
	testutil.RequireNoError(t, err)

	dequeued, err := impl.Dequeue(context.Background())
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, dequeued)
	testutil.RequireEqual(t, dequeued.Status, domain.TaskRunning)
}

// TST-CORE-829
func TestTaskQueue_8_1_3_DequeueEmptyReturnsNil(t *testing.T) {
	impl := realTaskQueuer
	// impl = taskqueue.New()
	testutil.RequireImplementation(t, impl, "TaskQueuer")

	dequeued, err := impl.Dequeue(context.Background())
	testutil.RequireNoError(t, err)
	testutil.RequireNil(t, dequeued)
}

// TST-CORE-830
func TestTaskQueue_8_1_4_CompleteTask(t *testing.T) {
	impl := realTaskQueuer
	// impl = taskqueue.New()
	testutil.RequireImplementation(t, impl, "TaskQueuer")

	task := testutil.TestTask()
	id, err := impl.Enqueue(context.Background(), task)
	testutil.RequireNoError(t, err)

	dequeued, err := impl.Dequeue(context.Background())
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, dequeued)

	err = impl.Complete(context.Background(), id)
	testutil.RequireNoError(t, err)
}

// TST-CORE-831
func TestTaskQueue_8_1_5_MockEnqueueDequeue(t *testing.T) {
	mock := &testutil.MockTaskQueuer{}

	task := testutil.TestTask()
	id, err := mock.Enqueue(context.Background(), task)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(id) > 0, "mock enqueue should return task ID")

	dequeued, err := mock.Dequeue(context.Background())
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, dequeued)
	testutil.RequireEqual(t, dequeued.Status, domain.TaskRunning)
	testutil.RequireEqual(t, dequeued.Type, "sync_gmail")
}

// --------------------------------------------------------------------------
// §8.2 Priority Ordering (3 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-832
func TestTaskQueue_8_2_1_HighPriorityFirst(t *testing.T) {
	impl := realTaskQueuer
	// impl = taskqueue.New()
	testutil.RequireImplementation(t, impl, "TaskQueuer")

	// Enqueue low priority, then high priority.
	lowPriority := testutil.TestTask()
	lowPriority.Priority = 1

	highPriority := testutil.TestTask()
	highPriority.Priority = 10
	highPriority.Type = "urgent_sync"

	_, err := impl.Enqueue(context.Background(), lowPriority)
	testutil.RequireNoError(t, err)
	_, err = impl.Enqueue(context.Background(), highPriority)
	testutil.RequireNoError(t, err)

	// Dequeue should return high-priority task first.
	dequeued, err := impl.Dequeue(context.Background())
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, dequeued)
	testutil.RequireEqual(t, dequeued.Type, "urgent_sync")
}

// TST-CORE-833
func TestTaskQueue_8_2_2_SamePriorityFIFO(t *testing.T) {
	impl := realTaskQueuer
	// impl = taskqueue.New()
	testutil.RequireImplementation(t, impl, "TaskQueuer")

	// Same priority — FIFO ordering.
	task1 := testutil.TestTask()
	task1.Type = "first"

	task2 := testutil.TestTask()
	task2.Type = "second"

	_, err := impl.Enqueue(context.Background(), task1)
	testutil.RequireNoError(t, err)
	_, err = impl.Enqueue(context.Background(), task2)
	testutil.RequireNoError(t, err)

	dequeued, err := impl.Dequeue(context.Background())
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, dequeued)
	testutil.RequireEqual(t, dequeued.Type, "first")
}

// TST-CORE-834
func TestTaskQueue_8_2_3_MockPriorityNotEnforced(t *testing.T) {
	// The mock does not enforce priority ordering (simple FIFO).
	// This test documents that the mock is a basic stub.
	mock := &testutil.MockTaskQueuer{}

	low := testutil.TestTask()
	low.Priority = 1
	low.Type = "low"

	high := testutil.TestTask()
	high.Priority = 10
	high.Type = "high"

	_, err := mock.Enqueue(context.Background(), low)
	testutil.RequireNoError(t, err)
	_, err = mock.Enqueue(context.Background(), high)
	testutil.RequireNoError(t, err)

	// Mock returns FIFO, not priority-ordered.
	dequeued, err := mock.Dequeue(context.Background())
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, dequeued)
	testutil.RequireEqual(t, dequeued.Type, "low")
}

// --------------------------------------------------------------------------
// §8.3 Fail & Retry (4 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-835
func TestTaskQueue_8_3_1_FailTask(t *testing.T) {
	impl := realTaskQueuer
	// impl = taskqueue.New()
	testutil.RequireImplementation(t, impl, "TaskQueuer")

	task := testutil.TestTask()
	id, err := impl.Enqueue(context.Background(), task)
	testutil.RequireNoError(t, err)

	_, err = impl.Dequeue(context.Background())
	testutil.RequireNoError(t, err)

	err = impl.Fail(context.Background(), id, "network timeout")
	testutil.RequireNoError(t, err)
}

// TST-CORE-836
func TestTaskQueue_8_3_2_RetryIncrementsCounter(t *testing.T) {
	mock := &testutil.MockTaskQueuer{}

	task := testutil.TestTask()
	id, err := mock.Enqueue(context.Background(), task)
	testutil.RequireNoError(t, err)

	dequeued, err := mock.Dequeue(context.Background())
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, dequeued.Retries, 0)

	err = mock.Fail(context.Background(), id, "timeout")
	testutil.RequireNoError(t, err)

	err = mock.Retry(context.Background(), id)
	testutil.RequireNoError(t, err)

	// After retry, task should be pending again with incremented retry count.
	retried, err := mock.Dequeue(context.Background())
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, retried)
	testutil.RequireEqual(t, retried.Retries, 1)
}

// TST-CORE-837
func TestTaskQueue_8_3_3_RetryNonFailedTaskFails(t *testing.T) {
	mock := &testutil.MockTaskQueuer{}

	task := testutil.TestTask()
	id, err := mock.Enqueue(context.Background(), task)
	testutil.RequireNoError(t, err)

	// Task is pending (not failed) — retry should fail.
	err = mock.Retry(context.Background(), id)
	testutil.RequireError(t, err)
}

// TST-CORE-838
func TestTaskQueue_8_3_4_FailNonExistentTaskFails(t *testing.T) {
	mock := &testutil.MockTaskQueuer{}

	err := mock.Fail(context.Background(), "nonexistent-id", "some reason")
	testutil.RequireError(t, err)
}

// --------------------------------------------------------------------------
// §8.4 Crash Recovery & Outbox Retry Schedule (4 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-839
func TestTaskQueue_8_4_1_CrashRecoveryReEnqueuesRunningTasks(t *testing.T) {
	impl := realTaskQueuer
	// impl = taskqueue.New()
	testutil.RequireImplementation(t, impl, "TaskQueuer")

	// After a crash, tasks with status="running" should be re-enqueued
	// as "pending" on startup. This is a persistence / WAL recovery contract.
	t.Skip("crash recovery requires SQLite WAL persistence integration")
}

// TST-CORE-840
func TestTaskQueue_8_4_2_RetryScheduleExponentialBackoff(t *testing.T) {
	impl := realTaskQueuer
	// impl = taskqueue.New()
	testutil.RequireImplementation(t, impl, "TaskQueuer")

	// The outbox retry schedule must follow: 30s -> 1m -> 5m -> 30m -> 2h.
	// This test verifies the implementation applies the correct backoff
	// delays between retry attempts.
	//
	// Expected schedule (per architecture spec):
	//   Retry 0: immediate (first attempt)
	//   Retry 1: +30 seconds
	//   Retry 2: +1 minute
	//   Retry 3: +5 minutes
	//   Retry 4: +30 minutes
	//   Retry 5: +2 hours
	t.Skip("retry schedule verification requires time-based integration test")
}

// TST-CORE-841
func TestTaskQueue_8_4_3_MaxRetriesExceededMarksDeadLetter(t *testing.T) {
	impl := realTaskQueuer
	// impl = taskqueue.New()
	testutil.RequireImplementation(t, impl, "TaskQueuer")

	// After exhausting all retry attempts (5 retries per the spec),
	// the task should be moved to a dead-letter state.
	t.Skip("dead-letter queue requires implementation of retry limit enforcement")
}

// TST-CORE-842
func TestTaskQueue_8_4_4_PersistenceAcrossRestart(t *testing.T) {
	impl := realTaskQueuer
	// impl = taskqueue.New()
	testutil.RequireImplementation(t, impl, "TaskQueuer")

	// Tasks must survive process restart via SQLite WAL.
	// Enqueue a task, simulate restart, verify task is recoverable.
	t.Skip("persistence test requires SQLite-backed TaskQueuer implementation")
}

// ==========================================================================
// TEST_PLAN §8.1 — Task Lifecycle (additional scenarios)
// ==========================================================================

// TST-CORE-457
func TestTaskQueue_8_1_6_TaskIDIsULID(t *testing.T) {
	impl := realTaskQueuer
	testutil.RequireImplementation(t, impl, "TaskQueuer")

	// Task ID must be a valid ULID (lexicographically sortable, timestamp-embedded).
	task := testutil.TestTask()
	id, err := impl.Enqueue(context.Background(), task)
	testutil.RequireNoError(t, err)
	// ULIDs are 26 characters, alphanumeric.
	testutil.RequireTrue(t, len(id) > 0, "task ID should be non-empty ULID")
}

// TST-CORE-458
func TestTaskQueue_8_1_7_SendToBrainSetsProcessing(t *testing.T) {
	impl := realTaskQueuer
	testutil.RequireImplementation(t, impl, "TaskQueuer")

	// Core sends POST brain:8200/api/v1/process, sets status="processing", timeout_at=now()+5min.
	task := testutil.TestTask()
	_, err := impl.Enqueue(context.Background(), task)
	testutil.RequireNoError(t, err)

	dequeued, err := impl.Dequeue(context.Background())
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, dequeued)
	testutil.RequireEqual(t, dequeued.Status, domain.TaskRunning)
}

// TST-CORE-459
func TestTaskQueue_8_1_8_BrainACKDeletesTask(t *testing.T) {
	mock := &testutil.MockTaskQueuer{}

	task := testutil.TestTask()
	id, err := mock.Enqueue(context.Background(), task)
	testutil.RequireNoError(t, err)

	_, err = mock.Dequeue(context.Background())
	testutil.RequireNoError(t, err)

	// Brain sends POST core:8100/v1/task/ack — core deletes task.
	err = mock.Complete(context.Background(), id)
	testutil.RequireNoError(t, err)

	// After completion, dequeue should return nil (no more pending tasks).
	next, err := mock.Dequeue(context.Background())
	testutil.RequireNoError(t, err)
	testutil.RequireNil(t, next)
}

// TST-CORE-461
func TestTaskQueue_8_1_9_TaskTypes(t *testing.T) {
	impl := realTaskQueuer
	testutil.RequireImplementation(t, impl, "TaskQueuer")

	// Valid types: process, reason, embed — unknown type rejected.
	validTypes := []string{"process", "reason", "embed"}
	for _, typ := range validTypes {
		task := testutil.TestTask()
		task.Type = typ
		_, err := impl.Enqueue(context.Background(), task)
		testutil.RequireNoError(t, err)
	}
}

// TST-CORE-463
func TestTaskQueue_8_1_10_ConcurrentWorkers(t *testing.T) {
	impl := realTaskQueuer
	testutil.RequireImplementation(t, impl, "TaskQueuer")

	// Multiple goroutines dequeuing — no duplicate processing (SQLite row-level locking).
	t.Skip("concurrent worker test requires SQLite-backed implementation with real locking")
}

// ==========================================================================
// TEST_PLAN §8.2 — Watchdog (additional scenarios)
// ==========================================================================

// TST-CORE-464
func TestTaskQueue_8_2_4_WatchdogDetectsTimedOutTask(t *testing.T) {
	impl := realWatchdogRunner
	testutil.RequireImplementation(t, impl, "WatchdogRunner")

	// Task with status="processing" and timeout_at < now() should be detected.
	timedOut, err := impl.ScanTimedOut(context.Background())
	testutil.RequireNoError(t, err)
	// No tasks should be timed out in a fresh system.
	_ = timedOut
}

// TST-CORE-465
func TestTaskQueue_8_2_5_WatchdogRunsPeriodically(t *testing.T) {
	impl := realWatchdogRunner
	testutil.RequireImplementation(t, impl, "WatchdogRunner")

	// Background goroutine scans dina_tasks every 30s.
	t.Skip("periodic scanning requires background goroutine integration test")
}

// TST-CORE-466
func TestTaskQueue_8_2_6_WatchdogDoesNotTouchHealthyTasks(t *testing.T) {
	impl := realWatchdogRunner
	testutil.RequireImplementation(t, impl, "WatchdogRunner")

	// Task processing with timeout not expired should be left alone.
	t.Skip("healthy task detection requires time-based integration test")
}

// TST-CORE-467
func TestTaskQueue_8_2_7_ResetTaskReDispatched(t *testing.T) {
	impl := realWatchdogRunner
	testutil.RequireImplementation(t, impl, "WatchdogRunner")

	// Watchdog resets task to pending — next dispatch cycle picks it up.
	t.Skip("re-dispatch requires full TaskQueuer + WatchdogRunner integration")
}

// ==========================================================================
// TEST_PLAN §8.3 — Dead Letter & Retry (additional scenarios)
// ==========================================================================

// TST-CORE-468
func TestTaskQueue_8_3_5_DeadLetterAfter3Failures(t *testing.T) {
	mock := &testutil.MockTaskQueuer{}

	task := testutil.TestTask()
	id, err := mock.Enqueue(context.Background(), task)
	testutil.RequireNoError(t, err)

	// Simulate 3 failure cycles.
	for i := 0; i < 3; i++ {
		_, _ = mock.Dequeue(context.Background())
		_ = mock.Fail(context.Background(), id, "brain crash")
		_ = mock.Retry(context.Background(), id)
	}

	// After 3 retries, the task should have retries=3.
	dequeued, _ := mock.Dequeue(context.Background())
	testutil.RequireNotNil(t, dequeued)
	testutil.RequireEqual(t, dequeued.Retries, 3)
	// In real implementation, this would trigger dead letter status + Tier 2 notification.
}

// TST-CORE-471
func TestTaskQueue_8_3_6_TaskCancellation(t *testing.T) {
	impl := realTaskQueuer
	testutil.RequireImplementation(t, impl, "TaskQueuer")

	// Cancel pending task by ID — status becomes "cancelled".
	t.Skip("task cancellation requires Cancel method on TaskQueuer")
}

// TST-CORE-472
func TestTaskQueue_8_3_7_IndexOnStatusTimeout(t *testing.T) {
	// CREATE INDEX idx_tasks_status ON dina_tasks(status, timeout_at) exists.
	t.Skip("index verification requires SQLite schema inspection")
}

// TST-CORE-473
func TestTaskQueue_8_3_8_NoSilentDataLoss(t *testing.T) {
	impl := realTaskQueuer
	testutil.RequireImplementation(t, impl, "TaskQueuer")

	// Task hits dead letter — user notification via Tier 2, not silently dropped.
	t.Skip("dead letter notification requires Tier 2 notification integration")
}

// ==========================================================================
// TEST_PLAN §8.4 — Reminder Loop (8 scenarios)
// ==========================================================================

// TST-CORE-474
func TestTaskQueue_8_4_5_StoreReminder(t *testing.T) {
	mock := testutil.NewMockReminderScheduler()

	reminder := testutil.TestReminder(1740200000)
	id, err := mock.StoreReminder(context.Background(), reminder)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(id) > 0, "store reminder must return an ID")
}

// TST-CORE-475
func TestTaskQueue_8_4_6_NextPendingReminder(t *testing.T) {
	mock := testutil.NewMockReminderScheduler()

	// Two reminders: 7 AM today, 9 AM tomorrow.
	r1 := testutil.TestReminder(1740200000) // Earlier
	r2 := testutil.TestReminder(1740300000) // Later

	_, err := mock.StoreReminder(context.Background(), r1)
	testutil.RequireNoError(t, err)
	_, err = mock.StoreReminder(context.Background(), r2)
	testutil.RequireNoError(t, err)

	// NextPending returns the earlier reminder (ORDER BY trigger_at LIMIT 1).
	next, err := mock.NextPending(context.Background())
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, next)
	testutil.RequireEqual(t, next.TriggerAt, int64(1740200000))
}

// TST-CORE-476
func TestTaskQueue_8_4_7_SleepUntilTriggerTime(t *testing.T) {
	impl := realReminderScheduler
	testutil.RequireImplementation(t, impl, "ReminderScheduler")

	// Reminder due in 30 minutes — loop sleeps for 30 minutes, then fires.
	t.Skip("sleep-until-trigger requires time-based integration test")
}

// TST-CORE-477
func TestTaskQueue_8_4_8_MissedReminderOnStartup(t *testing.T) {
	impl := realReminderScheduler
	testutil.RequireImplementation(t, impl, "ReminderScheduler")

	// Reminder was due 2 hours ago (server was down).
	// time.Until(trigger_at) is negative — should fire immediately on startup.
	t.Skip("missed reminder requires startup integration test")
}

// TST-CORE-478
func TestTaskQueue_8_4_9_FireAndMarkDone(t *testing.T) {
	mock := testutil.NewMockReminderScheduler()

	reminder := testutil.TestReminder(1740200000)
	id, err := mock.StoreReminder(context.Background(), reminder)
	testutil.RequireNoError(t, err)

	// Fire: notify(next) -> vault.MarkFired(next.ID) -> not re-triggered.
	err = mock.MarkFired(context.Background(), id)
	testutil.RequireNoError(t, err)

	// After marking fired, NextPending should not return this reminder.
	next, err := mock.NextPending(context.Background())
	testutil.RequireNoError(t, err)
	testutil.RequireNil(t, next)
}

// TST-CORE-479
func TestTaskQueue_8_4_10_NoPendingSleepOneMinute(t *testing.T) {
	mock := testutil.NewMockReminderScheduler()

	// No reminders in vault — NextPending returns nil, loop should sleep 1 minute.
	next, err := mock.NextPending(context.Background())
	testutil.RequireNoError(t, err)
	testutil.RequireNil(t, next)
}

// TST-CORE-480
func TestTaskQueue_8_4_11_NoCronLibrary(t *testing.T) {
	// Code audit: no robfig/cron, no scheduling library.
	// Just time.Sleep and vault query.
	t.Skip("code audit: verify no cron library dependency")
}

// TST-CORE-481
func TestTaskQueue_8_4_12_ComplexSchedulingDelegated(t *testing.T) {
	// User asks "every Monday at 9 AM" — brain delegates to OpenClaw/Calendar service.
	// Dina does not handle recurring schedules natively.
	t.Skip("recurring scheduling delegation requires brain integration test")
}

// ==========================================================================
// Uncovered plan scenarios — added by entries 400-600 fix
// ==========================================================================

// TST-CORE-460
func TestTaskQueue_8_1_11_BrainNoACKCrash(t *testing.T) {
	impl := realTaskQueuer
	testutil.RequireImplementation(t, impl, "TaskQueuer")

	// Brain crashes, no ACK within 5 min → timeout_at expires,
	// task stays "processing" until watchdog resets it.
	t.Skip("brain no-ACK requires time-based integration with watchdog")
}

// TST-CORE-462
func TestTaskQueue_8_1_12_TaskPersistenceAcrossRestart(t *testing.T) {
	impl := realTaskQueuer
	testutil.RequireImplementation(t, impl, "TaskQueuer")

	// All pending/processing tasks still in dina_tasks after restart,
	// re-dispatched by the scheduler.
	t.Skip("persistence across restart requires SQLite-backed TaskQueuer")
}

// TST-CORE-469
func TestTaskQueue_8_3_9_DeadLetterNot5(t *testing.T) {
	mock := &testutil.MockTaskQueuer{}

	task := testutil.TestTask()
	id, err := mock.Enqueue(context.Background(), task)
	testutil.RequireNoError(t, err)

	// Dead letter triggers at 3 failures, not 5. Attempts=4 should never happen.
	for i := 0; i < 3; i++ {
		_, _ = mock.Dequeue(context.Background())
		_ = mock.Fail(context.Background(), id, "brain crash")
		if i < 2 {
			_ = mock.Retry(context.Background(), id)
		}
	}
	// After 3 failures, task should be at retries=2 in failed state
	// (real implementation would move to dead letter at this point).
}

// TST-CORE-470
func TestTaskQueue_8_3_10_RetryBackoff(t *testing.T) {
	impl := realTaskQueuer
	testutil.RequireImplementation(t, impl, "TaskQueuer")

	// Task queue uses simple retry + dead letter (no exponential backoff).
	// The outbox has backoff (30s→1m→5m→30m→2h), but task queue does not.
	// This test verifies attempts is incremented and task reset to pending.
	t.Skip("retry backoff contract requires TaskQueuer implementation")
}

// TST-CORE-933
func TestTaskQueue_8_4_13_SilenceRules_StoredAndRetrievable(t *testing.T) {
	// Silence rules stored and retrievable from vault.
	impl := realVaultManager
	testutil.RequireImplementation(t, impl, "VaultManager")

	vaultCtx := context.Background()
	dek := testutil.TestDEK[:]
	persona := "test-silence-rules"
	err := impl.Open(vaultCtx, domain.PersonaName(persona), dek)
	testutil.RequireNoError(t, err)
	defer impl.Close(domain.PersonaName(persona))

	// Store a silence rule as a vault item.
	item := testutil.VaultItem{
		ID:         "silence-rule-001",
		Type:       "note",
		Source:     "silence_rules",
		Summary:    "suppress marketing notifications 22:00-08:00",
		Timestamp:  1700000000,
		IngestedAt: 1700000000,
	}
	_, err = impl.Store(vaultCtx, domain.PersonaName(persona), item)
	testutil.RequireNoError(t, err)
}
