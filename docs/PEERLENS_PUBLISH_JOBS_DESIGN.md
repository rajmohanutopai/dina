# PeerLens Publish — Durable Job State Machine (V1 design)

**Status:** Design / plan only. No code in this pass.
**Date:** 2026-06-08
**Context:** This thread has been patching one publish/outbox lifecycle edge after
another (single-flight drains, dismiss-during-publish, dead-letter hydration,
DID-filtered caps, demo-scope races, foreign-identity rows). Each fix patched a
**sync seam between two representations of the same state**: the durable KV row
(`peerlens_outbox` namespace) and the in-memory `outbox_store` mirror. This doc
replaces that split with **one durable source of truth** — a `peerlens_publish_jobs`
SQLite table and a small state machine over it. The chat card, Outbox screen, and
write form become **projections**, not owners, of that state.

**Greenfield:** pre-release, local dev state is disposable. The table is created via
the normal schema-migration array; there is **no KV→table data migration** and no
back-compat path. The old `review_outbox_durable.ts` / `outbox_store.ts` / KV
`peerlens_outbox` path is deleted at cutover.

**Decisions locked (2026-06-08):**
- **No credentials → hard error, do not queue.** A queue requires a *configured* PDS
  account. A *transient outage* (creds exist, PDS unreachable) still queues. These
  are different conditions — see §4.
- This document is plan-only; build order is in §11.

**Rev 2 (2026-06-08, post-review).** Two correctness gaps closed and four
refinements folded in:
- **Claim lease + crash recovery** (§2/§3/§9): a `publishing` row whose owner crashed
  before a terminal transition would otherwise be stuck forever (no user transition,
  the worker only claims `queued`). A claim lease + reaper requeues it; safe because
  the stable `rkey` makes the PDS write idempotent (replace).
- **Service-owned chat metadata, transactional** (§4/§6/§7) — <b>SUPERSEDED by Rev 3
  below</b>: Rev 2 proposed writing the job row + the chat draft's `publishJobId` (+ receipt)
  in one transaction. Rev 3 replaced this with the `(thread,draft)` back-reference +
  receipt-on-row, removing the cross-table coupling entirely. (Kept here only as the decision
  trail; §4/§6/§7 describe the as-built model.)
- Submit-time guided-demo guard (§4); `record_json` shape locked (§2); collection
  hardcoded to `com.dinakernel.peerlens.attestation` (§2); UI copy distinguishes
  "published to your PDS" from "visible in AppView search" since indexing is async
  (§6); crash-recovery test added (§12).

