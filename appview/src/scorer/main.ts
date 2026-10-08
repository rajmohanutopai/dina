import { createDb } from '@/db/connection.js'
import { startScheduler } from './scheduler.js'
import { installReconcileDeps } from './jobs/service-reconcile.js'
import { createReconcileDeps } from './jobs/service-reconcile-deps.js'
import { createPlcDidResolver } from '@/shared/a2a/did-resolver.js'
import { env } from '@/config/env.js'
import { logger } from '@/shared/utils/logger.js'
import 'dotenv/config'

const db = createDb()
// Live listings (docs/REAL_LIFE_FIXES.md §14): reconciliation reads
// publishers' repositories, resolved from the PLC directory over HTTPS.
installReconcileDeps(
  createReconcileDeps({
    resolveDid: createPlcDidResolver({ plcUrl: env.A2A_PLC_URL, allowInsecure: env.NODE_ENV !== 'production' }),
  }),
)
logger.info('Starting Scorer daemon')
startScheduler(db)
