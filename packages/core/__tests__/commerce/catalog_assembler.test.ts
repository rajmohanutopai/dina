/**
 * The assembler — the middle of the chain that did not exist (§3).
 *
 * Rows could be parsed and imported, and snapshots could be built from items,
 * and nothing turned one into the other. `buildCatalogSnapshot` takes
 * `readonly unknown[]` and never validates, so the gap was not a compile error
 * either: flat import items would have been paginated, digested and signed,
 * and AppView would have refused to project them.
 *
 * These tests are mostly about WHERE A VALUE COMES FROM. The lane's whole
 * safety argument is that a model reading a photograph supplies none of the
 * fields that decide who can buy, where it ships, or what currency the price
 * is in — so a test that only checked "an item came out" would miss the point
 * entirely.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import {
  validateCatalogItem,
  type RegionRef,
  type Sha256Fn,
} from '@dina/commerce-protocol';

import {
  assembleCatalogItems,
  type AssemblySettings,
  type AssemblyStamp,
} from '../../src/commerce/catalog_assembler';
import { buildCatalogSnapshot } from '../../src/commerce/catalog_publisher';


import type { CatalogImportItem } from '../../src/commerce/catalog_import';

const SUPPLIER = 'did:plc:chairmaker99';
const CATALOG = 'chairmaker-main';
const REGION: RegionRef = { scheme: 'admin_area', value: 'IN-KA' };

const STAMP: AssemblyStamp = {
  generatedAtIso: '2026-08-13T09:00:00.000Z',
  itemRevision: 'rev-1',
};

function settings(overrides: Partial<AssemblySettings> = {}): AssemblySettings {
  return {
    categoryIds: ['furniture.seating'],
    fulfilmentRegions: [REGION],
    tradingCurrency: 'INR',
    ...overrides,
  };
}

function row(overrides: Partial<CatalogImportItem> = {}): CatalogImportItem {
  return {
    product: { scheme: 'manufacturer_sku', value: 'CHAIR-1', issuer_did: SUPPLIER },
    name: 'Oak dining chair',
    unit_code: 'each',
    ...overrides,
  };
}

function assemble(items: CatalogImportItem[], s: AssemblySettings = settings()) {
  return assembleCatalogItems({
    items,
    identity: { supplierDid: SUPPLIER, catalogId: CATALOG },
    settings: s,
    stamp: STAMP,
  });
}

describe('what the assembler produces', () => {
  it('produces an item the WIRE accepts, not merely one that type-checks', () => {
    const result = assemble([row()]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The assertion that matters: run the protocol's own validator over the
    // output. A hand-checked field list here would inherit whatever this file
    // believes about the type rather than what the wire enforces.
    expect(validateCatalogItem(result.items[0])).toBeNull();
  });

  it('fills identity and stamp from the caller, never from the row', () => {
    const result = assemble([row()]);
    if (!result.ok) throw new Error(JSON.stringify(result.findings));
    expect(result.items[0]).toMatchObject({
      supplier_did: SUPPLIER,
      catalog_id: CATALOG,
      item_revision: 'rev-1',
      freshness: { generated_at: '2026-08-13T09:00:00.000Z' },
    });
  });

  it('takes categories and regions from SETTINGS — the two a model cannot know', () => {
    // A model reading a price list cannot know where a seller ships, and free
    // text off that list ("Pickles & Preserves") cannot be a category id at
    // all. Both come from the person. This is the lane's central claim.
    const result = assemble([row({ category: 'Pickles & Preserves' })], settings({
      categoryIds: ['food.preserves'],
      fulfilmentRegions: [{ scheme: 'country', value: 'IN' }],
    }));
    if (!result.ok) throw new Error(JSON.stringify(result.findings));
    expect(result.items[0]?.category_ids).toEqual(['food.preserves']);
    expect(result.items[0]?.fulfilment_regions).toEqual([{ scheme: 'country', value: 'IN' }]);
    // And the row's own free-text category reached nothing.
    expect(JSON.stringify(result.items[0])).not.toContain('Pickles & Preserves');
  });

  it('prices in the SUPPLIER’s currency, not one read off the page', () => {
    // The importer carries a currency on the row because a CSV may state one.
    // This lane's rows come from a model reading a symbol, and `₹` alone does
    // not distinguish several currencies — so settings win.
    const result = assemble(
      [row({ list_price: { currency: 'USD', minor_units: '18000' } })],
      settings({ tradingCurrency: 'INR' }),
    );
    if (!result.ok) throw new Error(JSON.stringify(result.findings));
    expect(result.items[0]?.indicative_price).toEqual({ currency: 'INR', minor_units: '18000' });
  });

  it('scopes a manufacturer_sku identifier to the supplier (§9.3)', () => {
    const result = assemble([row({ sku: 'SKU-9' })]);
    if (!result.ok) throw new Error(JSON.stringify(result.findings));
    expect(result.items[0]?.identifiers).toEqual([
      { scheme: 'manufacturer_sku', value: 'SKU-9', issuer_did: SUPPLIER },
    ]);
  });

  it('gives every item in one draft the SAME revision and timestamp', () => {
    // §10.2 snapshots are full state: the items move together, so a per-item
    // stamp would say they did not.
    const result = assemble([row(), row({ product: { scheme: 'gtin', value: '05012345678900' } })]);
    if (!result.ok) throw new Error(JSON.stringify(result.findings));
    expect(result.items[0]?.item_revision).toBe(result.items[1]?.item_revision);
    expect(result.items[0]?.freshness.generated_at).toBe(result.items[1]?.freshness.generated_at);
  });

  it('is reproducible — the same stamp yields byte-identical items', () => {
    // The property the whole approval design rests on: a rebuild after a lost
    // CAS must reproduce the bytes the owner approved. If assembly minted its
    // own timestamp, it could not.
    const a = assemble([row()]);
    const b = assemble([row()]);
    if (!a.ok || !b.ok) throw new Error('expected both to assemble');
    expect(JSON.stringify(a.items)).toBe(JSON.stringify(b.items));
  });
});

describe('what it refuses, and why each refusal is its own', () => {
  it('refuses when no categories are configured, ONCE rather than per item', () => {
    // Ten items with one missing setting is one problem, not ten. Reporting it
    // per row buries the single thing the seller has to fix.
    const result = assemble([row(), row(), row()], settings({ categoryIds: [] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ refusal: 'no_categories_configured', index: -1 });
  });

  it('refuses when no regions are configured', () => {
    const result = assemble([row()], settings({ fulfilmentRegions: [] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.findings[0]?.refusal).toBe('no_regions_configured');
  });

  it('refuses a PRICED row when the supplier has no currency, and names the row', () => {
    const result = assemble(
      [row(), row({ list_price: { currency: 'INR', minor_units: '18000' } })],
      settings({ tradingCurrency: undefined }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.findings[0]).toMatchObject({ refusal: 'no_trading_currency', index: 1 });
  });

  it('ACCEPTS an unpriced catalog with no currency — absence is a real state', () => {
    // The mirror of the case above, and the reason `tradingCurrency` is
    // optional rather than required. Without this test the refusal could be
    // "always refuse when currency is absent" and still look correct.
    const result = assemble([row()], settings({ tradingCurrency: undefined }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0]?.indicative_price).toBeUndefined();
  });

  it('refuses a stored currency the wire would reject', () => {
    const result = assemble([row()], settings({ tradingCurrency: 'inr' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.findings[0]?.refusal).toBe('malformed_trading_currency');
  });

  it('is ALL OR NOTHING — one bad row publishes no catalog', () => {
    // §10.2 snapshots are full state, so publishing the items that happened to
    // assemble would silently withdraw the ones that did not.
    const result = assemble([
      row(),
      // A scoped scheme with no issuer: `validateCatalogItem` refuses it.
      row({ product: { scheme: 'manufacturer_sku', value: 'NO-ISSUER' } }),
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.findings[0]).toMatchObject({ refusal: 'item_rejected', index: 1 });
  });

  it('refuses a row with NO NAME rather than publishing the identifier as one', () => {
    // An earlier version fell back to `product.value`, which puts "CHAIR-1" in
    // front of buyers as the product's name because a model could not read the
    // label. §5 sends an unreadable cell back empty; repair is where the seller
    // supplies it.
    const result = assemble([row({ name: undefined })]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.findings[0]).toMatchObject({ refusal: 'no_name', index: 0 });
  });

  it('refuses a pack size with no unit — the thousandfold error §2 opens on', () => {
    // "500" is 500 grams or 500 jars depending on a glyph the model did not
    // return. Defaulting to `each` would sign the wrong one silently.
    const result = assemble([row({ pack_size: '500', unit_code: undefined })]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.findings[0]).toMatchObject({ refusal: 'quantity_without_unit', index: 0 });
  });

  it('ACCEPTS a row with neither size nor unit as one each', () => {
    // The mirror. Both absent means the row named no quantity, and one of the
    // thing is the honest reading — so the refusal above is about a bare
    // NUMBER, not about an absent unit.
    const result = assemble([row({ pack_size: undefined, unit_code: undefined })]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0]?.pack.sell_unit).toEqual({ value: '1', unit_code: 'each' });
  });

  it('gives minimum_order the SAME unit as the sell unit', () => {
    const result = assemble([row({ unit_code: 'kg', pack_size: '2', min_order_quantity: '10' })]);
    if (!result.ok) throw new Error(JSON.stringify(result.findings));
    expect(result.items[0]?.minimum_order?.unit_code).toBe(
      result.items[0]?.pack.sell_unit.unit_code,
    );
  });

  it('refuses rather than emitting an item the publisher would sign unvalidated', () => {
    // `buildCatalogSnapshot` takes `readonly unknown[]` and never validates, so
    // anything this function returns is signed as-is. That makes the validate
    // call here load-bearing rather than belt-and-braces.
    const result = assemble([row({ unit_code: 'furlong' })]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.findings[0]?.detail).toMatch(/unit/i);
  });
});

/**
 * THE BRIDGE ITSELF, driven rather than asserted about.
 *
 * The gap this module fills was invisible for a long time because each side
 * was tested alone: the importer had tests, the publisher had tests, and
 * nothing put one's output into the other. `buildCatalogSnapshot` takes
 * `readonly unknown[]`, so the type system could not have caught it either.
 * A test that stops at "the assembler returned items" would reproduce exactly
 * that blindness.
 */
