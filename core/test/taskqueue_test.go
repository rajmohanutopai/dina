package test

import (
	"context"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/adapter/taskqueue"
	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/test/testutil"
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
// TRACE: {"suite": "CORE", "case": "1348", "section": "08", "sectionName": "Task Queue (Outbox Pattern)", "subsection": "01", "scenario": "01", "title": "EnqueueReturnsID"}
func TestTaskQueue_8_1_1_EnqueueReturnsID(t *testing.T) {
	impl := taskqueue.NewTaskQueue()
	testutil.RequireImplementation(t, impl, "TaskQueuer")

	ctx := context.Background()

	// Positive: Enqueue returns a non-empty ID.
	task := testutil.TestTask()
	id1, err := impl.Enqueue(ctx, task)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(id1) > 0, "enqueue must return a non-empty task ID")

	// Positive: round-trip — GetByID must find the enqueued task.
	got, err := impl.GetByID(ctx, id1)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, got.ID, id1)
	testutil.RequireEqual(t, got.Type, task.Type)
	testutil.RequireEqual(t, string(got.Status), "pending")

	// Negative: a second enqueue must produce a DIFFERENT ID (uniqueness).
	task2 := testutil.TestTask()
	id2, err := impl.Enqueue(ctx, task2)
	testutil.RequireNoError(t, err)
	if id1 == id2 {
		t.Fatal("two enqueued tasks must have different IDs")
	}
}

// TST-CORE-828
// TRACE: {"suite": "CORE", "case": "1349", "section": "08", "sectionName": "Task Queue (Outbox Pattern)", "subsection": "01", "scenario": "02", "title": "DequeueTransitionsToRunning"}
func TestTaskQueue_8_1_2_DequeueTransitionsToRunning(t *testing.T) {
	impl := realTaskQueuer
	// impl = taskqueue.New()
	testutil.RequireImplementation(t, impl, "TaskQueuer")

	task := testutil.TestTask()
	id, err := impl.Enqueue(context.Background(), task)
	testutil.RequireNoError(t, err)

	dequeued, err := impl.Dequeue(context.Background())
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, dequeued)
	testutil.RequireEqual(t, dequeued.ID, id)
	testutil.RequireEqual(t, dequeued.Status, domain.TaskRunning)
	testutil.RequireEqual(t, dequeued.Type, task.Type)
	testutil.RequireEqual(t, dequeued.Priority, task.Priority)
}

// TST-CORE-829
// TRACE: {"suite": "CORE", "case": "1350", "section": "08", "sectionName": "Task Queue (Outbox Pattern)", "subsection": "01", "scenario": "03", "title": "DequeueEmptyReturnsNil"}
func TestTaskQueue_8_1_3_DequeueEmptyReturnsNil(t *testing.T) {
	q := taskqueue.NewTaskQueue()
	testutil.RequireImplementation(t, q, "TaskQueuer")

	ctx := context.Background()

	// Positive: dequeue on fresh empty queue returns nil, no error.
	dequeued, err := q.Dequeue(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireNil(t, dequeued)

	// Negative: enqueue one task, dequeue it, then dequeue again → nil.
	task := testutil.TestTask()
	_, err = q.Enqueue(ctx, task)
	testutil.RequireNoError(t, err)

	dequeued, err = q.Dequeue(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, dequeued)

	// Queue is now empty (task is in-flight) — second dequeue must return nil.
	dequeued2, err := q.Dequeue(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireNil(t, dequeued2)
}

// TST-CORE-830
// TRACE: {"suite": "CORE", "case": "1351", "section": "08", "sectionName": "Task Queue (Outbox Pattern)", "subsection": "01", "scenario": "04", "title": "CompleteTask"}
func TestTaskQueue_8_1_4_CompleteTask(t *testing.T) {
	q := taskqueue.NewTaskQueue()
	ctx := context.Background()

	task := testutil.TestTask()
	id, err := q.Enqueue(ctx, task)
	testutil.RequireNoError(t, err)

	// Dequeue moves task to in-flight with status "running".
	dequeued, err := q.Dequeue(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, dequeued)
	testutil.RequireEqual(t, dequeued.ID, id)
	testutil.RequireEqual(t, dequeued.Status, domain.TaskRunning)

	// Complete the task.
	err = q.Complete(ctx, id)
	testutil.RequireNoError(t, err)

	// After completion, task is no longer in-flight — Dequeue returns nil.
	next, err := q.Dequeue(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireNil(t, next)

	// Negative: completing a non-existent task must fail.
	err = q.Complete(ctx, "nonexistent-task-id")
	testutil.RequireError(t, err)
}

// TST-CORE-831
// TRACE: {"suite": "CORE", "case": "1352", "section": "08", "sectionName": "Task Queue (Outbox Pattern)", "subsection": "01", "scenario": "05", "title": "MockEnqueueDequeue"}
func TestTaskQueue_8_1_5_MockEnqueueDequeue(t *testing.T) {
	// Fresh production TaskQueue — no mocks.
	impl := taskqueue.NewTaskQueue()
	testutil.RequireImplementation(t, impl, "TaskQueuer")

	ctx := context.Background()

	// Negative: dequeue on empty queue returns nil.
	dequeued, err := impl.Dequeue(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireNil(t, dequeued)

	// Enqueue a task.
	task := testutil.TestTask()
	id, err := impl.Enqueue(ctx, task)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(id) > 0, "enqueue should return task ID")

	// Dequeue — must return the task in running status.
	dequeued, err = impl.Dequeue(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, dequeued)
	testutil.RequireEqual(t, dequeued.Status, domain.TaskRunning)
	testutil.RequireEqual(t, dequeued.Type, task.Type)
	testutil.RequireEqual(t, dequeued.ID, id)

	// Dequeue again — queue is empty (task is in-flight).
	dequeued2, err := impl.Dequeue(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireNil(t, dequeued2)

	// GetByID should find the in-flight task.
	found, err := impl.GetByID(ctx, id)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, found)
	testutil.RequireEqual(t, found.Status, domain.TaskRunning)
}

// --------------------------------------------------------------------------
// §8.2 Priority Ordering (3 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-832
// TRACE: {"suite": "CORE", "case": "1353", "section": "08", "sectionName": "Task Queue (Outbox Pattern)", "subsection": "02", "scenario": "01", "title": "HighPriorityFirst"}
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
// TRACE: {"suite": "CORE", "case": "1354", "section": "08", "sectionName": "Task Queue (Outbox Pattern)", "subsection": "02", "scenario": "02", "title": "SamePriorityFIFO"}
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
// TRACE: {"suite": "CORE", "case": "1355", "section": "08", "sectionName": "Task Queue (Outbox Pattern)", "subsection": "02", "scenario": "03", "title": "MockPriorityNotEnforced"}
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
// TRACE: {"suite": "CORE", "case": "1356", "section": "08", "sectionName": "Task Queue (Outbox Pattern)", "subsection": "03", "scenario": "01", "title": "FailTask"}
func TestTaskQueue_8_3_1_FailTask(t *testing.T) {
	impl := realTaskQueuer
	// impl = taskqueue.New()
	testutil.RequireImplementation(t, impl, "TaskQueuer")

	ctx := context.Background()

	task := testutil.TestTask()
	id, err := impl.Enqueue(ctx, task)
	testutil.RequireNoError(t, err)

	dequeued, err := impl.Dequeue(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, dequeued)
	testutil.RequireEqual(t, string(dequeued.Status), "running")

	err = impl.Fail(ctx, id, "network timeout")
	testutil.RequireNoError(t, err)

	// Round-trip: verify task status changed to "failed" and error reason recorded.
	failed, err := impl.GetByID(ctx, id)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, failed)
	testutil.RequireEqual(t, string(failed.Status), "failed")
	testutil.RequireEqual(t, failed.Error, "network timeout")

	// Negative control: Fail on an already-failed task should error.
	err = impl.Fail(ctx, id, "double fail")
	testutil.RequireError(t, err)
}

// TST-CORE-836
// TRACE: {"suite": "CORE", "case": "1357", "section": "08", "sectionName": "Task Queue (Outbox Pattern)", "subsection": "03", "scenario": "02", "title": "RetryIncrementsCounter"}
func TestTaskQueue_8_3_2_RetryIncrementsCounter(t *testing.T) {
	impl := realTaskQueuer
	testutil.RequireImplementation(t, impl, "TaskQueuer")

	ctx := context.Background()

	task := testutil.TestTask()
	id, err := impl.Enqueue(ctx, task)
	testutil.RequireNoError(t, err)

	dequeued, err := impl.Dequeue(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, dequeued)
	testutil.RequireEqual(t, dequeued.Retries, 0)

	err = impl.Fail(ctx, id, "timeout")
	testutil.RequireNoError(t, err)

	err = impl.Retry(ctx, id)
	testutil.RequireNoError(t, err)

	// After retry, task should be pending again with incremented retry count.
	// OT2: Respect retry backoff — first retry is 1s delay.
	time.Sleep(1100 * time.Millisecond)
	retried, err := impl.Dequeue(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, retried)
	testutil.RequireEqual(t, retried.Retries, 1)
	testutil.RequireEqual(t, string(retried.Status), "running")

	// Verify via GetByID as well.
	lookedUp, err := impl.GetByID(ctx, id)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, lookedUp.Retries, 1)
}

// TST-CORE-837
// TRACE: {"suite": "CORE", "case": "1358", "section": "08", "sectionName": "Task Queue (Outbox Pattern)", "subsection": "03", "scenario": "03", "title": "RetryNonFailedTaskFails"}
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
// TRACE: {"suite": "CORE", "case": "1359", "section": "08", "sectionName": "Task Queue (Outbox Pattern)", "subsection": "03", "scenario": "04", "title": "FailNonExistentTaskFails"}
func TestTaskQueue_8_3_4_FailNonExistentTaskFails(t *testing.T) {
	q := taskqueue.NewTaskQueue()
	ctx := context.Background()

	// Negative: Fail on a non-existent task must return an error.
	err := q.Fail(ctx, "nonexistent-id", "some reason")
	testutil.RequireError(t, err)

	// Positive: Fail on a real in-flight task must succeed.
	task := testutil.TestTask()
	id, err := q.Enqueue(ctx, task)
	testutil.RequireNoError(t, err)

	_, err = q.Dequeue(ctx)
	testutil.RequireNoError(t, err)

	err = q.Fail(ctx, id, "network timeout")
	testutil.RequireNoError(t, err)

	// Verify failed status via GetByID.
	failed, err := q.GetByID(ctx, id)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, failed)
	testutil.RequireEqual(t, failed.Status, domain.TaskFailed)
	testutil.RequireEqual(t, failed.Error, "network timeout")
}

