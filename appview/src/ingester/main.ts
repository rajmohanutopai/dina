import { createDb } from '@/db/connection.js'
import { JetstreamConsumer } from './jetstream-consumer.js'
import { logger } from '@/shared/utils/logger.js'
import 'dotenv/config'

async function main() {
  const db = createDb()
  const consumer = new JetstreamConsumer(db)

  logger.info('Starting Ingester daemon')
  await consumer.start()
}

main().catch((err) => {
  logger.error({ err }, 'Ingester failed to start')
  process.exit(1)
})
