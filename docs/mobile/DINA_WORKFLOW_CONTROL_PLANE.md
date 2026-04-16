# Dina Workflow Control Plane — Durable Tasks, Timers, Approvals, Delegations (v1)

**Status:** Dina-specific design target, not a direct extraction from `claw-code` runtime behavior. This document is lightly inspired by runtime registries, worker boot state, task packets, and the broader `claw-code` coordination philosophy, but the durable control plane described here does not exist as such in either `claw-code` or current Dina. · **Audience:** Dina Mobile and Basic Dina teams · **Scope:** everything that outlives a single agent turn — durable work items, timers, approval flows, watches, external delegation lifecycle, and the machinery that re-enters the kernel when asynchronous work completes.

## Document Suite

- **[DINA_ARCHITECTURE_OVERVIEW.md](./DINA_ARCHITECTURE_OVERVIEW.md)** — the map.
- **[DINA_AGENT_KERNEL.md](./DINA_AGENT_KERNEL.md)** — the synchronous turn loop.
- **DINA_WORKFLOW_CONTROL_PLANE.md** — this document.
- **[DINA_DELEGATION_CONTRACT.md](./DINA_DELEGATION_CONTRACT.md)** — wire protocol to external execution planes.

## Provenance and Reading Contract

This document should be read as a **Dina architecture proposal**.

- It is **not** a faithful summary of an existing `claw-code` subsystem.
- It is **not** a claim that current Dina already has this control plane.
- It is a design target motivated by real Dina needs: long-running state, wakeups, approvals, retries, durable correlation, and external delegation.

Reference inputs are limited and indirect:

- `claw-code/rust/crates/runtime/src/task_registry.rs` — useful as a warning about what an in-memory task registry can and cannot do.
- `claw-code/rust/crates/runtime/src/worker_boot.rs` — useful for wake/recovery state-machine thinking.
- `claw-code/rust/crates/runtime/src/task_packet.rs` — useful for explicit task/delegation contracts.
- `claw-code/PHILOSOPHY.md` — useful for the larger coordination lesson, not as a runtime implementation reference.

## Provenance Summary

| Area | Classification | Notes |
|------|----------------|-------|
| Durable task model, wake reasons, watches, obligations | **[Dina addition]** | Needed by Dina; not present as a comparable durable subsystem in `claw-code` |
| Approval flow and re-entry semantics | **[Dina addition]** | Dina-specific integration problem across Brain/Core/UI |
| Retry, idempotency, audit, backup/export | **[Dina addition]** | Product architecture, not a direct runtime borrowing |
| Result ingestion router and delegation lifecycle | **[Dina addition]** | Motivated by Dina's async and inter-agent needs |
| Task-state-machine vocabulary | Mixed, loosely reference-inspired | Loosely inspired by runtime registries and repo coordination concepts, but redesigned here for app-grade durability |

Unless a section explicitly says otherwise, patterns in this document should be read as **[Dina addition]**.

## Current Dina Alignment

Current Dina has pieces of async state, but not the unified control plane described here:

- `core/internal/service/task.go` — internal Core to Brain queue
- `core/internal/port/delegated_task.go` — durable delegated-work model for external claim/lease execution
- approval persistence and service-specific async flows live in separate paths

That means this doc should guide future consolidation work. It should not be treated as a description of today's implementation.

## Preface — Why the Kernel Alone Is Insufficient

The Dina Agent Kernel runs one turn at a time. A turn begins with user input (or a control-plane trigger), streams through the LLM, executes tools, and commits to the session. When the turn ends, the kernel is done.

But Dina's real value is in work that **outlives a turn**:

- A reminder fires at 9 AM tomorrow and Dina should act on it.
- A user says "let me think about it" after a send_email proposal; Dina holds the approval for three days.
- A public-service watch for a court case update has been running for six months; when an update arrives, Dina must react.
- Dina delegates a complex research task to OpenClaw; the result comes back 40 minutes later.
- A subscription to an external event stream (calendar, inbox, pricing) produces events that Dina must triage.

