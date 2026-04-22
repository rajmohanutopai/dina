/**
 * Task 6.17 — service profile builder tests.
 */

import { computeSchemaHash } from '../src/appview/schema_hash';
import {
  SERVICE_PROFILE_TYPE,
  buildServiceProfile,
  hashCapabilitySchema,
  type BuildProfileInput,
  type CapabilitySchemaInput,
} from '../src/appview/profile_builder';

function etaSchema(): CapabilitySchemaInput {
  return {
    description: 'Query estimated bus arrival time',
    params: {
      type: 'object',
      properties: {
        route_id: { type: 'string' },
        location: {
          type: 'object',
          properties: {
            lat: { type: 'number' },
            lng: { type: 'number' },
          },
          required: ['lat', 'lng'],
        },
      },
      required: ['route_id', 'location'],
    },
    result: {
      type: 'object',
      properties: {
        eta_minutes: { type: 'integer' },
        stop_name: { type: 'string' },
      },
    },
  };
}

function baseConfig(): BuildProfileInput {
  return {
    name: 'SF Transit Authority',
    isPublic: true,
    capabilitySchemas: { eta_query: etaSchema() },
    responsePolicy: { eta_query: 'auto' },
    serviceArea: { lat: 37.7749, lng: -122.4194, radiusKm: 25 },
  };
}

