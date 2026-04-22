/**
 * Task 6.18 — schema_hash tests.
 */

import { createHash } from 'node:crypto';
import { canonicalJSON, computeSchemaHash } from '../src/appview/schema_hash';

/** Python-equivalent hash: sha256(json.dumps(obj, sort_keys=True, separators=(',', ':'))). */
function pythonStyleHash(obj: unknown): string {
  const sorted = sortRecursive(obj);
  const canonical = JSON.stringify(sorted);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function sortRecursive(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(sortRecursive);
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(v as object).sort()) {
    sorted[k] = sortRecursive((v as Record<string, unknown>)[k]);
  }
  return sorted;
}

describe('canonicalJSON (task 6.18)', () => {
  describe('primitives', () => {
    it.each([
      ['null', null, 'null'],
      ['true', true, 'true'],
      ['false', false, 'false'],
      ['integer', 42, '42'],
      ['float', 3.14, '3.14'],
      ['zero', 0, '0'],
      ['negative', -17, '-17'],
      ['string', 'hello', '"hello"'],
      ['empty string', '', '""'],
      ['string with special chars', 'a"b\\c', '"a\\"b\\\\c"'],
    ])('serialises %s', (_label, input, expected) => {
      expect(canonicalJSON(input)).toBe(expected);
    });

    it('NaN → null (matches JSON.stringify)', () => {
      expect(canonicalJSON(NaN)).toBe('null');
    });

    it('+Infinity / -Infinity → null (matches JSON.stringify)', () => {
      expect(canonicalJSON(Infinity)).toBe('null');
      expect(canonicalJSON(-Infinity)).toBe('null');
    });
  });

  describe('objects — key sorting', () => {
    it('sorts flat object keys lexicographically', () => {
      expect(canonicalJSON({ c: 3, a: 1, b: 2 })).toBe('{"a":1,"b":2,"c":3}');
    });

    it('sorts nested object keys recursively', () => {
      const schema = {
        type: 'object',
        properties: {
          route_id: { type: 'string' },
          location: { type: 'object', required: ['lat', 'lng'] },
        },
      };
      const out = canonicalJSON(schema);
      // Every {..} block must have keys in sorted order.
      // location block: required before type
      expect(out).toContain('"location":{"required":["lat","lng"],"type":"object"}');
      // route_id block
      expect(out).toContain('"route_id":{"type":"string"}');
      // Top-level: properties before type
      expect(out.indexOf('"properties"')).toBeLessThan(out.indexOf('"type"'));
    });

    it('byte-identical to Python json.dumps(sort_keys=True, separators=",:)', () => {
      // These are the exact keys a schema hash contract cares about.
      const schema = {
        type: 'object',
        required: ['route_id', 'location'],
        properties: {
          route_id: { type: 'string', description: 'Bus route number' },
          location: {
            type: 'object',
            properties: {
              lat: { type: 'number' },
              lng: { type: 'number' },
            },
            required: ['lat', 'lng'],
          },
        },
      };
      const ours = canonicalJSON(schema);
      // Python: json.dumps(schema, sort_keys=True, separators=(',',':'))
      const expected =
        '{"properties":{"location":{"properties":{"lat":{"type":"number"},"lng":{"type":"number"}},"required":["lat","lng"],"type":"object"},"route_id":{"description":"Bus route number","type":"string"}},"required":["route_id","location"],"type":"object"}';
      expect(ours).toBe(expected);
    });

    it('numeric-like keys sort by code point (matches Python), NOT V8 numeric-first', () => {
      // V8 would put '2' before '10' (numeric order); Python sorts '10' < '2' lexically.
      const out = canonicalJSON({ '10': 'a', '2': 'b', alpha: 'c' });
      // Lex order: '10' < '2' < 'alpha'
      expect(out).toBe('{"10":"a","2":"b","alpha":"c"}');
    });

    it('input key order does NOT affect output', () => {
      const a = { x: 1, y: 2, z: 3 };
      const b = { z: 3, x: 1, y: 2 };
      const c = { y: 2, z: 3, x: 1 };
      expect(canonicalJSON(a)).toBe(canonicalJSON(b));
      expect(canonicalJSON(b)).toBe(canonicalJSON(c));
    });
  });

  describe('arrays', () => {
    it('preserves element order', () => {
      expect(canonicalJSON([3, 1, 2])).toBe('[3,1,2]');
    });

    it('recurses into array elements', () => {
      expect(canonicalJSON([{ b: 2, a: 1 }, { d: 4, c: 3 }])).toBe(
        '[{"a":1,"b":2},{"c":3,"d":4}]',
      );
    });

    it('undefined in array → null (matches JSON.stringify)', () => {
      expect(canonicalJSON([1, undefined, 3])).toBe('[1,null,3]');
    });

    it('function in array → null', () => {
      expect(canonicalJSON([1, () => 0, 2])).toBe('[1,null,2]');
    });
  });

  describe('dropping values', () => {
    it('drops `undefined` from objects (matches JSON.stringify)', () => {
      expect(canonicalJSON({ a: 1, b: undefined, c: 3 })).toBe('{"a":1,"c":3}');
    });

    it('drops functions + symbols from objects', () => {
      expect(canonicalJSON({ a: 1, f: () => 0, s: Symbol('x') as unknown, b: 2 })).toBe(
        '{"a":1,"b":2}',
      );
    });
  });

  describe('error cases', () => {
    it('throws on top-level undefined', () => {
      expect(() => canonicalJSON(undefined)).toThrow(/not JSON-serialisable/);
    });

    it('throws on top-level function', () => {
      expect(() => canonicalJSON(() => 0)).toThrow(/not JSON-serialisable/);
    });

    it('throws on circular structure (with useful message)', () => {
      const a: Record<string, unknown> = { name: 'a' };
      a['self'] = a;
      expect(() => canonicalJSON(a)).toThrow(/circular/);
    });

    it('throws on BigInt', () => {
      expect(() => canonicalJSON({ big: BigInt(1) })).toThrow(/BigInt/);
    });
  });

  describe('round-trip vs. JSON.stringify', () => {
    it('for objects with no integer-like keys, output is identical to Python sort_keys', () => {
      const inputs: unknown[] = [
        { b: 'y', a: 'x' },
        { nested: { q: [1, 2, 3], p: false } },
        [{ z: 1, a: 2 }, { m: 3, n: 4 }],
        'a plain string',
        42,
        null,
        true,
        [],
        {},
      ];
      for (const v of inputs) {
        expect(canonicalJSON(v)).toBe(JSON.stringify(sortRecursive(v)));
      }
    });
  });
});

