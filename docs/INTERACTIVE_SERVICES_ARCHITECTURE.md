# Interactive Services: Paced, Approval-Gated Service Runs

## Architecture grounded in Dina's current system

**Status:** Design specification (design-complete baseline; v16). Implementation is phase-gated. Grounded against the shipping TypeScript stack (`packages/core`, `packages/brain`, `packages/protocol`, `apps/mobile`, `apps/home-node-lite`) and the design-only control-plane blueprint (`docs/mobile/DINA_WORKFLOW_CONTROL_PLANE.md`). Every "exists today" claim carries a file reference; everything else is net-new. Two owner decisions are frozen: **(a)** each message declares its own kind (informational vs action), and **(b)** pacing is a small bounded queue, not strictly one-at-a-time. An interactive service is an **owner-solicited** service, so it does not conflict with Silence First, and the Anti-Her posture is owner-sovereignty + structural bounds + honest attribution, not a content-police gate (§9.3).

This spec has been through a Claude+Codex adversarial-review convergence (frozen at the v16 baseline): the **interaction design** — the paced approval loop, cause-and-strength termination barriers, owner-only control boundary, non-load-bearing Brain-classify boundary, and at-most-one-delegation semantics — is design-complete and stable. The remaining precision is confined to **one deliberately conformance-gated sub-system**: locked-persona **payload durability + crypto-retention** (the content-addressed prepared-write/publish protocol, per-payload leaf-key crypto-shred, the hardened erasure backend + `erasure_mode` graceful degradation, and the `response_lost` path). §19 lists the values/constructions deferred to implementation + conformance vectors (exact transaction/lease/retention windows, the erasure-backend construction and its per-platform non-backup guarantee), not design.

**Purpose:** Let a person set up a service (agent-backed) that runs on an interval and streams a *sequence* of messages — each worked through with approve / deny — where Dina orchestrates the entire loop: schedule, pacing, gating, execution of approved actions, advance, and stop. The person sets up the service with an agent; **Dina is the whole control layer around it.**

Concrete shape the person described:

> A service runs at a definite interval and sends me messages. I approve or deny each one. There can be more than one — once I decide on this message, the next is ready. It keeps going until I tell it to stop, or it hits a count, or it runs out. Dina runs the whole thing.

This is the fourth interaction pattern in the services family, after query (`docs/SERVICES_LAUNCH_ARCHITECTURE.md`), peer pre-authorization (`docs/CONTACT_SERVICES_ARCHITECTURE.md`), earned-trust recommendation (`docs/CURATION_SERVICES_ARCHITECTURE.md`) and provider push (`docs/PUSH_SERVICES_ARCHITECTURE.md`).

---

## 1. The idea in plain language

A query service is one turn: you ask, it answers. An **interactive service** is many turns, bounded. The novelty is that **Dina owns the loop**: she paces it, gates every message, executes only what you approve, and holds all the state between.

> **Dina pulls; she is never pushed.** Dina requests the next message only when the interval allows *and* she has a free slot in a small, capped queue. This is the existing `service.query` → `service.response` loop iterated under Dina's control, with an approval gate on each turn. Silence First holds by construction.

Two rules carry the safety model:

> **The run authorizes the loop, not the actions.** Starting a run lets Dina *ask you* about a stream of proposals. **Every `action` message requires its own explicit approve before anything runs** — always, including SAFE. The risk gate is layered *after* that approve; it never removes the message approve.

> **The message declares its kind.** Informational (approve just acknowledges and advances) or action (approve authorizes execution, deny skips).

Everything else — the bounded queue, the termination barrier, persona binding, the delivery ceiling, attribution — keeps a long-running, agent-backed loop under the owner's control and inside the Four Laws.

---

## 2. Scope and non-goals

### 2.1 In scope

- A user-started, Dina-orchestrated **run**: an interval-scheduled service that streams approve/deny messages.
- Per-message routing by declared kind: informational vs action.
- A **bounded queue** with a frozen hard cap: fetch-ahead never exceeds `queue_cap`, the count budget, the owner's cadence, an open persona, or the run's hard TTL; atomic single-flight admission with a barrier-guarded enqueue-commit.
- Individual, per-action approval; the run never blanket- or auto-approves.
- **At most one logical delegation per approved action** (stable `delegation_id`, at-least-once transport, receiver dedup), created only after the risk gate authorizes it and claimed atomically before send; end-to-end effect exactly-once additionally requires a conforming provider (§6.3).
- Termination by explicit stop, a count, exhaustion, or expiry — all Dina-enforced through a persisted, **cause-and-strength-tagged** barrier with a bounded, forced drain that still lets cause-retained approved actions complete under a *permissive* drain (§5.1).
- Durable, encrypted storage of message payloads + all run state, surviving restart without Tier-0 plaintext, with **bounded terminal retention enforced by crypto-shredding** (destroy a per-payload leaf erasure key in a conformance-gated hardened store; graceful downgrade where unavailable, §13/§20).
- A Core-owned authority split: only the **owner** may create/steer a run (§12.5); **Core is the transport and sole state-transition authority, advancing all lifecycle autonomously**; **Brain is a non-load-bearing, pull-based classifier of open-persona informational messages** (§12.6).
- Reusing the approval inbox, the Brain-side semantic silence classifier, workflow tasks, scheduler, CardSpec, the `crypto/nacl.ts` sealed-box, and the storage-only dead-drop spool.

### 2.2 Non-goals

- Auto-approving or batch-approving actions.
- Letting the provider set its own urgency, bypass quiet hours, escalate to an interrupt, or pace itself past the queue cap, interval, or count.
- Guaranteeing interval precision, delivery timing, or a rescheduled quiet-hours banner (best-effort).
- Guaranteeing an approved external effect runs exactly once end-to-end (Dina guarantees at-most-once *logical delegation creation*; effect exactly-once depends on a conforming provider, §6.3).
- Recalling an already-sent effect (§5.1, §6.3, §20).
- Policing which services the owner may run, or *preventing* emotional dependency by content control (§9.3).
- Unbounded or perpetual runs. Every run force-terminates at `drain_deadline_at`.
- Sending vault context to the provider by default (awaits the Context Firewall).
- Letting an untrusted Brain affect recorded outcomes, suppress an **action-decision** banner, remove an inbox entry, or raise loudness (§9.1, §12.6). (The **owner** may always quiet a run via ceiling/mute/DND/quiet-hours; Brain may only route an **informational** message to briefing — never an action banner and never the inbox entry.)

---

## 3. Architectural position

An interactive service is an ordinary Dina service that declares a **run capability**. A run is a durable session **Core owns and is the sole authority over**. **Core is the fetch, dispatch and completion transport** (via its existing D2D/service transport, workflow and outbox), and **advances every message-lifecycle transition autonomously**. **Brain is an untrusted, non-load-bearing analyst whose only run role is to pull open-persona classification jobs and return a tier candidate** (§12.6); it never transports anything, holds no authoritative state, and can never create/steer/decide a run, affect a recorded outcome, or block delivery of an owner decision. Only the **owner** may create or steer a run (§10, §12.5).

| Layer | Existing Dina mechanism | Interactive-run use |
|---|---|---|
| Identity | DIDs, service URIs, runtime issuers | Identify the provider and the message/result signer |
| Authorization | Per-action intent gate; caller-type authz matrix; **provider-issued service grants** | Unchanged per-action gate + net-new local run authorizer (§10) + net-new **owner-only** control boundary (§12.5) + a **provider `grant_id`** binding (§10) + the **Brain-classify** boundary (§12.6) |
| Execution/transport | `service.query`/`service.response`; **Core-side D2D/service ingress incl. `service.response` completion in `packages/core/src/d2d/receive_pipeline.ts` (`completeMatchingServiceQueryTask`)**; delegation | Core pulls the next message; dispatches an approved action via an atomic outbox claim; ingests + verifies + advances its signed completion (net-new run-completion receipt + advancement over that ingress). |
| Payload confidentiality | Sealed-box `sealEncrypt`/`sealDecrypt` (`crypto/nacl.ts`); per-persona SQLCipher vaults | Reused as the crypto primitive under a **net-new envelope-encryption + crypto-shred payload store** (§13) — Core does not rely on the spool for encryption. |
| Locked-arrival buffering | **Storage-only dead-drop spool** (`storage/spool_node.ts` = `fs.writeFileSync`, no crypto; `home-node-lite/.../ingress/dead_drop.ts` — "blob already sealed by the sender") | Reused as **byte storage** for a payload that arrives while the persona is locked; Core supplies the sealing itself (§7, §13). |
| Downstream event/UI | Brain `WorkflowEventConsumer` (`workflow_event_consumer.ts:200`) polls Core workflow events, formats terminal results, delivers to the UI, acks | Optional downstream terminal-event/UI delivery only — **not** the authoritative completion path. |
| Decision | Workflow approval tasks + approval inbox | Gate each action message; acknowledge each info message |
| Delivery | Brain-side semantic silence classifier + notification inbox | Brain returns a tier candidate for open-persona **informational** messages; Core sets the deterministic tier per §9.1 |
| Durable anchor | `WorkflowTaskKind.Watch`/`.Timer` (declared, unused) | The run's interval + durable state |

### 3.1 Mapping to shipping code