None of these fit inside the turn loop. They require:

1. **Durable state** — outlives process restarts, app kills, device reboots.
2. **Wake semantics** — something triggers Dina to act again (a timer, an event, a callback, a human).
3. **Correlation** — asynchronous results match back to original intent.
4. **Policy** — retries, timeouts, cancellation, idempotency.
5. **Re-entry** — when work completes, the kernel is invoked again with appropriate context.

This document specifies that layer.

## Cross-Cutting Principles

1. **Durable first, ephemeral second.** Any state that could matter after a crash is persisted before being acted on. The control plane is the authoritative store; the kernel holds a read-through cache via session `StructuredState` (kernel point 11).

2. **Correlation IDs are mandatory.** Every work item, every delegation, every wake-up has a correlation ID. Results flow back by ID, not by timing or order.

3. **Idempotent operations.** Every operation that the control plane initiates can be safely retried. If a delegation is already running, re-issuing it is a no-op. If a reminder has already fired, re-triggering it produces no duplicate action.

4. **Wake reasons are first-class.** When the kernel is re-entered from the control plane, it receives a `WakeReason` structure explaining *why* this turn is happening. The agent sees this in the environment section, reasoned about like any other fact.

5. **User priority.** User-initiated turns always preempt background processing. A watch-event-triggered turn never runs while a user turn is pending.

6. **Observable by default.** Every control-plane action emits structured events (to audit log, telemetry, and optionally to a dev UI). There are no silent operations.

7. **Control-plane state is part of the backup/export surface.** When the user exports their Dina data, control-plane state travels with it. Importing to a new device recreates pending work.

## Component Map

```
┌─────────────────────────────────────────────────────────────┐
│                   Dina Application                          │
│                                                             │
│  ┌──────────────────┐         ┌─────────────────────────┐  │
│  │   UI / Chat      │◄───────►│   Agent Kernel (turns)  │  │
│  └──────────────────┘         └──────────┬──────────────┘  │
│                                          │ reads/writes    │
│                                          ▼                 │
│                               ┌─────────────────────────┐  │
│                               │  Session + State Cache  │  │
│                               └──────────┬──────────────┘  │
│                                          │                 │
│  ┌──────────────────────────────────────▼──────────────┐  │
│  │             Workflow Control Plane                   │  │
│  │                                                      │  │
│  │   ┌──────────┐  ┌──────────┐  ┌─────────────────┐   │  │
│  │   │ TaskQueue│  │ Scheduler│  │ ApprovalStore   │   │  │
│  │   └─────┬────┘  └─────┬────┘  └────────┬────────┘   │  │
│  │         │             │                │            │  │
│  │   ┌─────▼─────────────▼────────────────▼────────┐   │  │
│  │   │       Durable State (SQLite / files)        │   │  │
│  │   └──────────────────┬───────────────────────────┘  │  │
│  │                      │                              │  │
│  │   ┌──────────┐  ┌────▼──────┐  ┌───────────────┐   │  │
│  │   │ WatchMgr │  │ DelegMgr  │  │ IngestRouter  │   │  │
│  │   └──────────┘  └────┬──────┘  └───────┬───────┘   │  │
│  └─────────────────────┬┴─────────────────┬───────────┘  │
│                        │                  │              │
└────────────────────────┼──────────────────┼──────────────┘
                         │                  │
                         ▼                  ▲
              ┌─────────────────────────────────────┐
              │ External Execution Planes            │
              │ (OpenClaw, MCP servers, webhooks)    │
              └─────────────────────────────────────┘
```

---

## Section A — Durable State Model

### Entity types.

1. **Task** — a unit of work with lifecycle states. Spans from creation (by agent or user) to terminal outcome.
2. **ApprovalRequest** — a specific subtype tied to the action lifecycle (kernel point 22a). Blocks execution of a proposed action until resolved.
3. **Delegation** — a specific subtype representing outbound work sent to an external execution plane (OpenClaw, MCP).
4. **Watch** — a long-lived subscription to external events.
5. **Timer** — a wakeup scheduled at a specific time.
6. **Obligation** — an implicit promise captured from conversation ("I'll check once the meeting is confirmed") that the control plane tracks even without an explicit structured task.