describe('assembler → publisher, end to end', () => {
  const hash: Sha256Fn = (data) => sha256(data);

  it('produces items the publisher can build a snapshot from', () => {
    const assembled = assemble([row(), row({ product: { scheme: 'gtin', value: '05012345678900' } , name: 'Elm stool' })]);
    if (!assembled.ok) throw new Error(JSON.stringify(assembled.findings));

    const built = buildCatalogSnapshot({
      supplierDid: SUPPLIER,
      catalogId: CATALOG,
      protocolVersion: '1.0',
      publishedAt: '2026-08-13T09:00:00.000Z',
      items: assembled.items,
      previous: null,
      sha256: hash,
    });

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.snapshot?.item_count).toBe(2);
    expect(built.pages?.length).toBeGreaterThan(0);
  });

  it('and those items survive the §12.1 leakage gate the publisher runs', () => {
    // The gate refused ChairMaker's own catalog once, because the leakage
    // vocabulary had been written from the spec's prose rather than from the
    // published item type. An assembler that emitted a field the gate rejects
    // would fail here rather than at a supplier's first publication.
    const assembled = assemble([
      row({ sku: 'SKU-9', brand: 'ChairMaker', description: 'An oak chair.', list_price: { currency: 'INR', minor_units: '18000' } }),
    ]);
    if (!assembled.ok) throw new Error(JSON.stringify(assembled.findings));

    const built = buildCatalogSnapshot({
      supplierDid: SUPPLIER,
      catalogId: CATALOG,
      protocolVersion: '1.0',
      publishedAt: '2026-08-13T09:00:00.000Z',
      items: assembled.items,
      previous: null,
      sha256: hash,
    });
    // `ok:false` here would carry a `leakage_refused` refusal naming the field.
    expect(built).toMatchObject({ ok: true });
  });
});

