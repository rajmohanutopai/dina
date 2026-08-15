/**
 * §14.4 (WS-10.1 / WS-10.2) — the review-dimension projection, reached.
 *
 * WHAT THIS CLOSES. `review-dimensions.ts` was correct, tested and had NO
 * consumer: WBS 10.1 said "nothing consumes it yet" and 10.2 said nothing at
 * all. The whole §14.4 apparatus — closed vocabulary, model-extraction cap,
 * reviewer-confirmed floor, commercial-terms scan — was unreachable from
 * anything a buyer could ask. That is the defect class this codebase keeps
 * producing, and 33 unit tests over the module could not see it, because
 * unreachability is never visible from inside the thing that is unreachable.
 *
 * These drive the real endpoint against real Postgres, so the join, the
 * projection and the §14.4 rules are all on the same path a caller takes.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getSupplierDimensions } from '@/api/xrpc/commerce-review-dimensions.js'
import { attestations } from '@/db/schema/attestations.js'
import { subjects } from '@/db/schema/subjects.js'

import { cleanAllTables, getTestDb, type TestDB } from '../test-db.js'

const SUPPLIER = 'did:plc:chairmaker99'
const RIVAL = 'did:plc:rivalwood77'

let db: TestDB

/** A subject row, because an attestation names a subject and not a DID. */
async function subject(id: string, did: string): Promise<void> {
  // `name` and `subject_type` are NOT NULL — a subject with no name is not a
  // subject anyone could have reviewed.
  await db
    .insert(subjects)
    .values({ id, did, name: id, subjectType: 'business' })
    .onConflictDoNothing()
}

async function review(args: {
  uri: string
  subjectId: string
  /**
   * The SUBJECT's category — `commerce/product`, `furniture/chair`. Never a
   * §14.4 review dimension. Seeding a dimension name here is what made the
   * previous version of this suite pass against an endpoint that returned
   * nothing on real data: the route read `category` AS the dimension, and the
   * fixture obligingly handed it one.
   */
  category: string
  sentiment: string
  /** The reviewer's per-dimension verdicts, where the real signal lives. */
  dimensions?: { dimension: string; value: 'exceeded' | 'met' | 'below' | 'failed' }[]
  searchContent?: string
}): Promise<void> {
  await db.insert(attestations).values({
    uri: args.uri,
    // Every NOT NULL column, filled with what a real record carries: an
    // attestation with no author is not a review anyone signed.
    authorDid: 'did:plc:reviewer0001',
    cid: `bafy-${args.uri.slice(-8)}`,
    subjectId: args.subjectId,
    subjectRefRaw: { did: args.subjectId },
    category: args.category,
    sentiment: args.sentiment,
    ...(args.dimensions === undefined ? {} : { dimensionsJson: args.dimensions }),
    recordCreatedAt: new Date('2026-08-08T09:00:00.000Z'),
    ...(args.searchContent === undefined ? {} : { searchContent: args.searchContent }),
  })
}

beforeAll(() => {
  db = getTestDb()
})

beforeEach(async () => {
  await cleanAllTables(db)
  await subject('subj-chairmaker', SUPPLIER)
  await subject('subj-rivalwood', RIVAL)
})

