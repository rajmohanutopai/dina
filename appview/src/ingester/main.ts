import { createDb } from '@/db/connection.js'
import { ensureFtsColumns } from '@/db/fts_columns.js'
import { JetstreamConsumer } from './jetstream-consumer.js'
import { logger } from '@/shared/utils/logger.js'
import 'dotenv/config'

async function main() {
  const db = createDb()

  // Ensure FTS columns exist (idempotent — TN-DB-009). Drizzle push
  // creates the tables but cannot express GENERATED ALWAYS AS, so
  // the tsvector columns + GIN indexes land via this helper. Single
  // source of truth shared with the web-server startup path.
  await ensureFtsColumns(db)

  const consumer = new JetstreamConsumer(db)

  logger.info('Starting Ingester daemon')
  await consumer.start()
}

main().catch((err) => {
  logger.error({ err }, 'Ingester failed to start')
  process.exit(1)
})
