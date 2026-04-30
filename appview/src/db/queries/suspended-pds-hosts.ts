import { desc, eq } from 'drizzle-orm'
import type { DrizzleDB } from '../connection'
import { suspendedPdsHosts } from '../schema/suspended-pds-hosts'

/**
 * Typed accessors for `suspended_pds_hosts` (TN-OPS-003 / Plan
 * §13.10 abuse response).
 *
 * Public surface:
 *   - `isPdsSuspended(db, host)` — hot path, called by the
 *     ingester gate on every event. Single PK lookup; targeted
 *     latency < 0.5ms.
 *   - `suspendPdsHost(db, host, reason, suspendedBy?)` — operator
 *     write, idempotent: re-suspending an already-suspended host
 *     replaces the prior row's reason + suspended_at + suspended_by
 *     so the most-recent operator action is what audit sees.
 *   - `unsuspendPdsHost(db, host)` — operator write, returns
 *     `{removed: true | false}` so the CLI can distinguish "I
 *     unsuspended a real entry" from "host wasn't in the list".
 *   - `listSuspendedPdsHosts(db)` — paginated read for the CLI's
 *     `list` command + future ops dashboards. Ordered by
 *     `suspended_at DESC` so the most-recent suspensions surface
 *     first.
 *
 * **Why no application-level default**: this table has no concept
 * of a "default" — a host is either suspended or not. Sibling
 * `appview_config.readBoolFlag` falls through to `FLAG_DEFAULTS`
 * for missing rows; here, missing = not suspended = the boolean
 * `false`. No default table needed.
 *
 * **Hot-path caching policy**: the ingester gate calls
 * `isPdsSuspended` once per event. Postgres' query plan cache + the
 * PK index (~0.1ms lookup) keep this cheap; we deliberately do NOT
 * add an in-process cache because:
 *   - `dina-admin trust suspend-pds <host>` MUST take effect
 *     immediately. A 60s in-process cache would let abuse
 *     records keep landing for up to a minute after the operator
 *     acted — wrong direction for an abuse-response tool.
 *   - The lookup is fast enough that caching wouldn't measurably
 *     reduce ingester throughput.
 *
 * Same posture as `appview_config.readBoolFlag` — see its docstring
 * for the broader rationale.
 */

/**
 * Hot-path predicate. Returns `true` iff a row exists for the host.
 * Case-sensitive; the caller (ingester gate) is responsible for
 * normalising the host before lookup (the AT Protocol DID spec
 * specifies lowercase web-host normalisation for `did:web:`; PLC
 * directory entries surface PDS host strings already in canonical
 * form).
 */
export async function isPdsSuspended(db: DrizzleDB, host: string): Promise<boolean> {
  const rows = await db
    .select({ host: suspendedPdsHosts.host })
    .from(suspendedPdsHosts)
    .where(eq(suspendedPdsHosts.host, host))
    .limit(1)
  return rows.length > 0
}

/**
 * Operator write — UPSERTs the suspension row. The behaviour on
 * "host already suspended" is **replace, not no-op**: the reason +
 * suspended_at + suspended_by are overwritten with the new operator
 * action. Re-suspending with a different reason captures "the
 * earlier suspension was for X, but now we know it's also Y" — the
 * audit trail is "the most-recent operator action wins". An
 * operator who wants the FULL history (multi-suspension lineage)
 * keeps it in their ticket system; this table is the live
 * suspension list, not a journal.
 *
 * `suspendedBy` is optional because legacy / SQL-path inserts
 * pre-dating the CLI may not have an operator identity to record;
 * the CLI populates this from `process.env.USER` (or a CLI
 * `--by <id>` arg).
 */
export async function suspendPdsHost(
  db: DrizzleDB,
  host: string,
  reason: string,
  suspendedBy?: string,
): Promise<void> {
  // Single timestamp shared across INSERT + UPDATE branches.
  const now = new Date()
  await db
    .insert(suspendedPdsHosts)
    .values({
      host,
      reason,
      suspendedAt: now,
      suspendedBy: suspendedBy ?? null,
    })
    .onConflictDoUpdate({
      target: suspendedPdsHosts.host,
      set: {
        reason,
        suspendedAt: now,
        suspendedBy: suspendedBy ?? null,
      },
    })
}

/**
 * Operator write — DELETE the suspension row. Returns
 * `{removed: true}` when a row was deleted, `{removed: false}` when
 * no row existed (the CLI uses this to print a different message
 * for "I undid a real suspension" vs "host wasn't in the list,
 * no-op").
 *
 * Uses `.returning()` for portable row-count semantics — `db.delete`
 * doesn't return the affected count uniformly across drivers, but
 * `.returning({...}).then(rows => rows.length)` does (same pattern
 * as TN-SCORE-006 cosig-expiry-sweep).
 */
export async function unsuspendPdsHost(
  db: DrizzleDB,
  host: string,
): Promise<{ removed: boolean }> {
  const removed = await db
    .delete(suspendedPdsHosts)
    .where(eq(suspendedPdsHosts.host, host))
    .returning({ host: suspendedPdsHosts.host })
  return { removed: removed.length > 0 }
}

/**
 * Operator read — full list, ordered by `suspended_at DESC` so the
 * most-recent suspensions surface first. No pagination in V1: the
 * suspension list is intended to be small (operator-curated, not
 * algorithmic). If it grows past a few hundred entries, that's a
 * V2 conversation about adding pagination + a different abuse-
 * response strategy (the manual-suspend posture doesn't scale
 * past curator bandwidth).
 */
export async function listSuspendedPdsHosts(
  db: DrizzleDB,
): Promise<
  Array<{ host: string; reason: string; suspendedAt: Date; suspendedBy: string | null }>
> {
  return db
    .select({
      host: suspendedPdsHosts.host,
      reason: suspendedPdsHosts.reason,
      suspendedAt: suspendedPdsHosts.suspendedAt,
      suspendedBy: suspendedPdsHosts.suspendedBy,
    })
    .from(suspendedPdsHosts)
    .orderBy(desc(suspendedPdsHosts.suspendedAt))
}
