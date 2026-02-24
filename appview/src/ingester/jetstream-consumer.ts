import WebSocket from 'ws'
import { eq } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection.js'
import type {
  JetstreamEvent,
  JetstreamCommitCreate,
  JetstreamCommitDelete,
  JetstreamIdentityEvent,
  JetstreamAccountEvent,
} from '@/shared/types/jetstream-types.js'
import { routeHandler } from './handlers/index.js'
import { validateRecord } from './record-validator.js'
import { BoundedIngestionQueue } from './bounded-queue.js'
import { isRateLimited } from './rate-limiter.js'
import { env } from '@/config/env.js'
import { REPUTATION_COLLECTIONS } from '@/config/lexicons.js'
import { ingesterCursor } from '@/db/schema/index.js'
import { logger } from '@/shared/utils/logger.js'
import { metrics } from '@/shared/utils/metrics.js'

export class JetstreamConsumer {
  private ws: WebSocket | null = null
  private cursor: number = 0
  private reconnectAttempts = 0
  private readonly MAX_RECONNECT_DELAY_MS = 60_000
  private isShuttingDown = false
  private eventsSinceCursorSave = 0
  private readonly CURSOR_SAVE_INTERVAL = 100
  private queue: BoundedIngestionQueue | null = null
  private highestSeenTimeUs: number = 0

  constructor(private db: DrizzleDB) {}

  async start(): Promise<void> {
    this.cursor = await this.loadCursor()
    logger.info({ cursor: this.cursor }, 'Starting Jetstream consumer')
    this.connect()
    this.setupGracefulShutdown()
  }

  private connect(): void {
    const params = new URLSearchParams()
    for (const collection of REPUTATION_COLLECTIONS) {
      params.append('wantedCollections', collection)
    }
    if (this.cursor > 0) {
      params.set('cursor', this.cursor.toString())
    }

    const url = `${env.JETSTREAM_URL}/subscribe?${params.toString()}`
    logger.info({ url: env.JETSTREAM_URL, collections: REPUTATION_COLLECTIONS.length }, 'Connecting to Jetstream')

    this.ws = new WebSocket(url)

    this.queue = new BoundedIngestionQueue(
      (item) => this.processEvent(item.data as JetstreamEvent),
      { maxSize: 1000, maxConcurrency: env.DATABASE_POOL_MAX },
    )
    this.queue.setWebSocket(this.ws)

    this.ws.on('open', () => {
      logger.info('Jetstream connection established')
      this.reconnectAttempts = 0
      metrics.gauge('ingester.connected', 1)
    })

    this.ws.on('message', (data: Buffer) => {
      try {
        const event: JetstreamEvent = JSON.parse(data.toString())
        if (event.time_us > this.highestSeenTimeUs) {
          this.highestSeenTimeUs = event.time_us
        }
        this.queue!.push({ data: event, timestampUs: event.time_us })
      } catch (err) {
        logger.error({ err }, 'Failed to parse Jetstream message')
        metrics.incr('ingester.errors.parse')
      }
    })

    this.ws.on('close', (code, reason) => {
      metrics.gauge('ingester.connected', 0)
      if (!this.isShuttingDown) {
        logger.warn({ code, reason: reason.toString() }, 'Jetstream connection closed')
        this.reconnectWithBackoff()
      }
    })

    this.ws.on('error', (err) => {
      logger.error({ err }, 'Jetstream WebSocket error')
      metrics.incr('ingester.errors.connection')
    })
  }

