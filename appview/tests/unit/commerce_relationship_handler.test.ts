/**
 * The relationship-claim handler (§10.7).
 *
 * The projection rules are tested purely elsewhere. What is left here is the
 * part a pure function cannot express: that a claim is STORED and the subject's
 * edges are then DERIVED from every stored claim — which is what makes a
 * withdrawal able to un-dispute an edge, and what makes `first_party` a fact
 * about the publishing repo rather than a self-declared trust level.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  commerceProductRelationships,
  commerceRelationshipClaims,
} from '@/db/schema/index.js'
import { commerceRelationshipClaimHandler } from '@/ingester/handlers/commerce-relationship.js'
import { productKey } from '@/shared/commerce/catalog-projection.js'

import type { HandlerContext, RecordOp } from '@/ingester/handlers/index.js'

const MAKER = 'did:plc:chairmaker99'
const RIVAL = 'did:plc:rivalchairs01'
const CHAIR_1 = { scheme: 'gtin' as const, value: '05012345678900' }
const CHAIR_2 = { scheme: 'gtin' as const, value: '05012345678917' }
const CHAIR_3 = { scheme: 'gtin' as const, value: '05012345678924' }

interface Recorded {
  events: string[]
  inserted: Record<string, unknown[]>
}

function tableName(table: unknown): string {
  if (table === commerceRelationshipClaims) return 'claims'
  if (table === commerceProductRelationships) return 'edges'
  return 'unknown'
}

function stubCtx(recorded: Recorded, selects: unknown[][]): HandlerContext {
  const queue = [...selects]
  const handle = (prefix: string): Record<string, unknown> => ({
    select: () => ({
      from: (table: unknown) => {
        const consume = async (): Promise<unknown[]> => {
          recorded.events.push(`${prefix}select:${tableName(table)}`)
          return queue.shift() ?? []
        }
        // `.where()` is awaited directly on the rebuild path and `.limit()`ed
        // on the delete path. ONE consumption either way: a first version
        // called `consume()` to build the promise and again for `.limit()`,
        // which ate two queue entries per query and made the delete path look
        // like it selected twice.
        return {
          where: () => {
            const pending = consume()
            return Object.assign(pending, { limit: () => pending })
          },
        }
      },
    }),
    insert: (table: unknown) => ({
      values: (v: unknown) => {
        const name = tableName(table)
        recorded.events.push(`${prefix}insert:${name}`)
        recorded.inserted[name] = (recorded.inserted[name] ?? []).concat(
          Array.isArray(v) ? v : [v],
        )
        return Object.assign(Promise.resolve(), {
          onConflictDoUpdate: async () => undefined,
          onConflictDoNothing: async () => undefined,
        })
      },
    }),
    delete: (table: unknown) => ({
      where: async () => {
        recorded.events.push(`${prefix}delete:${tableName(table)}`)
      },
    }),
    transaction: async (fn: (tx: unknown) => Promise<void>) => {
      recorded.events.push('tx:begin')
      await fn(handle('tx:'))
      recorded.events.push('tx:commit')
    },
  })
  return {
    db: handle('') as unknown as HandlerContext['db'],
    logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } as never,
    metrics: { incr: vi.fn() } as never,
  }
}

function op(record: Record<string, unknown>, did = MAKER, rkey = 'c1'): RecordOp {
  return {
    uri: `at://${did}/com.dinakernel.commerce.relationshipClaim/${rkey}`,
    did,
    collection: 'com.dinakernel.commerce.relationshipClaim',
    rkey,
    record,
  }
}

const claim = {
  claim_id: 'claim-1',
  subject: CHAIR_2,
  relationship: 'variant_of',
  object: CHAIR_1,
  issuer_did: MAKER,
  asserted_at: '2026-08-08T09:00:00.000Z',
}

describe('storing a claim and deriving the edges', () => {
  it('stores the claim, then rebuilds the subject from every stored claim', async () => {
    const recorded: Recorded = { events: [], inserted: {} }
    const ctx = stubCtx(recorded, [
      [
        {
          claimJson: claim,
          source: 'first_party_claim',
          confidenceBp: 9500,
          assertedAt: claim.asserted_at,
          inferenceVersion: null,
        },
      ],
    ])
    await commerceRelationshipClaimHandler.handleCreate(ctx, op(claim))

    // Store, read back ALL claims for the subject, replace that subject's
    // edges inside one transaction. Not "update the edge in place": a dispute
    // has to be able to disappear when its claim is withdrawn.
    expect(recorded.events).toEqual([
      'insert:claims',
      'select:claims',
      'tx:begin',
      'tx:delete:edges',
      'tx:insert:edges',
      'tx:commit',
    ])
    expect(recorded.inserted.edges?.[0]).toMatchObject({
      subjectKey: productKey(CHAIR_2),
      relationship: 'variant_of',
      objectKey: productKey(CHAIR_1),
      disputed: false,
    })
  })

  it('treats the publishing repo as the first party, and nobody else', async () => {
    // A rival re-publishing the same claim cannot promote it to first-party by
    // saying so: `source` comes from the repo, not the record.
    const mine: Recorded = { events: [], inserted: {} }
    await commerceRelationshipClaimHandler.handleCreate(stubCtx(mine, [[]]), op(claim))
    expect(mine.inserted.claims?.[0]).toMatchObject({ source: 'first_party_claim' })

    const theirs: Recorded = { events: [], inserted: {} }
    await commerceRelationshipClaimHandler.handleCreate(
      stubCtx(theirs, [[]]),
      op(claim, RIVAL),
    )
    expect(theirs.inserted.claims?.[0]).toMatchObject({ source: 'third_party_claim' })
  })

  it('caps a model-suggested edge below the standing threshold', async () => {
    const recorded: Recorded = { events: [], inserted: {} }
    await commerceRelationshipClaimHandler.handleCreate(
      stubCtx(recorded, [[]]),
      op({ ...claim, inference_version: 'sim-v3', confidence_bp: 10000 }),
    )
    const stored = recorded.inserted.claims?.[0] as { source: string; confidenceBp: number }
    expect(stored.source).toBe('inferred')
    // Reported at 10000 and stored below the threshold, because §10.7 says a
    // similarity score alone can never carry standing.
    expect(stored.confidenceBp).toBeLessThan(6000)
  })

  it('surfaces a dispute when two claims name different parents', async () => {
    const recorded: Recorded = { events: [], inserted: {} }
    const ctx = stubCtx(recorded, [
      [
        {
          claimJson: claim,
          source: 'first_party_claim',
          confidenceBp: 9500,
          assertedAt: claim.asserted_at,
          inferenceVersion: null,
        },
        {
          claimJson: { ...claim, claim_id: 'claim-2', object: CHAIR_3, issuer_did: RIVAL },
          source: 'third_party_claim',
          confidenceBp: 6500,
          assertedAt: claim.asserted_at,
          inferenceVersion: null,
        },
      ],
    ])
    await commerceRelationshipClaimHandler.handleCreate(ctx, op(claim))
    const edge = recorded.inserted.edges?.[0] as { disputed: boolean; evidenceJson: unknown[] }
    expect(edge.disputed).toBe(true)
    // Both claims survive on the edge. Deleting the loser is the silent merge
    // §10.7 forbids.
    expect(edge.evidenceJson).toHaveLength(2)
  })
})

describe('withdrawing a claim', () => {
  it('removes it and re-derives, so a dispute can disappear', async () => {
    const recorded: Recorded = { events: [], inserted: {} }
    const ctx = stubCtx(recorded, [
      [{ uri: 'x', subjectKey: productKey(CHAIR_2) }],
      [
        {
          claimJson: claim,
          source: 'first_party_claim',
          confidenceBp: 9500,
          assertedAt: claim.asserted_at,
          inferenceVersion: null,
        },
      ],
    ])
    await commerceRelationshipClaimHandler.handleDelete(ctx, op(claim))
    expect(recorded.events).toEqual([
      'select:claims',
      'delete:claims',
      'select:claims',
      'tx:begin',
      'tx:delete:edges',
      'tx:insert:edges',
      'tx:commit',
    ])
    // One claim left, so the surviving edge is no longer disputed.
    expect(recorded.inserted.edges?.[0]).toMatchObject({ disputed: false })
  })

  it('does nothing for a record it never stored', async () => {
    const recorded: Recorded = { events: [], inserted: {} }
    await commerceRelationshipClaimHandler.handleDelete(stubCtx(recorded, [[]]), op(claim))
    expect(recorded.events).toEqual(['select:claims'])
  })
})
