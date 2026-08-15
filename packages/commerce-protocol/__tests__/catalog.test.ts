import {
  MAX_CATALOG_ATTRIBUTES,
  validateCatalogItem,
  validateCatalogItemForIngest,
  validateProductRelationshipClaim,
} from '../src/catalog';

import { SUPPLIER_DID } from './helpers/fixtures';

const validItem = () => ({
  product: { scheme: 'gtin' as const, value: '09506000134352' },
  supplier_did: SUPPLIER_DID,
  catalog_id: 'cat-1',
  item_revision: 'r1',
  name: 'Toned Milk 1L Carton',
  category_ids: ['dairy.milk'],
  pack: { sell_unit: { value: '1', unit_code: 'l' }, units_per_pack: '12' },
  fulfilment_regions: [{ scheme: 'postal_area' as const, value: '682001' }],
  freshness: { generated_at: '2026-08-07T00:00:00Z' },
});

describe('validateCatalogItem (§9.5)', () => {
  it('accepts a canonical item', () => {
    expect(validateCatalogItem(validItem())).toBeNull();
  });

  /**
   * §12.1 — a published item carries the declared fields and NOTHING else.
   *
   * The validator used to inspect the fields it knew and stay silent about the
   * rest, so an extra key travelled into the published record and into the
   * canonical bytes the snapshot digest commits to. `image_url` is the case
   * that matters: the §12.1 leakage gate allows it BY NAME, so the one field a
   * photo-catalog lane must never publish had no structural obstacle anywhere.
   */
  it('refuses an unknown field, naming it', () => {
    const withImage = { ...validItem(), image_url: 'https://example.test/a.jpg' };
    expect(validateCatalogItem(withImage)).toMatch(/unknown field "image_url"/);
  });

  /**
   * THE PUBLISHER'S RULE IS NOT THE READER'S, and this pins the difference.
   *
   * §9.13 makes a same-major higher MINOR additive: a 1.1 publisher may put a
   * field on an item a 1.0 reader has never heard of. AppView projects a
   * snapshot all-or-nothing and turns a failed projection into a refusal, so a
   * reader applying the exact-key rule would make a valid, correctly-signed
   * 1.1 catalog vanish from the index entirely — blamed on the supplier.
   *
   * The two must agree about KNOWN fields and disagree about unknown ones, so
   * both halves are asserted here rather than left to the two call sites.
   */
  it('tolerates an unknown field on the READ path, which the publisher refuses', () => {
    const additive = { ...validItem(), rrp_minor_units: '1500' };
    expect(validateCatalogItem(additive)).toMatch(/unknown field "rrp_minor_units"/);
    expect(validateCatalogItemForIngest(additive)).toBeNull();
  });

  it('refuses a FORBIDDEN field on the read path, unknown though it is', () => {
    // The tolerance for additive keys stops at the named ones. Live stock and
    // buyer-specific terms belong in a live service result (§10.4), and the
    // photo lane's image stays in the vault (§7) — an item carrying one is not
    // a future minor this build has not caught up with, it is a violation.
    for (const key of ['stock_on_hand', 'authorized_buyer', 'customer_price', 'image_url']) {
      const leaky = { ...validItem(), [key]: 'x' };
      expect(validateCatalogItemForIngest(leaky)).toMatch(/forbidden field/);
      // And the publisher refuses it too, one rule earlier.
      expect(validateCatalogItem(leaky)).toMatch(/unknown field/);
    }
  });

  it('applies the SAME field rules on both paths — only the key set differs', () => {
    // A malformed KNOWN field is refused by the reader too. If this ever
    // passes, the reader has stopped validating rather than started
    // tolerating, which is a different and much worse thing.
    const badName = { ...validItem(), name: '' };
    expect(validateCatalogItem(badName)).not.toBeNull();
    expect(validateCatalogItemForIngest(badName)).toEqual(validateCatalogItem(badName));

    const badRegion = { ...validItem(), fulfilment_regions: [] };
    expect(validateCatalogItemForIngest(badRegion)).toEqual(validateCatalogItem(badRegion));

    expect(validateCatalogItemForIngest('not an object')).toBe('catalogItem: must be an object');
  });

  it('refuses an unknown field even when every declared field is valid', () => {
    // Why the check runs BEFORE the field-by-field pass: correctness in the
    // known fields must not buy silence about an unknown one.
    expect(validateCatalogItem(validItem())).toBeNull();
    expect(validateCatalogItem({ ...validItem(), sneaked: 1 })).toMatch(/unknown field "sneaked"/);
  });

  it('still accepts every OPTIONAL declared field — exact, not narrow', () => {
    // A key list that also refused the optional fields would satisfy the two
    // tests above and quietly make half the type unpublishable.
    expect(
      validateCatalogItem({
        ...validItem(),
        brand: 'ChairMaker',
        description: 'An oak chair.',
        relationship_claim_refs: [],
        attributes: { finish: 'oiled' },
      }),
    ).toBeNull();
  });

  it('applies the §9.3 issuer-binding rule to identifiers', () => {
    const item = {
      ...validItem(),
      identifiers: [{ scheme: 'manufacturer_sku' as const, value: 'SKU-9' }],
    };
    expect(validateCatalogItem(item)).toMatch(/issuer_did/);
  });

  it('bounds attributes so they cannot become a prompt-text dump', () => {
    const attributes: Record<string, string> = {};
    for (let i = 0; i <= MAX_CATALOG_ATTRIBUTES; i += 1) attributes[`k${i}`] = 'v';
    expect(validateCatalogItem({ ...validItem(), attributes })).toMatch(
      /bounded, category-governed/,
    );
    expect(
      validateCatalogItem({ ...validItem(), attributes: { shelf_life_days: 'x'.repeat(201) } }),
    ).toMatch(/exceeds 200/);
  });

  it('requires a positive sell unit and canonical units_per_pack', () => {
    const zeroSell = { ...validItem(), pack: { sell_unit: { value: '0', unit_code: 'l' } } };
    expect(validateCatalogItem(zeroSell)).toMatch(/positive/);
    const badPack = {
      ...validItem(),
      pack: { sell_unit: { value: '1', unit_code: 'l' }, units_per_pack: '012' },
    };
    expect(validateCatalogItem(badPack)).toMatch(/units_per_pack/);
  });
});

