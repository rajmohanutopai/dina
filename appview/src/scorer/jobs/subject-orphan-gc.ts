import { alias } from 'drizzle-orm/pg-core'
import { and, eq, lt, notExists, or, inArray } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection.js'
import {
  attestations,
  flags,
  reviewRequests,
  subjectClaims,
  subjectScores,
  subjects,
  tombstones,
} from '@/db/schema/index.js'
import { logger } from '@/shared/utils/logger.js'
import { metrics } from '@/shared/utils/metrics.js'

/**
 * Minimum age before a subject is eligible for orphan GC.
 *
 * 30 days is the safety buffer. The ingester typically creates subjects
 * inline with the records that reference them (the subject row is
 * created in the same handler tick as the first attestation), so a
 * shorter buffer is sound in steady-state. The 30-day window protects
 * against:
 *   - Backfill / replay scenarios where records arrive out-of-order
 *     against a freshly-rebuilt subject table
 *   - Manual operator inserts (e.g., a future `dina-admin trust subjects
 *     create` for testing) that haven't been wired up to a referencer yet
 *   - Long-tail attestation arrival from federated PDSes that may take
 *     days to surface a record after the subject was created locally
 *
 * Tunable via the constant rather than a flag — operators almost never
 * need to change this, and the value is trivially auditable as a single
 * source of truth.
 */
const ORPHAN_AGE_DAYS = 30

/**
 * Maximum number of orphan rows the GC will reap per run.
 *
 * Bounds the per-tick load. Weekly cadence × 5000-row cap = ~260k
 * orphans/year cleared, which is more than the expected speculative-
 * subject churn for any practical AppView. If a backlog ever exceeds
 * this, the warning log + ops alerting will surface it (rather than a
 * single tick attempting a multi-million-row DELETE that holds locks
 * and churns vacuum). Conservative cap; ops can run multiple manual
 * passes to drain a one-time spike.
 */
const MAX_ORPHANS_PER_RUN = 5000

/**
 * `subject_orphan_gc` — weekly job (TN-SCORE-005 / Plan §5.4).
 *
 * Reaps `subjects` rows that have no live references from any record
 * type and are older than the safety threshold. Without this job,
 * speculatively-created subject rows (test fixtures, partial replays,
 * out-of-order ingestion that ultimately failed) would accumulate
 * indefinitely.
 *
 * **Reference graph audit** — a subject is referenced by ANY of:
 *   - `attestations.subject_id`           — the primary recall signal
 *   - `flags.subject_id`                  — moderation actions
 *   - `review_requests.subject_id`        — pending review intent
 *   - `subject_claims.source_subject_id`  — merge candidate
 *   - `subject_claims.target_subject_id`  — merge target
 *   - `tombstones.subject_id`             — deleted record's referent
 *   - `subjects.canonical_subject_id`     — merge target self-reference
 *
 * `endorsements`, `vouches`, `delegations` reference DIDs not subject
 * IDs, so they don't gate orphan status. `subject_scores` is the
 * computed score row — every subject has one — so it's NOT a referrer;
 * it's a dependent and gets cleaned up alongside the parent below.
 *
 * **Why six NOT EXISTS rather than LEFT JOIN counts**: the planner
 * short-circuits NOT EXISTS at the first matching row, while a count
 * scans the whole referrer set. With a 5000-row candidate window and
 * potentially millions of attestations, the difference is order-of-
 * magnitude. Each subquery hits the relevant `*_subject_idx` index.
 *
 * **Two-phase delete**: `subject_scores` has a FK constraint to
 * `subjects.id`. We delete the dependent score rows first, then the
 * parent subjects, in a single transaction. Without the explicit
 * dependent-first delete, pg would reject the parent delete with
 * a FK-violation error.
 *
 * **Idempotent + concurrent-safe**: the WHERE clause re-evaluates the
 * "is orphan" predicate on every run, so a row that gained a referrer
 * between candidate selection and delete is automatically excluded.
 * Combined with the scheduler's distributed advisory lock, only one
 * GC runs at a time across all scorer instances. Belt-and-suspenders.
 */
export async function subjectOrphanGc(db: DrizzleDB): Promise<void> {
  const ageCutoff = new Date(Date.now() - ORPHAN_AGE_DAYS * 24 * 60 * 60 * 1000)

  // Self-aliased `subjects` for the canonical-target subquery — pg
  // can't disambiguate two references to the same table inside the
  // same query without an explicit alias.
  const canon = alias(subjects, 'canon')

  // Phase 1 — pick up to MAX_ORPHANS_PER_RUN candidate orphan IDs.
  // Six structured `notExists` predicates rather than a raw `sql`
  // template — Drizzle generates the correlated subquery + alias
  // wiring + parameter binding for free, and the planner sees the
  // same shape it'd see from any other call site, hitting the
  // existing `*_subject_idx` indexes naturally.
  const candidates = await db
    .select({ id: subjects.id })
    .from(subjects)
    .where(
      and(
        lt(subjects.createdAt, ageCutoff),
        notExists(
          db.select().from(attestations).where(eq(attestations.subjectId, subjects.id)),
        ),
        notExists(
          db.select().from(flags).where(eq(flags.subjectId, subjects.id)),
        ),
        notExists(
          db.select().from(reviewRequests).where(eq(reviewRequests.subjectId, subjects.id)),
        ),
        notExists(
          db.select().from(subjectClaims).where(
            or(
              eq(subjectClaims.sourceSubjectId, subjects.id),
              eq(subjectClaims.targetSubjectId, subjects.id),
            ),
          ),
        ),
        notExists(
          db.select().from(tombstones).where(eq(tombstones.subjectId, subjects.id)),
        ),
        notExists(
          db.select().from(canon).where(eq(canon.canonicalSubjectId, subjects.id)),
        ),
      ),
    )
    .limit(MAX_ORPHANS_PER_RUN)

  if (candidates.length === 0) {
    logger.debug('subject-orphan-gc: no orphan subjects to reap')
    metrics.counter('scorer.subject_orphan_gc.deleted', 0)
    return
  }

  const orphanIds = candidates.map((c) => c.id)

  // Phase 2 — delete dependent score rows first, then parents.
  // `inArray` produces `IN ($1, $2, …)` which the planner can use
  // with the PK / `*_subject_idx` indexes; with the 5000-row cap
  // the parameter list size is bounded and well within pg's limits.
  await db.transaction(async (tx) => {
    await tx
      .delete(subjectScores)
      .where(inArray(subjectScores.subjectId, orphanIds))
    await tx
      .delete(subjects)
      .where(inArray(subjects.id, orphanIds))
  })

  const count = orphanIds.length
  logger.info({ count }, 'subject-orphan-gc: orphan subjects reaped')
  metrics.counter('scorer.subject_orphan_gc.deleted', count)

  // If we hit the per-run cap, there may be more orphans waiting.
  // Surface this so ops can investigate (e.g., backfill bug producing
  // unbounded speculative subjects) and optionally trigger a manual
  // sweep before the next weekly tick.
  if (count >= MAX_ORPHANS_PER_RUN) {
    logger.warn(
      { cap: MAX_ORPHANS_PER_RUN },
      'subject-orphan-gc: hit per-run cap, more orphans likely pending',
    )
    metrics.counter('scorer.subject_orphan_gc.cap_hit', 1)
  }
}