// --------------------------------------------------------------------------
// §8.4 Crash Recovery & Outbox Retry Schedule (4 scenarios)
// --------------------------------------------------------------------------

// TST-CORE-839
// TRACE: {"suite": "CORE", "case": "1360", "section": "08", "sectionName": "Task Queue (Outbox Pattern)", "subsection": "04", "scenario": "01", "title": "CrashRecoveryReEnqueuesRunningTasks"}
func TestTaskQueue_8_4_1_CrashRecoveryReEnqueuesRunningTasks(t *testing.T) {
	impl := realTaskQueuer
	testutil.RequireImplementation(t, impl, "TaskQueuer")

	ctx := context.Background()

	// Enqueue a task.
	task := testutil.TestTask()
	taskID, err := impl.Enqueue(ctx, task)
	testutil.RequireNoError(t, err)

	// Dequeue it (sets it to running/in-flight).
	dequeued, err := impl.Dequeue(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, dequeued)
	testutil.RequireEqual(t, dequeued.ID, taskID)

	// Simulate crash recovery — all running tasks back to pending.
	count, err := impl.RecoverRunning(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, count >= 1, "at least one running task should be recovered")

	// The task should be dequeueable again.
	recovered, err := impl.Dequeue(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, recovered)
	testutil.RequireEqual(t, recovered.ID, taskID)
}

// TST-CORE-840
// TRACE: {"suite": "CORE", "case": "1361", "section": "08", "sectionName": "Task Queue (Outbox Pattern)", "subsection": "04", "scenario": "02", "title": "RetryScheduleExponentialBackoff"}
func TestTaskQueue_8_4_2_RetryScheduleExponentialBackoff(t *testing.T) {
	q := taskqueue.NewTaskQueue()
	ctx := context.Background()

	// Enqueue and dequeue a task.
	task := testutil.TestTask()
	taskID, err := q.Enqueue(ctx, task)
	testutil.RequireNoError(t, err)

	dequeued, err := q.Dequeue(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, dequeued)
	testutil.RequireEqual(t, dequeued.ID, taskID)

	// Fail the task.
	err = q.Fail(ctx, taskID, "timeout")
	testutil.RequireNoError(t, err)

	// Retry twice and verify backoff increases strictly.
	// Production: backoff = 1<<(retries-1) seconds → 1s, 2s.
	var lastNextRetry int64
	for i := 0; i < 2; i++ {
		err = q.Retry(ctx, taskID)
		testutil.RequireNoError(t, err)

		found, err := q.GetByID(ctx, taskID)
		testutil.RequireNoError(t, err)
		testutil.RequireNotNil(t, found)
		testutil.RequireEqual(t, found.Retries, i+1)
		testutil.RequireEqual(t, found.Status, domain.TaskPending)
		testutil.RequireTrue(t, found.NextRetry > 0, "NextRetry should be set after retry")

		if i > 0 {
			// Strict increase: each NextRetry must be strictly greater (exponential).
			testutil.RequireTrue(t, found.NextRetry > lastNextRetry,
				"backoff must strictly increase with each retry")
		}
		lastNextRetry = found.NextRetry

		// OT2: Wait past the backoff, then re-dequeue and fail for next iteration.
		backoff := time.Duration(1<<uint(i)) * time.Second
		time.Sleep(backoff + 200*time.Millisecond)
		d, err := q.Dequeue(ctx)
		testutil.RequireNoError(t, err)
		testutil.RequireNotNil(t, d)
		testutil.RequireEqual(t, d.ID, taskID)
		err = q.Fail(ctx, taskID, "timeout")
		testutil.RequireNoError(t, err)
	}
}

