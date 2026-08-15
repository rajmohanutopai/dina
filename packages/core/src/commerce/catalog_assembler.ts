/**
 * `CatalogImportItem[]` → `CatalogItem[]` (§3 of the photo-catalog lane).
 *
 * THE MIDDLE OF THE CHAIN, WHICH DID NOT EXIST. Rows could be parsed
 * (`parseCatalogCsv`, `catalogRowsFromRecords`) and imported
 * (`importCatalogRows`), and snapshots could be built from items
 * (`buildCatalogSnapshot`) — but nothing in `packages/core/src` ever
 * constructed a `CatalogItem`. The only file naming the type did so in a
 * comment. So `buildCatalogSnapshot`, which takes `readonly unknown[]` and
 * never validates, would happily paginate and sign flat import items, and
 * AppView would then refuse to project them: a catalog that signs cleanly and
 * is discoverable by nobody.
 *
 * WHAT THE ASSEMBLER ADDS, and where each value comes from. The importer's
 * shape is flat and its bounds are looser than the wire's, so this is a
 * translation with its own refusals rather than a copy:
 *
 *   supplier_did          the node's own identity      (caller)
 *   catalog_id            the draft being assembled    (caller)
 *   item_revision         minted once, here            (see below)
 *   freshness.generated_at minted once, here           (see below)
 *   category_ids          the seller's settings        — never the model
 *   fulfilment_regions    the seller's settings        — never the model
 *   pack.sell_unit        unit_code + pack_size        → Quantity
 *   indicative_price      list_price + tradingCurrency → Money
 *
 * The two "never the model" lines are the point of the whole design. A model
 * reading a photograph cannot know where a seller ships or which governed
 * category an item belongs to, and free text read off a price list cannot be
 * an id at all — `validateId` permits only [A-Za-z0-9._:-], so "Pickles &
 * Preserves" is not a candidate. Those come from the person.
 *
 * MINTED ONCE, AND THAT IS A CONTRACT. `item_revision` and
 * `freshness.generated_at` are stamped here and must then be stored with the
 * draft and never re-derived. A rebuild that re-mints either changes the
 * canonical bytes, which changes the snapshot digest, which invalidates an
 * approval the owner already gave — the failure the two-receipt design in §6
 * of the lane exists to prevent. Callers pass them in on a rebuild.
 */

import {
  isCurrencyCode,
  validateCatalogItem,
  type CatalogItem,
  type ProductRef,
  type Quantity,
  type RegionRef,
} from '@dina/commerce-protocol';

import type { CatalogImportItem } from './catalog_import';

export type AssemblyRefusal =
  /** A row with no name. The wire requires one and this lane will not invent it. */
  | 'no_name'
  /** A pack size with no unit — a bare number that means nothing on its own. */
  | 'quantity_without_unit'
  /** No category configured, so no item can carry the required `category_ids`. */
  | 'no_categories_configured'
  /** No public regions configured, so `fulfilment_regions` cannot be filled. */
  | 'no_regions_configured'
  /** A row carries a price and the supplier has no currency to price it in. */
  | 'no_trading_currency'
  /** The supplier's stored currency is not one `Money` accepts. */
  | 'malformed_trading_currency'
  /** The assembled item failed `validateCatalogItem` — detail carries which. */
  | 'item_rejected'
  /** Two rows resolved to one product identity. §9.4 — see the refusal site. */
  | 'duplicate_identity';

export interface AssemblyFinding {
  refusal: AssemblyRefusal;
  /** 0-based position in the input, so a caller can point at the row. */
  index: number;
  detail: string;
}

export type CatalogAssembly =
  | { ok: true; items: CatalogItem[] }
  /**
   * ALL OR NOTHING, matching `importCatalogRows`. A partial catalog is a
   * statement the seller did not make: §10.2 snapshots are full state, so
   * publishing the items that happened to assemble would silently withdraw the
   * ones that did not.
   */
  | { ok: false; findings: AssemblyFinding[] };

export interface AssemblyIdentity {
  supplierDid: string;
  catalogId: string;
}

/** The seller-supplied values no source data may provide. */
export interface AssemblySettings {
  categoryIds: readonly string[];
  fulfilmentRegions: readonly RegionRef[];
  /** Absent is legal until a row carries a price. */
  tradingCurrency?: string;
}

/**
 * Where each published field's value comes from — `row` for anything the
 * source data supplied, `minted` for what this function or the seller's
 * settings put there.
 *
 * IT LIVES HERE BECAUSE THE CONSTRUCTION BELOW IS WHAT MAKES IT TRUE. §5 says
 * Core marks a field `not_model_derived` from what it knows rather than from
 * anything a caller asserts, and what Core knows is exactly this assignment.
 * Kept anywhere else it would be a second copy of the assembler's behaviour,
 * free to drift from it — and the drift that matters is one direction only: a
 * model-read price marked exempt is a machine-invented number published with
 * nobody's confirmation.
 *
 * `Record<keyof CatalogItem, …>` so a field added to the wire type fails to
 * compile until someone says which side it falls on. That is the only reason
 * the unset ones are listed: `formulation_ref`, `relationship_claim_refs` and
 * `attributes` are never assigned below, and `row` is the fail-closed reading
 * of a field this lane does not yet set — it asks for a confirmation that is
 * not needed rather than skipping one that is.
 */
