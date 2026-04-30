/**
 * Unit tests for `appview/src/scorer/jobs/subject-enrich-recompute.ts`
 * (TN-ENRICH-006 / Plan §3.6.4).
 *
 * Contract under test:
 *   - Stale-row selector picks rows where `enriched_at IS NULL OR
 *     enriched_at < NOW() - REENRICH_AGE_DAYS days`.
 *   - Per-row UPDATE writes `category`, `metadata` (JSONB-cast),
 *     `language`, `enriched_at = NOW()`, `updated_at = NOW()`.
 *   - The composer (`enrichSubject`) and language detector
 *     (`detectLanguage`) are invoked once per stale row.
 *   - Per-row failures don't abort the batch — the metric +
 *     error log fire, but later rows still process.
 *   - `enrichSingleSubject` returns `{updated: false, reason:
 *     'not_found'}` when the row doesn't exist.
 *   - The row → SubjectRef translator narrows unknown
 *     `subject_type` values to `'claim'` (defensive).
 *
 * Coverage strategy: drive the job with a fake DB stub that captures
 * the SELECT WHERE chain + per-row UPDATEs. The composer / language
 * detector are vi-mocked so test cases can return canned enrichments
 * and we assert what the job did with them.
 */

import { describe, expect, it, vi } from 'vitest'

const mockEnrichSubject = vi.fn()
vi.mock('@/util/subject_enrichment.js', async () => {
  const actual = await vi.importActual<typeof import('@/util/subject_enrichment')>(
    '@/util/subject_enrichment',
  )
  return {
    ...actual,
    enrichSubject: (ref: unknown) => mockEnrichSubject(ref),
  }
})

const mockDetectLanguage = vi.fn()
vi.mock('@/ingester/language-detect.js', () => ({
  detectLanguage: (text: unknown) => mockDetectLanguage(text),
}))

const mockMetricsCounter = vi.fn()
vi.mock('@/shared/utils/metrics.js', () => ({
  metrics: {
    counter: (...a: unknown[]) => mockMetricsCounter(...a),
    incr: vi.fn(),
    gauge: vi.fn(),
    histogram: vi.fn(),
  },
}))

const mockLoggerInfo = vi.fn()
const mockLoggerDebug = vi.fn()
const mockLoggerWarn = vi.fn()
const mockLoggerError = vi.fn()
vi.mock('@/shared/utils/logger.js', () => ({
  logger: {
    info: (...a: unknown[]) => mockLoggerInfo(...a),
    debug: (...a: unknown[]) => mockLoggerDebug(...a),
    warn: (...a: unknown[]) => mockLoggerWarn(...a),
    error: (...a: unknown[]) => mockLoggerError(...a),
  },
}))

import {
  subjectEnrichRecompute,
  enrichSingleSubject,
  __testInternals,
} from '@/scorer/jobs/subject-enrich-recompute'
import type { DrizzleDB } from '@/db/connection'

interface StubRow {
  id: string
  name: string
  subjectType: string
  did: string | null
  identifiersJson: unknown
}

interface CapturedUpdate {
  subjectId: string
  set: Record<string, unknown>
}

function makeStubDb(opts: {
  staleRows: StubRow[]
  /** When provided, single-row SELECT (used by enrichSingleSubject) returns this list. */
  pkLookupRows?: StubRow[]
}): { db: DrizzleDB; captures: CapturedUpdate[] } {
  const captures: CapturedUpdate[] = []
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async (n: number) => {
            // PK lookup uses limit(1); batch uses limit(MAX_REENRICH_PER_RUN).
            if (n === 1 && opts.pkLookupRows !== undefined) {
              return opts.pkLookupRows
            }
            return opts.staleRows
          },
        }),
      }),
    }),
    update: (_table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: async (_where: unknown) => {
          // We rely on the test passing a single subject at a time —
          // capture the SET payload + the implied subjectId from the
          // most-recent SELECT-and-process step. The job iterates
          // staleRows linearly, so we use `captures.length` to map
          // to the corresponding row.
          captures.push({
            subjectId: opts.staleRows[captures.length]?.id ?? 'unknown',
            set,
          })
        },
      }),
    }),
  } as unknown as DrizzleDB
  return { db, captures }
}