  private async processEvent(event: JetstreamEvent): Promise<void> {
    if (event.kind === 'identity') {
      await this.handleIdentityEvent(event as JetstreamIdentityEvent)
      return
    }
    if (event.kind === 'account') {
      await this.handleAccountEvent(event as JetstreamAccountEvent)
      return
    }
    if (event.kind !== 'commit') return

    const { commit, did } = event as JetstreamCommitCreate | JetstreamCommitDelete
    const collection = commit.collection

    if (!REPUTATION_COLLECTIONS.includes(collection as any)) return

    if (commit.operation === 'create' && isRateLimited(did)) {
      metrics.incr('ingester.rate_limited_drops', { collection })
      return
    }

    metrics.incr('ingester.events.received', { collection, operation: commit.operation })

    if (commit.operation === 'create' || commit.operation === 'update') {
      await this.handleCreateOrUpdate(did, commit as JetstreamCommitCreate['commit'])
    } else if (commit.operation === 'delete') {
      await this.handleDelete(did, commit as JetstreamCommitDelete['commit'])
    }

    this.eventsSinceCursorSave++
    if (this.eventsSinceCursorSave >= this.CURSOR_SAVE_INTERVAL) {
      const safeCursor = this.queue!.getSafeCursor()
      this.cursor = safeCursor ?? this.highestSeenTimeUs
      await this.saveCursor()
      this.eventsSinceCursorSave = 0
    }
  }

  private async handleCreateOrUpdate(did: string, commit: JetstreamCommitCreate['commit']): Promise<void> {
    const { collection, rkey, record, cid } = commit
    const uri = `at://${did}/${collection}/${rkey}`

    const validation = validateRecord(collection, record)
    if (!validation.success) {
      logger.warn({ uri, errors: validation.errors }, 'Record validation failed')
      metrics.incr('ingester.validation.failed', { collection })
      return
    }

    const handler = routeHandler(collection)
    if (!handler) {
      logger.warn({ collection }, 'No handler registered')
      return
    }

    const ctx = { db: this.db, logger, metrics }

    if (commit.operation === 'update') {
      await handler.handleDelete(ctx, { uri, did, collection, rkey })
    }

    await handler.handleCreate(ctx, {
      uri, did, collection, rkey, cid,
      record: validation.data as Record<string, unknown>,
    })

    metrics.incr('ingester.records.processed', { collection, operation: commit.operation })
  }

  private async handleDelete(did: string, commit: JetstreamCommitDelete['commit']): Promise<void> {
    const { collection, rkey } = commit
    const uri = `at://${did}/${collection}/${rkey}`

    const handler = routeHandler(collection)
    if (!handler) return

    const ctx = { db: this.db, logger, metrics }
    await handler.handleDelete(ctx, { uri, did, collection, rkey })
    metrics.incr('ingester.records.processed', { collection, operation: 'delete' })
  }

  private async handleIdentityEvent(event: JetstreamIdentityEvent): Promise<void> {
    logger.info({ did: event.did, handle: event.identity?.handle }, 'Identity event')
    metrics.incr('ingester.events.identity')
  }

  private async handleAccountEvent(event: JetstreamAccountEvent): Promise<void> {
    if (event.account?.status === 'takendown' || event.account?.status === 'deleted') {
      logger.info({ did: event.did, status: event.account.status }, 'Account status change')
    }
    metrics.incr('ingester.events.account', { status: event.account?.status ?? 'active' })
  }

  private async loadCursor(): Promise<number> {
    const row = await this.db.select()
      .from(ingesterCursor)
      .where(eq(ingesterCursor.service, env.JETSTREAM_URL))
      .limit(1)
    return row[0]?.cursor ? Number(row[0].cursor) : 0
  }

  private async saveCursor(): Promise<void> {
    await this.db.insert(ingesterCursor).values({
      service: env.JETSTREAM_URL,
      cursor: this.cursor,
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: ingesterCursor.service,
      set: { cursor: this.cursor, updatedAt: new Date() },
    })
  }

  private reconnectWithBackoff(): void {
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.MAX_RECONNECT_DELAY_MS)
    this.reconnectAttempts++
    logger.info({ delay, attempt: this.reconnectAttempts }, 'Reconnecting to Jetstream')
    setTimeout(() => this.connect(), delay)
  }

  private setupGracefulShutdown(): void {
    const shutdown = async () => {
      this.isShuttingDown = true
      logger.info('Shutting down ingester...')
      this.ws?.close()
      const safeCursor = this.queue?.getSafeCursor()
      this.cursor = safeCursor ?? this.cursor
      await this.saveCursor()
      logger.info({ cursor: this.cursor, inFlight: this.queue?.inFlight ?? 0 }, 'Final cursor saved')
      process.exit(0)
    }
    process.on('SIGTERM', shutdown)
    process.on('SIGINT', shutdown)
  }
}