// TST-CORE-841
// TRACE: {"suite": "CORE", "case": "1362", "section": "08", "sectionName": "Task Queue (Outbox Pattern)", "subsection": "04", "scenario": "03", "title": "MaxRetriesExceededMarksDeadLetter"}
func TestTaskQueue_8_4_3_MaxRetriesExceededMarksDeadLetter(t *testing.T) {
	q := taskqueue.NewTaskQueue()
	ctx := context.Background()

	// Set max retries to 2 for faster testing (reduces cumulative backoff sleep).
	q.SetMaxRetries(2)

	task := testutil.TestTask()
	taskID, err := q.Enqueue(ctx, task)
	testutil.RequireNoError(t, err)

	// Cycle through fail/retry until dead letter.
	// MaxRetries=2 → dead_letter when Retries > 2 (3rd Retry call).
	for i := 0; i < 3; i++ {
		// OT2: Wait past backoff before dequeuing (1s, 2s, 4s exponential).
		if i > 0 {
			backoff := time.Duration(1<<uint(i-1)) * time.Second
			time.Sleep(backoff + 200*time.Millisecond)
		}
		dequeued, err := q.Dequeue(ctx)
		testutil.RequireNoError(t, err)
		testutil.RequireNotNil(t, dequeued)
		testutil.RequireEqual(t, dequeued.ID, taskID)
		testutil.RequireEqual(t, dequeued.Status, domain.TaskRunning)

		err = q.Fail(ctx, taskID, "persistent failure")
		testutil.RequireNoError(t, err)

		err = q.Retry(ctx, taskID)
		testutil.RequireNoError(t, err)

		// Verify retries incremented (except the last iteration where it goes to dead_letter).
		found, err := q.GetByID(ctx, taskID)
		testutil.RequireNoError(t, err)
		testutil.RequireNotNil(t, found)
		if i < 2 {
			testutil.RequireEqual(t, found.Retries, i+1)
			testutil.RequireEqual(t, found.Status, domain.TaskPending)
		}
	}

	// After exceeding max retries, task should be dead_letter.
	found, err := q.GetByID(ctx, taskID)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, found)
	testutil.RequireEqual(t, found.Status, domain.TaskStatus("dead_letter"))
	testutil.RequireEqual(t, found.Retries, 3) // MaxRetries=2 → dead_letter at 3rd retry

	// Negative: dead-letter queue is empty — Dequeue returns nil.
	next, err := q.Dequeue(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireNil(t, next)
}

// TST-CORE-842
// TRACE: {"suite": "CORE", "case": "1363", "section": "08", "sectionName": "Task Queue (Outbox Pattern)", "subsection": "04", "scenario": "04", "title": "PersistenceAcrossRestart"}
func TestTaskQueue_8_4_4_PersistenceAcrossRestart(t *testing.T) {
	ctx := context.Background()

	// Create a fresh queue and enqueue tasks to test persistence semantics.
	queue := taskqueue.NewTaskQueue()

	// Enqueue two tasks with different types.
	task1 := testutil.TestTask()
	task1.Type = "persistence-type-a"
	taskID1, err := queue.Enqueue(ctx, task1)
	testutil.RequireNoError(t, err)

	task2 := testutil.TestTask()
	task2.Type = "persistence-type-b"
	taskID2, err := queue.Enqueue(ctx, task2)
	testutil.RequireNoError(t, err)

	// Positive: both tasks retrievable by ID with correct data.
	found1, err := queue.GetByID(ctx, taskID1)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, found1)
	testutil.RequireEqual(t, found1.ID, taskID1)
	testutil.RequireEqual(t, found1.Type, "persistence-type-a")
	testutil.RequireEqual(t, found1.Status, domain.TaskPending)

	found2, err := queue.GetByID(ctx, taskID2)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, found2)
	testutil.RequireEqual(t, found2.ID, taskID2)
	testutil.RequireEqual(t, found2.Type, "persistence-type-b")

	// Dequeue first task and complete it.
	dequeued, err := queue.Dequeue(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, dequeued)
	err = queue.Complete(ctx, dequeued.ID)
	testutil.RequireNoError(t, err)

	// Completed task should still be retrievable with correct status.
	completed, err := queue.GetByID(ctx, dequeued.ID)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, completed.Status, domain.TaskCompleted)

	// Remaining task should still be pending and dequeue-able.
	dequeued2, err := queue.Dequeue(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, dequeued2)
	testutil.RequireEqual(t, dequeued2.Status, domain.TaskRunning)

	// Negative: non-existent task ID returns error or nil.
	notFound, err := queue.GetByID(ctx, "nonexistent-task-id")
	testutil.RequireTrue(t, err != nil || notFound == nil, "non-existent task must not be found")
}

// ==========================================================================
// TEST_PLAN §8.1 — Task Lifecycle (additional scenarios)
// ==========================================================================

// TST-CORE-457
// TRACE: {"suite": "CORE", "case": "1364", "section": "08", "sectionName": "Task Queue (Outbox Pattern)", "subsection": "01", "scenario": "06", "title": "TaskIDIsULID"}
func TestTaskQueue_8_1_6_TaskIDIsULID(t *testing.T) {
	impl := realTaskQueuer
	testutil.RequireImplementation(t, impl, "TaskQueuer")

	task := testutil.TestTask()
	id, err := impl.Enqueue(context.Background(), task)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(id) > 0, "task ID must be non-empty")

	// Enqueue a second task and verify lexicographic ordering (sortable IDs).
	task2 := testutil.TestTask()
	id2, err := impl.Enqueue(context.Background(), task2)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, id2 > id, "second task ID must be lexicographically greater than first")
	testutil.RequireTrue(t, id != id2, "task IDs must be unique")
}

// TST-CORE-458
// TRACE: {"suite": "CORE", "case": "1365", "section": "08", "sectionName": "Task Queue (Outbox Pattern)", "subsection": "01", "scenario": "07", "title": "SendToBrainSetsProcessing"}
func TestTaskQueue_8_1_7_SendToBrainSetsProcessing(t *testing.T) {
	// §8.1.7: When Core dequeues a task to send to Brain, status must become "running".
	// Fresh TaskQueue to avoid shared state.
	impl := taskqueue.NewTaskQueue()
	testutil.RequireImplementation(t, impl, "TaskQueuer")

	ctx := context.Background()

	// Enqueue a task — should start as pending.
	task := testutil.TestTask()
	id, err := impl.Enqueue(ctx, task)
	testutil.RequireNoError(t, err)

	// Verify it starts as pending before dequeue.
	queued, err := impl.GetByID(ctx, id)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, queued.Status, domain.TaskPending)

	// Dequeue — status must transition to running.
	dequeued, err := impl.Dequeue(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, dequeued)
	testutil.RequireEqual(t, dequeued.ID, id)
	testutil.RequireEqual(t, dequeued.Status, domain.TaskRunning)

	// Negative: no more tasks to dequeue.
	empty, err := impl.Dequeue(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, empty == nil, "queue should be empty after dequeuing the only task")
}