| Concern | Shipping foundation | Run work |
|---|---|---|
| Per-action approval / risk gate | `POST /v1/agent/validate` (`intent.ts:17`); `requireAgentPersonaAccess` (`agent/access.ts:125`) | Reuse unchanged, as a persisted async sub-lifecycle after the message approve (§6.3). |
| Approval task + inbox | Workflow `approval` tasks; inbox + bridges (`inbox.ts:88`); Activity tab (`apps/mobile/app/notifications.tsx`) | Add a `run` notification kind. |
| Fetch/dispatch transport | Core-side D2D/service transport (`d2d/send.ts` `sendD2D` handles `service.query` egress) | **Net-new:** Core issues the query and dispatches. |
| Completion ingress + advancement | **Core** `service.response`/completion ingress in `d2d/receive_pipeline.ts` (`completeMatchingServiceQueryTask`) | **Net-new:** a signed run-completion receipt store + verification + a **two-step, idempotent-CAS advancement** (inline on the ingestion event, else via the recovery/reconciliation pass — §6.2). Brain's `WorkflowEventConsumer` is downstream UI delivery only. |
| Provider service authorization | `ServiceQueryBody.grant_id` (`packages/protocol/src/types/d2d.ts:64`); `known_only` grant gate (`service/bypass.ts`); `ServiceGrant`/`isAuthorized` | **Net-new:** bind an optional `provider_grant_id` to the run for protected/`known_only` services; include it in every query; distinct from local `run_authorization`; public services need none (§10). |
| Semantic classification | `silence.ts` / `dnd.ts` **live in Brain** | **Net-new:** a durable pull classification job; Brain classifies only *open-persona informational* content; the **deterministic action-tier base + owner-quieting clamp + fallback is net-new Core code** (§9.1). |
| Sealed-box crypto | `sealEncrypt`/`sealDecrypt` + `ed25519↔X25519` (`crypto/nacl.ts`; BLAKE2b(24) nonce, frozen vector) | **Reused primitive:** wraps a per-payload data key to the device X25519 key for a locked-arrival payload (§13). |
| Payload storage / crypto-shred | Per-persona SQLCipher vaults (persona-DEK encrypted); Tier-0 `identity.sqlite`; keystore (`keystore-node`/`keystore-expo`, **backup-friendly today — insufficient as-is**) | **Net-new:** an **envelope-encrypted payload store** — ciphertext under a per-payload data key wrapped for confidentiality (persona DEK/device) *and* under a **per-payload leaf erasure key** in a **conformance-gated, non-backed hardened erasure store** (net-new, not the shipping keystore); crypto-shred = destroy that leaf key (works while locked; defeats WAL/snapshot/backup copies) — **degrades to logical deletion where the backend is unavailable**; physical GC follows (§13). |
| Locked-arrival buffer | **Storage-only** dead-drop spool (`storage/spool_node.ts`, Node-only; no crypto, no run correlation) | **Net-new use:** buffer the *Core-sealed* ciphertext of a payload that arrives while the persona is locked; needs run correlation + an Expo/mobile adapter (§7, §13). |
| Pull cursor / reservation | reserve/commit/release window `query_window.ts` (**in-memory** — shape only) | **Net-new:** a durable reservation record incl. a `held_by_lock` state (§13); a **barrier-guarded** enqueue-commit fetch cursor (§7); a read-idempotency + replay-retention contract (§12.2). |
| Interval / durable schedule | `WorkflowTaskKind.Watch`/`.Timer` (`workflow/domain.ts:60`, **declared, unused**); reminder tick (`reminders/scheduler.ts:50`); sweepers | `watch` task; `next_fetch_at` paces the pull; sweepers enforce lease/expiry/`drain_deadline_at`/classify-timeout + orphan/terminal payload GC (**not** completion advancement, which is event-driven with a recovery backstop). |
| Local run authorization | **Analog only:** session approvals (`intent.ts`); `ServiceGrant`/`isAuthorized` (`service_grant_repository.ts:139`) | **Net-new, local:** a `run_authorization`; not a `service_grants` row and not the provider `grant_id`. |
| Owner-only run control | **Analog only, insufficient:** `auth/authz.ts` has **no `owner` type**; `trustedInProcess=true` (`in-process-transport.ts:109`, bypassed in `router.ts:212`) shared by Brain on mobile (`boot_service.ts`) | **Net-new:** an owner-only invocation boundary distinct from in-process trust; every `/v1/run/*` control mutation rejects Brain/agent/plugin/service (§12.5). |
| Anti-Her attribution | Guard scanner (`guard_scanner.ts`, **LLM, fail-open**) + regex helpers (`guardian/anti_her.ts`) | **Net-new posture (§9.3):** attribution + best-effort strip; no content-policing gate. |
| Session lifecycle | `POST /v1/session/start\|end` (`session.ts`, **no-op stubs**) | **Additive:** owner-only `/v1/run/*` (§12.5); `/v1/session/*` untouched. |
| Optional provider-fired mode | **[design-only]** `docs/PUSH_SERVICES_ARCHITECTURE.md` | **Deferred (Phase 2+), unspecified in V1** (§12.3). |

### 3.2 Why pull, and why push is deferred
Pull is the whole of V1. A provider-fired **push mode is deferred to Phase 2+ and unspecified in V1** — push is itself design-only and is a notification contract, not task creation.

---

## 4. Roles

### 4.1 Owner — starts, paces, decides and stops the run; the only caller permitted to create or control a run, and the only party that may quiet an **action decision** (§9.1, §10, §12.5).
### 4.2 Service provider operator — accountable for the service (`operator_did`); supplies the next message or a signed `exhausted` marker, executes approved actions, and returns a **runtime-issuer-signed completion** honestly (read-idempotency, delegation-dedup, effect-dedup — §6.3, §7).
### 4.3 Interactive service — the published service (`service_uri`).
### 4.4 Runtime issuer — the key authorized to sign run **messages, exhausted markers, and action-result completions** (§6.2).
### 4.5 Orchestrator / analyst — **Core** is the transport and sole authority, advancing all lifecycle autonomously. **Brain** is a non-load-bearing pull-classifier of open-persona informational messages; it may route an informational message to briefing but never touches an action banner or an inbox entry (§9.1, §12.6).

---

## 5. The run

