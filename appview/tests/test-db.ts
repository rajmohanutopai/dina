/**
 * Shared test database helper.
 *
 * Provides a real Drizzle DB connection to the test Postgres instance
 * and utility functions for cleaning tables between tests.
 */
import { drizzle } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import pg from 'pg'
import pino from 'pino'
const { Pool } = pg

// A real pino logger at `silent` level — satisfies the `Logger` type
// that HandlerContext requires (it IS a pino Logger), with zero output
// in tests. Using this instead of a `{info,warn,...}` duck-stub keeps
// `createTestHandlerContext`'s result assignable to HandlerContext
// without a cast. Created once; pino loggers are safe to share.
const TEST_SILENT_LOGGER = pino({ level: 'silent' })

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://dina:dina@localhost:5432/dina_trust'

let pool: pg.Pool | null = null

export function getTestDb() {
  if (!pool) {
    pool = new Pool({
      connectionString: DATABASE_URL,
      min: 1,
      max: 5,
    })
  }
  return drizzle(pool)
}

export type TestDB = ReturnType<typeof getTestDb>

/**
 * Truncate every table in the test database, between tests.
 *
 * ASKS POSTGRES WHAT EXISTS rather than naming tables here. The hand-written
 * list this replaces had drifted: it truncated `trust_policies`, a table the
 * schema dropped, so `TRUNCATE` raised `relation does not exist` and EVERY
 * integration suite that resets state failed in `beforeEach` — 260 tests
 * red for one stale name, and none of them for a reason in the code under
 * test.
 *
 * A list of tables maintained beside the schema is a second source of truth
 * for what the schema contains, and the two only ever diverge in one
 * direction: the schema moves and the list does not. Reading
 * `information_schema` cannot drift, and a table added tomorrow is cleaned
 * without anyone remembering to add it.
 *
 * Drizzle's own bookkeeping table is excluded — truncating the migration
 * journal would make the next run believe nothing had been applied.
 */
export async function cleanAllTables(db: TestDB) {
  const rows = await db.execute(sql`
    SELECT tablename FROM pg_tables
     WHERE schemaname = 'public'
       AND tablename NOT LIKE '__drizzle%'
  `)
  const names = (rows.rows as { tablename: string }[]).map((r) => `"${r.tablename}"`)
  if (names.length === 0) return
  // ONE statement, CASCADE. Truncating table by table would fail on foreign
  // keys in whatever order the catalog happened to return them.
  await db.execute(sql.raw(`TRUNCATE TABLE ${names.join(', ')} CASCADE`))
}

/**
 * Truncate specific tables.
 */
export async function cleanTables(db: TestDB, ...tableNames: string[]) {
  if (tableNames.length === 0) return
  const tables = tableNames.join(', ')
  await db.execute(sql.raw(`TRUNCATE TABLE ${tables} CASCADE`))
}

/**
 * Close the pool. Call in afterAll().
 */
export async function closeTestDb() {
  if (pool) {
    await pool.end()
    pool = null
  }
}

/**
 * Create a mock HandlerContext for use in handler tests.
 */
export function createTestHandlerContext(db: TestDB) {
  return {
    db,
    metrics: {
      incr: () => {},
      gauge: () => {},
      histogram: () => {},
      counter: () => {},
    },
    logger: TEST_SILENT_LOGGER,
  }
}