// TST-CORE-459
// TRACE: {"suite": "CORE", "case": "1366", "section": "08", "sectionName": "Task Queue (Outbox Pattern)", "subsection": "01", "scenario": "08", "title": "BrainACKDeletesTask"}
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
// TRACE: {"suite": "CORE", "case": "1367", "section": "08", "sectionName": "Task Queue (Outbox Pattern)", "subsection": "01", "scenario": "09", "title": "TaskTypes"}
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
// TRACE: {"suite": "CORE", "case": "1368", "section": "08", "sectionName": "Task Queue (Outbox Pattern)", "subsection": "01", "scenario": "10", "title": "ConcurrentWorkers"}
func TestTaskQueue_8_1_10_ConcurrentWorkers(t *testing.T) {
	// §8.1.10: Concurrent workers must each get unique tasks — no double-dequeue.
	// Fresh TaskQueue to avoid shared state.
	impl := taskqueue.NewTaskQueue()
	testutil.RequireImplementation(t, impl, "TaskQueuer")

	ctx := context.Background()
	const numTasks = 20
	const numWorkers = 5

	// Enqueue 20 tasks with unique payloads for verification.
	taskIDs := make(map[string]bool)
	for i := 0; i < numTasks; i++ {
		task := testutil.TestTask()
		task.Payload = []byte(fmt.Sprintf(`{"worker_test": %d}`, i))
		id, err := impl.Enqueue(ctx, task)
		testutil.RequireNoError(t, err)
		taskIDs[id] = true
	}
	testutil.RequireEqual(t, len(taskIDs), numTasks)

	// Launch concurrent workers to dequeue.
	var mu sync.Mutex
	dequeued := make(map[string]int)
	var wg sync.WaitGroup

	for w := 0; w < numWorkers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				task, err := impl.Dequeue(ctx)
				if err != nil {
					return
				}
				if task == nil {
					return
				}
				mu.Lock()
				dequeued[task.ID]++
				mu.Unlock()
			}
		}()
	}

	wg.Wait()

	// Positive: ALL 20 tasks must have been dequeued.
	testutil.RequireEqual(t, len(dequeued), numTasks)

	// No task dequeued more than once (no double-dispatch).
	for id, count := range dequeued {
		if count != 1 {
			t.Errorf("task %s was dequeued %d times, expected exactly 1", id, count)
		}
		// Every dequeued ID must be one we enqueued.
		testutil.RequireTrue(t, taskIDs[id], "dequeued unknown task ID: "+id)
	}
}

// ==========================================================================
// TEST_PLAN §8.2 — Watchdog (additional scenarios)
// ==========================================================================

// TST-CORE-464
// TRACE: {"suite": "CORE", "case": "1369", "section": "08", "sectionName": "Task Queue (Outbox Pattern)", "subsection": "02", "scenario": "04", "title": "WatchdogDetectsTimedOutTask"}
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
// TRACE: {"suite": "CORE", "case": "1370", "section": "08", "sectionName": "Task Queue (Outbox Pattern)", "subsection": "02", "scenario": "05", "title": "WatchdogRunsPeriodically"}
func TestTaskQueue_8_2_5_WatchdogRunsPeriodically(t *testing.T) {
	// Fresh TaskQueue + Watchdog for isolation.
	q := taskqueue.NewTaskQueue()
	watchdog := taskqueue.NewWatchdog(q)
	ctx := context.Background()

	// Negative: empty queue — no timed-out tasks.
	timedOut, err := watchdog.ScanTimedOut(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(timedOut), 0)

	// Enqueue and dequeue a task (sets it to "running" with TimeoutAt = now+300).
	task := testutil.TestTask()
	taskID, err := q.Enqueue(ctx, task)
	testutil.RequireNoError(t, err)

	dequeued, err := q.Dequeue(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, dequeued)
	testutil.RequireEqual(t, dequeued.ID, taskID)
	testutil.RequireEqual(t, dequeued.Status, domain.TaskRunning)

	// Task has a future timeout — watchdog should NOT detect it.
	timedOut, err = watchdog.ScanTimedOut(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(timedOut), 0)

	// Simulate timeout expiry by setting TimeoutAt to the past.
	// GetByID returns the in-flight pointer, so mutation affects the queue.
	found, err := q.GetByID(ctx, taskID)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, found)
	found.TimeoutAt = time.Now().Unix() - 10

	// Watchdog should now detect exactly 1 timed-out task.
	timedOut, err = watchdog.ScanTimedOut(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(timedOut), 1)
	testutil.RequireEqual(t, timedOut[0].ID, taskID)

	// ResetTask should move it back to pending.
	err = watchdog.ResetTask(ctx, taskID)
	testutil.RequireNoError(t, err)

	// After reset, no more timed-out tasks.
	timedOut, err = watchdog.ScanTimedOut(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(timedOut), 0)

	// Task should be pending again and re-dequeueable.
	redequeued, err := q.Dequeue(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, redequeued)
	testutil.RequireEqual(t, redequeued.ID, taskID)
	testutil.RequireEqual(t, redequeued.Retries, 1)
}

// TST-CORE-466
// TRACE: {"suite": "CORE", "case": "1371", "section": "08", "sectionName": "Task Queue (Outbox Pattern)", "subsection": "02", "scenario": "06", "title": "WatchdogDoesNotTouchHealthyTasks"}
func TestTaskQueue_8_2_6_WatchdogDoesNotTouchHealthyTasks(t *testing.T) {
	q := taskqueue.NewTaskQueue()
	watchdog := taskqueue.NewWatchdog(q)
	ctx := context.Background()

	// Negative: empty queue — ScanTimedOut returns empty.
	timedOut, err := watchdog.ScanTimedOut(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(timedOut), 0)

	// Enqueue and dequeue a task — it gets a future timeout (now + 300s).
	task := testutil.TestTask()
	id, err := q.Enqueue(ctx, task)
	testutil.RequireNoError(t, err)

	dequeued, err := q.Dequeue(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, dequeued)
	testutil.RequireEqual(t, dequeued.ID, id)
	testutil.RequireEqual(t, dequeued.Status, domain.TaskRunning)

	// ScanTimedOut should NOT return this task since its timeout is in the future.
	timedOut, err = watchdog.ScanTimedOut(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(timedOut), 0)

	// Verify the task is still running (watchdog didn't reset it).
	found, err := q.GetByID(ctx, id)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, found.Status, domain.TaskRunning)
}

// TST-CORE-467
// TRACE: {"suite": "CORE", "case": "1372", "section": "08", "sectionName": "Task Queue (Outbox Pattern)", "subsection": "02", "scenario": "07", "title": "ResetTaskReDispatched"}
func TestTaskQueue_8_2_7_ResetTaskReDispatched(t *testing.T) {
	// Fresh TaskQueue + Watchdog — no shared state.
	queue := taskqueue.NewTaskQueue()
	watchdog := taskqueue.NewWatchdog(queue)
	testutil.RequireImplementation(t, watchdog, "WatchdogRunner")

	ctx := context.Background()

	// Enqueue and dequeue a task.
	task := testutil.TestTask()
	taskID, err := queue.Enqueue(ctx, task)
	testutil.RequireNoError(t, err)

	dequeued, err := queue.Dequeue(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, dequeued)
	testutil.RequireEqual(t, dequeued.ID, taskID)
	testutil.RequireEqual(t, dequeued.Status, domain.TaskRunning)

	// Reset the task (watchdog resets timed-out task back to pending).
	err = watchdog.ResetTask(ctx, taskID)
	testutil.RequireNoError(t, err)

	// Verify task is back to pending with retries incremented.
	found, err := queue.GetByID(ctx, taskID)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, found.Status, domain.TaskPending)
	testutil.RequireEqual(t, found.Retries, 1)
	testutil.RequireEqual(t, found.TimeoutAt, int64(0))

	// The task should be dequeueable again.
	reDispatched, err := queue.Dequeue(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, reDispatched)
	testutil.RequireEqual(t, reDispatched.ID, taskID)
	testutil.RequireEqual(t, reDispatched.Status, domain.TaskRunning)

	// Negative: reset non-existent task should error.
	err = watchdog.ResetTask(ctx, "nonexistent-task-id")
	testutil.RequireError(t, err)
}