### Task state machine.

```
          created
             │
             ▼
        pending ─────────► cancelled
             │
             ▼
        running ─┬──────► succeeded ────► recorded
             │   │
             │   ├──────► failed (retryable) ──► scheduled_retry ──► running
             │   │
             │   └──────► failed (terminal) ───► recorded
             │
             ▼
        awaiting ──────► (external event / approval / timer)
                    │
                    └──► running (on wake)
```

Each state transition is a persisted event with timestamp, reason, actor.

### Canonical Task shape.

```json
{
  "task_id": "task_01H...",
  "type": "delegation" | "approval" | "watch" | "timer" | "obligation" | "generic",
  "state": "pending" | "running" | "awaiting" | "succeeded" | "failed" | "cancelled" | "recorded",
  "title": "Draft email to Alice about rescheduling",
  "created_at_ms": 1744670400000,
  "updated_at_ms": 1744671000000,
  "created_by": { "kind": "agent" | "user" | "system", "session_id": "sess_01H..." },
  "correlation_id": "corr_01H...",
  "parent_task_id": "task_01H..." | null,
  "priority": "user_blocking" | "normal" | "background",
  "persona": "general" | "health" | ...,
  "payload": { /* type-specific */ },
  "policy": {
    "max_wall_clock_ms": 86400000,
    "max_retries": 3,
    "retry_backoff_ms": [1000, 5000, 30000],
    "idempotency_key": "idem_..."
  },
  "history": [
    { "at_ms": ..., "event": "created", "by": {...}, "details": {...} },
    { "at_ms": ..., "event": "state_transition", "from": "pending", "to": "running" },
    ...
  ],
  "result": null | { "success": bool, "payload": {...}, "received_at_ms": ... }
}
```

### Storage.

- **TS (Mobile):** SQLite table `control_plane_tasks` with columns mirroring the shape above. JSON payload column for type-specific data. Indexes on `state`, `type`, `correlation_id`, `priority`.
- **Python (Basic Dina):** SQLite (or Postgres for larger deployments) with same schema.
- Both: history is append-only (separate `task_events` table, FK to task_id) for audit integrity.

### State deltas into session.

When control-plane state changes affect a session (new approval pending, delegation returned, watch fired), a `state_delta` record is appended to the session's JSONL (kernel point 23). The kernel's read-through cache of structured state is updated.

---

## Section B — Patterns (1–18)

### 1. Task Creation API (load-bearing)

**Pattern.** Tasks are created either by the kernel (agent-initiated during a turn) or by external entry points (user manual action, system events). Every creation returns a `task_id` immediately and emits an audit event.

**Kernel-initiated example.** During a turn, the agent proposes `send_email` (action lifecycle, kernel 22a). The action lifecycle machinery creates an `approval` task and returns immediately (sync in-turn) or stores it and returns synthetic result (async).

**User-initiated example.** User says "remind me to call Mom tomorrow at 10 AM." The agent creates a `timer` task. When the timer fires, the control plane triggers a new kernel turn with a `WakeReason` of `timer_fired`.

**API (language-neutral).**
```
create_task(type, payload, policy?, parent_task_id?, session_id?) -> task_id
```

**Idempotency.** `policy.idempotency_key` deduplicates. If a task with the same key and an active (non-terminal) state exists, return its ID without creating a new one. This protects against double-submission from network retries.

---

### 2. Wake Reasons as First-Class Input (load-bearing)

**Pattern.** When the control plane triggers a new kernel turn (not a user-typed turn), it provides a `WakeReason` structure that the kernel injects into the session as part of the user-role message or as a `<system-reminder>`.

