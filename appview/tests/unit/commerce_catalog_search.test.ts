/**
 * Catalog search: what matches, why, and how confidently (§10.5, FR-A4–FR-A7).
 *
 * The property under most of these is one sentence: `retrievalScoreBp` is
 * RECALL confidence and not a commercial ranking. An index whose score could
 * be read as "this is the best supplier" would let its operator move
 * commercial outcomes by tuning recall — the failure mode §10.6's
 * multiple-AppView design exists to survive.
 */

import { describe, expect, it } from 'vitest'

import {
  decodeProductKey,
  parseIdentifierParam,
  toCandidate,
} from '@/api/xrpc/commerce-catalog-search.js'
import { productKey, type CatalogProductRow } from '@/shared/commerce/catalog-projection.js'
import {
  CATEGORY_WEIGHT_BP,
  IDENTIFIER_WEIGHT_BP,
  REGION_WEIGHT_BP,
  RELATED_WEIGHT_BP,
  TEXT_WEIGHT_BP,
  isFresh,
  matchCatalogRow,
  rankCatalogMatches,
} from '@/shared/commerce/catalog-search.js'

const SUPPLIER = 'did:plc:chairmaker99'
const NOW = '2026-08-08T09:00:00.000Z'

function row(overrides: Partial<CatalogProductRow> = {}): CatalogProductRow {
  const product = { scheme: 'gtin' as const, value: '05012345678900' }
  return {
    rowKey: `row-${overrides.name ?? 'default'}`,
    productKey: productKey(product),
    supplierDid: SUPPLIER,
    catalogId: 'chairmaker-main',
    snapshotSequence: 1,
    snapshotDigest: 'a'.repeat(64),
    itemRevision: '1',
    name: 'Oak dining chair',
    brand: 'ChairMaker',
    description: 'Solid oak, four legs',
    categoryIds: ['furniture.seating'],
    identifierKeys: [productKey(product)],
    fulfilmentRegions: [{ scheme: 'admin_area', value: 'IN-KA' }],
    indicativePrice: { currency: 'INR', minor_units: '50000' },
    generatedAt: NOW,
    validUntil: null,
    ...overrides,
  }
}

describe('matching', () => {
  it('scores an identifier hit above every other signal combined', () => {
    // A GTIN match IS the product. No amount of text or category similarity
    // should be able to outrank it.
    expect(IDENTIFIER_WEIGHT_BP).toBeGreaterThan(
      CATEGORY_WEIGHT_BP + TEXT_WEIGHT_BP + REGION_WEIGHT_BP,
    )
    const byIdentifier = matchCatalogRow(row(), {
      atIso: NOW,
      identifiers: [{ scheme: 'gtin', value: '05012345678900' }],
    })
    const byEverythingElse = matchCatalogRow(row(), {
      atIso: NOW,
      categoryIds: ['furniture.seating'],
      text: 'oak',
      region: 'admin_area:IN-KA',
    })
    expect(byIdentifier?.retrievalScoreBp).toBeGreaterThan(
      byEverythingElse?.retrievalScoreBp ?? 0,
    )
  })

  it('names every field that matched', () => {
    // A candidate nobody can explain is indistinguishable from a paid
    // placement, which is the thing this index exists not to be.
    const match = matchCatalogRow(row(), {
      atIso: NOW,
      identifiers: [{ scheme: 'gtin', value: '05012345678900' }],
      categoryIds: ['furniture.seating'],
      text: 'oak',
      region: 'admin_area:IN-KA',
    })
    expect(match?.matchedFields).toEqual(['identifier', 'category', 'text', 'region'])
    expect(match?.retrievalScoreBp).toBe(10000)
  })

  it('finds a product by ANY identifier it claims, not only its primary', () => {
    // A buyer holding the GTIN and a buyer holding the supplier's SKU are
    // asking about the same product.
    const sku = { scheme: 'manufacturer_sku' as const, value: 'CHAIR-1', issuer_did: SUPPLIER }
    const withSecondary = row({
      identifierKeys: [productKey({ scheme: 'gtin', value: '05012345678900' }), productKey(sku)],
    })
    expect(matchCatalogRow(withSecondary, { atIso: NOW, identifiers: [sku] })).not.toBeNull()
  })

  it('returns null rather than a weak match when nothing hits', () => {
    // "No match" and "a poor match" must not arrive as the same thing.
    expect(matchCatalogRow(row(), { atIso: NOW, text: 'bicycle' })).toBeNull()
    expect(
      matchCatalogRow(row(), {
        atIso: NOW,
        identifiers: [{ scheme: 'gtin', value: '09999999999999' }],
      }),
    ).toBeNull()
  })

  it('matches text case-insensitively across name, brand and description', () => {
    for (const text of ['OAK DINING', 'chairmaker', 'four legs']) {
      expect(matchCatalogRow(row(), { atIso: NOW, text })?.matchedFields).toContain('text')
    }
  })

  it('drops an expired row instead of returning it flagged (§10.4, FR-A6)', () => {
    // A discovery result is what a buyer requests a quote against. Offering a
    // row the supplier has already said is stale invites the round trip §10.4
    // exists to avoid.
    const expired = row({ validUntil: '2026-08-01T00:00:00.000Z' })
    expect(isFresh(expired, NOW)).toBe(false)
    expect(
      matchCatalogRow(expired, {
        atIso: NOW,
        identifiers: [{ scheme: 'gtin', value: '05012345678900' }],
      }),
    ).toBeNull()
  })

  it('treats a row with no validUntil as never expiring', () => {
    // That is the supplier's own claim about it, not an omission to guess at.
    expect(isFresh(row({ validUntil: null }), '2099-01-01T00:00:00.000Z')).toBe(true)
  })

  it('treats the expiry instant itself as expired', () => {
    // `>` not `>=`: the supplier said valid UNTIL, and a boundary read the
    // other way is the classic off-by-one that ships a stale quote.
    const boundary = row({ validUntil: NOW })
    expect(isFresh(boundary, NOW)).toBe(false)
  })
})

