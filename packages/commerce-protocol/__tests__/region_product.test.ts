import { validateProtocolVersionShape, checkProtocolVersion, validateIsoUtc } from '../src/common';
import { productRefsEqual, validateProductRef } from '../src/product';
import {
  computeProjectionDigest,
  projectionExtends,
  validateDeliveryProjection,
  validateRegionRef,
} from '../src/region';
import { validateProductSearchRequirements, MAX_QUERY_TEXT_LENGTH } from '../src/search';

import { hash, makeProjection } from './helpers/fixtures';

describe('validateRegionRef', () => {
  it('accepts standard schemes', () => {
    expect(validateRegionRef({ scheme: 'country', value: 'IN' })).toBeNull();
    expect(validateRegionRef({ scheme: 'postal_area', value: '682001' })).toBeNull();
  });

  it('requires issuer_did for custom schemes', () => {
    expect(validateRegionRef({ scheme: 'custom', value: 'zone-4' })).toMatch(/requires issuer_did/);
    expect(
      validateRegionRef({ scheme: 'custom', value: 'zone-4', issuer_did: 'did:plc:issuer' }),
    ).toBeNull();
  });

  it('rejects unknown schemes and unbounded values', () => {
    expect(validateRegionRef({ scheme: 'zipcode', value: 'x' })).toMatch(/scheme/);
    expect(validateRegionRef({ scheme: 'country', value: 'x'.repeat(101) })).toMatch(/exceeds/);
  });
});

describe('validateDeliveryProjection', () => {
  it('accepts a stage-scoped projection with a correct digest', () => {
    expect(validateDeliveryProjection(makeProjection(), hash)).toBeNull();
    expect(
      validateDeliveryProjection(
        makeProjection({ address_lines: ['12 Harbour Rd'], recipient_name: 'Stores Desk' }),
        hash,
      ),
    ).toBeNull();
  });

  it('rejects a digest computed over different fields', () => {
    const projection = { ...makeProjection(), locality: 'Kochi' };
    expect(validateDeliveryProjection(projection, hash)).toMatch(/does not match/);
  });

  it('bounds address lines', () => {
    const lines = Array.from({ length: 6 }, (_, i) => `line ${i}`);
    const base = { region: { scheme: 'postal_area', value: '682001' }, address_lines: lines };
    const projection = {
      ...base,
      projection_digest: computeProjectionDigest(base as never, hash),
    };
    expect(validateDeliveryProjection(projection, hash)).toMatch(/exceeds 5 lines/);
  });
});

describe('projectionExtends (§9.9 order rule)', () => {
  const priced = makeProjection({ locality: 'Kochi' });

  it('accepts byte-identical priced fields plus additions', () => {
    const order = makeProjection({
      locality: 'Kochi',
      address_lines: ['12 Harbour Rd'],
      recipient_name: 'Stores Desk',
    });
    expect(projectionExtends(priced as never, order as never)).toBeNull();
  });

  it('rejects a dropped priced field', () => {
    const order = makeProjection({ address_lines: ['12 Harbour Rd'] });
    expect(projectionExtends(priced as never, order as never)).toMatch(/missing from the order/);
  });

  it('rejects a changed priced field — requote required', () => {
    const order = makeProjection({ locality: 'Ernakulam' });
    expect(projectionExtends(priced as never, order as never)).toMatch(
      /changed between quote and order/,
    );
  });
});

describe('validateProductRef', () => {
  it('enforces issuer binding for scoped schemes', () => {
    expect(validateProductRef({ scheme: 'manufacturer_sku', value: 'SKU-9' })).toMatch(/issuer_did/);
    expect(
      validateProductRef({ scheme: 'manufacturer_sku', value: 'SKU-9', issuer_did: 'did:plc:mfr' }),
    ).toBeNull();
    expect(validateProductRef({ scheme: 'custom', value: 'x-1' })).toMatch(/issuer_did/);
  });

  it('validates gtin shape', () => {
    expect(validateProductRef({ scheme: 'gtin', value: '09506000134352' })).toBeNull();
    expect(validateProductRef({ scheme: 'gtin', value: 'ABC123' })).toMatch(/8-14 digits/);
  });

  it('exact-variant equality includes issuer and variant digest', () => {
    const a = { scheme: 'gtin' as const, value: '09506000134352' };
    expect(productRefsEqual(a, { ...a })).toBe(true);
    expect(productRefsEqual(a, { ...a, variant_digest: 'a'.repeat(64) })).toBe(false);
  });
});

describe('protocol version negotiation (§9.13)', () => {
  it('validates MAJOR.MINOR shape', () => {
    expect(validateProtocolVersionShape('1.0', 'v')).toBeNull();
    expect(validateProtocolVersionShape('1', 'v')).toMatch(/MAJOR.MINOR/);
    expect(validateProtocolVersionShape('01.0', 'v')).toMatch(/MAJOR.MINOR/);
  });

  it('admits same-major minors and rejects unknown majors with the typed error', () => {
    expect(checkProtocolVersion('1.7')).toBeNull();
    const err = checkProtocolVersion('2.0');
    expect(err?.code).toBe('unsupported_version');
    expect(err?.supported_versions).toEqual(['1.0']);
  });
});

describe('canonical ISO UTC timestamps', () => {
  it('accepts Z-suffixed instants with no or 3-digit fractions', () => {
    expect(validateIsoUtc('2026-08-07T10:00:00Z', 't')).toBeNull();
    expect(validateIsoUtc('2026-08-07T10:00:00.500Z', 't')).toBeNull();
  });

  it('rejects offsets, missing Z, and odd fractions', () => {
    for (const t of [
      '2026-08-07T10:00:00+05:30',
      '2026-08-07T10:00:00',
      '2026-08-07T10:00:00.5Z',
      '2026-13-40T99:00:00Z',
    ]) {
      expect(validateIsoUtc(t, 't')).not.toBeNull();
    }
  });
});

describe('validateProductSearchRequirements', () => {
  it('accepts a closed-field default with no free text', () => {
    expect(
      validateProductSearchRequirements({
        identifiers: [{ scheme: 'gtin', value: '09506000134352' }],
        category_ids: ['dairy.milk'],
        quantity: { value: '100', unit_code: 'case' },
        delivery_region: { scheme: 'postal_area', value: '682001' },
      }),
    ).toBeNull();
  });

  it('bounds owner-opt-in query_text', () => {
    expect(
      validateProductSearchRequirements({ query_text: 'x'.repeat(MAX_QUERY_TEXT_LENGTH + 1) }),
    ).toMatch(/bounded/);
  });
});
