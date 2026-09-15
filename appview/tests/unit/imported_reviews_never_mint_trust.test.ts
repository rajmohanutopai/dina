/**
 * D4's load-bearing line, pinned at the query boundary.
 *
 * An imported review may move a subject's RATING. It must never move a DID's
 * PeerLens score — not the subject's, not the feed publisher's. If it could,
 * importing a corpus to solve a market's cold start would mint reputation for
 * every DID in it, and the Dead Internet Filter would be defending against
 * exactly what Dina had just done to itself.
 *
 * That rule lives in two WHERE clauses inside `refresh-profiles`, which the
 * integration suite exercises end to end against a real database. These pin
 * the clauses at the unit boundary so a refactor that drops one fails here
 * rather than in a market six months later — the same stance as the
 * moderation-filter guard beside it.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('@/shared/utils/metrics.js', () => ({
  metrics: { counter: vi.fn(), incr: vi.fn() },
}))
vi.mock('@/shared/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import {
  attestations,
  didProfiles,
  subjects,
  subjectScores,
  vouches,
  endorsements,
  flags,
  reactions,
  peerlensEdges,
  revocations,
  tombstones,
  delegations,
  verifications,
} from '@/db/schema/index'
import { refreshProfiles } from '@/scorer/jobs/refresh-profiles'
import type { DrizzleDB } from '@/db/connection'

/** Column references serialize as `col:<name>` so a filter can be read as text. */
function columnsIn(filter: unknown): string {
  return JSON.stringify(filter, (_k, v) => {
    if (
      v !== null &&
      typeof v === 'object' &&
      'name' in (v as Record<string, unknown>) &&
      typeof (v as { name: unknown }).name === 'string'
    ) {
      return `col:${(v as { name: string }).name}`
    }
    return v
  })
}

/**
 * Stub every query `refreshProfiles` issues, capturing the two filters that
 * matter: the attestations-ABOUT query (does an import move this DID's
 * score?) and the attestations-BY query (does republishing a corpus make a
 * feed publisher look like a prolific reviewer?).
 */
function stubDb(): { db: DrizzleDB; filters: () => unknown[] } {
  const attestationFilters: unknown[] = []

  const rowsFor = (table: unknown): unknown[] => {
    if (table === didProfiles) return [{ did: 'did:plc:subject', overallTrustScore: 0.5 }]
    if (table === subjects) return [{ id: 'sub_x' }]
    return []
  }

  const db = {
    select: () => ({
      from: (table: unknown) => {
        const where = (filter: unknown): Promise<unknown[]> & { limit: () => Promise<unknown[]> } => {
          if (table === attestations) attestationFilters.push(filter)
          const p = Promise.resolve(rowsFor(table)) as Promise<unknown[]> & {
            limit: () => Promise<unknown[]>
            groupBy: () => Promise<unknown[]>
          }
          p.limit = () => Promise.resolve(rowsFor(table))
          p.groupBy = () => Promise.resolve([])
          return p
        }
        return {
          where,
          // A couple of the gathers await `.from()` directly or group.
          then: (resolve: (rows: unknown[]) => void) => resolve(rowsFor(table)),
        }
      },
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    selectDistinct: () => ({
      from: () => ({ where: () => ({ limit: async () => [] }) }),
    }),
  } as unknown as DrizzleDB

  // Silence the unused-import lint on the tables the job touches but this
  // stub answers generically — naming them here documents the surface.
  void [vouches, endorsements, flags, reactions, peerlensEdges, revocations, tombstones, delegations, verifications, subjectScores]

  return { db, filters: () => attestationFilters }
}

describe('an imported review never mints trust', () => {
  it('is excluded from the attestations that move a DID’s PeerLens score', async () => {
    const { db, filters } = stubDb()
    await refreshProfiles(db)
    const about = filters().map(columnsIn).filter((f) => f.includes('col:subject_id'))
    expect(about.length).toBeGreaterThanOrEqual(1)
    for (const filter of about) {
      // The rule: testimony only. Without `source_feed IS NULL` here,
      // importing a corpus would raise the score of every DID it mentions.
      expect(filter).toContain('col:source_feed')
      expect(filter).toContain('col:is_revoked')
    }
  })

  it('is excluded from the volume that makes a publisher look like a reviewer', async () => {
    const { db, filters } = stubDb()
    await refreshProfiles(db)
    const by = filters().map(columnsIn).filter((f) => f.includes('col:author_did'))
    expect(by.length).toBeGreaterThanOrEqual(1)
    for (const filter of by) {
      // A feed republishing ten thousand reviews is not ten thousand times a
      // reviewer, and `totalAttestationsBy` feeds the reviewer component.
      expect(filter).toContain('col:source_feed')
    }
  })
})
