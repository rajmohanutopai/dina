/**
 * The catalog projection: exact variants, never merged by name (FR-A3, FR-A5,
 * FR-A7, §9.3, §9.4).
 *
 * Almost every case here is the same property stated a different way: an index
 * that merges two product identities answers a buyer's question about product
 * A with product B's reviews, and nothing downstream can tell that it did.
 */

import { describe, expect, it } from 'vitest'

import {
  productKey,
  projectCatalogSnapshot,
  type CatalogItemShape,
} from '@/shared/commerce/catalog-projection.js'

const SUPPLIER = 'did:plc:chairmaker99'
const CATALOG = 'chairmaker-main'

function item(overrides: Partial<CatalogItemShape> = {}): CatalogItemShape {
  return {
    product: { scheme: 'manufacturer_sku', value: 'CHAIR-1', issuer_did: SUPPLIER },
    supplier_did: SUPPLIER,
    catalog_id: CATALOG,
    item_revision: '1',
    name: 'Oak dining chair',
    category_ids: ['furniture.seating'],
    // `pack` is REQUIRED by §9.5 and this fixture omitted it, so every case in
    // this file was projecting an item no conformant publisher could publish —
    // and passing, because the projection checked a handful of shallow types
    // rather than the protocol's rules.
    pack: { sell_unit: { unit_code: 'each', value: '1' } },
    fulfilment_regions: [{ scheme: 'admin_area', value: 'IN-KA' }],
    freshness: { generated_at: '2026-08-08T09:00:00.000Z' },
    ...overrides,
  }
}

function project(items: CatalogItemShape[]) {
  return projectCatalogSnapshot({
    supplierDid: SUPPLIER,
    catalogId: CATALOG,
    snapshotSequence: 1,
    snapshotDigest: 'a'.repeat(64),
    items,
  })
}

describe('product identity', () => {
  it('separates two products that share a name', () => {
    // Names are labels. Two suppliers, or two variants, may use one.
    const result = project([
      item({ product: { scheme: 'gtin', value: '05012345678900' } }),
      item({ product: { scheme: 'gtin', value: '05012345678917' } }),
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(JSON.stringify(result.findings))
    expect(new Set(result.rows.map((r) => r.productKey)).size).toBe(2)
  })

  it('keeps exact variants apart when they share an identifier', () => {
    // `variant_digest` is what distinguishes them, so dropping it from the key
    // is precisely the merge FR-A3 forbids.
    const base = { scheme: 'gtin', value: '05012345678900' } as const
    expect(productKey({ ...base, variant_digest: 'b'.repeat(64) })).not.toBe(
      productKey({ ...base, variant_digest: 'c'.repeat(64) }),
    )
  })

  it('cannot be spliced into a collision', () => {
    // The encoding is length-prefixed for this reason: a `custom` value is an
    // arbitrary bounded string, so any separator character can appear inside
    // one field and impersonate the boundary to the next.
    //
    // These two refs are the EXACT collision a plain `join(':')` produces —
    // both render `custom:A:B:C:`. A first version of this test used a pair
    // that only looked like a collision, and the separator-joining mutation
    // survived: the two keys differed by one character in a place neither
    // assertion looked at. Constructing the real collision is the whole test.
    const a = productKey({ scheme: 'custom', value: 'A:B', issuer_did: 'C' })
    const b = productKey({ scheme: 'custom', value: 'A', issuer_did: 'B:C' })
    expect(a).not.toBe(b)
  })

  it('indexes every identifier an item claims, not only its primary', () => {
    // A buyer holding the GTIN and a buyer holding the supplier SKU are asking
    // about the same product, and both must find it.
    const result = project([
      item({ identifiers: [{ scheme: 'gtin', value: '05012345678900' }] }),
    ])
    if (!result.ok) throw new Error(JSON.stringify(result.findings))
    expect(result.rows[0]?.identifierKeys).toHaveLength(2)
    expect(result.rows[0]?.identifierKeys).toContain(
      productKey({ scheme: 'gtin', value: '05012345678900' }),
    )
  })
})

describe('what the projection refuses', () => {
  it('refuses a snapshot with two items claiming one identity (§9.4)', () => {
    const result = project([item(), item({ name: 'Oak dining chair (2026)' })])
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.findings[0]).toMatchObject({ refusal: 'duplicate_identity', index: 1 })
  })

  it('refuses the WHOLE snapshot, not just the bad item', () => {
    // A snapshot is full state. Indexing the items that happened to parse
    // publishes a catalog that silently omits products, and a buyer sees a
    // supplier who does not stock the thing rather than an error.
    const result = project([
      item({ product: { scheme: 'gtin', value: '05012345678900' } }),
      item({ product: { scheme: 'manufacturer_sku', value: 'NO-ISSUER' } }),
      item({ product: { scheme: 'gtin', value: '05012345678917' } }),
    ])
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]?.refusal).toBe('unattributed_identifier')
  })

  it('refuses an unattributed scoped identifier, primary or secondary (§9.3)', () => {
    // `CHAIR-1` means nothing without knowing who issues it, and two suppliers
    // may both use it. A secondary identifier gets the same rule: it is a
    // lookup key, so an ambiguous one points at the wrong product.
    // BOTH cases, because the title promised two and the test exercised one.
    const primary = project([item({ product: { scheme: 'custom', value: 'CHAIR-1' } })])
    expect(primary.ok).toBe(false)
    if (primary.ok) throw new Error('expected a refusal')
    expect(primary.findings[0]?.refusal).toBe('unattributed_identifier')
    expect(primary.findings[0]?.detail).toContain('item.product.issuer_did')

    const secondary = project([
      item({ identifiers: [{ scheme: 'custom', value: 'INTERNAL-77' }] }),
    ])
    expect(secondary.ok).toBe(false)
    if (secondary.ok) throw new Error('expected a refusal')
    expect(secondary.findings[0]?.refusal).toBe('unattributed_identifier')
    // The PATH names which identifier, so primary and secondary stay
    // distinguishable without the refusal detail restating it in prose.
    expect(secondary.findings[0]?.detail).toContain('item.identifiers[0].issuer_did')
  })

  it('refuses an item that names a supplier other than the publishing repo', () => {
    // Believing the item would let one supplier write rows under another's
    // name — the AppView equivalent of a forged catalog.
    const result = project([item({ supplier_did: 'did:plc:rivalchairs01' })])
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.findings[0]?.refusal).toBe('supplier_mismatch')
  })

  it('refuses an item that names a different catalog', () => {
    const result = project([item({ catalog_id: 'someone-elses-catalog' })])
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.findings[0]?.refusal).toBe('catalog_mismatch')
  })
})