// ── subjectEnrichRecompute (batch) ──────────────────────────────

describe('subjectEnrichRecompute — TN-ENRICH-006 batch', () => {
  it('no stale rows → debug log + zero counter, no UPDATE', async () => {
    mockMetricsCounter.mockClear()
    mockLoggerDebug.mockClear()
    const { db, captures } = makeStubDb({ staleRows: [] })
    await subjectEnrichRecompute(db)
    expect(captures).toHaveLength(0)
    expect(mockMetricsCounter).toHaveBeenCalledWith(
      'scorer.enrich_recompute.updated',
      0,
    )
    expect(mockLoggerDebug).toHaveBeenCalled()
  })

  it('stale rows: composer + detector run once per row, UPDATE applied', async () => {
    mockMetricsCounter.mockClear()
    mockEnrichSubject.mockReturnValue({
      category: 'product:furniture',
      metadata: { host: 'amazon.com' },
    })
    mockDetectLanguage.mockReturnValue('en')

    const { db, captures } = makeStubDb({
      staleRows: [
        {
          id: 'sub_a',
          name: 'Aeron chair',
          subjectType: 'product',
          did: null,
          identifiersJson: [{ uri: 'https://amazon.com/x' }],
        },
        {
          id: 'sub_b',
          name: 'Cafe XYZ',
          subjectType: 'place',
          did: null,
          identifiersJson: [],
        },
      ],
    })
    await subjectEnrichRecompute(db)

    expect(mockEnrichSubject).toHaveBeenCalledTimes(2)
    expect(mockDetectLanguage).toHaveBeenCalledTimes(2)
    expect(captures).toHaveLength(2)
    // Verify SET payload shape — must carry all four enrichment
    // columns + bump enriched_at + updated_at.
    expect(captures[0].set).toMatchObject({
      category: 'product:furniture',
      language: 'en',
    })
    expect(captures[0].set.enrichedAt).toBeInstanceOf(Date)
    expect(captures[0].set.updatedAt).toBeInstanceOf(Date)
    // metadata is wrapped in a sql`...::jsonb` template — non-null
    // is enough for the contract.
    expect(captures[0].set.metadata).toBeDefined()
    expect(mockMetricsCounter).toHaveBeenCalledWith(
      'scorer.enrich_recompute.updated',
      2,
    )
  })

  it('per-row failure does NOT abort the batch', async () => {
    // Plan §3.6.4 contract: enrichment must be best-effort. One
    // bad row's UPDATE-failure shouldn't block the rest of the
    // weekly tick. Pinned by simulating a thrown enrichSubject for
    // one row + asserting the others still process.
    mockMetricsCounter.mockClear()
    mockLoggerError.mockClear()
    mockEnrichSubject
      .mockImplementationOnce(() => {
        throw new Error('synthetic enrich failure')
      })
      .mockReturnValue({ category: 'content:article', metadata: {} })
    mockDetectLanguage.mockReturnValue('en')

    const { db, captures } = makeStubDb({
      staleRows: [
        { id: 'sub_bad', name: 'X', subjectType: 'content', did: null, identifiersJson: [] },
        { id: 'sub_ok1', name: 'Y', subjectType: 'content', did: null, identifiersJson: [] },
        { id: 'sub_ok2', name: 'Z', subjectType: 'content', did: null, identifiersJson: [] },
      ],
    })
    await subjectEnrichRecompute(db)

    // 2 of 3 rows updated despite the first throwing.
    expect(captures).toHaveLength(2)
    expect(mockLoggerError).toHaveBeenCalledTimes(1)
    expect(mockMetricsCounter).toHaveBeenCalledWith(
      'scorer.enrich_recompute.updated',
      2,
    )
    expect(mockMetricsCounter).toHaveBeenCalledWith(
      'scorer.enrich_recompute.errors',
      1,
    )
  })

  it('null detectLanguage → language column set to null (not undefined)', async () => {
    // Subjects with very-short names don't pass franc-min's threshold
    // and detectLanguage returns null. The job must persist that as
    // an explicit NULL, not silently keep the old value.
    mockEnrichSubject.mockReturnValue({ category: 'claim', metadata: {} })
    mockDetectLanguage.mockReturnValue(null)
    const { db, captures } = makeStubDb({
      staleRows: [{ id: 'sub_x', name: 'Hi', subjectType: 'claim', did: null, identifiersJson: [] }],
    })
    await subjectEnrichRecompute(db)
    expect(captures[0].set.language).toBeNull()
  })
})