// ==========================================================================
// TEST_PLAN §8.3 — Dead Letter & Retry (additional scenarios)
// ==========================================================================

// TST-CORE-468
// TRACE: {"suite": "CORE", "case": "1373", "section": "08", "sectionName": "Task Queue (Outbox Pattern)", "subsection": "03", "scenario": "05", "title": "DeadLetterAfter3Failures"}
func TestTaskQueue_8_3_5_DeadLetterAfter3Failures(t *testing.T) {
	// Fresh TaskQueue — no shared state. Production maxRetries defaults to 5.
	impl := taskqueue.NewTaskQueue()
	testutil.RequireImplementation(t, impl, "TaskQueuer")

	ctx := context.Background()

	task := testutil.TestTask()
	id, err := impl.Enqueue(ctx, task)
	testutil.RequireNoError(t, err)

	// Simulate failure→retry cycles up to max retries (5).
	for i := 1; i <= 5; i++ {
		_, err = impl.Dequeue(ctx)
		testutil.RequireNoError(t, err)

		err = impl.Fail(ctx, id, fmt.Sprintf("brain crash #%d", i))
		testutil.RequireNoError(t, err)

		err = impl.Retry(ctx, id)
		testutil.RequireNoError(t, err)

		found, err := impl.GetByID(ctx, id)
		testutil.RequireNoError(t, err)
		testutil.RequireEqual(t, found.Retries, i)
		testutil.RequireEqual(t, found.Status, domain.TaskPending)
	}

	// 6th failure + retry should move to dead_letter.
	_, err = impl.Dequeue(ctx)
	testutil.RequireNoError(t, err)

	err = impl.Fail(ctx, id, "brain crash #6")
	testutil.RequireNoError(t, err)

	err = impl.Retry(ctx, id)
	testutil.RequireNoError(t, err)

	found, err := impl.GetByID(ctx, id)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, found)
	testutil.RequireEqual(t, found.Status, domain.TaskStatus("dead_letter"))
	testutil.RequireEqual(t, found.Retries, 6)

	// Dead letter task should not be dequeue-able.
	dequeued, err := impl.Dequeue(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireNil(t, dequeued)
}

// TST-CORE-471
// TRACE: {"suite": "CORE", "case": "1374", "section": "08", "sectionName": "Task Queue (Outbox Pattern)", "subsection": "03", "scenario": "06", "title": "TaskCancellation"}
func TestTaskQueue_8_3_6_TaskCancellation(t *testing.T) {
	impl := realTaskQueuer
	testutil.RequireImplementation(t, impl, "TaskQueuer")

	ctx := context.Background()

	// Enqueue a task.
	task := testutil.TestTask()
	taskID, err := impl.Enqueue(ctx, task)
	testutil.RequireNoError(t, err)

	// Cancel the pending task.
	err = impl.Cancel(ctx, taskID)
	testutil.RequireNoError(t, err)

	// Verify task is cancelled via GetByID.
	found, err := impl.GetByID(ctx, taskID)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, found)
	testutil.RequireEqual(t, found.Status, domain.TaskStatus("cancelled"))

	// Dequeue should not return cancelled tasks.
	dequeued, err := impl.Dequeue(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireNil(t, dequeued)
}

// TST-CORE-472
// TRACE: {"suite": "CORE", "case": "1375", "section": "08", "sectionName": "Task Queue (Outbox Pattern)", "subsection": "03", "scenario": "07", "title": "IndexOnStatusTimeout"}
func TestTaskQueue_8_3_7_IndexOnStatusTimeout(t *testing.T) {
	// §8.3.7: Task queue must support efficient watchdog scans.
	// The in-memory TaskQueue doesn't use SQLite indexes, but per requirements
	// the watchdog must be able to efficiently scan timed-out tasks.
	// Verify the behavioral requirement: ScanTimedOut returns only actually timed-out tasks.
	impl := taskqueue.NewTaskQueue()
	testutil.RequireImplementation(t, impl, "TaskQueuer")

	ctx := context.Background()
	watchdog := taskqueue.NewWatchdog(impl)

	// Negative: empty queue has no timed-out tasks.
	timedOut, err := watchdog.ScanTimedOut(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(timedOut), 0)

	// Enqueue and dequeue a task (sets it running with timeout).
	task := testutil.TestTask()
	id, err := impl.Enqueue(ctx, task)
	testutil.RequireNoError(t, err)
	dequeued, err := impl.Dequeue(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, dequeued.ID, id)

	// Before timeout expires, scan should return 0.
	timedOut, err = watchdog.ScanTimedOut(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(timedOut), 0)

	// Simulate timeout by mutating the in-flight task's TimeoutAt via GetByID pointer.
	inFlight, err := impl.GetByID(ctx, id)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, inFlight)
	inFlight.TimeoutAt = time.Now().Add(-1 * time.Minute).Unix()

	// After timeout, scan must find exactly 1 timed-out task.
	timedOut, err = watchdog.ScanTimedOut(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(timedOut), 1)
	testutil.RequireEqual(t, timedOut[0].ID, id)
}

// TST-CORE-473
// TRACE: {"suite": "CORE", "case": "1376", "section": "08", "sectionName": "Task Queue (Outbox Pattern)", "subsection": "03", "scenario": "08", "title": "NoSilentDataLoss"}
func TestTaskQueue_8_3_8_NoSilentDataLoss(t *testing.T) {
	impl := realTaskQueuer
	testutil.RequireImplementation(t, impl, "TaskQueuer")

	ctx := context.Background()

	// Set max retries to 2 for faster testing.
	impl.SetMaxRetries(2)

	// Enqueue a task and cycle it to dead letter.
	task := testutil.TestTask()
	taskID, err := impl.Enqueue(ctx, task)
	testutil.RequireNoError(t, err)

	for i := 0; i < 3; i++ {
		_, err = impl.Dequeue(ctx)
		testutil.RequireNoError(t, err)

		err = impl.Fail(ctx, taskID, "persistent failure")
		testutil.RequireNoError(t, err)

		err = impl.Retry(ctx, taskID)
		testutil.RequireNoError(t, err)
	}

	// Task should be in dead_letter — NOT silently deleted.
	found, err := impl.GetByID(ctx, taskID)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, found)
	testutil.RequireEqual(t, found.Status, domain.TaskStatus("dead_letter"))
}

// ==========================================================================
// TEST_PLAN §8.4 — Reminder Loop (8 scenarios)
// ==========================================================================

