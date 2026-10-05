/**
 * The UCP profile host (docs/UCP_IMPLEMENTATION_PLAN.md §3.5) as it runs in
 * appview-web: real HTTP, REAL POSTGRES (`ucp_profile_labels`), and DID
 * documents from a local PLC directory over the real resolver. Only the
 * off-host log is in memory (its S3 form has its own suite).
 *
 * Run:
 *   DATABASE_URL=postgresql://dina:dina@localhost:5432/dina_trust \
 *     npx vitest run tests/integration/ucp_profile_host.test.ts
 */

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { generateKeyPairSync, sign as nodeSign, type KeyObject } from 'node:crypto'

import {
  buyerProfileBytes,
  documentHash,
  es256PublicJwk,
  labelFromBytes,
  signPublication,
  type PublishedKey,
} from '@dina/ucp'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createRateLimitCache } from '@/api/middleware/rate-limit.js'
import { sha256 } from '@/shared/a2a/card-verify.js'
import { logger } from '@/shared/utils/logger.js'
import { createUcpHostServer, ucpHostConfig } from '@/ucp/serve.js'

import { didDocument, newDid, newKeys, type Keys } from '../a2a-fixture.js'
import { cleanTables, closeTestDb, getTestDb } from '../test-db.js'

const db = getTestDb()
const HOST = 'ucp.dina.test'

let plc: http.Server
let web: http.Server
let port: number
const docs = new Map<string, unknown>()

const ucpKey = (() => {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string }
  return es256PublicJwk(
    new Uint8Array([0x04, ...Buffer.from(jwk.x, 'base64url'), ...Buffer.from(jwk.y, 'base64url')]),
    sha256,
  )
})()
const activeKey: PublishedKey = { thumbprint: ucpKey.kid, generation: 0, phase: 'active' }

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)))
}

beforeAll(async () => {
  plc = http.createServer((req, res) => {
    const doc = docs.get(decodeURIComponent((req.url ?? '/').slice(1)))
    res.writeHead(doc === undefined ? 404 : 200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(doc ?? {}))
  })
  const plcPort = await listen(plc)
  const config = ucpHostConfig({ UCP_PROFILE_HOST: HOST, A2A_PLC_URL: `http://127.0.0.1:${plcPort}` }, false)
  if (config === null) throw new Error('host off')
  const host = createUcpHostServer({
    config,
    db,
    rateLimitCache: createRateLimitCache(),
    rateLimitEnvOverride: 100_000,
  })
  web = http.createServer(async (req, res) => {
    if (!(await host.serve(req, res, '127.0.0.1'))) {
      res.writeHead(418)
      res.end()
    }
  })
  port = await listen(web)
})

afterAll(async () => {
  await new Promise((r) => web.close(r))
  await new Promise((r) => plc.close(r))
  await closeTestDb()
})

beforeEach(async () => {
  await cleanTables(db, 'ucp_profile_labels')
  docs.clear()
})

interface Node {
  did: string
  keys: Keys
  label: string
}

function newNode(labelByte: number): Node {
  const did = newDid()
  const keys = newKeys()
  docs.set(did, didDocument(did, keys))
  return { did, keys, label: labelFromBytes(new Uint8Array(16).fill(labelByte)) }
}

const sign = (k: KeyObject) => (m: Uint8Array) => new Uint8Array(nodeSign(null, m, k))

async function uploadBody(node: Node, revision: number, webhook = 'orders'): Promise<string> {
  const bytes = buyerProfileBytes({ keys: [ucpKey], webhookUrl: `https://${node.label}.${HOST}/webhooks/${webhook}` })
  const envelope = await signPublication(
    {
      did: node.did,
      label: node.label,
      epoch: 1,
      instance: '11111111-1111-4111-8111-111111111111',
      revision,
      issued_at: 1_759_000_000_000 + revision,
      op: 'upload',
      documents: { '2026-08-25': documentHash(bytes, sha256) },
      keys: [activeKey],
    },
    sign(node.keys.ed.privateKey),
    HOST,
  )
  return JSON.stringify({ envelope, documents: { '2026-08-25': bytes } })
}

function call(
  method: string,
  host: string,
  path: string,
  body?: string | Buffer,
  headers: Record<string, string> = {},
) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { host, ...headers } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }),
      )
    })
    req.on('error', reject)
    req.end(body)
  })
}

