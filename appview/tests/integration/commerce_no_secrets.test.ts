/**
 * §25.2 — "secrets never enter AppView", as a property of AppView.
 *
 * THE HALF THAT WAS MISSING. WBS 11.2 named this and said it "needs the
 * AppView of WS-5.4". The AppView exists now, so the claim is checkable.
 *
 * WHY CORE'S GATE IS NOT ENOUGH, and this is the whole argument for testing it
 * here. Core's §12.1 publication gate stops the OWNER's node from publishing
 * the owner's secrets, and it is well covered. But AppView does not ingest
 * from Core — it ingests from a firehose, and anybody may publish anything to
 * their own PDS. A guarantee that holds only when every publisher is honest is
 * not a guarantee about AppView; it is a guarantee about publishers.
 *
 * WHAT IS ACTUALLY CLAIMABLE, and my first version of this file claimed more.
 * I asserted that a secret spliced into a published item reaches NO column at
 * all. That is false, and the scan found it: `commerce_catalog_snapshots`
 * stores `pages_json` — the publisher's raw pages, verbatim — because a
 * snapshot store must keep what it was given in order to verify digests
 * against it and re-project later. So §25.2's sentence cannot mean "no
 * publisher's byte is ever retained".
 *
 * WHAT IT DOES MEAN, and the distinction is the useful part:
 *
 *   1. DINA never SENDS secrets. That is Core's §12.1 publication gate, tested
 *      in `catalog_leakage_vocabulary.test.ts`, and it is the load-bearing
 *      half — it is the only half that protects the OWNER's data, because
 *      AppView cannot classify a stranger's string as a secret and pretending
 *      otherwise would invent a requirement nothing can meet.
 *   2. AppView creates no NEW exposure. Everything in `pages_json` was already
 *      public: the publisher put it on their own PDS. What AppView must not do
 *      is take an unnamed field and PROJECT it into the queryable, searchable
 *      surface that discovery answers from. That is a structural property —
 *      the projection is an allow-list, "a field that does not exist cannot
 *      leak" as the schema's own comment puts it — and it is checkable.
 *
 * SO THE TESTS BELOW SPLIT ALONG THAT LINE: the projected columns must be
 * clean, the raw column is expected to retain bytes and says so out loud, and
 * a tampered page must not be projected at all.
 *
 * THE ASSERTION IS A DATABASE SCAN rather than a field-by-field check. A test
 * that named the columns it expected to be clean would be checking the columns
 * I thought of; a scan reads the column list from `information_schema`, so it
 * checks the ones I did not and the ones added later.
 *
 * WHY THE HOSTILE PUBLISHER RECOMPUTES ITS OWN DIGESTS. Splicing a field into
 * an item changes the page bytes, so the page digest no longer matches and the
 * publication is refused as tampered — which is correct, and is pinned below
 * as its own property. But it also means a naive taint tests the digest check
 * rather than the projection. A real hostile supplier signs whatever they
 * like: they publish tainted content with digests that are perfectly valid
 * OVER that content. Reproducing that needs the digests recomputed, and using
 * AppView's own digest functions to do it is sound here because the digest is
 * not what is under test — `commerce_discovery_interop.test.ts` already pins
 * those functions against Core's bytes.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { sql } from 'drizzle-orm'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  commerceCatalogPointerHandler,
  commerceCatalogSnapshotHandler,
} from '@/ingester/handlers/commerce-catalog.js'
import { commerceRelationshipClaimHandler } from '@/ingester/handlers/commerce-relationship.js'
import { searchCommerceCatalog } from '@/api/xrpc/commerce-catalog-search.js'

import { cleanAllTables, createTestHandlerContext, getTestDb, type TestDB } from '../test-db.js'

import {
  catalogPageDigest,
  catalogPayloadRoot,
  catalogSnapshotDigest,
  type CatalogPointer,
  type CatalogSnapshot,
  type CatalogSnapshotPage,
} from '@/shared/commerce/catalog-verify.js'
import type { RecordOp } from '@/ingester/handlers/index.js'

/** Core's real publication — the same bytes the discovery suite uses. */
const PUBLICATION = JSON.parse(
  readFileSync(
    path.join(
      __dirname,
      '..',
      '..',
      '..',
      'packages',
      'commerce-protocol',
      'conformance',
      'interop',
      'catalog_publication.json',
    ),
    'utf8',
  ),
) as { pointer: CatalogPointer; snapshot: CatalogSnapshot; pages: CatalogSnapshotPage[] }