describe('validateProductRelationshipClaim (§9.4)', () => {
  const base = {
    claim_id: 'claim-1',
    subject: { scheme: 'gtin' as const, value: '09506000134352' },
    issuer_did: SUPPLIER_DID,
  };

  it('accepts product-object and did-object relationships appropriately', () => {
    expect(
      validateProductRelationshipClaim({
        ...base,
        relationship: 'packaging_variant_of',
        object: { scheme: 'gtin', value: '09506000134369' },
      }),
    ).toBeNull();
    expect(
      validateProductRelationshipClaim({
        ...base,
        relationship: 'manufactured_by',
        object: { did: 'did:plc:mfr' },
      }),
    ).toBeNull();
  });

  it('rejects a DID object on a product-to-product relationship', () => {
    expect(
      validateProductRelationshipClaim({
        ...base,
        relationship: 'variant_of',
        object: { did: 'did:plc:mfr' },
      }),
    ).toMatch(/must be a ProductRef/);
  });

  it('rejects a ProductRef object on an OPERATOR relationship (the inverse)', () => {
    // The direction that was open. "manufactured_by" a PRODUCT is not a
    // typo the projection can absorb: it composes inherited manufacturer
    // standing along an edge that means nothing.
    expect(
      validateProductRelationshipClaim({
        ...base,
        relationship: 'manufactured_by',
        object: { scheme: 'gtin', value: '09506000134369' },
      }),
    ).toMatch(/must carry a did/);
    expect(
      validateProductRelationshipClaim({
        ...base,
        relationship: 'sold_by',
        object: { scheme: 'gtin', value: '09506000134369' },
      }),
    ).toMatch(/must carry a did/);
  });

  it('enforces temporal validity ordering', () => {
    expect(
      validateProductRelationshipClaim({
        ...base,
        relationship: 'replaces',
        object: { scheme: 'gtin', value: '09506000134369' },
        effective_from: '2026-08-07T00:00:00Z',
        effective_until: '2026-08-01T00:00:00Z',
      }),
    ).toMatch(/after effective_from/);
  });
});
