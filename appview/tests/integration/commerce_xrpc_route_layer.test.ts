/**
 * §25.4 (WS-11.4) — the commerce endpoints through the REAL route layer.
 *
 * WHAT THIS CLOSES, in the row's own words: "the xRPC route layer itself
 * (these drive `searchCommerceCatalog` directly)". Every commerce AppView test
 * so far calls the handler function with an already-parsed params object. That
 * skips the two things a caller actually meets — the route TABLE, which decides
 * whether the method exists at all, and the ZOD PARSE, which decides what a
 * query string means.
 *
 * The distinction is not academic and this repository has the scar: a
 * catalog-search test that pinned the parse helper rather than the server was
 * written, and reverting the server would have left it green. Driving the real
 * `dispatchXrpc` over the real `XRPC_ROUTES` is what makes the method id, the
 * coercion and the status codes part of what is tested.
 *
 * REAL POSTGRES underneath, because a route layer over a mock answers about
 * the mock.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { commerceCatalogPointerHandler, commerceCatalogSnapshotHandler } from '@/ingester/handlers/commerce-catalog.js'
import { attestations } from '@/db/schema/attestations.js'
import { subjects } from '@/db/schema/subjects.js'
import { dispatchXrpc } from '@/web/xrpc-dispatch.js'
import { XRPC_ROUTES } from '@/web/xrpc-routes.js'

import { cleanAllTables, createTestHandlerContext, getTestDb, type TestDB } from '../test-db.js'

import { readFileSync } from 'node:fs'
import path from 'node:path'

import type {
  CatalogPointer,
  CatalogSnapshot,
  CatalogSnapshotPage,
} from '@/shared/commerce/catalog-verify.js'
import type { RecordOp } from '@/ingester/handlers/index.js'

/** The same bytes Core publishes — see `commerce_discovery_interop.test.ts`. */
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

let db: TestDB
let ctx: ReturnType<typeof createTestHandlerContext>

/** Call the way a client does: a method id and a query string. */
async function call(methodId: string, query: string) {
  return dispatchXrpc({
    routes: XRPC_ROUTES as never,
    db,
    methodId,
    searchParams: new URLSearchParams(query),
  })
}

async function publishCatalog(): Promise<void> {
  await commerceCatalogSnapshotHandler.handleCreate?.(ctx, {
    uri: `at://${MANUFACTURER}/com.dinakernel.commerce.catalogSnapshot/${PUBLICATION.snapshot.snapshot_digest}`,
    did: MANUFACTURER,
    collection: 'com.dinakernel.commerce.catalogSnapshot',
    rkey: PUBLICATION.snapshot.snapshot_digest,
    record: { snapshot: PUBLICATION.snapshot, pages: PUBLICATION.pages } as unknown as Record<
      string,
      unknown
    >,
  } satisfies RecordOp)
  await commerceCatalogPointerHandler.handleCreate?.(ctx, {
    uri: `at://${MANUFACTURER}/com.dinakernel.commerce.catalog/${PUBLICATION.pointer.catalog_id}`,
    did: MANUFACTURER,
    collection: 'com.dinakernel.commerce.catalog',
    rkey: PUBLICATION.pointer.catalog_id,
    record: PUBLICATION.pointer as unknown as Record<string, unknown>,
  } satisfies RecordOp)
}

beforeAll(() => {
  db = getTestDb()
  ctx = createTestHandlerContext(db)
})

beforeEach(async () => {
  await cleanAllTables(db)
})

describe('the route table decides what exists', () => {
  it('serves both commerce methods', async () => {
    // The registration itself. An endpoint written and never added to the
    // table is unreachable, which is this codebase's signature defect one
    // layer up from the code.
    expect(Object.keys(XRPC_ROUTES)).toEqual(
      expect.arrayContaining([
        'com.dinakernel.commerce.searchCatalog',
        'com.dinakernel.commerce.getSupplierDimensions',
      ]),
    )
  })

  it('refuses an unknown method as a BAD REQUEST, not a server fault', async () => {
    const out = await call('com.dinakernel.commerce.nonexistent', 'q=chair')

    expect(out.status).toBe(400)
    expect((out.body as { error: string }).error).toBe('InvalidRequest')
  })

  it('does not answer a commerce query sent to a PeerLens method', async () => {
    // Method ids are exact. A dispatch that prefix-matched would let a caller
    // reach a handler that never agreed to answer their question.
    const out = await call('com.dinakernel.commerce.searchCatalog.v2', 'q=chair')
    expect(out.status).toBe(400)
  })
})

