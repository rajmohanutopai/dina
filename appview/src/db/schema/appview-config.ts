import { pgTable, text, timestamp, boolean } from 'drizzle-orm/pg-core'

/**
 * `appview_config` (TN-FLAG-001 / Plan §13.6 + §13.10).
 *
 * Operator-controlled feature flags. One row per flag, identified by
 * `key`. Hot-reloadable: the ingester / scorer / xRPC layer all read
 * the freshest row at the start of each cycle (or per-request, for the
 * xRPC kill-switch).
 *
 * **Why a key-value table** rather than typed boolean columns:
 *   - V1 flags can grow over time (`trust_v1_enabled`, `cosig_enabled`,
 *     a future `pseudonymous_namespaces_enabled`, etc.) — adding a
 *     boolean column per flag would churn the schema for every flip.
 *   - Operators introspect with plain `SELECT * FROM appview_config`.
 *   - Sibling pattern to `trust_v1_params` (TN-DB-004), which also uses
 *     a key-value model.
 *
 * **Schema rationale** — separate `bool_value` and `text_value` columns
 * rather than a single string blob:
 *   - All current flags are boolean. Typed column makes that explicit.
 *   - Future config that needs a non-bool value (a string allowlist,
 *     an integer limit) gets its own typed column added — call sites
 *     read the column they expect. No coercion-at-runtime brittleness.
 *   - Both columns nullable so each row populates only the type it
 *     uses; the application layer's accessor knows which column to
 *     read by key.
 *
 * **Default flag values are application-level** — the absence of a row
 * means "use the application default". Per-flag defaults live in
 * `db/queries/appview-config.ts:FLAG_DEFAULTS`; the reader
 * `readBoolFlag(db, key)` falls through to that table when the row is
 * missing or has a NULL `bool_value`.
 *
 * **`updated_at` defaults to NOW()** so the polling layer can compare
 * `max(updated_at)` against its last-loaded snapshot to detect change.
 * Plain TIMESTAMP — codebase convention; same reasoning as
 * `trust_v1_params.updated_at` (TN-DB-004).
 *
 * **Migration / seeding**: the consolidated TN-DB-010 migration seeds
 * one row per `FLAG_DEFAULTS` entry (with the matching default value)
 * so fresh deployments don't depend on row-absence semantics. Operator
 * flips with `dina-admin trust enable|disable` (TN-FLAG-002), which
 * UPDATEs the row.
 */
export const appviewConfig = pgTable('appview_config', {
  key: text('key').primaryKey(),
  boolValue: boolean('bool_value'),
  textValue: text('text_value'),
  description: text('description').notNull(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})
