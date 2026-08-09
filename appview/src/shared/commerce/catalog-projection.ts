/**
 * Projecting a verified catalog snapshot into indexable rows (FR-A3, FR-A5,
 * FR-A7, §10.4, §10.7).
 *
 * PURE. It takes a publication that `catalog-verify.ts` has already accepted
 * and returns rows; it opens no transaction and reads no clock. The handler is
 * the shell that writes them. Separating the two is not ceremony — every rule
 * worth arguing about is in here, and none of them should need a database to
 * test.
 *
 * THE RULE THAT SHAPES THE WHOLE MODULE (FR-A3): identity comes from the
 * IDENTIFIER, never from the name. "Oak dining chair" from two suppliers is
 * two products; the same GTIN under two names is one. An index that merged on
 * name would silently answer a buyer's question about product A with product
 * B's reviews, and no later check could tell that it had. So the row key is a
 * canonical rendering of the `ProductRef`, and names are only ever searchable
 * text hanging off it.
 *
 * WHAT IS DELIBERATELY NOT PROJECTED (FR-A7). No stock quantity, no
 * customer-specific price, no authorization. `indicative_price` is carried and
 * labelled as indicative because §10.4 permits it, and a real price still
 * comes from a signed quote; a field that could be read as a current
 * contractual offer has no column here to live in.
 */

/** A product identity as the catalog publishes it (§9.3). */
export interface ProductRef {
  scheme: 'gtin' | 'manufacturer_sku' | 'dina_subject' | 'custom'
  value: string
  issuer_did?: string
  variant_digest?: string
}

export interface Money {
  currency: string
  minor_units: string
}

/**
 * A fulfilment region as §9.0 defines it — `value`, not `code`, and a CLOSED
 * scheme vocabulary. Carried through verbatim rather than flattened into a
 * string: a first draft stored `"${scheme}:${code}"` and split it back for the
 * search result, which invented a field name the protocol does not have and
 * dropped `issuer_did` on a `custom` region. The frozen §10.5 vector caught it
 * on its first run, which is what that vector is for.
 */
export interface RegionRefShape {
  scheme: 'country' | 'admin_area' | 'postal_area' | 'geohash' | 'custom'
  value: string
  issuer_did?: string
}

export interface CatalogItemShape {
  product: ProductRef
  supplier_did: string
  catalog_id: string
  item_revision: string
  name: string
  brand?: string
  description?: string
  category_ids: string[]
  identifiers?: ProductRef[]
  fulfilment_regions: RegionRefShape[]
  indicative_price?: Money
  freshness: { generated_at: string; valid_until?: string }
}

/** One indexed document: an exact variant offered by one supplier. */
export interface CatalogProductRow {
  /** Supplier plus product identity — unique per exact variant per supplier. */
  rowKey: string
  /** Canonical rendering of the ProductRef. Identity; never the name. */
  productKey: string
  supplierDid: string
  catalogId: string
  snapshotSequence: number
  snapshotDigest: string
  itemRevision: string
  name: string
  brand: string | null
  description: string | null
  categoryIds: string[]
  /** Every identifier this item claims, canonicalized, for lookup by any of them. */
  identifierKeys: string[]
  fulfilmentRegions: RegionRefShape[]
  /** §10.4: permitted, and never a contractual offer. */
  indicativePrice: Money | null
  generatedAt: string
  validUntil: string | null
}

export type ProjectionRefusal =
  /** §9.4: two rows in one snapshot claiming the same identity. */
  | 'duplicate_identity'
  /** §9.3: a scoped scheme with no issuer is ambiguous across suppliers. */
  | 'unattributed_identifier'
  /** The item names a supplier other than the one whose repo published it. */
  | 'supplier_mismatch'
  /** The item names a catalog other than the one being published. */
  | 'catalog_mismatch'

export interface ProjectionFinding {
  refusal: ProjectionRefusal
  /** 0-based position in the concatenated item list. */
  index: number
  detail: string
}

export type CatalogProjection =
  | { ok: true; rows: CatalogProductRow[] }
  /**
   * ALL-OR-NOTHING, for the same reason the supplier-side importer is. A
   * snapshot is full state (§10.2): indexing the items that happened to parse
   * publishes a catalog that silently omits products, and a buyer sees a
   * supplier who does not stock the thing rather than an error. Refusing the
   * whole snapshot leaves the PREVIOUS one in place, which is the honest
   * fallback — it is at least a catalog the supplier once stood behind.
   */
  | { ok: false; findings: ProjectionFinding[] }

