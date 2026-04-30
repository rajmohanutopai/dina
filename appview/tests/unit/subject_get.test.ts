/**
 * Unit tests for `appview/src/api/xrpc/subject-get.ts`
 * (TN-API-002 / Plan §6.2).
 *
 * Contract:
 *   - Schema: subjectId required, viewerDid required + DID regex
 *   - Subject not found → null subject + empty reviewer groups
 *   - Reviewer categorisation: depth=1 → contacts, depth=2 → extended,
 *     depth=3+ / unknown → strangers
 *   - Viewer's own attestations excluded from any group
 *   - Revoked attestations excluded by the SQL WHERE clause
 *   - Each group sorted by trust score desc, createdAt desc tiebreak,
 *     NULL scores last
 *   - Each group capped at 100 entries
 *   - band derived from score via 0.8/0.5/0.3 thresholds
 */

import { describe, expect, it, vi } from 'vitest'

const computeGraphContextMock = vi.fn()

vi.mock('@/db/queries/graph.js', () => ({
  computeGraphContext: (...args: unknown[]) => computeGraphContextMock(...args),
}))

import { subjectGet, SubjectGetParams } from '@/api/xrpc/subject-get'
import {
  attestations,
  didProfiles,
  subjects,
  subjectScores,
} from '@/db/schema/index'
import type { DrizzleDB } from '@/db/connection'

interface SubjectRow {
  id: string
  name: string
  subjectType: string
  did: string | null
  identifiersJson: unknown
}

interface ScoreRow {
  weightedScore: number | null
  totalAttestations: number | null
}

interface AttRow {
  uri: string
  text: string | null
  sentiment: string
  recordCreatedAt: Date
  authorDid: string
}

interface ProfileRow {
  did: string
  overallTrustScore: number | null
}

/**
 * Stub the four query shapes the handler issues, routed by table
 * identity:
 *   - select(subjects).where(eq(id, ...)).limit(1)         → subjectRow
 *   - select(subjectScores).where(eq(subjectId, ...)).limit(1) → scoreRow
 *   - select(attestations).where(...).orderBy(...).limit(...)   → attRows
 *   - select(didProfiles).where(inArray(did, [...]))           → profileRows
 */
function stubDb(opts: {
  subject?: SubjectRow | null
  score?: ScoreRow | null
  attRows?: AttRow[]
  profileRows?: ProfileRow[]
}): DrizzleDB {
  return {
    select: (_sel?: unknown) => ({
      from: (table: unknown) => {
        if (table === subjects) {
          return {
            where: () => ({
              limit: async () =>
                opts.subject ? [opts.subject] : [],
            }),
          }
        }
        if (table === subjectScores) {
          return {
            where: () => ({
              limit: async () => (opts.score ? [opts.score] : []),
            }),
          }
        }
        if (table === attestations) {
          return {
            where: () => ({
              orderBy: () => ({
                limit: async () => opts.attRows ?? [],
              }),
            }),
          }
        }
        if (table === didProfiles) {
          // didProfiles query: select.from.where (no orderBy/limit)
          return {
            where: async () => opts.profileRows ?? [],
          }
        }
        throw new Error(`stubDb: unexpected table ${String(table)}`)
      },
    }),
  } as unknown as DrizzleDB
}

function subjectRow(): SubjectRow {
  return {
    id: 'sub_x',
    name: 'Aeron Chair',
    subjectType: 'product',
    did: null,
    identifiersJson: [],
  }
}

function attRow(overrides: Partial<AttRow> = {}): AttRow {
  return {
    uri: 'at://did:plc:r1/com.dina.trust.attestation/A',
    text: 'Solid build — comfortable for long sessions.',
    sentiment: 'positive',
    recordCreatedAt: new Date('2026-04-29T10:00:00Z'),
    authorDid: 'did:plc:r1',
    ...overrides,
  }
}

