/**
 * Tests for the capabilities registry + eta_query capability.
 *
 * Source parity target: brain/src/service/capabilities/registry.py and
 * brain/src/service/capabilities/eta_query.py.
 */

import {
  canonicalJSON,
  computeSchemaHash,
  FALLBACK_TTL_SECONDS,
  getCapability,
  getTTL,
  listCapabilities,
  SUPPORTED_CAPABILITIES,
} from '../../../src/service/capabilities/registry';
import {
  EtaQueryParamsSchema,
  EtaQueryResultSchema,
  validateEtaQueryParams,
  validateEtaQueryResult,
} from '../../../src/service/capabilities/eta_query';

describe('capabilities registry', () => {
  describe('SUPPORTED_CAPABILITIES', () => {
    it('lists exactly the registered capabilities', () => {
      expect(SUPPORTED_CAPABILITIES).toEqual(['eta_query']);
    });

    it('is immutable', () => {
      expect(() => {
        (SUPPORTED_CAPABILITIES as unknown as string[]).push('noop');
      }).toThrow();
    });
  });

  describe('getCapability', () => {
    it('returns the eta_query definition', () => {
      const cap = getCapability('eta_query');
      expect(cap).toBeDefined();
      expect(cap?.name).toBe('eta_query');
      expect(cap?.defaultTtlSeconds).toBe(60);
      expect(cap?.validateParams).toBe(validateEtaQueryParams);
      expect(cap?.validateResult).toBe(validateEtaQueryResult);
    });

    it('returns undefined for unknown capabilities', () => {
      expect(getCapability('mystery')).toBeUndefined();
      expect(getCapability('')).toBeUndefined();
    });
  });

  describe('getTTL', () => {
    it('returns the capability default for known capabilities', () => {
      expect(getTTL('eta_query')).toBe(60);
    });

    it('returns FALLBACK_TTL_SECONDS for unknown capabilities', () => {
      expect(getTTL('unknown')).toBe(FALLBACK_TTL_SECONDS);
      expect(getTTL('')).toBe(FALLBACK_TTL_SECONDS);
    });

    it('FALLBACK_TTL_SECONDS matches the Python default (60)', () => {
      expect(FALLBACK_TTL_SECONDS).toBe(60);
    });
  });

  describe('listCapabilities', () => {
    it('returns one entry per registered capability', () => {
      const list = listCapabilities();
      expect(list.map((c) => c.name)).toEqual(['eta_query']);
    });
  });
});

