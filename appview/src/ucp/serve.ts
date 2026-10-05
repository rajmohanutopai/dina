/**
 * The profile host inside `appview-web` (§3.5): its configuration, and the
 * adapter between Node's HTTP server and `createUcpHost`.
 *
 * Off unless `UCP_PROFILE_HOST` is set. In production it also needs the
 * off-host log's bucket (`UCP_LOG_S3_*`) and refuses to start without it; in
 * development and test a missing bucket means an in-memory log, which does
 * not survive a restart.
 *
 * The logging rule (§3.5 "Host logs"): no per-request log line. Counts only
 * (`ucp_host_requests_total` by route and status), and error lines that carry
 * the error's class and nothing else — a database error's message can hold the
 * label, which would tie a merchant's fetch to a person.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  createUcpHost,
  HOST_MAX_BODY_BYTES,
  isUcpHostRequest,
  memoryHostLog,
  type HostRequest,
  type UcpHostLog,
} from '@dina/ucp'

import { checkPerMethodRateLimit, type createRateLimitCache } from '@/api/middleware/rate-limit.js'
import type { DrizzleDB } from '@/db/connection.js'
import { ed25519Verify, publisherKeysFromDidDocument, sha256 } from '@/shared/a2a/card-verify.js'
import { createPlcDidResolver } from '@/shared/a2a/did-resolver.js'
import { logger } from '@/shared/utils/logger.js'
import { metrics } from '@/shared/utils/metrics.js'

import { s3HostLog } from './s3_log.js'
import { postgresHostStore } from './store.js'

export interface UcpHostConfig {
  profileHost: string
  /** The Dina app as the OS knows it, for the claimed OAuth callback link (UCP plan §3.17); absent: none served. */
  appLinks?: { appleAppIds: string[]; androidPackage: string; androidFingerprints: string[] }
  /** The PLC directory publishers' DID documents come from (as the A2A directory's). */
  plcUrl: string
  allowInsecurePlc: boolean
  log:
    | {
        kind: 's3'
        endpoint: string
        region: string
        bucket: string
        accessKeyId: string
        secretAccessKey: string
        prefix: string
      }
    | { kind: 'memory' }
}