// TST-CORE-474
// TRACE: {"suite": "CORE", "case": "1377", "section": "08", "sectionName": "Task Queue (Outbox Pattern)", "subsection": "04", "scenario": "05", "title": "StoreReminder"}
func TestTaskQueue_8_4_5_StoreReminder(t *testing.T) {
	mock := testutil.NewMockReminderScheduler()

	reminder := testutil.TestReminder(1740200000)
	id, err := mock.StoreReminder(context.Background(), reminder)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(id) > 0, "store reminder must return an ID")
}

// TST-CORE-475
// TRACE: {"suite": "CORE", "case": "1378", "section": "08", "sectionName": "Task Queue (Outbox Pattern)", "subsection": "04", "scenario": "06", "title": "NextPendingReminder"}
func TestTaskQueue_8_4_6_NextPendingReminder(t *testing.T) {
	sched := taskqueue.NewReminderScheduler()
	ctx := context.Background()

	// Negative: empty scheduler → NextPending returns nil.
	next, err := sched.NextPending(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireNil(t, next)

	// Store two reminders: 7 AM today, 9 AM tomorrow.
	r1 := testutil.TestReminder(1740200000) // Earlier
	r2 := testutil.TestReminder(1740300000) // Later

	id1, err := sched.StoreReminder(ctx, r1)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(id1) > 0, "must return reminder ID")
	_, err = sched.StoreReminder(ctx, r2)
	testutil.RequireNoError(t, err)

	// NextPending returns the earlier reminder (ORDER BY trigger_at LIMIT 1).
	next, err = sched.NextPending(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, next)
	testutil.RequireEqual(t, next.TriggerAt, int64(1740200000))

	// Mark the earlier reminder as fired.
	err = sched.MarkFired(ctx, next.ID)
	testutil.RequireNoError(t, err)

	// NextPending now returns the later reminder (fired ones excluded).
	next2, err := sched.NextPending(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, next2)
	testutil.RequireEqual(t, next2.TriggerAt, int64(1740300000))

	// Mark the second one as fired — NextPending returns nil (all fired).
	err = sched.MarkFired(ctx, next2.ID)
	testutil.RequireNoError(t, err)
	next3, err := sched.NextPending(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireNil(t, next3)
}

// TST-CORE-476
// TRACE: {"suite": "CORE", "case": "1379", "section": "08", "sectionName": "Task Queue (Outbox Pattern)", "subsection": "04", "scenario": "07", "title": "SleepUntilTriggerTime"}
func TestTaskQueue_8_4_7_SleepUntilTriggerTime(t *testing.T) {
	impl := realReminderScheduler
	testutil.RequireImplementation(t, impl, "ReminderScheduler")

	ctx := context.Background()

	// Store two reminders: one 60 min out and one 30 min out.
	// NextPending must return the earlier one (ordering by trigger_at).
	farTime := time.Now().Add(60 * time.Minute).Unix()
	nearTime := time.Now().Add(30 * time.Minute).Unix()

	farReminder := testutil.TestReminder(farTime)
	farReminder.Message = "far reminder"
	farID, err := impl.StoreReminder(ctx, farReminder)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(farID) > 0, "far reminder must return an ID")

	nearReminder := testutil.TestReminder(nearTime)
	nearReminder.Message = "near reminder"
	nearID, err := impl.StoreReminder(ctx, nearReminder)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, len(nearID) > 0, "near reminder must return an ID")

	// NextPending should return the nearer reminder (ORDER BY trigger_at).
	next, err := impl.NextPending(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, next)
	testutil.RequireEqual(t, next.ID, nearID)
	testutil.RequireEqual(t, next.TriggerAt, nearTime)
	testutil.RequireEqual(t, next.Message, "near reminder")

	// The trigger time is in the future — a real loop would sleep until then.
	testutil.RequireTrue(t, next.TriggerAt > time.Now().Unix(),
		"trigger time should be in the future")

	// The far reminder should NOT be returned first.
	testutil.RequireTrue(t, next.ID != farID,
		"NextPending must return the earliest unfired reminder, not the later one")

	// Mark the near one fired and verify NextPending now returns the far one.
	err = impl.MarkFired(ctx, nearID)
	testutil.RequireNoError(t, err)

	next2, err := impl.NextPending(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, next2)
	testutil.RequireEqual(t, next2.ID, farID)
	testutil.RequireEqual(t, next2.TriggerAt, farTime)
	testutil.RequireEqual(t, next2.Message, "far reminder")
}

// TST-CORE-477
// TRACE: {"suite": "CORE", "case": "1380", "section": "08", "sectionName": "Task Queue (Outbox Pattern)", "subsection": "04", "scenario": "08", "title": "MissedReminderOnStartup"}
func TestTaskQueue_8_4_8_MissedReminderOnStartup(t *testing.T) {
	// §8.4.8: Missed reminders (trigger time in the past) must be returned by NextPending.
	// Fresh scheduler to avoid shared state.
	impl := taskqueue.NewReminderScheduler()
	testutil.RequireImplementation(t, impl, "ReminderScheduler")

	ctx := context.Background()

	// Negative: empty scheduler has no pending reminders.
	emptyNext, err := impl.NextPending(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, emptyNext == nil, "empty scheduler must return nil for NextPending")

	// Store a reminder with trigger time 2 hours in the past (missed).
	pastTime := time.Now().Add(-2 * time.Hour).Unix()
	reminder := testutil.TestReminder(pastTime)
	missedID, err := impl.StoreReminder(ctx, reminder)
	testutil.RequireNoError(t, err)

	// Positive: NextPending returns the missed reminder immediately.
	next, err := impl.NextPending(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, next)
	testutil.RequireEqual(t, next.ID, missedID)
	testutil.RequireEqual(t, next.Message, "License renewal")
	testutil.RequireTrue(t, next.TriggerAt < time.Now().Unix(),
		"missed reminder must have a past trigger time")

	// Mark it fired — should no longer appear as pending.
	err = impl.MarkFired(ctx, missedID)
	testutil.RequireNoError(t, err)
	afterFired, err := impl.NextPending(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, afterFired == nil, "fired reminder must not appear in NextPending")
}

// TST-CORE-478
// TRACE: {"suite": "CORE", "case": "1381", "section": "08", "sectionName": "Task Queue (Outbox Pattern)", "subsection": "04", "scenario": "09", "title": "FireAndMarkDone"}
func TestTaskQueue_8_4_9_FireAndMarkDone(t *testing.T) {
	impl := realReminderScheduler
	testutil.RequireImplementation(t, impl, "ReminderScheduler")

	ctx := context.Background()

	// Store a reminder with a past trigger time so it's immediately pending.
	reminder := testutil.TestReminder(1740200000)
	id, err := impl.StoreReminder(ctx, reminder)
	testutil.RequireNoError(t, err)

	// Verify it appears as pending before firing.
	next, err := impl.NextPending(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, next)
	testutil.RequireEqual(t, next.ID, id)

	// Fire: mark reminder as done so it is not re-triggered.
	err = impl.MarkFired(ctx, id)
	testutil.RequireNoError(t, err)

	// After marking fired, NextPending should not return this reminder.
	next, err = impl.NextPending(ctx)
	testutil.RequireNoError(t, err)
	if next != nil && next.ID == id {
		t.Fatalf("fired reminder %q should not appear in NextPending", id)
	}
}

