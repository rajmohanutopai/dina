/**
 * Unit tests for the TN-API-003 / Plan §6.3 fields on
 * `appview/src/api/xrpc/resolve.ts`.
 *
 * Contract:
 *   - Response carries `subjectId`, `reviewCount`, `lastAttestedAt`
 *   - When parse fails: subjectId=null, reviewCount=0, lastAttestedAt=null
 *   - When subject not in index: subjectId=null, reviewCount=0,
 *     lastAttestedAt=null
 *   - When subject exists but scores haven't been computed:
 *     subjectId=<id>, reviewCount=0, lastAttestedAt=null
 *   - When subject + scores exist: numeric reviewCount, ISO datetime
 *   - `conflicts` is omitted in V1 (Plan §13.10 — same-as merges
 *     deferred)
 */

import { describe, expect, it, vi } from 'vitest'

const resolveSubjectMock = vi.fn()
const computeGraphContextMock = vi.fn()
const computeRecommendationMock = vi.fn().mockReturnValue({
  trustLevel: 'unknown',
  confidence: 0,
  action: 'proceed',
  reasoning: 'no signal',
})

vi.mock('@/db/queries/subjects.js', () => ({
  resolveSubject: (...a: unknown[]) => resolveSubjectMock(...a),
}))
vi.mock('@/db/queries/graph.js', () => ({
  computeGraphContext: (...a: unknown[]) => computeGraphContextMock(...a),
}))
vi.mock('@/scorer/algorithms/recommendation.js', () => ({
  computeRecommendation: (...a: unknown[]) => computeRecommendationMock(...a),
}))
// Bypass the SWR cache so each test sees a fresh resolve call.
vi.mock('../../src/api/middleware/swr-cache.js', () => ({
  withSWR: async (_key: string, _ttl: number, fn: () => Promise<unknown>) => fn(),
  resolveKey: () => 'cache-key',
  CACHE_TTLS: { RESOLVE: 60_000 },
}))

import { resolve } from '@/api/xrpc/resolve'
import { subjectScores, didProfiles, flags } from '@/db/schema/index'
import type { DrizzleDB } from '@/db/connection'

interface ScoreRow {
  totalAttestations: number | null
  positive: number | null
  neutral: number | null
  negative: number | null
  weightedScore: number | null
  confidence: number | null
  dimensionSummaryJson: unknown
  authenticityConsensus: string | null
  authenticityConfidence: number | null
  lastAttestationAt: Date | null
}

/**
 * DB stub for the three table-keyed queries the handler issues:
 *   - subjectScores (scores lookup)
 *   - didProfiles (DID profile for did-typed subjects)
 *   - flags (active flags)
 *
 * Routes by table identity from the schema imports.
 */
function stubDb(opts: {
  scores?: ScoreRow | null
  profile?: unknown
  flagRows?: unknown[]
}): DrizzleDB {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () =>
            table === subjectScores
              ? opts.scores !== undefined && opts.scores !== null
                ? [opts.scores]
                : []
              : table === didProfiles
                ? opts.profile !== undefined && opts.profile !== null
                  ? [opts.profile]
                  : []
                : table === flags
                  ? (opts.flagRows ?? [])
                  : [],
        }),
      }),
    }),
  } as unknown as DrizzleDB
}

