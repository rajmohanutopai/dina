import http from 'node:http'
import { URL } from 'node:url'
import { createDb } from '@/db/connection.js'
import { ensureFtsColumns } from '@/db/fts_columns.js'
import { sql } from 'drizzle-orm'
import { resolve, ResolveParams } from '@/api/xrpc/resolve.js'
import { search, SearchParams } from '@/api/xrpc/search.js'
import { getGraph, GetGraphParams } from '@/api/xrpc/get-graph.js'
import { getProfile, GetProfileParams } from '@/api/xrpc/get-profile.js'
import { getAttestations, GetAttestationsParams } from '@/api/xrpc/get-attestations.js'
import { serviceSearch, ServiceSearchParams } from '@/api/xrpc/service-search.js'
import { serviceIsDiscoverable, ServiceIsDiscoverableParams } from '@/api/xrpc/service-is-discoverable.js'
import { attestationStatus, AttestationStatusParams } from '@/api/xrpc/attestation-status.js'
import { cosigList, CosigListParams } from '@/api/xrpc/cosig-list.js'
import { networkFeed, NetworkFeedParams } from '@/api/xrpc/network-feed.js'
import { subjectGet, SubjectGetParams } from '@/api/xrpc/subject-get.js'
import { gateTrustNamespace } from '@/api/middleware/trust-flag-gate.js'
import {
  checkPerMethodRateLimit,
  createRateLimitCache,
} from '@/api/middleware/rate-limit.js'
import { extractClientIp } from '@/api/middleware/client-ip.js'
import { logger } from '@/shared/utils/logger.js'
import { aggregator } from '@/shared/utils/metrics.js'

const db = createDb()
const port = Number(process.env.PORT ?? 3000)

// Ensure FTS columns exist (idempotent — TN-DB-009). Drizzle push
// creates the tables but cannot express GENERATED ALWAYS AS, so the
// tsvector columns + GIN indexes land via this helper. Single source
// of truth shared with the ingester startup path.
;(async () => {
  await ensureFtsColumns(db)
})()

// --- Per-IP, per-method rate limiting (TN-API-007 / Plan §6) ---
// HIGH-01: bounded LRU, proxy guard preserved. Tier table lives in
// `api/middleware/rate-limit.ts`; methods absent from the table fall
// back to DEFAULT_LIMIT_RPM (60). RATE_LIMIT_RPM env override raises
// the floor of every tier (test mode: `RATE_LIMIT_RPM=100000` →
// every bucket effectively unbounded).
const TRUST_PROXY = process.env.TRUST_PROXY === '1'
const rateLimitEnvOverride = parseInt(process.env.RATE_LIMIT_RPM ?? '0', 10)
const rateLimitCache = createRateLimitCache()

const ROUTES: Record<string, { params: any; handler: (db: any, params: any) => Promise<any> }> = {
  'com.dina.trust.resolve': { params: ResolveParams, handler: resolve },
  'com.dina.trust.search': { params: SearchParams, handler: search },
  'com.dina.trust.getGraph': { params: GetGraphParams, handler: getGraph },
  'com.dina.trust.getProfile': { params: GetProfileParams, handler: getProfile },
  'com.dina.trust.getAttestations': { params: GetAttestationsParams, handler: getAttestations },
  'com.dina.service.search': { params: ServiceSearchParams, handler: serviceSearch },
  'com.dina.service.isDiscoverable': { params: ServiceIsDiscoverableParams, handler: serviceIsDiscoverable },
  'com.dina.trust.attestationStatus': { params: AttestationStatusParams, handler: attestationStatus },
  'com.dina.trust.cosigList': { params: CosigListParams, handler: cosigList },
  'com.dina.trust.networkFeed': { params: NetworkFeedParams, handler: networkFeed },
  'com.dina.trust.subjectGet': { params: SubjectGetParams, handler: subjectGet },
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`)

  // HIGH-01 / TN-TEST-082: Pure helper owns the proxy-trust boundary.
  // Tests pin the bypass-resistance contract; inline logic was
  // un-testable + drift-prone.
  const xff = req.headers['x-forwarded-for']
  const clientIp = extractClientIp({
    trustProxy: TRUST_PROXY,
    forwardedFor: typeof xff === 'string' ? xff : Array.isArray(xff) ? xff[0] : undefined,
    remoteAddress: req.socket.remoteAddress,
  })

  // TN-OBS-001: Prometheus exposition endpoint. Like /health, the
  // `/metrics` endpoint is exempt from the rate limiter — Prometheus
  // scrapers poll every 15-60s by default, and tripping the limiter
  // would cause gaps in dashboards exactly when operators need them
  // (during incident traffic spikes). The aggregator is process-
  // singleton, so the response reflects the running counter/gauge
  // state at request time. See `docs/trust-network/observability.md`
  // for the canonical metric list + alert thresholds.
  if (url.pathname === '/metrics') {
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' })
    res.end(aggregator.serialize())
    return
  }

  // MED-06: Health check with DB connectivity verification.
  // Health checks must NOT rate-limit — load balancers / monitoring
  // would trip the limiter at scale and falsely declare the AppView
  // unhealthy.
  if (url.pathname === '/health') {
    try {
      await db.execute(sql`SELECT 1`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok' }))
    } catch {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'degraded', reason: 'db_unreachable' }))
    }
    return
  }

  // XRPC dispatch: /xrpc/{methodId}
  if (url.pathname.startsWith('/xrpc/')) {
    const methodId = url.pathname.slice('/xrpc/'.length)

    // TN-API-007: per-(IP, method) rate limit. Runs BEFORE the unknown-
    // method check so an attacker can't bypass the limiter by spamming
    // `/xrpc/random_garbage`. Unknown methods fall through to
    // DEFAULT_LIMIT_RPM (60), and the LRU cache bound (50k entries)
    // contains the bucket-flood surface. Each method has its own
    // bucket — outbox-watcher polling on `attestationStatus` (600/min)
    // does not crowd out a user's `search` budget (60/min).
    const rl = checkPerMethodRateLimit(
      rateLimitCache,
      clientIp,
      methodId,
      Date.now(),
      rateLimitEnvOverride,
    )
    if (!rl.ok) {
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': String(rl.retryAfterSec),
      })
      res.end(JSON.stringify({
        error: 'TooManyRequests',
        message: `Rate limit exceeded (${rl.limit}/min for ${methodId})`,
      }))
      return
    }

    const route = ROUTES[methodId]
    if (!route) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'InvalidRequest', message: `Unknown method: ${methodId}` }))
      return
    }

    // TN-FLAG-003: kill-switch gate for `com.dina.trust.*`. Service
    // namespaces pass through; trust-namespace methods 503 when the
    // operator has disabled the V1 surface (or when the flag read
    // itself fails — closed-default).
    const gate = await gateTrustNamespace(db, methodId)
    if (!gate.ok) {
      res.writeHead(gate.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(gate.body))
      return
    }

    try {
      const queryParams = Object.fromEntries(url.searchParams.entries())
      const parsed = route.params.parse(queryParams)
      const result = await route.handler(db, parsed)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (err: any) {
      if (err?.name === 'ZodError') {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'InvalidRequest', message: err.message }))
      } else {
        logger.error({ err, method: methodId }, 'XRPC handler error')
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'InternalServerError' }))
      }
    }
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'NotFound' }))
})

server.listen(port, () => {
  logger.info({ port }, 'AppView web server listening')
})
