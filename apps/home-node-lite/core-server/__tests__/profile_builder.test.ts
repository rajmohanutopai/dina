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

    // ── Deep-isolation contract — pinning structuredClone semantics ─────
    // The existing test pins TOP-LEVEL field mutation. structuredClone
    // is a deep copy, so deeply-nested mutation in params, result,
    // responsePolicy, and capabilitySchemas[cap] all should be
    // isolated. Pin so a refactor to a shallow `{...input}` (which
    // would NOT deep-copy nested objects) surfaces here.

    it('mutating params (deep nested object) does NOT corrupt the profile', () => {
      const cfg = baseConfig();
      const profile = buildServiceProfile(cfg);
      // Reach 3 levels deep into the JSON Schema params.
      const props = (cfg.capabilitySchemas.eta_query!.params as { properties: Record<string, unknown> }).properties;
      (props.route_id as { type: string }).type = 'MUTATED';
      // Profile's params is the sibling deep-clone — unchanged.
      const profileProps = (profile.capabilitySchemas.eta_query!.params as { properties: Record<string, unknown> }).properties;
      expect((profileProps.route_id as { type: string }).type).toBe('string');
    });

    it('mutating result (deep nested object) does NOT corrupt the profile', () => {
      const cfg = baseConfig();
      const profile = buildServiceProfile(cfg);
      const resultProps = (cfg.capabilitySchemas.eta_query!.result as { properties: Record<string, unknown> }).properties;
      (resultProps.eta_minutes as { type: string }).type = 'MUTATED';
      const profileResultProps = (profile.capabilitySchemas.eta_query!.result as { properties: Record<string, unknown> }).properties;
      expect((profileResultProps.eta_minutes as { type: string }).type).toBe('integer');
    });

    it('mutating responsePolicy (sibling object) does NOT corrupt the profile', () => {
      const cfg = baseConfig();
      const profile = buildServiceProfile(cfg);
      cfg.responsePolicy.eta_query = 'manual'; // change after build
      expect(profile.responsePolicy.eta_query).toBe('auto');
    });

    it('mutating capabilitySchemas (replacing a key) does NOT corrupt the profile', () => {
      const cfg = baseConfig();
      const profile = buildServiceProfile(cfg);
      // Replace the entire schema entry on the source.
      cfg.capabilitySchemas.eta_query = {
        description: 'HACKED',
        params: { hacked: true },
        result: { hacked: true },
      };
      // Profile's schema is the deep-clone snapshot from build-time.
      expect(profile.capabilitySchemas.eta_query!.description).toBe(
        'Query estimated bus arrival time',
      );
      expect(profile.capabilitySchemas.eta_query!.params).not.toEqual({ hacked: true });
    });

    it('two profiles built from the SAME input are not aliased', () => {
      // Counter-pin: each build() call deep-clones independently.
      // A refactor that cached the cloned input would alias profiles
      // built back-to-back. Pin so that aliasing surfaces.
      const cfg = baseConfig();
      const a = buildServiceProfile(cfg);
      const b = buildServiceProfile(cfg);
      // Different objects.
      expect(a).not.toBe(b);
      expect(a.capabilitySchemas).not.toBe(b.capabilitySchemas);
      expect(a.capabilitySchemas.eta_query).not.toBe(b.capabilitySchemas.eta_query);
      expect(a.capabilitySchemas.eta_query!.params).not.toBe(b.capabilitySchemas.eta_query!.params);
      expect(a.serviceArea).not.toBe(b.serviceArea);
      // But same VALUES (deep-equal).
      expect(a).toEqual(b);
    });

    it('reverse-isolation: mutating the BUILT profile does NOT corrupt the source input', () => {
      // The structuredClone runs ONCE at the start. The output then
      // contains references INTO the cloned input — but those
      // references are owned by the profile, not the source. A caller
      // who mutates the profile (e.g. to add `$type` later) shouldn't
      // disturb the source config.
      const cfg = baseConfig();
      const sourceArea = cfg.serviceArea;
      const sourceSchema = cfg.capabilitySchemas.eta_query;
      if (!sourceArea || !sourceSchema) throw new Error('expected serviceArea + schema in baseConfig');
      const originalRadius = sourceArea.radiusKm;
      const profile = buildServiceProfile(cfg);
      const builtArea = profile.serviceArea;
      const builtSchema = profile.capabilitySchemas.eta_query;
      if (!builtArea || !builtSchema) throw new Error('expected serviceArea + schema on profile');
      // Caller mutates the BUILT profile.
      profile.name = 'TEST_MUTATED';
      builtArea.radiusKm = 99999;
      builtSchema.description = 'MUTATED';
      // Source config is unaffected.
      expect(cfg.name).toBe('SF Transit Authority');
      expect(sourceArea.radiusKm).toBe(originalRadius);
      expect(sourceSchema.description).toBe('Query estimated bus arrival time');
    });

    it('schema_hash is unaffected by source-input mutation after build', () => {
      // The schema_hash is computed at build time over the cloned
      // params/result. A refactor that re-computed lazily on access
      // (returning a getter) would silently let post-build source
      // mutations change the hash. Pin so the hash is captured-at-build.
      const cfg = baseConfig();
      const profile = buildServiceProfile(cfg);
      const builtSchema = profile.capabilitySchemas.eta_query;
      const sourceSchema = cfg.capabilitySchemas.eta_query;
      if (!builtSchema || !sourceSchema) throw new Error('expected eta_query in capabilitySchemas');
      const originalHash = builtSchema.schema_hash;
      // Mutate source params after build.
      const props = (sourceSchema.params as { properties: Record<string, unknown> }).properties;
      (props.route_id as { type: string }).type = 'integer'; // would change hash
      // Profile's hash is the build-time snapshot.
      expect(builtSchema.schema_hash).toBe(originalHash);
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

    // ── Extended boundary coverage ────────────────────────────────────
    // The existing it.each pins range + NaN-on-lat. Production guard
    // is `!Number.isFinite() || out-of-range` for ALL three fields.
    // A refactor that loosened any one to `Number.isNaN()` would
    // silently let ±Infinity through as a "valid" coordinate.

    it.each([
      ['+Infinity lat', { lat: Number.POSITIVE_INFINITY, lng: 0, radiusKm: 1 }],
      ['-Infinity lat', { lat: Number.NEGATIVE_INFINITY, lng: 0, radiusKm: 1 }],
      ['NaN lng', { lat: 0, lng: Number.NaN, radiusKm: 1 }],
      ['+Infinity lng', { lat: 0, lng: Number.POSITIVE_INFINITY, radiusKm: 1 }],
      ['-Infinity lng', { lat: 0, lng: Number.NEGATIVE_INFINITY, radiusKm: 1 }],
      ['NaN radiusKm', { lat: 0, lng: 0, radiusKm: Number.NaN }],
      ['+Infinity radiusKm', { lat: 0, lng: 0, radiusKm: Number.POSITIVE_INFINITY }],
    ])('rejects non-finite %s', (_label, area) => {
      const cfg = baseConfig();
      cfg.serviceArea = area;
      expect(() => buildServiceProfile(cfg)).toThrow();
    });

    it.each([
      ['lat is string', { lat: '37.7' as unknown as number, lng: 0, radiusKm: 1 }],
      ['lat is null', { lat: null as unknown as number, lng: 0, radiusKm: 1 }],
      ['lng is string', { lat: 0, lng: '0' as unknown as number, radiusKm: 1 }],
      ['lng is undefined', { lat: 0, lng: undefined as unknown as number, radiusKm: 1 }],
      ['radiusKm is string', { lat: 0, lng: 0, radiusKm: '1' as unknown as number }],
      ['radiusKm is null', { lat: 0, lng: 0, radiusKm: null as unknown as number }],
    ])('rejects non-number %s', (_label, area) => {
      const cfg = baseConfig();
      cfg.serviceArea = area;
      expect(() => buildServiceProfile(cfg)).toThrow();
    });

    it.each([
      ['null serviceArea', null],
      ['array serviceArea', [37.7, -122.4, 25]],
      ['number serviceArea', 42],
      ['string serviceArea', 'SF'],
    ])('rejects non-object %s', (_label, area) => {
      const cfg = baseConfig();
      (cfg as unknown as { serviceArea: unknown }).serviceArea = area;
      expect(() => buildServiceProfile(cfg)).toThrow(/serviceArea must be an object/);
    });

    it('rejects empty serviceArea object (missing all required fields)', async () => {
      // The first field-check (lat) fires + throws — the empty-object
      // case is the most reduction-prone "I'll just clear it" config bug.
      const cfg = baseConfig();
      (cfg as unknown as { serviceArea: unknown }).serviceArea = {};
      expect(() => buildServiceProfile(cfg)).toThrow(/lat/);
    });
  });

  // ── validateCapabilityListMatches edge cases ─────────────────────────
  // Existing test only covers length-mismatch (line 257). Production has
  // 3 distinct guards: non-array input, length mismatch, content
  // mismatch (same length but different keys). Pin all three.

  describe('explicit capabilities list validation', () => {
    it('rejects non-array capabilities', () => {
      const cfg: BuildProfileInput = {
        name: 'x',
        isPublic: true,
        capabilitySchemas: { eta_query: etaSchema() },
        responsePolicy: { eta_query: 'auto' },
        capabilities: 'eta_query' as unknown as string[], // string instead of array
      };
      expect(() => buildServiceProfile(cfg)).toThrow(/must be an array/);
    });

    it('rejects same-length but different-content capabilities', () => {
      // A refactor that compared only `length` would pass this.
      // Production iterates element-by-element after sort; pin that.
      const cfg: BuildProfileInput = {
        name: 'x',
        isPublic: true,
        capabilitySchemas: { eta_query: etaSchema() },
        responsePolicy: { eta_query: 'auto' },
        capabilities: ['wrong_cap'], // same length=1, different value
      };
      expect(() => buildServiceProfile(cfg)).toThrow(/does not match/);
    });

    it('accepts capabilities in different order than schema keys (sort-equality)', () => {
      // Counter-pin: explicit list need NOT match insertion order — the
      // builder sorts both sides before comparing. Pin so a refactor
      // that required reference-equality surfaces here.
      const cfg: BuildProfileInput = {
        name: 'x',
        isPublic: true,
        capabilitySchemas: { zeta: etaSchema(), alpha: etaSchema() },
        responsePolicy: { zeta: 'auto', alpha: 'auto' },
        capabilities: ['zeta', 'alpha'], // reverse-alpha order
      };
      expect(() => buildServiceProfile(cfg)).not.toThrow();
      const profile = buildServiceProfile(cfg);
      // Output is always sort-canonical regardless of input order.
      expect(profile.capabilities).toEqual(['alpha', 'zeta']);
    });
  });

  // ── Capability schema array-rejection counter-pin ────────────────────
  // The existing 'rejects capability with non-object params' test uses
  // `[]` (an array). Production guard is `!== object || isArray()`.
  // Pin all three rejection branches per field for params + result.

  describe('capability schema params/result rejection taxonomy', () => {
    it.each([
      ['null params', null],
      ['array params', []],
      ['string params', 'object'],
      ['number params', 42],
      ['boolean params', true],
    ])('rejects capability with %s', (_label, params) => {
      const cfg = baseConfig();
      (cfg.capabilitySchemas.eta_query as unknown as { params: unknown }).params = params;
      expect(() => buildServiceProfile(cfg)).toThrow(/params/);
    });

    it.each([
      ['null result', null],
      ['array result', []],
      ['string result', 'object'],
      ['number result', 42],
    ])('rejects capability with %s', (_label, result) => {
      const cfg = baseConfig();
      (cfg.capabilitySchemas.eta_query as unknown as { result: unknown }).result = result;
      expect(() => buildServiceProfile(cfg)).toThrow(/result/);
    });

    it.each([
      ['null description', null],
      ['number description', 42],
      ['undefined description', undefined],
      ['boolean description', true],
    ])('rejects capability with %s', (_label, description) => {
      const cfg = baseConfig();
      (cfg.capabilitySchemas.eta_query as unknown as { description: unknown }).description = description;
      expect(() => buildServiceProfile(cfg)).toThrow(/description/);
    });

    it.each([
      ['null schema', null],
      ['number schema', 42],
      ['string schema', 'oops'],
    ])('rejects capability with %s', (_label, schema) => {
      const cfg = baseConfig();
      (cfg.capabilitySchemas as unknown as Record<string, unknown>).eta_query = schema;
      expect(() => buildServiceProfile(cfg)).toThrow(/schema must be an object/);
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
