/**
 * Shared test database helper.
 *
 * Provides a real Drizzle DB connection to the test Postgres instance
 * and utility functions for cleaning tables between tests.
 */
import { drizzle } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import pg from 'pg'
const { Pool } = pg

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://dina:dina@localhost:5432/dina_reputation'

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
 * Truncate all tables to reset state between tests.
 * Uses TRUNCATE ... CASCADE for efficiency.
 */
export async function cleanAllTables(db: TestDB) {
  await db.execute(sql`
    TRUNCATE TABLE
      attestations,
      vouches,
      endorsements,
      flags,
      replies,
      reactions,
      report_records,
      revocations,
      delegations,
      collections,
      media,
      amendments,
      verifications,
      review_requests,
      comparisons,
      subject_claims,
      trust_policies,
      notification_prefs,
      mention_edges,
      trust_edges,
      tombstones,
      anomaly_events,
      ingester_cursor,
      did_profiles,
      subject_scores,
      domain_scores,
      subjects
    CASCADE
  `)
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
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
  }
}