export const CATALOG_FIELD_ORIGIN: Readonly<Record<keyof CatalogItem, 'row' | 'minted'>> = {
  // Minted by the assembler or supplied by the seller's settings. None of
  // these can carry a value a model read off a photograph.
  supplier_did: 'minted',
  catalog_id: 'minted',
  item_revision: 'minted',
  category_ids: 'minted',
  fulfilment_regions: 'minted',
  freshness: 'minted',
  // From the source row. `indicative_price` counts as row-derived even though
  // its CURRENCY comes from settings: the digits are the model's, and a field
  // is only exempt when nothing in it was inferred.
  product: 'row',
  name: 'row',
  brand: 'row',
  description: 'row',
  family_ref: 'row',
  pack: 'row',
  identifiers: 'row',
  indicative_price: 'row',
  minimum_order: 'row',
  formulation_ref: 'row',
  relationship_claim_refs: 'row',
  attributes: 'row',
};

/**
 * Values minted once per draft and reused on every rebuild.
 *
 * Passing these in is what makes a rebuild reproduce the approved bytes. A
 * caller assembling for the first time generates them; a caller re-assembling
 * after a lost CAS passes back what the draft stored.
 */
/**
 * A product's identity as §9.3 defines it, length-prefixed so no field's
 * content can impersonate a separator. Exported because the draft lane carries
 * per-field provenance by this same key.
 */
export function productIdentity(item: CatalogItem): string {
  const parts = [
    item.product.scheme,
    item.product.value,
    item.product.issuer_did ?? '',
    item.product.variant_digest ?? '',
  ];
  return parts.map((part) => `${String(part.length)}:${part}`).join('');
}

export interface AssemblyStamp {
  generatedAtIso: string;
  /** One revision for the whole draft: the items move together (§10.2). */
  itemRevision: string;
}

/**
 * `1 each` is a safe reading of "one of these"; a bare number is not.
 *
 * Both absent means the row named no quantity at all, and one unit of one item
 * is what that means. But a `pack_size` with no `unit_code` is a number whose
 * meaning was not read — "500" is 500 grams or 500 jars depending on a glyph
 * the model did not return — and §2 opens on exactly that error being a
 * thousandfold one. §5 says unreadable cells come back empty and are never
 * guessed; defaulting the unit here would be guessing at the one field the
 * design singles out as load-bearing.
 */
function packSellUnit(item: CatalogImportItem): Quantity | null {
  if (item.pack_size !== undefined && item.unit_code === undefined) return null;
  return { value: item.pack_size ?? '1', unit_code: item.unit_code ?? 'each' };
}

function identifiersOf(item: CatalogImportItem, supplierDid: string): ProductRef[] {
  const refs: ProductRef[] = [];
  // §9.3 — a scoped scheme carries its issuer. A `manufacturer_sku` with no
  // issuer_did is an identifier nobody is accountable for, and AppView's
  // projection refuses it.
  if (item.sku !== undefined && item.sku !== '') {
    refs.push({ scheme: 'manufacturer_sku', value: item.sku, issuer_did: supplierDid });
  }
  if (item.mpn !== undefined && item.mpn !== '') {
    refs.push({ scheme: 'custom', value: item.mpn, issuer_did: supplierDid });
  }
  return refs;
}

