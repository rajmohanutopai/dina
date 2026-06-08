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
```

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
| `queued` | `publishing` | worker/inline **CAS claim** |
| `publishing` | `published` | PDS write succeeded |
| `publishing` | `queued` | **retryable** failure (`attempts++`, `next_attempt_at = backoff`) |
| `publishing` | `failed` | **permanent** failure, or retries exhausted |
| `failed` | `queued` | user "Try again" (`attempts = 0`, `next_attempt_at = NULL`) |
| `queued` | `discarded` | user cancel |
| `failed` | `discarded` | user dismiss |

`publishing` has **no user-initiated transition** — the write is on the wire and will
go public; cancel is disabled (this is the dismiss-during-publish bug, fixed
structurally instead of by a UI flag).

**The claim is a compare-and-set, which gives single-flight for free** and deletes the
in-memory `drainInFlight` guard:

```sql
UPDATE peerlens_publish_jobs
   SET status='publishing', updated_at=?
 WHERE job_id=? AND status='queued';     -- affected rows == 1 ⇒ this caller owns it
```

Two overlapping workers can't both claim the same row; the loser's `UPDATE` affects 0
rows and it moves on. No coalescing promise, no kvHas re-check.

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
  | { kind: 'cap_exceeded' };

async function submitReviewPublish(input: {
  did: string;
  credentials: PdsCredentialState;   // 'configured' | 'absent' (see below)
  publisher: PDSPublisher | undefined;
  rkey: string;
  record: Record<string, unknown>;
  draft: AttestationDraftBody;
  threadId?: string; draftId?: string;
}): Promise<SubmitOutcome>;
```

Flow:

1. **Local validation** (same limits AppView enforces — text ≤ 2000 etc., shared with the
   form validator). Invalid → `{kind:'error', code:'lexicon_invalid'}`. Nothing persisted.
2. **Credential gate (locked decision).** If **no PDS account is configured at all** →
   `{kind:'no_credentials'}`. Nothing persisted; UI shows a setup prompt. *Distinct from*
   a configured-but-unreachable PDS (offline), which proceeds to queue. This distinction
   already exists in code: `tryBuildPdsPublisher → {publisher, sessionReachable}` — "absent
   credentials" ⇒ `publisher === undefined`; "offline" ⇒ `publisher` present,
   `sessionReachable === false`.