const MANUFACTURER = 'did:plc:chairmaker99'

/**
 * A string no honest catalog would contain, distinctive enough that finding it
 * anywhere is unambiguous. Deliberately NOT a realistic-looking key: the test
 * is about whether an unnamed field reaches a column, not about whether a
 * classifier recognises a credential.
 */
const SECRET = 'ZZ-SECRET-erp-api-key-8f41c2-ZZ'

let db: TestDB
let ctx: ReturnType<typeof createTestHandlerContext>

/** Every commerce table, with its text and jsonb columns. */
const COMMERCE_TABLES = [
  'commerce_catalog_pointers',
  'commerce_catalog_snapshots',
  'commerce_catalog_products',
  'commerce_relationship_claims',
  'commerce_product_relationships',
] as const

/**
 * Scan every text-ish column of every commerce table for a needle.
 *
 * Reads the column list from `information_schema` rather than from a list I
 * maintain, so a column added later is scanned without anyone remembering to
 * add it here. That is the difference between a test that checks the schema
 * and one that checks my memory of it.
 */
async function findAnywhere(needle: string): Promise<string[]> {
  const hits: string[] = []
  for (const table of COMMERCE_TABLES) {
    const cols = await db.execute<{ column_name: string; data_type: string }>(
      sql`SELECT column_name, data_type FROM information_schema.columns
          WHERE table_name = ${table}
            AND data_type IN ('text', 'jsonb', 'character varying')`,
    )
    for (const { column_name } of cols.rows) {
      const found = await db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)}
            WHERE ${sql.identifier(column_name)}::text LIKE ${`%${needle}%`}`,
      )
      const n = found.rows[0]?.n ?? 0
      if (n > 0) hits.push(`${table}.${column_name} (${String(n)} row(s))`)
    }
  }
  return hits
}

/**
 * Deliver a publication.
 *
 * `resign: true` recomputes every digest over the (possibly tainted) pages, so
 * the publication verifies — a hostile-but-conforming supplier. `false` leaves
 * the original digests, which is a TAMPERED publication and must be refused.
 */
async function deliver(
  taint?: (page: CatalogSnapshotPage) => CatalogSnapshotPage,
  resign = true,
  snapshotOverrides: Record<string, unknown> = {},
): Promise<void> {
  const pages = taint === undefined ? PUBLICATION.pages : PUBLICATION.pages.map(taint)
  let snapshot = PUBLICATION.snapshot
  let pointer = PUBLICATION.pointer

  if (taint !== undefined && resign) {
    for (const page of pages) page.page_digest = catalogPageDigest(page)
    const pageDigests = pages.map((p) => p.page_digest)
    const draft: CatalogSnapshot = {
      ...snapshot,
      page_digests: pageDigests,
      payload_root: catalogPayloadRoot(pageDigests),
      snapshot_digest: '',
    }
    snapshot = { ...draft, snapshot_digest: catalogSnapshotDigest(draft) }
    pointer = { ...pointer, snapshot_digest: snapshot.snapshot_digest }
  }

  const publishedSnapshot = { ...snapshot, ...snapshotOverrides }
  await commerceCatalogSnapshotHandler.handleCreate?.(ctx, {
    uri: `at://${MANUFACTURER}/com.dinakernel.commerce.catalogSnapshot/${snapshot.snapshot_digest}`,
    did: MANUFACTURER,
    collection: 'com.dinakernel.commerce.catalogSnapshot',
    rkey: snapshot.snapshot_digest,
    record: { snapshot: publishedSnapshot, pages } as unknown as Record<string, unknown>,
  } satisfies RecordOp)
  await commerceCatalogPointerHandler.handleCreate?.(ctx, {
    uri: `at://${MANUFACTURER}/com.dinakernel.commerce.catalog/${pointer.catalog_id}`,
    did: MANUFACTURER,
    collection: 'com.dinakernel.commerce.catalog',
    rkey: pointer.catalog_id,
    record: pointer as unknown as Record<string, unknown>,
  } satisfies RecordOp)
}

