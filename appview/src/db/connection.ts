import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
const { Pool } = pg

export function createDb(url?: string) {
  const pool = new Pool({
    connectionString: url ?? process.env.DATABASE_URL ?? 'postgresql://dina:dina@localhost:5432/dina_reputation',
    min: Number(process.env.DATABASE_POOL_MIN ?? 2),
    max: Number(process.env.DATABASE_POOL_MAX ?? 20),
  })
  return drizzle(pool)
}

export type DrizzleDB = ReturnType<typeof createDb>
export const db = createDb()