**Wake reason types.**
- `user_input` — user typed a message (baseline; not really a "wake")
- `timer_fired` — a scheduled timer fired
- `approval_resolved` — user resolved a pending approval (approved, denied, modified)
- `delegation_returned` — external execution plane returned results
- `watch_event` — a subscribed external event occurred
- `obligation_due` — an inferred obligation's trigger condition is met
- `system_alert` — a control-plane condition requires agent attention (circuit breaker opened, quota exhausted, etc.)

**Wake reason payload example.**
```json
{
  "kind": "timer_fired",
  "task_id": "task_01H...",
  "fired_at_ms": 1744756800000,
  "details": {
    "original_request": "remind me to call Mom tomorrow at 10 AM",
    "scheduled_for_ms": 1744756800000,
    "persona": "general"
  }
}
```

**Injection format (the model sees this in the session).**
```
<system-reminder>
Wake reason: timer_fired
Task: task_01H...
Original request: "remind me to call Mom tomorrow at 10 AM"
Fired at: 2026-04-15 10:00 EDT (on schedule)
Active persona: general
</system-reminder>
```

**Why it matters.** Without an explicit wake reason, an agent triggered by a fired timer would be confused about why it's running. Making it explicit lets the agent act purposefully.

**Golden test.**
```
Given a timer task fires at T
When the control plane triggers a new turn
Then the kernel's session gets a user-role message with the wake reason <system-reminder>
And the model's response acknowledges the trigger accurately
```

---

### 3. Timers and Scheduler (load-bearing)

**Pattern.** Scheduled wake-ups. Each timer is a `task` of `type: timer` with `payload.scheduled_for_ms`. The scheduler polls every N seconds (default 30s; tighter near the next-fire time) and triggers fires at or after the scheduled time.

**Mobile constraints.**
- iOS: foreground timers via `setTimeout`; background via `BackgroundFetch` (iOS decides when — not precise). Use local notifications for user-visible reminders; use background fetch for silent wake-ups.
- Android: `WorkManager` with `OneTimeWorkRequest`. More permissive than iOS.
- Both: timers that fire while app is killed rely on OS-level notifications. When user taps notification, app launches and the control plane reconciles missed fires.

**Server constraints (Basic Dina).**
- Standard cron-like scheduler (APScheduler, Celery Beat, etc.). No OS limitations.

**Catch-up on resume.** When the app/server starts, run `catchup()` which finds all timers with `scheduled_for_ms <= now()` that haven't fired. For each, fire now (optionally with "delayed by Nm" note in the wake reason).

**Idempotency.** Timers fire at most once. Their state machine goes `pending → running (on fire) → succeeded (after kernel turn completes)`. Re-firing a `running` or `succeeded` timer is a no-op.

**Snoozing and modification.** Users can modify a pending timer (change time, change message) via an API that creates a new version and marks the old as `cancelled`. The state machine enforces that only `pending` timers can be modified.

---

### 4. Approval Flow — Sync and Async (load-bearing)

**Pattern.** When the kernel's action lifecycle (point 22a) creates a proposal, two approval modes exist:

**Sync (in-turn).** The turn loop calls `PermissionPrompter.decide()` which blocks until the user responds. The turn proceeds with the result. Suitable for immediate, low-latency proposals.

**Async (cross-turn).** The proposal is stored as an `ApprovalRequest` task with `state: awaiting`. The kernel returns a synthetic tool result: `"proposed; pending user approval (ID apr_X)"`. The turn ends. When the user later resolves (via a notification tap, an in-app action, or an explicit chat message), the control plane triggers a new kernel turn with wake reason `approval_resolved`.

**Decision flow.**

```
When does the kernel pick sync vs async?

If prompter is currently attached (i.e., user is actively in-chat) AND
  estimated_approval_latency_ms < 10000 AND
  action is low-complexity:
    → sync

Else:
    → async
```

Low-complexity = simple send, simple schedule. High-complexity = multi-parameter action, high-stakes (purchase, external contact).

