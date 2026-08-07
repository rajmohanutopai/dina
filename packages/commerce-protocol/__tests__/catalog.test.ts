import {
  MAX_CATALOG_ATTRIBUTES,
  validateCatalogItem,
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