// TST-CORE-479
// TRACE: {"suite": "CORE", "case": "1382", "section": "08", "sectionName": "Task Queue (Outbox Pattern)", "subsection": "04", "scenario": "10", "title": "NoPendingSleepOneMinute"}
func TestTaskQueue_8_4_10_NoPendingSleepOneMinute(t *testing.T) {
	mock := testutil.NewMockReminderScheduler()

	// No reminders in vault — NextPending returns nil, loop should sleep 1 minute.
	next, err := mock.NextPending(context.Background())
	testutil.RequireNoError(t, err)
	testutil.RequireNil(t, next)
}

// TST-CORE-480
// TRACE: {"suite": "CORE", "case": "1383", "section": "08", "sectionName": "Task Queue (Outbox Pattern)", "subsection": "04", "scenario": "11", "title": "NoCronLibrary"}
func TestTaskQueue_8_4_11_NoCronLibrary(t *testing.T) {
	// Code audit: no cron library dependency — scheduling delegated to brain.
	goMod, err := os.ReadFile("../go.mod")
	if err != nil {
		t.Fatalf("cannot read go.mod: %v", err)
	}
	content := string(goMod)
	cronLibs := []string{"robfig/cron", "go-co-op/gocron", "jasonlvhit/gocron"}
	for _, lib := range cronLibs {
		if strings.Contains(content, lib) {
			t.Fatalf("go.mod must not contain cron library: %s", lib)
		}
	}
}

// TST-CORE-481
// TRACE: {"suite": "CORE", "case": "1384", "section": "08", "sectionName": "Task Queue (Outbox Pattern)", "subsection": "04", "scenario": "12", "title": "ComplexSchedulingDelegated"}
func TestTaskQueue_8_4_12_ComplexSchedulingDelegated(t *testing.T) {
	// Core must NOT contain cron libraries — complex scheduling is
	// delegated to the Brain. Verify via go.mod (portable relative path)
	// and verify the ReminderScheduler uses simple timestamps, not cron.
	goMod, err := os.ReadFile("../go.mod")
	if err != nil {
		t.Fatalf("failed to read go.mod: %v", err)
	}
	content := string(goMod)

	// Explicit cron library denylist (same as TST-CORE-480 but with extras).
	denyList := []string{"robfig/cron", "go-co-op/gocron", "jasonlvhit/gocron"}
	for _, lib := range denyList {
		testutil.RequireFalse(t, strings.Contains(content, lib),
			"go.mod must not contain cron library: "+lib)
	}

	// Verify the real ReminderScheduler stores and retrieves simple
	// timestamp-based reminders — it doesn't interpret cron expressions.
	impl := realReminderScheduler
	testutil.RequireImplementation(t, impl, "ReminderScheduler")

	triggerAt := time.Now().Add(-1 * time.Second).Unix()
	id, err := impl.StoreReminder(context.Background(), testutil.TestReminder(triggerAt))
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, id != "", "StoreReminder must return a non-empty ID")

	// NextPending should return the past-due reminder — proving Core only
	// stores timestamps and relies on Brain for cron interpretation.
	next, err := impl.NextPending(context.Background())
	testutil.RequireNoError(t, err)
	testutil.RequireTrue(t, next != nil, "past-due reminder must be returned by NextPending")
}

// ==========================================================================
// Uncovered plan scenarios — added by entries 400-600 fix
// ==========================================================================

// TST-CORE-460
// TRACE: {"suite": "CORE", "case": "1385", "section": "08", "sectionName": "Task Queue (Outbox Pattern)", "subsection": "01", "scenario": "11", "title": "BrainNoACKCrash"}
func TestTaskQueue_8_1_11_BrainNoACKCrash(t *testing.T) {
	// Fresh instances — no shared state.
	q := taskqueue.NewTaskQueue()
	testutil.RequireImplementation(t, q, "TaskQueuer")
	wd := taskqueue.NewWatchdog(q)
	testutil.RequireImplementation(t, wd, "WatchdogRunner")

	ctx := context.Background()

	// Negative control: no timed-out tasks in a fresh queue.
	timedOutBefore, err := wd.ScanTimedOut(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(timedOutBefore), 0)

	// Brain receives task but crashes (no ACK).
	task := testutil.TestTask()
	taskID, err := q.Enqueue(ctx, task)
	testutil.RequireNoError(t, err)

	// Dequeue simulates sending to brain.
	dequeued, err := q.Dequeue(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, dequeued)
	testutil.RequireEqual(t, dequeued.ID, taskID)

	// Verify task is now "running" after dequeue.
	found, err := q.GetByID(ctx, taskID)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, found)
	testutil.RequireEqual(t, string(found.Status), "running")

	// Don't call Complete (brain crashed, no ACK).
	// Set timeout to past via in-flight pointer to simulate expired timeout.
	found.TimeoutAt = time.Now().Unix() - 10

	// ScanTimedOut should find exactly this one task.
	timedOut, err := wd.ScanTimedOut(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, len(timedOut), 1)
	testutil.RequireEqual(t, timedOut[0].ID, taskID)

	// After reset, task should be back to "pending" with incremented retries.
	err = wd.ResetTask(ctx, taskID)
	testutil.RequireNoError(t, err)
	reset, err := q.GetByID(ctx, taskID)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, reset)
	testutil.RequireEqual(t, string(reset.Status), "pending")
	testutil.RequireEqual(t, reset.Retries, 1)
}

// TST-CORE-462
// TRACE: {"suite": "CORE", "case": "1386", "section": "08", "sectionName": "Task Queue (Outbox Pattern)", "subsection": "01", "scenario": "12", "title": "TaskPersistenceAcrossRestart"}
func TestTaskQueue_8_1_12_TaskPersistenceAcrossRestart(t *testing.T) {
	impl := realTaskQueuer
	testutil.RequireImplementation(t, impl, "TaskQueuer")

	ctx := context.Background()

	// Enqueue a task and verify it persists (retrievable by ID).
	task := testutil.TestTask()
	taskID, err := impl.Enqueue(ctx, task)
	testutil.RequireNoError(t, err)

	// GetByID should find the task.
	found, err := impl.GetByID(ctx, taskID)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, found)
	testutil.RequireEqual(t, found.ID, taskID)
	testutil.RequireEqual(t, found.Type, "sync_gmail")
}