/**
 * How many product rows the projection actually wrote.
 *
 * Asserting a secret is ABSENT proves nothing if the catalog was thrown away —
 * the empty index satisfies it perfectly. Three of the four hostile-splice
 * scenarios asserted absence alone until a reviewer pointed this out, so each
 * now pairs its absence check with evidence that there was something to leak
 * from.
 */
async function projectedEdgeCount(): Promise<number> {
  // NEW-F: the pairing rule was applied to the catalog block and not to the
  // relationship block beside it, so three scenarios certifying the derived
  // edge could go green over an empty table — the original positive-control
  // defect, one block over.
  const out = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM commerce_product_relationships`,
  )
  return out.rows[0]?.n ?? 0
}

async function projectedProductCount(): Promise<number> {
  const out = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM commerce_catalog_products`,
  )
  return out.rows[0]?.n ?? 0
}

/**
 * The projected surface only — what discovery answers from.
 *
 * TWO columns are excluded, and both are RAW EVIDENCE the schema keeps
 * deliberately verbatim rather than projections anyone queries:
 *
 *   - `commerce_catalog_snapshots.pages_json` — the page digests are computed
 *     over these bytes, so stripping them would leave AppView unable to
 *     re-verify its own index.
 *   - `commerce_relationship_claims.claim_json` — the schema states the split:
 *     this table "holds what people SAID, verbatim and durably", while
 *     `commerce_product_relationships` "holds what AppView currently BELIEVES,
 *     derived from all the claims". Deriving rather than mutating is what lets
 *     a withdrawn claim un-dispute an edge, and that needs the original kept.
 *
 * The DERIVED table is NOT excluded, and that is the line: `evidence_json` is
 * read by `commerce-catalog-search` and emitted on the wire as
 * `relationship_evidence_refs`, so anything reaching it is served to buyers.
 */
const RAW_EVIDENCE_COLUMNS = [
  'commerce_catalog_snapshots.pages_json',
  // Added after a reviewer noted the boundary was drawn in three places and
  // left undecided in the fourth. The schema gives it the same argument as the
  // other two: "the record as published, so verification can be re-run from
  // storage". A digest is computed over these bytes, so keeping them is what
  // makes re-verification possible at all.
  'commerce_catalog_snapshots.snapshot_json',
  'commerce_relationship_claims.claim_json',
]

async function findInProjection(needle: string): Promise<string[]> {
  return (await findAnywhere(needle)).filter(
    (hit) => !RAW_EVIDENCE_COLUMNS.some((col) => hit.startsWith(col)),
  )
}

/** Publish a relationship claim the way Jetstream delivers one. */
async function deliverClaim(
  evidenceRefs: unknown[],
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await commerceRelationshipClaimHandler.handleCreate?.(ctx, {
    uri: `at://${MANUFACTURER}/com.dinakernel.commerce.relationshipClaim/rc-taint`,
    did: MANUFACTURER,
    collection: 'com.dinakernel.commerce.relationshipClaim',
    rkey: 'rc-taint',
    record: {
      claim_id: 'rc-taint',
      subject: { scheme: 'gtin', value: '05012345678900' },
      relationship: 'variant_of',
      object: { scheme: 'gtin', value: '05012345678917' },
      issuer_did: MANUFACTURER,
      evidence_refs: evidenceRefs,
      ...overrides,
    } as unknown as Record<string, unknown>,
  } satisfies RecordOp)
}