describe('canonicalJSON', () => {
  it('sorts object keys recursively', () => {
    const a = canonicalJSON({ b: 1, a: 2, z: { y: 3, x: 4 } });
    const b = canonicalJSON({ a: 2, z: { x: 4, y: 3 }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1,"z":{"x":4,"y":3}}');
  });

  it('preserves array order', () => {
    expect(canonicalJSON([3, 1, 2])).toBe('[3,1,2]');
  });

  it('handles primitives', () => {
    expect(canonicalJSON(null)).toBe('null');
    expect(canonicalJSON(true)).toBe('true');
    expect(canonicalJSON(false)).toBe('false');
    expect(canonicalJSON(42)).toBe('42');
    expect(canonicalJSON('x')).toBe('"x"');
  });

  it('omits undefined object values like JSON.stringify does', () => {
    expect(canonicalJSON({ a: 1, b: undefined, c: 3 })).toBe('{"a":1,"c":3}');
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalJSON(Number.NaN)).toThrow(/non-finite/);
    expect(() => canonicalJSON(Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
    expect(() => canonicalJSON(Number.NEGATIVE_INFINITY)).toThrow(/non-finite/);
  });

  it('rejects unsupported types', () => {
    expect(() => canonicalJSON(() => 0)).toThrow(/unsupported type/);
    expect(() => canonicalJSON(Symbol('s'))).toThrow(/unsupported type/);
    expect(() => canonicalJSON(BigInt(1))).toThrow(/unsupported type/);
  });
});

describe('computeSchemaHash', () => {
  it('is stable across key-order permutations', () => {
    const a = computeSchemaHash({ a: 1, b: { c: 2, d: 3 } });
    const b = computeSchemaHash({ b: { d: 3, c: 2 }, a: 1 });
    expect(a).toBe(b);
  });

  it('produces a 64-character hex SHA-256', () => {
    const hash = computeSchemaHash({ foo: 'bar' });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('parity vector: empty object hashes deterministically', () => {
    // SHA-256 of the canonical bytes "{}"
    expect(computeSchemaHash({})).toBe(
      '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    );
  });

  it('differs when payload differs', () => {
    expect(computeSchemaHash({ a: 1 })).not.toBe(computeSchemaHash({ a: 2 }));
  });
});

describe('eta_query capability', () => {
  describe('validateEtaQueryParams', () => {
    const valid = { location: { lat: 37.77, lng: -122.41 } };

    it('accepts a minimal valid body', () => {
      expect(validateEtaQueryParams(valid)).toBeNull();
    });

    it('accepts an optional route_id', () => {
      expect(validateEtaQueryParams({ ...valid, route_id: '42' })).toBeNull();
    });

    it('rejects non-object', () => {
      expect(validateEtaQueryParams(null)).toContain('must be a JSON object');
      expect(validateEtaQueryParams('x')).toContain('must be a JSON object');
    });

    it('rejects missing location', () => {
      expect(validateEtaQueryParams({})).toContain('location');
    });

    it('rejects out-of-range lat/lng', () => {
      expect(validateEtaQueryParams({ location: { lat: 91, lng: 0 } })).toContain('lat');
      expect(validateEtaQueryParams({ location: { lat: -91, lng: 0 } })).toContain('lat');
      expect(validateEtaQueryParams({ location: { lat: 0, lng: 181 } })).toContain('lng');
      expect(validateEtaQueryParams({ location: { lat: 0, lng: -181 } })).toContain('lng');
    });

    it('rejects non-finite lat/lng', () => {
      expect(validateEtaQueryParams({ location: { lat: Number.NaN, lng: 0 } })).toContain('lat');
      expect(
        validateEtaQueryParams({ location: { lat: 0, lng: Number.POSITIVE_INFINITY } }),
      ).toContain('lng');
    });

    it('rejects extra properties in location', () => {
      expect(validateEtaQueryParams({ location: { lat: 0, lng: 0, alt: 100 } })).toContain(
        'unexpected property',
      );
    });

    it('rejects extra top-level properties', () => {
      expect(validateEtaQueryParams({ ...valid, extra: true })).toContain('unexpected property');
    });

    it('rejects non-string route_id', () => {
      expect(validateEtaQueryParams({ ...valid, route_id: 42 })).toContain('route_id');
    });
  });

  describe('validateEtaQueryResult', () => {
    const valid = {
      eta_minutes: 45,
      vehicle_type: 'bus',
      route_name: 'Route 42',
    };

    it('accepts a minimal valid result', () => {
      expect(validateEtaQueryResult(valid)).toBeNull();
    });

    it('accepts all optional fields', () => {
      expect(
        validateEtaQueryResult({
          ...valid,
          current_location: { lat: 37.77, lng: -122.41 },
          stop_name: 'Market & Powell',
          stop_distance_m: 120,
          map_url: 'https://maps.google.com/?q=37.77,-122.41',
          status: 'on_route',
          message: 'traffic is light',
        }),
      ).toBeNull();
    });

    it('rejects negative eta_minutes', () => {
      expect(validateEtaQueryResult({ ...valid, eta_minutes: -1 })).toContain('eta_minutes');
    });

    it('rejects non-finite eta_minutes', () => {
      expect(validateEtaQueryResult({ ...valid, eta_minutes: Number.NaN })).toContain(
        'eta_minutes',
      );
    });

    it('rejects unknown status', () => {
      expect(validateEtaQueryResult({ ...valid, status: 'teleporting' })).toContain('status');
    });

    it('accepts each allowed status', () => {
      for (const s of ['on_route', 'not_on_route', 'out_of_service', 'not_found']) {
        expect(validateEtaQueryResult({ ...valid, status: s })).toBeNull();
      }
    });

    it('rejects extra top-level properties', () => {
      expect(validateEtaQueryResult({ ...valid, hidden: true })).toContain('unexpected property');
    });

    it('rejects negative stop_distance_m', () => {
      expect(validateEtaQueryResult({ ...valid, stop_distance_m: -1 })).toContain(
        'stop_distance_m',
      );
    });
  });

  describe('JSON Schema exports', () => {
    it('params schema declares additionalProperties:false', () => {
      expect(EtaQueryParamsSchema.additionalProperties).toBe(false);
    });

    it('result schema declares additionalProperties:false', () => {
      expect(EtaQueryResultSchema.additionalProperties).toBe(false);
    });

    it('schema_hash for params is stable', () => {
      const h1 = computeSchemaHash(EtaQueryParamsSchema);
      const h2 = computeSchemaHash(EtaQueryParamsSchema);
      expect(h1).toBe(h2);
      expect(h1).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});