describe('ranking', () => {
  it('orders by recall, then by a key with no commercial meaning', () => {
    // Breaking ties by recency or price would make the index a ranking
    // authority, and §10.5 is explicit that it is not one.
    const ranked = rankCatalogMatches([
      { retrievalScoreBp: 2000, rowKey: 'b' },
      { retrievalScoreBp: 6000, rowKey: 'z' },
      { retrievalScoreBp: 2000, rowKey: 'a' },
    ])
    expect(ranked.map((r) => r.rowKey)).toEqual(['z', 'a', 'b'])
  })

  it('does not mutate its input', () => {
    const input = [
      { retrievalScoreBp: 1, rowKey: 'b' },
      { retrievalScoreBp: 2, rowKey: 'a' },
    ]
    rankCatalogMatches(input)
    expect(input.map((r) => r.rowKey)).toEqual(['b', 'a'])
  })
})

describe('identifier parameters on the wire', () => {
  it('reads an unscoped scheme', () => {
    expect(parseIdentifierParam('gtin:05012345678900')).toEqual({
      scheme: 'gtin',
      value: '05012345678900',
    })
  })

  it('keeps a DID intact when reading a scoped scheme', () => {
    // An issuer DID is itself full of colons, so a greedy split would shred it
    // and search for a product nobody published.
    expect(parseIdentifierParam(`manufacturer_sku:CHAIR-1:${SUPPLIER}`)).toEqual({
      scheme: 'manufacturer_sku',
      value: 'CHAIR-1',
      issuer_did: SUPPLIER,
    })
  })

  it.each([
    ['manufacturer_sku:CHAIR-1', 'a scoped scheme with no issuer'],
    ['custom:INTERNAL-77', 'a custom scheme with no issuer'],
    ['gtin:', 'an empty value'],
    [':05012345678900', 'an empty scheme'],
    ['nocolon', 'no separator at all'],
    [`manufacturer_sku:CHAIR-1:`, 'an empty issuer'],
  ])('refuses %s (%s)', (raw) => {
    // §9.3: an unattributed scoped identifier is ambiguous across suppliers,
    // so searching for one anyway returns somebody else's product.
    expect(parseIdentifierParam(raw)).toBeNull()
  })
})

describe('the candidate on the wire (§10.5, FR-A7)', () => {
  it('carries source and freshness evidence, and no commitment', () => {
    const candidate = toCandidate(row({ validUntil: '2026-09-08T09:00:00.000Z' }), ['identifier'], 6000)
    expect(candidate).toMatchObject({
      supplier_did: SUPPLIER,
      catalog_snapshot_ref: 'a'.repeat(64),
      matched_fields: ['identifier'],
      indicative_price: { currency: 'INR', minor_units: '50000' },
      generated_at: NOW,
      valid_until: '2026-09-08T09:00:00.000Z',
      retrieval_score_bp: 6000,
    })
    // There is no field for stock or authorization to populate. FR-A7 is
    // enforced by the shape rather than by a filter someone must remember.
    expect(Object.keys(candidate)).not.toContain('stock')
    expect(Object.keys(candidate)).not.toContain('authorized')
  })

  it('reconstructs the product reference exactly from the stored key', () => {
    // The key is length-prefixed, which is the second reason that encoding was
    // chosen: a separator-joined key could not be decoded at all once a value
    // contained the separator.
    const scoped = { scheme: 'custom' as const, value: 'A:B', issuer_did: SUPPLIER }
    const candidate = toCandidate(row({ productKey: productKey(scoped) }), ['identifier'], 6000)
    expect(candidate.product).toEqual({
      scheme: 'custom',
      value: 'A:B',
      issuer_did: SUPPLIER,
    })
  })

  it('round-trips a variant digest', () => {
    const variant = {
      scheme: 'gtin' as const,
      value: '05012345678900',
      variant_digest: 'd'.repeat(64),
    }
    expect(decodeProductKey(productKey(variant))).toEqual([
      'gtin',
      '05012345678900',
      '',
      'd'.repeat(64),
    ])
  })

  it('splits a fulfilment region back into scheme and code', () => {
    const candidate = toCandidate(row(), ['region'], 500)
    expect(candidate.fulfilment_regions).toEqual([{ scheme: 'admin_area', value: 'IN-KA' }])
  })

  it('omits an absent price rather than sending a zero', () => {
    // A zero indicative price is a claim; absence is the truth.
    const candidate = toCandidate(row({ indicativePrice: null }), ['text'], 1500)
    expect(candidate.indicative_price).toBeUndefined()
  })
})