describe('what the projection carries, and what it must not (FR-A7, §10.4)', () => {
  it('carries an indicative price, labelled as indicative', () => {
    const result = project([
      item({ indicative_price: { currency: 'INR', minor_units: '50000' } }),
    ])
    if (!result.ok) throw new Error(JSON.stringify(result.findings))
    expect(result.rows[0]?.indicativePrice).toEqual({ currency: 'INR', minor_units: '50000' })
  })

  it('carries bounded source and freshness evidence (FR-A5)', () => {
    const result = project([
      item({
        freshness: {
          generated_at: '2026-08-08T09:00:00.000Z',
          valid_until: '2026-09-08T09:00:00.000Z',
        },
      }),
    ])
    if (!result.ok) throw new Error(JSON.stringify(result.findings))
    // Which snapshot this came from, and when it was generated: enough for a
    // buyer to verify the supplier live before committing (§10.6).
    expect(result.rows[0]).toMatchObject({
      snapshotDigest: 'a'.repeat(64),
      snapshotSequence: 1,
      generatedAt: '2026-08-08T09:00:00.000Z',
      validUntil: '2026-09-08T09:00:00.000Z',
    })
  })

  it('has nowhere to put live stock or a buyer authorization', () => {
    // FR-A7 is enforced by the SHAPE, not by a filter someone must remember to
    // run: a row has no field these could occupy, so a future item carrying
    // them cannot leak them into the index.
    const result = project([
      item({
        ...({ stock_on_hand: '40', authorized_buyer: 'did:plc:sancho' } as Partial<CatalogItemShape>),
      }),
    ])
    if (!result.ok) throw new Error(JSON.stringify(result.findings))
    const row = result.rows[0]
    expect(row).toBeDefined()
    expect(JSON.stringify(row)).not.toContain('stock_on_hand')
    expect(JSON.stringify(row)).not.toContain('did:plc:sancho')
  })

  it('projects an empty catalog as zero rows rather than refusing', () => {
    // "This supplier currently offers nothing" is a legitimate published
    // state, and the honest projection of it is an empty index, not an error.
    const result = project([])
    expect(result).toEqual({ ok: true, rows: [] })
  })
})
