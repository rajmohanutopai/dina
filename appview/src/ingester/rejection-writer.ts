import type { DrizzleDB } from '@/db/connection.js'
import type { Logger } from '@/shared/utils/logger.js'
import type { Metrics } from '@/shared/utils/metrics.js'
import { ingestRejections } from '@/db/schema/index.js'

/**
 * Rejection writer (TN-ING-005 / Plan §3.5.1 + §4.1).
 *
 * Single point of write for the `ingest_rejections` table. Every
 * ingester rejection path (rate-limit, schema-invalid, signature-
 * invalid, namespace-disabled, feature-off) flows through this
 * function so:
 *
 *   1. The mobile outbox watcher (Plan §3.5.1) sees a uniform shape
 *      via `at_uri` lookup — no per-reason format variance.
 *   2. The structured log line carries the same fields the row
 *      carries — search by `at_uri` works in logs and DB.
 *   3. Metrics bump uses a single counter with `reason` label so
 *      Grafana can chart rejections per-reason without bespoke
 *      counters per call site.
 *
 * **Closed reason taxonomy** matches the `ingest_rejections.reason`
 * column's documented values (TN-DB-005 schema docstring):
 *   - `rate_limit`         — author exceeded per-day cap
 *   - `signature_invalid`  — commit signature failed verification
 *   - `schema_invalid`     — record body / CID failed Zod / format check
 *   - `namespace_disabled` — author published under a `verificationMethod`
 *                            id that's no longer in their DID document
 *   - `feature_off`        — `appview_config.trust_v1_enabled = false`
 *
 * **Best-effort INSERT semantics**: the ingester pipeline must NEVER
 * fail because a rejection write failed (DB transient error, table
 * locked, etc.) — that would turn a single bad record into a
 * pipeline-wide outage. INSERT errors are logged at warn level and
 * the function returns normally; the structured log line + metric
 * are still emitted, so observability isn't lost when the row write
 * itself fails.
 *
 * **No transaction wrapping**: each rejection is its own row; we
 * deliberately don't share a transaction with the (failed) record
 * processing because the record never landed — there's nothing to
 * roll back. Each rejection write is independent.
 */

export type RejectionReason =
  | 'rate_limit'
  | 'signature_invalid'
  | 'schema_invalid'
  | 'namespace_disabled'
  | 'feature_off'

/** Subset of HandlerContext — the pieces a rejection writer actually needs. */
export interface RejectionContext {
  readonly db: DrizzleDB
  readonly logger: Logger
  readonly metrics: Metrics
  /**
   * Per-event correlation id (TN-OBS-002 / Plan §13.8). The
   * dispatcher synthesizes this at the top of `processEvent`; we
   * stamp it on the rejection log line so post-hoc queries can
   * reconstruct the full lifecycle of a rejected record. Optional
   * because legacy callers (and tests) may not supply one — when
   * absent, the log line simply omits the field rather than
   * fabricating a fresh trace mid-pipeline (which would be
   * misleading, suggesting the rejected record had its own trace
   * arc when it actually inherited the dispatcher's).
   */
  readonly traceId?: string
}

export interface RejectionParams {
  readonly atUri: string
  readonly did: string
  readonly reason: RejectionReason
  /** Reason-specific JSON context, e.g. `{ limit_remaining: 0 }` for rate-limit. */
  readonly detail?: Record<string, unknown>
}

/**
 * Record an ingester rejection. Writes one row to `ingest_rejections`,
 * emits a structured `warn`-level log line, and increments the
 * `ingester.rejections{reason=<reason>}` metric. Always returns
 * normally; INSERT failures are logged but do not propagate.
 */
export async function recordRejection(
  ctx: RejectionContext,
  params: RejectionParams,
): Promise<void> {
  // Best-effort INSERT — log + counter still fire even if the row
  // write fails, so observability survives a degraded DB.
  try {
    await ctx.db.insert(ingestRejections).values({
      atUri: params.atUri,
      did: params.did,
      reason: params.reason,
      detail: params.detail ?? null,
    })
  } catch (err) {
    ctx.logger.warn(
      { err, atUri: params.atUri, reason: params.reason },
      'Failed to write ingest_rejections row',
    )
  }

  // Structured log line — fields mirror the row columns so log search
  // by `at_uri` finds the same rejection that the outbox watcher will
  // pick up via DB poll. `detail` is spread at the top level for
  // ergonomic log queries (`reason="rate_limit" limit_remaining=0`).
  // `trace_id` (TN-OBS-002) is stamped when the dispatcher supplied
  // one, so the rejected record joins the same trace-id-keyed view
  // as successful ingests.
  ctx.logger.warn(
    {
      at_uri: params.atUri,
      did: params.did,
      reason: params.reason,
      ...(ctx.traceId ? { trace_id: ctx.traceId } : {}),
      ...(params.detail ?? {}),
    },
    'Record rejected by ingester',
  )

  ctx.metrics.incr('ingester.rejections', { reason: params.reason })
}
