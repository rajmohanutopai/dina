/**
 * The two Jetstream catalog handlers (§10.2, FR-A6).
 *
 * The DECISIONS are tested purely in `commerce_catalog_ingest_decision`. What
 * is left for a handler test is the part a pure function cannot express: that
 * the handler reaches the decision at all, that it hands it the right
 * predecessor, and that a full-state replacement deletes before it inserts
 * inside ONE transaction — a reader must never see the new catalog half
 * applied over the old one.
 *
 * The database is a stub that records the call sequence, in the same style as
 * `service_profile_handler`. That is a real limit and worth naming: it proves
 * the ORDER of operations, not that the SQL is valid. The integration suite
 * against real Postgres is where the second claim belongs.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  commerceCatalogPointerHandler,
  commerceCatalogSnapshotHandler,
} from '@/ingester/handlers/commerce-catalog.js'
import {
  commerceCatalogPointers,
  commerceCatalogProducts,
  commerceCatalogSnapshots,
} from '@/db/schema/index.js'
import {
  catalogPageDigest,
  catalogPayloadRoot,
  catalogSnapshotDigest,
  type CatalogPointer,
  type CatalogSnapshot,
  type CatalogSnapshotPage,
} from '@/shared/commerce/catalog-verify.js'

import type { HandlerContext, RecordOp } from '@/ingester/handlers/index.js'

const SUPPLIER = 'did:plc:chairmaker99'
const CATALOG = 'chairmaker-main'

function catalogItem(sku: string) {
  return {
    product: { scheme: 'manufacturer_sku', value: sku, issuer_did: SUPPLIER },
    supplier_did: SUPPLIER,
    catalog_id: CATALOG,
    item_revision: '1',
    name: `Chair ${sku}`,
    category_ids: ['furniture.seating'],
    // §9.5 requires `pack`; this fixture omitted it, so the cases here were
    // driving items no conformant publisher could publish.
    pack: { sell_unit: { unit_code: 'each', value: '1' } },
    fulfilment_regions: [{ scheme: 'admin_area', value: 'IN-KA' }],
    freshness: { generated_at: '2026-08-08T09:00:00.000Z' },
  }
}

/**
 * A TWO-PAGE publication, one item per page.
 *
 * `publication()` always emits a single page, which is fine for the chain tests
 * but cannot express the defect below: with one committed page there is nothing
 * for a duplicate to displace, so the count check alone catches it. Coverage
 * only becomes a distinct rule once there are at least two slots to fill.
 */
function twoPagePublication(sequence: number, skus: [string, string]) {
  const pages: CatalogSnapshotPage[] = skus.map((sku, i) => {
    const draft: CatalogSnapshotPage = {
      catalog_id: CATALOG,
      snapshot_sequence: sequence,
      page_index: i,
      items: [catalogItem(sku)],
      page_digest: '',
    }
    return { ...draft, page_digest: catalogPageDigest(draft) }
  })
  const digests = pages.map((p) => p.page_digest)
  const draft: CatalogSnapshot = {
    supplier_did: SUPPLIER,
    catalog_id: CATALOG,
    snapshot_sequence: sequence,
    protocol_version: '1.0',
    published_at: '2026-08-08T09:00:00.000Z',
    page_digests: digests,
    item_count: skus.length,
    payload_root: catalogPayloadRoot(digests),
    snapshot_digest: '',
  }
  const snapshot: CatalogSnapshot = { ...draft, snapshot_digest: catalogSnapshotDigest(draft) }
  return { snapshot, pages }
}