/** Splice a value into every item at `mutate`, leaving the rest untouched. */
function taintItems(
  mutate: (item: Record<string, unknown>) => Record<string, unknown>,
): (page: CatalogSnapshotPage) => CatalogSnapshotPage {
  return (page) => ({
    ...page,
    items: (page.items as unknown as Record<string, unknown>[]).map(mutate),
  }) as CatalogSnapshotPage
}

beforeAll(() => {
  db = getTestDb()
  ctx = createTestHandlerContext(db)
})

beforeEach(async () => {
  await cleanAllTables(db)
})

describe('the scan itself is trustworthy', () => {
  it('finds a needle in the PROJECTED surface, not merely in the raw blob', async () => {
    // STRENGTHENED. The first version asserted `findAnywhere(MANUFACTURER)` was
    // non-empty — but the supplier DID sits in `pages_json`, and the snapshot
    // row is written before any projection decision, so the control passed even
    // when NOTHING was projected. A positive control satisfied by the one
    // column the real assertions exclude is not a control at all.
    await deliver()

    expect(await findInProjection(MANUFACTURER)).not.toEqual([])
  })

  it('covers every commerce table that exists, not a list I remembered', async () => {
    const present = await db.execute<{ table_name: string }>(
      sql`SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name LIKE 'commerce_%'`,
    )
    const found = present.rows.map((r) => r.table_name).sort()

    expect(found).toEqual([...COMMERCE_TABLES].sort())
  })
})

describe('a hostile supplier cannot get an unnamed field into the SEARCHABLE surface', () => {
  it('drops a secret spliced in at the TOP LEVEL of an item', async () => {
    await deliver(taintItems((item) => ({ ...item, supplier_erp_key: SECRET })))

    expect(await findInProjection(SECRET)).toEqual([])
    expect(await projectedProductCount()).toBeGreaterThan(0)
  })

  it('drops a secret nested inside a REGION, which is copied as an object', async () => {
    // `fulfilmentRegions: [...item.fulfilment_regions]` copies the region
    // objects verbatim into jsonb. This is the case where an allow-list stops
    // being obviously an allow-list, and the reason this file exists.
    await deliver(
      taintItems((item) => ({
        ...item,
        fulfilment_regions: (item.fulfilment_regions as Record<string, unknown>[]).map((r) => ({
          ...r,
          internal_note: SECRET,
        })),
      })),
    )

    expect(await findInProjection(SECRET)).toEqual([])
    expect(await projectedProductCount()).toBeGreaterThan(0)
  })

  it('refuses a secret in an ALLOW-LISTED region field, which reaches the WIRE', async () => {
    // THE SHARPEST INSTANCE OF FOUR ROUNDS, and the one no existing scenario
    // could reach. Every other taint here uses an UNNAMED key, which the
    // allow-list correctly drops. `issuer_did` is NAMED — the region rebuild
    // copies it by reference — so an object landed in the jsonb column AND was
    // served to buyers, because `toCandidate` spreads the stored region into
    // the candidate's `fulfilment_regions`.
    //
    // It is also the field the original region fix names as its whole reason
    // for carrying regions structurally, which is what made it invisible: the
    // comment explaining why the field matters sat above a check that omitted
    // it.
    await deliver(
      taintItems((item) => ({
        ...item,
        fulfilment_regions: (item.fulfilment_regions as Record<string, unknown>[]).map((r) => ({
          ...r,
          issuer_did: { nested: SECRET },
        })),
      })),
    )

    expect(await findInProjection(SECRET)).toEqual([])
    expect(await projectedProductCount()).toBe(0)
  })

  it('still carries an HONEST region issuer_did, so the check is not a ban', async () => {
    // §9.0 allows `issuer_did` on a custom region and the §10.5 vector caught
    // it being dropped once already. Refusing the field outright would be the
    // same bug wearing a safety label.
    await deliver(
      taintItems((item) => ({
        ...item,
        fulfilment_regions: (item.fulfilment_regions as Record<string, unknown>[]).map((r) => ({
          ...r,
          issuer_did: 'did:plc:regionissuer99',
        })),
      })),
    )

    expect(await findAnywhere('did:plc:regionissuer99')).not.toEqual([])
    expect(await projectedProductCount()).toBeGreaterThan(0)
  })

  it('drops a secret nested inside the INDICATIVE PRICE, likewise copied', async () => {
    await deliver(
      taintItems((item) =>
        item.indicative_price === undefined
          ? item
          : {
              ...item,
              indicative_price: {
                ...(item.indicative_price as Record<string, unknown>),
                cost_basis: SECRET,
              },
            },
      ),
    )

    expect(await findInProjection(SECRET)).toEqual([])
    expect(await projectedProductCount()).toBeGreaterThan(0)
  })

  it('drops a secret nested inside a CATEGORY ID, which reaches a searchable column', async () => {
    // ADDED after a reviewer found `categoryIds: [...item.category_ids]` still
    // spreading, three lines above my own comment saying the rule is about
    // depth. `catalog-search` reads this column through
    // `jsonb_array_elements_text`, so an object element sits in the searchable
    // surface exactly like the region did.
    await deliver(
      taintItems((item) => ({
        ...item,
        category_ids: [...(item.category_ids as string[]), { internal: SECRET }],
      })),
    )

    // REFUSED, not sanitized. §9.5 says a category id is an id; an object
    // there is a protocol violation, and the earlier behaviour — index the
    // product and quietly drop the bad element — turned malformed input into
    // valid-looking data. A snapshot is full state (§10.2), so the refusal is
    // the whole publication rather than a silently shorter catalog.
    expect(await findInProjection(SECRET)).toEqual([])
    expect(await projectedProductCount()).toBe(0)
  })

  it('drops a secret nested inside the PRODUCT IDENTIFIER', async () => {
    await deliver(
      taintItems((item) => ({
        ...item,
        product: { ...(item.product as Record<string, unknown>), supplier_cost: SECRET },
      })),
    )

    expect(await findInProjection(SECRET)).toEqual([])
    expect(await projectedProductCount()).toBeGreaterThan(0)
  })
})

