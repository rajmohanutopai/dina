import { createDb } from '@/db/connection.js'
import { startScheduler } from './scheduler.js'
import { logger } from '@/shared/utils/logger.js'
import 'dotenv/config'

const db = createDb()
logger.info('Starting Scorer daemon')
startScheduler(db)