describe('the query string is parsed, not assumed', () => {
  it('coerces `limit` from a string, because a query string has no numbers', async () => {
    await publishCatalog()

    const out = await call('com.dinakernel.commerce.searchCatalog', 'q=oak+dining+chair&limit=1')

    expect(out.status).toBe(200)
    expect((out.body as { candidates: unknown[] }).candidates).toHaveLength(1)
  })

  it('applies the schema default when `limit` is absent', async () => {
    await publishCatalog()

    const out = await call('com.dinakernel.commerce.searchCatalog', 'category=furniture.seating')

    expect(out.status).toBe(200)
    expect((out.body as { candidates: unknown[] }).candidates.length).toBeGreaterThan(0)
  })

  it('refuses a limit outside the schema bound with a 400', async () => {
    // A cap a caller can talk past is not a cap. The refusal must be a bad
    // request rather than a clamp, because silently serving 50 to a caller who
    // asked for 5000 makes a truncated page look like a complete one.
    const out = await call('com.dinakernel.commerce.searchCatalog', 'q=chair&limit=99999')

    expect(out.status).toBe(400)
    expect((out.body as { error: string }).error).toBe('InvalidRequest')
  })

  it('reads a repeated parameter as a LIST', async () => {
    // `category=a&category=b` is the only way a query string expresses two
    // values. A parse that took the last one would silently narrow the search.
    await publishCatalog()

    const out = await call(
      'com.dinakernel.commerce.searchCatalog',
      'category=furniture.seating&category=furniture.tables&limit=10',
    )

    expect(out.status).toBe(200)
    expect((out.body as { candidates: unknown[] }).candidates.length).toBeGreaterThan(0)
  })

  it('refuses the dimensions query with no supplier', async () => {
    const out = await call('com.dinakernel.commerce.getSupplierDimensions', 'limit=10')

    expect(out.status).toBe(400)
    expect((out.body as { error: string }).error).toBe('InvalidRequest')
  })
})

describe('a retailer’s whole question, over the wire', () => {
  it('finds a manufacturer and asks what reviewers said about them', async () => {
    // The two commerce endpoints in the order a buyer uses them, each through
    // the dispatch: discovery answers WHO, dimensions answer WHAT IS SAID.
    await publishCatalog()
    await db
      .insert(subjects)
      .values({ id: 'subj-cm', did: MANUFACTURER, name: 'ChairMaker', subjectType: 'business' })
    await db.insert(attestations).values({
      uri: 'at://did:plc:reviewer0001/a/1',
      authorDid: 'did:plc:reviewer0001',
      cid: 'bafy-review-1',
      subjectId: 'subj-cm',
      subjectRefRaw: { did: MANUFACTURER },
      // The SUBJECT's category, and the reviewer's per-dimension verdict kept
      // apart. This seeded `category: 'fulfilment'` — a §14.4 dimension name in
      // the subject-category column — which matched the route's own mistake of
      // reading `category` AS the dimension. Fixture and defect agreed, so the
      // endpoint looked alive while returning nothing for any real publisher.
      category: 'commerce/product',
      dimensionsJson: [{ dimension: 'fulfilment', value: 'met' }],
      sentiment: 'positive',
      recordCreatedAt: new Date('2026-08-08T09:00:00.000Z'),
    })

    const found = await call('com.dinakernel.commerce.searchCatalog', 'q=oak+dining+chair&limit=5')
    expect(found.status).toBe(200)
    const supplier = (found.body as { candidates: { supplier_did: string }[] }).candidates[0]
      ?.supplier_did
    expect(supplier).toBe(MANUFACTURER)

    const said = await call(
      'com.dinakernel.commerce.getSupplierDimensions',
      `supplier=${encodeURIComponent(supplier ?? '')}&limit=10`,
    )

    expect(said.status).toBe(200)
    const body = said.body as { dimensions: { dimension: string }[] }
    expect(body.dimensions.map((d) => d.dimension)).toEqual(['fulfilment'])
  })

  it('answers an unknown supplier with an empty answer, not an error', async () => {
    // "Nobody has reviewed them" is a fact about the world, and a 404 would
    // make a buyer think their question was malformed.
    const out = await call(
      'com.dinakernel.commerce.getSupplierDimensions',
      'supplier=did%3Aplc%3Anobody000001&limit=10',
    )

    expect(out.status).toBe(200)
    expect((out.body as { dimensions: unknown[] }).dimensions).toEqual([])
  })
})
