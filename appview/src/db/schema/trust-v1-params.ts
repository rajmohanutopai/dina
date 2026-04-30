import { pgTable, text, timestamp, numeric } from 'drizzle-orm/pg-core'

/**
 * `trust_v1_params` (TN-DB-004 / Plan §4.1).
 *
 * Hot-reloadable scoring parameters. The scorer reads this table on
 * each run (every 60s when polling is enabled — see TN-SCORE-009) and
 * uses the freshest values. Tuning the trust formula no longer
 * requires a redeploy: a `dina-admin trust set-param WEIGHT_VOLUME 0.30`
 * UPDATE propagates within the next scorer tick.
 *
 * **Why a key-value table** rather than typed columns:
 *   - V1 has ~10 numeric parameters; v2 may add more without churning
 *     the schema.
 *   - Operators can introspect with plain `SELECT * FROM
 *     trust_v1_params` instead of memorising column names.
 *   - The `description` column is the operator-facing docstring
 *     (admin CLI prints it on `dina-admin trust list-params`).
 *
 * **Why NUMERIC** rather than `real`/`double precision`:
 *   - Exact decimal — no float drift accumulating across reloads.
 *   - Postgres NUMERIC unbounded precision; the scorer truncates to
 *     however many digits it needs at read time.
 *
 * **FTS_WEIGHT_NAME / FTS_WEIGHT_HEADLINE / FTS_WEIGHT_BODY** appear in
 * the Plan §4.1 seed-row list as letter labels (`'A'`/`'B'`/`'C'`) —
 * those are Postgres `setweight()` rank labels, NOT numeric values.
 * They don't fit a NUMERIC column. They're left out of this table on
 * purpose; FTS weights are a tsvector-trigger concern that lives with
 * TN-DB-009 (FTS columns + populate triggers), not the scorer-loop
 * parameter store. If we ever need them as numeric multipliers
 * (`A=1.0, B=0.4, C=0.2, D=0.1`), they can land here later.
 *
 * **Updated at** defaults to NOW() so the scorer's hot-reload check
 * (compare `max(updated_at)` against last-loaded snapshot) is cheap.
 * Plain TIMESTAMP — codebase convention; Plan §4.1 calls for
 * TIMESTAMPTZ but every other AppView timestamp is plain TIMESTAMP.
 */
export const trustV1Params = pgTable('trust_v1_params', {
  key: text('key').primaryKey(),
  value: numeric('value').notNull(),
  description: text('description').notNull(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})
