import WebSocket from 'ws'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, openSync, writeSync, closeSync, constants as fsConstants } from 'node:fs'
import { join } from 'node:path'
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

// --- Jetstream TLS host pinning (SEC-MED-08) ---
const DEFAULT_JETSTREAM_ALLOWED_HOSTS = [
  'jetstream1.us-east.bsky.network',
  'jetstream2.us-east.bsky.network',
  'jetstream1.us-west.bsky.network',
  'jetstream2.us-west.bsky.network',
]

const JETSTREAM_ALLOWED_HOSTS: Set<string> = new Set(
  process.env.JETSTREAM_ALLOWED_HOSTS
    ? process.env.JETSTREAM_ALLOWED_HOSTS.split(',').map((h) => h.trim()).filter(Boolean)
    : DEFAULT_JETSTREAM_ALLOWED_HOSTS,
)

/**
 * Validate that the Jetstream URL uses wss: and connects to an allowed host.
 * In non-production (development/test), ws: is permitted for local testing
 * and hostname validation is only enforced for wss: connections.
 */
function validateJetstreamUrl(rawUrl: string): void {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error(`Invalid Jetstream URL: ${rawUrl}`)
  }

  const isProduction = process.env.NODE_ENV === 'production'

  // In production, require wss: (TLS)
  if (isProduction && parsed.protocol !== 'wss:') {
    throw new Error(
      `Jetstream URL must use wss: in production (got ${parsed.protocol}): ${rawUrl}`,
    )
  }

  // In any environment, reject protocols other than ws: and wss:
  if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') {
    throw new Error(
      `Jetstream URL must use ws: or wss: protocol (got ${parsed.protocol}): ${rawUrl}`,
    )
  }

  // Validate hostname against allowlist for wss: connections
  // (ws: is only allowed in non-production for local dev, e.g. ws://localhost)
  if (parsed.protocol === 'wss:' && !JETSTREAM_ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `Jetstream host '${parsed.hostname}' is not in JETSTREAM_ALLOWED_HOSTS. ` +
      `Allowed: [${[...JETSTREAM_ALLOWED_HOSTS].join(', ')}]`,
    )
  }
}

const SPOOL_DIR = process.env.SPOOL_DIR || './data/overflow-spool'
const SPOOL_MAX_SIZE_MB = parseInt(process.env.SPOOL_MAX_SIZE_MB || '100', 10)
const SPOOL_MAX_SIZE_BYTES = SPOOL_MAX_SIZE_MB * 1024 * 1024
const SPOOL_MAX_AGE_MS = 24 * 60 * 60 * 1000 // 24 hours

/** Calculate total size of all files in a directory. */
function getSpoolDirSize(dir: string): number {
  if (!existsSync(dir)) return 0
  let total = 0
  try {
    for (const file of readdirSync(dir)) {
      try {
        total += statSync(join(dir, file)).size
      } catch { /* skip files that vanish between readdir and stat */ }
    }
  } catch { /* directory may not exist or be unreadable */ }
  return total
}

/** Delete spool files older than SPOOL_MAX_AGE_MS. */
function cleanupStaleSpool(dir: string): void {
  if (!existsSync(dir)) return
  const cutoff = Date.now() - SPOOL_MAX_AGE_MS
  try {
    for (const file of readdirSync(dir)) {
      try {
        const filePath = join(dir, file)
        const stat = statSync(filePath)
        if (stat.mtimeMs < cutoff) {
          unlinkSync(filePath)
          logger.info({ file }, 'deleted stale spool file')
        }
      } catch { /* skip files that vanish between readdir and stat */ }
    }
  } catch { /* directory may not exist */ }
}

