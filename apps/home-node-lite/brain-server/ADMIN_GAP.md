# Brain-server admin API surface — gap audit

Task 5.57: mirror of Phase 4.84's Core-side admin audit for the
Home Node Lite Brain. This file is the living tracking doc for
what the Brain admin API needs to expose vs. what's currently
primitive-only.

The Python Brain's admin UI exposes approximately 40 surfaces
(persona status, ask registry, guardian stats, scratchpad dumps,
cached trust scores, config snapshot, metrics). The TS
brain-server (task 5.1) is the app shell that will mount those
surfaces. This file tracks the mapping: **Python has → primitive
exists → HTTP route landed**.

Legend:
- **✅ primitive** = a framework-free primitive exists in `apps/home-node-lite/core-server/src/brain/*.ts`.
- **🟡 partial** = primitive exists but doesn't yet expose every field the admin UI needs.
- **❌ missing** = no primitive yet.
- **HTTP**: `✅` when the brain-server's Fastify app has a route wired; `🚧` when the primitive exists but no route; `—` when irrelevant (primitive-only helper).

Route prefix: `/admin/*` (CLIENT_TOKEN auth, matches Python convention).

## Summary

| Area | Primitives | HTTP routes |
|-----:|:----------:|:-----------:|
| Ask registry | ✅ | 🚧 |
| Guardian loop | ✅ | 🚧 |
| Scratchpad | ✅ | 🚧 |
| Persona registry + selector | ✅ | 🚧 |
| Domain / intent classifier | ✅ | — |
| Capabilities registry | ✅ | 🚧 |
| Notify dispatcher | ✅ | 🚧 |
| Trust scoring + decide | ✅ | 🚧 |
| Metrics | ✅ | 🚧 |
| Config reload | ✅ | 🚧 |
| LLM provider registry | ✅ | 🚧 |
| Token ledger | ✅ | 🚧 |
| Tool registry | ✅ | 🚧 |
| Crash recovery | ✅ | — |
| Background loop registry | ✅ | 🚧 |
| Command dispatcher | ✅ | — |
| Approval registry | ❌ | ❌ |
| Briefing history | ❌ | ❌ |
| Working-memory TOC | ❌ | ❌ |

## Per-surface breakdown

### Ask registry (task 5.19) — ✅ primitive / 🚧 HTTP

Primitive: `src/brain/ask_registry.ts` — state machine, TTL reaper,
persistence adapter, crash-recovery.

Missing HTTP surfaces:
- `GET /admin/asks` — list in-flight + recent asks with status
- `GET /admin/asks/:id` — single ask detail (question, answer, error)
- `POST /admin/asks/:id/cancel` — force `failed` on an in-flight ask
- `GET /admin/asks/stats` — counts by terminal status

### Guardian loop (task 5.30) — ✅ primitive / 🚧 HTTP

Primitive: `src/brain/guardian_loop.ts` — supervisor, per-event
timeout, error isolation, stats counters.

Missing HTTP surfaces:
- `GET /admin/guardian/stats` — processed / failed / timed_out counts
- `GET /admin/guardian/events?since=…` — live event stream (SSE or poll)
- `POST /admin/guardian/stop` — graceful stop for maintenance

### Scratchpad (task 5.42) — ✅ primitive / 🚧 HTTP

Primitive: `src/brain/scratchpad.ts` — multi-step checkpointing,
step-order validation, backend abstraction.

Missing HTTP surfaces:
- `GET /admin/scratchpad/:taskId` — read latest checkpoint
- `DELETE /admin/scratchpad/:taskId` — clear a stuck task
- `GET /admin/scratchpad` — list tasks in flight

### Persona registry + selector (task 5.44) — ✅ primitive / 🚧 HTTP

Primitive: `src/brain/persona_registry.ts` + `src/brain/persona_selector.ts`.

Missing HTTP surfaces:
- `GET /admin/personas` — installed personas with tier + lock state
- `POST /admin/personas/refresh` — trigger out-of-band refresh
- `GET /admin/persona-selector/stats` — selection counts per persona

### Capabilities registry (task 5.45) — ✅ primitive / 🚧 HTTP

Primitive: `src/brain/capabilities_registry.ts` — ttl resolution,
schema hash computation, freeze semantics.

Missing HTTP surfaces:
- `GET /admin/capabilities` — list registered capabilities
- `GET /admin/capabilities/:name` — full schema + schema_hash + TTL

### Notify dispatcher (task 5.47 + 5.49) — ✅ primitive / 🚧 HTTP

Primitive: `src/brain/notify_dispatcher.ts` — fiduciary bypass,
solicited policy, engagement buffering, flush.

Missing HTTP surfaces:
- `GET /admin/notify/pending` — count + peekBuffered
- `POST /admin/notify/flush` — force flush the engagement buffer
- `POST /admin/notify/discard` — admin "discard drafts" action