Run **control state** (metadata, cursor, counts, lifecycle-row metadata) lives in **Tier-0 identity storage** (`identity.sqlite`, always open). Message **payloads** (the verified signed envelope, `card`, bounded `params`) are **envelope-encrypted** (ciphertext under a fresh per-payload data key; the wrapped key held in Tier-0, §13) — never Tier-0 plaintext. While the persona is open the data key is wrapped under the persona DEK (so a locked persona's payload is unrecoverable ⇒ sealed); a payload that *arrives while the persona is locked* has its data key wrapped to the **device X25519 key** and its ciphertext buffered in the storage-only spool until unlock (§7). The run is a `watch`-kind workflow task plus the Core run store.

```text
run_id / idempotency_key / service_uri / provider_did / persona
provider_grant_id           optional; provider-issued grant this run exercises for a protected/known_only service (§10)
interval / next_fetch_at    a fetch requires now >= next_fetch_at (§7); an interval update recomputes it (§12.5)
queue_cap                   admission ceiling; frozen 1..MAX_QUEUE_CAP; out-of-range rejected at creation
action_risk_ceiling         never BLOCKED
priority_ceiling            solicited (default) | engagement. V1 rejects `fiduciary`/Tier-1 (Phase 2, §9.1)
classify_timeout            bounded window (< the pre-deadline decision window) after enqueue-commit; on expiry Core finalizes tier (§9.1)
muted                       durable owner setting; suppresses banners (decisions still accrue in the inbox)
on_stop                     cancel_pending (default) | finish_pending — UNDECIDED messages on an EXPLICIT stop only
erasure_mode                backup_resistant | logical_deletion — frozen at creation from the platform erasure-backend probe (§13); owner-visible (§12.5)
paused_reason               null | provider_grant_unavailable | response_lost | ...   (surfaced via /status, §12.5)
termination:
  stop_on_command / max_count? (hard) / max_count_basis produced|decided(default) / stop_on_exhaustion
  expires_at (hard TTL; required) / drain_deadline_at (forced-terminate instant, §5.1)
  drain_cause (null|cancel_pending|finish_pending|count|exhaustion|expiry) / drain_strength (null|permissive|fencing)  (§5.1)
config_version              optimistic-concurrency token for owner CONFIG changes; NOT for decisions
fetch_cursor / last_commit_at
produced_count / decided_count
state                       active | paused | draining | completed | stopped | expired
created_at
```

`fetch-paused` is a **derived condition under `active`** (queue full, interval not elapsed, count budget exhausted, persona locked, run past `expires_at`, or `paused_reason` set) — not a persisted state. `outstanding` is defined in §7. There is no per-message lock epoch: the outbox claim, the enqueue-commit, and the fetch/classify hand-offs are guarded by *current* persona-open + run state + the hard bounds (§8). Each admitted message has a durable lifecycle record (§6.3) referencing its encrypted payload; each in-flight fetch a reservation record; each pending classification a classification job; each owner mutation a command receipt; each returned action a completion receipt (§13). All authoritative changes run in one per-run Core transaction (§8).

### 5.1 State machine, termination, and drain strength

Every termination path passes through `draining`. The **barrier** stops new fetches and **admissions** (it does **not**, on its own, stop classifying, surfacing, deciding, or dispatching messages already admitted — that depends on the drain's *strength*). Setting the barrier stamps `drain_cause`, `drain_strength`, and `drain_deadline_at`, **and atomically invalidates every outstanding uncommitted reservation** (`reserved` and `held_by_lock`): each is cancelled and any already-fetched ciphertext + its wrapped key are crypto-shredded, so no in-flight fetch can enqueue after a barrier (§7).

**Two drain strengths.** A cause is either **permissive** — `finish_pending` stop, `count`, `exhaustion` (a cause-retained approved action may still risk-gate and dispatch until `drain_deadline_at`) — or **fencing** — `cancel_pending` stop, `expiry` (all still-undecided / `classification_pending` / `risk_pending` / `risk_authorized` / unclaimed `dispatch_pending` are atomically fenced *now*: `cancelled` for stop, `expired` for expiry, and each fenced message's classification job is cancelled in the same transaction; only already-*claimed* effects may still complete). `fencing` is strictly stronger than `permissive`.

**Barriers are monotonic — strengthen only, never weaken.**
- `active`/`paused` → `draining`: the initiating cause sets `drain_cause`/`drain_strength` and `drain_deadline_at`.
- While `draining` under a **permissive** cause, an explicit **`cancel_pending` stop** or an **`expiry`** event **strengthens** to `fencing`: it atomically fences the unclaimed/undecided set (as above) and updates `drain_cause`/`drain_strength`; `drain_deadline_at` is only moved *earlier or equal*, never later.
- A `finish_pending` stop, a duplicate/weaker cause, or `pause`/`resume` while `draining` is an **idempotent no-op** — it never weakens a barrier, un-fences fenced work, restores authorization, or extends the deadline.
- Terminal states are absorbing.

**Command/state matrix** (§12.5): `pause` only `active → paused` (**retains** everything; cancels nothing); `resume` only `paused → active`; `stop` from `active/paused → draining`, and — for `cancel_pending` — also *strengthens* an in-progress permissive drain. **Persona lock is not a termination barrier** (§10): it fences/seals but preserves `decision_revision`; only termination barriers invalidate revisions.

**Count barriers are atomic (both bases):** the transaction taking the count to `max_count` sets the (permissive `count`) barrier (decision commit for `decided`; enqueue-commit for `produced`). Because a permissive barrier stops only *admission*, that in-budget final message is still classified, surfaced, decidable, **and — if approved — remains eligible to risk-gate and dispatch until `drain_deadline_at`** (subject to the §8 claim guard: persona open, not expired, before the deadline).

**Cause-aware dispatch during draining.** Under a **permissive** drain (`count`, `exhaustion`, `finish_pending`), an already-admitted, approved (or approvable) message may finish its risk gate and be dispatched (the outbox claim succeeds, §8) until `drain_deadline_at`. Under a **fencing** drain (`cancel_pending`, `expiry`) — including one reached by strengthening a permissive drain — unclaimed/undecided messages are fenced and cannot dispatch. So the honest property is: the final in-budget approved action **remains eligible to complete risk gating and dispatch** (not "always executes"); a fencing cause the owner or the clock imposes takes precedence.

| Cause (strength) | New fetch/admission | Already-admitted undecided | Already-approved / claimable |
|---|---|---|---|
| **explicit stop / `cancel_pending`** (fencing) | halted | → `cancelled` | already-claimed → completes/`outcome_unknown`; unclaimed → `cancelled` |
| **explicit stop / `finish_pending`** (permissive) | halted | decidable until deadline | may finish risk gate + dispatch until deadline |
| **max_count reached** (permissive) | halted | surplus → `cancelled`; in-budget final decidable | in-budget approved may dispatch until deadline |
| **exhaustion** (permissive, signed marker) | none left | decidable until deadline | may dispatch until deadline |
| **expiry** (fencing) | halted | all → `expired` | unclaimed → `expired`; already-claimed → `outcome_unknown` |

The **interval watch is cancelled the moment `draining` begins.** **At `drain_deadline_at` one atomic transition force-terminates:** any still-undecided / `classification_pending` / `risk_pending` / `risk_authorized` / unclaimed `dispatch_pending` → `cancelled` (stop/count/exhaustion) or `expired` (expiry), no delegation sent, classification jobs cancelled; every already-*claimed* (`sending`/`dispatched`) non-terminal delegation → `outcome_unknown`; every `held_by_lock`/`reserved` reservation cancelled and its buffered ciphertext + wrapped key crypto-shredded; all `decision_revision`s invalidated; the run authorization is revoked; the run becomes terminal, and terminal payload crypto-shredding is scheduled (§13). This bounds `finish_pending`/exhaustion so a run always terminates.

---

## 6. Messages

### 6.1 Envelope (stored envelope-encrypted, §13)
```text
message_id / run_id / sequence / dedup_key
kind: informational | action
action?   action_type; risk_class (SAFE|MODERATE|HIGH|BLOCKED, Dina re-derives); params (bounded)
card      CardSpec (validated, data-not-code, service-attributed)
issued_at / expires_at / schema_version / runtime_issuer_did / runtime_key_id
signature over the message projection (§6.2)
```
The verified envelope, `card`, and `params` are persisted as ciphertext in the envelope-encrypted payload store (§13) so Core can, after restart, rebuild the classification view, render the decision, verify the proposal, and dispatch the action — for an open persona; while the persona is locked the wrapped data key is unrecoverable (sealed) until unlock. A payload fetched *while locked* is buffered as Core-sealed ciphertext in its reservation until unlock (§7).

### 6.2 Signatures, projections, and the classification view
All provider outputs are runtime-issuer-signed over distinct domain-separated snake_case projections; `runtime_key_id` must be authorized at `issued_at`; a bare/missing signature, expired bucket, replayed id, or out-of-window `sequence` is rejected.
- **Message/proposal** — binds `provider_did`, `service_uri`, `run_id`, `message_id`, `sequence`, `dedup_key`, `kind`, `action_type`, digests of `params` and `card`, `issued_at`, `expires_at`, `schema_version`, issuer/key.
- **Exhausted marker** — binds `provider_did`, `service_uri`, `run_id`, exhausting `cursor`, `issued_at`, `schema_version`, issuer/key. Core verifies and **atomically sets the (permissive) exhaustion barrier**; a replay is idempotent.
- **Action-result completion** — binds `provider_did`, `service_uri`, `run_id`, `message_id`, `delegation_id`, `decision_revision`, `status` (`completed`|`failed`), a digest of the result card, `issued_at`, `schema_version`, issuer/key. It **returns to Core through the delegation's signed return path** (the Core `service.response` ingress, `receive_pipeline.ts` — the provider is the transport, never Brain) and lands in the Core **completion-receipt store keyed by `delegation_id`** (§13). Advancement is **two-step and idempotent**, not a single claimed-atomic transaction: on the ingestion event Core verifies the receipt and commits it as **`verified_pending`**, then attempts an inline **compare-and-set (CAS) advance** of the message lifecycle (`dispatched → completed/failed`) in the same event; if the per-run transaction is contended or a crash interleaves, the receipt stays `verified_pending` and a **separate idempotent advancement pass** (the crash-recovery sweep and the `drain_deadline_at` reconciliation) performs the CAS advance exactly once. The `drain_deadline_at` transaction reconciles `verified_pending` receipts before assigning `outcome_unknown`, so a completion that arrived before the deadline is never mis-recorded. Because advancement is a CAS keyed on `delegation_id`, double-advance is impossible. Forged/unsigned/replayed/mismatched-`delegation_id` are rejected. A **validly-signed late** completion (after `outcome_unknown`/termination) is preserved as **append-only reconciliation evidence**.
- **Classification view** (net-new, not a signature) — the bounded, size-limited, snake_case object Core hands Brain: `message_id`, `message_revision`, `kind`, the card's permitted display text (title/body), and the message content digest. **No vault context, no `params`.** Distinct from the signed digest projection; Core builds it only from a verified, open-persona message whose classification job is still eligible (§12.6).

### 6.3 Per-message lifecycle and the exactly-once boundary
```
received ─► enqueued ─► classification_pending ─► classified ─┬► decided(deny|acknowledge) ─► terminal
                                                              └► decided(approve) ─► risk_pending ─► risk_authorized ─► dispatch_pending ─► sending ─► dispatched ─► completed|failed
                                                                                          │                                                                              │
                                                                                          └► policy_refused                                                              └►(timeout)─► outcome_unknown ┄(late completion)┄► + reconciliation_evidence
undecided / classification_pending / risk_pending / risk_authorized / unclaimed dispatch_pending + fencing-barrier/expiry/deadline ─► cancelled | expired
```
- `enqueued → classification_pending` at the barrier-guarded commit (open persona; a message whose persona is locked is sealed and re-enters `classification_pending` on unlock). Informational messages get a `tier_candidate` from Brain (or the ceiling on `classify_timeout`); **action messages are not classified by Brain at all** — Core assigns the Tier-2 base directly (§9.1). `classify_timeout` atomically transitions `classification_pending → classified` at the fallback tier (job → `timed_out`); a later candidate is audit-only. **Fencing a `classification_pending` message atomically cancels its classification job** (job → `cancelled`/`expired`) in the same transaction, so no fenced card view is ever handed to Brain (§12.6).
- **Message `expires_at` and the run's hard bounds are rechecked** atomically before surfacing, `decide`, `risk_authorized`, and the outbox claim: a message past `expires_at` becomes `expired`, and any of these transitions also fails closed if `now >= run.expires_at` or (while draining) `now >= drain_deadline_at`. **An expired action never surfaces-for-new-decision, authorizes, or dispatches.**
- `risk_pending`→`risk_authorized` is the async MODERATE/HIGH confirmation/persona-unlock; `policy_refused` is terminal for BLOCKED/above-ceiling/gate-deny. The outbox delegation is created on entry to `dispatch_pending` (after `risk_authorized`) but **sent only when an atomic outbox claim succeeds** (§8). So an approved action can send **zero** delegations (refused, fenced, expired, or past a hard bound).
- **At most one logical delegation.** The claim mints/sends **one** delegation with a **stable `delegation_id` = H(run_id, message_id, decision_revision)** + `effect_idempotency_key`, via a transactional outbox; transport is at-least-once (crash re-sends the same id); the receiver deduplicates on `delegation_id`.
- **End-to-end effect exactly-once is a provider contract**; a non-conforming provider may duplicate; the capability declares conformance and the residual risk is surfaced.

### 6.4 Routing
- **informational** → a notification the owner acknowledges; nothing executes.
- **action** → requires an explicit approve (always, incl. SAFE), then the risk gate (capped by `action_risk_ceiling`): SAFE → immediate `risk_authorized`; MODERATE/HIGH → confirmation/unlock; BLOCKED/above-ceiling → `policy_refused`. `card`/`params` are untrusted.

---

## 7. Pacing — the atomic bounded queue

- **`outstanding` is frozen:** `outstanding = enqueued_undecided_count + open_reservation_count`, where enqueued-undecided counts messages in `enqueued`/`classification_pending`/`classified` (not yet decided) and open reservations counts reservation records in `reserved` **or `held_by_lock`** state. Re-derived on restart; lease-expired `reserved` rows released (but **`held_by_lock` rows are never lease-reclaimed** — they hold a durable Core-sealed response; both `reserved` and `held_by_lock` are cleaned up by barrier invalidation or termination, §5.1/§13).
- **Frozen cap.** `queue_cap ∈ 1..MAX_QUEUE_CAP` (admission ceiling; shrink rule §11).
- **Atomic admission (single-flight) with gates.** Core, on an eligible tick, opens an atomic reservation succeeding only when **all** hold: `outstanding < queue_cap`; `now >= next_fetch_at`; **`now < run.expires_at`**; the run is `active` (no barrier); the count budget allows (produced `produced_count < max_count`; decided `outstanding + decided_count < max_count`); **the persona is open**; and, for a protected service, `provider_grant_id` is present and unexpired (§10). A tick that observes `now >= run.expires_at` establishes the expiry barrier instead of admitting.
- **Core is the fetch transport.** Core issues the signed `service.query` (with `provider_grant_id` when protected), receives and verifies the signed `RunMessage`/`exhausted` (§6.2), envelope-encrypts the verified payload (a fresh per-payload data key, §13), and **rechecks the barrier + persona-open on arrival at a guarded enqueue-commit**:
  - **enqueue-commit is a guarded CAS** succeeding only if the reservation is still `reserved`, the run is still `active` (no barrier was set since the query was issued), and `now < run.expires_at`. A barrier or elapsed TTL that landed while the query was in flight makes the CAS fail: the fetched ciphertext + wrapped key are crypto-shredded and the reservation is released — **no message is admitted, no cursor advance, after a stop/expiry.**
  - **persona open at commit** → the data key is wrapped under the **persona DEK**; Core stores the ciphertext in the persona payload store, commits the reservation, and enqueues.
  - **persona locked (raced) at commit** → the persona DEK is out of RAM, so the data key is instead wrapped to the always-available **device X25519 key** (`sealEncrypt`, `crypto/nacl.ts`); the ciphertext is **durably staged in the spool (fsync) *before* the `held_by_lock` commit**, and only then does the reservation atomically become **`held_by_lock`** with a `sealed_response_ref` (spool blob id + digest) — **not discarded, no plaintext at rest, no persona DEK required.** (Confidentiality while locked rests on the device key, the standard dead-drop property; it is upgraded to persona-DEK grade on unlock.)
- **Unlock-commit vs termination (a crash-safe, content-addressed prepared-write/publish — NOT a cross-database transaction).** A `held_by_lock` reservation is an *uncommitted admission*; there is **no single ACID transaction spanning the persona vault and Tier-0** (`identity.sqlite`). Instead, the **Tier-0 pointer CAS is the sole atomic commit point**, ordered around idempotent, content-addressed side effects. The spool blob is read **non-destructively (`peek`, never a destructive drain)** and acknowledged/deleted only *after* the Tier-0 commit:
  - **unlock while the run is still `active` and `now < run.expires_at`** → (1) Core `peek`s the staged ciphertext, verifying the `sealed_response_ref` content digest; (2) writes a Tier-0 **`prepared` blob-registry pin** (§13) then device-unseals `k_p`, **re-wraps it under the persona DEK**, and **durably writes** the (content-addressed) persona-wrapped ciphertext to the persona payload store (persona open ⇒ writable); (3) **the single Tier-0 CAS** flips the pin `prepared → published`, committing the reservation + `payload_ref`(content hash) + cursor (enqueued exactly once); (4) only *after* that commit does it `ack`(delete) the spool blob. Because the pin and orphan GC's delete-claim both mutate the Tier-0 registry, GC can never delete a `prepared`/`published` blob mid-publish (§13). Crash after (2) before (3) → a `prepared`-but-unpublished vault blob, reclaimed only via the prepared-lease sweep (never mid-publish), reservation still `held_by_lock`, spool blob intact ⇒ retried; crash after (3) before (4) → the recovery pass acks the blob (`payload_ref` present ⇒ re-run is a no-op). No step assumes cross-database atomicity.
  - **any termination barrier / `drain_deadline_at` reached before unlock** → the held reservation is **terminally cancelled**, its per-payload erasure key crypto-shredded (§13), and its spool blob `ack`-deleted **without decryption** (admission is barred under any barrier). Restart re-runs this reconciliation idempotently.
  - **spool capacity / I/O failure** on the staged write fails the fetch closed (reservation released, nothing admitted), like any other fetch error; a missing/partial blob detected at `peek` (content-digest mismatch) fails the unlock-commit closed and re-drives via provider read-idempotency if still available. If replay is no longer available, this is a **detected storage failure**, surfaced as an **owner-visible terminal `response_lost` error on that reservation — never a silent drop, and never a partial admit** (see invariant 4: no *silent* loss; a detected storage fault is reported, not hidden).
- **Fetch cursor advances on enqueue-commit** (immediately, or on unlock-commit from a `held_by_lock` response): the reservation commits, `fetch_cursor`/`produced_count` advance, `last_commit_at` is stamped, `next_fetch_at` moves forward.
- **Provider read-idempotency (contract).** While a reservation is *uncommitted and not held*, retrying `(run_id, cursor)` MUST return the **identical signed message/exhausted**; `provider_replay_retention > reservation_lease + max_recovery_horizon` (§19). (`held_by_lock` does not rely on replay.) `dedup_key` collapses duplicates.
- **Over-cap / over-budget / locked / past-TTL / paused_reason:** Core stops fetching (`fetch-paused`).

---

## 8. The advancement loop and linearization

1. **Eligibility → atomic reservation** under all §7 gates (incl. `now < run.expires_at`).
2. **Core fetches, verifies, envelope-encrypts, barrier-guarded-commits (or holds)** — Core issues the query, verifies the signed message/exhausted + CardSpec, envelope-encrypts the payload; the guarded enqueue-commit CAS (reservation `reserved` + run `active` + `now < run.expires_at`) either commits (persona-DEK-wrapped; cursor advances; produced-basis `max_count` sets the barrier same-transaction, §5.1), holds (locked-raced → device-wrapped `held_by_lock`), or fails-and-shreds (barrier/TTL raced in); signed `exhausted` → exhaustion barrier.
3. **Classify (open persona, informational only, pull-based)** — the message enters `classification_pending`; for informational messages Brain **acquires** via `worker_acquire_classification` (Core CAS-checks the message is still `classification_pending` in an eligible run/drain state within hard bounds, persona open, at hand-off) and reports a `tier_candidate` idempotently; on `classify_timeout` Core finalizes at the ceiling. **Action messages skip Brain and take the Tier-2 base** (§9.1).
4. **Decide** — the owner approves/denies/acknowledges (§12.5) with `decision_revision`; Core commits.
5. **Execute** — approved → `risk_pending`→`risk_authorized`→ `dispatch_pending`; an **atomic outbox claim** sends exactly one delegation; the provider's signed completion returns and **Core advances it via the two-step idempotent CAS on ingestion** (§6.2).
6. **Advance** — the committed decision frees a slot; check the barrier; fetch the next only if eligible.

**Linearization (single-writer per run):**
- **Count.** A decision/produced-commit reaching `max_count` sets the (permissive) barrier same-transaction; concurrent excess is rejected.
- **Enqueue-commit (barrier point).** The guarded CAS is the admission linearization point: a barrier/TTL that commits first cancels the outstanding reservation and shreds any fetched ciphertext (never enqueued); otherwise the reservation commits and the cursor advances. So a stop/expiry landing during an in-flight fetch is always honored.
- **Dispatch (outbox claim).** The claim is the dispatch linearization point; its guard is **"persona currently open AND message not `expired` AND `now < run.expires_at` AND (run `active`, OR (run `draining` AND `drain_strength = permissive` AND the message is cause-retained AND `now < drain_deadline_at`))."** No frozen epoch. A **fencing** cause (cancel_pending stop / expiry, incl. one reached by strengthening) or an elapsed hard bound that commits first cancels/expires the row (never sent); a **persona lock** that commits first **holds** the row (persona not open) and it dispatches on unlock — **never silently dropped.**
- **Persona lock (not a barrier).** Fences classify/risk/claim and seals payloads but **preserves `decision_revision`**; on unlock everything resumes.

---

## 9. Delivery and silence

A run's pending decisions are **solicited** — Tier 2 by default.

### 9.1 Frozen delivery evaluation order
The banner tier is computed by Core in this fixed order, so Brain is bounded to *informational* routing and cannot touch an action banner or an inbox entry:
1. **Base tier.** An **action** (decision-requiring) message gets a **Core Tier-2 base** — Brain is **not consulted for action loudness at all**. An **informational** message gets Brain's `tier_candidate` (or the run's ceiling on `classify_timeout`), which may be Tier 3 (briefing) — Brain routing an informational message to briefing is legitimate quieting of *informational delivery*, but it never removes the informational inbox entry.
2. **Owner ceiling.** Apply `priority_ceiling` (quieter-of = numeric max over 1=Fiduciary…3=Engagement). This is the **owner's** setting — if the owner set `priority_ceiling = engagement`, an action may be quieted to briefing (owner control). The ceiling never *raises* loudness.
3. **Owner quiet settings.** Apply `muted`, DND, and quiet-hours (all deterministic, Core-enforced) — the decision stays in the Activity inbox; only the banner is suppressed.

So the honest guarantees are: **a Brain candidate can never raise loudness and never affects an action's tier at all; the untrusted Brain can never suppress an *action* banner and can never remove any inbox entry (informational or action).** Brain may route an *informational* message to briefing; only the **owner** may quiet an *action decision* (ceiling ≤ Engagement, mute, DND, quiet hours). **V1 rejects `priority_ceiling = fiduciary` (Tier 1); `solicited` (Tier 2, default) and `engagement` (Tier 3) are the allowed ceilings.** `fiduciary`/Tier-1 is Phase 2.

### 9.2 Back-pressure and delivery liveness
Delivery never waits on Brain (action = immediate Tier-2 base; informational = classify-timeout fallback). At most `queue_cap` decisions can pend.

### 9.3 Anti-Her (Law 4)
Owner-solicited; Dina does **not** police which services the owner runs. Hard guarantees: **attribution** (messages always attributed to the service under Dina-owned trust UI, never Dina's voice) and **owner control**. Structural bounds *mitigate* — not eliminate — engagement risk. The guard-scanner impersonation strip is **LLM-based and fail-open** (defence-in-depth). No content-policing admission gate.

---

## 10. Authorization and safety

- **Three distinct authorizations, kept separate.** (1) **Local `run_authorization`** (Tier-0) scopes only the local loop. (2) The **owner-only control boundary** (§12.5). (3) An optional **provider-issued `provider_grant_id`** — for a protected/`known_only` service, the provider grants Dina access (shipping offer/grant flow); Core includes `provider_grant_id` in **every** `service.query` (`ServiceQueryBody.grant_id`, `d2d.ts:64`). On provider-side expiry/revocation the query fails and the run enters a **derived `fetch-paused` condition (still `active`) with `paused_reason = provider_grant_unavailable`** (owner-visible via `/status`, §12.5) — it does not cancel anything. The owner rebinds a replacement via the versioned `/update` route; Core auto-revalidates and resumes. The locally-known grant binding + expiry are persisted (§13). A **public** service needs no grant. `run_authorization` can never serve as provider authority, and `provider_grant_id` can never steer the loop.
- **Owner-only control — a real boundary, not `trustedInProcess`.** Only the owner may create/steer a run via a net-new path the Brain transport cannot reach; every `/v1/run/*` control mutation rejects Brain/agent/plugin/service in-handler (§12.5).
- **Every action is individually gated** (§6.4).
- **Persona lock is a serialized transition** (one Core transaction): it stops new fetches (§7); on a lock-raced *verified* fetch it makes the enqueue-commit CAS hold the reservation as `held_by_lock` (device-wrapped, admitted exactly-once on unlock, or terminally cancelled + crypto-shredded if a barrier intervenes, §7); it **freezes classify/risk gates**; it makes the **atomic outbox claim fail** (persona not open) so **no new dispatch occurs while locked**, but an unclaimed `dispatch_pending` row is **held and re-armed on unlock** (never dropped); and already-persisted persona-DEK-wrapped payloads/result-cards are simply **unrecoverable while the persona DEK is out of RAM** (naturally sealed). It **preserves `decision_revision`** — on unlock, fetching, classify/risk gates, held dispatches, and decidability resume. An already-*claimed* effect may complete (its result card device-wrapped until unlock, then re-wrapped under the persona DEK). The persona DEK is never eagerly derived while locked; Brain never receives locked-persona plaintext (Core is the transport).
- **Provider content is untrusted, service-attributed.**
- **Instant, unconditional owner halt, strengthenable.** Pause/stop unconditional w.r.t. `config_version` but state-gated (§5.1); a `cancel_pending` stop fences undecided by default and **may strengthen an in-progress permissive drain** (§5.1). Already-claimed effects complete.
- **No vault context by default** until the Context Firewall exists.
- **Bounded retention by crypto-shredding.** Terminated runs and terminal messages destroy the **per-payload leaf erasure key** protecting each payload, device-sealed response, and result card after a bounded audit/replay window — rendering the ciphertext unrecoverable **in every copy, including `identity.sqlite` WAL/snapshots/backups**, and it works while the persona is still locked, **provided a non-backed hardened erasure store is available** (net-new, conformance-gated; else the guarantee degrades to logical deletion, §13/§20); physical GC of the inert ciphertext (and orphans) follows (§13). Per-payload keys mean shredding one payload never affects another. Mere Tier-0 row deletion is *not* the guarantee (§13, §20).

---

## 11. Control surface — Dina is the whole setup

- **Start** (owner-only): service, interval, cap, ceilings (V1 rejects `priority_ceiling = fiduciary`; `solicited`/`engagement` allowed), termination (+ `drain_deadline_at`), `on_stop`, persona, `provider_grant_id` if protected.
- **Work the run:** the Activity tab shows pending decisions in order (approve/deny; acknowledge/dismiss; **`modify` is Phase 2**), each service-attributed; `/status` shows state, counts, remaining, next fetch, termination progress (incl. `drain_cause`/`drain_strength`), **`fetch_paused` + `paused_reason` (incl. `response_lost`) + `erasure_mode` + non-secret provider-grant validity** (§12.5). The owner-facing UI reflects the run's `erasure_mode` (backup-resistant vs logical-deletion) honestly.
- **Steer the run:** `pause`/`resume`/`stop` unconditional but state-gated (§5.1) — `pause` retains all; a `cancel_pending` `stop` may strengthen a permissive drain; **config changes** (mute, lower ceiling, change interval or cap, rebind grant) via the owner-only, `config_version`-gated `/update`. Lowering `queue_cap` below `outstanding` retains admitted messages (no new admission until `outstanding < queue_cap`). Changing `interval` recomputes `next_fetch_at = max(now, last_commit_at + new_interval)`.
- **On stop/termination:** barrier set (cause + strength), outstanding reservations invalidated, watch cancelled, undecided/dispatch handled by cause (§5.1), cause-retained approved actions may complete until `drain_deadline_at` under a permissive drain, then terminal, authorization revoked, summary written, payloads crypto-shredded after the audit window.

---

## 12. Protocol surface

### 12.1 Capability
`com.dinakernel.service.profile` declaring `interactive_run` with frozen schemas for run start params, the signed message/exhausted/result projections, the classification view, the action schema, and provider conformance flags.

### 12.2 Pull mode (the whole of V1)
Core sends a scoped query for `(run_id, fetch_cursor)` (with `provider_grant_id` when protected); the provider returns a signed `RunMessage` or signed `exhausted`, honouring read-idempotency + replay-retention (§7). Approved actions dispatch via the atomic outbox claim; the signed completion returns via the delegation path and Core advances it via the two-step idempotent CAS on ingestion (§6.2).

### 12.3 Push mode — deferred (Phase 2+), unspecified in V1.

### 12.4 Additive public NSIDs — `com.dinakernel.run.declaration` / `com.dinakernel.run.outcome`.

### 12.5 Owner-only run-control API (net-new)
**Only the owner may call these** — not `trustedInProcess`. Every mutation rejects Brain/agent/plugin/service in-handler. Additive; snake_case:
```text
POST /v1/run/start        { ...config, provider_grant_id?, idempotency_key } -> { run_id, config_version, erasure_mode }
POST /v1/run/{id}/decide  { message_id, decision, decision_revision, idempotency_key } -> { ... }
POST /v1/run/{id}/update  { interval? | queue_cap? | priority_ceiling?(lower-only) | muted? | provider_grant_id? | skip_lost_reservation?(owner-authorized), config_version, idempotency_key } -> { config_version }
POST /v1/run/{id}/pause | /resume | /stop   { on_stop?, idempotency_key } -> { state }   # unconditional re: version; state-gated per §5.1
GET  /v1/run/{id}/status  -> { state, erasure_mode, drain_cause?, drain_strength?, fetch_paused, paused_reason, provider_grant_valid_until?, counts, pending[], lost[]?, next_fetch_at, config_version }
```
- **Durable per-command idempotency.** `start` keys on `(owner_principal, route, idempotency_key)` and stores the resulting `run_id`; others key on `(owner_principal, run_id, route, idempotency_key)`. Receipts store request hash + committed response (retention §19), so a replayed old `resume` cannot undo a newer `pause`, across restart.
- **`decide` uses `decision_revision`**; **`update` uses `config_version`**; **`pause`/`resume`/`stop` are version-unconditional but state-gated** (§5.1), and a `cancel_pending` `stop` may *strengthen* (never weaken) an in-progress drain.

### 12.6 Core-owned mechanics + the Brain classify boundary (net-new)
**Core owns fetch, reservation, commit, dispatch (atomic outbox claim), and autonomous completion advancement.** **Brain is a non-load-bearing, pull-based classifier of open-persona *informational* messages**; its only two calls are:
```text
worker_acquire_classification()                                      -> { message_id, message_revision, classification_view, lease_token } | none
      # Core CAS-checks the message is still `classification_pending`, the run is in an eligible (non-fencing) state within its hard bounds, and the persona is open; else returns none. Leases the job; an expired lease re-enqueues it; fencing the message cancels the job and invalidates the lease.
worker_report_classification(message_id, message_revision, lease_token, tier_candidate)
      # untrusted candidate for INFORMATIONAL messages only; idempotent by (message_id, message_revision); a stale lease or a fenced/terminal message is rejected. Absent within classify_timeout, Core finalizes at the ceiling.
```
Brain never transports a fetch/dispatch/completion, never receives locked-persona plaintext, never receives a fenced/terminal message's view, never advances a completion (Core does), never blocks delivery (action = Tier-2 base; informational = timeout fallback), and never affects action loudness. **A compromised Brain can only route an *informational* message to briefing (mis-classify a candidate downward, bounded by Core), and can never suppress an *action* banner, remove any inbox entry, affect a recorded outcome, create/steer/decide, transport anything, forge a message/exhausted/completion, or raise a run to an interrupt.**

---

## 13. Data-model and schema deltas

- **Run store** (net-new, Tier-0): the §5 fields incl. `provider_grant_id`(+known expiry), `paused_reason`, `classify_timeout`, `idempotency_key`, `config_version`, `fetch_cursor`, `last_commit_at`, `next_fetch_at`, `priority_ceiling` (`solicited`|`engagement`; V1 rejects `fiduciary`), `muted`, `max_count`(+`basis`), `on_stop`, `expires_at`, `drain_deadline_at`, **`drain_cause`, `drain_strength`**, `queue_cap`, counts, `state`. **No `persona_lock_epoch`** (guards are current-state).
- **Envelope-encrypted payload store + crypto-shred (net-new; erasure backend conformance-gated).** Each payload (message envelope + `card` + bounded `params`; and each action result card) is encrypted with a **fresh per-payload symmetric data key `k_p`** (AEAD from the `crypto/nacl.ts` stack). The content-addressed **ciphertext** is written as an immutable blob (in the persona payload store when open, or in the storage-only spool for a locked-arrival payload) and committed only by a **Tier-0 pointer CAS** (§7 — no cross-database transaction). `k_p` is wrapped **twice** and the wrapped record lives in **Tier-0** (`identity.sqlite`, always open): an inner **confidentiality wrap** under the **persona DEK** (persona-open payloads; a locked persona's `k_p` is unrecoverable) or **sealed to the device X25519 key** (`sealEncrypt`) for a locked-arrival payload (re-wrapped under the persona DEK on unlock); and an outer **erasure wrap** under a **per-payload, independently-destroyable leaf erasure key `k_e^{payload}`** held in a hardened erasure-key backend. **Erasure keys are per-payload, not per-run** — shredding one terminal message or one cancelled reservation must not touch any other live payload in the run (V1 freezes independently-erasable leaf keys with atomic per-key destruction; §5.1/§19). **Crypto-shred = destroy that payload's leaf erasure key** — needs no persona DEK (so it works while the persona is locked) and renders `k_p`, and therefore the ciphertext, **undecryptable in every copy, including historical `identity.sqlite` WAL / snapshots / backups** — *provided the erasure-key backend genuinely keeps the leaf key out of every backup/snapshot and destroys it durably.* **That backend is net-new and conformance-gated, NOT a shipping property:** today's `keystore-node` (`FileKeystore` = plaintext files, backup-trivial, `unlink` delete) and `keystore-expo` (default, backup-syncable attributes) do **not** provide it. A platform must supply a **non-migratable, non-backed, crash-safe-destroy** erasure store to claim backup-resistant crypto-shred; **where unavailable, the guarantee degrades to logical deletion + physical GC and the honest claim is downgraded accordingly** (§20) — the run does not silently pretend to crypto-shred. The mode is **determined by a platform erasure-backend conformance probe at run creation, frozen as `erasure_mode ∈ {backup_resistant, logical_deletion}`** (§5), returned from `/start` and exposed in `/status` and owner UI (§12.5); a `logical_deletion` run never advertises backup-resistance. Deleting only the live Tier-0 row is never sufficient by itself. After crypto-shred, **physical GC** of the now-inert ciphertext (persona-store blobs at next unlock; spool blobs immediately) is cleanup only. On a message reaching a terminal state (or on run termination) and past a bounded audit/replay window, Core crypto-shreds its per-payload leaf keys. The **spool performs no crypto** (`spool_node.ts` = `fs.writeFileSync`, destructive drain); a fsync'd staged write + a non-destructive `peek`/`ack` two-phase drain (§7) + an Expo/mobile adapter + run correlation are **net-new** (the `peek`/`ack` shape exists in `home-node-lite`'s `dead_drop.ts` but without fsync and is not in `spool_node.ts`).
- **Orphan GC reachability (net-new).** A payload/spool blob is deletable **only when no live reference exists across all three reference sources** — a `reservation.sealed_response_ref` (a `held_by_lock` blob has *no* lifecycle row yet and MUST NOT be treated as orphaned), a per-message `payload_ref`, or a completion-receipt result-card ref — verified by an atomic recheck at delete time. GC never deletes a blob reachable from a live `reserved`/`held_by_lock` reservation.
- **Tier-0 blob registry (net-new; makes GC and publish mutually exclusive).** Every ciphertext blob (persona-store or spool) has a Tier-0 registry row `state` (`prepared`|`published`|`abandoned`) keyed by content-id + owning reservation/message. Core writes a **`prepared` pin *before* it writes the blob bytes**; the publish CAS flips `prepared → published` and attaches the `payload_ref`. **Orphan GC's delete-claim and the publish CAS both mutate this Tier-0 registry, so they serialize (single Tier-0 writer per run) — GC never deletes a `prepared` or `published` blob**, only one whose registry row is `abandoned` (or absent). A `prepared` pin that never publishes (crash/abandon) is moved to `abandoned` by a bounded prepared-lease sweep, then its bytes are deleted. This closes the write-before-commit vs concurrent-GC race across the two stores.
- **Reservation record** (net-new): `run_id`, `cursor`, `state` (`reserved`|`committed`|`released`|**`held_by_lock`**|**`response_lost`**), `sealed_response_ref` (for `held_by_lock`; the durably-staged spool blob content-id + its device-wrapped `k_p` handle + its per-payload leaf erasure key + digest), `error_reason`/`error_at` (for `response_lost`), `lease_expires_at` (not applied to `held_by_lock`), `query_correlation_id`. Both `reserved` and `held_by_lock` rows are invalidated (cancelled + leaf-erasure-key-shredded + blob `ack`-deleted, no decryption — shredding one reservation's leaf key never affects another live payload) by barrier creation or termination; `held_by_lock` is additionally exempt from *lease* reclamation and from orphan GC. A **`response_lost`** reservation (detected staged-blob loss with provider replay unavailable, §7) is terminal: it **releases its slot** (the run does not stall), does **not** advance the cursor past the lost item, and **sets `paused_reason = response_lost`** so the owner sees it and may `/update`-authorize a skip (cursor advances past it), `resume`, or `stop`; the lost item never became a message, so it never counts toward `produced_count`/`decided_count`. `/status` surfaces it and a `run` notification is raised.
- **Per-message lifecycle** (net-new, Tier-0 metadata): `message_id`, `dedup_key`, `sequence`, `kind`, `state` (§6.3), `decision_revision`, `delegation_id`, persisted `expires_at`, `payload_ref`(+wrapped-key handle), `tier_candidate`/`final_tier`(+`tier_source`), `reconciliation_evidence` (append-only).
- **Classification job** (net-new, durable): `message_id`, `message_revision`, `state` (`pending`|`classified`|`timed_out`|**`cancelled`|`expired`**), lease; a fence cancels the job + invalidates the lease; restart re-enqueues `pending` jobs.
- **Command-receipt record** (net-new): keyed per §12.5.
- **Completion-receipt store** (net-new): provider-signed completion keyed by `delegation_id`, with receipt `state` **`verified_pending`|`advanced`**; **Core commits `verified_pending` on the ingestion event then CAS-advances the lifecycle** (inline, else via the idempotent recovery/reconciliation pass, §6.2). **Not a scheduled completion sweeper** (the recovery pass is a crash backstop, not the primary path). A result card arriving while the persona is locked is device-sealed like a held fetch and re-wrapped under the persona DEK on unlock; it is crypto-shredded with the run.
- **Run authorization + owner-only boundary + Brain-classify boundary + provider `grant_id` binding** (net-new; all distinct).
- **Workflow**: activate `WorkflowTaskKind.Watch`; reuse `next_run_at`/sweepers for pacing, lease/expiry, reservation reclaim (excluding `held_by_lock` lease reclaim), `drain_deadline_at`, classify-timeout, and **terminal/orphan payload GC** — **not** completion advancement.
- **Notifications**: add a `run` kind. **Sessions**: no change to `/v1/session/*`.

---

## 14. Reuse vs net-new (summary)

**Reused unchanged:** the per-action intent/risk gate and persona access check, workflow approval tasks + inbox, `service.query`/`service.response` (incl. `grant_id`) + Core's D2D/service ingress (`receive_pipeline.ts` `service.response`/`completeMatchingServiceQueryTask`), the provider `ServiceGrant`/`isAuthorized`/`known_only` gate, per-persona SQLCipher vault encryption, the **`crypto/nacl.ts` sealed-box** (as the wrap primitive for a locked-arrival data key), the **storage-only dead-drop spool** (as byte storage — its `peek`/`ack` + fsync are net-new, below), the **Brain-side semantic silence classifier** (as an untrusted candidate over open-persona informational content only), CardSpec + `validateCardSpec`, scheduler + non-completion sweepers.

**Net-new:** the `interactive_run` capability + signed schemas + classification view; the Core-owned run object + full lifecycle + reservation (incl. `held_by_lock`) + classification-job (incl. `cancelled`/`expired`) + command-receipt + completion-receipt (`verified_pending`/`advanced`) stores + **envelope-encrypted payload store with per-payload-leaf-key crypto-shred (a conformance-gated non-backed erasure store; graceful downgrade) + content-addressed prepared-write/publish (Tier-0 CAS the sole commit, no cross-DB txn) + reference-safe orphan/terminal GC + a net-new fsync'd `peek`/`ack` spool** + transactional outbox with atomic claim + stable `delegation_id`; the local `run_authorization`, the **owner-only boundary**, the **provider `grant_id` binding**, and the **Brain-classify boundary** (fence-aware acquire); **Core as the run transport with two-step idempotent-CAS completion advancement**; the atomic gated pacer with frozen `outstanding`, hard-TTL admission guard, **barrier-guarded enqueue-commit CAS**, on-arrival recheck, and **seal-buffer-and-admit-exactly-once-on-unlock** (or terminal-cancel + crypto-shred on a barrier) for a lock-raced fetch; **the frozen Core-side delivery evaluation order** (action Tier-2 base + owner-only action quieting; Brain may route informational to briefing); the **cause-and-strength-tagged** termination barrier (atomic both bases; admission-only; monotonic strengthening; invalidates outstanding reservations; hard-bound-guarded dispatch), the command/state matrix, and the serialized persona-lock transition (preserves revision, holds+re-arms dispatch); the run UI incl. `/status` `drain_cause`/`paused_reason`/grant visibility.

**Partial foundations:** the dead-drop spool (Node-only, storage-only) is extended with run correlation + a mobile adapter and reused as the locked-arrival ciphertext buffer; the persona-DEK vault handles at-rest-while-locked for persona-open payloads; the guard-scanner strip (LLM, fail-open).

**Design-only / deferred:** `push.*` and push mode; the `approval_resolved`/`delegation_returned` wake reasons; `fiduciary`/Tier-1 + harm signal, a signed cursor-ack, and the device sealing-key provenance/rotation, are Phase 2 / §19.

**Dormant primitive activated:** `WorkflowTaskKind.Watch`. `/v1/session/*` untouched.

---

## 15. End-to-end flows

### 15.1 Start
Owner sets up the service and asks Dina to run it (interval, cap, ceilings — `solicited`/`engagement`, termination, `on_stop`, persona, `provider_grant_id` if protected). Core (owner-authenticated) creates the run (Tier-0), the `watch`, and the `run_authorization`.

### 15.2 A turn
Watch/slot triggers an atomic reservation (§7, incl. `now < run.expires_at`); **Core** issues the query (with `grant_id` if protected), verifies the signed message, envelope-encrypts it, and runs the guarded enqueue-commit — commit (persona-DEK-wrapped) if open + still active, hold (device-wrapped `held_by_lock`) if the persona raced locked, or shred if a barrier raced in. Informational → Brain classifies (or Tier-2/ceiling fallback); action → Core Tier-2 base. Owner approves via `/decide`; message → `risk_pending`→`risk_authorized`→ atomic outbox claim sends one delegation; the provider's signed completion returns and **Core advances it via the two-step idempotent CAS on ingestion**. Slot frees; barrier checked; next turn only if eligible.

### 15.3 Away and back
Core fetches ahead up to `queue_cap` and the count budget, then fetch-pauses. Owner returns, clears decisions in order.

### 15.4 Stop / count / exhaustion / expiry
Owner stops, or the count is reached (atomically), or the provider returns signed `exhausted`, or `expires_at` passes. Core sets the cause-and-strength barrier → `draining`, invalidates outstanding reservations (shredding in-flight fetches), cancels the watch, resolves undecided by cause (§5.1) — cause-retained approved actions may still complete until `drain_deadline_at` under a *permissive* drain, while a `cancel_pending` stop or expiry fences them (and may strengthen a permissive drain in progress) — then force-terminates atomically, writes the summary, and crypto-shreds payloads after the audit window.

---

## 16. Invariants

1. **The run authorizes the loop, not the actions.** Every action message requires its own explicit approve, including SAFE.
2. **Three separate authorizations** (local `run_authorization`, owner-only control, provider `grant_id`) are distinct; none serves another's purpose.
3. **Core is the transport and sole authority; Brain is non-load-bearing.** Only an owner-authenticated caller (not `trustedInProcess`) may create/steer; Core transports fetch/dispatch/completion and advances all lifecycle; Brain only routes an *informational*, still-eligible message to a downward tier candidate and can never create/steer/decide, transport, **forge a message/exhausted/completion, affect a recorded outcome, suppress an *action* banner, remove any inbox entry, receive locked-persona or fenced plaintext, or raise loudness.**
4. **Dina paces atomically, on cadence, within budget, before the hard TTL, on an open persona, with provider authority — and rechecks the barrier at commit.** `outstanding = enqueued_undecided + open_reservations` (reserved + held_by_lock); admission requires `now < run.expires_at` and the enqueue-commit CAS re-checks reservation-still-reserved + run-active + before-TTL; a lock-raced verified fetch is **Core-sealed and admitted exactly-once on unlock** (or terminally cancelled + crypto-shredded if a barrier intervenes first), never re-fetched, double-admitted, enqueued-after-a-barrier, or **silently** lost — even if the lock outlives replay retention. (The only loss path is a **detected** storage corruption/failure of the staged blob when provider replay is no longer available; it is surfaced as an owner-visible terminal `response_lost` error, never a silent drop — §7.)
5. **At most one logical delegation; honest about the effect.** One delegation per approved action via an atomic outbox claim; a refused/expired/fencing-barriered/past-TTL approval sends none, but a **cause-retained approved action under a permissive drain (count/exhaustion/finish_pending) remains eligible to dispatch during draining** until the deadline; receiver-deduped; effect exactly-once needs a conforming provider; **Core advances completions autonomously via idempotent CAS** (Brain cannot force `outcome_unknown`).
6. **The message declares its kind.**
7. **Risk gating is unchanged, layered after approve, persisted.** No delegation is sent before `risk_authorized` + a successful claim; an expired message or an elapsed hard bound never dispatches.
8. **Bounded and always-terminating; barriers strengthen only.** Both count bases and expiry set the barrier atomically; a barrier stops *admission* and invalidates outstanding reservations; a *permissive* barrier still lets cause-retained approvals dispatch, a *fencing* one does not; a `cancel_pending` stop or expiry may strengthen a permissive drain but nothing weakens a barrier; `drain_deadline_at` force-terminates every cause.
9. **Persona lock: no new fetch/classify/dispatch, no plaintext, revision preserved, nothing *silently* dropped.** A lock seals (device-wrapped keys for locked-arrival responses/result cards; persona-DEK-wrapped, unrecoverable keys for already-persisted ones), holds a `held_by_lock` fetch and an unclaimed `dispatch_pending` (re-armed on unlock; or terminally cancelled + crypto-shredded if a barrier intervenes), freezes classify/risk, and preserves `decision_revision`; an already-*claimed* effect may complete (card device-wrapped until unlock). The sole loss path — a detected staged-blob storage fault with provider replay unavailable — becomes an owner-visible terminal `response_lost` (slot released, cursor not advanced, run paused for owner skip/resume/stop, §7/§13), never a silent drop.
10. **Frozen delivery order; owner quiets an action, Brain routes informational.** Action = Core Tier-2 base (Brain not consulted); then owner ceiling, then mute/DND/quiet-hours. A Brain candidate never raises loudness, never affects an action, and never removes an inbox entry; only the **owner** may quiet an *action decision*; Brain may route an *informational* message to briefing. **V1 rejects `fiduciary`/Tier-1.**
11. **Termination is barriered, cause-and-strength-aware, force-bounded.** Fencing causes cancel/expire pre-dispatch (and cancel their classification jobs); permissive causes let cause-retained approvals dispatch until the deadline; already-claimed → `outcome_unknown`; outstanding reservations invalidated; authorization revoked.
12. **Owner commands are version-unconditional but state-gated;** out-of-state = idempotent no-op that never restores authorization or weakens a barrier; `pause` retains and cancels nothing.
13. **Owner sovereignty; attribution, not policing.** Content always service-attributed, never Dina's voice; structural bounds mitigate — not eliminate — engagement risk.
14. **Idempotent owner commands** via durable receipts (start keyed pre-`run_id`).
15. **Linearized.** One per-run transaction; count, the enqueue-commit (barrier point), the outbox claim (dispatch point, cause-and-strength-aware, hard-bound-guarded), and persona lock are ordered; persona lock preserves revisions while only termination invalidates them.
16. **State persists without Tier-0 plaintext, with crypto-shred retention.** Payloads are envelope-encrypted (ciphertext + a per-payload data key wrapped for confidentiality *and* under a per-payload, independently-destroyable leaf erasure key); a locked persona's confidentiality wrap is unrecoverable; restart rebuilds classification/decision/dispatch from the store; terminal payloads are crypto-shredded by destroying that payload's leaf key (works while locked; defeats WAL/snapshot/backup copies **when the frozen, owner-visible `erasure_mode` is `backup_resistant`**, else `logical_deletion` — §5/§12.5/§13/§20) after a bounded window, and inert ciphertext + orphans are GC'd only when unreferenced by any reservation/lifecycle/receipt and never mid-publish (Tier-0 blob registry, §13).
17. **Additive, not replacing.** `/v1/run/*` additive/owner-only; `/v1/session/*` untouched.
18. **Silence First survives.**

---

## 17. Implementation sequence

### Phase 0: single-step, local
Activate the `watch` kind; the Tier-0 run store, reservation (incl. `held_by_lock`), classification-job, command-receipt, completion-receipt (`verified_pending`/`advanced`) records, and the **envelope-encrypted payload store with per-payload-leaf-key crypto-shred (conformance-gated erasure store; graceful downgrade) + content-addressed prepared-write**; the **owner-only boundary**, the **provider `grant_id` binding**, and the **Core-transport / two-step-completion / Brain-pull-classify** split; a `max_count = 1` run with one message, pull mode, atomic gated admission (incl. the hard-TTL guard + barrier-guarded enqueue-commit), the full lifecycle incl. the atomic outbox claim (cause-and-strength-aware) + idempotent-CAS completion advancement + classify-timeout fallback. Prove the loop, that **an eligible risk-authorized action under `max_count=1` (decided basis) remains claimable and dispatches before the deadline** (not the external effect), that a barrier landing mid-fetch does not enqueue, and the trust boundaries.

### Phase 1: the paced loop
The `interactive_run` capability + signed schemas + classification view; the gated pacer (frozen `outstanding`; cap+interval+count+open-persona+hard-TTL+grant; **barrier-guarded enqueue-commit CAS**; on-arrival recheck; **device-wrap-buffer-and-admit-on-unlock**, terminal-cancel + crypto-shred on a barrier); pull-based informational classification (fence-aware acquire) + Core action-tier base + owner-quieting order + attribution/strip; the cause-and-strength barrier (atomic both bases; admission-only; monotonic strengthening; reservation invalidation; cause-aware dispatch) + `drain_deadline_at` + command/state matrix + linearization + atomic outbox claim + late-completion reconciliation + crash-recovery/verified-pending advancement; the **envelope-encryption + crypto-shred + orphan/terminal GC** + **storage-only-spool Expo/mobile adapter** + unlock recovery; the owner-only API + durable receipts + `/status` drain/grant visibility; run UI.

### Phase 2: reach and comfort
Informational push extension; `modify`-on-approve; **`fiduciary`/Tier-1 with a Core-deterministic harm condition**; signed cursor-ack; device sealing-key rotation policy; durable quiet-hours `deliver_after`; run summaries/history; multi-run.

### Phase 3: accountability
Opt-in `com.dinakernel.run.outcome` + provider run-quality standing.

Each phase requires demonstrated value from the preceding loop.

---

## 18. Conformance, adversarial and acceptance tests

- Creation: no stop/count/expiry, `queue_cap` out of range, or **`priority_ceiling = fiduciary` (V1)** rejected — `solicited`/`engagement` accepted; a protected service without a `provider_grant_id` cannot start; a public service needs none.
- Cadence/`outstanding`: a slot freed before `next_fetch_at` does not fetch; a tick at/after `run.expires_at` sets the expiry barrier instead of admitting; `outstanding = enqueued_undecided + open_reservations (reserved + held_by_lock)`, consistent across admission/cap-shrink/restart.
- **Barrier vs in-flight fetch:** a stop/expiry/deadline that lands after the query is sent but before commit makes the guarded enqueue-commit CAS fail — no message admitted, no cursor advance, fetched ciphertext crypto-shredded; both orderings (barrier-before-arrival, arrival-before-barrier) tested, across restart.
- Fetch-ahead + count: `queue_cap=3`, `max_count=2` — produced-basis commit reaching 2 barriers atomically (no 3rd) yet the 2nd stays classifiable/decidable; decided-basis never surfaces > can be decided within 2; surplus `cancelled`.
- **Final approved action dispatches (permissive drain):** with `max_count=1` decided basis, approving the sole message sets the permissive `count` barrier **and the action still risk-gates and dispatches** before `drain_deadline_at`; also tested for finish_pending stop and exhaustion; a cancel_pending stop / expiry fences it (including one that **strengthens** an in-progress count/exhaustion/finish_pending drain: previously-eligible unclaimed work is fenced).
- **Hard bounds in guards:** a delayed sweeper cannot admit or dispatch after `run.expires_at` or, while draining, after `drain_deadline_at` — the admission, enqueue-commit, and claim transactions fail closed on the elapsed bound; races tested.
- Classification/banner: `worker_acquire_classification` returns `{message_id, message_revision, classification_view, lease_token}` (bounded content, never `params`/vault) only for an open-persona, still-eligible `classification_pending` message; a fenced/terminal message yields none and invalidates any active lease; a late report against a fenced/terminal message is rejected; expired lease re-enqueues; on `classify_timeout` an informational message finalizes at the ceiling; **an action message is never sent to Brain and always takes the Tier-2 base**; a Tier-3 candidate cannot demote an action; **Brain routing an informational message to briefing is allowed but never removes its inbox entry**; the **owner** setting `priority_ceiling=engagement`/mute/DND/quiet-hours quiets an action banner (inbox entry retained); no candidate ever raises loudness.
- Completion: verified + committed `verified_pending` then **CAS-advanced idempotently** on the ingestion event even with no worker call; the crash-recovery pass re-advances a `verified_pending` receipt exactly once; the `drain_deadline_at` transaction reconciles a `verified_pending` receipt before `outcome_unknown` (receipt-before-deadline and deadline-before-receipt both tested); double-advance is impossible; forged/unsigned/replayed/mismatched rejected; a valid late completion is append-only evidence.
- Message expiry: a message past its signed `expires_at` while queued is `expired` and can never be surfaced-for-new-decision/`risk_authorized`/dispatched (rechecked at each gate; races tested).
- Dispatch claim: guard = "persona open + not expired + before `run.expires_at` + (active OR draining-permissive-cause-retained before `drain_deadline_at`)" — cancel_pending/expiry-barrier or elapsed-bound-before-claim → `cancelled`/`expired`; a **persona-lock**-before-claim **holds** the row and it dispatches on unlock (no silent drop); all orderings tested.
- Persona lock: a lock-raced verified fetch becomes `held_by_lock` (Core-sealed, device-wrapped key, ciphertext durably staged in the spool) and is **admitted exactly-once on unlock** (never re-fetched or lost even past replay retention and across restart); a barrier before unlock **terminally cancels** it and **crypto-shreds** + `ack`-deletes the buffered ciphertext without decryption; a lock holds an unclaimed dispatch, seals already-persisted payloads (confidentiality wrap unrecoverable), freezes classify/risk, preserves `decision_revision`; on unlock all resume; already-claimed completes (card device-wrapped then re-wrapped); Brain never receives locked plaintext; mobile matches Node.
- **Held-by-lock crash-safety (prepared-write/publish; no cross-DB txn):** the unlock migration durably writes the content-addressed vault ciphertext, then the **single Tier-0 CAS** commits reservation + `payload_ref` + cursor, then `ack`-deletes the spool blob; injected crashes at each boundary recover exactly-once — crash after the `prepared` pin + vault write before the Tier-0 CAS leaves a `prepared`-but-unpublished blob (reclaimed only by the prepared-lease sweep, never mid-publish) with the reservation still `held_by_lock` and the spool blob intact (retried), crash after the Tier-0 CAS before `ack` deletes an already-published blob idempotently (`payload_ref` present ⇒ no double-admit); a spool `peek` content-digest mismatch fails closed; spool capacity/I/O failure on the staged write fails the fetch closed (nothing admitted); tested on Node and mobile.
- **GC-vs-publish race:** interleavings of orphan-GC's delete-claim and the publish CAS (GC-before-publish and publish-before-GC), across restart, never leave Tier-0 committing a `payload_ref` to a deleted blob — a `prepared`/`published` registry row is never GC-deleted; only an `abandoned`/absent one is.
- **Orphan GC never eats a held response:** with a `held_by_lock` reservation live and no lifecycle row yet, the orphan sweeper (incl. during the lock and after restart) does **not** delete its spool blob (reachable via `reservation.sealed_response_ref` + its `prepared`/`published` registry row); a blob is deleted only when unreferenced by any reservation, lifecycle row, or completion receipt at an atomic delete-time recheck.
- **`response_lost`:** with the staged blob corrupted/lost and provider replay unavailable, the reservation goes terminal `response_lost` (`error_reason` persisted), releases its slot, does not advance the cursor, sets `paused_reason=response_lost`, surfaces in `/status` (`lost[]`) + a `run` notification, and does not count the lost item; an owner `/update skip_lost_reservation` advances past it, `resume`/`stop` behave as specified; restart-idempotent.
- **Crypto-shred retention (backup-resistant + per-payload isolation):** a terminal message/run crypto-shreds its payload/result **by destroying that payload's leaf erasure key** — verified to succeed **while the persona is locked**; **shredding one message's/reservation's leaf key leaves every other live payload in the run classifiable/decidable/dispatchable** (per-payload isolation); with a conforming non-backed erasure store, a test that **restores a pre-deletion `identity.sqlite` backup/WAL/snapshot and later supplies the persona DEK/device key still cannot decrypt** the ciphertext (the leaf key is gone and was never in the backup); on a backend that lacks the non-backup property the test instead asserts the **downgraded** logical-deletion claim (no backup-resistance asserted); deleting only the live Tier-0 row is shown insufficient; physical GC of inert ciphertext (with WAL/backup/vacuum handling) and orphan blobs follows; erasure is idempotent across restart; the spool stores only Core-supplied ciphertext (no plaintext ever written).
- **Erasure-key backend conformance + `erasure_mode`:** the platform erasure store demonstrably (a) keeps a leaf key out of every backup/snapshot/sync and (b) durably destroys it crash-safely; a backend failing either is rejected for the backup-resistant claim. The probed result is frozen as `erasure_mode` at `/start`, returned there and in `/status`; a `backup_resistant` run passes the restore-backup-still-undecryptable test, a `logical_deletion` run passes only the logical-deletion assertion and its owner-facing claim/UI reflects the weaker guarantee; both modes tested.
- Restart: after restart Core rebuilds the classification view, renders the decision, verifies the proposal, and dispatches, all from the **envelope-encrypted payload store** — with **no Tier-0 plaintext**.
- Provider grant: a protected query carries `provider_grant_id`; on expiry/revocation the run is `fetch-paused` with `paused_reason` **surfaced in `/status`** (still `active`, nothing cancelled); an owner `/update` rebinds and fetching auto-resumes; binding+expiry survive restart; `run_authorization` cannot satisfy provider `isAuthorized`.
- Command/state: `resume` on a terminal/draining run is an idempotent no-op that does not restore authorization or weaken a barrier; a `finish_pending` stop cannot weaken a `cancel_pending`/expiry drain; a replayed old `resume` after a newer `pause` is a no-op across restart.
- Trust boundaries: Brain has no fetch/dispatch/completion call; the mobile Brain `InProcessTransport` (`trustedInProcess=true`) is rejected from every `/v1/run/*` control mutation.
- Exhaustion: unsigned/forged rejected; a valid signed `exhausted` atomically barriers (permissive); replay idempotent.
- Delivery/Anti-Her/compat: owner ceiling/mute/DND/quiet-hours quiet as specified; a conversational owner-chosen service is never rejected; content always service-attributed even with the strip unavailable; `/v1/session/*` unchanged; malformed/oversized cards fail `validateCardSpec`.

---

## 19. Open decisions (deferred to implementation + conformance vectors)

- The message/exhausted/result/classification-view envelope + action-schema grammar, and its bounded, injection-safe encoding.
- Exact `MAX_QUEUE_CAP`, default `queue_cap`, interval bounds, `classify_timeout` (< pre-deadline window), `drain_deadline_at` window per scope.
- The concrete owner-only invocation mechanism per platform; the Brain-classify authentication.
- **Reservation lease, max recovery horizon, provider replay-retention minimum** (`> reservation_lease + max_recovery_horizon`, §7; note `held_by_lock` is retention-independent).
- Command-receipt and completion-receipt retention; **message/result payload terminal-retention (audit/replay) window, and the physical-GC of inert ciphertext incl. SQLCipher row deletion + WAL/backup/vacuum handling per platform** (§13); the completion recovery/reconciliation pass's exact ownership/ordering vs the ingestion CAS and the deadline (completion advancement itself is **not** a scheduled sweeper).
- The **device sealing key** for locked-arrival wraps: its provenance and `key_id` binding, rotation, and old-key retention/rewrapping (Phase 2), plus the Expo/mobile spool adapter.
- The AEAD/data-key scheme for envelope encryption + the wrapped-key format (a conformance vector).
- The **net-new hardened erasure-key backend** (V1 uses **per-payload, independently-destroyable leaf keys**, not per-run): its concrete construction and — the load-bearing dependency — its **per-platform non-backup + crash-safe-destroy guarantee**. The shipping `keystore-node`/`keystore-expo` do **not** provide this (plaintext files / default backup-syncable attributes); a conforming backend (e.g. Secure Enclave / StrongBox / an explicitly backup-excluded keyfile with secure erase) is required for the backup-resistant claim, and the run **degrades to logical deletion + physical GC** where it is unavailable.
- The **crash-safe content-addressed prepared-write/publish protocol** concrete values: staged-write durability (fsync), `peek`/`ack` semantics (net-new to `spool_node.ts`), the Tier-0-CAS-as-sole-commit ordering, and the recovery pass's ownership of orphan vault blobs + half-published `held_by_lock` blobs — on Node and mobile.
- Provider-grant expiry/revocation UX and re-grant flow.
- The **Phase-2 `fiduciary`/Tier-1 path**: a Core-deterministic harm condition + its data-model representation + the harm signal.
- A signed **cursor-ack** (Phase 2); durable quiet-hours `deliver_after` (Phase 2).
- The informational-run push extension is **open/deferred (Phase 2)** — it is **not** frozen in the sibling push doc yet; a shared contract must be written in both before it can be claimed.
- Whether informational messages route to the briefing by default; run-quality outcome disclosure (Phase 3).

---

## 20. Honest product claim

The architecture can credibly claim:

> Set up a service that streams you decisions, and Dina runs the whole loop: only you can start or steer it; Dina (not the untrusted analyst) fetches, dispatches, and records outcomes, and only when you have room, the interval has elapsed, your count and time allow, and your persona is open; she asks you to approve or deny each one individually; she creates at most one delegation per approved action, and even the final in-budget approval remains eligible to risk-gate and dispatch; and she always terminates when you say so, when the count or time is reached, or when it runs out — and you can strengthen a stop at any moment.

It must not claim:

- that a run auto-approves, batch-approves, or skips approval for SAFE actions;
- that Dina creates a delegation for *every* approval (at most one, created after `risk_authorized` and sent only via a successful atomic claim; a refused/expired/fencing-barriered/past-TTL approval sends none);
- that the final in-budget approval *always executes* (it **remains eligible** to risk-gate and dispatch under a permissive drain; a `cancel_pending` stop, expiry, an elapsed hard bound, a risk refusal, or a failed claim can still stop it);
- that an external effect is guaranteed exactly-once end-to-end (at-most-one *logical* delegation; effect dedup depends on a conforming provider; ambiguity → `outcome_unknown`);
- that stopping or locking recalls an already-*claimed* action (it completes with its result card sealed);
- that the interval is precise, delivery real-time, or a quiet-hours-suppressed banner re-issued at a precise later time;
- that the provider's declared risk or urgency affects gating or loudness, or that a run can reach Tier 1 in V1 (Phase 2; V1 rejects `fiduciary`);
- that a run can execute anything above its ceiling, a BLOCKED action, or a sensitive-persona action without the normal unlock/approval;
- that "trusted-in-process" is an owner-only boundary; that `run_authorization` authorizes calling a protected provider, or that `provider_grant_id` steers the loop;
- that Brain transports anything, advances a completion, affects an action's loudness, suppresses an *action* banner, or removes any inbox entry (only the **owner** may quiet an *action decision*; Brain may route an *informational* message to briefing), or that a compromised Brain can forge a message/exhausted/completion, supply an authoritative classification, receive a fenced/terminal view, or raise loudness;
- that provider content is trusted or is ever Dina's own voice; that the best-effort strip is a hard guarantee; that Dina polices which services the owner runs; or that the architecture prevents provider-created dependency (it mitigates, and guarantees attribution + owner control);
- that message payloads are stored as Tier-0 plaintext (they are envelope-encrypted; the spool holds only Core-supplied ciphertext) or retained forever (after a bounded window a terminal payload's per-payload leaf key is destroyed — **backup-resistant crypto-shred when `erasure_mode = backup_resistant`, else logical deletion** — then physical GC follows);
- that deleting a ciphertext file, or a live Tier-0 wrapped-key row, *is* the erasure guarantee (the guarantee is destroying the **per-payload leaf erasure key in a non-backed hardened store**, which defeats WAL/snapshot/backup copies; a mere row/file delete leaves backup-restorable ciphertext; physical GC is a follow-up);
- that backup-resistant crypto-shred holds on **any** platform, or that a run **hides which guarantee it provides** (it requires a net-new erasure backend that keeps leaf keys out of every backup and destroys them crash-safely; the shipping `keystore-node`/`keystore-expo` do **not** qualify; the actual guarantee is the frozen, owner-visible `erasure_mode` — `backup_resistant` or `logical_deletion` — returned from `/start` and `/status`; a `logical_deletion` run never presents itself as backup-resistant, §5/§12.5/§13/§19);
- that shredding one payload's key affects others (leaf keys are per-payload; the rest of the run stays usable), or that the payload store commits across the persona vault and Tier-0 in a single cross-database transaction (the Tier-0 pointer CAS is the sole atomic commit; the ciphertext write is an ordered, idempotent, content-addressed step);
- that push mode is available in V1, or that the informational-run push extension is frozen in the sibling doc (it is not);
- that a run continues without an owner-set termination policy, or that `finish_pending`/exhaustion can outlive `drain_deadline_at`.

The value is not a faster stream of proposals. The value is *a bounded, paced, owner-only sequence of decisions that remain individually yours — Dina holds the loop, creates at most one delegation per approval, always terminates, and lets you stop new activity the instant you want to.*