function publication(sequence: number, skus: string[], previousDigest?: string) {
  const draftPage: CatalogSnapshotPage = {
    catalog_id: CATALOG,
    snapshot_sequence: sequence,
    page_index: 0,
    items: skus.map(catalogItem),
    page_digest: '',
  }
  const page = { ...draftPage, page_digest: catalogPageDigest(draftPage) }
  const draft: CatalogSnapshot = {
    supplier_did: SUPPLIER,
    catalog_id: CATALOG,
    snapshot_sequence: sequence,
    protocol_version: '1.0',
    published_at: '2026-08-08T09:00:00.000Z',
    page_digests: [page.page_digest],
    item_count: skus.length,
    payload_root: catalogPayloadRoot([page.page_digest]),
    snapshot_digest: '',
  }
  const snapshot: CatalogSnapshot = { ...draft, snapshot_digest: catalogSnapshotDigest(draft) }
  const pointer: CatalogPointer = {
    supplier_did: SUPPLIER,
    catalog_id: CATALOG,
    snapshot_sequence: sequence,
    protocol_version: '1.0',
    published_at: '2026-08-08T09:00:00.000Z',
    snapshot_rkey: snapshot.snapshot_digest,
    snapshot_digest: snapshot.snapshot_digest,
    ...(previousDigest === undefined ? {} : { previous_snapshot_digest: previousDigest }),
  }
  return { pointer, snapshot, pages: [page] }
}

interface Recorded {
  events: string[]
  inserted: Record<string, unknown[]>
}

function tableName(table: unknown): string {
  if (table === commerceCatalogPointers) return 'pointers'
  if (table === commerceCatalogProducts) return 'products'
  if (table === commerceCatalogSnapshots) return 'snapshots'
  return 'unknown'
}

/**
 * A stub drizzle handle. `selects` is a queue: each `select()` chain consumes
 * the next entry, so a test says what the handler will find, in order.
 */