3. **Per-DID cap.** `countActive(did)` = jobs `WHERE owner_did=? AND status IN
   ('queued','publishing')`. `>= MAX_QUEUE_SIZE` → `{kind:'cap_exceeded'}`. (Foreign-DID
   rows never counted — they're a different `owner_did`.)
4. **Create job** `status='queued'`, `data_scope='user'`, stable `rkey`.
5. **Inline fast-path** (online, user scope): CAS-claim → `publishing` → attempt the PDS
   write once so an online user sees instant success/failure:
   - ok → `published`, write receipt (§7), return `{kind:'published'}`.
   - retryable → back to `queued` w/ backoff, return `{kind:'queued'}`.
   - permanent → `failed`, return `{kind:'error'}`.
   - offline (no `sessionReachable`) → skip the inline attempt, leave `queued`, return
     `{kind:'queued'}` — the worker drains on reconnect.
6. If the call came from a chat draft, the card stores `publishJobId` (§6) before returning.

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

`ReviewDraftLifecycle` keeps **only the pre-submit phase** it genuinely owns; it gains a
`publishJobId?` and **delegates post-submit status to the job**:

```
ReviewDraftLifecycle (chat message metadata):
  status: 'drafting' | 'ready'        ← LOCAL, before any job exists
  values: WriteFormState              ← the editor's working copy
  publishJobId?: string               ← set on Publish; thereafter the card READS the job
```

Card render logic:

```
if (no publishJobId)  → drafting / ready (editable; Publish enabled)
else read job(publishJobId).status:
    queued      → "Queued in Outbox"   + [View Outbox] [Cancel queued publish]
    publishing  → "Publishing…"        (spinner; NO cancel)
    published   → receipt (uri/cid)    (from the chat message, see §7)
    failed      → "Needs attention"    + [Try again] [Dismiss] + error message
    discarded   → "Removed"
```

This removes the entire class of "card stuck in publishing" / "card not patched because
the thread wasn't hydrated" bugs — the card has no status to get stuck; it reads the row.
The `setReviewDraftStatus(... 'publishing'|'published'|'failed'|'discarded')` calls and the
`hydrateThread`-before-patch dance go away; only the pre-submit `'ready'` patch (editor
values) remains.

**Reactivity:** the repository emits a change signal; `subscribeReviewJob(jobId, cb)` lets
the card re-render on transitions. (Same subscribe shape `outbox_store` had, but over the
table instead of a mirror.)

---

## 7. Receipts + pruning

Terminal rows must not accumulate as a growing log.

- On `published`: write the `{uri, cid}` receipt onto the **chat message** metadata
  (`updateReviewDraftLifecycle(... published receipt)`) so the receipt survives, **then**
  the worker prunes (`DELETE`) the job row. The card's `published` branch reads the receipt
  from the message, not the job.
- On `discarded`: `DELETE` the job immediately.
- `failed` rows persist (user-actionable) until the user retries (→ `queued`) or dismisses
  (→ deleted).

So at rest the table holds only `queued` + `publishing` + `failed` — exactly the rows the
Outbox shows.

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
  due = SELECT * FROM peerlens_publish_jobs
        WHERE owner_did=:did AND status='queued'
          AND (next_attempt_at IS NULL OR next_attempt_at <= :now)
        ORDER BY created_at
  for job in due:
    if not CAS-claim(job): continue          # someone else took it (single-flight)
    try: out = publish(job); markPublished(job, out); writeReceipt(job); prune(job)
    except err:
      c = classifyPublishError(err)
      if c.class == 'permanent': markFailed(job, c)
      elif job.attempts+1 >= MAX_ATTEMPTS: markFailed(job, code='retries_exhausted')
      else: requeue(job, attempts+1, backoff)
```

No `drainInFlight` (CAS), no in-memory mirror to keep in sync, no `markSubmitting`/
`markQueued`/`enqueueDeadLettered` helpers (status lives in the row), no kvHas re-check
(a cancelled job is `discarded`/deleted, so the claim finds nothing to claim).

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
  claim(jobId: string): boolean;                 // CAS queued→publishing; true if won
  markPublished(jobId: string, uri: string, cid: string): void;
  requeue(jobId: string, attempts: number, nextAttemptAt: number, err: ClassifiedError): void;
  markFailed(jobId: string, err: ClassifiedError): void;
  retry(jobId: string): void;                    // failed→queued, attempts=0
  discard(jobId: string): void;                  // queued|failed → delete
  prune(jobId: string): void;                    // delete (post-published)
  getById(jobId: string): PublishJob | null;
  countActive(ownerDid: string): number;         // queued+publishing
  listForOwner(ownerDid: string): PublishJob[];  // queued+publishing+failed (Outbox)
  listDue(ownerDid: string, nowMs: number): PublishJob[];
  purgeForeign(ownerDid: string): void;          // DELETE WHERE owner_did != ?
  subscribe(cb: () => void): () => void;         // change signal for projections
}
```

Wiring (per the Explore map):
- `boot_service.ts` (~L360): `reviewPublishRepository = databaseAdapter ? new
  SQLiteReviewPublishRepository(databaseAdapter) : new InMemoryReviewPublishRepository()`,
  passed into `createNode` options.
- `bootstrap.ts` `installCoreGlobals` (~L445): `setReviewPublishRepository(options.reviewPublishRepository)`.
- `init.ts` `initializePersistence` (~L187, beside `setChatMessageRepository`): wire the
  SQLite impl against `identityDB`.
- `CreateNodeOptions` gains `reviewPublishRepository?`.

---

## 11. Build order (each step keeps the suite green)

Because it's greenfield, the cutover deletes the old path rather than running both.

- **Phase A — engine (no UI):** migration v14; `ReviewPublishRepository` (SQLite +
  InMemory + globals); the state machine + CAS; `classifyPublishError`;
  `submitReviewPublish`; the worker. Wire through boot. **Contract tests** (§ below). The
  old `review_outbox_durable.ts`/`outbox_store.ts` still exist but are now dead weight.
- **Phase B — entrypoint cutover:** `WriteScreen.Publish` and `InlineReviewDraftCard.Publish`
  call `submitReviewPublish`; the card gains `publishJobId` + reads job status. Map the four
  submit outcomes to UI (incl. the new `no_credentials` setup prompt).
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
- **Error classifier table:** `(network=null, 408, 429, 5xx) → retryable`;
  `(400, 401, 403, identity_mismatch, lexicon_invalid, no_credentials) → permanent`. One
  data-driven test covering every case this thread fixed individually.
- **Per-DID cap:** 50 rows under DID-A do not block a publish under DID-B; cap counts
  `queued+publishing` only.
- **No-credentials:** `submit()` with absent creds → `{kind:'no_credentials'}`, **0 rows
  written**. Offline (creds present, unreachable) → `{kind:'queued'}`, 1 row.
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