describe('computeSchemaHash (task 6.18)', () => {
  it('returns 64-char lowercase hex SHA-256', () => {
    const hash = computeSchemaHash({ type: 'object' });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('matches SHA-256 of the canonical serialisation', () => {
    const schema = {
      type: 'object',
      properties: { x: { type: 'string' } },
    };
    const expected = createHash('sha256')
      .update(canonicalJSON(schema), 'utf8')
      .digest('hex');
    expect(computeSchemaHash(schema)).toBe(expected);
  });

  it('insensitive to input key order — same hash for shuffled schemas', () => {
    const a = {
      type: 'object',
      description: 'x',
      properties: { a: 1, b: 2 },
    };
    const b = {
      properties: { b: 2, a: 1 },
      type: 'object',
      description: 'x',
    };
    expect(computeSchemaHash(a)).toBe(computeSchemaHash(b));
  });

  it('different schemas produce different hashes', () => {
    const h1 = computeSchemaHash({ type: 'object' });
    const h2 = computeSchemaHash({ type: 'array' });
    expect(h1).not.toBe(h2);
  });

  it('matches the Python reference byte-for-byte', () => {
    // This is the SF-Transit plan's example schema — the one that
    // flows over the wire between Alonso + BusDriver. Hash must match
    // what Python's `compute_schema_hash` produces.
    const etaSchema = {
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
    expect(computeSchemaHash(etaSchema)).toBe(pythonStyleHash(etaSchema));
  });

  it('rejects non-object inputs', () => {
    expect(() => computeSchemaHash(null as unknown as object)).toThrow(/plain object/);
    expect(() => computeSchemaHash('string' as unknown as object)).toThrow(/plain object/);
    expect(() => computeSchemaHash(42 as unknown as object)).toThrow(/plain object/);
    expect(() => computeSchemaHash([] as unknown as object)).toThrow(/plain object/);
  });

  it('deterministic across multiple calls', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } } };
    const h1 = computeSchemaHash(schema);
    const h2 = computeSchemaHash(schema);
    const h3 = computeSchemaHash(schema);
    expect(h1).toBe(h2);
    expect(h2).toBe(h3);
  });
});
