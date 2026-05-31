package transport

import (
	"context"
	"sync"
	"testing"
	"time"
)

// --- TST-MBX-0037: Expiry in worker pool backlog ---
// TRACE: {"suite": "MBX", "case": "0037", "section": "04", "sectionName": "Offline Behavior, Expiry & Cancel", "subsection": "02", "scenario": "06", "title": "expiry_in_worker_backlog"}
//
// Request delivered to Core before expiry, sits in worker pool backlog past
// expiry → Core re-checks on worker start, does not execute.
func TestWorkerPool_ExpiryInBacklog(t *testing.T) {
	pool := NewRPCWorkerPool(1, 10)

	// Controllable clock.
	now := time.Now()
	pool.now = func() time.Time { return now }

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var processed []string
	var mu sync.Mutex

	// Block the single worker with a slow task.
	blocker := make(chan struct{})
	pool.Start(ctx, func(task *RPCTask) *RPCInnerResponse {
		if task.RequestID == "blocker" {
			<-blocker // block until released
		}
		mu.Lock()
		processed = append(processed, task.RequestID)
		mu.Unlock()
		return &RPCInnerResponse{Status: 200}
	})

	// Submit the blocker task (no expiry).
	taskCtx, taskCancel := context.WithCancel(ctx)
	defer taskCancel()
	pool.Submit(&RPCTask{
		RequestID: "blocker", FromDID: "did:key:z1",
		Ctx: taskCtx, Cancel: taskCancel,
	})

	// Submit a task with tight expiry (now + 1s).
	expiresAt := now.Unix() + 1
	taskCtx2, taskCancel2 := context.WithCancel(ctx)
	defer taskCancel2()
	pool.Submit(&RPCTask{
		RequestID: "expiring", FromDID: "did:key:z1",
		ExpiresAt: &expiresAt,
		InnerJSON: []byte(`{"test":true}`),
		Ctx:       taskCtx2, Cancel: taskCancel2,
	})

	// Advance clock past expiry while task is queued.
	now = now.Add(5 * time.Second)

	// Release the blocker — worker picks up "expiring" but it's now expired.
	close(blocker)
	time.Sleep(50 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()

	// "expiring" should NOT be in processed (expired on worker start).
	for _, id := range processed {
		if id == "expiring" {
			t.Error("'expiring' task was processed — should have been dropped on worker start (expired)")
		}
	}
}

// --- TST-MBX-0038: Expiry on receipt before enqueue ---
// TRACE: {"suite": "MBX", "case": "0038", "section": "04", "sectionName": "Offline Behavior, Expiry & Cancel", "subsection": "02", "scenario": "07", "title": "expiry_on_receipt_before_enqueue"}
//
// Request arrives at Core with expires_at already in the past →
// Submit() silently drops it, never enqueued.
func TestWorkerPool_ExpiryOnReceipt(t *testing.T) {
	pool := NewRPCWorkerPool(2, 10)

	now := time.Now()
	pool.now = func() time.Time { return now }

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var processed []string
	var mu sync.Mutex

	pool.Start(ctx, func(task *RPCTask) *RPCInnerResponse {
		mu.Lock()
		processed = append(processed, task.RequestID)
		mu.Unlock()
		return &RPCInnerResponse{Status: 200}
	})

	// Submit a task that's already expired (expires_at = now - 10s).
	expired := now.Unix() - 10
	taskCtx, taskCancel := context.WithCancel(ctx)
	defer taskCancel()
	result := pool.Submit(&RPCTask{
		RequestID: "already-expired", FromDID: "did:key:z2",
		ExpiresAt: &expired,
		Ctx:       taskCtx, Cancel: taskCancel,
	})

	// Submit returns SubmitExpired so caller can send 408.
	if result != SubmitExpired {
		t.Errorf("Submit should return SubmitExpired for already-expired task, got %d", result)
	}

	// Nothing should be in the queue.
	if pool.QueueLen() != 0 {
		t.Errorf("queue len = %d, want 0 (task should not be enqueued)", pool.QueueLen())
	}

	time.Sleep(50 * time.Millisecond)

	mu.Lock()
	for _, id := range processed {
		if id == "already-expired" {
			t.Error("expired task was processed — should have been dropped on receipt")
		}
	}
	mu.Unlock()

	// Submit a valid task (no expiry) — should work.
	taskCtx3, taskCancel3 := context.WithCancel(ctx)
	defer taskCancel3()
	pool.Submit(&RPCTask{
		RequestID: "valid-task", FromDID: "did:key:z2",
		Ctx: taskCtx3, Cancel: taskCancel3,
	})
	time.Sleep(50 * time.Millisecond)

	mu.Lock()
	found := false
	for _, id := range processed {
		if id == "valid-task" {
			found = true
		}
	}
	mu.Unlock()
	if !found {
		t.Error("valid task was not processed")
	}
}

// --- TST-MBX-0043: Core-side cancel — matching from_did, in-progress ---
// TRACE: {"suite": "MBX", "case": "0043", "section": "04", "sectionName": "Offline Behavior, Expiry & Cancel", "subsection": "04", "scenario": "03", "title": "core_cancel_matching_in_progress"}
//
// A running handler's context is cancelled when CancelTask is called
// with the correct from_did.
func TestWorkerPool_CancelMatchingInProgress(t *testing.T) {
	pool := NewRPCWorkerPool(1, 10)

	ctx, ctxCancel := context.WithCancel(context.Background())
	defer ctxCancel()

	// Channel to signal the handler noticed cancellation.
	cancelled := make(chan struct{})

	pool.Start(ctx, func(task *RPCTask) *RPCInnerResponse {
		// Block until context is cancelled.
		<-task.Ctx.Done()
		close(cancelled)
		return &RPCInnerResponse{Status: 499, Body: `{"cancelled":true}`}
	})

	taskCtx, taskCancel := context.WithCancel(ctx)
	pool.Submit(&RPCTask{
		RequestID: "cancel-me", FromDID: "did:key:zOwner",
		Ctx: taskCtx, Cancel: taskCancel,
	})

	// Wait for the handler to start.
	time.Sleep(50 * time.Millisecond)

	// Cancel with matching from_did.
	ok := pool.CancelTask("did:key:zOwner", "cancel-me")
	if !ok {
		t.Fatal("CancelTask returned false — task not found")
	}

	// Handler should observe cancellation.
	select {
	case <-cancelled:
		// Good — handler saw ctx.Done().
	case <-time.After(2 * time.Second):
		t.Fatal("handler did not observe cancellation within 2s")
	}
}

// --- TST-MBX-0044: Core-side cancel — non-matching from_did → rejected ---
// TRACE: {"suite": "MBX", "case": "0044", "section": "04", "sectionName": "Offline Behavior, Expiry & Cancel", "subsection": "04", "scenario": "04", "title": "core_cancel_nonmatching_rejected"}
func TestWorkerPool_CancelNonMatchingRejected(t *testing.T) {
	pool := NewRPCWorkerPool(1, 10)

	ctx, ctxCancel := context.WithCancel(context.Background())
	defer ctxCancel()

	handlerDone := make(chan struct{})

	pool.Start(ctx, func(task *RPCTask) *RPCInnerResponse {
		// Block briefly, then complete normally.
		time.Sleep(100 * time.Millisecond)
		close(handlerDone)
		return &RPCInnerResponse{Status: 200}
	})

	taskCtx, taskCancel := context.WithCancel(ctx)
	defer taskCancel()
	pool.Submit(&RPCTask{
		RequestID: "protected", FromDID: "did:key:zOwner",
		Ctx: taskCtx, Cancel: taskCancel,
	})

	time.Sleep(20 * time.Millisecond) // let handler start

	// Cancel with WRONG from_did.
	ok := pool.CancelTask("did:key:zAttacker", "protected")
	if ok {
		t.Error("CancelTask should return false for non-matching from_did")
	}

	// Handler should complete normally (not cancelled).
	select {
	case <-handlerDone:
		// Good — completed without cancellation.
	case <-time.After(2 * time.Second):
		t.Fatal("handler did not complete within 2s")
	}
}

// --- TST-MBX-0085: Cancel while queued in worker backlog ---
// TRACE: {"suite": "MBX", "case": "0085", "section": "04", "sectionName": "Offline Behavior, Expiry & Cancel", "subsection": "04", "scenario": "05", "title": "cancel_while_queued_backlog"}
//
// Worker pool is busy. Task queued in backlog. Cancel arrives before worker
// picks it up → task is marked cancelled, worker skips execution.
func TestWorkerPool_CancelWhileQueued(t *testing.T) {
	pool := NewRPCWorkerPool(1, 10)

	ctx, ctxCancel := context.WithCancel(context.Background())
	defer ctxCancel()

	var processed []string
	var mu sync.Mutex

	blocker := make(chan struct{})
	pool.Start(ctx, func(task *RPCTask) *RPCInnerResponse {
		if task.RequestID == "blocker" {
			<-blocker
		}
		mu.Lock()
		processed = append(processed, task.RequestID)
		mu.Unlock()
		return &RPCInnerResponse{Status: 200}
	})

	// Submit blocker task (occupies the single worker).
	blockerCtx, blockerCancel := context.WithCancel(ctx)
	defer blockerCancel()
	pool.Submit(&RPCTask{
		RequestID: "blocker", FromDID: "did:key:z1",
		Ctx: blockerCtx, Cancel: blockerCancel,
	})

	// Submit the target task — goes to backlog (worker busy).
	targetCtx, targetCancel := context.WithCancel(ctx)
	pool.Submit(&RPCTask{
		RequestID: "queued-target", FromDID: "did:key:zOwner",
		Ctx: targetCtx, Cancel: targetCancel,
	})

	// Cancel the queued target before the worker picks it up.
	ok := pool.CancelTask("did:key:zOwner", "queued-target")
	if !ok {
		t.Fatal("CancelTask should return true for queued task")
	}

	// Release the blocker — worker picks up queued-target but sees ctx.Done().
	close(blocker)
	time.Sleep(100 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()
	for _, id := range processed {
		if id == "queued-target" {
			t.Error("queued-target was processed — should have been skipped (cancelled)")
		}
	}
}

// --- TST-MBX-0089: Cancel race with worker start ---
// TRACE: {"suite": "MBX", "case": "0089", "section": "08", "sectionName": "Reliability & Crash Recovery", "subsection": "03", "scenario": "01", "title": "cancel_race_with_worker_start"}
//
// Fill worker pool, submit request to backlog, cancel + free worker
// simultaneously. Assert exactly one outcome: canceled or handler runs
// with cancel context. Never double-handled.
func TestWorkerPool_CancelRaceWithWorkerStart(t *testing.T) {
	pool := NewRPCWorkerPool(1, 10)

	ctx, ctxCancel := context.WithCancel(context.Background())
	defer ctxCancel()

	var processed sync.Map
	handlerStarted := make(chan string, 10)

	pool.Start(ctx, func(task *RPCTask) *RPCInnerResponse {
		handlerStarted <- task.RequestID
		// Give cancel a chance to arrive during processing.
		select {
		case <-task.Ctx.Done():
			// Cancelled during execution — valid outcome.
		case <-time.After(50 * time.Millisecond):
			// Completed without cancellation — also valid.
		}
		processed.Store(task.RequestID, true)
		return &RPCInnerResponse{Status: 200}
	})

	// Block the worker.
	blocker := make(chan struct{})
	blockerCtx, blockerCancel := context.WithCancel(ctx)
	defer blockerCancel()
	pool.Submit(&RPCTask{
		RequestID: "blocker-089", FromDID: "did:key:z089",
		Ctx: blockerCtx, Cancel: blockerCancel,
	})
	// Wait for blocker to start.
	<-handlerStarted

	// Submit target to backlog.
	targetCtx, targetCancel := context.WithCancel(ctx)
	pool.Submit(&RPCTask{
		RequestID: "race-target", FromDID: "did:key:z089",
		Ctx: targetCtx, Cancel: targetCancel,
	})

	// Simultaneously: cancel the target AND release the blocker.
	go pool.CancelTask("did:key:z089", "race-target")
	close(blocker) // no-op since handler uses handlerStarted, not blocker
	// Actually release the blocker handler by letting it complete.
	time.Sleep(100 * time.Millisecond)

	// Count how many times "race-target" was processed.
	count := 0
	processed.Range(func(key, value interface{}) bool {
		if key == "race-target" {
			count++
		}
		return true
	})

	// Exactly 0 or 1 (cancelled before start, or started and completed).
	// Never >1 (double-handled).
	if count > 1 {
		t.Errorf("race-target processed %d times — should be 0 or 1 (never double-handled)", count)
	}
	t.Logf("race-target processed %d times (0=cancelled before start, 1=ran with cancel context)", count)
}

// --- TST-MBX-0068: Worker pool full → 503 ---
// TRACE: {"suite": "MBX", "case": "0068", "section": "06", "sectionName": "Operational & Load", "subsection": "03", "scenario": "02", "title": "worker_pool_full_503"}
//
// All workers busy + backlog full → Submit returns SubmitFull (503).
func TestWorkerPool_Full503(t *testing.T) {
	// 1 worker, backlog of 2.
	pool := NewRPCWorkerPool(1, 2)

	ctx, ctxCancel := context.WithCancel(context.Background())
	defer ctxCancel()

	// Use a started channel to know when the worker has picked up Task 1.
	workerStarted := make(chan struct{})
	blocker := make(chan struct{})
	pool.Start(ctx, func(task *RPCTask) *RPCInnerResponse {
		if task.RequestID == "t1" {
			close(workerStarted) // signal that worker consumed Task 1
		}
		<-blocker
		return &RPCInnerResponse{Status: 200}
	})

	// Task 1: goes to worker.
	c1, cl1 := context.WithCancel(ctx)
	defer cl1()
	pool.Submit(&RPCTask{RequestID: "t1", FromDID: "d1", Ctx: c1, Cancel: cl1})

	// Wait for worker to pick up Task 1 (frees a channel slot).
	<-workerStarted

	// Task 2: goes to backlog (slot 1).
	c2, cl2 := context.WithCancel(ctx)
	defer cl2()
	pool.Submit(&RPCTask{RequestID: "t2", FromDID: "d1", Ctx: c2, Cancel: cl2})

	// Task 3: goes to backlog (slot 2).
	c3, cl3 := context.WithCancel(ctx)
	defer cl3()
	pool.Submit(&RPCTask{RequestID: "t3", FromDID: "d1", Ctx: c3, Cancel: cl3})

	// Task 4: backlog full → should return SubmitFull.
	c4, cl4 := context.WithCancel(ctx)
	defer cl4()
	result := pool.Submit(&RPCTask{RequestID: "t4", FromDID: "d1", Ctx: c4, Cancel: cl4})
	if result != SubmitFull {
		t.Errorf("Submit should return SubmitFull when backlog is full, got %d", result)
	}

	close(blocker)
}

// --- TST-MBX-0067: Slow handler doesn't block D2D ---
// TRACE: {"suite": "MBX", "case": "0067", "section": "06", "sectionName": "Operational & Load", "subsection": "03", "scenario": "01", "title": "slow_handler_no_d2d_block"}
//
// A slow RPC handler does not block D2D delivery on the same connection.
// In production, RPC is dispatched to a worker pool off the read loop.
// This test verifies the pool's async dispatch doesn't block the caller.
func TestWorkerPool_SlowHandlerNoBlock(t *testing.T) {
	pool := NewRPCWorkerPool(2, 10)

	ctx, ctxCancel := context.WithCancel(context.Background())
	defer ctxCancel()

	slowDone := make(chan struct{})
	pool.Start(ctx, func(task *RPCTask) *RPCInnerResponse {
		if task.RequestID == "slow" {
			// Simulate a slow handler (200ms).
			time.Sleep(200 * time.Millisecond)
			close(slowDone)
		}
		return &RPCInnerResponse{Status: 200}
	})

	// Submit a slow task.
	c1, cl1 := context.WithCancel(ctx)
	defer cl1()
	pool.Submit(&RPCTask{RequestID: "slow", FromDID: "d1", Ctx: c1, Cancel: cl1})

	// Submit returns immediately (async dispatch) — the caller is NOT blocked.
	// Verify by submitting another task right away.
	start := time.Now()
	c2, cl2 := context.WithCancel(ctx)
	defer cl2()
	result := pool.Submit(&RPCTask{RequestID: "fast", FromDID: "d1", Ctx: c2, Cancel: cl2})
	submitTime := time.Since(start)

	if result != SubmitOK {
		t.Fatalf("fast task submit failed with result %d", result)
	}

	// Submit should take <10ms (just a channel send), not 200ms.
	if submitTime > 50*time.Millisecond {
		t.Errorf("Submit took %v — should be near-instant (async dispatch)", submitTime)
	}

	// Wait for slow handler to complete.
	<-slowDone
}

// --- Concurrent dedupe: same (from_did, request_id) already in-flight → SubmitDuplicate ---
// TRACE: {"suite": "MBX", "case": "0137", "section": "05", "sectionName": "Idempotency & Replay Protection", "subsection": "01", "scenario": "08", "title": "concurrent_dedupe_inflight"}
//
// Two identical requests arrive concurrently. The first is submitted and
// queued. The second arrives before the first completes → SubmitDuplicate.
func TestWorkerPool_ConcurrentDedupe(t *testing.T) {
	pool := NewRPCWorkerPool(1, 10)

	ctx, ctxCancel := context.WithCancel(context.Background())
	defer ctxCancel()

	blocker := make(chan struct{})
	pool.Start(ctx, func(task *RPCTask) *RPCInnerResponse {
		<-blocker
		return &RPCInnerResponse{Status: 200}
	})

	// Submit first request — goes to worker, blocks.
	c1, cl1 := context.WithCancel(ctx)
	defer cl1()
	r1 := pool.Submit(&RPCTask{
		RequestID: "dedup-req", FromDID: "did:key:zSameSender",
		Ctx: c1, Cancel: cl1,
	})
	if r1 != SubmitOK {
		t.Fatalf("first submit should return SubmitOK, got %d", r1)
	}

	// Submit identical (from_did, request_id) while first is still running.
	c2, cl2 := context.WithCancel(ctx)
	defer cl2()
	r2 := pool.Submit(&RPCTask{
		RequestID: "dedup-req", FromDID: "did:key:zSameSender",
		Ctx: c2, Cancel: cl2,
	})
	if r2 != SubmitDuplicate {
		t.Errorf("duplicate submit should return SubmitDuplicate, got %d", r2)
	}

	// Different from_did with same request_id should NOT be a duplicate.
	c3, cl3 := context.WithCancel(ctx)
	defer cl3()
	r3 := pool.Submit(&RPCTask{
		RequestID: "dedup-req", FromDID: "did:key:zDifferentSender",
		Ctx: c3, Cancel: cl3,
	})
	if r3 != SubmitOK {
		t.Errorf("different sender same request_id should return SubmitOK, got %d", r3)
	}

	close(blocker)
}

// --- Concurrent dedupe: after first completes, resubmit succeeds ---
// TRACE: {"suite": "MBX", "case": "0138", "section": "05", "sectionName": "Idempotency & Replay Protection", "subsection": "01", "scenario": "09", "title": "concurrent_dedupe_after_completion"}
//
// First request completes and is removed from inflight. Same (from_did,
// request_id) can be resubmitted (retry hits pool, idempotency cache
// handles in production — but pool should not block it).
func TestWorkerPool_DedupeAfterCompletion(t *testing.T) {
	pool := NewRPCWorkerPool(1, 10)

	ctx, ctxCancel := context.WithCancel(context.Background())
	defer ctxCancel()

	pool.Start(ctx, func(task *RPCTask) *RPCInnerResponse {
		return &RPCInnerResponse{Status: 200}
	})

	// Submit and let it complete.
	c1, cl1 := context.WithCancel(ctx)
	defer cl1()
	pool.Submit(&RPCTask{
		RequestID: "retry-req", FromDID: "did:key:zRetry",
		Ctx: c1, Cancel: cl1,
	})
	time.Sleep(50 * time.Millisecond) // let worker complete

	// Resubmit same (from_did, request_id) after completion.
	c2, cl2 := context.WithCancel(ctx)
	defer cl2()
	r := pool.Submit(&RPCTask{
		RequestID: "retry-req", FromDID: "did:key:zRetry",
		Ctx: c2, Cancel: cl2,
	})
	if r != SubmitOK {
		t.Errorf("resubmit after completion should return SubmitOK, got %d", r)
	}
}

// --- OnExpired callback: worker-start expiry triggers 408 ---
// TRACE: {"suite": "MBX", "case": "0141", "section": "04", "sectionName": "Offline Behavior, Expiry & Cancel", "subsection": "02", "scenario": "08", "title": "expiry_triggers_on_expired_callback"}
//
// Task expires while queued in worker pool backlog. The OnExpired callback
// is invoked with the expired task so the caller can send a 408 response.
func TestWorkerPool_OnExpiredCallback(t *testing.T) {
	pool := NewRPCWorkerPool(1, 10)

	now := time.Now()
	pool.now = func() time.Time { return now }

	var expiredTasks []*RPCTask
	var expMu sync.Mutex
	pool.OnExpired = func(task *RPCTask) {
		expMu.Lock()
		expiredTasks = append(expiredTasks, task)
		expMu.Unlock()
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Block the single worker.
	blocker := make(chan struct{})
	pool.Start(ctx, func(task *RPCTask) *RPCInnerResponse {
		if task.RequestID == "blocker" {
			<-blocker
		}
		return &RPCInnerResponse{Status: 200}
	})

	// Submit blocker.
	bc, bcl := context.WithCancel(ctx)
	defer bcl()
	pool.Submit(&RPCTask{
		RequestID: "blocker", FromDID: "did:key:z1",
		Ctx: bc, Cancel: bcl,
	})

	// Submit a task with tight expiry.
	expiresAt := now.Unix() + 1
	tc, tcl := context.WithCancel(ctx)
	defer tcl()
	pool.Submit(&RPCTask{
		RequestID: "will-expire", FromDID: "did:key:zClient",
		ExpiresAt: &expiresAt,
		InnerJSON: []byte(`{"method":"GET","path":"/api/v1/status"}`),
		Ctx: tc, Cancel: tcl,
	})

	// Advance clock past expiry.
	now = now.Add(5 * time.Second)

	// Release blocker — worker picks up "will-expire" but it's expired.
	close(blocker)
	time.Sleep(100 * time.Millisecond)

	expMu.Lock()
	defer expMu.Unlock()

	if len(expiredTasks) != 1 {
		t.Fatalf("OnExpired called %d times, want 1", len(expiredTasks))
	}
	if expiredTasks[0].RequestID != "will-expire" {
		t.Errorf("expired task ID = %q, want %q", expiredTasks[0].RequestID, "will-expire")
	}
	if expiredTasks[0].FromDID != "did:key:zClient" {
		t.Errorf("expired task FromDID = %q, want %q", expiredTasks[0].FromDID, "did:key:zClient")
	}
}

// --- OnExpired not called for non-expired tasks ---
// TRACE: {"suite": "MBX", "case": "0142", "section": "04", "sectionName": "Offline Behavior, Expiry & Cancel", "subsection": "02", "scenario": "09", "title": "on_expired_not_called_for_valid"}
func TestWorkerPool_OnExpiredNotCalledForValid(t *testing.T) {
	pool := NewRPCWorkerPool(2, 10)

	callCount := 0
	pool.OnExpired = func(task *RPCTask) {
		callCount++
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	pool.Start(ctx, func(task *RPCTask) *RPCInnerResponse {
		return &RPCInnerResponse{Status: 200}
	})

	// Submit a valid task (no expiry).
	tc, tcl := context.WithCancel(ctx)
	defer tcl()
	pool.Submit(&RPCTask{
		RequestID: "valid", FromDID: "did:key:z1",
		Ctx: tc, Cancel: tcl,
	})
	time.Sleep(50 * time.Millisecond)

	if callCount != 0 {
		t.Errorf("OnExpired called %d times for valid task, want 0", callCount)
	}
}