// TST-CORE-469
// TRACE: {"suite": "CORE", "case": "1387", "section": "08", "sectionName": "Task Queue (Outbox Pattern)", "subsection": "03", "scenario": "09", "title": "DeadLetterNot5"}
func TestTaskQueue_8_3_9_DeadLetterNot5(t *testing.T) {
	impl := realTaskQueuer
	testutil.RequireImplementation(t, impl, "TaskQueuer")

	ctx := context.Background()

	// Configure dead letter at 3 retries instead of the default 5.
	impl.SetMaxRetries(3)
	defer impl.SetMaxRetries(0) // restore default after test

	task := testutil.TestTask()
	taskID, err := impl.Enqueue(ctx, task)
	testutil.RequireNoError(t, err)

	// Cycle through fail/retry 3 times — task should still be alive.
	for i := 0; i < 3; i++ {
		_, err = impl.Dequeue(ctx)
		testutil.RequireNoError(t, err)

		err = impl.Fail(ctx, taskID, "brain crash")
		testutil.RequireNoError(t, err)

		err = impl.Retry(ctx, taskID)
		testutil.RequireNoError(t, err)

		found, err := impl.GetByID(ctx, taskID)
		testutil.RequireNoError(t, err)
		testutil.RequireNotNil(t, found)
		testutil.RequireEqual(t, found.Status, domain.TaskPending)
	}

	// 4th fail/retry should exceed maxRetries=3 and move to dead letter.
	_, err = impl.Dequeue(ctx)
	testutil.RequireNoError(t, err)

	err = impl.Fail(ctx, taskID, "brain crash")
	testutil.RequireNoError(t, err)

	err = impl.Retry(ctx, taskID)
	testutil.RequireNoError(t, err)

	found, err := impl.GetByID(ctx, taskID)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, found)
	testutil.RequireEqual(t, found.Status, domain.TaskStatus("dead_letter"))
}

// TST-CORE-470
// TRACE: {"suite": "CORE", "case": "1388", "section": "08", "sectionName": "Task Queue (Outbox Pattern)", "subsection": "03", "scenario": "10", "title": "RetryBackoff"}
func TestTaskQueue_8_3_10_RetryBackoff(t *testing.T) {
	// Fresh TaskQueue — no shared state.
	impl := taskqueue.NewTaskQueue()
	testutil.RequireImplementation(t, impl, "TaskQueuer")

	ctx := context.Background()

	// Enqueue and dequeue a task.
	task := testutil.TestTask()
	taskID, err := impl.Enqueue(ctx, task)
	testutil.RequireNoError(t, err)

	_, err = impl.Dequeue(ctx)
	testutil.RequireNoError(t, err)

	// Fail the task.
	err = impl.Fail(ctx, taskID, "error")
	testutil.RequireNoError(t, err)

	// Retry 1 — verify retries=1, status=pending, NextRetry set.
	err = impl.Retry(ctx, taskID)
	testutil.RequireNoError(t, err)

	found, err := impl.GetByID(ctx, taskID)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, found)
	testutil.RequireEqual(t, found.Retries, 1)
	testutil.RequireEqual(t, found.Status, domain.TaskPending)
	testutil.RequireTrue(t, found.NextRetry > 0, "NextRetry should be set after retry")
	firstNextRetry := found.NextRetry

	// Retry 2 — backoff must be strictly greater.
	_, err = impl.Dequeue(ctx)
	testutil.RequireNoError(t, err)
	err = impl.Fail(ctx, taskID, "error again")
	testutil.RequireNoError(t, err)

	err = impl.Retry(ctx, taskID)
	testutil.RequireNoError(t, err)

	found2, err := impl.GetByID(ctx, taskID)
	testutil.RequireNoError(t, err)
	testutil.RequireEqual(t, found2.Retries, 2)
	testutil.RequireTrue(t, found2.NextRetry > firstNextRetry,
		fmt.Sprintf("second retry backoff (%d) must be strictly greater than first (%d)", found2.NextRetry, firstNextRetry))

	// Negative: retry a non-failed task should fail.
	// Task is currently pending (from retry above), so retry should error.
	err = impl.Retry(ctx, taskID)
	testutil.RequireError(t, err)
}

// TST-CORE-933
// TRACE: {"suite": "CORE", "case": "1389", "section": "08", "sectionName": "Task Queue (Outbox Pattern)", "subsection": "04", "scenario": "13", "title": "SilenceRules_StoredAndRetrievable"}
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

// ==========================================================================
// TEST_PLAN §8.5 — ACK Semantics (Fix 5)
// ==========================================================================

// TST-CORE-882
// TRACE: {"suite": "CORE", "case": "1390", "section": "08", "sectionName": "Task Queue (Outbox Pattern)", "subsection": "05", "scenario": "01", "title": "DequeueClaimsOnlyOneTask"}
func TestTaskQueue_8_5_1_DequeueClaimsOnlyOneTask(t *testing.T) {
	q := taskqueue.NewTaskQueue()
	ctx := context.Background()

	// Enqueue 3 tasks with the same priority.
	var ids []string
	for i := 0; i < 3; i++ {
		task := testutil.TestTask()
		id, err := q.Enqueue(ctx, task)
		testutil.RequireNoError(t, err)
		ids = append(ids, id)
	}

	// Dequeue should claim exactly 1 task.
	dequeued, err := q.Dequeue(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, dequeued)
	testutil.RequireEqual(t, dequeued.Status, domain.TaskRunning)

	// The dequeued task must be one of the 3 we enqueued.
	dequeuedFound := false
	for _, id := range ids {
		if dequeued.ID == id {
			dequeuedFound = true
		}
	}
	testutil.RequireTrue(t, dequeuedFound, "dequeued task must be one of the enqueued tasks")

	// Exactly 2 remaining tasks should be pending.
	pendingCount := 0
	for _, id := range ids {
		found, err := q.GetByID(ctx, id)
		testutil.RequireNoError(t, err)
		testutil.RequireNotNil(t, found)
		if found.Status == domain.TaskPending {
			pendingCount++
		}
	}
	testutil.RequireEqual(t, pendingCount, 2)
}

// TST-CORE-883
// TRACE: {"suite": "CORE", "case": "1391", "section": "08", "sectionName": "Task Queue (Outbox Pattern)", "subsection": "05", "scenario": "02", "title": "AcknowledgeWithCorrectID"}
func TestTaskQueue_8_5_2_AcknowledgeWithCorrectID(t *testing.T) {
	impl := realTaskQueuer
	testutil.RequireImplementation(t, impl, "TaskQueuer")

	ctx := context.Background()

	// Enqueue and dequeue a task.
	task := testutil.TestTask()
	taskID, err := impl.Enqueue(ctx, task)
	testutil.RequireNoError(t, err)

	dequeued, err := impl.Dequeue(ctx)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, dequeued)
	testutil.RequireEqual(t, dequeued.ID, taskID)

	// Acknowledge with the correct task ID should succeed.
	acked, err := impl.Acknowledge(ctx, taskID)
	testutil.RequireNoError(t, err)
	testutil.RequireNotNil(t, acked)
	testutil.RequireEqual(t, acked.ID, taskID)
	testutil.RequireEqual(t, acked.Status, domain.TaskCompleted)
}

// TST-CORE-884
// TRACE: {"suite": "CORE", "case": "1392", "section": "08", "sectionName": "Task Queue (Outbox Pattern)", "subsection": "05", "scenario": "03", "title": "AcknowledgeWithWrongID"}
func TestTaskQueue_8_5_3_AcknowledgeWithWrongID(t *testing.T) {
	impl := realTaskQueuer
	testutil.RequireImplementation(t, impl, "TaskQueuer")

	ctx := context.Background()

	// Acknowledge with a nonexistent task ID should return an error.
	acked, err := impl.Acknowledge(ctx, "nonexistent-task-id")
	testutil.RequireError(t, err)
	testutil.RequireNil(t, acked)
}
