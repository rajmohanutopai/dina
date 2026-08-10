/**
 * What AppView does with an arriving catalog record (§10.2, §10.4, FR-A6).
 *
 * The cases that matter are the ones a database test would not think to
 * write: the two Jetstream delivery orders, and every way a record can look
 * legal while belonging to somebody else.
 */

import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  decideCatalogPointer,
  decideCatalogSnapshot,
} from '@/shared/commerce/catalog-ingest-decision.js'
import {
  canonicalJson,
  catalogPageDigest,
  catalogPayloadRoot,
  catalogSnapshotDigest,
  type CatalogPointer,
  type CatalogSnapshot,
  type CatalogSnapshotPage,
} from '@/shared/commerce/catalog-verify.js'

const SUPPLIER = 'did:plc:chairmaker99'
const CATALOG = 'chairmaker-main'
const RIVAL = 'did:plc:rivalchairs01'

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

/** A whole publication, built the way a supplier's node would build one. */
function publication(sequence: number, skus: string[], previousDigest?: string) {
  const pages: CatalogSnapshotPage[] = skus.map((sku, index) => {
    const draft: CatalogSnapshotPage = {
      catalog_id: CATALOG,
      snapshot_sequence: sequence,
      page_index: index,
      items: [catalogItem(sku)],
      page_digest: '',
    }
    return { ...draft, page_digest: catalogPageDigest(draft) }
  })
  const pageDigests = pages.map((p) => p.page_digest)
  const draft: CatalogSnapshot = {
    supplier_did: SUPPLIER,
    catalog_id: CATALOG,
    snapshot_sequence: sequence,
    protocol_version: '1.0',
    published_at: '2026-08-08T09:00:00.000Z',
    page_digests: pageDigests,
    item_count: skus.length,
    payload_root: catalogPayloadRoot(pageDigests),
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
  return { pointer, snapshot, pages }
}

describe('the two Jetstream delivery orders reach the same index', () => {
  it('indexes when the snapshot arrives first', () => {
    const { pointer, snapshot, pages } = publication(1, ['CHAIR-1', 'CHAIR-2'])

    // Snapshot first: stored as evidence, NOT indexed. A snapshot no pointer
    // names is a draft, and indexing it is how a superseded catalog comes
    // back to life.
    const stored = decideCatalogSnapshot({
      repoDid: SUPPLIER,
      snapshot,
      pages,
      pendingPointer: null,
      previous: null,
    })
    expect(stored).toEqual({ kind: 'store_snapshot', snapshotDigest: snapshot.snapshot_digest })

    const indexed = decideCatalogPointer({
      previous: null,
      pointer,
      repoDid: SUPPLIER,
      snapshot: { snapshot, pages },
    })
    expect(indexed.kind).toBe('index')
    if (indexed.kind !== 'index') throw new Error(JSON.stringify(indexed))
    expect(indexed.rows).toHaveLength(2)
  })

  it('indexes when the pointer arrives first', () => {
    const { pointer, snapshot, pages } = publication(1, ['CHAIR-1', 'CHAIR-2'])

    const held = decideCatalogPointer({
      previous: null,
      pointer,
      repoDid: SUPPLIER,
      snapshot: null,
    })
    expect(held).toEqual({ kind: 'await_snapshot', pointer })

    // …and the snapshot, arriving into a held pointer, indexes through the
    // SAME decision. Two copies of "what is current" would eventually
    // disagree, which is the disagreement the pointer exists to settle.
    const indexed = decideCatalogSnapshot({
      repoDid: SUPPLIER,
      snapshot,
      pages,
      pendingPointer: pointer,
      previous: null,
    })
    expect(indexed.kind).toBe('index')
    if (indexed.kind !== 'index') throw new Error(JSON.stringify(indexed))
    expect(indexed.rows.map((r) => r.name)).toEqual(['Chair CHAIR-1', 'Chair CHAIR-2'])
  })
})

describe('advancing and retiring a catalog', () => {
  it('replaces the whole catalog on the next snapshot (§10.2 full state)', () => {
    const first = publication(1, ['CHAIR-1', 'CHAIR-2'])
    const second = publication(2, ['CHAIR-2'], first.snapshot.snapshot_digest)

    const action = decideCatalogPointer({
      previous: first.pointer,
      pointer: second.pointer,
      repoDid: SUPPLIER,
      snapshot: { snapshot: second.snapshot, pages: second.pages },
    })
    expect(action.kind).toBe('index')
    if (action.kind !== 'index') throw new Error(JSON.stringify(action))
    // CHAIR-1 is gone because the new snapshot does not carry it — a
    // full-state replacement, not a merge.
    expect(action.rows.map((r) => r.name)).toEqual(['Chair CHAIR-2'])
  })

  it('withdraws rather than indexing an empty catalog (FR-A6)', () => {
    const first = publication(1, ['CHAIR-1'])
    const tombstone: CatalogPointer = {
      supplier_did: SUPPLIER,
      catalog_id: CATALOG,
      snapshot_sequence: 2,
      protocol_version: '1.0',
      published_at: '2026-09-01T00:00:00.000Z',
      previous_snapshot_digest: first.snapshot.snapshot_digest,
      withdrawn: true,
    }
    expect(
      decideCatalogPointer({
        previous: first.pointer,
        pointer: tombstone,
        repoDid: SUPPLIER,
        snapshot: null,
      }),
    ).toEqual({ kind: 'withdraw', pointer: tombstone })
  })

  it('refuses a publication that follows a withdrawal', () => {
    const first = publication(1, ['CHAIR-1'])
    const tombstone: CatalogPointer = {
      ...first.pointer,
      snapshot_sequence: 2,
      previous_snapshot_digest: first.snapshot.snapshot_digest,
      withdrawn: true,
      snapshot_rkey: undefined,
      snapshot_digest: undefined,
    }
    const relaunch = publication(3, ['CHAIR-9'], first.snapshot.snapshot_digest)
    const action = decideCatalogPointer({
      previous: tombstone,
      pointer: relaunch.pointer,
      repoDid: SUPPLIER,
      snapshot: { snapshot: relaunch.snapshot, pages: relaunch.pages },
    })
    expect(action).toEqual({
      kind: 'refuse',
      reason: 'pointer chain: this catalog was withdrawn; publish under a new catalog_id',
    })
  })

  it('refuses a sequence gap rather than indexing what it can see', () => {
    const first = publication(1, ['CHAIR-1'])
    const third = publication(3, ['CHAIR-3'], first.snapshot.snapshot_digest)
    const action = decideCatalogPointer({
      previous: first.pointer,
      pointer: third.pointer,
      repoDid: SUPPLIER,
      snapshot: { snapshot: third.snapshot, pages: third.pages },
    })
    expect(action.kind).toBe('refuse')
    if (action.kind !== 'refuse') throw new Error(JSON.stringify(action))
    expect(action.reason).toContain('sequence gap')
  })
})

describe('records that look legal and belong to somebody else', () => {
  it('refuses a pointer naming a supplier other than the publishing repo', () => {
    // The cheapest possible attack on a discovery index: publish a catalog in
    // your own repo, name a rival as the supplier.
    const { pointer, snapshot, pages } = publication(1, ['CHAIR-1'])
    expect(
      decideCatalogPointer({
        previous: null,
        pointer,
        repoDid: RIVAL,
        snapshot: { snapshot, pages },
      }),
    ).toEqual({ kind: 'refuse', reason: 'pointer: supplier_did is not the publishing repo' })
  })

  it('refuses a snapshot naming a supplier other than the publishing repo', () => {
    const { snapshot, pages } = publication(1, ['CHAIR-1'])
    expect(
      decideCatalogSnapshot({
        repoDid: RIVAL,
        snapshot,
        pages,
        pendingPointer: null,
        previous: null,
      }),
    ).toEqual({ kind: 'refuse', reason: 'snapshot: supplier_did is not the publishing repo' })
  })

  it('refuses a pointer that names a snapshot it was not published with', () => {
    // Both records verify individually. Only the binding is wrong, which is
    // how a supplier would advance the chain while serving last week's terms.
    const current = publication(1, ['CHAIR-1'])
    const other = publication(1, ['CHAIR-9'])
    const action = decideCatalogPointer({
      previous: null,
      pointer: current.pointer,
      repoDid: SUPPLIER,
      snapshot: { snapshot: other.snapshot, pages: other.pages },
    })
    expect(action.kind).toBe('refuse')
    if (action.kind !== 'refuse') throw new Error(JSON.stringify(action))
    expect(action.reason).toBe('pointer: does not name this snapshot')
  })

  it('refuses a page edited on the way to the index', () => {
    const { pointer, snapshot, pages } = publication(1, ['CHAIR-1'])
    const tampered = JSON.parse(JSON.stringify(pages)) as CatalogSnapshotPage[]
    ;(tampered[0]!.items[0] as { name: string }).name = 'Chair CHAIR-1 (clearance)'
    const action = decideCatalogPointer({
      previous: null,
      pointer,
      repoDid: SUPPLIER,
      snapshot: { snapshot, pages: tampered },
    })
    expect(action.kind).toBe('refuse')
    if (action.kind !== 'refuse') throw new Error(JSON.stringify(action))
    expect(action.reason).toContain('does not match the digest')
  })

  it('refuses the whole snapshot when one item is unprojectable', () => {
    // Leaves the previous catalog indexed. An empty index reads to a buyer as
    // "this supplier stocks nothing", which is a worse lie than a stale page.
    const { pointer, snapshot, pages } = (() => {
      const bad = catalogItem('NO-ISSUER') as Record<string, unknown>
      bad.product = { scheme: 'manufacturer_sku', value: 'NO-ISSUER' }
      const draft: CatalogSnapshotPage = {
        catalog_id: CATALOG,
        snapshot_sequence: 1,
        page_index: 0,
        items: [catalogItem('CHAIR-1'), bad],
        page_digest: '',
      }
      const page = { ...draft, page_digest: catalogPageDigest(draft) }
      const snapDraft: CatalogSnapshot = {
        supplier_did: SUPPLIER,
        catalog_id: CATALOG,
        snapshot_sequence: 1,
        protocol_version: '1.0',
        published_at: '2026-08-08T09:00:00.000Z',
        page_digests: [page.page_digest],
        item_count: 2,
        payload_root: catalogPayloadRoot([page.page_digest]),
        snapshot_digest: '',
      }
      const snap = { ...snapDraft, snapshot_digest: catalogSnapshotDigest(snapDraft) }
      return {
        snapshot: snap,
        pages: [page],
        pointer: {
          supplier_did: SUPPLIER,
          catalog_id: CATALOG,
          snapshot_sequence: 1,
          protocol_version: '1.0',
          published_at: '2026-08-08T09:00:00.000Z',
          snapshot_rkey: snap.snapshot_digest,
          snapshot_digest: snap.snapshot_digest,
        } satisfies CatalogPointer,
      }
    })()

    const action = decideCatalogPointer({
      previous: null,
      pointer,
      repoDid: SUPPLIER,
      snapshot: { snapshot, pages },
    })
    expect(action.kind).toBe('refuse')
    if (action.kind !== 'refuse') throw new Error(JSON.stringify(action))
    expect(action.findings?.[0]?.refusal).toBe('unattributed_identifier')
  })
})

describe('the digests this AppView computes', () => {
  it('are domain-separated from anything else that hashes JSON', () => {
    // Without the prefix, a page and any other record with the same canonical
    // bytes would share a digest, and a commitment to one would be a
    // commitment to the other.
    const page: CatalogSnapshotPage = {
      catalog_id: CATALOG,
      snapshot_sequence: 1,
      page_index: 0,
      items: [],
      page_digest: '',
    }
    const { page_digest: _drop, ...rest } = page
    const undomained = createHash('sha256').update(canonicalJson(rest), 'utf8').digest('hex')
    expect(catalogPageDigest(page)).not.toBe(undomained)
  })
})