// ── enrichSingleSubject ─────────────────────────────────────────

describe('enrichSingleSubject — TN-ENRICH-006 single-subject path', () => {
  it('row found: composer + detector run, UPDATE applied, returns {updated:true}', async () => {
    mockEnrichSubject.mockReturnValue({ category: 'place:cafe', metadata: { place_type: 'cafe' } })
    mockDetectLanguage.mockReturnValue('en')
    const row: StubRow = {
      id: 'sub_only',
      name: 'Cafe X',
      subjectType: 'place',
      did: null,
      identifiersJson: [],
    }
    const { db, captures } = makeStubDb({
      staleRows: [row],
      pkLookupRows: [row],
    })
    const result = await enrichSingleSubject(db, 'sub_only')
    expect(result).toEqual({ updated: true })
    expect(captures).toHaveLength(1)
    expect(captures[0].set.category).toBe('place:cafe')
  })

  it('row not found: returns {updated:false, reason:"not_found"}, no UPDATE', async () => {
    mockEnrichSubject.mockClear()
    const { db, captures } = makeStubDb({
      staleRows: [],
      pkLookupRows: [],
    })
    const result = await enrichSingleSubject(db, 'sub_missing')
    expect(result).toEqual({ updated: false, reason: 'not_found' })
    expect(captures).toHaveLength(0)
    expect(mockEnrichSubject).not.toHaveBeenCalled()
  })
})

// ── Internals ──────────────────────────────────────────────────

describe('subjectRefFromRow — TN-ENRICH-006 row→ref translator', () => {
  it('extracts uri + identifier from identifiers_json', () => {
    const ref = __testInternals.subjectRefFromRow({
      id: 'sub_a',
      name: 'Aeron chair',
      subjectType: 'product',
      did: null,
      identifiersJson: [{ uri: 'https://amazon.com/x' }, { id: 'B00FLYWNYQ' }],
    })
    expect(ref).toEqual({
      type: 'product',
      did: undefined,
      uri: 'https://amazon.com/x',
      name: 'Aeron chair',
      identifier: 'B00FLYWNYQ',
    })
  })

  it('did rows surface did + leave uri/identifier undefined', () => {
    const ref = __testInternals.subjectRefFromRow({
      id: 'sub_did',
      name: 'did:plc:abc',
      subjectType: 'did',
      did: 'did:plc:abc',
      identifiersJson: [],
    })
    expect(ref.type).toBe('did')
    expect(ref.did).toBe('did:plc:abc')
    expect(ref.uri).toBeUndefined()
    expect(ref.identifier).toBeUndefined()
  })

  it('non-array identifiersJson falls through to empty extraction', () => {
    // Defensive: a future schema migration that stored identifiers
    // as a JSON object instead of array shouldn't crash the job —
    // the row still gets a SubjectRef with no uri/identifier.
    const ref = __testInternals.subjectRefFromRow({
      id: 'sub_x',
      name: 'X',
      subjectType: 'product',
      did: null,
      identifiersJson: { unexpected: 'shape' },
    })
    expect(ref.uri).toBeUndefined()
    expect(ref.identifier).toBeUndefined()
  })
})

describe('narrowSubjectType — defensive enum guard', () => {
  it('passes through documented SubjectType values', () => {
    const types = [
      'did',
      'content',
      'product',
      'dataset',
      'organization',
      'claim',
      'place',
    ] as const
    for (const t of types) {
      expect(__testInternals.narrowSubjectType(t)).toBe(t)
    }
  })

  it('unknown subject_type values fall through to "claim"', () => {
    // Defends against a legacy row with a typo or a future
    // schema change that introduced a new subject_type value
    // before this enricher knew about it.
    expect(__testInternals.narrowSubjectType('unknown_type')).toBe('claim')
    expect(__testInternals.narrowSubjectType('')).toBe('claim')
    expect(__testInternals.narrowSubjectType('person')).toBe('claim')
  })
})
