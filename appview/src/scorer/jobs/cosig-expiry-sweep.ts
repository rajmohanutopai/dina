import { and, eq, lt } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection.js'
import { cosigRequests } from '@/db/schema/index.js'
import { logger } from '@/shared/utils/logger.js'
import { metrics } from '@/shared/utils/metrics.js'

/**
 * `cosig_expiry_sweep` — hourly job (TN-SCORE-006 / Plan §10).
 *
 * Flips `cosig_requests` rows from `pending` → `expired` when their
 * `expires_at` has passed. Sets `reject_reason = 'expired'` so UI
 * consumers can render uniform "did not endorse" surface across the
 * `rejected` and `expired` terminal states (per the schema docstring).
 *
 * **Why a sweep job rather than a per-row trigger or an on-read check**:
 *   - DB triggers on time-based predicates require a tickless trigger
 *     (pg_cron or app-side polling) — no real saving over an explicit
 *     job, and harder to reason about.
 *   - On-read expiry check would have to mutate state during a SELECT
 *     (or just paper over the stale state in API responses), which
 *     leaks the lifecycle abstraction. Several consumers see this
 *     table — the recipient inbox, the requester's outbox watcher,
 *     dashboards — they all want the same canonical truth.
 * The hourly job is the canonical state-transition path. Latency
 * between actual expiry and the `expired` flip is bounded by 1 hour;
 * Plan §10 accepts this for the MVP since cosig requests are
 * day-scale not minute-scale.
 *
 * **Index usage**: relies on `cosig_requests_expiry_idx` — a partial
 * index on `expires_at` WHERE `status = 'pending'`. This narrows the
 * scan to only candidate rows; terminal-state rows (the long-tail
 * majority) are excluded from the index entirely.
 *
 * **Single bulk UPDATE**: cosig request volume is low (Plan §10:
 * "day-scale ceremonies, ~hundreds per AppView per day at saturation").
 * Even at 1k expiring rows per tick, a single UPDATE with the partial
 * index is sub-second. No need for chunking. If volume grows, the
 * pattern can be revisited — but premature chunking adds complexity
 * for no current benefit.
 *
 * **Idempotent**: the WHERE clause filters by `status = 'pending'`, so
 * a row already flipped to `expired` (by a prior run, or by a concurrent
 * sweep on another scorer instance) is excluded. Multiple runs converge
 * to the same fixed point. Combined with the scheduler's distributed
 * advisory lock (`pg_try_advisory_lock`), only one sweep runs at a time
 * across all scorer instances; the WHERE clause is belt-and-suspenders.
 *
 * **State integrity**: the schema CHECK constraint enforces
 * `status IN ('pending', 'accepted', 'rejected', 'expired')`. We only
 * write `'expired'` here — accepted and rejected are application-set
 * via the recipient's response handler. This job CANNOT corrupt the
 * state machine even if the WHERE clause is buggy: the worst case is
 * "we flip something we shouldn't have" → CHECK still allows it →
 * but consumers see `expired` with `reject_reason='expired'` which
 * is recoverable. The right safeguard is the WHERE clause itself,
 * which is regression-pinned by tests.
 */
export async function cosigExpirySweep(db: DrizzleDB): Promise<void> {
  const now = new Date()

  // Drizzle's UPDATE returns a result whose row count differs by
  // driver. node-postgres returns `{ rowCount, command, ... }`; the
  // `.returning()` clause is the portable way to count exactly what
  // changed. We don't need the column data, just the count.
  const expired = await db
    .update(cosigRequests)
    .set({
      status: 'expired',
      rejectReason: 'expired',
      updatedAt: now,
    })
    .where(
      and(
        eq(cosigRequests.status, 'pending'),
        lt(cosigRequests.expiresAt, now),
      ),
    )
    .returning({ id: cosigRequests.id })

  const count = expired.length
  if (count > 0) {
    logger.info({ count }, 'cosig-expiry-sweep: pending requests expired')
  } else {
    logger.debug('cosig-expiry-sweep: no expired pending requests')
  }
  metrics.counter('scorer.cosig_expiry_sweep.expired', count)
}