/**
 * The other half of the frozen §10.5 vector.
 *
 * `packages/commerce-protocol` asserts its validator ACCEPTS
 * `search_candidate.json`. This asserts AppView PRODUCES it. Neither half is
 * worth much alone: a validator that accepts a shape nobody emits proves
 * nothing, and a projection nobody validates is a shape only this codebase
 * believes in. Together they are the only thing keeping a standalone
 * deployment and a package it cannot import agreeing about the wire.
 */
describe('the frozen §10.5 candidate, produced here', () => {
  it('matches the vector byte for byte', async () => {
    const { readFileSync } = await import('node:fs')
    const path = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const here = path.dirname(fileURLToPath(import.meta.url))
    const vector = JSON.parse(
      readFileSync(
        path.resolve(
          here,
          '../../../packages/commerce-protocol/conformance/vectors/search_candidate.json',
        ),
        'utf8',
      ),
    ) as { candidate: Record<string, unknown> }

    const product = {
      scheme: 'manufacturer_sku' as const,
      value: 'CHAIR-1',
      issuer_did: SUPPLIER,
    }
    const produced = toCandidate(
      row({
        productKey: productKey(product),
        identifierKeys: [productKey(product)],
        validUntil: '2026-09-08T09:00:00.000Z',
      }),
      ['identifier', 'category'],
      8000,
    )
    expect(produced).toEqual(vector.candidate)
  })
})


/**
 * §10.7 recall expansion: an edge widens what a buyer is offered to LOOK at,
 * and nothing more. It is the lowest-consequence use of the relationship
 * graph, and the one the spec explicitly permits at low confidence.
 */
describe('reaching a product along a relationship edge', () => {
  const RELATED = { scheme: 'gtin' as const, value: '05012345678917' }

  function relatedRow() {
    return row({
      productKey: productKey(RELATED),
      identifierKeys: [productKey(RELATED)],
      name: 'Ash dining chair',
    })
  }

  it('finds a related product and says the index guessed', () => {
    const match = matchCatalogRow(relatedRow(), {
      atIso: NOW,
      identifiers: [{ scheme: 'gtin', value: '05012345678900' }],
      relatedKeys: new Map([[productKey(RELATED), ['claim-7']]]),
    })
    expect(match?.matchedFields).toEqual(['related'])
    expect(match?.retrievalScoreBp).toBe(RELATED_WEIGHT_BP)
    // The evidence travels with the result, so a buyer can see WHOSE claim put
    // it there (§10.5 relationship_evidence_refs).
    expect(match?.relationshipEvidenceRefs).toEqual(['claim-7'])
  })

  it('never outranks a product that matched on its own identity', () => {
    // An edge improves recall; it does not get to win on precision.
    expect(RELATED_WEIGHT_BP).toBeLessThan(IDENTIFIER_WEIGHT_BP)
    expect(RELATED_WEIGHT_BP).toBeLessThan(CATEGORY_WEIGHT_BP + TEXT_WEIGHT_BP)
  })

  it('does not pay a row twice for being related to itself', () => {
    // A direct hit is not additionally "related", and awarding both would let
    // the graph inflate a hit it did not produce.
    const direct = matchCatalogRow(row(), {
      atIso: NOW,
      identifiers: [{ scheme: 'gtin', value: '05012345678900' }],
      relatedKeys: new Map([[productKey({ scheme: 'gtin', value: '05012345678900' }), ['c']]]),
    })
    expect(direct?.matchedFields).toEqual(['identifier'])
    expect(direct?.retrievalScoreBp).toBe(IDENTIFIER_WEIGHT_BP)
    expect(direct?.relationshipEvidenceRefs).toEqual([])
  })

  it('still drops an expired related row', () => {
    // Expansion widens recall, not the freshness rule.
    const expired = { ...relatedRow(), validUntil: '2026-08-01T00:00:00.000Z' }
    expect(
      matchCatalogRow(expired, {
        atIso: NOW,
        identifiers: [{ scheme: 'gtin', value: '05012345678900' }],
        relatedKeys: new Map([[productKey(RELATED), ['claim-7']]]),
      }),
    ).toBeNull()
  })

  it('omits the evidence field entirely on a direct match', () => {
    // An empty array and an absent field both render as "no evidence", but
    // only one of them is true: this row needed none.
    expect(toCandidate(row(), ['identifier'], 6000)).not.toHaveProperty(
      'relationship_evidence_refs',
    )
    expect(
      toCandidate(row(), ['related'], RELATED_WEIGHT_BP, ['claim-7']).relationship_evidence_refs,
    ).toEqual(['claim-7'])
  })
})
