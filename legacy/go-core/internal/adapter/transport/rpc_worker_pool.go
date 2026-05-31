// rpc_worker_pool.go — Bounded worker pool for async RPC dispatch.
//
// RPC requests from MsgBox are dispatched to a bounded goroutine pool
// to avoid blocking the WebSocket read loop. If the pool is full, the
// request is rejected with 503.
package transport

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

// SubmitResult indicates the outcome of RPCWorkerPool.Submit.
type SubmitResult int

const (
	SubmitOK        SubmitResult = iota // submitted successfully
	SubmitFull                          // backlog full — caller should respond 503
	SubmitDuplicate                     // same (from_did, request_id) already in-flight — caller should respond 409
	SubmitExpired                       // already expired on receipt — caller should respond 408
)

// RPCWorkerPool dispatches RPC requests to a bounded set of workers.
// Thread-safe. Injectable clock for expiry testing.
type RPCWorkerPool struct {
	workers int
	backlog int
	queue   chan *RPCTask
	now     func() time.Time

	mu       sync.Mutex
	inflight map[string]*RPCTask // from_did:request_id → task (for cancel + dedupe)

	// OnExpired is called when a task expires while queued in the backlog
	// (between Submit and worker start). The caller wires this to send a
	// 408 response so the CLI doesn't wait forever. Optional (nil = silent drop).
	OnExpired func(task *RPCTask)
}

// RPCTask represents a queued or in-progress RPC request.
type RPCTask struct {
	RequestID string
	FromDID   string
	ExpiresAt *int64
	InnerJSON []byte
	Ctx       context.Context
	Cancel    context.CancelFunc
	State     string // "queued", "running", "completed"
}

// NewRPCWorkerPool creates a pool with the given worker count and backlog.
func NewRPCWorkerPool(workers, backlog int) *RPCWorkerPool {
	return &RPCWorkerPool{
		workers:  workers,
		backlog:  backlog,
		queue:    make(chan *RPCTask, backlog),
		now:      time.Now,
		inflight: make(map[string]*RPCTask),
	}
}

// Submit enqueues a task. Returns SubmitOK on success (or silent expiry drop),
// SubmitFull if the backlog is full (503), or SubmitDuplicate if the same
// (from_did, request_id) is already queued or running (409).
func (p *RPCWorkerPool) Submit(task *RPCTask) SubmitResult {
	// MBX-019: Check expiry on receipt — reject with explicit status so
	// the caller can send a 408 instead of leaving the CLI hanging.
	if task.ExpiresAt != nil && *task.ExpiresAt < p.now().Unix() {
		return SubmitExpired
	}

	key := task.FromDID + ":" + task.RequestID

	p.mu.Lock()
	// Concurrent dedupe: reject if same (from_did, request_id) is already in-flight.
	if existing, ok := p.inflight[key]; ok && existing.State != "completed" {
		p.mu.Unlock()
		return SubmitDuplicate
	}
	task.State = "queued"
	p.inflight[key] = task
	p.mu.Unlock()

	select {
	case p.queue <- task:
		return SubmitOK
	default:
		// Backlog full.
		p.mu.Lock()
		delete(p.inflight, key)
		p.mu.Unlock()
		return SubmitFull
	}
}

// Start launches the worker goroutines. Each worker pulls tasks from the
// queue, checks expiry again (may have expired while queued), then calls
// the handler function.
func (p *RPCWorkerPool) Start(ctx context.Context, handler func(*RPCTask) *RPCInnerResponse) {
	for i := 0; i < p.workers; i++ {
		go func() {
			for {
				select {
				case <-ctx.Done():
					return
				case task := <-p.queue:
					p.mu.Lock()
					task.State = "running"
					p.mu.Unlock()

					// MBX-020: Re-check expiry on worker start.
					if task.ExpiresAt != nil && *task.ExpiresAt < p.now().Unix() {
						if p.OnExpired != nil {
							p.OnExpired(task)
						}
						p.mu.Lock()
						task.State = "completed"
						delete(p.inflight, task.FromDID+":"+task.RequestID)
						p.mu.Unlock()
						continue // expired while queued
					}

					// Check if cancelled while queued.
					select {
					case <-task.Ctx.Done():
						p.mu.Lock()
						task.State = "completed"
						delete(p.inflight, task.FromDID+":"+task.RequestID)
						p.mu.Unlock()
						continue
					default:
					}

					func() {
						defer func() {
							if r := recover(); r != nil {
								slog.Error("rpc_worker.panic", "id", task.RequestID, "from", task.FromDID, "panic", r)
							}
						}()
						_ = handler(task)
					}()

					p.mu.Lock()
					task.State = "completed"
					delete(p.inflight, task.FromDID+":"+task.RequestID)
					p.mu.Unlock()
				}
			}
		}()
	}
}

// QueueLen returns the current number of queued (not yet started) tasks.
func (p *RPCWorkerPool) QueueLen() int {
	return len(p.queue)
}

// GetInflight returns the task for a given key, or nil.
func (p *RPCWorkerPool) GetInflight(fromDID, requestID string) *RPCTask {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.inflight[fromDID+":"+requestID]
}

// CancelTask attempts to cancel a task. Returns true if the task was found
// and cancelled (queued or running). Returns false if not found (already
// completed or never submitted). Ownership is verified: cancelFromDID must
// match the task's FromDID.
func (p *RPCWorkerPool) CancelTask(cancelFromDID, requestID string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()

	key := cancelFromDID + ":" + requestID
	task, ok := p.inflight[key]
	if !ok {
		return false // not found — already completed or never submitted
	}

	// Ownership check: cancelFromDID must match task.FromDID.
	if task.FromDID != cancelFromDID {
		return false // ownership mismatch
	}

	// Cancel the task's context. If running, the handler can check ctx.Done().
	// If queued, the worker will see ctx.Done() before starting.
	task.Cancel()
	return true
}