describe('two rows, one product identity', () => {
  // WHY THIS IS A REFUSAL AND NOT A MERGE. Three separate things break when a
  // catalog carries one identity twice, and only one of them is visible here:
  //
  //   AppView refuses the whole snapshot as `duplicate_identity`, so the
  //   catalog would be built, reviewed, signed, published — and projected by
  //   nobody. A supplier would see success and no listing.
  //
  //   The draft's per-field decisions are keyed by product identity, so the
  //   owner accepting a model-read price on one row would silently vouch for
  //   the other row's price too. That is the lane's one safety property,
  //   broken by a duplicated key.
  //
  //   §9.4 substitution resolves a buyer's line to a product. Two answers is
  //   not an answer.
  //
  // Refusing at assembly removes all three by construction: no colliding pair
  // ever reaches a draft, a decision map, or a signature.

  it('is refused, naming the row that claimed the identity first', () => {
    const assembled = assemble([
      row({ name: 'Oak dining chair' }),
      row({ name: 'Oak dining chair, second listing' }),
    ]);

    expect(assembled.ok).toBe(false);
    if (assembled.ok) return;
    expect(assembled.findings).toEqual([
      expect.objectContaining({ refusal: 'duplicate_identity', index: 1 }),
    ]);
    // The message points at the row a person can go and look at, 1-based
    // because that is how a spreadsheet numbers them.
    expect(assembled.findings[0]?.detail).toContain('row 1');
  });

  it('and refused whole, so the surviving row is not published alone', () => {
    // All-or-nothing, as `importCatalogRows` is: §10.2 snapshots are full
    // state, so publishing the row that happened to assemble would withdraw
    // the one that did not.
    const assembled = assemble([
      row({ product: { scheme: 'manufacturer_sku', value: 'STOOL-1', issuer_did: SUPPLIER }, name: 'Stool' }),
      row({ name: 'Chair' }),
      row({ name: 'Chair again' }),
    ]);

    expect(assembled).toMatchObject({ ok: false });
  });

  it('but the same value under a different issuer is a different product', () => {
    // Identity is the whole `ProductRef`, not the value alone. Two suppliers
    // numbering their own SKUs `CHAIR-1` is ordinary, and a length-prefixed
    // key is what stops one field's content spilling into the next.
    const assembled = assemble([
      row(),
      row({ product: { scheme: 'manufacturer_sku', value: 'CHAIR-1', issuer_did: 'did:plc:otherfactory' } }),
    ]);

    expect(assembled).toMatchObject({ ok: true });
  });

  it('and a variant of a product is a different product', () => {
    const assembled = assemble([
      row(),
      row({ product: { scheme: 'manufacturer_sku', value: 'CHAIR-1', issuer_did: SUPPLIER, variant_digest: 'a'.repeat(64) } }),
    ]);

    expect(assembled).toMatchObject({ ok: true });
  });
});
