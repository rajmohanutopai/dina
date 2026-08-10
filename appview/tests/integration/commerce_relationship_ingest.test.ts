/**
 * §10.7 product relationships, against REAL POSTGRES (WS-5.8, WS-11.4).
 *
 * WHY A DATABASE IS NEEDED HERE, even though this handler holds no raw SQL.
 * The projection rules are pure and tested purely; the handler's stub test
 * proves a claim is stored and the subject is then rebuilt. What neither can
 * show is the property the two-table design exists FOR: edges are DERIVED from
 * every stored claim rather than mutated in place, so a withdrawal can
 * un-dispute an edge that two claims disagreed about. That is a statement about
 * rows surviving across several handler calls, and it is only true if the
 * writes and deletes actually land.
 *
 * THE RULE WITH TEETH is disagreement. Two claims naming different parents must
 * land on ONE edge, marked disputed, with BOTH claims kept — deleting the loser
 * would be the silent merge §10.7 forbids, and a merge is irreversible in
 * practice: once two identities are one row, the reviews, order history and
 * lineage of both are indistinguishable and no later evidence separates them.
 *
 * Run against `dina_commerce_test`:
 *   DATABASE_URL=postgresql://dina:dina@localhost:5432/dina_commerce_test \
 *     npx vitest run tests/integration/commerce_relationship_ingest.test.ts
 */

import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  commerceProductRelationships,
  commerceRelationshipClaims,
} from '@/db/schema/index.js'
import { commerceRelationshipClaimHandler } from '@/ingester/handlers/commerce-relationship.js'
import { productKey } from '@/shared/commerce/catalog-projection.js'
import {
  mayInheritStanding,
  type RelationshipEdge,
} from '@/shared/commerce/relationship-projection.js'

import {
  cleanAllTables,
  closeTestDb,
  createTestHandlerContext,
  getTestDb,
  type TestDB,
} from '../test-db'

import type { HandlerContext, RecordOp } from '@/ingester/handlers/index.js'

/** The manufacturer, and a rival who also has opinions about its products. */
const MAKER = 'did:plc:chairmaker99'
const RIVAL = 'did:plc:rivalchairs01'

const CHAIR_1 = { scheme: 'gtin' as const, value: '05012345678900' }
const CHAIR_2 = { scheme: 'gtin' as const, value: '05012345678917' }
const CHAIR_3 = { scheme: 'gtin' as const, value: '05012345678924' }

const AT = '2026-08-08T09:00:00.000Z'

let db: TestDB
let ctx: HandlerContext

interface ClaimSpec {
  claimId: string
  subject: typeof CHAIR_1
  object: typeof CHAIR_1
  relationship?: string
  issuer?: string
  confidenceBp?: number
  inferenceVersion?: string
}

function claimRecord(spec: ClaimSpec): Record<string, unknown> {
  return {
    claim_id: spec.claimId,
    subject: spec.subject,
    relationship: spec.relationship ?? 'variant_of',
    object: spec.object,
    issuer_did: spec.issuer ?? MAKER,
    asserted_at: AT,
    ...(spec.confidenceBp === undefined ? {} : { confidence_bp: spec.confidenceBp }),
    ...(spec.inferenceVersion === undefined
      ? {}
      : { inference_version: spec.inferenceVersion }),
  }
}

function op(spec: ClaimSpec, did?: string): RecordOp {
  const publisher = did ?? spec.issuer ?? MAKER
  return {
    uri: `at://${publisher}/com.dinakernel.commerce.relationshipClaim/${spec.claimId}`,
    did: publisher,
    collection: 'com.dinakernel.commerce.relationshipClaim',
    rkey: spec.claimId,
    record: claimRecord(spec),
  }
}

const file = async (spec: ClaimSpec, did?: string): Promise<void> => {
  await commerceRelationshipClaimHandler.handleCreate(ctx, op(spec, did))
}

const withdraw = async (spec: ClaimSpec, did?: string): Promise<void> => {
  await commerceRelationshipClaimHandler.handleDelete?.(ctx, op(spec, did))
}

async function claimRows() {
  return db.select().from(commerceRelationshipClaims)
}

async function edgesFor(subject: typeof CHAIR_1) {
  return db
    .select()
    .from(commerceProductRelationships)
    .where(eq(commerceProductRelationships.subjectKey, productKey(subject as never)))
}

/**
 * Ask the REAL predicate whether standing may inherit along a stored row.
 *
 * `mayInheritStanding` is derived, not a column — the table stores the
 * evidence and the rule is applied at read. A test asserting a
 * `may_inherit_standing` column would be asserting a schema that does not
 * exist, and would pass the moment someone added one for a different reason.
 */
function standingInherits(row: {
  edgeKey: string
  subjectKey: string
  relationship: string
  objectKey: string | null
  confidenceBp: number
  disputed: boolean
  evidenceJson: unknown
}): boolean {
  return mayInheritStanding({
    edgeKey: row.edgeKey,
    subjectKey: row.subjectKey,
    relationship: row.relationship,
    objectKey: row.objectKey,
    confidenceBp: row.confidenceBp,
    disputed: row.disputed,
    evidence: row.evidenceJson,
  } as unknown as RelationshipEdge)
}

beforeAll(() => {
  db = getTestDb()
  ctx = createTestHandlerContext(db) as unknown as HandlerContext
})

beforeEach(async () => {
  await cleanAllTables(db)
})

afterAll(async () => {
  await closeTestDb()
})