describe('a buyer asks what reviewers said, by dimension', () => {
  it('answers per dimension rather than with one number', async () => {
    // The point of §14.4. A single score is what PeerLens exists to replace,
    // so the shape of the answer has to be the shape of the evidence.
    await review({
      uri: 'at://did:plc:reviewer0001/a/1',
      subjectId: 'subj-chairmaker',
      category: 'commerce/product',
      dimensions: [{ dimension: 'fulfilment', value: 'met' }],
      sentiment: 'positive',
    })
    await review({
      uri: 'at://did:plc:reviewer0001/a/2',
      subjectId: 'subj-chairmaker',
      category: 'commerce/product',
      dimensions: [{ dimension: 'product_quality', value: 'met' }],
      sentiment: 'positive',
    })

    const out = await getSupplierDimensions(db, { supplier: SUPPLIER, limit: 50 })

    expect(out.dimensions.map((d) => d.dimension).sort()).toEqual([
      'fulfilment',
      'product_quality',
    ])
    expect(out.reviews_examined).toBe(2)
  })

  it('answers about the supplier ASKED FOR, not whoever shares a subject row', async () => {
    // The join is through `subjects` because the DID lives there. Reading the
    // subject id as though it were a DID is the §9.4 identity mistake one
    // table over, and it would answer about a rival.
    await review({
      uri: 'at://did:plc:reviewer0001/a/3',
      subjectId: 'subj-rivalwood',
      category: 'commerce/product',
      dimensions: [{ dimension: 'fulfilment', value: 'met' }],
      sentiment: 'negative',
    })

    const out = await getSupplierDimensions(db, { supplier: SUPPLIER, limit: 50 })

    expect(out.dimensions).toEqual([])
    expect(out.reviews_examined).toBe(0)
  })

  it('carries the sentiment a reviewer actually gave', async () => {
    await review({
      uri: 'at://did:plc:reviewer0001/a/4',
      subjectId: 'subj-chairmaker',
      category: 'commerce/product',
      // The reviewer's OWN verdict on this dimension. `failed` is the signal;
      // the record-level `sentiment` is only the fallback for a rating that
      // names a dimension without scoring it.
      dimensions: [{ dimension: 'packaging', value: 'failed' }],
      sentiment: 'negative',
    })

    const out = await getSupplierDimensions(db, { supplier: SUPPLIER, limit: 50 })

    expect(out.dimensions[0]?.sentiment).toBe('negative')
  })

  it('says which review each dimension came from, so a buyer can read it', async () => {
    // §14.4's traceability rule. A dimension whose source cannot be opened is
    // an opinion with a number attached.
    await review({
      uri: 'at://did:plc:reviewer0001/a/5',
      subjectId: 'subj-chairmaker',
      category: 'commerce/product',
      dimensions: [{ dimension: 'terms_held', value: 'met' }],
      sentiment: 'positive',
    })

    const out = await getSupplierDimensions(db, { supplier: SUPPLIER, limit: 50 })

    expect(out.dimensions[0]?.sourceReviewUri).toBe('at://did:plc:reviewer0001/a/5')
    expect(out.dimensions[0]?.targetNode).toBe(SUPPLIER)
  })
})

