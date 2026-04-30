/**
 * FTS column + index DDL — centralised idempotent helper (TN-DB-009).
 *
 * Postgres `tsvector GENERATED ALWAYS AS (to_tsvector(...)) STORED`
 * columns and their accompanying GIN indexes are NOT expressed in the
 * Drizzle schema declarations — Drizzle's column builders cannot emit
 * a `GENERATED ALWAYS AS (<expression>) STORED` clause. Before this
 * helper, the DDL was duplicated as inline `db.execute(sql\`...\`)`
 * blocks in both `web/server.ts` and `ingester/main.ts`. Two copies
 * of the same idempotent ALTER drift on every change — the ingester
 * ran ahead while the web server lagged, or one path got an updated
 * generation expression and the other didn't. Single helper, two
 * call-sites, one source of truth.
 *
 * Columns managed here:
 *
 *   1. `attestations.search_vector` — generated from `search_content`
 *      (the ingester writes `search_content` from the record's
 *      headline / body / tags / subject.name / category / domain).
 *      The search xRPC's FTS branch (`sort=relevant` + `q`) uses this
 *      column; without it, the planner falls back to a sequential scan
 *      and the 200ms statement_timeout fires.
 *
 *   2. `subjects.search_tsv` — generated from `name` (the only
 *      always-present text column on `subjects`). When subjects-side
 *      search lands, this is what `to_tsvector` queries against.
 *      Landing the column now lets the search xRPC extension be a
 *      pure handler change rather than a schema migration.
 *
 * Both columns are NULL-safe via `coalesce(<source>, '')` — Postgres
 * generated columns evaluate the expression on every row, and a NULL
 * source would otherwise produce a NULL tsvector that the GIN index
 * wouldn't catch in a `@@` predicate.
 *
 * **Idempotency**: every statement is `IF NOT EXISTS`. Calling
 * `ensureFtsColumns(db)` on every startup is the contract; running
 * twice is a no-op, running on a fresh DB creates the columns + index,
 * running on a partial DB (e.g., column exists but index doesn't)
 * fills in the missing piece. Cheap to run unconditionally — Postgres
 * resolves the catalog lookup in microseconds when the column already
 * exists.
 *
 * **Why STORED, not VIRTUAL**: STORED writes the tsvector to disk on
 * every UPDATE; VIRTUAL recomputes on every read. The search xRPC's
 * GIN index requires STORED — VIRTUAL columns can't be indexed. The
 * write-amplification cost (one tsvector per row mutation) is paid
 * once per ingest, while the read benefit (sub-millisecond GIN
 * lookups vs sequential `to_tsvector(searchContent)` evaluation per
 * row) compounds on every search.
 *
 * **English vs simple dictionary**: hard-coded `'english'`. Multi-
 * lingual content is rare at V1 (the language column is mostly empty)
 * and a single-language tsvector is correct for the V1 cohort. V2 can
 * add a per-row `language`-driven dictionary via a CASE expression in
 * the GENERATED clause; that's a non-breaking schema change.
 */

import { sql, type SQL } from 'drizzle-orm'

/**
 * Minimal `db.execute(sql\`...\`)` shape — the helper takes any
 * Drizzle DB-like object. Keeps the helper testable with a captured-
 * statement stub without dragging in the full Drizzle DB type.
 */
export interface FtsCapableDb {
  execute(query: SQL): Promise<unknown>
}

/**
 * Ordered DDL statement list. Exported as a constant so tests can
 * pin the exact emitted SQL and so any future reorder (e.g., column
 * before index — Postgres rejects creating an index on a column that
 * doesn't exist yet) is a deliberate code change rather than a
 * documentation drift.
 *
 * The pairing is rigid: each `ALTER TABLE ... ADD COLUMN` is
 * immediately followed by its `CREATE INDEX` so a `CREATE` against a
 * not-yet-created column never fires.
 */
export const FTS_DDL_STATEMENTS: readonly string[] = Object.freeze([
  // attestations.search_vector — generated from search_content.
  `ALTER TABLE attestations ADD COLUMN IF NOT EXISTS search_vector tsvector
     GENERATED ALWAYS AS (to_tsvector('english', coalesce(search_content, ''))) STORED`,
  `CREATE INDEX IF NOT EXISTS idx_attestations_search
     ON attestations USING GIN (search_vector)`,
  // subjects.search_tsv — generated from name.
  `ALTER TABLE subjects ADD COLUMN IF NOT EXISTS search_tsv tsvector
     GENERATED ALWAYS AS (to_tsvector('english', coalesce(name, ''))) STORED`,
  `CREATE INDEX IF NOT EXISTS idx_subjects_search
     ON subjects USING GIN (search_tsv)`,
])

/**
 * Run the idempotent FTS DDL against a Drizzle-compatible DB.
 *
 * `42P01` (undefined_table) on a single statement is treated as a
 * cold-boot signal — that statement's table hasn't been created yet
 * (the web server raced ahead of the ingester's baseline schema
 * push). The helper SKIPS that statement and continues with the rest:
 * if `attestations` is missing but `subjects` exists, the subjects
 * FTS surface still lands. The next call (after the ingester
 * finishes) picks up the skipped statements via `IF NOT EXISTS`. Any
 * other error (syntax, permissions) propagates so misconfiguration
 * surfaces immediately.
 */
export async function ensureFtsColumns(db: FtsCapableDb): Promise<void> {
  for (const stmt of FTS_DDL_STATEMENTS) {
    try {
      await db.execute(sql.raw(stmt))
    } catch (err) {
      const code = (err as { code?: string })?.code
      if (code === '42P01') {
        // Cold-boot path for THIS statement's table — skip and
        // continue. Caller will retry on next startup; missing
        // statements re-run via `IF NOT EXISTS`.
        continue
      }
      throw err
    }
  }
}