describe('the profile host in appview-web, on Postgres', () => {
  it('binds, stores and serves; the stored row reads back as the state', async () => {
    const node = newNode(0x11)
    const up = await call('PUT', HOST, `/v1/profiles/${node.label}`, await uploadBody(node, 1))
    expect(up.status).toBe(200)
    const served = await call('GET', `${node.label}.${HOST}`, '/.well-known/ucp')
    expect(served.status).toBe(200)
    expect(served.headers['cache-control']).toBe('public, max-age=300')
    expect(JSON.parse(served.body).keys[0].kid).toBe(ucpKey.kid)
    const rows = await db.execute(sql`SELECT did, revision FROM ucp_profile_labels WHERE label = ${node.label}`)
    expect(rows.rows).toEqual([{ did: node.did, revision: '1' }])
  })

  it('two first claims for one label at once: exactly one DID gets it', async () => {
    const a = newNode(0x22)
    const b = { ...newNode(0x22) }
    const [ra, rb] = await Promise.all([
      call('PUT', HOST, `/v1/profiles/${a.label}`, await uploadBody(a, 1)),
      call('PUT', HOST, `/v1/profiles/${b.label}`, await uploadBody(b, 1)),
    ])
    expect([ra.status, rb.status].sort()).toEqual([200, 409])
    const rows = await db.execute(sql`SELECT did FROM ucp_profile_labels WHERE label = ${a.label}`)
    expect(rows.rows).toHaveLength(1)
  })

  it('ten uploads racing for revision 2: one applies, and the revision moves once', async () => {
    const node = newNode(0x33)
    await call('PUT', HOST, `/v1/profiles/${node.label}`, await uploadBody(node, 1))
    const bodies = await Promise.all(Array.from({ length: 10 }, (_, i) => uploadBody(node, 2, `w${i}`)))
    const answers = await Promise.all(bodies.map((b) => call('PUT', HOST, `/v1/profiles/${node.label}`, b)))
    expect(answers.filter((r) => r.status === 200)).toHaveLength(1)
    expect(answers.filter((r) => r.status === 409)).toHaveLength(9)
    const state = JSON.parse((await call('GET', HOST, `/v1/profiles/${node.label}/state`)).body)
    expect(state.revision).toBe(2)
  })

  it('a damaged stored row answers 500 without taking the label for unbound', async () => {
    const node = newNode(0x44)
    await call('PUT', HOST, `/v1/profiles/${node.label}`, await uploadBody(node, 1))
    await db.execute(sql`UPDATE ucp_profile_labels SET state_json = '{"did":"x"}' WHERE label = ${node.label}`)
    expect((await call('GET', `${node.label}.${HOST}`, '/.well-known/ucp')).status).toBe(500)
    const other = { ...newNode(0x44) }
    expect((await call('PUT', HOST, `/v1/profiles/${other.label}`, await uploadBody(other, 1))).status).toBe(500)
  })

  it('an over-long change body is refused with 400 on a working connection', async () => {
    const node = newNode(0x55)
    const r = await call('PUT', HOST, `/v1/profiles/${node.label}`, Buffer.alloc(300 * 1024, 0x20))
    expect(r.status).toBe(400)
  })

  it('a DID whose document has no dina_signing key, or that PLC does not know, is refused', async () => {
    const node = newNode(0x66)
    docs.set(node.did, { '@context': [], id: node.did, verificationMethod: [] })
    expect((await call('PUT', HOST, `/v1/profiles/${node.label}`, await uploadBody(node, 1))).status).toBe(401)
    // PLC does not know the DID (a permanent answer): 401, never a 5xx that would have the node retry for ever.
    docs.delete(node.did)
    expect((await call('PUT', HOST, `/v1/profiles/${node.label}`, await uploadBody(node, 1))).status).toBe(401)
  })

  it('names that are not the host fall through; AppView routes are unreachable under host names', async () => {
    expect((await call('GET', 'appview.dina.test', '/health')).status).toBe(418)
    expect((await call('GET', HOST, '/health')).status).toBe(404)
    expect((await call('GET', `x.${HOST}`, '/xrpc/com.dinakernel.peerlens.search')).status).toBe(404)
  })
})

describe('failures', () => {
  it('a client that drops a change mid-body leaves the server answering', async () => {
    const node = newNode(0x77)
    await new Promise<void>((resolve) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'PUT',
        path: `/v1/profiles/${node.label}`,
        headers: { host: HOST, 'content-length': '1000' },
      })
      req.on('error', () => resolve())
      req.write('{"env')
      setTimeout(() => {
        req.destroy()
        resolve()
      }, 50)
    })
    await new Promise((r) => setTimeout(r, 50))
    expect((await call('GET', HOST, `/v1/profiles/${node.label}/state`)).status).toBe(404)
  })

  it('an error line carries the error class and route only: no label, DID or host name', async () => {
    const node = newNode(0x44)
    await call('PUT', HOST, `/v1/profiles/${node.label}`, await uploadBody(node, 1))
    await db.execute(sql`UPDATE ucp_profile_labels SET state_json = '{"did":"x"}' WHERE label = ${node.label}`)
    const lines: unknown[] = []
    const spy = vi.spyOn(logger, 'error').mockImplementation(((...args: unknown[]) => {
      lines.push(args)
    }) as typeof logger.error)
    try {
      expect((await call('GET', `${node.label}.${HOST}`, '/.well-known/ucp')).status).toBe(500)
    } finally {
      spy.mockRestore()
    }
    expect(lines).toHaveLength(1)
    const text = JSON.stringify(lines)
    expect(text).toContain('errorClass')
    for (const secret of [node.label, node.did, HOST]) expect(text).not.toContain(secret)
  })
})

describe('configuration', () => {
  it('is off without UCP_PROFILE_HOST, and refuses a half-set or production-without-log setup', () => {
    expect(ucpHostConfig({}, true)).toBeNull()
    expect(() => ucpHostConfig({ UCP_PROFILE_HOST: HOST }, true)).toThrow('off-host log')
    expect(() => ucpHostConfig({ UCP_PROFILE_HOST: HOST, UCP_LOG_S3_BUCKET: 'b' }, false)).toThrow('together')
    expect(() => ucpHostConfig({ UCP_PROFILE_HOST: 'UCP.Example' }, false)).toThrow('host name')
    expect(ucpHostConfig({ UCP_PROFILE_HOST: HOST }, false)?.log).toEqual({ kind: 'memory' })
    const full = ucpHostConfig(
      {
        UCP_PROFILE_HOST: HOST,
        UCP_LOG_S3_ENDPOINT: 'https://s3.test',
        UCP_LOG_S3_REGION: 'r',
        UCP_LOG_S3_BUCKET: 'b-1',
        UCP_LOG_S3_ACCESS_KEY_ID: 'a',
        UCP_LOG_S3_SECRET_ACCESS_KEY: 's',
      },
      true,
    )
    expect(full).toMatchObject({
      plcUrl: 'https://plc.directory',
      allowInsecurePlc: false,
      log: { kind: 's3', prefix: 'ucp-host/ucp-dina-test' },
    })
  })
})