**Async approval timeout.** Each async approval has a `max_wall_clock_ms` (default 24h). When expired, the approval transitions to `failed` with reason `expired`. The original proposing turn was already committed; a new turn is triggered with wake reason `approval_resolved` (expired) so the agent can handle it (notify user, discard, etc.).

**Modification.** User may approve-with-modifications. The modification is captured in the approval's result payload; the subsequent execution uses the modified input.

**UI responsibilities.**
- Immediate approvals: native action sheet with PII-scrubbed payload display (kernel point 22).
- Async approvals: notification + persistent in-app inbox listing all pending approvals with details, approve/deny/modify affordances.

---

### 5. External Delegation Lifecycle (load-bearing)

**Pattern.** Dina outsources heavy or specialized work to external execution planes (OpenClaw, MCP servers, webhook integrations). A delegation is a task with `type: delegation`.

Delegation lifecycle (coordinated with the delegation contract — see that doc for wire format).

```
created ──► outbound ──► awaiting ──┬──► succeeded (result received, validated)
                                     ├──► failed (result received, error)
                                     ├──► timed_out (no result within max_wall_clock_ms)
                                     └──► cancelled (user cancelled)
```

**Outbound phase.** Control plane sends the task packet to the external execution plane (per delegation contract). On success, state becomes `awaiting`. On immediate failure (unreachable, auth fail), state becomes `failed` with retry scheduled if `policy.max_retries > 0`.

**Awaiting phase.** The task is persisted with full context. The app/server can be restarted; on recovery, the control plane reconnects any pending callbacks.

**Result ingestion.** When the external plane POSTs/callbacks a result, the ingest router (Section C) validates, writes it to the task, and triggers a kernel turn with wake reason `delegation_returned`.

**Correlation.** Delegation's `correlation_id` is sent out and must come back with the result. Results without matching correlation IDs are logged as anomalies and quarantined.

**Timeouts.** Delegations have generous timeouts (default 1h; configurable up to 7 days). On timeout, a kernel turn is triggered with wake reason `delegation_returned` (with `success: false, reason: timeout`) so the agent can handle it.

---

### 6. Watches and Subscriptions (load-bearing)

**Pattern.** A watch is a long-lived subscription to an external event stream or polling source. Examples:
- Calendar events for the next 7 days (poll every 5 min)
- Inbox subscription (push via webhook)
- Court case status updates (poll daily)
- Price alerts on a product (poll hourly)
- A specific contact's public posts (poll daily)

Watches are tasks of `type: watch` with `state: running` as their normal steady state. They don't terminate unless the user cancels or the watch's condition is met.

**Watch structure.**
```json
{
  "type": "watch",
  "payload": {
    "source": "calendar" | "inbox" | "external_webhook" | "polling",
    "source_config": { /* source-specific */ },
    "filter": { /* criteria for events that trigger wake */ },
    "wake_policy": "each_event" | "batched" | "significant_only"
  }
}
```

**Event firing.** When a source produces an event matching the filter, the control plane evaluates the wake policy:
- `each_event` — triggers a kernel turn per event (expensive; use for high-value events)
- `batched` — accumulates events and triggers one turn per batching window (hourly/daily)
- `significant_only` — runs a classifier (local, deterministic) to decide if the event is worth waking the agent

Once triggered, wake reason is `watch_event` with the event(s) in the payload.

**Lifecycle.** User can pause, resume, modify, or cancel. Watches survive app restarts; on recovery, the control plane re-registers with sources (e.g., re-subscribes webhooks).

**Cost awareness.** Polling watches consume battery and bandwidth. Mobile watches default to conservative poll intervals (≥5 min for events, ≥1h for reference data). Server watches can be more aggressive.

---

### 7. Obligations — Inferred Tracked Promises (load-bearing)

**Pattern.** Not every commitment is an explicit task. The user often makes or receives implicit promises in conversation ("I'll follow up once we hear from Alice", "Remind me when the deadline gets closer"). Obligations capture these implicit commitments as lightweight tracked entities.

**Detection.** At turn end, a deterministic obligation-extractor analyzes the turn for commitment patterns. If any found, an `obligation` task is created with the inferred condition.