/** Write data to a spool file with restrictive permissions (0o600). */
function secureSpoolWrite(filePath: string, data: string): void {
  const fd = openSync(filePath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND, 0o600)
  try {
    writeSync(fd, data)
  } finally {
    closeSync(fd)
  }
}

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

  /**
   * Write an event to the overflow spool on disk.
   * Used for both ingress drops (queue full on push) and post-pop retry
   * failures (queue full when trying to requeue a failed item).
   *
   * SEC-MED-07/10: Uses rolling hourly spool files instead of one file per
   * event. This reduces inode churn and makes cleanup predictable.
   */
  private spoolEvent(event: unknown): void {
    const currentSize = getSpoolDirSize(SPOOL_DIR)
    if (currentSize >= SPOOL_MAX_SIZE_BYTES) {
      logger.warn({ currentSizeMB: Math.round(currentSize / 1024 / 1024), maxMB: SPOOL_MAX_SIZE_MB }, 'spool size limit exceeded — skipping write')
      metrics.incr('ingester.spool.quota_exceeded')
      return
    }
    if (!existsSync(SPOOL_DIR)) mkdirSync(SPOOL_DIR, { recursive: true, mode: 0o700 })
    // Rolling hourly file: all events within the same hour go to one file.
    const hourBucket = new Date().toISOString().slice(0, 13).replace(/[^0-9]/g, '')
    const spoolFile = join(SPOOL_DIR, `spool-${hourBucket}.jsonl`)
    secureSpoolWrite(spoolFile, JSON.stringify(event) + '\n')
  }

  async start(): Promise<void> {
    this.cursor = await this.loadCursor()
    logger.info({ cursor: this.cursor }, 'Starting Jetstream consumer')
    await this.replaySpool()
    this.connect()
    this.setupGracefulShutdown()

    // SEC-MED-07/10: Periodic spool cleanup — delete files older than 24h.
    // Runs every hour regardless of whether spoolEvent() is called.
    setInterval(() => {
      try {
        cleanupStaleSpool(SPOOL_DIR)
      } catch (err) {
        logger.warn({ err }, 'periodic spool cleanup failed')
      }
    }, 60 * 60 * 1000)
  }

  /**
   * HIGH-03: Replay spool files from disk before connecting to Jetstream.
   * Spool files contain events that were dropped during queue overflow.
   * Events are replayed in file order (oldest first), and each file is
   * deleted after successful replay.
   */
  private async replaySpool(): Promise<void> {
    if (!existsSync(SPOOL_DIR)) return
    const files = readdirSync(SPOOL_DIR)
      .filter(f => f.endsWith('.jsonl'))
      .sort()
    if (files.length === 0) return
    logger.info({ fileCount: files.length }, 'Replaying spool files')
    for (const file of files) {
      const filePath = join(SPOOL_DIR, file)
      let replayedCount = 0
      try {
        const lines = readFileSync(filePath, 'utf-8').split('\n').filter(Boolean)
        for (const line of lines) {
          try {
            const event = JSON.parse(line) as JetstreamEvent
            await this.processEvent(event)
            replayedCount++
          } catch (err) {
            logger.warn({ file, err }, 'Spool replay: skipping malformed event')
          }
        }
        unlinkSync(filePath)
        logger.info({ file, events: replayedCount }, 'Spool file replayed and deleted')
        metrics.incr('ingester.spool.replayed')
      } catch (err) {
        logger.error({ file, err }, 'Failed to replay spool file')
      }
    }
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

    // SEC-MED-08: Validate TLS and hostname before opening WebSocket
    validateJetstreamUrl(env.JETSTREAM_URL)

    this.ws = new WebSocket(url)

    this.queue = new BoundedIngestionQueue(
      (item) => this.processEvent(item.data as JetstreamEvent),
      {
        maxSize: 1000,
        maxConcurrency: env.DATABASE_POOL_MAX,
        onRetryDropped: (item) => {
          // Spool the failed item so it's recovered via replaySpool() on restart
          try {
            this.spoolEvent(item.data)
            cleanupStaleSpool(SPOOL_DIR)
          } catch (err) {
            logger.error({ err }, 'failed to spool retry-dropped event')
          }
        },
      },
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
        if (!this.queue!.push({ data: event, timestampUs: event.time_us })) {
          metrics.incr('ingester.queue.dropped')
          logger.warn({ event: event.kind }, 'queue full — spooling dropped event')
          try {
            this.spoolEvent(event)
            cleanupStaleSpool(SPOOL_DIR)
          } catch (spoolErr) {
            logger.error({ err: spoolErr }, 'failed to spool dropped event')
          }
        }
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

    if (isRateLimited(did)) {
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
      // HIGH-03 fix: queue may be null during spool replay (before connect())
      const safeCursor = this.queue?.getSafeCursor() ?? null
      this.cursor = safeCursor ?? this.highestSeenTimeUs
      await this.saveCursor()
      this.eventsSinceCursorSave = 0
    }
  }

  private async handleCreateOrUpdate(did: string, commit: JetstreamCommitCreate['commit']): Promise<void> {
    const { collection, rkey, record, cid } = commit
    const uri = `at://${did}/${collection}/${rkey}`

    // HIGH-06: CID provenance validation at ingest boundary.
    //
    // Limitation: Jetstream delivers deserialized JSON records, not the original
    // dag-cbor bytes. Re-encoding JSON→CBOR is not guaranteed to produce the
    // same CID (field ordering, type coercion). Full cryptographic CID
    // verification requires syncing raw blocks from the PDS repo via
    // com.atproto.sync.getRecord. This is tracked as future work for a
    // PDS-sync verification pipeline.
    //
    // Current defense: Enforce CID format (CIDv1 base32lower, "bafy" prefix).
    // Reject records with missing or malformed CIDs — they cannot have come
    // from a well-formed AT Protocol commit.
    if (!cid) {
      logger.warn({ uri }, 'Record missing CID — rejected')
      metrics.incr('ingester.validation.cid_missing', { collection })
      return
    }
    if (!/^bafy[a-z2-7]{50,}$/.test(cid)) {
      logger.warn({ uri, cid: cid.slice(0, 20) }, 'Malformed CID — rejected')
      metrics.incr('ingester.validation.cid_invalid', { collection })
      return
    }

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

    // handleCreate already does ON CONFLICT DO UPDATE (upsert),
    // so no need to handleDelete first for updates. Removing the
    // delete-then-create pattern prevents false tombstones (HIGH-02)
    // and non-transactional data loss risk (HIGH-03).
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