const HOSTNAME = /^(?=.{1,200}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

/** The host's configuration from the environment; null when the host is off. Throws on a half-set configuration. */
export function ucpHostConfig(
  env: Readonly<Record<string, string | undefined>>,
  production: boolean,
): UcpHostConfig | null {
  const profileHost = env.UCP_PROFILE_HOST
  if (profileHost === undefined || profileHost === '') return null
  if (!HOSTNAME.test(profileHost)) throw new Error('UCP_PROFILE_HOST must be a lower-case host name')
  const plc = { plcUrl: env.A2A_PLC_URL || 'https://plc.directory', allowInsecurePlc: !production }
  const appLinks = appLinksConfig(env)
  const names = ['ENDPOINT', 'REGION', 'BUCKET', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY'] as const
  const values = names.map((n) => env[`UCP_LOG_S3_${n}`])
  const set = values.filter((v) => v !== undefined && v !== '').length
  if (set === 0) {
    if (production) throw new Error('the UCP profile host needs its off-host log (UCP_LOG_S3_*) in production')
    return { profileHost, ...plc, ...appLinks, log: { kind: 'memory' } }
  }
  if (set !== names.length) throw new Error('UCP_LOG_S3_* must be set together')
  const [endpoint, region, bucket, accessKeyId, secretAccessKey] = values as string[]
  return {
    profileHost,
    ...plc,
    ...appLinks,
    log: {
      kind: 's3',
      endpoint: endpoint as string,
      region: region as string,
      bucket: bucket as string,
      accessKeyId: accessKeyId as string,
      secretAccessKey: secretAccessKey as string,
      prefix: env.UCP_LOG_PREFIX ?? `ucp-host/${profileHost}`.replace(/\./g, '-'),
    },
  }
}

const list = (v: string | undefined): string[] =>
  (v ?? '').split(',').map((x) => x.trim()).filter((x) => x !== '')

/**
 * The app's identifiers for its claimed callback link: UCP_APP_APPLE_IDS
 * (`TEAMID.bundle`, comma-separated), UCP_APP_ANDROID_PACKAGE and
 * UCP_APP_ANDROID_FINGERPRINTS (SHA-256 signing-certificate fingerprints),
 * set together or not at all.
 */
function appLinksConfig(env: NodeJS.ProcessEnv): { appLinks?: UcpHostConfig['appLinks'] } {
  const apple = list(env.UCP_APP_APPLE_IDS)
  const pkg = env.UCP_APP_ANDROID_PACKAGE ?? ''
  const prints = list(env.UCP_APP_ANDROID_FINGERPRINTS)
  const set = [apple.length > 0, pkg !== '', prints.length > 0].filter(Boolean).length
  if (set === 0) return {}
  if (set !== 3) throw new Error('UCP_APP_APPLE_IDS, UCP_APP_ANDROID_PACKAGE and UCP_APP_ANDROID_FINGERPRINTS must be set together')
  return { appLinks: { appleAppIds: apple, androidPackage: pkg, androidFingerprints: prints } }
}

export interface UcpHostServer {
  /** Answers the request when it is for the profile host; false when it is not. */
  serve(req: IncomingMessage, res: ServerResponse, clientIp: string): Promise<boolean>
}

export function createUcpHostServer(args: {
  config: UcpHostConfig
  db: DrizzleDB
  rateLimitCache: ReturnType<typeof createRateLimitCache>
  rateLimitEnvOverride: number
}): UcpHostServer {
  const { config } = args
  const log: UcpHostLog = config.log.kind === 's3' ? s3HostLog(config.log) : memoryHostLog()
  if (config.log.kind === 'memory') logger.warn('ucp host: in-memory log (development only; a restart loses it)')
  const resolveDid = createPlcDidResolver({ plcUrl: config.plcUrl, allowInsecure: config.allowInsecurePlc })
  const host = createUcpHost({
    profileHost: config.profileHost,
    store: postgresHostStore(args.db),
    log,
    signingKeyFor: async (did) => {
      const resolution = await resolveDid(did)
      if (resolution.kind === 'unavailable') return 'unavailable'
      if (resolution.kind !== 'document') return null
      return publisherKeysFromDidDocument(resolution.document, did).dinaSigning
    },
    sha256,
    ed25519Verify,
    ...(config.appLinks !== undefined ? { appLinks: config.appLinks } : {}),
  })

  return {
    async serve(req, res, clientIp) {
      const hostname = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase()
      if (!isUcpHostRequest(hostname, config.profileHost)) return false
      const path = (req.url ?? '/').split('?')[0] as string
      const method = req.method ?? 'GET'
      const route = routeName(hostname, config.profileHost, path)
      const reply = (status: number, headers: Record<string, string>, body: string): void => {
        metrics.incr('ucp_host_requests_total', { route, status: String(status) })
        res.writeHead(status, headers)
        res.end(body)
      }

      const rl = checkPerMethodRateLimit(
        args.rateLimitCache,
        clientIp,
        `ucp.host.${route}`,
        Date.now(),
        args.rateLimitEnvOverride,
      )
      if (!rl.ok) {
        req.resume()
        reply(429, { 'content-type': 'application/json', 'retry-after': String(rl.retryAfterSec) }, '{}')
        return true
      }

      // A change's body is read up to the limit; the drop-box and reads take none.
      let body: Uint8Array | null = null
      if (route === 'change') {
        try {
          body = await readLimited(req, HOST_MAX_BODY_BYTES)
        } catch {
          // The client went away mid-body: nothing to answer, nothing to apply.
          res.destroy()
          return true
        }
      } else {
        req.resume()
      }
      try {
        const answer = await host.handle({
          method,
          hostname,
          path,
          headers: { 'if-none-match': header(req, 'if-none-match') },
          body,
        } satisfies HostRequest)
        reply(answer.status, answer.headers, answer.body)
      } catch (err) {
        logger.error(
          { errorClass: err instanceof Error ? err.constructor.name : typeof err, route },
          'ucp host: request failed',
        )
        reply(500, { 'content-type': 'application/json', 'cache-control': 'no-store' }, '{}')
      }
      return true
    },
  }
}

/** A label-free name for the request's route, for counts and rate limits. */
function routeName(
  hostname: string,
  profileHost: string,
  path: string,
): 'change' | 'state' | 'profile' | 'dropbox' | 'other' {
  if (hostname === profileHost) {
    if (/^\/v1\/profiles\/[^/]+\/state$/.test(path)) return 'state'
    if (/^\/v1\/profiles\/[^/]+(\/retire)?$/.test(path)) return 'change'
    return 'other'
  }
  if (path === '/.well-known/ucp') return 'profile'
  if (path === '/webhooks/orders') return 'dropbox'
  return 'other'
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name]
  return Array.isArray(v) ? v[0] : v
}

/**
 * The body, or an over-long marker (limit + 1 bytes) as soon as it passes the
 * limit. Past the limit the rest is drained, not kept, so the 400 can still be
 * written on the same connection.
 */
function readLimited(req: IncomingMessage, limit: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    const finish = (value: Uint8Array): void => {
      if (done) return
      done = true
      resolve(value)
    }
    req.on('data', (chunk: Buffer) => {
      if (done) return
      size += chunk.length
      if (size > limit) {
        chunks.length = 0
        finish(new Uint8Array(limit + 1))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => finish(new Uint8Array(Buffer.concat(chunks))))
    const fail = (err: Error): void => {
      if (done) return
      done = true
      reject(err)
    }
    req.on('error', fail)
    // A request closed before its end (the client went away) settles too.
    req.on('close', () => fail(new Error('request closed before its end')))
  })
}