Examples:
- "Once we hear from Alice" → obligation with trigger `{kind: "watch", source: "inbox", filter: {from: alice_did}}`
- "When the deadline gets closer" → obligation with trigger `{kind: "timer", fire_at: deadline - 2d}`
- "If the price drops below $X" → obligation with trigger `{kind: "watch", source: "price_check", filter: {below: X}}`

**User confirmation.** Unlike deterministic tasks (approvals, timers), obligations are inferred. The control plane lists them in the structured state summary (kernel point 11) so the user can see them and confirm/cancel.

**Unfinished obligations in long sessions.** If a session has obligations from turn 3 that are still unresolved at turn 30, the structured state summary in the environment section shows them, preventing drift.

**Explicit demotion.** If the user says "never mind, you don't need to track that", the obligation is cancelled. If the obligation's trigger condition fires, the kernel is triggered with wake reason `obligation_due`.

---

### 8. Result Ingestion Router (load-bearing)

**Pattern.** A central router that receives async results from all sources (delegations, watches, external webhooks, timer fires) and decides what to do with them.

**Router responsibilities.**
1. **Authenticate** the incoming result (signed envelope, correlation match).
2. **Validate** against the task's expected result schema.
3. **Record** the result in the task's `result` field and history.
4. **Decide** whether to trigger a kernel turn immediately, batch, or drop.
5. **Emit** audit events.

**Priority queue.** Ingested results are queued with priority:
- `user_blocking` — approval resolution, direct user action
- `normal` — delegation returns, timer fires
- `background` — watch events (unless marked urgent)

User turns always preempt queue processing. If a user is actively in a turn, background results queue; they fire after the user's turn completes.

**Trigger cadence.** Multiple results for the same session queued close together may be batched into one kernel turn. E.g., three watch events for the same session within 10s → one wake reason of `watch_event` with all three events in payload.

---

### 9. Retry Policy for Async Tasks (production-grade)

**Pattern.** Async task failures retry according to per-task `policy`. Distinct from per-turn retry (kernel point 24).

**Default policies.**
| Task type | Max retries | Backoff |
|-----------|-------------|---------|
| timer (fire delivery) | 5 | exponential, 5s → 5min cap |
| delegation | 3 | exponential, 30s → 30min cap |
| watch (polling) | 10 | linear, 5min between tries |
| approval (no retry — waits forever up to timeout) | 0 | — |
| obligation trigger | 3 | exponential, 5min → 1h cap |

**Retryable vs terminal.** Same classification as kernel point 24 — network, 5xx, rate-limit are retryable; auth, schema, business-logic failures are terminal.

**Circuit breaker.** After N consecutive terminal failures across tasks targeting the same external dependency, open circuit. New tasks targeting that dependency fail immediately with `circuit_open`. Half-open retry after cooldown.

---

### 10. Idempotency and Restartability (production-grade)

**Pattern.** Every control-plane operation is idempotent. The same action invoked twice produces the same outcome.

**Mechanisms.**
- `policy.idempotency_key` on tasks — dedup at creation.
- State machine — transitions are idempotent (state = X is the same whether it was X before or just transitioned to X).
- Results are write-once — attempting to write a result to a task that already has one is a no-op with a warning.
- Callbacks are deduplicated by `(task_id, result_hash)` — same result delivered twice → processed once.

**Restartability.** On app/server restart, `recover()` runs:
1. Find all tasks in non-terminal states.
2. Re-register any external connections (webhooks, watches).
3. Catch up on timers that should have fired.
4. Reconnect to any in-flight delegations (poll for status or re-listen for callbacks).
5. Ingest results that arrived while down.
6. Emit `recovery_complete` audit event.

Recovery is bounded (2-minute timeout). If a dependency can't be reached within recovery, the affected tasks remain in their prior state; kernel turns triggered by them may surface "unable to reach X" to the user.

---

### 11. Priority Queuing and User Preemption (production-grade)