describe('§14.4’s rules survive the route, not just the module', () => {
  it('refuses a category outside the CLOSED vocabulary, and names it', async () => {
    // A projection cannot invent a dimension. Reporting the refusal is what
    // stops a degraded index looking like a supplier nobody has reviewed.
    await review({
      uri: 'at://did:plc:reviewer0001/a/6',
      subjectId: 'subj-chairmaker',
      category: 'commerce/product',
      dimensions: [{ dimension: 'vibes', value: 'met' }],
      sentiment: 'positive',
    })

    const out = await getSupplierDimensions(db, { supplier: SUPPLIER, limit: 50 })

    expect(out.dimensions).toEqual([])
    expect(out.findings[0]?.refusal).toBe('unknown_dimension')
    expect(out.findings[0]?.dimension).toBe('vibes')
    // The review WAS read. "Nothing to say" and "said something inadmissible"
    // are different answers and a caller can now tell them apart.
    expect(out.reviews_examined).toBe(1)
  })

  /**
   * WHAT THIS REPLACED. The case here used to assert
   * `findings[0].refusal === 'commercial_terms_leak'`: the route passed the
   * whole review body as `evidenceText`, so `projectDimension` refused the
   * ENTIRE claim whenever the text mentioned a price. But
   * `ProjectedDimension` has no `evidenceText` field — nothing was ever
   * published from it. The refusal prevented no disclosure, cost a legitimate
   * dimension, and filed a privacy-shaped finding an operator would read as
   * the index degrading.
   *
   * The route no longer supplies `evidenceText`. Privacy comes from the SHAPE
   * — a projected dimension has nowhere to put review prose — which is the
   * same argument FR-A7 makes for the catalog row.
   */
  it('keeps a dimension whose review text mentions a price, and republishes no term', async () => {
    await review({
      uri: 'at://did:plc:reviewer0001/a/7',
      subjectId: 'subj-chairmaker',
      category: 'commerce/product',
      dimensions: [{ dimension: 'terms_held', value: 'met' }],
      sentiment: 'positive',
      searchContent: 'they honoured the agreed price of INR 4,50,000 per pallet',
    })

    const out = await getSupplierDimensions(db, { supplier: SUPPLIER, limit: 50 })

    // The reviewer's verdict survives — a buyer asking "did they hold terms?"
    // gets the answer a reviewer gave.
    expect(out.dimensions.map((d) => d.dimension)).toContain('terms_held')
    expect(out.findings).toEqual([])
    // And the term itself never appears, because no field carries it.
    expect(JSON.stringify(out)).not.toContain('4,50,000')
    expect(JSON.stringify(out)).not.toContain('honoured the agreed price')
  })

  it('marks a reviewer-confirmed dimension as able to move standing', async () => {
    // The other half of §14.4's ranking: a person who said it outranks
    // software that inferred it, and the flag is how a caller can tell.
    await review({
      uri: 'at://did:plc:reviewer0001/a/8',
      subjectId: 'subj-chairmaker',
      category: 'commerce/product',
      dimensions: [{ dimension: 'customer_service', value: 'met' }],
      sentiment: 'positive',
    })

    const out = await getSupplierDimensions(db, { supplier: SUPPLIER, limit: 50 })

    expect(out.dimensions[0]?.source).toBe('reviewer_confirmed')
    expect(out.dimensions[0]?.mayAffectStandingAlone).toBe(true)
  })

  it('computes NO score, so the weighting stays where §10.6 puts it', async () => {
    // An extractor's confidence and a trust weight tunable in one place is the
    // coupling to avoid. Asserted as an ABSENCE because that is what it is:
    // the day someone adds a `score` here, this fails and asks them why.
    await review({
      uri: 'at://did:plc:reviewer0001/a/9',
      subjectId: 'subj-chairmaker',
      category: 'commerce/product',
      dimensions: [{ dimension: 'fulfilment', value: 'met' }],
      sentiment: 'positive',
    })

    const out = await getSupplierDimensions(db, { supplier: SUPPLIER, limit: 50 })

    expect(Object.keys(out).sort()).toEqual([
      'all',
      'dimensions',
      'findings',
      'reviews_examined',
      'supplier_did',
    ])
  })

  it('keeps every projected claim beside the strongest one', async () => {
    // `dimensions` is the winner per dimension; `all` is the spread behind it.
    // A caller shown only a winner cannot see that two reviewers disagreed.
    await review({
      uri: 'at://did:plc:reviewer0001/b/1',
      subjectId: 'subj-chairmaker',
      category: 'commerce/product',
      dimensions: [{ dimension: 'fulfilment', value: 'met' }],
      sentiment: 'positive',
    })
    await review({
      uri: 'at://did:plc:reviewer0001/b/2',
      subjectId: 'subj-chairmaker',
      category: 'commerce/product',
      dimensions: [{ dimension: 'fulfilment', value: 'met' }],
      sentiment: 'negative',
    })

    const out = await getSupplierDimensions(db, { supplier: SUPPLIER, limit: 50 })

    expect(out.dimensions).toHaveLength(1)
    expect(out.all).toHaveLength(2)
  })

  it('bounds the read, and says how many it read', async () => {
    // A supplier with a long history must not turn one question into a scan,
    // and a caller who sees three dimensions from a limit of two has to be
    // able to tell that the read was capped.
    for (let i = 0; i < 5; i += 1) {
      await review({
        uri: `at://did:plc:reviewer0001/c/${String(i)}`,
        subjectId: 'subj-chairmaker',
        category: 'commerce/product',
        dimensions: [{ dimension: 'packaging', value: 'met' }],
        sentiment: 'positive',
      })
    }

    const out = await getSupplierDimensions(db, { supplier: SUPPLIER, limit: 2 })

    expect(out.reviews_examined).toBe(2)
  })
})
