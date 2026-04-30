import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * `suspended_pds_hosts` (TN-OPS-003 / Plan §13.10 abuse response).
 *
 * Operator-managed allowlist-by-exclusion: every host in this table
 * is excluded from ingestion. Future records published from a
 * suspended host get dropped at the ingester gate with
 * `reason='pds_suspended'`. Existing records the cluster already
 * published are NOT retroactively unindexed — they're public on the
 * firehose; the AppView is choosing not to index FURTHER from this
 * source. Manual cleanup of historical rows is a separate operator
 * task (Plan §13 line 612).
 *
 * **Why a dedicated table** rather than encoding into
 * `appview_config`'s `text_value` column:
 *   - Per-host metadata (suspension reason, who suspended, when) is
 *     structured. Stuffing JSON into a single `text_value` makes
 *     audit grep painful.
 *   - The hot path (ingester checking suspension on every event) is
 *     a PK lookup against a small table — sub-ms even for 10k
 *     suspended hosts.
 *   - `appview_config` semantics are "operator flag with default
 *     fallback". Suspension has no concept of a default — a host is
 *     either listed or not.
 *
 * **Schema rationale**:
 *   - `host TEXT PRIMARY KEY` — case-sensitive exact match. The
 *     ingester resolves the PDS host from the DID's plc/web doc
 *     before consulting this table; that resolution returns
 *     normalised lowercase per the AT Protocol DID spec.
 *   - `reason TEXT NOT NULL` — operator-provided free-form. Required
 *     so the audit trail captures *why* (sybil cluster, abuse,
 *     legal request, etc.) rather than relying on operator memory.
 *   - `suspended_at TIMESTAMP NOT NULL DEFAULT NOW()` — when the
 *     suspension landed; not user-overridable from the CLI to
 *     prevent backdating.
 *   - `suspended_by TEXT` (nullable) — operator identifier (DID,
 *     username, ticket id). Nullable so SQL-path inserts that
 *     pre-date the CLI don't fail; the CLI populates this when
 *     invoked.
 *
 * **No `unsuspended_at` / soft-delete** — unsuspension is a DELETE.
 * Re-suspending a host inserts a fresh row with a new reason. The
 * audit trail for "this host was suspended, then unsuspended, then
 * re-suspended" lives in operator-level logs / ticket systems, not
 * in this table. Keeping the table active-only keeps the hot-path
 * lookup as a single PK probe with no `WHERE unsuspended_at IS NULL`
 * filter to forget.
 */
export const suspendedPdsHosts = pgTable('suspended_pds_hosts', {
  host: text('host').primaryKey(),
  reason: text('reason').notNull(),
  suspendedAt: timestamp('suspended_at').notNull().defaultNow(),
  suspendedBy: text('suspended_by'),
})