export function assembleCatalogItems(args: {
  items: readonly CatalogImportItem[];
  identity: AssemblyIdentity;
  settings: AssemblySettings;
  stamp: AssemblyStamp;
}): CatalogAssembly {
  const { identity, settings, stamp } = args;
  const findings: AssemblyFinding[] = [];

  // THE SETTINGS CHECKS RUN ONCE, BEFORE ANY ITEM. Reporting "item 0 has no
  // category, item 1 has no category, item 2 has no category…" for a
  // single missing setting buries the one thing the seller has to fix.
  // Reported at index -1 because they belong to no row.
  if (settings.categoryIds.length === 0) {
    findings.push({
      refusal: 'no_categories_configured',
      index: -1,
      detail:
        'every published item needs a non-empty category_ids (§12.1); set the supplier catalog categories first',
    });
  }
  if (settings.fulfilmentRegions.length === 0) {
    findings.push({
      refusal: 'no_regions_configured',
      index: -1,
      detail:
        'every published item needs a non-empty fulfilment_regions; set the supplier public regions first',
    });
  }
  if (settings.tradingCurrency !== undefined && !isCurrencyCode(settings.tradingCurrency)) {
    findings.push({
      refusal: 'malformed_trading_currency',
      index: -1,
      detail: `stored trading currency ${JSON.stringify(settings.tradingCurrency)} is not a three-letter uppercase ISO 4217 code`,
    });
  }
  if (findings.length > 0) return { ok: false, findings };

  const assembled: CatalogItem[] = [];
  /** Product identity -> the row index that claimed it first. */
  const identities = new Map<string, number>();
  for (const [index, source] of args.items.entries()) {
    const priced = source.list_price !== undefined;
    if (priced && settings.tradingCurrency === undefined) {
      // The row has a price and the supplier has nowhere to say what it is
      // priced in. Refusing names the setting; guessing would publish a number
      // in a currency nobody chose.
      findings.push({
        refusal: 'no_trading_currency',
        index,
        detail: 'row carries a price and the supplier has no trading currency configured',
      });
      continue;
    }

    // THE WIRE REQUIRES A NAME AND THIS LANE WILL NOT INVENT ONE. The importer
    // treats `name` as optional, so an earlier version of this function fell
    // back to the identifier — which publishes "CHAIR-1" to buyers as the
    // product's name because a model could not read the label. §5 sends an
    // unreadable cell back empty rather than guessed, and repair is where the
    // seller supplies it; a fallback here would skip that and sign the guess.
    if (source.name === undefined || source.name === '') {
      findings.push({
        refusal: 'no_name',
        index,
        detail: 'a published item needs a name; the row has none and one will not be invented',
      });
      continue;
    }

    const sellUnit = packSellUnit(source);
    if (sellUnit === null) {
      findings.push({
        refusal: 'quantity_without_unit',
        index,
        detail: `pack_size ${JSON.stringify(source.pack_size)} has no unit_code — a bare number does not say what it measures (§9.2)`,
      });
      continue;
    }

    const item: CatalogItem = {
      product: source.product,
      supplier_did: identity.supplierDid,
      catalog_id: identity.catalogId,
      item_revision: stamp.itemRevision,
      name: source.name,
      category_ids: [...settings.categoryIds],
      pack: { sell_unit: sellUnit },
      fulfilment_regions: [...settings.fulfilmentRegions],
      freshness: { generated_at: stamp.generatedAtIso },
      ...(source.brand === undefined ? {} : { brand: source.brand }),
      ...(source.description === undefined ? {} : { description: source.description }),
      ...(source.variant_of === undefined ? {} : { family_ref: source.variant_of }),
      ...(source.min_order_quantity === undefined
        ? {}
        : {
            // THE SELL UNIT'S OWN CODE, not the same defaulting expression
            // written a second time. A minimum order is a count of the thing
            // being sold, so the two cannot legitimately disagree — and two
            // copies of one rule is how they would come to.
            minimum_order: { value: source.min_order_quantity, unit_code: sellUnit.unit_code },
          }),
      ...(source.list_price === undefined || settings.tradingCurrency === undefined
        ? {}
        : {
            indicative_price: {
              // The CURRENCY IS THE SELLER'S, not the row's. The importer
              // carries a currency on the row because a CSV may state one, but
              // this lane's rows come from a model reading a symbol off a
              // photograph, and `₹` alone does not distinguish several
              // currencies.
              currency: settings.tradingCurrency,
              minor_units: source.list_price.minor_units,
            },
          }),
    };

    const identifiers = identifiersOf(source, identity.supplierDid);
    if (identifiers.length > 0) item.identifiers = identifiers;

    // VALIDATED HERE, not left to the publisher. `buildCatalogSnapshot` takes
    // `readonly unknown[]` and never calls this, so an item that skipped it
    // would be paginated, digested and signed — and refused by every consumer.
    const refusal = validateCatalogItem(item);
    if (refusal !== null) {
      findings.push({ refusal: 'item_rejected', index, detail: refusal });
      continue;
    }

    // TWO ROWS, ONE PRODUCT IDENTITY, is not a catalog. §9.4 is explicit that
    // an index merging two identities answers a buyer's question about one
    // product with another's, and AppView refuses such a snapshot outright as
    // `duplicate_identity` — so a catalog that got this far would be built,
    // reviewed, signed, published and then rejected by the only consumer.
    //
    // It also collapses provenance: the draft's decisions are keyed by product
    // identity, so a repair to either row would carry the other's acceptance.
    // Refusing here keeps one identity meaning one thing everywhere.
    const productKey = productIdentity(item);
    const claimedBy = identities.get(productKey);
    if (claimedBy !== undefined) {
      findings.push({
        refusal: 'duplicate_identity',
        index,
        detail: `this product is already claimed by row ${String(claimedBy + 1)} — two rows cannot publish one identity (§9.4)`,
      });
      continue;
    }
    identities.set(productKey, index);
    assembled.push(item);
  }

  if (findings.length > 0) return { ok: false, findings };
  return { ok: true, items: assembled };
}
