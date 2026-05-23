import { and, desc, eq, type SQL } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection.js'
import { adminAuditLog } from '@/db/schema/admin-audit-log.js'

/**
 * Typed chokepoint for inserts into `admin_audit_log`.
 *
 * The schema's `action` column is free text (intentional — see the
 * schema-side rationale), but every code path that writes the table
 * MUST route through this module. That keeps the action vocabulary
 * closed at the TypeScript layer (typo prevention, IDE rename
 * support) and gives us one place to enforce per-action invariants
 * on `context_json` shape as those land.
 *
 * **The contract:**
 *   - The application NEVER inserts into `admin_audit_log` directly.
 *     A grep for `insert(adminAuditLog)` outside this file should
 *     return zero results.
 *   - To add a new admin action verb, add it to `ADMIN_ACTIONS`
 *     below, define the per-action context shape, and call
 *     `recordAdminAction` from the new code path.
 *   - Tests assert that the action passed in matches the union; the
 *     `as const` narrows the type so the compiler catches typos
 *     (`'tombsone_subject'` would be a TypeScript error).
 *
 * **Why a TS union vs a Postgres ENUM:** a Postgres ENUM would
 * require a schema migration for every new admin verb. The TS union
 * gives us the same compile-time safety without the schema churn —
 * appropriate for a vocabulary that evolves as new admin surfaces
 * land.
 */

/**
 * The closed vocabulary of admin actions. Adding a new verb is a
 * one-line edit here + a new code path that calls
 * `recordAdminAction`. Removing a verb is a major change — old
 * audit log rows reference removed verbs.
 */
export const ADMIN_ACTIONS = [
  // Subject moderation
  'tombstone_subject',
  'untombstone_subject',
  // Attestation moderation
  'takedown_attestation',
  'restore_attestation',
  // Subject merges (admin folds duplicates into a canonical)
  'merge_subjects',
  // GDPR-shaped redactions
  'redact_did',
  'restore_did',
  // Operator-forced scorer runs
  'recompute_subject_score',
  // Service profile moderation (parallel to subject tombstone)
  'tombstone_service',
  'untombstone_service',
] as const

export type AdminAction = (typeof ADMIN_ACTIONS)[number]

/**
 * Insert an admin action into the audit log. Returns the BigInt
 * row id so the caller can wire downstream references (e.g.
 * `did_redactions.audit_log_id`).
 *
 * All fields are stamped with `performed_at = NOW()` server-side;
 * callers cannot pre-date entries (an admin can't back-fill the
 * audit log to look like a tombstone happened earlier than it did).
 */
export interface RecordAdminActionArgs {
  /** Operator DID. Required — anonymous admin actions are not logged. */
  actorDid: string
  /** Closed-vocabulary action verb. TypeScript narrows via the union. */
  action: AdminAction
  /**
   * Free-string id of the target. For subject actions this is a
   * subject_id; for attestation actions, the at:// URI; for DID
   * actions, the DID; for merges, the canonical subject_id.
   */
  targetId: string
  /**
   * Free-text reason. Required at the application layer for
   * moderation actions (operator discipline). The schema column is
   * nullable to permit emergency / scripted actions that genuinely
   * have no human-authored reason.
   */
  reason?: string
  /**
   * Action-specific structured context. Stored as JSONB. Future
   * work can add per-action Zod validation here (e.g.
   * `merge_subjects` always carries `{from_id, to_id}`).
   */
  context?: Record<string, unknown>
}

/**
 * Drizzle transaction handle. Aliased so callers don't have to import
 * `Parameters<DrizzleDB['transaction']>[0]` arguments[0] inline; matches
 * the surface area Drizzle's tx callback exposes (same `.insert` /
 * `.update` / `.select` shape as `DrizzleDB` itself).
 */
type DbExecutor = DrizzleDB | Parameters<Parameters<DrizzleDB['transaction']>[0]>[0]

export async function recordAdminAction(
  db: DbExecutor,
  args: RecordAdminActionArgs,
): Promise<bigint> {
  const [row] = await db
    .insert(adminAuditLog)
    .values({
      actorDid: args.actorDid,
      action: args.action,
      targetId: args.targetId,
      reason: args.reason ?? null,
      contextJson: args.context ?? null,
    })
    .returning({ id: adminAuditLog.id })
  return row.id
}

/**
 * Read-side accessor for the audit log.
 *
 * Lives in this module (not the CLI) so the wrapper file is the
 * single chokepoint for ALL `admin_audit_log` access — writes via
 * `recordAdminAction`, reads via `queryAuditLog`. The chokepoint
 * test only enforces the write side today, but routing reads here
 * too keeps the surface symmetrical and gives us one place to add
 * future ACL / redaction logic.
 *
 * Filters are independently optional; combined with AND when more
 * than one is supplied. `limit` capped at 1000 (operator forensics
 * use case — no client-facing pagination needed yet).
 */
export interface AuditLogEntry {
  id: bigint
  performedAt: Date
  actorDid: string
  action: string
  targetId: string
  reason: string | null
  contextJson: unknown
}

export interface AuditLogQuery {
  actor?: string
  target?: string
  action?: AdminAction
  limit?: number
}

const AUDIT_LOG_DEFAULT_LIMIT = 50
const AUDIT_LOG_MAX_LIMIT = 1000

export async function queryAuditLog(
  db: DbExecutor,
  query: AuditLogQuery,
): Promise<AuditLogEntry[]> {
  const limit = query.limit ?? AUDIT_LOG_DEFAULT_LIMIT
  if (!Number.isInteger(limit) || limit <= 0 || limit > AUDIT_LOG_MAX_LIMIT) {
    throw new Error(
      `audit-log limit must be a positive integer <= ${AUDIT_LOG_MAX_LIMIT}, got ${limit}`,
    )
  }

  const filters: SQL[] = []
  if (query.actor !== undefined) filters.push(eq(adminAuditLog.actorDid, query.actor))
  if (query.target !== undefined) filters.push(eq(adminAuditLog.targetId, query.target))
  if (query.action !== undefined) filters.push(eq(adminAuditLog.action, query.action))

  return db
    .select({
      id: adminAuditLog.id,
      performedAt: adminAuditLog.performedAt,
      actorDid: adminAuditLog.actorDid,
      action: adminAuditLog.action,
      targetId: adminAuditLog.targetId,
      reason: adminAuditLog.reason,
      contextJson: adminAuditLog.contextJson,
    })
    .from(adminAuditLog)
    .where(filters.length === 0 ? undefined : and(...filters))
    // `id DESC` as a tiebreaker after `performed_at DESC`. NOW() can
    // collide across rows written in the same millisecond (e.g. a
    // scripted batch), and `performed_at` alone leaves their relative
    // order undefined — non-deterministic forensic output. `id` is a
    // monotonic BIGSERIAL, so it gives a stable, insertion-order
    // tiebreak.
    .orderBy(desc(adminAuditLog.performedAt), desc(adminAuditLog.id))
    .limit(limit)
}
