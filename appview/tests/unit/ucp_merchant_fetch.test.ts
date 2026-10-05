/**
 * Reading a merchant's public profile for the index (UCP plan §3.15, §3.3):
 * the URL check every Dina fetch makes, the vetted socket's answer read into
 * a document, a 304, a 404, or a failure, Cache-Control's max-age, and the
 * deadline held here.
 */

import { describe, expect, it, vi } from 'vitest'

import type { PolicySocket, PolicySocketRequest } from '@dina/net-policy'

import { maxAgeOf, profileFetcher } from '@/ucp/merchant_fetch.js'

const ok = (status: number, headers: [string, string][] = [], body = '{}') =>
  ({ ok: true, status, bodyBytes: new TextEncoder().encode(body), rawHeaders: headers, connectedAddress: '203.0.113.1' }) as const

describe('max-age', () => {
  it.each([
    [undefined, null],
    ['public, max-age=3600', 3600_000],
    ['MAX-AGE=60, public', 60_000],
    ['no-store', 0],
    ['max-age=60, no-cache', 0],
    ['max-age=abc', null],
    ['max-age=-1', null],
  ])('%s → %s', (header, ms) => expect(maxAgeOf(header)).toBe(ms))
})

describe('profileFetcher', () => {
  it('asks the vetted socket for JSON within the profile caps, with If-None-Match when given', async () => {
    const asked: PolicySocketRequest[] = []
    const socket: PolicySocket = async (r) => {
      asked.push(r)
      return ok(200, [['etag', '"e1"'], ['cache-control', 'max-age=120'], ['set-cookie', 'x']], '{"ucp":{}}')
    }
    const got = await profileFetcher(socket)('https://shop.example/.well-known/ucp', '"e0"')
    expect(got).toEqual({ kind: 'document', bytes: new TextEncoder().encode('{"ucp":{}}'), etag: '"e1"', maxAgeMs: 120_000 })
    expect(asked[0]).toMatchObject({
      method: 'GET',
      url: 'https://shop.example/.well-known/ucp',
      accept: 'json',
      minTls: 'TLSv1.2',
      ifNoneMatch: '"e0"',
      maxResponseBytes: 128 * 1024,
      timeoutMs: 10_000,
    })
  })

  it.each([
    ['http://shop.example/.well-known/ucp'],
    ['https://user:pw@shop.example/.well-known/ucp'],
    ['https://203.0.113.9/.well-known/ucp'],
  ])('%s is refused before the socket is asked', async (url) => {
    const socket = vi.fn<PolicySocket>()
    expect(await profileFetcher(socket)(url)).toMatchObject({ kind: 'failed', reason: 'unreachable' })
    expect(socket).not.toHaveBeenCalled()
  })

  it('304 only answers a conditional request; 404 is not found; another status is out of reach', async () => {
    expect(await profileFetcher(async () => ok(304))('https://s.example/.well-known/ucp', '"e"')).toEqual({ kind: 'not_modified', maxAgeMs: null })
    // A 304 carries its own Cache-Control.
    expect(await profileFetcher(async () => ok(304, [['cache-control', 'max-age=600']]))('https://s.example/.well-known/ucp', '"e"')).toEqual({
      kind: 'not_modified',
      maxAgeMs: 600_000,
    })
    expect(await profileFetcher(async () => ok(304))('https://s.example/.well-known/ucp')).toMatchObject({ kind: 'failed', reason: 'unreachable', detail: '304' })
    expect(await profileFetcher(async () => ok(404))('https://s.example/.well-known/ucp')).toEqual({ kind: 'failed', reason: 'not_found' })
    expect(await profileFetcher(async () => ok(503))('https://s.example/.well-known/ucp')).toEqual({ kind: 'failed', reason: 'unreachable', detail: '503' })
  })

  it('the socket’s refusals: too large is too large; a blocked address or a throw is out of reach', async () => {
    expect(await profileFetcher(async () => ({ ok: false, error: 'too_large', sent: true }))('https://s.example/x')).toEqual({ kind: 'failed', reason: 'too_large' })
    expect(await profileFetcher(async () => ({ ok: false, error: 'address_blocked', sent: false }))('https://s.example/x')).toEqual({
      kind: 'failed',
      reason: 'unreachable',
      detail: 'address_blocked',
    })
    expect(await profileFetcher(async () => { throw new Error('boom') })('https://s.example/x')).toEqual({ kind: 'failed', reason: 'unreachable', detail: 'io_error' })
  })

  it('a socket that overruns the deadline is out of reach', async () => {
    vi.useFakeTimers()
    try {
      const pending = profileFetcher(() => new Promise(() => undefined))('https://s.example/x')
      await vi.advanceTimersByTimeAsync(10_001)
      expect(await pending).toEqual({ kind: 'failed', reason: 'unreachable', detail: 'timeout' })
    } finally {
      vi.useRealTimers()
    }
  })
})