**Pattern.** Three priority classes:
- `user_blocking` — someone is waiting interactively
- `normal` — scheduled work
- `background` — watches, speculative work

**Preemption rule.** If a user turn is pending or active, no background turns run. Normal turns can run concurrently only if they target a different session; same-session concurrency is serialized (kernel point 34).

**Starvation protection.** Background tasks have a max queue age. Tasks older than 4 hours escalate to `normal`. This prevents indefinite deferral during high interactive use.

---

### 12. Structured State Visibility to the Agent (load-bearing)

**Pattern.** At every turn start, the kernel queries the control plane for the current structured state relevant to this session (kernel invariant #9):

```
get_session_state(session_id) -> StructuredState {
  plan: PlanStep[],
  open_tasks: TaskSummary[],
  pending_approvals: ApprovalSummary[],
  pending_delegations: DelegationSummary[],
  watches: WatchSummary[],
  obligations: ObligationSummary[],
}
```

This is rendered into the environment section (kernel point 11) for the model to see.

**Why the control plane is authoritative.** Tasks may be created in session A, relevant to session B. Approvals may be resolved by a system process while the user isn't in a session. Watches fire outside any session. The kernel's local cache is a read-through; the control plane is the truth.

**Budget for state in environment.** Cap at 2000 tokens. If over, prioritize by recency + relevance + urgency; show top items with "N more" hint.

---

### 13. Control-Plane Events and Audit (production-grade)

**Pattern.** Every control-plane operation emits a structured event:

```json
{
  "event_id": "evt_01H...",
  "at_ms": ...,
  "kind": "task_created" | "state_transition" | "result_ingested" | "wake_triggered" | ...,
  "task_id": "task_01H..." | null,
  "session_id": "sess_01H..." | null,
  "details": { /* kind-specific */ }
}
```

Events flow to:
1. Audit log (durable, immutable, exportable as part of user data backup).
2. Telemetry (local counters; optionally cloud telemetry if user opts in).
3. Dev UI (if enabled) — a real-time view of control-plane activity.

**Correlation across layers.** Every event carries the `correlation_id` of the originating request (the agent's tool call, the user's intent, the external trigger). This lets you trace a single operation from user request → agent proposal → delegation → external work → callback → kernel turn → user response.

---

### 14. Cancellation Semantics for Long-Running Tasks (production-grade)

**Pattern.** Every non-terminal task can be cancelled. Cancellation is a state transition that:
1. Emits `cancellation_requested` event.
2. Attempts to cancel the underlying work (abort network call, send SIGTERM to subprocess, unsubscribe from webhook).
3. On cancel success, state transitions to `cancelled`.
4. On cancel failure (work already committed externally), task enters `cancel_pending` and polls until confirmation or timeout.

**User-initiated cancel.** UI exposes cancel for every pending/running task.

**System-initiated cancel.** If the user invalidates a prerequisite (closes persona, removes BYOK key, signs out), dependent tasks are cancelled by the control plane.

**Cascade.** Cancelling a parent task cancels all child tasks.

---

### 15. Backup, Export, and Migration (production-grade)

**Pattern.** Control-plane state is part of user data. The existing Dina archive/export mechanism (from the core's `createArchive` / `readManifest`) must include:
- All tasks (full history, payloads, results)
- All watches (with source credentials encrypted at rest)
- All events (audit log)

Restore on a new device recreates pending work. Timers re-register. Watches reconnect to sources (may require user re-auth for OAuth-based ones). Delegations in flight are surfaced to the user as "these were pending on your old device — resume, cancel, or wait for result?".

---

### 16. Data Retention and Cleanup (observability/advanced)

**Pattern.** Terminal-state tasks accumulate. Policy:
- `succeeded` + recorded → retain for 30 days, then archive (compressed, indexed by search only).
- `failed` → retain for 90 days for debugging.
- `cancelled` → retain for 7 days.
- History events → retain per task's retention + 30 days.

Cleanup runs nightly in background (mobile: during device-charging window; server: off-peak).

---

### 17. Rate Limits and Cost Budgets at Control-Plane Level (production-grade)

**Pattern.** Per-user cost and rate ceilings independent of per-turn budgets (kernel point 27):
- Daily LLM spend ceiling (BYOK per-provider)
- Daily delegation count ceiling
- Per-watch poll frequency floor

When a ceiling is approached, the control plane:
1. Warns the user.
2. Reduces background work aggressiveness (longer poll intervals, defer non-critical obligations).
3. At 100%, pauses background work entirely; user-blocking work still runs.

---

### 18. Observability and Debugging (observability/advanced)

**Pattern.** A dev UI (hidden in production, enabled via settings) surfaces:
- All active tasks with current state, age, last activity
- Event stream (real-time)
- Queue depth per priority class
- Circuit breaker states for each external dependency
- Ingested results awaiting processing

Also: structured log export for support tickets — redacted version of control-plane state that can be attached to a support request.

---

## Cross-Plane Contracts

### Kernel ↔ Control Plane

**Kernel reads.**
- `get_session_state(session_id) → StructuredState` (for environment section)

**Kernel writes.**
- `create_task(type, payload, policy, parent_task_id?, session_id) → task_id`
- `update_plan_step(session_id, step_id, state)` — plan lives in control plane, kernel advances it
- `resolve_approval(approval_id, decision, modified_input?)` — only called for sync approvals

**Kernel is invoked by.**
- User input (baseline)
- Control plane with `WakeReason` (timer, approval, delegation, watch, obligation, system_alert)

### Control Plane ↔ Delegation Contract

See delegation contract document. Summary:
- Control plane sends delegations out via delegation contract wire protocol.
- Control plane receives callbacks and results via the same contract.
- All signing, auth, trust, audit are per the delegation contract.

---

## Implementation Roadmap

### Phase 0 — Align with current Dina reality

- Inventory current async ownership across:
  - `core/internal/service/task.go`
  - `core/internal/port/delegated_task.go`
  - existing approval persistence
  - service-specific in-memory async paths in Brain
- Decide what remains separate, what gets consolidated, and what should **not** become a generic workflow abstraction.
- Explicitly avoid adding a third generic task queue until those boundaries are resolved.

### Phase 1 — Minimum Viable Control Plane (load-bearing)

- Task data model + SQLite storage
- Task creation API + idempotency
- Approval flow (sync and async)
- Timer scheduler (in-foreground only; defer background)
- Wake reason injection into kernel
- Structured state visibility API
- Basic event emission

### Phase 2 — Delegations and Results (load-bearing)

- Delegation lifecycle
- Result ingestion router with auth + correlation
- Retry policy and circuit breaker

### Phase 3 — Watches (load-bearing for full Dina; can defer for v1)

- Watch model + polling engine
- Webhook ingestion (Basic Dina)
- Event classification (significant_only)

### Phase 4 — Obligations (observability/advanced)

- Obligation extractor
- Confirmation UI
- Trigger matching

### Phase 5 — Resilience (production-grade)

- Background timer delivery (iOS BackgroundFetch, Android WorkManager)
- Restart recovery
- Cancellation cascade
- Backup/export/migration

### Phase 6 — Observability (advanced)

- Dev UI
- Support-log export
- Rate and cost budgets

---

## What This Control Plane Does NOT Handle

1. **Multi-user collaboration** — one user, one control plane instance.
2. **Real-time push between devices** — cross-device sync is eventual (seconds to minutes), not real-time.
3. **Guaranteed background delivery on iOS** — iOS controls background execution; local notifications are the reliable surfacing mechanism.
4. **Compensating transactions across external systems** — if a delegation succeeded but we lost track, we can't automatically "undo" at the external side. Human intervention required.
5. **Predictive pre-fetching** — watches poll or subscribe; they don't anticipate user needs unprompted.

---

**Document version:** 1.0 · **Last updated:** 2026-04-14 · **Scope:** durable state, timers, approvals, delegations, watches, obligations, ingestion.
