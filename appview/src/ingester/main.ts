import { createDb } from '@/db/connection.js'
import { JetstreamConsumer } from './jetstream-consumer.js'
import { logger } from '@/shared/utils/logger.js'
import 'dotenv/config'

async function main() {
  const db = createDb()

  // Ensure FTS search_vector column + GIN index exist.
  // This is idempotent (IF NOT EXISTS) and runs on every startup.
  // Drizzle push creates the table but cannot express GENERATED ALWAYS AS.
  await db.execute(/*sql*/`
    ALTER TABLE attestations ADD COLUMN IF NOT EXISTS search_vector tsvector
      GENERATED ALWAYS AS (to_tsvector('english', coalesce(search_content, ''))) STORED
  `)
  await db.execute(/*sql*/`
    CREATE INDEX IF NOT EXISTS idx_attestations_search
      ON attestations USING GIN (search_vector)
  `)

  const consumer = new JetstreamConsumer(db)

  logger.info('Starting Ingester daemon')
  await consumer.start()
}

main().catch((err) => {
  logger.error({ err }, 'Ingester failed to start')
  process.exit(1)
})