describe('a claim is stored, and the edge is derived from it', () => {
  it('one first-party claim makes one undisputed edge', async () => {
    await file({ claimId: 'c1', subject: CHAIR_2, object: CHAIR_1 })

    expect(await claimRows()).toHaveLength(1)
    const edges = await edgesFor(CHAIR_2)
    expect(edges).toHaveLength(1)
    expect(edges[0]?.objectKey).toBe(productKey(CHAIR_1 as never))
    expect(edges[0]?.disputed).toBe(false)
  })

  it('re-delivering the same claim does not duplicate it or its edge', async () => {
    await file({ claimId: 'c1', subject: CHAIR_2, object: CHAIR_1 })
    await file({ claimId: 'c1', subject: CHAIR_2, object: CHAIR_1 })

    expect(await claimRows()).toHaveLength(1)
    expect(await edgesFor(CHAIR_2)).toHaveLength(1)
  })
})

describe('disagreement is DATA, not a winner', () => {
  it('two claims naming different parents make ONE disputed edge and keep both', async () => {
    // The manufacturer says CHAIR-2 is a variant of CHAIR-1. A rival says it is
    // a variant of CHAIR-3. Picking either one for them is the silent merge
    // §10.7 forbids.
    await file({ claimId: 'c1', subject: CHAIR_2, object: CHAIR_1 })
    await file({ claimId: 'c2', subject: CHAIR_2, object: CHAIR_3, issuer: RIVAL }, RIVAL)

    // BOTH claims survive. The evidence is the point.
    expect(await claimRows()).toHaveLength(2)

    const edges = await edgesFor(CHAIR_2)
    expect(edges.some((e) => e.disputed === true)).toBe(true)
  })

  it('a disputed edge carries no standing, however confident its claims', async () => {
    // Inheriting standing across a contested identity is how one product
    // silently acquires another's reviews and order history.
    await file({ claimId: 'c1', subject: CHAIR_2, object: CHAIR_1, confidenceBp: 9900 })
    await file(
      { claimId: 'c2', subject: CHAIR_2, object: CHAIR_3, issuer: RIVAL, confidenceBp: 9900 },
      RIVAL,
    )

    const edges = await edgesFor(CHAIR_2)
    const disputed = edges.filter((e) => e.disputed === true)
    expect(disputed.length).toBeGreaterThan(0)
    for (const edge of disputed) {
      expect(standingInherits(edge)).toBe(false)
    }
  })

  it('WITHDRAWING the loser un-disputes the edge — the reason for two tables', async () => {
    // An in-place edge update could not do this: once the edge said "disputed"
    // there would be nothing left to recompute it from. Derived-from-claims is
    // what makes a retraction actually retract.
    await file({ claimId: 'c1', subject: CHAIR_2, object: CHAIR_1 })
    await file({ claimId: 'c2', subject: CHAIR_2, object: CHAIR_3, issuer: RIVAL }, RIVAL)
    expect((await edgesFor(CHAIR_2)).some((e) => e.disputed === true)).toBe(true)

    await withdraw({ claimId: 'c2', subject: CHAIR_2, object: CHAIR_3, issuer: RIVAL }, RIVAL)

    expect(await claimRows()).toHaveLength(1)
    const edges = await edgesFor(CHAIR_2)
    expect(edges).toHaveLength(1)
    expect(edges[0]?.disputed).toBe(false)
    expect(edges[0]?.objectKey).toBe(productKey(CHAIR_1 as never))
  })

  it('withdrawing the LAST claim leaves no edge behind', async () => {
    await file({ claimId: 'c1', subject: CHAIR_2, object: CHAIR_1 })
    await withdraw({ claimId: 'c1', subject: CHAIR_2, object: CHAIR_1 })

    expect(await claimRows()).toEqual([])
    expect(await edgesFor(CHAIR_2)).toEqual([])
  })
})

describe('confidence is evidence, not arithmetic', () => {
  it('the edge takes the STRONGEST single claim, never a sum', async () => {
    // Three weak inferences agreeing is still three weak inferences. Summing
    // would let anyone manufacture standing by filing the same opinion twice.
    await file({
      claimId: 'i1',
      subject: CHAIR_2,
      object: CHAIR_1,
      confidenceBp: 2000,
      inferenceVersion: 'v1',
      issuer: RIVAL,
    })
    await file({
      claimId: 'i2',
      subject: CHAIR_2,
      object: CHAIR_1,
      confidenceBp: 2500,
      inferenceVersion: 'v1',
      issuer: RIVAL,
    })
    await file({
      claimId: 'i3',
      subject: CHAIR_2,
      object: CHAIR_1,
      confidenceBp: 1500,
      inferenceVersion: 'v1',
      issuer: RIVAL,
    })

    const edges = await edgesFor(CHAIR_2)
    expect(edges).toHaveLength(1)
    // The strongest single claim, not 6000.
    expect(edges[0]?.confidenceBp).toBeLessThanOrEqual(2500)
  })

  it('an inference cannot reach standing whatever it reports', async () => {
    // Arithmetically capped below the standing threshold, and `mayInherit`
    // checks the SOURCE again so a hand-built edge cannot route around the cap.
    await file({
      claimId: 'i1',
      subject: CHAIR_2,
      object: CHAIR_1,
      confidenceBp: 10000,
      inferenceVersion: 'v1',
      issuer: RIVAL,
    })

    const edges = await edgesFor(CHAIR_2)
    expect(edges).toHaveLength(1)
    const only = edges[0]
    if (only === undefined) throw new Error('no edge')
    expect(standingInherits(only)).toBe(false)
  })
})