describe('buildServiceProfile (task 6.17)', () => {
  describe('happy path', () => {
    it('builds a valid service profile with schema_hash', () => {
      const profile = buildServiceProfile(baseConfig());
      expect(profile.$type).toBe(SERVICE_PROFILE_TYPE);
      expect(profile.name).toBe('SF Transit Authority');
      expect(profile.isPublic).toBe(true);
      expect(profile.capabilities).toEqual(['eta_query']);
      expect(profile.capabilitySchemas.eta_query!.schema_hash).toMatch(
        /^[0-9a-f]{64}$/,
      );
      expect(profile.capabilitySchemas.eta_query!.description).toBe(
        'Query estimated bus arrival time',
      );
      expect(profile.responsePolicy.eta_query).toBe('auto');
      expect(profile.serviceArea).toEqual({
        lat: 37.7749,
        lng: -122.4194,
        radiusKm: 25,
      });
    });

    it('omits serviceArea when the input omits it', () => {
      const cfg = baseConfig();
      delete cfg.serviceArea;
      const profile = buildServiceProfile(cfg);
      expect(profile.serviceArea).toBeUndefined();
      expect('serviceArea' in profile).toBe(false);
    });

    it('capabilities is sorted lexicographically (deterministic)', () => {
      const cfg: BuildProfileInput = {
        name: 'Multi',
        isPublic: true,
        capabilitySchemas: {
          zeta: etaSchema(),
          alpha: etaSchema(),
          mu: etaSchema(),
        },
        responsePolicy: { zeta: 'auto', alpha: 'auto', mu: 'auto' },
      };
      const profile = buildServiceProfile(cfg);
      expect(profile.capabilities).toEqual(['alpha', 'mu', 'zeta']);
    });

    it('accepts all three responsePolicy values', () => {
      const cfg: BuildProfileInput = {
        name: 'Multi',
        isPublic: true,
        capabilitySchemas: {
          a: etaSchema(),
          b: etaSchema(),
          c: etaSchema(),
        },
        responsePolicy: { a: 'auto', b: 'review', c: 'manual' },
      };
      const profile = buildServiceProfile(cfg);
      expect(profile.responsePolicy).toEqual({ a: 'auto', b: 'review', c: 'manual' });
    });

    it('de-duplicates explicit capability list', () => {
      const cfg: BuildProfileInput = {
        name: 'Dup',
        isPublic: true,
        capabilitySchemas: { eta_query: etaSchema() },
        responsePolicy: { eta_query: 'auto' },
        capabilities: ['eta_query'],
      };
      const profile = buildServiceProfile(cfg);
      expect(profile.capabilities).toEqual(['eta_query']);
    });
  });

  describe('schema_hash contract', () => {
    it('hash covers only {description, params, result} — not any other fields', () => {
      const cfg = baseConfig();
      const profile = buildServiceProfile(cfg);
      const eta = cfg.capabilitySchemas.eta_query!;
      const expected = computeSchemaHash({
        description: eta.description,
        params: eta.params,
        result: eta.result,
      });
      expect(profile.capabilitySchemas.eta_query!.schema_hash).toBe(expected);
    });

    it('hashCapabilitySchema returns the same hash as buildServiceProfile', () => {
      const eta = etaSchema();
      const direct = hashCapabilitySchema(eta);
      const profile = buildServiceProfile(baseConfig());
      expect(profile.capabilitySchemas.eta_query!.schema_hash).toBe(direct);
    });

    it('hash is stable across rebuilds (deterministic)', () => {
      const h1 = buildServiceProfile(baseConfig())
        .capabilitySchemas.eta_query!.schema_hash;
      const h2 = buildServiceProfile(baseConfig())
        .capabilitySchemas.eta_query!.schema_hash;
      expect(h1).toBe(h2);
    });

    it('different params → different hash', () => {
      const a = buildServiceProfile(baseConfig()).capabilitySchemas.eta_query!
        .schema_hash;
      const cfg = baseConfig();
      cfg.capabilitySchemas.eta_query!.params = { type: 'object' };
      const b = buildServiceProfile(cfg).capabilitySchemas.eta_query!.schema_hash;
      expect(a).not.toBe(b);
    });

    it('key-order change in params does NOT change the hash', () => {
      const a = buildServiceProfile(baseConfig()).capabilitySchemas.eta_query!
        .schema_hash;
      const cfg = baseConfig();
      // Re-order the location properties.
      cfg.capabilitySchemas.eta_query!.params = {
        required: ['route_id', 'location'],
        properties: {
          location: {
            required: ['lat', 'lng'],
            properties: {
              lng: { type: 'number' },
              lat: { type: 'number' },
            },
            type: 'object',
          },
          route_id: { type: 'string' },
        },
        type: 'object',
      };
      const b = buildServiceProfile(cfg).capabilitySchemas.eta_query!.schema_hash;
      expect(a).toBe(b);
    });
  });

  describe('input isolation', () => {
    it('mutating the input after build does NOT corrupt the profile', () => {
      const cfg = baseConfig();
      const profile = buildServiceProfile(cfg);
      // Caller mutates source after build.
      cfg.name = 'MUTATED';
      cfg.capabilitySchemas.eta_query!.description = 'MUTATED';
      cfg.serviceArea!.radiusKm = 99999;
      expect(profile.name).toBe('SF Transit Authority');
      expect(profile.capabilitySchemas.eta_query!.description).toBe(
        'Query estimated bus arrival time',
      );
      expect(profile.serviceArea!.radiusKm).toBe(25);
    });
  });

  describe('name validation', () => {
    it.each([
      ['empty', ''],
      ['whitespace only', '   '],
    ])('rejects %s name', (_label, name) => {
      const cfg = baseConfig();
      cfg.name = name;
      expect(() => buildServiceProfile(cfg)).toThrow(/non-empty/);
    });

    it('rejects non-string name', () => {
      const cfg = baseConfig();
      (cfg as unknown as { name: unknown }).name = 42;
      expect(() => buildServiceProfile(cfg)).toThrow(/non-empty string/);
    });
  });

  describe('isPublic validation', () => {
    it('rejects non-boolean isPublic', () => {
      const cfg = baseConfig();
      (cfg as unknown as { isPublic: unknown }).isPublic = 'yes';
      expect(() => buildServiceProfile(cfg)).toThrow(/isPublic/);
    });
  });

  describe('capabilitySchemas validation', () => {
    it('rejects empty capabilitySchemas', () => {
      const cfg: BuildProfileInput = {
        name: 'x',
        isPublic: true,
        capabilitySchemas: {},
        responsePolicy: {},
      };
      expect(() => buildServiceProfile(cfg)).toThrow(/at least one/);
    });

    it('rejects capability with empty description', () => {
      const cfg = baseConfig();
      cfg.capabilitySchemas.eta_query!.description = '';
      expect(() => buildServiceProfile(cfg)).toThrow(/description/);
    });

    it('rejects capability with non-object params', () => {
      const cfg = baseConfig();
      (cfg.capabilitySchemas.eta_query as unknown as { params: unknown }).params = [];
      expect(() => buildServiceProfile(cfg)).toThrow(/params/);
    });

    it('rejects capability with non-object result', () => {
      const cfg = baseConfig();
      (cfg.capabilitySchemas.eta_query as unknown as { result: unknown }).result = null;
      expect(() => buildServiceProfile(cfg)).toThrow(/result/);
    });

    it('rejects explicit capabilities list that does not match schema keys', () => {
      const cfg: BuildProfileInput = {
        name: 'x',
        isPublic: true,
        capabilitySchemas: { eta_query: etaSchema() },
        responsePolicy: { eta_query: 'auto' },
        capabilities: ['eta_query', 'extra'],
      };
      expect(() => buildServiceProfile(cfg)).toThrow(/does not match/);
    });
  });

  describe('responsePolicy validation', () => {
    it('rejects missing policy for a declared capability', () => {
      const cfg: BuildProfileInput = {
        name: 'x',
        isPublic: true,
        capabilitySchemas: { eta_query: etaSchema(), b: etaSchema() },
        responsePolicy: { eta_query: 'auto' }, // missing b
      };
      expect(() => buildServiceProfile(cfg)).toThrow(/auto\|review\|manual/);
    });

    it('rejects invalid policy value', () => {
      const cfg = baseConfig();
      (cfg.responsePolicy as Record<string, string>).eta_query = 'YOLO';
      expect(() => buildServiceProfile(cfg)).toThrow(/auto\|review\|manual/);
    });

    it('rejects stray policy entries for undeclared capabilities', () => {
      const cfg = baseConfig();
      cfg.responsePolicy.stray_cap = 'auto';
      expect(() => buildServiceProfile(cfg)).toThrow(/undeclared capabilities/);
    });
  });

  describe('serviceArea validation', () => {
    it.each([
      ['lat out of range (north)', { lat: 91, lng: 0, radiusKm: 1 }],
      ['lat out of range (south)', { lat: -91, lng: 0, radiusKm: 1 }],
      ['lng out of range (east)', { lat: 0, lng: 181, radiusKm: 1 }],
      ['lng out of range (west)', { lat: 0, lng: -181, radiusKm: 1 }],
      ['radius zero', { lat: 0, lng: 0, radiusKm: 0 }],
      ['radius negative', { lat: 0, lng: 0, radiusKm: -5 }],
      ['NaN lat', { lat: NaN, lng: 0, radiusKm: 1 }],
    ])('rejects %s', (_label, area) => {
      const cfg = baseConfig();
      cfg.serviceArea = area;
      expect(() => buildServiceProfile(cfg)).toThrow();
    });

    it('accepts pole + antimeridian boundaries', () => {
      const cfg = baseConfig();
      cfg.serviceArea = { lat: 90, lng: 180, radiusKm: 1 };
      expect(() => buildServiceProfile(cfg)).not.toThrow();
      cfg.serviceArea = { lat: -90, lng: -180, radiusKm: 1 };
      expect(() => buildServiceProfile(cfg)).not.toThrow();
    });
  });

  describe('hashCapabilitySchema direct', () => {
    it('validates its input', () => {
      expect(() =>
        hashCapabilitySchema({
          description: '',
          params: {},
          result: {},
        }),
      ).toThrow(/description/);
    });

    it('different descriptions → different hashes', () => {
      const a = hashCapabilitySchema({
        description: 'foo',
        params: {},
        result: {},
      });
      const b = hashCapabilitySchema({
        description: 'bar',
        params: {},
        result: {},
      });
      expect(a).not.toBe(b);
    });
  });
});