**Rev 3 (2026-06-09, AS-BUILT — this section is the authoritative contract where it
differs from §2–§9 below).** Two deviations were taken during implementation; the
prose in later sections that says otherwise is superseded here (see
`implementation-notes.html` for full rationale):
- **No `publishJobId` on the chat message; the card finds its job by the
  `(thread_id, draft_id)` back-reference** (supersedes §4/§6's stored pointer).
  Eliminates the create-path cross-table transaction entirely — the job row is one
  atomic write that already carries the link.
- **The published receipt lives ON the job row, not on the chat message; there is no
  cross-table receipt transaction** (supersedes §7). The inline card projects the
  `published` state (uri/cid) straight off the retained job row. Consequences:
  - A job WITH a chat back-reference is RETAINED on `published` (the card reads it as
    the receipt). A job with NO back-reference (full-form publish) is PRUNED
    immediately after success — so those rows stay bounded.
  - `complete()` / `fail()` / `requeue()` are CAS-checked: a lease reclaimed
    mid-write yields a `lost` outcome (the owning tick records the real state),
    never a false "published".
- **Duplicate guard** (added §4): `submitReviewPublish` projects an existing
  `queued`/`publishing`/`published` job for the same `(thread,draft)` instead of
  minting a second one — a double-tap or form+inline race can't publish duplicates.
- **Worker cadence is boot + foreground only** (no NetInfo/periodic tick yet); the
  queued-card copy is worded as "in flight / will publish when back online", not a
  promise of instant retry.

---

## 1. Core principle

There is exactly one source of truth for anything that can outlive the current tap:

> the `peerlens_publish_jobs` table.

The inline chat draft card, the Outbox screen, and the write form **never publish
directly** and **never hold independent post-submit status**. They call one service
to create/transition a job, and they render by reading the job. No "hidden queued
publish," no two-status-fields-to-keep-in-sync, no in-memory mirror.

```
InlineReviewDraftCard.Publish ─┐
WriteScreen.Publish ───────────┼─► submitReviewPublish()  ──►  peerlens_publish_jobs  ◄── worker (drain)
                               │                                      ▲
                               └──────────── projections ─────────────┘
                                   (chat card status, Outbox list)
```

---

## 2. Data model

New table, created as migration **v14** in `packages/core/src/storage/schemas.ts`
(`IDENTITY_MIGRATIONS` — it lives in `identity.sqlite`, alongside `kv_store`,
`workflow_tasks`, `chat_messages`; current latest version is **13**). Schema-migration
mechanics: `applyMigrations` runs each `{version,name,sql}` in a `db.transaction`,
version-tracked via the `schema_version` table (`packages/core/src/storage/migration.ts`).

```sql
CREATE TABLE IF NOT EXISTS peerlens_publish_jobs (
  job_id             TEXT PRIMARY KEY,            -- local uuid, stable across restart
  owner_did          TEXT NOT NULL,              -- author = PDS repo owner
  rkey               TEXT NOT NULL,              -- stable AT-rkey (idempotent retries / edit replace)
  record_json        TEXT NOT NULL,              -- the attestation record body (no $type)
  draft_json         TEXT NOT NULL,              -- minimal body the Outbox/card render
  status             TEXT NOT NULL CHECK (status IN
                       ('queued','publishing','published','failed','discarded')),
  attempts           INTEGER NOT NULL DEFAULT 0,
  last_error_code    TEXT,                        -- classifier code (see §5)
  last_error_message TEXT,
  next_attempt_at    INTEGER,                     -- epoch ms; NULL = ready now (backoff gate)
  claimed_at         INTEGER,                     -- epoch ms a worker claimed (→ publishing)
  claim_expires_at   INTEGER,                     -- epoch ms the lease lapses (reaper requeues)
  thread_id          TEXT,                        -- originating inline chat draft (nullable)
  draft_id           TEXT,                        -- "
  published_uri      TEXT,
  published_cid      TEXT,
  data_scope         TEXT NOT NULL DEFAULT 'user',
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ppj_owner_status ON peerlens_publish_jobs(owner_did, status);
CREATE INDEX IF NOT EXISTS idx_ppj_draft        ON peerlens_publish_jobs(thread_id, draft_id);
CREATE INDEX IF NOT EXISTS idx_ppj_lease        ON peerlens_publish_jobs(status, claim_expires_at);
```

**`record_json` shape (locked):** the attestation record body **WITHOUT** the `$type`
discriminator — `publishAttestationToPDS` / the inject path add
`$type: com.dinakernel.peerlens.attestation` at write time. (Matches the current code.)
A contract test pins this so the stored body and the wire body can't silently diverge.

**Collection (locked):** hardcoded to `com.dinakernel.peerlens.attestation`
(`PEERLENS_NSIDS.attestation`). This table is PeerLens-attestation-only; there is no
per-row collection column.

**`data_scope` is stamped `'user'` explicitly on insert — NOT `currentDataScope()`.**
Publish jobs are real user data and must survive guided-demo teardown (the scope
cleanup deletes scope-stamped rows). We never create a publish job in demo scope; the
worker additionally refuses to run under a demo scope (§8). The column exists for
consistency + a possible future "demo publishing" mode, but V1 always writes `'user'`.

The table replaces, in one place, what was previously spread across: KV `record`/`draft`/
`attempts`/`createdAt` (durable), `outbox_store` row `status` (mirror), and
`ReviewDraftLifecycle.status` (chat card). One row, one status, one attempt count.

---

## 3. State machine

```
            submit (creds ok)
   (none) ───────────────────►  queued
                                  │  ▲ retryable failure (attempts++, backoff)
                    claim (CAS)   │  │
                                  ▼  │
                              publishing
                              │   │   │
                  ok          │   │   │  permanent failure / retries exhausted
            ┌─────────────────┘   │   └─────────────────────┐
            ▼                     │ (no user transition      ▼
        published                 │  here — cancel disabled) failed
                                  │                          │  ▲
            user cancel ◄─────────┘                user retry│  │ user cancel
            (queued only)                       (reset attempts)│
                                  queued ◄───────────────────┘  │
                                  failed ──────────────────────►┘
        discarded ◄── (from queued or failed only)
```

Allowed transitions (everything else is rejected by the repo):

| From | To | Trigger |
|------|----|---------|
| — | `queued` | `submit()` with valid record + configured creds |
| `queued` | `publishing` | worker/inline **CAS claim** (sets lease) |
| `publishing` | `published` | PDS write succeeded |
| `publishing` | `queued` | **retryable** failure (`attempts++`, `next_attempt_at = backoff`) |
| `publishing` | `failed` | **permanent** failure, or retries exhausted |
| `publishing` | `queued` | **lease expired** (owner crashed mid-write) — reaper, `attempts++`, backoff |
| `failed` | `queued` | user "Try again" (`attempts = 0`, `next_attempt_at = NULL`) |
| `queued` | `discarded` | user cancel |
| `failed` | `discarded` | user dismiss |

`publishing` has **no user-initiated transition** — the write is on the wire and will
go public; cancel is disabled (this is the dismiss-during-publish bug, fixed
structurally instead of by a UI flag). It does have **one system transition besides the
publish result: lease expiry** (below) — the only escape from a crash mid-write.

**The claim is a compare-and-set that also writes the lease**, which gives single-flight
for free (deletes the in-memory `drainInFlight` guard) AND makes crashes recoverable:

```sql
UPDATE peerlens_publish_jobs
   SET status='publishing', claimed_at=:now, claim_expires_at=:now + :LEASE_MS, updated_at=:now
 WHERE job_id=:id AND status='queued';   -- affected rows == 1 ⇒ this caller owns it
```

Two overlapping workers can't both claim the same row; the loser's `UPDATE` affects 0
rows and it moves on. No coalescing promise, no kvHas re-check.

**Lease recovery (crash safety).** If the app dies after `claim()` but before a terminal
transition, the row sits in `publishing` with nothing to move it — `publishing` has no
user transition and the worker only claims `queued`. So before each pass the worker reaps
expired leases back to `queued`:

```sql
UPDATE peerlens_publish_jobs
   SET status='queued', attempts=attempts+1, next_attempt_at=:now,
       claimed_at=NULL, claim_expires_at=NULL,
       last_error_code='lease_expired', updated_at=:now
 WHERE owner_did=:did AND status='publishing' AND claim_expires_at < :now;
```

Safe because retries reuse the **same `rkey`**: if the previous `putRecord` actually
*succeeded* before the crash, re-publishing replaces the identical record (no duplicate
on AppView); if it didn't, the retry completes it. `LEASE_MS` must comfortably exceed the
PDS publish timeout (the publisher's `DEFAULT_TIMEOUT_MS` is 15s) — e.g. **60s** — so a
merely-slow write isn't reclaimed out from under an in-flight worker. Counting the reclaim
as an attempt means a *poison* job (one that crashes the app every publish) eventually
dead-letters via `MAX_ATTEMPTS` instead of crash-looping forever.

---

## 4. `submitReviewPublish()` — the only entrypoint

Both `InlineReviewDraftCard.Publish` and `WriteScreen.Publish` call this. No
test-inject-only path in production; no card-specific publish path.

```ts
type SubmitOutcome =
  | { kind: 'published'; uri: string; cid: string }   // inline fast-path succeeded
  | { kind: 'queued'; jobId: string }                 // durable, worker will drain
  | { kind: 'error'; code: PublishErrorCode; message: string }      // permanent
  | { kind: 'no_credentials' }                        // hard error — nothing persisted
  | { kind: 'cap_exceeded' }
  | { kind: 'demo_scope' };

async function submitReviewPublish(input: {
  did: string;
  publisher: PDSPublisher | undefined;   // undefined ⇒ no credentials
  rkey: string;
  record: Record<string, unknown>;
  draft: AttestationDraftBody;
  threadId?: string; draftId?: string;
  // injectable seams (production defaults at the call site): repo, nowMs,
  // newJobId, publishToPDS?, isDemoScope?, now?
}): Promise<SubmitOutcome>;
```

Flow:

0. **Guided-demo guard.** If `isGuidedDemoScope(currentDataScope())` → never create a real
   publish job; return `{kind:'demo_scope'}`. Defense-in-depth: the worker also refuses to
   drain under demo scope (§8), but the job must not be *created* under it either.
0.5 **Duplicate guard (back-reference).** When `threadId`/`draftId` are present, look up the
   existing job by `(thread_id, draft_id)`:
   - `queued`/`publishing` → return `{kind:'queued', jobId}` — already in flight; don't mint
     a second job (a double-tap / re-render race / form+inline both publishing the same
     draft would otherwise create two jobs with different fresh rkeys → duplicate reviews).
   - `published` → return `{kind:'published', uri, cid}` from the retained row (idempotent —
     never republish).
   - `failed` → **supersede it** (`discard` the stale row) then fall through to create the
     replacement; the failed row never published, so a re-attempt (possibly edited) is safe,
     but leaving it would put a stale "Try again" row in the Outbox that could publish a
     second record after the replacement succeeds.
1. **Local validation** (same limits AppView enforces — `lexiconErrorFor`, text ≤ 2000).
   Invalid → `{kind:'error', code:'lexicon_invalid'}`. Nothing persisted.
2. **Credential gate (locked decision).** If **no PDS account is configured** (`publisher
   === undefined`) → `{kind:'no_credentials'}`. Nothing persisted; UI shows a setup prompt.
   *Distinct from* a configured-but-unreachable PDS (offline): a publisher is present and the
   inline attempt below simply fails network-retryable → the job queues.
3. **Per-DID cap.** `countActive(did)` = jobs `WHERE owner_did=? AND status IN
   ('queued','publishing')`. `>= MAX_PUBLISH_QUEUE` → `{kind:'cap_exceeded'}`. (Foreign-DID
   rows never counted — different `owner_did`.)
4. **Create job.** ONE atomic row (`status='queued'`, `data_scope='user'`, stable `rkey`,
   plus `thread_id`/`draft_id` when present). No chat-message write — the card finds this job
   by the `(thread,draft)` back-reference (§6), so there is no cross-table coupling on create.
5. **Inline fast-path** (always attempted — no reachability pre-check; an offline device
   fails the fetch immediately → queued): CAS-claim → `publishing` → one attempt:
   - ok → `published` (receipt on the row); return `{kind:'published'}`. A job with NO
     `thread/draft` is pruned immediately (§7); an inline-chat job is retained as the card's
     receipt.
   - retryable → back to `queued` w/ backoff → `{kind:'queued'}`.
   - permanent → `failed` → `{kind:'error'}`.
   - CAS lost (lease reclaimed mid-write) → `{kind:'queued'}` (the worker owns it).

The UI's job after `submit()` returns is only to navigate / re-render from job state (§6)
and, for `no_credentials`/`cap_exceeded`, show the inline message. It performs no lifecycle
writes.

---

## 5. One shared error classifier

Used by **both** the inline fast-path and the worker — no divergent retry logic.

```ts
type PublishErrorCode =
  | 'network' | 'timeout' | 'server_5xx' | 'rate_limited' | 'request_timeout'   // retryable
  | 'identity_mismatch' | 'lexicon_invalid' | 'bad_request' | 'unauthorized'
  | 'forbidden' | 'no_credentials';                                             // permanent

function classifyPublishError(err: unknown):
  { class: 'retryable' | 'permanent'; code: PublishErrorCode; message: string };
```

| Class | Conditions |
|-------|-----------|
| **retryable** | network failure (`PDSPublisherError.status === null`), timeout, PDS **5xx**, **408**, **429** |
| **permanent** | identity mismatch, lexicon/text-too-long, **400**, **401**, **403**, no credentials |

retryable → `publishing → queued` (backoff). permanent → `publishing → failed` (or, in
the inline path, surfaced as `{kind:'error'}` so the user sees it immediately). This is
exactly the logic currently split between `review_publish_service.ts` (4xx/429/408) and
`publish_attestation.ts` (identity/lexicon) — unified into one function with a table-driven
test (§10).

---

## 6. Projection: the inline chat draft card

`ReviewDraftLifecycle` keeps **only the pre-submit phase** it genuinely owns; it stores NO
`publishJobId`. The card finds its job by the `(thread_id, draft_id)` **back-reference** on
the job row and **delegates every post-submit state to the job**:

```
ReviewDraftLifecycle (chat message metadata):
  status: 'drafting' | 'ready' | 'discarded'   ← LOCAL only (pre-submit + the discarded terminal)
  values: WriteFormState                       ← the editor's working copy
  (no publishJobId — the job carries thread_id/draft_id; the card queries by those)
```

The card calls `useReviewPublishJob(threadId, draftId)` → `findLatestForDraft(...)` and
subscribes to repo changes. Because the job row is a single atomic write that already
carries the link, there is **no window** where a job exists but its card doesn't know — and
no cross-table transaction on create.

Card render logic:

```
if (lc.status === 'drafting')  → drafting (spinner)
else if (a job exists)         → render by job.status:
    queued      → "Queued in Outbox"   + [View Outbox] [Cancel]
    publishing  → "Publishing…"        (spinner; NO cancel — write is on the wire)
    published   → receipt (uri/cid read off the job row)
    failed      → "Couldn't publish"   + [Try again] [Dismiss] + describePublishErrorCode(code)
else if (lc.status === 'discarded') → "Removed"
else                          → ready (editable; Publish enabled)
```

Cancel / Dismiss `discard` the job → the card falls back to its editable `ready` draft (no
hydration dependency). "Try again" `retry`s the job in place. This removes the entire class
of "card stuck in publishing" / "thread-not-hydrated no-op" bugs — the card has no
post-submit status of its own; it reads the row.

**Copy: "published" ≠ "indexed."** `published` means the PDS write landed. AppView indexing
(Jetstream → ingester) is **async**, seconds later. The receipt copy says *"Published your
review"*, and the queued copy says *"in flight / will publish when back online"* — not a
promise of instant search visibility or instant retry.

---

## 7. Receipts + retention

The published receipt (`uri`/`cid`) lives **on the job row** — there is NO chat-message
receipt write and NO cross-table transaction (the seam that would have needed a sync chat
write inside the repo txn). Retention is bounded by which jobs a projection still needs:

- On `published`: the receipt is recorded on the row by `complete()`. A job WITH a chat
  back-reference (`thread_id`/`draft_id`) is **retained** — the inline card reads it as the
  receipt. A job with NO back-reference (a full-form publish) is **pruned immediately** after
  success — nothing projects it, so it can't accumulate.
- On `discarded` (Cancel/Dismiss): `DELETE` the job. The card (a projection) then falls back
  to its editable draft; the Outbox row disappears.
- `failed` rows persist (user-actionable) until the user retries (→ `queued`), dismisses
  (→ deleted), or re-submits the draft (the stale failed row is superseded — §4 step 0.5).
- Every terminal transition (`complete`/`fail`/`requeue`) is CAS-guarded; a lease reclaimed
  mid-write yields `lost` rather than a false outcome.
- `prunePublished(ownerDid, olderThanMs)` exists as an escape hatch if retained inline-chat
  published rows ever need a TTL sweep; unscheduled in V1.

So at rest the table holds `queued` + `publishing` + `failed` (the rows the Outbox shows)
**plus** the `published` rows that still back an inline chat card (the card's receipt).
Full-form `published` rows are pruned on success, so the only retained `published` rows are
inline-chat receipts — bounded by the user's chat history, and TTL-prunable via
`prunePublished` if ever needed.

---

## 8. DID isolation + guided-demo guard

- **Every query filters `owner_did = currentDid`.** Outbox list, cap count, and the worker's
  due-query all scope to the booted DID. Foreign-identity rows (after restore/re-onboard)
  are simply never selected — no special "hide" logic, no per-DID hydrate filter, no
  foreign-rows-occupy-the-cap bug. Optional housekeeping on re-onboard: `DELETE WHERE
  owner_did != currentDid`.
- **Worker refuses to run under a demo scope.** `if (isGuidedDemoScope(currentDataScope()))
  return;` at the top of the worker tick (same guard as today's `drainBootedReviewOutbox`,
  now in one place). Combined with jobs always being `data_scope='user'`, a demo can never
  publish a real review or have its teardown delete a pending job.

---

## 9. The worker (drain) replaces the autodrain

`runReviewPublishWorker()` — started at boot + on every foreground (replacing
`startReviewOutboxAutodrain`):

```
tick():
  if isGuidedDemoScope(currentDataScope()): return
  reclaimExpiredLeases(did, now)             # publishing + claim_expires_at < now → queued (§3)
  due = SELECT * FROM peerlens_publish_jobs
        WHERE owner_did=:did AND status='queued'
          AND (next_attempt_at IS NULL OR next_attempt_at <= :now)
        ORDER BY created_at
  for job in due:
    if not CAS-claim(job): continue          # someone else took it (single-flight); also writes lease
    try: out = publish(job); markPublished+writeReceipt+prune(job)   # one txn (§7)
    except err:
      c = classifyPublishError(err)
      if c.class == 'permanent': markFailed(job, c)
      elif job.attempts+1 >= MAX_ATTEMPTS: markFailed(job, code='retries_exhausted')
      else: requeue(job, attempts+1, backoff)
```

The **first step every tick is the lease reaper** (§3) — it's what rescues a row whose
owner crashed mid-write. No `drainInFlight` (CAS), no in-memory mirror to keep in sync, no
`markSubmitting`/`markQueued`/`enqueueDeadLettered` helpers (status lives in the row), no
kvHas re-check (a cancelled job is `discarded`/deleted, so the claim finds nothing to
claim).

---

## 10. Repository interface (convention-matched)

Follows the existing repo convention (`ServiceConfigRepository`, `WorkflowRepository`,
`ChatMessageRepository`): interface + `SQLite*` impl (ctor takes `DatabaseAdapter`,
synchronous queries) + `InMemory*` impl for tests + global `set/get*Repository`.
`WorkflowRepository` precedent: **synchronous** signatures are allowed for repos whose
transitions must complete inside `db.transaction()` (pinned exempt in
`port_async_gate.test.ts`) — the CAS claim wants this.

```ts
export interface ReviewPublishRepository {
  create(job: NewPublishJob): void;
  claim(jobId: string, nowMs: number, leaseMs: number): boolean;             // CAS queued→publishing + lease
  reclaimExpiredLeases(ownerDid: string, nowMs: number): number;            // publishing+expired → queued
  complete(jobId: string, uri: string, cid: string, nowMs: number): boolean; // CAS publishing→published (receipt on row)
  requeue(jobId, attempts, nextAttemptAt, err: ClassifiedError, nowMs): boolean; // CAS publishing→queued
  fail(jobId: string, err: ClassifiedError, nowMs: number): boolean;        // CAS publishing→failed
  retry(jobId: string, nowMs: number): boolean;                            // failed→queued, attempts=0
  discard(jobId: string): boolean;                                          // queued|failed → delete
  prune(jobId: string): void;                                              // unconditional delete
  getById(jobId: string): PublishJob | null;
  findLatestForDraft(ownerDid, threadId, draftId): PublishJob | null;       // the card's back-reference projection
  countActive(ownerDid: string): number;                                   // queued+publishing (the cap)
  listForOwner(ownerDid: string): PublishJob[];                            // queued+publishing+failed (Outbox)
  listDue(ownerDid: string, nowMs: number): PublishJob[];
  prunePublished(ownerDid: string, olderThanMs: number): number;           // retention escape hatch (unscheduled V1)
  purgeForeign(ownerDid: string): void;                                    // DELETE WHERE owner_did != ?
  transaction(fn: () => void): void;                                       // atomic block (SQLite) / snapshot-rollback (InMemory)
  subscribe(cb: () => void): () => void;                                   // change signal for projections
}
```

Every status transition is a **CAS returning a boolean** (`db.run(UPDATE … WHERE …
AND status=?)` → affected-rows): the caller checks it and reports `lost` if the row was
reclaimed mid-write. There is **no `db` handle on the interface and no cross-table coupling**
— the back-reference (§6) removes the create-path transaction, and the receipt-on-row (§7)
removes the publish-path one. `transaction(fn)` exists only so a caller could batch repo
writes atomically; the publish flow uses single-row CAS transitions.

Wiring (as built):
- `boot_service.ts`: `reviewPublishRepository = databaseAdapter ? new
  SQLiteReviewPublishRepository(databaseAdapter) : new InMemoryReviewPublishRepository()`,
  passed into `createNode` options.
- `CreateNodeOptions` (bootstrap.ts) gains `reviewPublishRepository?`; `installCoreGlobals`
  calls `setReviewPublishRepository(options.reviewPublishRepository)` and unwires it on
  dispose — matching the `serviceConfigRepository` pattern exactly.
- Exposed from the `@dina/core/runtime` curated barrel (which `bootstrap`/`boot_service`
  import). The card/Outbox/worker resolve it via the global `getReviewPublishRepository()`.

---

## 11. Build order (each step keeps the suite green)

Because it's greenfield, the cutover deletes the old path rather than running both.

- **Phase A — engine (no UI):** migration v14 (incl. lease columns); `ReviewPublishRepository`
  (SQLite + InMemory + globals) with `claim`-with-lease + `reclaimExpiredLeases`;
  `classifyPublishError`; `submitReviewPublish` (demo guard + back-reference dedup);
  the worker (lease reap → claim → publish). Wire through boot. **Contract tests** (§12),
  including crash-recovery. The old `review_outbox_durable.ts`/`outbox_store.ts` still exist
  but are now dead weight.
- **Phase B — entrypoint cutover:** `WriteScreen.Publish` and `InlineReviewDraftCard.Publish`
  call `submitReviewPublish`; the card reads its job via the `(thread,draft)` back-reference.
  Map the submit outcomes to UI (incl. the `no_credentials` setup prompt).
- **Phase C — delete the old world:** remove `outbox_store.ts` (mirror), the KV functions in
  `review_outbox_durable.ts`, `drainInFlight`, the `markSubmitting/markQueued/
  enqueueDeadLettered/hydrateBooted` helpers, the `peerlens_outbox` KV namespace, and the
  post-submit branches of `setReviewDraftStatus`. Outbox screen + chat card subscribe to the
  repo. The race-prone seams no longer exist to race.

---

## 12. Test plan — contract tests that close the bug *classes*

Each past race-fix becomes a contract test on the new model (the
"contract-tests-over-scenario-tests" principle — close the class, not the instance):

- **State machine:** every allowed transition succeeds; every disallowed transition (e.g.
  `published → queued`, `publishing → discarded`, `discarded → anything`) is rejected.
- **CAS single-flight:** two concurrent `claim(jobId)` → exactly one returns true. (Replaces
  the `drainInFlight` coalescing test.)
- **Crash recovery / lease reclaim:** claim a job (→ `publishing`) and never finish it;
  advance the clock past `claim_expires_at`; `reclaimExpiredLeases` returns it to `queued`
  with `attempts++`; the next worker pass re-publishes with the **same `rkey`** (assert the
  rkey is unchanged → idempotent). A row still within its lease is NOT reclaimed. A job that
  reclaims past `MAX_ATTEMPTS` dead-letters (`failed`, `retries_exhausted`) — no crash loop.
- **Error classifier table:** `(network=null, 408, 429, 5xx) → retryable`;
  `(400, 401, 403, identity_mismatch, lexicon_invalid, no_credentials) → permanent`. One
  data-driven test covering every case this thread fixed individually.
- **`record_json` shape:** the stored body has **no `$type`**; the publish path adds
  `$type: com.dinakernel.peerlens.attestation`. Asserts stored-vs-wire can't diverge.
- **Per-DID cap:** 50 rows under DID-A do not block a publish under DID-B; cap counts
  `queued+publishing` only.
- **No-credentials:** `submit()` with absent creds → `{kind:'no_credentials'}`, **0 rows
  written**. Offline (creds present, unreachable) → `{kind:'queued'}`, 1 row.
- **Submit demo-scope guard:** `submit()` under `guided_demo:*` creates **0** job rows.
- **Duplicate guard (back-reference):** a second `submit()` for the same `(thread,draft)`
  while a job is `queued`/`publishing` returns that job (no 2nd row); after `published` it
  returns the existing receipt; a stale `failed` row is superseded (discarded) before the
  replacement is created — exactly one publishable job per draft.
- **CAS-lost outcome:** a transition whose CAS fails (lease reclaimed mid-write) yields
  `lost` — never a false `published`; submit maps it to `queued`, the worker doesn't count it.
- **Retention:** a `published` job with a chat back-reference is retained (card receipt); one
  with no back-reference (full-form publish) is pruned immediately after success.
- **Cancel rules:** `discard` allowed from `queued`/`failed`; rejected from `publishing`.
- **Worker demo-scope skip:** worker tick under `guided_demo:*` claims nothing; jobs stay
  `queued`; resumes under `user`.
- **Projection:** chat card label per job status; `published` receipt read from the message
  survives job prune; dismissing a `failed` job removes the card's stuck state.
- **DID-scoped Outbox:** `listForOwner` returns only current-DID `queued/publishing/failed`.

---

## 13. What this is NOT (V1 scope)

- Not a generic background-job framework — it's the review-publish lifecycle only. (The
  `WorkflowRepository` already exists for agent tasks; this is deliberately separate and
  smaller.)
- Not a server-side queue — mobile-local, per the TS consolidation direction.
- Not cross-device sync — jobs are local to the Home Node that drafted them.
- No "demo publishing" — demo review cards stay inert/sample (worker skips demo scope).
```