/**
 * Canonical identity for a product reference.
 *
 * Scoped schemes carry their issuer, because `CHAIR-1` means nothing without
 * knowing who issues it and two suppliers may both use it. `variant_digest`
 * is part of identity when present: it is what distinguishes exact variants
 * that share an identifier, and dropping it is precisely the merge FR-A3
 * forbids.
 *
 * The encoding is length-prefixed rather than separator-joined; see
 * `encodeParts` for why that is not a stylistic choice.
 */
export function productKey(product: ProductRef): string {
  return encodeParts([
    product.scheme,
    product.value,
    product.issuer_did ?? '',
    product.variant_digest ?? '',
  ])
}

/**
 * LENGTH-PREFIXED, not separator-joined.
 *
 * A `custom` or `manufacturer_sku` value is an arbitrary bounded string, so
 * ANY separator character can appear inside a field and let two different refs
 * splice to the same key — which is the merge FR-A3 forbids, arriving through
 * the back door. Prefixing each part with its length makes the encoding
 * injective whatever the contents are. A first draft joined on a single
 * character and would have collided `{value: 'A|B'}` with
 * `{value: 'A', issuer_did: 'B'}`.
 */
function encodeParts(parts: readonly string[]): string {
  return parts.map((part) => `${String(part.length)}:${part}`).join('')
}

const SCOPED_SCHEMES: ReadonlySet<string> = new Set(['manufacturer_sku', 'custom'])

function unattributed(product: ProductRef): boolean {
  return SCOPED_SCHEMES.has(product.scheme) && (product.issuer_did ?? '') === ''
}

/**
 * Project every item in a verified publication.
 *
 * `supplierDid` comes from the REPO the records were published in, not from
 * the items: an item claiming someone else's DID is a publication fault, and
 * believing it would let one supplier write rows under another's name.
 */
export function projectCatalogSnapshot(args: {
  supplierDid: string
  catalogId: string
  snapshotSequence: number
  snapshotDigest: string
  items: readonly CatalogItemShape[]
}): CatalogProjection {
  const findings: ProjectionFinding[] = []
  const rows: CatalogProductRow[] = []
  const seen = new Map<string, number>()

  args.items.forEach((item, index) => {
    if (item.supplier_did !== args.supplierDid) {
      findings.push({
        refusal: 'supplier_mismatch',
        index,
        detail: 'item names a supplier other than the publishing repo',
      })
      return
    }
    if (item.catalog_id !== args.catalogId) {
      findings.push({
        refusal: 'catalog_mismatch',
        index,
        detail: 'item names a catalog other than the one being published',
      })
      return
    }
    if (unattributed(item.product)) {
      findings.push({
        refusal: 'unattributed_identifier',
        index,
        detail: `${item.product.scheme} requires an issuer_did`,
      })
      return
    }

    const key = productKey(item.product)
    const first = seen.get(key)
    if (first !== undefined) {
      // NOT deduplicated. Two rows claiming one identity means the supplier
      // does not know which one they sell, and picking either for them is
      // the merge FR-A3 exists to forbid — one of the two products would
      // silently inherit the other's standing.
      findings.push({
        refusal: 'duplicate_identity',
        index,
        detail: `same product identity as item ${String(first)}`,
      })
      return
    }
    seen.set(key, index)

    const identifierKeys: string[] = [key]
    for (const identifier of item.identifiers ?? []) {
      if (unattributed(identifier)) {
        findings.push({
          refusal: 'unattributed_identifier',
          index,
          detail: `secondary ${identifier.scheme} identifier requires an issuer_did`,
        })
        return
      }
      identifierKeys.push(productKey(identifier))
    }

    rows.push({
      rowKey: encodeParts([args.supplierDid, key]),
      productKey: key,
      supplierDid: args.supplierDid,
      catalogId: args.catalogId,
      snapshotSequence: args.snapshotSequence,
      snapshotDigest: args.snapshotDigest,
      itemRevision: item.item_revision,
      name: item.name,
      brand: item.brand ?? null,
      description: item.description ?? null,
      categoryIds: [...item.category_ids],
      identifierKeys,
      fulfilmentRegions: [...item.fulfilment_regions],
      // §10.4 permits an indicative price and forbids presenting it as a
      // current contractual offer. The column name is the label.
      indicativePrice: item.indicative_price ?? null,
      generatedAt: item.freshness.generated_at,
      validUntil: item.freshness.valid_until ?? null,
    })
  })

  if (findings.length > 0) return { ok: false, findings }
  return { ok: true, rows }
}