describe('resolve — TN-API-003 / Plan §6.3 fields', () => {
  it('parse-failure → subjectId=null, reviewCount=0, lastAttestedAt=null', async () => {
    const db = stubDb({})
    const r = await resolve(db, { subject: 'not-json' })
    expect(r.subjectId).toBeNull()
    expect(r.reviewCount).toBe(0)
    expect(r.lastAttestedAt).toBeNull()
    // Legacy field also stays consistent
    expect(r.recommendation).toBe('error')
    expect(r.conflicts).toBeUndefined()
  })

  it('subject not in index → subjectId=null, reviewCount=0, lastAttestedAt=null', async () => {
    resolveSubjectMock.mockResolvedValueOnce(null) // not found
    const db = stubDb({})
    const r = await resolve(db, {
      subject: '{"type":"product","name":"NotInIndex"}',
    })
    expect(r.subjectId).toBeNull()
    expect(r.reviewCount).toBe(0)
    expect(r.lastAttestedAt).toBeNull()
  })

  it('subject exists but scores row absent → reviewCount=0, lastAttestedAt=null', async () => {
    // The scorer hasn't ticked since the first attestation landed,
    // so subject_scores row doesn't exist yet. Plan §6.3 wants a
    // valid response anyway.
    resolveSubjectMock.mockResolvedValueOnce('sub_abc123')
    const db = stubDb({ scores: null })
    const r = await resolve(db, {
      subject: '{"type":"product","name":"Just Created"}',
    })
    expect(r.subjectId).toBe('sub_abc123')
    expect(r.reviewCount).toBe(0)
    expect(r.lastAttestedAt).toBeNull()
  })

  it('subject + scores exist → reviewCount + lastAttestedAt populated', async () => {
    resolveSubjectMock.mockResolvedValueOnce('sub_abc123')
    const lastDate = new Date('2026-04-29T12:34:56Z')
    const db = stubDb({
      scores: {
        totalAttestations: 42,
        positive: 30,
        neutral: 10,
        negative: 2,
        weightedScore: 0.75,
        confidence: 0.8,
        dimensionSummaryJson: null,
        authenticityConsensus: null,
        authenticityConfidence: null,
        lastAttestationAt: lastDate,
      },
    })
    const r = await resolve(db, {
      subject: '{"type":"product","name":"Aeron Chair"}',
    })
    expect(r.subjectId).toBe('sub_abc123')
    expect(r.reviewCount).toBe(42)
    expect(r.lastAttestedAt).toBe('2026-04-29T12:34:56.000Z')
  })

  it('lastAttestationAt null on score row → lastAttestedAt null', async () => {
    // Edge case: scores row exists (e.g. needsRecalc=true upserted
    // by dirty-flags) but no attestations have actually landed yet,
    // so lastAttestationAt is NULL.
    resolveSubjectMock.mockResolvedValueOnce('sub_abc')
    const db = stubDb({
      scores: {
        totalAttestations: 0,
        positive: 0,
        neutral: 0,
        negative: 0,
        weightedScore: null,
        confidence: null,
        dimensionSummaryJson: null,
        authenticityConsensus: null,
        authenticityConfidence: null,
        lastAttestationAt: null,
      },
    })
    const r = await resolve(db, { subject: '{"type":"product","name":"X"}' })
    expect(r.lastAttestedAt).toBeNull()
  })

  it('legacy fields still populated alongside new ones', async () => {
    // Defensive: don't break existing transaction / interaction
    // / content-verification callers that read `recommendation`,
    // `trustLevel`, etc.
    resolveSubjectMock.mockResolvedValueOnce('sub_x')
    const db = stubDb({
      scores: {
        totalAttestations: 5,
        positive: 3,
        neutral: 1,
        negative: 1,
        weightedScore: 0.5,
        confidence: 0.4,
        dimensionSummaryJson: { quality: 0.8 },
        authenticityConsensus: 'genuine',
        authenticityConfidence: 0.9,
        lastAttestationAt: new Date('2026-04-29T00:00:00Z'),
      },
    })
    const r = await resolve(db, { subject: '{"type":"product","name":"X"}' })
    // New fields:
    expect(r.subjectId).toBe('sub_x')
    expect(r.reviewCount).toBe(5)
    expect(r.lastAttestedAt).toBe('2026-04-29T00:00:00.000Z')
    // Legacy fields still computed:
    expect(r.subjectType).toBe('product')
    expect(r.attestationSummary).toEqual({
      total: 5,
      positive: 3,
      neutral: 1,
      negative: 1,
      averageDimensions: { quality: 0.8 },
    })
    expect(r.authenticity).toEqual({
      predominantAssessment: 'genuine',
      confidence: 0.9,
    })
  })

  it('conflicts omitted (V1 — Plan §13.10 same-as deferred)', async () => {
    resolveSubjectMock.mockResolvedValueOnce('sub_x')
    const db = stubDb({ scores: null })
    const r = await resolve(db, { subject: '{"type":"product","name":"X"}' })
    expect('conflicts' in r).toBe(false) // strictly absent, not just undefined
  })
})