describe('the relationship lane keeps its DERIVED edge clean', () => {
  it('does not carry a secret nested in evidence_refs onto the derived edge', async () => {
    // `evidence_json` is emitted on the wire as `relationship_evidence_refs`,
    // so an object nested here is served to buyers. Two of the five commerce
    // tables were declared in COMMERCE_TABLES and never populated by any
    // scenario, which a reviewer caught: the scan certified a surface it had
    // never actually visited.
    // REFUSED, not sanitized. §10.7 evidence refs are strings, and the old
    // behaviour coerced the object with `String()` — writing the literal
    // "[object Object]" into stored evidence, which is malformed input dressed
    // up as a real reference. Production Zod refuses this record outright, so
    // the scenario that asserted an edge SURVIVED was asserting something no
    // publisher could actually produce.
    await deliverClaim([{ nested: SECRET }])

    expect(await findAnywhere(SECRET)).toEqual([])
    expect(await projectedEdgeCount()).toBe(0)
  })

  it('does not carry a secret nested in claim_id, which is EMITTED ON THE WIRE', async () => {
    // The sharpest one. `commerce-catalog-search` reads `claimId` out of the
    // derived edge into `relationship_evidence_refs`, typed `string[]`, so an
    // object here is both stored in the derived table AND served to buyers.
    // The first pass of this fix hardened only `evidence_refs` and left this.
    await deliverClaim(['rc-1'], { claim_id: { nested: SECRET } })

    expect(await findInProjection(SECRET)).toEqual([])
  })

  it('does not carry a secret nested in effective_from', async () => {
    await deliverClaim(['rc-1'], { effective_from: { nested: SECRET } })

    expect(await findInProjection(SECRET)).toEqual([])
  })

  it('refuses a claim whose relationship is an object, rather than storing it', async () => {
    // Reached `commerce_product_relationships.relationship`, a text column the
    // scan does not exclude. The discriminant did not reject it — an object is
    // not in DID_OBJECT_RELATIONSHIPS and the claim's object is a ProductRef,
    // so `false !== false` passed — and pg serialized it into the column.
    await deliverClaim(['rc-1'], { relationship: { nested: SECRET } })

    expect(await findAnywhere(SECRET)).toEqual([])
    expect(await projectedEdgeCount()).toBe(0)
  })

  it('refuses a claim with a primitive object, rather than throwing', async () => {
    // `objectKeyOf` does `'did' in object` and raises on a primitive.
    await expect(deliverClaim(['rc-1'], { object: 'not-an-object' })).resolves.not.toThrow()

    expect(await projectedEdgeCount()).toBe(0)
  })

  it('keeps the claim itself verbatim, which is the DESIGN for raw evidence', async () => {
    // A VALID claim carrying the secret in a field that legitimately holds
    // free text. The earlier version used an OBJECT evidence reference, which
    // production Zod refuses — so it was asserting that a record no publisher
    // can actually publish gets stored verbatim, and it passed only because
    // the projection coerced the object with `String()` instead of refusing
    // it. The property under test is "raw evidence is kept verbatim", and it
    // should not depend on malformed input to demonstrate that.
    await deliverClaim([`evidence://${SECRET}`])

    // BOTH places, and both are the design: the claim table keeps what was
    // said verbatim, and §10.7 evidence refs are emitted on the wire, so a
    // supplier who puts a secret in one has published it themselves. The
    // guarantee that protects the OWNER is upstream in Core's §12.1 gate.
    expect((await findAnywhere(SECRET)).sort()).toEqual([
      'commerce_product_relationships.evidence_json (1 row(s))',
      'commerce_relationship_claims.claim_json (1 row(s))',
    ])
  })


  it('carries an honest string reference through to the derived edge', async () => {
    // The positive half: excluding objects must not mean dropping evidence.
    await deliverClaim(['rc-evidence-1'])

    expect(await findAnywhere('rc-evidence-1')).toEqual(
      expect.arrayContaining(['commerce_product_relationships.evidence_json (1 row(s))']),
    )
  })
})

