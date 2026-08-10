/**
 * §12.1 rule 1 — the closed vocabulary must BE the wire type.
 *
 * THE DEFECT THIS EXISTS TO PREVENT, because it already happened once.
 * `PUBLIC_CATALOG_FIELDS` was written from §12.1's prose as a hand-picked set
 * (`category`, `regions`, `list_price`, `pack_size`) while
 * `@dina/commerce-protocol` defines the published item as `category_ids`,
 * `fulfilment_regions`, `indicative_price`, `pack`. The two never met, so
 * Core's own publication gate refused every item shape AppView's ingest
 * requires — a supplier publishing a real `CatalogItem` could not publish at
 * all.
 *
 * Neither side's tests could see it. Core's publisher tests used a flat
 * `{sku, name}` CSV shape; AppView's ingest tests hand-built `CatalogItem`s and
 * never called Core's publisher. Two vocabularies, each self-consistent.
 *
 * SO THIS IS THE FIX, and the list is data it checks. A field the wire type
 * permits and this gate refuses is unpublishable; a field the gate permits and
 * the wire type does not know is a hole in the closed vocabulary. Both
 * directions are asserted, driven off a maximal item built through the real
 * validator rather than off a list someone maintains by hand.
 */

import { validateCatalogItem } from '@dina/commerce-protocol';

import { PUBLIC_CATALOG_FIELDS, findCatalogLeakage } from '../../src/commerce/catalog_leakage';

const SUPPLIER = 'did:plc:chairmaker99';

/**
 * A `CatalogItem` carrying EVERY optional field the wire type allows.
 *
 * Maximal on purpose: an item that omitted the optionals would pass this test
 * while leaving exactly the fields nobody thought about unpublishable, which is
 * the shape of the defect being prevented.
 */
function maximalItem(): Record<string, unknown> {
  return {
    product: {
      scheme: 'gtin',
      value: '5901234123457',
      issuer_did: SUPPLIER,
      variant_digest: 'a'.repeat(64),
    },
    supplier_did: SUPPLIER,
    catalog_id: 'chairmaker-seating',
    item_revision: '3',
    name: 'Oak dining chair',
    brand: 'ChairMaker',
    family_ref: { scheme: 'manufacturer_sku', value: 'FAMILY-OAK', issuer_did: SUPPLIER },
    formulation_ref: { scheme: 'manufacturer_sku', value: 'FORM-OAK', issuer_did: SUPPLIER },
    // An ID, not an AT-URI: the validator's charset is [A-Za-z0-9._:-].
    relationship_claim_refs: ['claim-oak-family-2026'],
    description: 'Solid oak, four legs.',
    category_ids: ['furniture.seating'],
    pack: { sell_unit: { value: '1', unit_code: 'each' }, units_per_pack: '4' },
    identifiers: [{ scheme: 'manufacturer_sku', value: 'CHAIR2024B', issuer_did: SUPPLIER }],
    fulfilment_regions: [{ scheme: 'admin_area', value: 'IN-KA' }],
    indicative_price: { currency: 'INR', minor_units: '450000' },
    minimum_order: { value: '4', unit_code: 'each' },
    freshness: { generated_at: '2026-08-08T09:00:00.000Z', valid_until: '2026-09-08T09:00:00.000Z' },
    attributes: { finish: 'matte', stackable: true, seat_height_cm: 45 },
  };
}

/** Every distinct key name anywhere in a value, at any depth. */
function keyNames(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) keyNames(entry, out);
    return out;
  }
  if (value === null || typeof value !== 'object') return out;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out.add(key);
    // `attributes` keys are supplier-chosen and bounded by §9.5; they are not
    // vocabulary, so the subtree below that key is not walked for names.
    if (key !== 'attributes') keyNames(child, out);
  }
  return out;
}

describe('the closed vocabulary and the wire type are one list', () => {
  it('the maximal item is a VALID CatalogItem, so the fixture is not the thing being tested', () => {
    // If this drifts out of validity the test below starts asserting something
    // about a shape no supplier can publish, which is how the original defect
    // hid for as long as it did.
    expect(validateCatalogItem(maximalItem())).toBeNull();
  });

  it('publishes every field a valid CatalogItem can carry', () => {
    // The direction that was broken: a field the wire type permits and this
    // gate refuses makes an honest catalog unpublishable.
    const findings = findCatalogLeakage(maximalItem());

    expect(findings).toEqual([]);
  });

  it('names every one of those fields in the vocabulary, not merely tolerating them', () => {
    // Stronger than the assertion above, and deliberately so: passing the walk
    // could in principle come from a hole in the walk rather than from
    // membership. This asserts membership directly.
    const missing = [...keyNames(maximalItem())].filter(
      (name) => !PUBLIC_CATALOG_FIELDS.has(name),
    );

    expect(missing).toEqual([]);
  });

  it('still refuses a field the wire type does not know', () => {
    // The vocabulary being complete must not mean the vocabulary being open.
    const findings = findCatalogLeakage({ ...maximalItem(), cost_basis: 42 });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.refusal).toBe('unknown_public_field');
    expect(findings[0]?.path).toBe('item.cost_basis');
  });

  it('allows supplier-chosen ATTRIBUTE KEYS while still scanning their values', () => {
    // §9.5 makes `attributes` a bounded free-form map, so its keys cannot be
    // vocabulary. Its VALUES are still supplier text reaching a public record,
    // which is exactly where the value scan belongs.
    expect(findCatalogLeakage({ ...maximalItem(), attributes: { finish: 'oiled' } })).toEqual([]);

    const leaked = findCatalogLeakage({
      ...maximalItem(),
      attributes: { contact: 'raj@example.com' },
    });
    expect(leaked[0]?.refusal).toBe('personal_identifier_value');
  });
});

/**
 * The OTHER lane: a flat CSV import, before normalization.
 *
 * Reconciling the vocabulary to the wire type dropped `category` — the flat
 * column name — and broke every spreadsheet import. An existing test caught it,
 * which was luck rather than design: nothing said the two lanes both had to be
 * covered. This says it.
 */
describe('the flat import lane publishes too', () => {
  it('passes the columns a spreadsheet import produces', () => {
    const findings = findCatalogLeakage({
      sku: 'CHAIR-1',
      mpn: 'CM-OAK-1',
      name: 'Oak dining chair',
      description: 'Solid oak, flat packed.',
      category: 'furniture/seating',
      brand: 'ChairMaker',
      image_url: 'https://example.invalid/chair.jpg',
      unit_code: 'each',
      pack_size: '4',
      min_order_quantity: '4',
      lead_time_days: 14,
      regions: ['IN-KA'],
      availability: 'in_stock',
      list_price: { currency: 'INR', minor_units: '450000' },
    });

    expect(findings).toEqual([]);
  });

  it('names both spellings of the category column, so neither lane can be dropped', () => {
    // The specific omission that happened, asserted as a pair rather than as
    // two separate facts a future edit could satisfy one of.
    expect(PUBLIC_CATALOG_FIELDS.has('category')).toBe(true);
    expect(PUBLIC_CATALOG_FIELDS.has('category_ids')).toBe(true);
  });
});
