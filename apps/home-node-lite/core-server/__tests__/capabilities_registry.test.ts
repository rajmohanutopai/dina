/**
 * Task 5.45 — CapabilityRegistry tests.
 */

import { computeSchemaHash } from '../src/appview/schema_hash';
import {
  CapabilityRegistry,
  DEFAULT_CAPABILITY_TTL_SECONDS,
  type CapabilityDefinition,
  type CapabilityRegistryEvent,
} from '../src/brain/capabilities_registry';

function etaDef(): CapabilityDefinition {
  return {
    name: 'eta_query',
    description: 'Query estimated time of arrival for a transit service.',
    paramsSchema: {
      type: 'object',
      properties: {
        route_id: { type: 'string' },
      },
      required: ['route_id'],
    },
    resultSchema: {
      type: 'object',
      properties: {
        eta_minutes: { type: 'integer' },
      },
    },
    defaultTtlSeconds: 60,
  };
}

function recipeDef(): CapabilityDefinition {
  return {
    name: 'recipe_lookup',
    description: 'Look up a recipe by name.',
    paramsSchema: { type: 'object' },
    resultSchema: { type: 'object' },
  };
}

describe('CapabilityRegistry (task 5.45)', () => {
  describe('register', () => {
    it('registers a capability + computes schema hash', () => {
      const events: CapabilityRegistryEvent[] = [];
      const r = new CapabilityRegistry({ onEvent: (e) => events.push(e) });
      const reg = r.register(etaDef());
      expect(reg.name).toBe('eta_query');
      expect(reg.schemaHash).toMatch(/^[0-9a-f]{64}$/);
      // Hash must match computeSchemaHash({description, params, result}).
      const expected = computeSchemaHash({
        description: etaDef().description,
        params: etaDef().paramsSchema,
        result: etaDef().resultSchema,
      });
      expect(reg.schemaHash).toBe(expected);
      expect(events.some((e) => e.kind === 'registered')).toBe(true);
    });

    it('applies DEFAULT_CAPABILITY_TTL_SECONDS when not specified', () => {
      const r = new CapabilityRegistry();
      const reg = r.register(recipeDef());
      expect(reg.defaultTtlSeconds).toBe(60);
      expect(DEFAULT_CAPABILITY_TTL_SECONDS).toBe(60);
    });

    it('rejects duplicates', () => {
      const r = new CapabilityRegistry();
      r.register(etaDef());
      expect(() => r.register(etaDef())).toThrow(/already registered/);
    });

    it('rejects non-positive TTL', () => {
      const r = new CapabilityRegistry();
      expect(() =>
        r.register({ ...etaDef(), defaultTtlSeconds: 0 }),
      ).toThrow(/positive integer/);
      expect(() =>
        r.register({ ...etaDef(), defaultTtlSeconds: -5 }),
      ).toThrow(/positive integer/);
      expect(() =>
        r.register({ ...etaDef(), defaultTtlSeconds: 1.5 }),
      ).toThrow(/positive integer/);
    });

    it.each([
      ['empty name', { ...etaDef(), name: '' }],
      ['whitespace name', { ...etaDef(), name: '   ' }],
      ['empty description', { ...etaDef(), description: '' }],
      ['null paramsSchema', { ...etaDef(), paramsSchema: null as unknown as Record<string, unknown> }],
      ['array paramsSchema', { ...etaDef(), paramsSchema: [] as unknown as Record<string, unknown> }],
      ['null resultSchema', { ...etaDef(), resultSchema: null as unknown as Record<string, unknown> }],
      ['array resultSchema', { ...etaDef(), resultSchema: [] as unknown as Record<string, unknown> }],
    ])('rejects %s', (_label, def) => {
      const r = new CapabilityRegistry();
      expect(() => r.register(def)).toThrow();
    });

    it('rejects non-object definition', () => {
      const r = new CapabilityRegistry();
      expect(() => r.register(null as unknown as CapabilityDefinition)).toThrow();
    });
  });

  describe('registerMany', () => {
    it('batch-registers multiple capabilities', () => {
      const r = new CapabilityRegistry();
      r.registerMany([etaDef(), recipeDef()]);
      expect(r.size()).toBe(2);
    });

    it('rejects duplicate within batch', () => {
      const r = new CapabilityRegistry();
      expect(() => r.registerMany([etaDef(), etaDef()])).toThrow(/duplicate/);
    });

    it('rejects duplicate against already-registered', () => {
      const r = new CapabilityRegistry();
      r.register(etaDef());
      expect(() => r.registerMany([etaDef()])).toThrow(/duplicate/);
    });

    it('atomicity — bad entry fails the whole batch without registering anything', () => {
      const r = new CapabilityRegistry();
      expect(() =>
        r.registerMany([
          etaDef(),
          { ...recipeDef(), description: '' }, // invalid
        ]),
      ).toThrow();
      expect(r.size()).toBe(0);
    });
  });

  describe('freeze', () => {
    it('locks registration + fires frozen event', () => {
      const events: CapabilityRegistryEvent[] = [];
      const r = new CapabilityRegistry({ onEvent: (e) => events.push(e) });
      r.register(etaDef());
      const count = r.freeze();
      expect(count).toBe(1);
      expect(r.isFrozen()).toBe(true);
      expect(events.some((e) => e.kind === 'frozen')).toBe(true);
    });

    it('register after freeze throws', () => {
      const events: CapabilityRegistryEvent[] = [];
      const r = new CapabilityRegistry({ onEvent: (e) => events.push(e) });
      r.freeze();
      expect(() => r.register(etaDef())).toThrow(/after freeze/);
      expect(events.some((e) => e.kind === 'rejected_frozen')).toBe(true);
    });

    it('registerMany after freeze throws', () => {
      const r = new CapabilityRegistry();
      r.freeze();
      expect(() => r.registerMany([etaDef()])).toThrow(/after freeze/);
    });
  });

  describe('query surface', () => {
    it('get returns null for unknown + capability for known', () => {
      const r = new CapabilityRegistry();
      expect(r.get('unknown')).toBeNull();
      r.register(etaDef());
      expect(r.get('eta_query')?.name).toBe('eta_query');
    });

    it('has returns true/false', () => {
      const r = new CapabilityRegistry();
      r.register(etaDef());
      expect(r.has('eta_query')).toBe(true);
      expect(r.has('unknown')).toBe(false);
    });

    it('list returns alphabetically sorted', () => {
      const r = new CapabilityRegistry();
      r.register(recipeDef()); // "recipe_lookup"
      r.register(etaDef()); // "eta_query"
      const names = r.list().map((c) => c.name);
      expect(names).toEqual(['eta_query', 'recipe_lookup']);
    });

    it('size reports count', () => {
      const r = new CapabilityRegistry();
      expect(r.size()).toBe(0);
      r.register(etaDef());
      r.register(recipeDef());
      expect(r.size()).toBe(2);
    });
  });

  describe('immutability of returned capabilities', () => {
    it('get returns a frozen object', () => {
      const r = new CapabilityRegistry();
      r.register(etaDef());
      const c = r.get('eta_query')!;
      expect(Object.isFrozen(c)).toBe(true);
      expect(() => {
        (c as { name: string }).name = 'MUTATED';
      }).toThrow();
    });

    it('list entries are frozen', () => {
      const r = new CapabilityRegistry();
      r.register(etaDef());
      const list = r.list();
      expect(list.every((c) => Object.isFrozen(c))).toBe(true);
    });
  });

  describe('ttlFor', () => {
    it('honours provider schema default_ttl_seconds', () => {
      const r = new CapabilityRegistry();
      r.register(etaDef()); // default 60
      expect(r.ttlFor('eta_query', { default_ttl_seconds: 300 })).toBe(300);
    });

    it('falls back to registered default when schema has no hint', () => {
      const r = new CapabilityRegistry();
      r.register({ ...etaDef(), defaultTtlSeconds: 120 });
      expect(r.ttlFor('eta_query')).toBe(120);
      expect(r.ttlFor('eta_query', {})).toBe(120);
    });

    it('falls back to 60 when capability is unknown', () => {
      const r = new CapabilityRegistry();
      expect(r.ttlFor('unknown_capability')).toBe(60);
    });

    it('ignores non-positive schema default_ttl_seconds', () => {
      const r = new CapabilityRegistry();
      r.register(etaDef()); // default 60
      expect(r.ttlFor('eta_query', { default_ttl_seconds: 0 })).toBe(60);
      expect(r.ttlFor('eta_query', { default_ttl_seconds: -5 })).toBe(60);
      expect(r.ttlFor('eta_query', { default_ttl_seconds: 1.5 })).toBe(60);
    });

    it('schema hint works for unknown capability too', () => {
      const r = new CapabilityRegistry();
      expect(r.ttlFor('new_cap', { default_ttl_seconds: 90 })).toBe(90);
    });
  });

  describe('schema hash equivalence', () => {
    it('same schema across two registry instances → same hash', () => {
      const r1 = new CapabilityRegistry();
      const r2 = new CapabilityRegistry();
      const c1 = r1.register(etaDef());
      const c2 = r2.register(etaDef());
      expect(c1.schemaHash).toBe(c2.schemaHash);
    });

    it('different description → different hash', () => {
      const r = new CapabilityRegistry();
      const c1 = r.register(etaDef());
      r.register({
        ...etaDef(),
        name: 'eta_query_v2',
        description: 'different',
      });
      expect(c1.schemaHash).not.toBe(r.get('eta_query_v2')!.schemaHash);
    });
  });
});
