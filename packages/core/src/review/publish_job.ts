/**
 * PeerLens publish-job domain — types + the state machine.
 *
 * One `PublishJob` row owns a single review's entire publish lifecycle
 * (docs/PEERLENS_PUBLISH_JOBS_DESIGN.md). The row is the single source of
 * truth; the inline chat card and the Outbox screen are projections of it.
 *
 * This file is pure (no I/O, no `@dina/brain`): types, the allowed-transition
 * table, and the error-code vocabulary. The repository (durable CRUD + CAS) is
 * in `publish_job_repository.ts`; the classifier that maps a thrown PDS error
 * to a {@link PublishErrorCode} lives mobile-side (it pattern-matches brain +
 * mobile error classes core can't import).
 */

/** Lifecycle states. `published`/`discarded` are terminal (the row is then
 *  pruned/deleted — see the design §7). `publishing` carries a worker lease. */
export type PublishJobStatus =
  | 'queued'
  | 'publishing'
  | 'published'
  | 'failed'
  | 'discarded';

/**
 * The stored error-code vocabulary. The classifier (mobile) emits the
 * publish-failure codes; `lease_expired` / `retries_exhausted` are set by the
 * worker; `demo_scope` / `no_credentials` are submit-time rejections that never
 * create a row but share the union for typed outcomes.
 */
export type PublishErrorCode =
  // retryable
  | 'network'
  | 'timeout'
  | 'server_5xx'
  | 'rate_limited' // 429
  | 'request_timeout' // 408
  | 'lease_expired'
  // permanent
  | 'identity_mismatch'
  | 'lexicon_invalid'
  | 'bad_request' // 400
  | 'unauthorized' // 401
  | 'forbidden' // 403
  | 'no_credentials'
  | 'retries_exhausted'
  | 'demo_scope'
  | 'unknown';

/** Classifier output, stored on the job (`last_error_*`). */
export interface ClassifiedError {
  readonly class: 'retryable' | 'permanent';
  readonly code: PublishErrorCode;
  readonly message: string;
}

/** A durable publish job. Mirrors the `peerlens_publish_jobs` row (camelCase). */
export interface PublishJob {
  readonly jobId: string;
  readonly ownerDid: string;
  readonly rkey: string;
  /** Attestation record body WITHOUT `$type` — the publish path adds it. */
  readonly recordJSON: string;
  /** Minimal body the Outbox/card render. */
  readonly draftJSON: string;
  readonly status: PublishJobStatus;
  readonly attempts: number;
  readonly lastErrorCode: PublishErrorCode | null;
  readonly lastErrorMessage: string | null;
  /** epoch ms; null = ready now (backoff gate). */
  readonly nextAttemptAt: number | null;
  readonly claimedAt: number | null;
  /** epoch ms the worker lease lapses (reaper requeues `publishing` past this). */
  readonly claimExpiresAt: number | null;
  /** Back-reference to the originating inline chat draft (the card finds its job by this). */
  readonly threadId: string | null;
  readonly draftId: string | null;
  readonly publishedUri: string | null;
  readonly publishedCid: string | null;
  readonly dataScope: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Fields the caller supplies to create a job; the repo defaults the rest. */
export interface NewPublishJob {
  readonly jobId: string;
  readonly ownerDid: string;
  readonly rkey: string;
  readonly recordJSON: string;
  readonly draftJSON: string;
  readonly threadId?: string;
  readonly draftId?: string;
  /** Caller-stamped creation time (the app passes `Date.now()`). */
  readonly createdAt: number;
}

/**
 * The allowed-transition table — the contract the repository enforces (each repo
 * method is a CAS on the `from` status). Exported so the test suite can assert
 * every allowed transition succeeds and every disallowed one is rejected.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<PublishJobStatus, ReadonlySet<PublishJobStatus>>> =
  {
    queued: new Set<PublishJobStatus>(['publishing', 'discarded']),
    publishing: new Set<PublishJobStatus>(['published', 'queued', 'failed']),
    published: new Set<PublishJobStatus>([]), // terminal — pruned
    failed: new Set<PublishJobStatus>(['queued', 'discarded']),
    discarded: new Set<PublishJobStatus>([]), // terminal — deleted
  };

/** True iff `from → to` is a legal lifecycle transition. */
export function canTransition(from: PublishJobStatus, to: PublishJobStatus): boolean {
  return ALLOWED_TRANSITIONS[from].has(to);
}

/** Statuses that occupy the per-identity queue cap (the "active" set). */
export const ACTIVE_STATUSES: readonly PublishJobStatus[] = ['queued', 'publishing'];

/** Statuses the Outbox screen surfaces (active + user-actionable failures). */
export const OUTBOX_STATUSES: readonly PublishJobStatus[] = ['queued', 'publishing', 'failed'];

/** Per-identity active-queue cap. Mirrors the old `MAX_QUEUE_SIZE`. */
export const MAX_PUBLISH_QUEUE = 50;

/** Stop retrying after this many attempts (then `failed` / `retries_exhausted`). */
export const MAX_PUBLISH_ATTEMPTS = 8;

/**
 * Worker claim lease. Must comfortably exceed the PDS publish timeout (the
 * publisher's default is 15s) so a merely-slow write isn't reclaimed out from
 * under an in-flight worker; the reaper only fires on a genuine crash/hang.
 */
export const PUBLISH_CLAIM_LEASE_MS = 60_000;

/** Exponential backoff (capped) for a retryable failure, by attempt count. */
export function publishBackoffMs(attempts: number): number {
  const base = 5_000; // 5s
  const capped = Math.min(base * 2 ** Math.max(0, attempts - 1), 5 * 60_000); // cap 5min
  return capped;
}
