import { createDb } from '@/db/connection.js'
import { ensureFtsColumns } from '@/db/fts_columns.js'
import { JetstreamConsumer } from './jetstream-consumer.js'
import { A2ADirectory } from './a2a-directory.js'
import { env } from '@/config/env.js'
import { createPlcDidResolver } from '@/shared/a2a/did-resolver.js'
import { metrics } from '@/shared/utils/metrics.js'
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

  // A2A directory (Lane 3, design §8.3): records every card event, and
  // processes them while `a2a_directory_enabled` is on (it is off until an
  // operator turns it on). Publishers' DID documents come from the PLC
  // directory, over HTTPS (plain HTTP only outside production).
  const a2aDirectory = new A2ADirectory({
    db,
    resolveDid: createPlcDidResolver({
      plcUrl: env.A2A_PLC_URL,
      allowInsecure: env.NODE_ENV !== 'production',
    }),
    rejection: { logger, metrics },
    log: logger,
    retentionUs: env.A2A_JETSTREAM_RETENTION_HOURS * 3_600_000_000,
  })
  consumer.setA2ADirectory(a2aDirectory)

  logger.info('Starting Ingester daemon')
  await consumer.start()
  a2aDirectory.start()
}

main().catch((err) => {
  logger.error({ err }, 'Ingester failed to start')
  process.exit(1)
})