describe('a malformed item is REFUSED, not thrown', () => {
  it('refuses an item with no freshness rather than crashing the ingest path', async () => {
    // A throw is not a refusal. Before this the record was neither indexed NOR
    // counted as refused, so a hostile-but-digest-valid page vanished from the
    // very metric an operator would use to notice it. Nothing upstream
    // validates item shapes — `verifyCatalogPage` checks digests, not fields.
    await expect(
      deliver(
        taintItems((item) => {
          const { freshness: _dropped, ...rest } = item
          return rest
        }),
      ),
    ).resolves.not.toThrow()

    // Refused, so nothing was projected — and crucially the handler returned.
    const out = await searchCommerceCatalog(
      db,
      { q: 'oak dining chair', limit: 5 },
      '2026-08-08T12:00:00.000Z',
    )
    expect(out.candidates).toEqual([])
  })

  it('refuses an item with no product identity, and indexes NOTHING', async () => {
    // The assertion this test was missing. `resolves.not.toThrow()` alone
    // would have passed just as well against an AppView that INDEXED the
    // malformed item — proving only that nothing crashed, which is not the
    // property. A reviewer caught it.
    await expect(
      deliver(
        taintItems((item) => {
          const { product: _dropped, ...rest } = item
          return rest
        }),
      ),
    ).resolves.not.toThrow()

    expect(await projectedProductCount()).toBe(0)
  })

  it('REFUSES a null indicative price, because the protocol does', async () => {
    // THIS TEST ONCE ASSERTED THE OPPOSITE, and the reasoning was appealing:
    // `null` is how JSON spells "no value", §10.4 makes the price optional, so
    // tolerate it. The protocol does not agree — `validateCatalogItem` checks
    // `!== undefined` and then validates, so a null price is refused — and a
    // divergence between AppView and the protocol is worse than either rule on
    // its own: AppView indexed publications every conforming consumer refuses,
    // which is an interoperability failure that looks like a working index.
    //
    // Found by an independent reviewer mutation-testing the two
    // implementations against each other, not by any hand-written case of mine.
    // The refusal is still a REFUSAL rather than a throw, which is what the
    // original guard was really protecting.
    await expect(
      deliver(taintItems((item) => ({ ...item, indicative_price: null }))),
    ).resolves.not.toThrow()

    expect(await projectedProductCount()).toBe(0)
  })

  it('refuses a product whose scheme is not a string', async () => {
    // `productKey` reads `.length` off the scheme. The declared type says it
    // is a closed union; the wire says whatever the publisher sent.
    await expect(
      deliver(
        taintItems((item) => ({
          ...item,
          product: { ...(item.product as Record<string, unknown>), scheme: { evil: true } },
        })),
      ),
    ).resolves.not.toThrow()

    expect(await projectedProductCount()).toBe(0)
  })

  it('refuses an object in brand, which would land in an ILIKE-searched column', async () => {
    // Not merely a crash risk: `brand` and `description` are `text` columns
    // that catalog-search ILIKE-matches, so an object serialized into one is
    // searchable JSON — a leak of exactly the class this file exists to close.
    await deliver(taintItems((item) => ({ ...item, brand: { nested: SECRET } })))

    expect(await findInProjection(SECRET)).toEqual([])
    expect(await projectedProductCount()).toBe(0)
  })

  it('refuses a null element inside fulfilment_regions', async () => {
    await expect(
      deliver(taintItems((item) => ({ ...item, fulfilment_regions: [null] }))),
    ).resolves.not.toThrow()

    expect(await projectedProductCount()).toBe(0)
  })
})