function stubDb(recorded: Recorded, selects: unknown[][]) {
  const queue = [...selects]
  const handle = (prefix: string): Record<string, unknown> => ({
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            recorded.events.push(`${prefix}select:${tableName(table)}`)
            return queue.shift() ?? []
          },
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (v: unknown) => {
        const name = tableName(table)
        recorded.events.push(`${prefix}insert:${name}`)
        recorded.inserted[name] = (recorded.inserted[name] ?? []).concat(
          Array.isArray(v) ? v : [v],
        )
        const done = Promise.resolve()
        return Object.assign(done, {
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
    update: (table: unknown) => ({
      set: () => ({
        where: async () => {
          recorded.events.push(`${prefix}update:${tableName(table)}`)
        },
      }),
    }),
    transaction: async (fn: (tx: unknown) => Promise<void>) => {
      recorded.events.push('tx:begin')
      await fn(handle('tx:'))
      recorded.events.push('tx:commit')
    },
  })
  return handle('')
}

function stubCtx(recorded: Recorded, selects: unknown[][]): HandlerContext {
  return {
    db: stubDb(recorded, selects) as unknown as HandlerContext['db'],
    logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } as never,
    metrics: { incr: vi.fn() } as never,
  }
}

function op(record: Record<string, unknown>, rkey = 'self'): RecordOp {
  return {
    uri: `at://${SUPPLIER}/com.dinakernel.commerce.catalog/${rkey}`,
    did: SUPPLIER,
    collection: 'com.dinakernel.commerce.catalog',
    rkey,
    record,
  }
}

describe('the catalog pointer handler', () => {
  it('indexes products and the pointer in one transaction, delete before insert', async () => {
    const { pointer, snapshot, pages } = publication(1, ['CHAIR-1', 'CHAIR-2'])
    const recorded: Recorded = { events: [], inserted: {} }
    const ctx = stubCtx(recorded, [
      [], // no current pointer
      [{ snapshotJson: snapshot, pagesJson: pages }], // the snapshot it names
    ])

    await commerceCatalogPointerHandler.handleCreate(ctx, op(pointer as never))

    // A snapshot is full state: the old rows go before the new ones land, and
    // both happen inside one transaction so no reader sees the gap.
    expect(recorded.events).toEqual([
      'select:pointers',
      'select:snapshots',
      'tx:begin',
      'tx:delete:products',
      'tx:insert:products',
      'tx:insert:pointers',
      'tx:commit',
    ])
    expect(recorded.inserted.products).toHaveLength(2)
  })

  it('holds a pointer whose snapshot has not arrived, indexing nothing', async () => {
    const { pointer } = publication(1, ['CHAIR-1'])
    const recorded: Recorded = { events: [], inserted: {} }
    const ctx = stubCtx(recorded, [[], []])

    await commerceCatalogPointerHandler.handleCreate(ctx, op(pointer as never))

    expect(recorded.events).toContain('insert:pointers')
    // Nothing was deleted and nothing was indexed: the previously published
    // catalog stays queryable, which is the honest fallback.
    expect(recorded.events).not.toContain('tx:delete:products')
    expect(recorded.inserted.products).toBeUndefined()
    expect(recorded.inserted.pointers?.[0]).toMatchObject({ awaitingSnapshot: true })
  })

  it('does not treat a PENDING pointer as the predecessor', async () => {
    // A held pointer indexed nothing. Treating it as current would make the
    // chain refuse the supplier's next publication for a gap they did not
    // create — and the supplier would have no way to see why.
    const { pointer } = publication(1, ['CHAIR-1'])
    const recorded: Recorded = { events: [], inserted: {} }
    const ctx = stubCtx(recorded, [
      [
        {
          id: `${SUPPLIER}/${CATALOG}`,
          supplierDid: SUPPLIER,
          catalogId: CATALOG,
          snapshotSequence: 7,
          protocolVersion: '1.0',
          publishedAt: '2026-08-01T00:00:00.000Z',
          snapshotDigest: 'a'.repeat(64),
          previousSnapshotDigest: null,
          withdrawn: false,
          awaitingSnapshot: true,
        },
      ],
      [],
    ])

    await commerceCatalogPointerHandler.handleCreate(ctx, op(pointer as never))

    // Sequence 1 against a pending sequence 7 would be a rollback if the
    // pending row counted. It is held instead.
    expect(recorded.inserted.pointers?.[0]).toMatchObject({ awaitingSnapshot: true })
  })

  it('removes the products but keeps the tombstone on withdrawal (FR-A6)', async () => {
    const first = publication(1, ['CHAIR-1'])
    const tombstone = {
      supplier_did: SUPPLIER,
      catalog_id: CATALOG,
      snapshot_sequence: 2,
      protocol_version: '1.0',
      published_at: '2026-09-01T00:00:00.000Z',
      previous_snapshot_digest: first.snapshot.snapshot_digest,
      withdrawn: true,
    }
    const recorded: Recorded = { events: [], inserted: {} }
    const ctx = stubCtx(recorded, [
      [
        {
          id: `${SUPPLIER}/${CATALOG}`,
          supplierDid: SUPPLIER,
          catalogId: CATALOG,
          snapshotSequence: 1,
          protocolVersion: '1.0',
          publishedAt: '2026-08-08T09:00:00.000Z',
          snapshotDigest: first.snapshot.snapshot_digest,
          previousSnapshotDigest: null,
          withdrawn: false,
          awaitingSnapshot: false,
        },
      ],
    ])

    await commerceCatalogPointerHandler.handleCreate(ctx, op(tombstone))

    expect(recorded.events).toContain('tx:delete:products')
    // The row SURVIVES: it is what refuses a later publication under the same
    // catalog_id, which is the signal a buyer needs to see.
    expect(recorded.inserted.pointers?.[0]).toMatchObject({
      withdrawn: true,
      snapshotDigest: null,
    })
  })

  it('writes nothing when the record names a different supplier', async () => {
    const { pointer } = publication(1, ['CHAIR-1'])
    const recorded: Recorded = { events: [], inserted: {} }
    const ctx = stubCtx(recorded, [[], []])

    await commerceCatalogPointerHandler.handleCreate(ctx, {
      ...op(pointer as never),
      did: 'did:plc:rivalchairs01',
    })

    expect(recorded.inserted).toEqual({})
    expect(recorded.events).not.toContain('tx:begin')
  })
})

describe('the catalog snapshot handler', () => {
  it('stores a snapshot no pointer names, and indexes nothing', async () => {
    const { snapshot, pages } = publication(1, ['CHAIR-1'])
    const recorded: Recorded = { events: [], inserted: {} }
    const ctx = stubCtx(recorded, [[]]) // no pending pointer

    await commerceCatalogSnapshotHandler.handleCreate(ctx, op({ snapshot, pages }))

    expect(recorded.inserted.snapshots).toHaveLength(1)
    // A snapshot no pointer names is a draft. Indexing it is how a withdrawn
    // or superseded catalog comes back to life.
    expect(recorded.inserted.products).toBeUndefined()
  })

  it('refuses a snapshot that serves one page twice and omits another', async () => {
    // PER-PAGE VERIFICATION DOES NOT ADD UP TO A WHOLE. Each page answers
    // "do I belong to this snapshot, at the slot I claim?" about ITSELF, so
    // serving page 0 twice passed: the count matched, both copies verified at
    // index 0, and a committed page was simply never presented. The catalog
    // then projected is not the catalog the supplier published — and it lands
    // under the global digest key, where `onConflictDoNothing` stops the
    // correct bytes from ever replacing it.
    const { snapshot, pages } = twoPagePublication(1, ['CHAIR-1', 'CHAIR-2'])
    expect(pages.length).toBe(2)
    const recorded: Recorded = { events: [], inserted: {} }
    const ctx = stubCtx(recorded, [[]])

    await commerceCatalogSnapshotHandler.handleCreate(
      ctx,
      op({ snapshot, pages: [pages[0], pages[0]] }),
    )

    expect(recorded.inserted.snapshots).toBeUndefined()
    expect(ctx.metrics.incr).toHaveBeenCalledWith('ingester.commerce_catalog.refused')
  })

  it('refuses a snapshot whose claimed digest does not commit to its bytes', async () => {
    // DIGEST SQUATTING. `snapshot_digest` is the primary key of a globally
    // shared table and it arrives as a claim. Storing before verifying let an
    // attacker occupy the digest the real supplier is about to publish under:
    // their row lands first, `onConflictDoNothing` then DISCARDS the genuine
    // snapshot, and the supplier's pointer resolves to the attacker's bytes —
    // so their catalog is refused for as long as the squatted row survives.
    const { snapshot, pages } = publication(1, ['CHAIR-1'])
    const squatted = { ...snapshot, item_count: snapshot.item_count + 41 }
    const recorded: Recorded = { events: [], inserted: {} }
    const ctx = stubCtx(recorded, [[]])

    await commerceCatalogSnapshotHandler.handleCreate(ctx, op({ snapshot: squatted, pages }))

    expect(recorded.inserted.snapshots).toBeUndefined()
    expect(ctx.metrics.incr).toHaveBeenCalledWith('ingester.commerce_catalog.refused')
  })

  it('refuses a snapshot published in a repo that is not its supplier', async () => {
    const { snapshot, pages } = publication(1, ['CHAIR-1'])
    const recorded: Recorded = { events: [], inserted: {} }
    const ctx = stubCtx(recorded, [[]])

    await commerceCatalogSnapshotHandler.handleCreate(ctx, {
      ...op({ snapshot, pages }),
      did: 'did:plc:rivalchairs01',
    })

    expect(recorded.inserted.snapshots).toBeUndefined()
    expect(ctx.metrics.incr).toHaveBeenCalledWith('ingester.commerce_catalog.refused')
  })

  it('indexes when it completes a held pointer', async () => {
    const { snapshot, pages } = publication(1, ['CHAIR-1', 'CHAIR-2'])
    const recorded: Recorded = { events: [], inserted: {} }
    const ctx = stubCtx(recorded, [
      [
        {
          id: `${SUPPLIER}/${CATALOG}`,
          uri: `at://${SUPPLIER}/com.dinakernel.commerce.catalog/self`,
          supplierDid: SUPPLIER,
          catalogId: CATALOG,
          snapshotSequence: 1,
          protocolVersion: '1.0',
          publishedAt: '2026-08-08T09:00:00.000Z',
          snapshotDigest: snapshot.snapshot_digest,
          previousSnapshotDigest: null,
          withdrawn: false,
          awaitingSnapshot: true,
        },
      ],
      [], // and no CURRENT pointer for that catalog
    ])

    await commerceCatalogSnapshotHandler.handleCreate(ctx, op({ snapshot, pages }))

    expect(recorded.inserted.products).toHaveLength(2)
    expect(recorded.inserted.pointers?.[0]).toMatchObject({ awaitingSnapshot: false })
  })

  it('refuses a snapshot record whose pages are absent or over the caps', async () => {
    const { snapshot } = publication(1, ['CHAIR-1'])
    const recorded: Recorded = { events: [], inserted: {} }
    const ctx = stubCtx(recorded, [[]])

    // Refused, not truncated: half a catalog published as if it were the whole
    // one omits products with nothing in the record to say so.
    await commerceCatalogSnapshotHandler.handleCreate(ctx, op({ snapshot }))
    expect(recorded.inserted).toEqual({})

    const oversized = {
      snapshot,
      pages: [{ ...({ items: new Array(501).fill({}) } as object) }],
    }
    await commerceCatalogSnapshotHandler.handleCreate(ctx, op(oversized))
    expect(recorded.inserted).toEqual({})
  })
})

/**
 * The wiring, asserted rather than assumed.
 *
 * This repo's most common defect is a correct module nothing calls. Three
 * registries have to agree before a catalog record reaches any of the code
 * above — the collection list the consumer subscribes to, the schema map the
 * validator looks in, and the handler map the dispatcher routes through — and
 * a record silently ignored looks exactly like a supplier who published
 * nothing.
 */
describe('a catalog record can actually reach the handlers', () => {
  it('is subscribed, validated, and routed', async () => {
    const { TRUST_COLLECTIONS } = await import('@/config/lexicons.js')
    const { hasSchema, validateRecord } = await import('@/ingester/record-validator.js')
    const { routeHandler } = await import('@/ingester/handlers/index.js')

    for (const collection of [
      'com.dinakernel.commerce.catalog',
      'com.dinakernel.commerce.catalogSnapshot',
      'com.dinakernel.commerce.relationshipClaim',
    ]) {
      expect(TRUST_COLLECTIONS as readonly string[]).toContain(collection)
      expect(hasSchema(collection)).toBe(true)
      expect(routeHandler(collection)).not.toBeNull()
    }

    const { pointer, snapshot, pages } = publication(1, ['CHAIR-1'])
    expect(validateRecord('com.dinakernel.commerce.catalog', pointer).success).toBe(true)
    expect(
      validateRecord('com.dinakernel.commerce.catalogSnapshot', { snapshot, pages }).success,
    ).toBe(true)
  })

  it('exposes the §10.5 search method on the xRPC surface', async () => {
    // Ingesting a catalog nobody can query is the same defect as an orphan,
    // one layer out: the index fills up and discovery still returns nothing.
    //
    // Reads the TABLE, not the server's source. This used to grep `server.ts`
    // for two substrings, which pinned a spelling rather than a registration —
    // it would have passed a route registered under a typo'd method id, and it
    // broke the moment the table moved to its own module without any behaviour
    // changing. The table is now importable, so ask it.
    const { XRPC_ROUTES } = await import('@/web/xrpc-routes.js')
    const route = XRPC_ROUTES['com.dinakernel.commerce.searchCatalog']
    expect(route).toBeDefined()
    expect(typeof route?.handler).toBe('function')
    expect(typeof route?.params.parse).toBe('function')
  })

  it('refuses a pointer that both names a snapshot and claims to be a withdrawal', async () => {
    // A tombstone names no snapshot; a live pointer must name one. Accepting
    // both at once would leave a consumer unsure whether the catalog is live
    // at that record.
    const { pointer } = publication(1, ['CHAIR-1'])
    const { validateRecord } = await import('@/ingester/record-validator.js')
    expect(
      validateRecord('com.dinakernel.commerce.catalog', { ...pointer, withdrawn: true }).success,
    ).toBe(false)
  })
})
