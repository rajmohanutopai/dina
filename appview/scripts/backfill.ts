import { createDb } from '@/db/connection.js'
import { validateRecord } from '@/ingester/record-validator.js'
import { routeHandler } from '@/ingester/handlers/index.js'
import { isRateLimited } from '@/ingester/rate-limiter.js'
import { logger } from '@/shared/utils/logger.js'
import { metrics } from '@/shared/utils/metrics.js'
import { TRUST_COLLECTIONS } from '@/config/lexicons.js'
import 'dotenv/config'

interface BackfillConfig {
  pdsUrls: string[]
  filterDids?: string[]
  maxConcurrentPds: number
}

class Semaphore {
  private queue: (() => void)[] = []
  private active = 0
  constructor(private max: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++
      return
    }
    await new Promise<void>((resolve) => this.queue.push(resolve))
    this.active++
  }

  release(): void {
    this.active--
    const next = this.queue.shift()
    if (next) next()
  }
}

async function backfill(config: BackfillConfig): Promise<void> {
  const db = createDb()
  const ctx = { db, logger, metrics }

  logger.info({ pdsCount: config.pdsUrls.length }, 'Starting backfill')

  const semaphore = new Semaphore(config.maxConcurrentPds)

  await Promise.all(config.pdsUrls.map(async (pdsUrl) => {
    await semaphore.acquire()
    try {
      await backfillFromPds(pdsUrl, ctx, config.filterDids)
    } catch (err) {
      logger.error({ pdsUrl, err }, 'Failed to backfill PDS')
    } finally {
      semaphore.release()
    }
  }))

  logger.info('Backfill complete')
}

async function backfillFromPds(
  pdsUrl: string,
  ctx: { db: ReturnType<typeof createDb>; logger: typeof logger; metrics: typeof metrics },
  filterDids?: string[],
): Promise<void> {
  const repos = await listRepos(pdsUrl, filterDids)

  for (const repo of repos) {
    const did = repo.did

    for (const collection of TRUST_COLLECTIONS) {
      let cursor: string | undefined

      do {
        const url = `${pdsUrl}/xrpc/com.atproto.repo.listRecords?` +
          `repo=${did}&collection=${collection}&limit=100` +
          (cursor ? `&cursor=${cursor}` : '')

        const response = await fetch(url)

        if (!response.ok) {
          logger.warn({ pdsUrl, did, collection, status: response.status }, 'listRecords failed')
          break
        }

        const data = await response.json() as { records?: any[]; cursor?: string }
        const records = data.records ?? []

        for (const item of records) {
          const uri = item.uri as string
          const cid = item.cid as string
          const record = item.value as Record<string, unknown>

          if (isRateLimited(did)) {
            logger.warn({ did }, 'Backfill: DID rate limited, skipping remaining records')
            break
          }

          const validation = validateRecord(collection, record)
          if (!validation.success) continue

          const handler = routeHandler(collection)
          if (!handler) continue

          const rkey = uri.split('/').pop()!
          await handler.handleCreate(ctx, {
            uri,
            did,
            collection,
            rkey,
            cid,
            record: validation.data,
          })
        }

        cursor = data.cursor
      } while (cursor)
    }

    logger.info({ did, pdsUrl }, 'Backfilled DID')
  }
}

async function listRepos(
  pdsUrl: string,
  filterDids?: string[],
): Promise<{ did: string }[]> {
  if (filterDids?.length) {
    return filterDids.map(did => ({ did }))
  }

  const repos: { did: string }[] = []
  let cursor: string | undefined

  do {
    const response = await fetch(
      `${pdsUrl}/xrpc/com.atproto.sync.listRepos?limit=1000` +
      (cursor ? `&cursor=${cursor}` : ''),
    )
    if (!response.ok) break

    const data = await response.json() as { repos?: { did: string }[]; cursor?: string }
    repos.push(...(data.repos ?? []))
    cursor = data.cursor
  } while (cursor)

  return repos
}

// ── CLI ──

const args = process.argv.slice(2)
const pdsUrls = args.filter(a => a.startsWith('--pds-urls='))
  .map(a => a.replace('--pds-urls=', '').split(','))
  .flat()
  .filter(Boolean)

if (pdsUrls.length === 0) {
  console.error('Usage: npx tsx scripts/backfill.ts --pds-urls=https://pds1.example.com,https://pds2.example.com')
  process.exit(1)
}

backfill({
  pdsUrls,
  maxConcurrentPds: 5,
}).catch((err) => {
  logger.error({ err }, 'Backfill failed')
  process.exit(1)
})
