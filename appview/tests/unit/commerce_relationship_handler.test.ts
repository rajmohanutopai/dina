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
  commerceCatalogProducts,
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
  if (table === commerceCatalogProducts) return 'products'
  return 'unknown'
}

function stubCtx(recorded: Recorded, selects: unknown[][]): HandlerContext {
  const queue = [...selects]
  const handle = (prefix: string): Record<string, unknown> => ({
    // The per-subject advisory lock. Recorded rather than ignored, so the
    // ORDER is asserted: the lock must be taken before the claims are read,
    // or two concurrent rebuilds can still interleave a stale read with a
    // later replacement.
    execute: async () => {
      recorded.events.push(`${prefix}lock:subject`)
      return { rows: [] }
    },
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
  it('rebuilds BOTH subjects when a record moves from one subject to another', async () => {
    // AT create and update arrive through the same handler, so a record can
    // change which product it is about. Rebuilding only the INCOMING subject
    // left the one it departed still holding an edge derived from a claim that
    // no longer says it — the edge outliving its assertion, which is the exact
    // failure deriving-rather-than-mutating exists to prevent.
    const recorded: Recorded = { events: [], inserted: {} }
    const ctx = stubCtx(recorded, [
      [], // the repo supplies no catalog row for this subject
      // The prior row: this URI used to be about a DIFFERENT subject.
      [{ subjectKey: 'gtin:0000000000000' }],
      [], // rebuild of the OLD subject finds no claims left
      [], // rebuild of the NEW subject
    ])

    await commerceRelationshipClaimHandler.handleCreate(ctx, op(claim))

    // Two rebuilds, old subject first so the claim never counts for both.
    const rebuilds = recorded.events.filter((e) => e === 'tx:begin').length
    expect(rebuilds).toBe(2)
    expect(recorded.events[0]).toBe('select:products')
    expect(recorded.events[1]).toBe('select:claims')
    expect(recorded.events[2]).toBe('insert:claims')
  })

  it('stores the claim, then rebuilds the subject from every stored claim', async () => {
    const recorded: Recorded = { events: [], inserted: {} }
    const ctx = stubCtx(recorded, [
      [], // the repo supplies no catalog row for this subject
      [], // no prior row for this URI
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
      // Whether this repo SUPPLIES the subject, read from the verified
      // catalog index — first party is authority over the subject, not
      // authorship of the claim.
      'select:products',
      // Then the claim's PRIOR subject: a record can move between subjects,
      // and the one it leaves has to be rebuilt too or its edge outlives the
      // assertion behind it.
      'select:claims',
      'insert:claims',
      // The claims read moved INSIDE the transaction, behind a per-subject
      // advisory lock: reading outside it let two concurrent rebuilds of one
      // subject interleave, so an older rebuild could commit last and delete
      // an edge whose claim was still in the table.
      'tx:begin',
      'tx:lock:subject',
      'tx:select:claims',
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

  it('lets a verified seller speak with authority about SELLING, and nothing else', async () => {
    // A verified catalog row proves this repo sells the thing. That is standing
    // over `sold_by` and over nothing else.
    const sells: Recorded = { events: [], inserted: {} }
    await commerceRelationshipClaimHandler.handleCreate(
      stubCtx(sells, [[{ rowKey: 'row-1' }], []]),
      op({ ...claim, relationship: 'sold_by', object: { did: MAKER } }),
    )
    expect(sells.inserted.claims?.[0]).toMatchObject({ source: 'first_party_claim' })
  })

  it('refuses a reseller product-line authority they do not have', async () => {
    // THE §24 NON-GOAL, stated outright: "Making public catalog presence
    // equivalent to supplier verification." An earlier fix did exactly that —
    // any repo holding a catalog row spoke as first party about the product's
    // FORMULATION and what it REPLACES, at 9500 basis points, clearing the
    // substitution threshold. Listing a product is not knowing how it is made.
    for (const relationship of ['same_formulation_as', 'replaces', 'variant_of']) {
      const recorded: Recorded = { events: [], inserted: {} }
      await commerceRelationshipClaimHandler.handleCreate(
        stubCtx(recorded, [[{ rowKey: 'row-1' }], []]),
        op({ ...claim, relationship }),
      )
      expect(recorded.inserted.claims?.[0]).toMatchObject({ source: 'third_party_claim' })
    }
  })

  it('refuses a reseller MANUFACTURER authority even for an operator claim', async () => {
    const recorded: Recorded = { events: [], inserted: {} }
    await commerceRelationshipClaimHandler.handleCreate(
      stubCtx(recorded, [[{ rowKey: 'row-1' }], []]),
      op({ ...claim, relationship: 'manufactured_by', object: { did: MAKER } }),
    )
    expect(recorded.inserted.claims?.[0]).toMatchObject({ source: 'third_party_claim' })
  })

  it('refuses first-party standing to a publisher who merely names itself issuer', async () => {
    // THE ATTACK the old rule allowed. `source` was `repoDid === issuerDid`,
    // which any publisher satisfies by setting `issuer_did` to itself — and
    // the claim can be about ANY product. That bought 9500 basis points and a
    // pass through the standing predicate, which is how one manufacturer's
    // reputation lands on another's product.
    //
    // Here the repo IS the named issuer and still supplies no catalog row for
    // the subject, so it has demonstrated no authority over it.
    const selfDeclared: Recorded = { events: [], inserted: {} }
    await commerceRelationshipClaimHandler.handleCreate(
      stubCtx(selfDeclared, [[], []]),
      op(claim),
    )
    expect(selfDeclared.inserted.claims?.[0]).toMatchObject({
      source: 'third_party_claim',
    })
  })

  it('treats a publisher who issued the subject IDENTITY as the first party', async () => {
    // A scoped ProductRef carries its issuer, so authority is on the record
    // itself and needs no catalog lookup.
    const scoped = {
      ...claim,
      subject: { scheme: 'manufacturer_sku' as const, value: 'CHAIR-2', issuer_did: MAKER },
    }
    const owned: Recorded = { events: [], inserted: {} }
    await commerceRelationshipClaimHandler.handleCreate(stubCtx(owned, [[], []]), op(scoped))
    expect(owned.inserted.claims?.[0]).toMatchObject({ source: 'first_party_claim' })
  })

  it('gives a rival re-publishing the same claim no standing at all', async () => {
    const theirs: Recorded = { events: [], inserted: {} }
    await commerceRelationshipClaimHandler.handleCreate(
      stubCtx(theirs, [[{ rowKey: 'row-1' }], []]),
      op(claim, RIVAL),
    )
    expect(theirs.inserted.claims?.[0]).toMatchObject({ source: 'third_party_claim' })
  })

  it('caps a model-suggested edge below the standing threshold', async () => {
    const recorded: Recorded = { events: [], inserted: {} }
    await commerceRelationshipClaimHandler.handleCreate(
      stubCtx(recorded, [[], []]),
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
      [], // the repo supplies no catalog row for this subject
      [], // no prior row for this URI
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
    // TWO EDGES, both disputed. §10.3: "Conflicting edges coexist". Asserting
    // one edge holding both claims encoded the old collapse — the losing
    // parent was hidden behind whichever row the unordered query returned
    // first.
    const edges = (recorded.inserted.edges ?? []) as {
      disputed: boolean
      objectKey: string
      evidenceJson: unknown[]
    }[]
    expect(edges).toHaveLength(2)
    expect(edges.every((e) => e.disputed)).toBe(true)
    // One claim each, kept apart rather than merged into a single edge.
    expect(edges.map((e) => e.evidenceJson.length).sort()).toEqual([1, 1])
    expect(new Set(edges.map((e) => e.objectKey)).size).toBe(2)
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
      // The claims read moved INSIDE the transaction, behind a per-subject
      // advisory lock: reading outside it let two concurrent rebuilds of one
      // subject interleave, so an older rebuild could commit last and delete
      // an edge whose claim was still in the table.
      'tx:begin',
      'tx:lock:subject',
      'tx:select:claims',
      'tx:delete:edges',
      'tx:insert:edges',
      'tx:commit',
    ])
    // One claim left, so the surviving edge is no longer disputed.
    expect(recorded.inserted.edges?.[0]).toMatchObject({ disputed: false })
  })

  it('does nothing for a record it never stored', async () => {
    const recorded: Recorded = { events: [], inserted: {} }
    await commerceRelationshipClaimHandler.handleDelete(stubCtx(recorded, [[], []]), op(claim))
    expect(recorded.events).toEqual(['select:claims'])
  })
})