describe('the POINTER record is shape-checked too', () => {
  /** Deliver only a pointer, taking whichever early-return path we want. */
  async function deliverPointer(overrides: Record<string, unknown>): Promise<void> {
    await commerceCatalogPointerHandler.handleCreate?.(ctx, {
      uri: `at://${MANUFACTURER}/com.dinakernel.commerce.catalog/taint`,
      did: MANUFACTURER,
      collection: 'com.dinakernel.commerce.catalog',
      rkey: 'taint',
      record: { ...PUBLICATION.pointer, ...overrides } as unknown as Record<string, unknown>,
    } satisfies RecordOp)
  }

  async function pointerRows(): Promise<number> {
    const out = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM commerce_catalog_pointers`,
    )
    return out.rows[0]?.n ?? 0
  }

  it('refuses a pointer whose protocol_version is an object', async () => {
    // THE THIRD TABLE THE SCAN HAD NEVER VISITED. Nothing on this path checked
    // types: `verifyCatalogPointerAdvance` compares sequences and digests, and
    // both the await-snapshot and withdrawn branches return BEFORE any content
    // verification. One record from any DID reached a `text NOT NULL` column.
    await deliverPointer({ protocol_version: { nested: SECRET }, snapshot_sequence: 1 })

    expect(await findAnywhere(SECRET)).toEqual([])
    expect(await pointerRows()).toBe(0)
  })

  it('refuses a pointer whose catalog_id is an object, which would key the row', async () => {
    // `catalog_id` reaches the primary key through a template, so an object
    // became the literal string `[object Object]`.
    await deliverPointer({ catalog_id: { nested: SECRET }, snapshot_sequence: 1 })

    expect(await findAnywhere(SECRET)).toEqual([])
    expect(await pointerRows()).toBe(0)
  })

  it('refuses a WITHDRAWN pointer carrying a secret, the path that returns earliest', async () => {
    await deliverPointer({ withdrawn: true, published_at: { nested: SECRET }, snapshot_sequence: 1 })

    expect(await findAnywhere(SECRET)).toEqual([])
  })

  it('still accepts an honest pointer, so the gate is not refusing everything', async () => {
    await deliver()

    expect(await pointerRows()).toBeGreaterThan(0)
  })
})

describe('sequences are bounded by the COLUMN, not by JavaScript', () => {
  it('refuses a snapshot sequence beyond pg int4 rather than throwing on INSERT', async () => {
    // `Number.isSafeInteger` was the wrong bound: the column is `integer`, so
    // 3_000_000_000 passed the gate and made the insert raise "out of range" —
    // an unhandled throw in the lane the gate had just been added to.
    //
    // AND ASSERT THE PROPERTY, not merely the absence of a throw. "Did not
    // throw" is also true when the malformed snapshot is happily ACCEPTED and
    // stored, which is the outcome this test exists to forbid — so as written
    // it could not fail for the reason it names.
    await expect(
      deliver(undefined, true, { snapshot_sequence: 3_000_000_000 }),
    ).resolves.not.toThrow()

    const stored = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM commerce_catalog_snapshots
          WHERE snapshot_sequence = 3000000000`,
    )
    expect(stored.rows[0]?.n ?? 0).toBe(0)
    expect(await projectedProductCount()).toBe(0)
  })
})

