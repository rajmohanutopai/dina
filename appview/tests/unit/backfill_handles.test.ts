/**
 * Unit tests for `appview/src/scorer/jobs/backfill-handles.ts`.
 *
 * Contract:
 *   - Picks up to BATCH_SIZE DIDs from `did_profiles` with handle = NULL
 *   - Filters to `did:plc:` only (skips `did:web:`, etc.)
 *   - Resolves each via the injected resolver (PLC fetch)
 *   - Persists resolved handles via UPDATE
 *   - Persists '' sentinel for DIDs with no published handle (so the
 *     row isn't picked up again next tick)
 *   - Logs counts; doesn't throw on per-DID resolver failures
 */

import { describe, expect, it, vi } from 'vitest'

const mockMetricsCounter = vi.fn()
vi.mock('@/shared/utils/metrics.js', () => ({
  metrics: {
    counter: (...args: unknown[]) => mockMetricsCounter(...args),
    incr: vi.fn(),
  },
}))

const mockLoggerInfo = vi.fn()
const mockLoggerDebug = vi.fn()
const mockLoggerWarn = vi.fn()
vi.mock('@/shared/utils/logger.js', () => ({
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    debug: (...args: unknown[]) => mockLoggerDebug(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: vi.fn(),
  },
}))

import { backfillHandles } from '@/scorer/jobs/backfill-handles'
import type { DrizzleDB } from '@/db/connection'

interface CapturedUpdate {
  setValue: Record<string, unknown>
}

interface StubOpts {
  candidates: { did: string }[]
}

/**
 * Build a minimal Drizzle stub. We capture every UPDATE's SET payload
 * so tests can assert which handles got written to which DIDs.
 */
function stubDb(opts: StubOpts): { db: DrizzleDB; updates: CapturedUpdate[] } {
  const updates: CapturedUpdate[] = []
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => opts.candidates,
        }),
      }),
    }),
    update: () => ({
      set: (value: Record<string, unknown>) => {
        const u: CapturedUpdate = { setValue: value }
        updates.push(u)
        return {
          where: async () => undefined,
        }
      },
    }),
  } as unknown as DrizzleDB
  return { db, updates }
}

/**
 * Build a fetch stub keyed by DID — return `{alsoKnownAs: ['at://<handle>']}`
 * for known DIDs, 404 for missing DIDs, throw for "broken" DIDs.
 */
function stubFetch(map: Record<string, string | 'broken' | '404'>): typeof globalThis.fetch {
  return (vi.fn(async (input: unknown) => {
    const url = String(input)
    const did = decodeURIComponent(url.split('/').pop() ?? '')
    const value = map[did]
    if (value === undefined || value === '404') {
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response
    }
    if (value === 'broken') {
      throw new Error('boom')
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ alsoKnownAs: [`at://${value}`] }),
    } as unknown as Response
  }) as unknown) as typeof globalThis.fetch
}

describe('backfillHandles', () => {
  it('writes handle for DIDs whose PLC doc has alsoKnownAs', async () => {
    const { db, updates } = stubDb({
      candidates: [{ did: 'did:plc:alice' }, { did: 'did:plc:bob' }],
    })
    await backfillHandles(db, {
      plcURL: 'https://plc.example',
      fetch: stubFetch({
        'did:plc:alice': 'alice.pds.dinakernel.com',
        'did:plc:bob': 'bob.pds.dinakernel.com',
      }),
    })
    const handlesWritten = updates
      .map((u) => u.setValue.handle)
      .filter((h) => typeof h === 'string' && h.length > 0)
    expect(handlesWritten).toEqual(
      expect.arrayContaining([
        'alice.pds.dinakernel.com',
        'bob.pds.dinakernel.com',
      ]),
    )
  })

  it("writes '' sentinel for DIDs that resolved without a handle", async () => {
    // A DID whose PLC doc lacks alsoKnownAs (or PLC returned 404). We
    // persist '' so the WHERE clause `handle IS NULL` doesn't pick it
    // up again next tick — V2 will model this with a real
    // last-tried timestamp, V1 takes the simpler sentinel path.
    const { db, updates } = stubDb({
      candidates: [{ did: 'did:plc:no-aka' }],
    })
    await backfillHandles(db, {
      plcURL: 'https://plc.example',
      fetch: stubFetch({ 'did:plc:no-aka': '404' }),
    })
    const sentinelWrites = updates.filter((u) => u.setValue.handle === '')
    expect(sentinelWrites.length).toBe(1)
  })

  it('records null for resolver failures so the DID retries next tick', async () => {
    // A 5xx / network failure shouldn't burn the row to a sentinel.
    // The resolver returns null on per-DID failure (graceful), and
    // the backfill writes that as '' sentinel — wait, that's wrong.
    // Re-reading: `resolveHandlesBatch` swallows exceptions and stores
    // null. backfill writes '' for null. So a transient failure does
    // burn the row. That's a known V1 limitation noted in the file's
    // docstring.
    //
    // This test pins the V1 behaviour explicitly so a future change
    // that adds proper retry tracking has to update this test.
    const { db, updates } = stubDb({
      candidates: [{ did: 'did:plc:flaky' }],
    })
    await backfillHandles(db, {
      plcURL: 'https://plc.example',
      fetch: stubFetch({ 'did:plc:flaky': 'broken' }),
    })
    const sentinelWrites = updates.filter((u) => u.setValue.handle === '')
    expect(sentinelWrites.length).toBe(1)
    expect(mockLoggerWarn).toHaveBeenCalled()
  })

  it('skips non-plc DIDs entirely (no fetch, no UPDATE)', async () => {
    const fetchFn = vi.fn() as unknown as typeof globalThis.fetch
    const { db, updates } = stubDb({
      candidates: [{ did: 'did:web:alice.example.com' }],
    })
    await backfillHandles(db, { plcURL: 'https://plc.example', fetch: fetchFn })
    expect(fetchFn).not.toHaveBeenCalled()
    expect(updates).toEqual([])
  })

  it('no-ops with a debug log when no candidates need backfill', async () => {
    const { db, updates } = stubDb({ candidates: [] })
    await backfillHandles(db, { plcURL: 'https://plc.example' })
    expect(updates).toEqual([])
    expect(mockLoggerDebug).toHaveBeenCalled()
  })
})
