import http from 'node:http'
import { LRUCache } from 'lru-cache'
import { URL } from 'node:url'
import { createDb } from '@/db/connection.js'
import { sql } from 'drizzle-orm'
import { resolve, ResolveParams } from '@/api/xrpc/resolve.js'
import { search, SearchParams } from '@/api/xrpc/search.js'
import { getGraph, GetGraphParams } from '@/api/xrpc/get-graph.js'
import { getProfile, GetProfileParams } from '@/api/xrpc/get-profile.js'
import { getAttestations, GetAttestationsParams } from '@/api/xrpc/get-attestations.js'
import { serviceSearch, ServiceSearchParams } from '@/api/xrpc/service-search.js'
import { serviceIsPublic, ServiceIsPublicParams } from '@/api/xrpc/service-is-public.js'
import { logger } from '@/shared/utils/logger.js'

const db = createDb()
const port = Number(process.env.PORT ?? 3000)

// Ensure FTS search_vector column exists (idempotent, runs on every startup).
// Drizzle push creates the table but cannot express GENERATED ALWAYS AS.
;(async () => {
  try {
    await db.execute(sql`
      ALTER TABLE attestations ADD COLUMN IF NOT EXISTS search_vector tsvector
        GENERATED ALWAYS AS (to_tsvector('english', coalesce(search_content, ''))) STORED
    `)
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_attestations_search
        ON attestations USING GIN (search_vector)
    `)
  } catch { /* table may not exist yet — ingester creates it first */ }
})()

// --- Per-IP rate limiting (HIGH-01: bounded LRU, proxy guard) ---
const TRUST_PROXY = process.env.TRUST_PROXY === '1'
const RATE_LIMIT_RPM = parseInt(process.env.RATE_LIMIT_RPM || '60', 10)
const rateLimitMap = new LRUCache<string, { count: number; resetAt: number }>({
  max: 50_000,
  ttl: 60_000,
})

function checkRateLimit(ip: string): boolean {
  const now = Date.now()
  const entry = rateLimitMap.get(ip)
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + 60_000 })
    return true
  }
  entry.count++
  return entry.count <= RATE_LIMIT_RPM
}

const ROUTES: Record<string, { params: any; handler: (db: any, params: any) => Promise<any> }> = {
  'com.dina.trust.resolve': { params: ResolveParams, handler: resolve },
  'com.dina.trust.search': { params: SearchParams, handler: search },
  'com.dina.trust.getGraph': { params: GetGraphParams, handler: getGraph },
  'com.dina.trust.getProfile': { params: GetProfileParams, handler: getProfile },
  'com.dina.trust.getAttestations': { params: GetAttestationsParams, handler: getAttestations },
  'com.dina.service.search': { params: ServiceSearchParams, handler: serviceSearch },
  'com.dina.service.isPublic': { params: ServiceIsPublicParams, handler: serviceIsPublic },
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`)

  // Per-IP rate limiting (SEC-MED-06) — checked before any routing
  // HIGH-01: Only trust proxy headers when explicitly configured
  const clientIp = TRUST_PROXY
    ? (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
      || req.socket.remoteAddress || 'unknown'
    : req.socket.remoteAddress || 'unknown'
  if (!checkRateLimit(clientIp)) {
    const entry = rateLimitMap.get(clientIp)
    const retryAfter = entry ? Math.ceil((entry.resetAt - Date.now()) / 1000) : 60
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'Retry-After': String(Math.max(retryAfter, 1)),
    })
    res.end(JSON.stringify({ error: 'TooManyRequests', message: 'Rate limit exceeded' }))
    return
  }

  // MED-06: Health check with DB connectivity verification
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
    const route = ROUTES[methodId]

    if (!route) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'InvalidRequest', message: `Unknown method: ${methodId}` }))
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