describe('the raw snapshot column keeps what the publisher published', () => {
  it('retains the untouched pages, and that is the DESIGN rather than a leak', async () => {
    // ASSERTED OUT LOUD so nobody "fixes" it later. A snapshot store must keep
    // what it was given: the page digests are computed OVER these bytes, so
    // stripping them would leave AppView unable to re-verify its own index or
    // re-project after a schema change. And it is not new exposure — the
    // publisher put these bytes on their own public PDS; AppView copying a
    // public record does not make it more public.
    //
    // The guarantee that protects the OWNER is upstream, in Core's §12.1
    // publication gate, which is where a secret is stopped from ever becoming
    // one of these bytes. That is the sentence §25.2 is really making.
    await deliver(taintItems((item) => ({ ...item, supplier_erp_key: SECRET })))

    expect(await findAnywhere(SECRET)).toEqual(['commerce_catalog_snapshots.pages_json (1 row(s))'])
  })
})

describe('an unknown field is tolerated, a TAMPERED page is not', () => {
  it('still indexes and still answers, so the allow-list is not refusing everything', async () => {
    // §9.13's forward-compatibility law meets §25.2 here: an unknown field must
    // not make a record unindexable, or every minor version bump would empty
    // the index. Tolerated AND unprojected is the only correct pair — a test
    // that only checked the secret was absent would pass just as well against
    // an AppView that had thrown the whole catalog away.
    await deliver(taintItems((item) => ({ ...item, supplier_erp_key: SECRET })))

    const out = await searchCommerceCatalog(
      db,
      { q: 'oak dining chair', limit: 5 },
      '2026-08-08T12:00:00.000Z',
    )

    expect(out.candidates[0]?.supplier_did).toBe(MANUFACTURER)
    expect(await findInProjection(SECRET)).toEqual([])
    expect(await projectedProductCount()).toBeGreaterThan(0)
  })

  it('projects NOTHING when the pages do not match the digest they were published under', async () => {
    // Found by accident while writing this file, and worth its own test. My
    // first taint left the original digests in place, and the whole catalog
    // vanished from search — which is exactly right, and nothing had pinned
    // it. Content that does not hash to what the supplier committed to is not
    // that supplier's catalog, and indexing it would let anyone who can reach
    // the firehose edit somebody else's prices.
    await deliver(taintItems((item) => ({ ...item, name: 'REWRITTEN BY SOMEONE ELSE' })), false)

    const out = await searchCommerceCatalog(
      db,
      { q: 'oak dining chair', limit: 5 },
      '2026-08-08T12:00:00.000Z',
    )

    expect(out.candidates).toEqual([])
  })
})