### Trust resolver + decision (task 6.21-6.23) — ✅ primitive / 🚧 HTTP

Primitive: `src/appview/trust_score_resolver.ts` + `src/appview/
trust_decision.ts`.

Missing HTTP surfaces:
- `POST /admin/trust/resolve` — explicit trust lookup for debugging
- `GET /admin/trust/cache` — cache stats + inspect entries
- `POST /admin/trust/invalidate` — drop a specific DID's entry

### Metrics (task 5.54) — ✅ primitive / 🚧 HTTP

Primitive: `src/brain/brain_metrics.ts` — Prometheus text format,
counters / gauges / histograms.

Missing HTTP surfaces:
- `GET /metrics` — Prometheus scrape endpoint (standard path, not `/admin/*`)

### Config reload (task 5.13) — ✅ primitive / 🚧 HTTP

Primitive: `src/brain/config_reloader.ts` — polling + change detection.

Missing HTTP surfaces:
- `GET /admin/config` — current config snapshot
- `POST /admin/config/reload` — trigger out-of-band reload
- `GET /admin/config/status` — isReady + last-fetch timestamp

### LLM provider registry (task 5.22) — ✅ primitive / 🚧 HTTP

Primitive: `src/brain/llm_provider.ts` — scripted adapter + registry + stats.

Missing HTTP surfaces:
- `GET /admin/providers` — registered providers with isLocal flag
- `GET /admin/providers/:id/stats` — chat/embed call + failure counts

### Token ledger (task 5.28) — ✅ primitive / 🚧 HTTP

Primitive: `src/brain/token_ledger.ts` — 3-scope budget tracking.

Missing HTTP surfaces:
- `GET /admin/tokens/snapshot` — live buckets with remaining budget
- `POST /admin/tokens/reset` — admin reset (test-only or extreme cases)

### Tool registry (task 5.26) — ✅ primitive / 🚧 HTTP

Primitive: `src/brain/tool_registry.ts`.

Missing HTTP surfaces:
- `GET /admin/tools` — registered tools with param schemas

### Background loop registry (task 5.56) — ✅ primitive / 🚧 HTTP

Primitive: `src/brain/brain_loop_registry.ts`.

Missing HTTP surfaces:
- `GET /admin/loops` — running status + stats for every loop
- `POST /admin/loops/:name/start` / `stop` — manual control

### Command dispatcher (task 5.33) — ✅ primitive / — HTTP

Primitive: `src/brain/command_dispatcher.ts`. User-facing slash
commands; admin exposure not typical (admin UI calls admin HTTP
routes directly instead).

### Crash recovery (task 5.55) — ✅ primitive / — HTTP

Primitive: `src/brain/crash_recovery.ts`. Boot-time only; no HTTP
surface needed.

### Domain + intent classifier (tasks 5.31 + 5.32) — ✅ primitive / — HTTP

Primitive: `src/brain/domain_classifier.ts` + `src/brain/
intent_classifier.ts`. Pre-reasoning routing; no admin surface
intended.

## Missing primitives (no primitive yet)

### Approval registry — ❌

The Python Brain has an approval queue for human-in-the-loop
decisions (fiduciary actions that need operator sign-off before
executing). Core has `ApprovalRegistry` (task 4.72) — Brain needs
a client adapter for it.

Scope: brain-side wrapper over Core's approval endpoints. Maps
request_id → approval_id when an ask returns `pending_approval`.

### Briefing history — ❌

Silence-First engagement events accumulate + get flushed to the
daily briefing. The Python Brain keeps a rolling log of what was
surfaced + when. TS has `NotifyDispatcher.flush()` but no
persistent briefing history.

Scope: a `BriefingHistoryStore` primitive + admin routes to read
past briefings.

### Working-memory TOC — ❌

Brain's ToC (topic EWMA + persona grouping) feeds the intent
classifier prompt. Already exists in the Python reference but not
yet ported to TS.

Scope: a `TopicMemory` primitive that the `IntentClassifier`'s
`tocFetcherFn` can read from.

## HTTP route wiring status — blocked on 5.1

Every "🚧 HTTP" row above is blocked on task 5.1 (brain-server app
scaffold). Once 5.1 + 5.4 (Fastify) land, the routes wire directly
onto the existing primitives — this file drives the checklist.

Route pattern (once 5.1 lands):

```ts
// e.g. asks
app.get('/admin/asks', { preHandler: requireClientToken }, async () => {
  return { asks: await askRegistry.list(), stats: askRegistry.stats() };
});
```

## Process

This file is updated on every iteration that either:
1. Adds a new primitive (bump the corresponding row to ✅).
2. Wires an HTTP route (bump the corresponding row to ✅).
3. Discovers a new admin surface the Python reference has (add a
   new row).

Ownership: anyone working on the brain-server app.
