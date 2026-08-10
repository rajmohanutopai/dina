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

import { validateCatalogItem } from './wire-rules.js'

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
  /**
   * §9.5 REQUIRES this, and the type omitted it.
   *
   * AppView neither projects nor searches on `pack` — orderability is settled
   * by Core at quote and order time — but leaving it off the type meant every
   * fixture in this repo built an item no conformant publisher could publish,
   * and the projection indexed them. The unit vocabulary and its decimal
   * scales stay protocol-side; what AppView owes is that the field is there
   * and structurally sound.
   */
  pack: { sell_unit: unknown; units_per_pack?: string }
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
  /**
   * The listing that serves this catalog, as the supplier stated it on the
   * pointer (§10.5, DR-5). NULL when they did not say.
   */
  serviceRkey: string | null
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
  /**
   * The item is missing a field the projection must read.
   *
   * ADDED after a reviewer noticed the module promised an all-or-nothing
   * refusal but had no case for this, so an item without `product` or
   * `freshness` threw a TypeError out of the firehose ingest path instead. A
   * throw is not a refusal: the record is neither indexed NOR counted as
   * refused, so a hostile-but-digest-valid page disappears from the metrics an
   * operator would use to notice it. Nothing validates item shapes upstream —
   * `verifyCatalogPage` checks digests, not fields, and the handler casts.
   */
  | 'malformed_item'

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
export function encodeParts(parts: readonly string[]): string {
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
  /** From the POINTER, never from an item: a listing is a repo-level fact. */
  serviceRkey?: string | null
  items: readonly CatalogItemShape[]
}): CatalogProjection {
  const findings: ProjectionFinding[] = []
  const rows: CatalogProductRow[] = []
  const seen = new Map<string, number>()

  const isObject = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v)

  /**
   * Every field this projection dereferences. Absent or mistyped means REFUSE,
   * not throw.
   *
   * SECOND PASS. The first version of this guard covered the fields I noticed
   * and a reviewer traced five more the projection reaches afterwards. Each is
   * a different flavour of the same error — checking the level I was looking at
   * rather than every level a publisher controls:
   *
   *   - `indicative_price: null` — `null` is the ONLY way JSON expresses "no
   *     price", and the branch below tested `=== undefined`, so a null price
   *     reached `.currency`.
   *   - `product` was accepted as any object, but `productKey` → `encodeParts`
   *     reads `.length` off `scheme` and `value`.
   *   - `identifiers` was never checked, so a primitive element reached
   *     `productKey`.
   *   - `fulfilment_regions` was checked as an ARRAY but not its elements —
   *     the exact depth mistake the comment further down describes.
   *   - `brand`/`description` were passed through untyped into `text` columns
   *     that catalog-search ILIKE-matches, so an object there becomes
   *     searchable JSON: a leak, not just a crash.
   */
  const missingField = (typed: CatalogItemShape): string | null => {
    // ONE STATEMENT OF THE RULES, delegated to `wire-rules.ts`, which frozen
    // parity vectors hold to the protocol's own semantics.
    //
    // WHAT THE HAND-ROLLED VERSION HERE LET THROUGH. It checked a handful of
    // shallow types, so an item with an arbitrary product scheme, an arbitrary
    // region scheme, an object where a category id belongs, an invalid
    // timestamp and no `pack` was INDEXED — and the object category reached a
    // searchable column as the string "[object Object]". Its first act was
    // also `item.product` on a value it had not established was an object, so
    // a digest-valid snapshot carrying `items:[null]` threw out of the ingest
    // handler instead of being refused and counted.
    //
    // READ AS UNKNOWN: the declared type describes an intention about bytes
    // that came off the wire from a publisher we do not control. Trusting the
    // annotation here is how the throw got in.
    return validateCatalogItem(typed as unknown)
  }

  /**
   * Which refusal a rejected field path is.
   *
   * §9.3's unattributed-scoped-identifier case has its own refusal because it
   * is a DIFFERENT problem from a mistyped field: the item is well-formed and
   * still ambiguous, since two suppliers' SKU "A-1" collide into one product
   * key. Collapsing it into `malformed_item` would tell a supplier "something
   * is wrong with your item" when the answer is "this identifier needs an
   * issuer". Regions are excluded — `fulfilment_regions[…].issuer_did` is a
   * §9.0 delivery scope, not product identity.
   */
  const classify = (path: string): ProjectionRefusal =>
    path.endsWith('.issuer_did') &&
    (path.startsWith('item.product') || path.startsWith('item.identifiers'))
      ? 'unattributed_identifier'
      : 'malformed_item'

  args.items.forEach((item, index) => {
    const missing = missingField(item)
    if (missing !== null) {
      findings.push({
        refusal: classify(missing),
        index,
        // The FIELD NAME, never its value: a refusal that quoted the payload
        // would put a hostile publisher's bytes into an operator's log.
        detail: `item is missing or mistyped: ${missing}`,
      })
      return
    }
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
      serviceRkey: args.serviceRkey ?? null,
      itemRevision: item.item_revision,
      name: item.name,
      brand: item.brand ?? null,
      description: item.description ?? null,
      // STRINGS ONLY, and this one was MISSED by the first pass of the fix
      // below — which is the finding worth keeping. I rebuilt the regions and
      // the price, wrote the comment saying the rule is about DEPTH, and left a
      // shallow spread three lines above it. `category_ids` elements are
      // publisher-controlled and reach a queryable column: `catalog-search`
      // reads them through `jsonb_array_elements_text`, so an object element
      // would sit in the searchable surface exactly like the region did.
      categoryIds: item.category_ids.map((id) => String(id)),
      identifierKeys,
      // FIELD BY FIELD, never a spread of the inbound object.
      //
      // `[...item.fulfilment_regions]` copied the region OBJECTS verbatim, so
      // anything a publisher nested inside one landed in a queryable column —
      // the §25.2 "secrets never enter AppView" claim, broken one level below
      // where the allow-list was obvious. `commerce_no_secrets.test.ts` found
      // it by scanning every column rather than the ones anyone thought of.
      //
      // A shallow copy of an array of objects copies the REFERENCES; only the
      // outer array was ever new. The rule is therefore about depth, not about
      // spreading: every level a publisher controls has to be rebuilt from
      // named fields, or the allow-list stops one level above the data.
      fulfilmentRegions: item.fulfilment_regions.map((region) => ({
        scheme: region.scheme,
        value: region.value,
        // `== null` catches BOTH undefined and null, and that second case is a
        // regression I introduced: loosening `optionalText` to admit null let
        // `{issuer_did: null}` through the gate, and this test was `=== undefined`,
        // so null was written into the jsonb column and spread onto the wire.
        // `validateRegionRef` — the frozen §10.5 validator a BUYER runs — then
        // refuses it, so AppView would emit a candidate the protocol rejects,
        // which is the one thing `search_candidate.json` exists to prevent.
        ...(region.issuer_did == null ? {} : { issuer_did: region.issuer_did }),
      })),
      // §10.4 permits an indicative price and forbids presenting it as a
      // current contractual offer. The column name is the label — and the two
      // fields below are the whole of Money, so a supplier cannot append a
      // cost basis to the price a buyer sees.
      indicativePrice:
        item.indicative_price === undefined || item.indicative_price === null
          ? null
          : {
              currency: item.indicative_price.currency,
              minor_units: item.indicative_price.minor_units,
            },
      generatedAt: item.freshness.generated_at,
      validUntil: item.freshness.valid_until ?? null,
    })
  })

  if (findings.length > 0) return { ok: false, findings }
  return { ok: true, rows }
}
