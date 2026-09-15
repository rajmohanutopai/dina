import { createDb } from '@/db/connection.js'
import { ensureFtsColumns } from '@/db/fts_columns.js'
import { JetstreamConsumer } from './jetstream-consumer.js'
import { registeredReviewFeeds, setReviewFeedRegistry } from '@/config/review-feeds.js'
import { logger } from '@/shared/utils/logger.js'
import 'dotenv/config'

async function main() {
  const db = createDb()

  // Ensure FTS columns exist (idempotent — TN-DB-009). Drizzle push
  // creates the tables but cannot express GENERATED ALWAYS AS, so
  // the tsvector columns + GIN indexes land via this helper. Single
  // source of truth shared with the web-server startup path.
  await ensureFtsColumns(db)

  // D4 — the per-market review feeds this node admits (§5.D). The list is
  // EMPTY, and saying so out loud at boot is the point: a feed belongs here
  // once someone has read its terms and decided Dina may show its reviews
  // with attribution, which is a decision about a contract rather than a
  // line of code. An operator adds one by editing this call — a change that
  // goes through review like any other, which is the right ceremony for a
  // legal agreement. Until then every record claiming to be an import is
  // refused at the gate, which is correct for a node that has agreed to
  // nothing. See `config/review-feeds.ts` for why an import may move a
  // rating and may never move a trust ring.
  setReviewFeedRegistry([])
  logger.info({ feeds: registeredReviewFeeds().length }, 'Review feeds registered')

  const consumer = new JetstreamConsumer(db)

  logger.info('Starting Ingester daemon')
  await consumer.start()
}

main().catch((err) => {
  logger.error({ err }, 'Ingester failed to start')
  process.exit(1)
})
