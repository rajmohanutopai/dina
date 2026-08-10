import http from 'node:http'
import { URL } from 'node:url'
import { buildOAuthClientMetadata } from '@/web/oauth_metadata.js'
import { createDb } from '@/db/connection.js'
import { ensureFtsColumns } from '@/db/fts_columns.js'
import { sql } from 'drizzle-orm'
import {
  InjectAttestationBody,
  DeleteAttestationBody,
  injectAttestation,
  deleteAttestation,
  checkTestInjectAuth,
} from '@/api/xrpc/test-inject.js'
import { checkMetricsAuth } from '@/web/metrics_auth.js'
import { gatePeerlensNamespace } from '@/api/middleware/peerlens-flag-gate.js'
import {
  checkPerMethodRateLimit,
  createRateLimitCache,
} from '@/api/middleware/rate-limit.js'
import { dispatchXrpc } from '@/web/xrpc-dispatch.js'
import { XRPC_ROUTES } from '@/web/xrpc-routes.js'
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
  // state at request time. See `docs/peerlens-network/observability.md`
  // for the canonical metric list + alert thresholds.
  if (url.pathname === '/metrics') {
    // P3.13: gate /metrics behind a bearer token (DINA_METRICS_TOKEN) so this
    // internal operational data isn't world-readable. 404 on missing/mismatch
    // so the surface can't be enumerated. See `checkMetricsAuth`.
    if (!checkMetricsAuth(req.headers.authorization)) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'NotFound' }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' })
    res.end(aggregator.serialize())
    return
  }

  // Build identity: {version, tree, dirty} baked in at image build from the
  // appview/.release binding manifest (scripts/release/component_version.sh).
  // Lets the deploy script — and anyone — verify what exactly is running
  // without trusting a hand-maintained version string.
  if (url.pathname === '/version') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        service: 'appview',
        version: process.env.BUILD_VERSION ?? 'dev',
        tree: process.env.BUILD_TREE ?? 'unknown',
        dirty: process.env.BUILD_DIRTY === '1',
      }),
    )
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

  // ATProto OAuth client metadata (Login with Bluesky). The `client_id`
  // MUST equal the URL this doc is fetched from, so derive it from the
  // request Host — one route serves both test-appview and appview. The
  // native redirect scheme is the client_id host in reverse-domain order
  // (atproto OAuth native-client rule), e.g.
  // test-appview.dinakernel.com → com.dinakernel.test-appview:/oauth/callback.
  // Static, no DB, no rate-limit. See atproto.com/specs/oauth.
  if (url.pathname === '/oauth/client-metadata.json') {
    const host = (req.headers.host ?? `localhost:${port}`).split(',')[0].trim()
    // Identity-only scope, no refresh_token — see `buildOAuthClientMetadata`.
    const metadata = buildOAuthClientMetadata(host)
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300',
    })
    res.end(JSON.stringify(metadata))
    return
  }

  // POST writes — test-mode-only inject endpoints. Hidden behind a
  // 404 unless `DINA_TEST_INJECT=1` AND `DINA_TEST_INJECT_TOKEN` are
  // both set on the container; the token must match
  // `Authorization: Bearer <token>`. See test-inject.ts for the
  // gate. Treats wrong/absent auth identically to "endpoint not
  // found" so probes can't enumerate the surface.
  if (
    req.method === 'POST' &&
    (url.pathname === '/xrpc/com.dinakernel.test.injectAttestation' ||
      url.pathname === '/xrpc/com.dinakernel.test.deleteAttestation')
  ) {
    const authFail = checkTestInjectAuth(req.headers.authorization)
    if (authFail !== null) {
      res.writeHead(authFail.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(authFail.body))
      return
    }
    // P3.14: bound the request body even though the endpoint is token-gated —
    // an authenticated-but-buggy/hostile client shouldn't be able to stream an
    // unbounded payload into memory.
    let raw = ''
    const MAX_INJECT_BODY = 256 * 1024 // 256 KB
    for await (const chunk of req) {
      raw += chunk
      if (raw.length > MAX_INJECT_BODY) {
        // Reuse the documented `InvalidRequest` name (a too-large body is an
        // invalid request) to stay within the public error-name contract.
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'InvalidRequest', message: 'request body too large' }))
        return
      }
    }
    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'InvalidRequest', message: 'malformed JSON' }))
      return
    }
    try {
      if (url.pathname.endsWith('injectAttestation')) {
        const parsed = InjectAttestationBody.parse(body)
        const out = await injectAttestation(db, parsed)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(out))
      } else {
        const parsed = DeleteAttestationBody.parse(body)
        const out = await deleteAttestation(db, parsed)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(out))
      }
    } catch (err: any) {
      if (err?.name === 'ZodError') {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'InvalidRequest', message: err.message }))
      } else {
        logger.error({ err, path: url.pathname }, 'test-inject handler error')
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'InternalServerError' }))
      }
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

    if (XRPC_ROUTES[methodId] === undefined) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'InvalidRequest', message: `Unknown method: ${methodId}` }))
      return
    }

    // TN-FLAG-003: kill-switch gate for `com.dinakernel.peerlens.*`. Service
    // namespaces pass through; trust-namespace methods 503 when the
    // operator has disabled the V1 surface (or when the flag read
    // itself fails — closed-default).
    const gate = await gatePeerlensNamespace(db, methodId)
    if (!gate.ok) {
      res.writeHead(gate.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(gate.body))
      return
    }

    const outcome = await dispatchXrpc({
      routes: XRPC_ROUTES,
      db,
      methodId,
      searchParams: url.searchParams,
      onError: (err, method) => {
        logger.error({ err, method }, 'XRPC handler error')
      },
    })
    res.writeHead(outcome.status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(outcome.body))
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'NotFound' }))
})

server.listen(port, () => {
  logger.info({ port }, 'AppView web server listening')
})