describe('SubjectGetParams — TN-API-002 schema', () => {
  it('accepts subjectId + viewerDid', () => {
    const r = SubjectGetParams.safeParse({
      subjectId: 'sub_x',
      viewerDid: 'did:plc:viewer',
    })
    expect(r.success).toBe(true)
  })

  it('rejects missing subjectId', () => {
    const r = SubjectGetParams.safeParse({ viewerDid: 'did:plc:v' })
    expect(r.success).toBe(false)
  })

  it('rejects missing viewerDid', () => {
    const r = SubjectGetParams.safeParse({ subjectId: 'sub_x' })
    expect(r.success).toBe(false)
  })

  it('rejects non-DID viewerDid', () => {
    const r = SubjectGetParams.safeParse({
      subjectId: 'sub_x',
      viewerDid: 'plc:abc',
    })
    expect(r.success).toBe(false)
  })
})

describe('subjectGet handler — TN-API-002', () => {
  it('subject not found → null subject + empty groups', async () => {
    const db = stubDb({ subject: null })
    // Even when subject is null, computeGraphContext might still be
    // called via the parallel select (Phase 1 runs both subject + score
    // lookups concurrently). The handler short-circuits AFTER both
    // resolve, so graph isn't needed for this path.
    const r = await subjectGet(db, {
      subjectId: 'missing',
      viewerDid: 'did:plc:v',
    })
    expect(r.subject).toBeNull()
    expect(r.score).toBeNull()
    expect(r.band).toBe('unrated')
    expect(r.reviewCount).toBe(0)
    expect(r.reviewers).toEqual({
      contacts: [],
      extended: [],
      strangers: [],
    })
  })

  it('subject + no attestations → empty groups', async () => {
    const db = stubDb({ subject: subjectRow(), score: null, attRows: [] })
    const r = await subjectGet(db, {
      subjectId: 'sub_x',
      viewerDid: 'did:plc:v',
    })
    expect(r.subject?.type).toBe('product')
    expect(r.subject?.name).toBe('Aeron Chair')
    expect(r.reviewers).toEqual({
      contacts: [],
      extended: [],
      strangers: [],
    })
  })

  it('categorises reviewers by graph depth (1 → contacts, 2 → extended, 3+ → strangers)', async () => {
    computeGraphContextMock.mockResolvedValueOnce({
      nodes: [
        { did: 'did:plc:v', trustScore: null, depth: 0 },
        { did: 'did:plc:r1', trustScore: 0.9, depth: 1 },
        { did: 'did:plc:r2', trustScore: 0.7, depth: 2 },
      ],
      edges: [],
      rootDid: 'did:plc:v',
      depth: 2,
    })
    const db = stubDb({
      subject: subjectRow(),
      score: { weightedScore: 0.8, totalAttestations: 3 },
      attRows: [
        attRow({ authorDid: 'did:plc:r1', uri: 'at://r1/A' }),
        attRow({ authorDid: 'did:plc:r2', uri: 'at://r2/A' }),
        attRow({ authorDid: 'did:plc:stranger', uri: 'at://s/A' }),
      ],
      profileRows: [
        { did: 'did:plc:r1', overallTrustScore: 0.9 },
        { did: 'did:plc:r2', overallTrustScore: 0.7 },
        { did: 'did:plc:stranger', overallTrustScore: 0.5 },
      ],
    })
    const r = await subjectGet(db, {
      subjectId: 'sub_x',
      viewerDid: 'did:plc:v',
    })
    expect(r.reviewers.contacts.map((e) => e.did)).toEqual(['did:plc:r1'])
    expect(r.reviewers.extended.map((e) => e.did)).toEqual(['did:plc:r2'])
    expect(r.reviewers.strangers.map((e) => e.did)).toEqual([
      'did:plc:stranger',
    ])
  })

  it('excludes the viewer from any group (defensive)', async () => {
    // Edge case: a viewer attesting their own subject. The viewer's
    // own attestation must NOT appear in any reviewer band; that'd
    // be confusing (the viewer doesn't review themselves).
    computeGraphContextMock.mockResolvedValueOnce({
      nodes: [{ did: 'did:plc:v', trustScore: 0.5, depth: 0 }],
      edges: [],
      rootDid: 'did:plc:v',
      depth: 0,
    })
    const db = stubDb({
      subject: subjectRow(),
      score: { weightedScore: 0.5, totalAttestations: 1 },
      attRows: [attRow({ authorDid: 'did:plc:v', uri: 'at://v/A' })],
      profileRows: [{ did: 'did:plc:v', overallTrustScore: 0.5 }],
    })
    const r = await subjectGet(db, {
      subjectId: 'sub_x',
      viewerDid: 'did:plc:v',
    })
    expect(r.reviewers.contacts).toEqual([])
    expect(r.reviewers.extended).toEqual([])
    expect(r.reviewers.strangers).toEqual([])
  })

  it('sorts each group by trust score desc, NULL last, createdAt as tiebreak', async () => {
    computeGraphContextMock.mockResolvedValueOnce({
      nodes: [],
      edges: [],
      rootDid: 'did:plc:v',
      depth: 2,
    })
    // All three are strangers (no graph entries). Scores: 0.9, null, 0.5.
    // Tiebreak via createdAt: same-score reviewers ordered most-recent-first.
    const db = stubDb({
      subject: subjectRow(),
      score: { weightedScore: 0.8, totalAttestations: 4 },
      attRows: [
        attRow({
          authorDid: 'did:plc:a',
          uri: 'at://a/1',
          recordCreatedAt: new Date('2026-04-28T00:00:00Z'),
        }),
        attRow({
          authorDid: 'did:plc:b',
          uri: 'at://b/1',
          recordCreatedAt: new Date('2026-04-29T00:00:00Z'),
        }),
        attRow({
          authorDid: 'did:plc:c',
          uri: 'at://c/1',
          recordCreatedAt: new Date('2026-04-30T00:00:00Z'),
        }),
        attRow({
          authorDid: 'did:plc:d',
          uri: 'at://d/1',
          recordCreatedAt: new Date('2026-04-27T00:00:00Z'),
        }),
      ],
      profileRows: [
        { did: 'did:plc:a', overallTrustScore: 0.5 },
        { did: 'did:plc:b', overallTrustScore: 0.5 },
        { did: 'did:plc:c', overallTrustScore: 0.9 },
        { did: 'did:plc:d', overallTrustScore: null },
      ],
    })
    const r = await subjectGet(db, {
      subjectId: 'sub_x',
      viewerDid: 'did:plc:v',
    })
    // Order should be: c (0.9), b (0.5, more recent than a), a (0.5), d (null)
    expect(r.reviewers.strangers.map((e) => e.did)).toEqual([
      'did:plc:c',
      'did:plc:b',
      'did:plc:a',
      'did:plc:d',
    ])
  })

  it('caps each group at 100 entries', async () => {
    computeGraphContextMock.mockResolvedValueOnce({
      nodes: [],
      edges: [],
      rootDid: 'did:plc:v',
      depth: 2,
    })
    // 150 strangers — group must trim to 100.
    const attRows: AttRow[] = []
    const profileRows: ProfileRow[] = []
    for (let i = 0; i < 150; i++) {
      attRows.push(
        attRow({
          authorDid: `did:plc:stranger-${i}`,
          uri: `at://s/${i}`,
        }),
      )
      profileRows.push({
        did: `did:plc:stranger-${i}`,
        overallTrustScore: 0.5,
      })
    }
    const db = stubDb({
      subject: subjectRow(),
      score: { weightedScore: 0.7, totalAttestations: 150 },
      attRows,
      profileRows,
    })
    const r = await subjectGet(db, {
      subjectId: 'sub_x',
      viewerDid: 'did:plc:v',
    })
    expect(r.reviewers.strangers).toHaveLength(100)
  })

  it('band reflects 0.8/0.5/0.3 thresholds (high/moderate/low/very-low/unrated)', async () => {
    // Drive band classification from the score directly. Empty
    // attestations to keep the test focused on the score → band mapping.
    computeGraphContextMock.mockResolvedValue({
      nodes: [],
      edges: [],
      rootDid: 'did:plc:v',
      depth: 2,
    })

    const cases: Array<{ score: number | null; expected: string }> = [
      { score: 0.9, expected: 'high' },
      { score: 0.8, expected: 'high' }, // boundary
      { score: 0.79, expected: 'moderate' },
      { score: 0.5, expected: 'moderate' }, // boundary
      { score: 0.49, expected: 'low' },
      { score: 0.3, expected: 'low' }, // boundary
      { score: 0.29, expected: 'very-low' },
      { score: null, expected: 'unrated' },
    ]
    for (const { score, expected } of cases) {
      const db = stubDb({
        subject: subjectRow(),
        score: { weightedScore: score, totalAttestations: 0 },
        attRows: [],
      })
      const r = await subjectGet(db, {
        subjectId: 'sub_x',
        viewerDid: 'did:plc:v',
      })
      expect(r.band).toBe(expected)
      expect(r.score).toBe(score)
    }
  })

  it('reviewer trustBand mirrors author score band classification', async () => {
    computeGraphContextMock.mockResolvedValueOnce({
      nodes: [{ did: 'did:plc:r1', trustScore: 0.9, depth: 1 }],
      edges: [],
      rootDid: 'did:plc:v',
      depth: 1,
    })
    const db = stubDb({
      subject: subjectRow(),
      score: { weightedScore: 0.8, totalAttestations: 1 },
      attRows: [attRow({ authorDid: 'did:plc:r1' })],
      profileRows: [{ did: 'did:plc:r1', overallTrustScore: 0.9 }],
    })
    const r = await subjectGet(db, {
      subjectId: 'sub_x',
      viewerDid: 'did:plc:v',
    })
    expect(r.reviewers.contacts[0].trustBand).toBe('high')
  })

  it('reviewer with NULL profile score → trustBand = unrated', async () => {
    computeGraphContextMock.mockResolvedValueOnce({
      nodes: [{ did: 'did:plc:r1', trustScore: null, depth: 1 }],
      edges: [],
      rootDid: 'did:plc:v',
      depth: 1,
    })
    const db = stubDb({
      subject: subjectRow(),
      score: { weightedScore: 0.7, totalAttestations: 1 },
      attRows: [attRow({ authorDid: 'did:plc:r1' })],
      profileRows: [], // no profile row → score map miss
    })
    const r = await subjectGet(db, {
      subjectId: 'sub_x',
      viewerDid: 'did:plc:v',
    })
    expect(r.reviewers.contacts[0].trustScore).toBeNull()
    expect(r.reviewers.contacts[0].trustBand).toBe('unrated')
  })

  it('attestation timestamps serialised to ISO strings', async () => {
    computeGraphContextMock.mockResolvedValueOnce({
      nodes: [{ did: 'did:plc:r1', trustScore: 0.9, depth: 1 }],
      edges: [],
      rootDid: 'did:plc:v',
      depth: 1,
    })
    const db = stubDb({
      subject: subjectRow(),
      score: { weightedScore: 0.7, totalAttestations: 1 },
      attRows: [
        attRow({
          authorDid: 'did:plc:r1',
          recordCreatedAt: new Date('2026-04-29T12:34:56Z'),
        }),
      ],
      profileRows: [{ did: 'did:plc:r1', overallTrustScore: 0.9 }],
    })
    const r = await subjectGet(db, {
      subjectId: 'sub_x',
      viewerDid: 'did:plc:v',
    })
    expect(r.reviewers.contacts[0].attestation.createdAt).toBe(
      '2026-04-29T12:34:56.000Z',
    )
  })
})
