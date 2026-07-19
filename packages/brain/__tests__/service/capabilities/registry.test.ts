/**
 * Tests for the capabilities registry + eta_query capability.
 *
 * Source parity target: brain/src/service/capabilities/registry.py and
 * brain/src/service/capabilities/eta_query.py.
 */

import { isOfficialCapability } from '@dina/protocol';

import {
  EtaQueryParamsSchema,
  EtaQueryResultSchema,
  validateEtaQueryParams,
  validateEtaQueryResult,
} from '../../../src/service/capabilities/eta_query';
import {
  canonicalJSON,
  computeSchemaHash,
  FALLBACK_TTL_SECONDS,
  getCapability,
  getTTL,
  listCapabilities,
  SUPPORTED_CAPABILITIES,
} from '../../../src/service/capabilities/registry';

describe('capabilities registry', () => {
  describe('SUPPORTED_CAPABILITIES', () => {
    it('lists exactly the registered capabilities', () => {
      expect(SUPPORTED_CAPABILITIES).toEqual(['eta_query', 'appointment_availability', 'appointment_book', 'availability_coordination']);
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

    // SERVICES_LAUNCH_ARCHITECTURE.md Part 1: the local registry must be
    // alias-aware so `getCapability('bus_eta')` returns the `eta_query`
    // def — else no-schema fallback paths skip local validation for an
    // alias name.
    it('resolves a known ALIAS to its canonical definition', () => {
      const cap = getCapability('bus_eta'); // alias of eta_query
      expect(cap?.name).toBe('eta_query');
      expect(cap?.validateParams).toBe(validateEtaQueryParams);
    });

    it('returns the availability_coordination definition (Contact Services §6.1)', () => {
      const cap = getCapability('availability_coordination');
      expect(cap).toBeDefined();
      expect(cap?.name).toBe('availability_coordination');
      expect(cap?.defaultTtlSeconds).toBe(300);
      // result schema is the symmetric accept/counter/needs_more_info shape
      const resultEnum = (
        cap?.resultSchema as { properties?: { status?: { enum?: string[] } } }
      ).properties?.status?.enum;
      expect(resultEnum).toEqual(['accepted', 'counter', 'needs_more_info']);
    });
  });

  describe('getTTL', () => {
    it('returns the capability default for known capabilities', () => {
      expect(getTTL('eta_query')).toBe(60);
    });

    it('resolves a known ALIAS to its canonical TTL', () => {
      expect(getTTL('bus_eta')).toBe(60); // alias of eta_query (default 60)
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
      expect(list.map((c) => c.name)).toEqual(['eta_query', 'appointment_availability', 'appointment_book', 'availability_coordination']);
    });
  });

  // CONTRACT — closes the brain↔protocol drift class. Every capability the brain
  // REGISTERS must also be an OFFICIAL capability in the protocol catalog;
  // otherwise a provider cannot publish/offer it (`validateServiceListing`
  // rejects the listing with `unknown_capability`) even though the node fully
  // supports the capability at runtime. This shipped once —
  // `availability_coordination` was wired in the brain registry but missing from
  // `capability-catalog.ts`, so a Talk availability listing failed validation;
  // a live two-Dina sim test caught it. The existing catalog-integrity test only
  // checks protocol↔protocol parity (registry ⊇ catalog), never brain↔protocol.
  // This is that missing check.
  describe('brain registry ⊆ protocol capability catalog', () => {
    it('every brain-registered capability is an official protocol catalog capability', () => {
      for (const name of SUPPORTED_CAPABILITIES) {
        expect({ name, official: isOfficialCapability(name) }).toEqual({ name, official: true });
      }
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
    // Canonical contract (MT-24-I2): route_id is the discriminator, location
    // is optional. Mirrors brain/src/service/capabilities/eta_query.py and
    // the seeded test fixtures (test_rel_029_service_query.py et al).
    const valid = { route_id: '42' };

    it('accepts a minimal valid body (route_id only)', () => {
      expect(validateEtaQueryParams(valid)).toBeNull();
    });

    it('accepts a body with optional location', () => {
      expect(
        validateEtaQueryParams({ ...valid, location: { lat: 37.77, lng: -122.41 } }),
      ).toBeNull();
    });

    it('rejects non-object', () => {
      expect(validateEtaQueryParams(null)).toContain('must be a JSON object');
      expect(validateEtaQueryParams('x')).toContain('must be a JSON object');
    });

    it('rejects missing route_id', () => {
      expect(validateEtaQueryParams({})).toContain('route_id');
    });

    it('rejects empty-string route_id', () => {
      expect(validateEtaQueryParams({ route_id: '' })).toContain('route_id');
    });

    it('rejects non-string route_id', () => {
      expect(validateEtaQueryParams({ route_id: 42 })).toContain('route_id');
    });

    it('rejects malformed location.lat / lng (non-finite)', () => {
      expect(
        validateEtaQueryParams({ ...valid, location: { lat: Number.NaN, lng: 0 } }),
      ).toContain('lat');
      expect(
        validateEtaQueryParams({
          ...valid,
          location: { lat: 0, lng: Number.POSITIVE_INFINITY },
        }),
      ).toContain('lng');
    });
  });

  describe('validateEtaQueryResult', () => {
    // Canonical contract: status is the only required field. Other fields
    // are optional because terminal statuses (out_of_service, not_found)
    // legitimately omit eta_minutes / route_name / vehicle_type.
    const valid = { status: 'on_route' as const };

    it('accepts a minimal valid result (status only)', () => {
      expect(validateEtaQueryResult(valid)).toBeNull();
    });

    it('accepts all optional fields', () => {
      expect(
        validateEtaQueryResult({
          ...valid,
          eta_minutes: 12,
          vehicle_type: 'bus',
          route_name: 'Route 42',
          stop_name: 'Market & Powell',
          stop_distance_m: 120,
          map_url: 'https://maps.google.com/?q=37.77,-122.41',
          message: 'traffic is light',
        }),
      ).toBeNull();
    });

    it('rejects non-integer eta_minutes', () => {
      expect(validateEtaQueryResult({ ...valid, eta_minutes: 12.5 })).toContain('eta_minutes');
    });

    it('rejects non-finite eta_minutes', () => {
      expect(validateEtaQueryResult({ ...valid, eta_minutes: Number.NaN })).toContain(
        'eta_minutes',
      );
    });

    it('rejects unknown status', () => {
      expect(validateEtaQueryResult({ status: 'teleporting' })).toContain('status');
    });

    it('rejects missing status', () => {
      expect(validateEtaQueryResult({})).toContain('status');
    });

    it('accepts each allowed status', () => {
      for (const s of ['on_route', 'not_on_route', 'out_of_service', 'not_found']) {
        expect(validateEtaQueryResult({ status: s })).toBeNull();
      }
    });

    it('rejects negative stop_distance_m', () => {
      expect(validateEtaQueryResult({ ...valid, stop_distance_m: -1 })).toContain(
        'stop_distance_m',
      );
    });
  });

  describe('JSON Schema exports', () => {
    // The published schemas stay byte-identical to the Python and Go
    // canonical references (cross-stack interop — see MT-24-I2). Anything
    // beyond the minimal {type, required, properties} keys would land in
    // the canonical hash and break interop with main-dina + the Go core.
    // The cross-stack hash is locked in by `canonical_hash_parity.test.ts`.
    it('params schema requires route_id', () => {
      expect(EtaQueryParamsSchema.required).toEqual(['route_id']);
    });

    it('result schema requires status', () => {
      expect(EtaQueryResultSchema.required).toEqual(['status']);
    });

    it('schema_hash for params is stable', () => {
      const h1 = computeSchemaHash(EtaQueryParamsSchema);
      const h2 = computeSchemaHash(EtaQueryParamsSchema);
      expect(h1).toBe(h2);
      expect(h1).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});
