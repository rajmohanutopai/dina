/**
 * Tests for the handle resolver — pure extractor + HTTP-backed
 * resolver that powers the `backfill-handles` scorer job.
 *
 * Mocks `globalThis.fetch` rather than spinning up a fake PLC server;
 * the resolver's side effects are entirely the HTTP call shape and
 * the JSON parse of the returned doc.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  extractHandleFromDoc,
  resolveHandleFromPLC,
  resolveHandlesBatch,
} from '@/util/handle_resolver.js'

describe('extractHandleFromDoc', () => {
  it('returns the handle from a normal alsoKnownAs entry', () => {
    expect(
      extractHandleFromDoc({ alsoKnownAs: ['at://alice.bsky.social'] }),
    ).toBe('alice.bsky.social')
  })

  it('lowercases the handle (PLC docs occasionally carry mixed case)', () => {
    expect(
      extractHandleFromDoc({ alsoKnownAs: ['at://Alice.Bsky.Social'] }),
    ).toBe('alice.bsky.social')
  })

  it('strips an accidental trailing slash', () => {
    expect(
      extractHandleFromDoc({ alsoKnownAs: ['at://alice.bsky.social/'] }),
    ).toBe('alice.bsky.social')
  })

  it('skips non-string entries and finds the first valid one', () => {
    expect(
      extractHandleFromDoc({
        alsoKnownAs: [42 as unknown as string, 'at://alice.bsky.social'],
      }),
    ).toBe('alice.bsky.social')
  })

  it('returns null when alsoKnownAs is absent', () => {
    expect(extractHandleFromDoc({})).toBeNull()
  })

  it('returns null when alsoKnownAs is empty', () => {
    expect(extractHandleFromDoc({ alsoKnownAs: [] })).toBeNull()
  })

  it('returns null for non-at:// URIs', () => {
    expect(
      extractHandleFromDoc({ alsoKnownAs: ['https://alice.example.com'] }),
    ).toBeNull()
  })

  it('rejects handles missing a domain (single-label)', () => {
    expect(
      extractHandleFromDoc({ alsoKnownAs: ['at://alice'] }),
    ).toBeNull()
  })

  it('rejects handles with underscores', () => {
    expect(
      extractHandleFromDoc({ alsoKnownAs: ['at://al_ice.bsky.social'] }),
    ).toBeNull()
  })

  it('rejects handles with leading hyphen on a label', () => {
    expect(
      extractHandleFromDoc({ alsoKnownAs: ['at://-alice.bsky.social'] }),
    ).toBeNull()
  })
})

describe('resolveHandleFromPLC', () => {
  function fetchOk(body: unknown): typeof globalThis.fetch {
    return vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => body,
    } as unknown as Response)) as unknown as typeof globalThis.fetch
  }

  it('returns null without fetching for non-plc DIDs', async () => {
    const fetch = vi.fn() as unknown as typeof globalThis.fetch
    const r = await resolveHandleFromPLC('did:web:alice.example.com', { fetch })
    expect(r).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('hits PLC and returns the handle from alsoKnownAs', async () => {
    const fetch = fetchOk({ alsoKnownAs: ['at://alice.pds.dinakernel.com'] })
    const r = await resolveHandleFromPLC('did:plc:abc123', {
      plcURL: 'https://plc.example',
      fetch,
    })
    expect(r).toBe('alice.pds.dinakernel.com')
    expect(fetch).toHaveBeenCalledTimes(1)
    const url = (fetch as unknown as { mock: { calls: [unknown][] } }).mock.calls[0][0]
    expect(String(url)).toBe('https://plc.example/did%3Aplc%3Aabc123')
  })

  it('returns null on PLC 404 (DID not registered)', async () => {
    const fetch = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
    } as unknown as Response)) as unknown as typeof globalThis.fetch
    const r = await resolveHandleFromPLC('did:plc:gone', { fetch })
    expect(r).toBeNull()
  })

  it('returns null on PLC 410 (DID tombstoned)', async () => {
    const fetch = vi.fn(async () => ({
      ok: false,
      status: 410,
      json: async () => ({}),
    } as unknown as Response)) as unknown as typeof globalThis.fetch
    const r = await resolveHandleFromPLC('did:plc:tomb', { fetch })
    expect(r).toBeNull()
  })

  it('throws on PLC 500 so the caller can retry on a future tick', async () => {
    const fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as unknown as Response)) as unknown as typeof globalThis.fetch
    await expect(
      resolveHandleFromPLC('did:plc:abc', { fetch }),
    ).rejects.toThrow(/HTTP 500/)
  })

  it('throws on network error (no swallow)', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED')
    }) as unknown as typeof globalThis.fetch
    await expect(
      resolveHandleFromPLC('did:plc:abc', { fetch }),
    ).rejects.toThrow(/ECONNREFUSED/)
  })

  it('returns null when the doc has no parseable handle', async () => {
    const fetch = fetchOk({ alsoKnownAs: ['https://alice.example.com'] })
    const r = await resolveHandleFromPLC('did:plc:noaka', { fetch })
    expect(r).toBeNull()
  })
})

describe('resolveHandlesBatch', () => {
  it('resolves DIDs in parallel and returns a map keyed by DID', async () => {
    const responses: Record<string, unknown> = {
      'did:plc:a': { alsoKnownAs: ['at://alice.dina'] },
      'did:plc:b': { alsoKnownAs: ['at://bob.dina'] },
      'did:plc:c': {}, // no handle published
    }
    // The DNS validation requires at least one dot; "alice.dina" has
    // one but we still want to lower it so let's use full domains.
    responses['did:plc:a'] = { alsoKnownAs: ['at://alice.pds.dinakernel.com'] }
    responses['did:plc:b'] = { alsoKnownAs: ['at://bob.pds.dinakernel.com'] }

    const fetch = vi.fn(async (input: unknown) => {
      const url = String(input)
      const did = decodeURIComponent(url.split('/').pop() ?? '')
      const body = responses[did]
      return {
        ok: body !== undefined,
        status: body !== undefined ? 200 : 404,
        json: async () => body ?? {},
      } as unknown as Response
    }) as unknown as typeof globalThis.fetch

    const result = await resolveHandlesBatch(
      ['did:plc:a', 'did:plc:b', 'did:plc:c'],
      { fetch },
    )
    expect(result.get('did:plc:a')).toBe('alice.pds.dinakernel.com')
    expect(result.get('did:plc:b')).toBe('bob.pds.dinakernel.com')
    expect(result.get('did:plc:c')).toBeNull()
  })

  it('records null for DIDs whose fetch threw (graceful degradation)', async () => {
    const fetch = vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.includes('flaky')) throw new Error('boom')
      return {
        ok: true,
        status: 200,
        json: async () => ({ alsoKnownAs: ['at://ok.pds.dinakernel.com'] }),
      } as unknown as Response
    }) as unknown as typeof globalThis.fetch
    const result = await resolveHandlesBatch(
      ['did:plc:flaky', 'did:plc:ok'],
      { fetch },
    )
    expect(result.get('did:plc:flaky')).toBeNull()
    expect(result.get('did:plc:ok')).toBe('ok.pds.dinakernel.com')
  })
})
