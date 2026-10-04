/**
 * The directory's DID document fetch under §6.6's outbound rules: HTTPS
 * only, no redirects, a size cap, a deadline, bounded concurrency; and
 * `did:plc` only. Against a scripted fetch, so each rule is shown alone.
 */

import { describe, expect, it } from 'vitest'

import { DID_DOCUMENT_MAX_BYTES, createPlcDidResolver } from '@/shared/a2a/did-resolver.js'

const DID = 'did:plc:abcdefghijklmnopqrstuvwx'
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/did+ld+json' }, ...init })

function resolverWith(handler: (url: string, init: RequestInit) => Promise<Response>, over: Record<string, unknown> = {}) {
  const calls: { url: string; init: RequestInit }[] = []
  const resolve = createPlcDidResolver({
    plcUrl: 'https://plc.example',
    fetch: (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      return handler(String(url), init ?? {})
    }) as typeof fetch,
    ...over,
  })
  return { resolve, calls }
}

describe('what it asks for, and how', () => {
  it('GET {plc}/{did}, no redirects followed, a deadline on it', async () => {
    const { resolve, calls } = resolverWith(async () => json({ id: DID }))
    expect(await resolve(DID)).toEqual({ kind: 'document', document: { id: DID } })
    expect(calls[0]?.url).toBe(`https://plc.example/${DID}`)
    expect(calls[0]?.init).toEqual(expect.objectContaining({ method: 'GET', redirect: 'error' }))
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal)
  })

  it('refuses a plain-HTTP directory unless allowed (development only)', () => {
    expect(() => createPlcDidResolver({ plcUrl: 'http://plc.local' })).toThrow(/HTTPS/)
    expect(() => createPlcDidResolver({ plcUrl: 'http://plc.local', allowInsecure: true })).not.toThrow()
    expect(() => createPlcDidResolver({ plcUrl: 'ftp://plc.local', allowInsecure: true })).toThrow(/HTTPS/)
  })

  it('did:plc only: a did:web, or anything else, is never fetched', async () => {
    const { resolve, calls } = resolverWith(async () => json({}))
    for (const did of ['did:web:evil.example', 'did:plc:short', 'did:plc:ABCDEFGHIJKLMNOPQRSTUVWX', `${DID}/../x`]) {
      expect(await resolve(did)).toEqual({ kind: 'unsupported' })
    }
    expect(calls).toEqual([])
  })
})

describe('what an answer means', () => {
  it.each([
    [404, { kind: 'not_found' }],
    [410, { kind: 'deactivated' }],
    [500, { kind: 'unavailable' }],
    [302, { kind: 'unavailable' }],
  ])('HTTP %s → %j', async (status, expected) => {
    const { resolve } = resolverWith(async () => new Response('{}', { status, headers: { 'content-type': 'application/json' } }))
    expect(await resolve(DID)).toEqual(expected)
  })

  it('a refused redirect, a reset, a timeout: unavailable, never a verdict', async () => {
    for (const fail of [new TypeError('fetch failed: redirect mode is set to error'), new Error('ECONNRESET')]) {
      const { resolve } = resolverWith(async () => {
        throw fail
      })
      expect(await resolve(DID)).toEqual({ kind: 'unavailable' })
    }
    const { resolve } = resolverWith(
      (_url, init) =>
        new Promise((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
      { timeoutMs: 20 },
    )
    expect(await resolve(DID)).toEqual({ kind: 'unavailable' })
  })

  it('not JSON, too large (declared or streamed), or not UTF-8: unavailable', async () => {
    const cases: Response[] = [
      new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(DID_DOCUMENT_MAX_BYTES + 1) } }),
      new Response(JSON.stringify({ pad: 'x'.repeat(DID_DOCUMENT_MAX_BYTES) }), { status: 200, headers: { 'content-type': 'application/json' } }),
      new Response(new Uint8Array([0x7b, 0xff, 0x7d]), { status: 200, headers: { 'content-type': 'application/json' } }),
      new Response('{not json', { status: 200, headers: { 'content-type': 'application/json' } }),
    ]
    for (const response of cases) {
      const { resolve } = resolverWith(async () => response)
      expect(await resolve(DID)).toEqual({ kind: 'unavailable' })
    }
  })
})

it('runs at most the configured number of lookups at once', async () => {
  let inFlight = 0
  let most = 0
  const { resolve } = resolverWith(
    async () => {
      inFlight += 1
      most = Math.max(most, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight -= 1
      return json({ id: DID })
    },
    { maxConcurrent: 2 },
  )
  const results = await Promise.all(Array.from({ length: 7 }, () => resolve(DID)))
  expect(results.every((r) => r.kind === 'document')).toBe(true)
  expect(most).toBe(2)
})
