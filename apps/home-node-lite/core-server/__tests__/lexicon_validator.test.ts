/**
 * Task 6.5 — LexiconValidator tests.
 */

import {
  DEFAULT_MAX_ERRORS,
  LexiconValidator,
  type LexiconSchema,
} from '../src/appview/lexicon_validator';

const PROFILE_SCHEMA: LexiconSchema = {
  type: 'object',
  required: ['$type', 'name', 'isPublic', 'capabilities'],
  additionalProperties: false,
  properties: {
    $type: { const: 'com.dina.service.profile' },
    name: { type: 'string', minLength: 1, maxLength: 200 },
    isPublic: { type: 'boolean' },
    capabilities: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
    },
    serviceArea: {
      type: 'object',
      required: ['lat', 'lng', 'radiusKm'],
      properties: {
        lat: { type: 'number', minimum: -90, maximum: 90 },
        lng: { type: 'number', minimum: -180, maximum: 180 },
        radiusKm: { type: 'number', minimum: 0 },
      },
    },
  },
};

describe('LexiconValidator (task 6.5)', () => {
  describe('construction', () => {
    it('throws when schemas is not an object', () => {
      expect(
        () => new LexiconValidator(null as unknown as Record<string, LexiconSchema>),
      ).toThrow(/schemas/);
    });

    it('throws on empty collection name', () => {
      expect(
        () => new LexiconValidator({ '': PROFILE_SCHEMA }),
      ).toThrow(/non-empty/);
    });

    it('DEFAULT_MAX_ERRORS is 10', () => {
      expect(DEFAULT_MAX_ERRORS).toBe(10);
    });
  });

  describe('collection lookup', () => {
    it('has + collections reports registered schemas', () => {
      const v = new LexiconValidator({
        'com.dina.service.profile': PROFILE_SCHEMA,
        'com.dina.contact.card': { type: 'object' },
      });
      expect(v.has('com.dina.service.profile')).toBe(true);
      expect(v.has('unknown')).toBe(false);
      expect(v.collections().sort()).toEqual([
        'com.dina.contact.card',
        'com.dina.service.profile',
      ]);
    });

    it('uses $type from record when collection argument omitted', () => {
      const v = new LexiconValidator({
        'com.dina.service.profile': PROFILE_SCHEMA,
      });
      const result = v.validate({
        $type: 'com.dina.service.profile',
        name: 'SF Transit',
        isPublic: true,
        capabilities: ['eta_query'],
      });
      expect(result.ok).toBe(true);
    });

    it('returns unknown_collection when $type missing + no argument', () => {
      const v = new LexiconValidator({ 'x': { type: 'object' } });
      const r = v.validate({ foo: 'bar' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors[0]!.kind).toBe('unknown_collection');
    });

    it('returns unknown_collection for unregistered collection', () => {
      const v = new LexiconValidator({ 'x': { type: 'object' } });
      const r = v.validate({}, 'not-registered');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors[0]!.kind).toBe('unknown_collection');
    });
  });

  describe('type checks', () => {
    const v = new LexiconValidator({
      str: { type: 'string' },
      num: { type: 'number' },
      int: { type: 'integer' },
      bool: { type: 'boolean' },
      obj: { type: 'object' },
      arr: { type: 'array' },
      null_t: { type: 'null' },
      union: { type: ['string', 'null'] },
    });

    it.each([
      ['string', 'hello', 'str'],
      ['number', 3.14, 'num'],
      ['integer', 42, 'int'],
      ['boolean', true, 'bool'],
      ['object', {}, 'obj'],
      ['array', [], 'arr'],
      ['null', null, 'null_t'],
      ['union (string)', 'x', 'union'],
      ['union (null)', null, 'union'],
    ])('%s accepts %s', (_label, value, collection) => {
      expect(v.validate(value, collection).ok).toBe(true);
    });

    it.each([
      ['string rejects number', 42, 'str'],
      ['number rejects string', 'x', 'num'],
      ['integer rejects float', 3.14, 'int'],
      ['boolean rejects 1', 1, 'bool'],
      ['object rejects array', [], 'obj'],
      ['array rejects object', {}, 'arr'],
      ['null rejects undefined', undefined, 'null_t'],
    ])('%s', (_label, value, collection) => {
      const r = v.validate(value, collection);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors[0]!.kind).toBe('type_mismatch');
    });

    it('NaN / Infinity rejected for number type', () => {
      expect(v.validate(NaN, 'num').ok).toBe(false);
      expect(v.validate(Infinity, 'num').ok).toBe(false);
    });
  });

  describe('object validation', () => {
    const v = new LexiconValidator({ profile: PROFILE_SCHEMA });

    it('accepts a valid profile', () => {
      expect(
        v.validate(
          {
            $type: 'com.dina.service.profile',
            name: 'SF Transit',
            isPublic: true,
            capabilities: ['eta_query'],
          },
          'profile',
        ).ok,
      ).toBe(true);
    });

    it('required property missing → required_missing with path', () => {
      const r = v.validate(
        {
          $type: 'com.dina.service.profile',
          isPublic: true,
          capabilities: ['eta_query'],
        },
        'profile',
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        const err = r.errors.find((e) => e.path === '/name');
        expect(err?.kind).toBe('required_missing');
      }
    });

    it('additionalProperties: false rejects unknown keys', () => {
      const r = v.validate(
        {
          $type: 'com.dina.service.profile',
          name: 'x',
          isPublic: true,
          capabilities: ['y'],
          someExtra: 42,
        },
        'profile',
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        const extra = r.errors.find((e) => e.path === '/someExtra');
        expect(extra?.kind).toBe('additional_property_not_allowed');
      }
    });

    it('wrong type on nested property → type_mismatch with nested path', () => {
      const r = v.validate(
        {
          $type: 'com.dina.service.profile',
          name: 'x',
          isPublic: 'yes', // wrong type
          capabilities: ['y'],
        },
        'profile',
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        const err = r.errors.find((e) => e.path === '/isPublic');
        expect(err?.kind).toBe('type_mismatch');
      }
    });

    it('deeply nested path encoded', () => {
      const r = v.validate(
        {
          $type: 'com.dina.service.profile',
          name: 'x',
          isPublic: true,
          capabilities: ['y'],
          serviceArea: { lat: 100, lng: 0, radiusKm: 1 },
        },
        'profile',
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        const err = r.errors.find((e) => e.path === '/serviceArea/lat');
        expect(err?.kind).toBe('maximum_violation');
      }
    });
  });

  describe('array validation', () => {
    const v = new LexiconValidator({
      strArr: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 },
    });

    it('accepts valid array', () => {
      expect(v.validate(['a', 'b'], 'strArr').ok).toBe(true);
    });

    it('min/max items', () => {
      const empty = v.validate([], 'strArr');
      const big = v.validate(['a', 'b', 'c', 'd'], 'strArr');
      expect(empty.ok).toBe(false);
      expect(big.ok).toBe(false);
      if (!empty.ok) expect(empty.errors[0]!.kind).toBe('min_items_violation');
      if (!big.ok) expect(big.errors[0]!.kind).toBe('max_items_violation');
    });

    it('per-item type check reports index in path', () => {
      const r = v.validate(['a', 42, 'c'], 'strArr');
      expect(r.ok).toBe(false);
      if (!r.ok) {
        const err = r.errors.find((e) => e.path === '/1');
        expect(err?.kind).toBe('type_mismatch');
      }
    });
  });

  describe('string constraints', () => {
    const v = new LexiconValidator({
      code: { type: 'string', pattern: '^[a-z0-9_]+$' },
      bounded: { type: 'string', minLength: 3, maxLength: 5 },
      color: { type: 'string', enum: ['red', 'green', 'blue'] },
    });

    it('pattern match', () => {
      expect(v.validate('route_42', 'code').ok).toBe(true);
      const r = v.validate('UPPER', 'code');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors[0]!.kind).toBe('pattern_mismatch');
    });

    it('minLength / maxLength', () => {
      expect(v.validate('abcd', 'bounded').ok).toBe(true);
      expect(v.validate('ab', 'bounded').ok).toBe(false);
      expect(v.validate('abcdef', 'bounded').ok).toBe(false);
    });

    it('enum', () => {
      expect(v.validate('red', 'color').ok).toBe(true);
      const r = v.validate('yellow', 'color');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors[0]!.kind).toBe('enum_mismatch');
    });

    it('malformed pattern in schema skipped (no crash)', () => {
      const v2 = new LexiconValidator({
        bad: { type: 'string', pattern: '[' }, // invalid regex
      });
      // Should not throw; just passes without the pattern check.
      expect(v2.validate('anything', 'bad').ok).toBe(true);
    });
  });

  describe('number constraints', () => {
    const v = new LexiconValidator({
      pct: { type: 'number', minimum: 0, maximum: 1 },
      age: { type: 'integer', minimum: 0 },
    });

    it('minimum / maximum', () => {
      expect(v.validate(0.5, 'pct').ok).toBe(true);
      expect(v.validate(-0.1, 'pct').ok).toBe(false);
      expect(v.validate(1.1, 'pct').ok).toBe(false);
    });

    it('integer type rejects float', () => {
      expect(v.validate(25, 'age').ok).toBe(true);
      const r = v.validate(25.5, 'age');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors[0]!.kind).toBe('type_mismatch');
    });
  });

  describe('const + enum', () => {
    const v = new LexiconValidator({
      yes: { const: 'yes' },
      colors: { enum: ['red', 'green', 'blue'] },
      nullable: { enum: [null, 'empty', 42] },
    });

    it('const exact match', () => {
      expect(v.validate('yes', 'yes').ok).toBe(true);
      const r = v.validate('no', 'yes');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors[0]!.kind).toBe('const_mismatch');
    });

    it('enum allows mixed types', () => {
      expect(v.validate(null, 'nullable').ok).toBe(true);
      expect(v.validate('empty', 'nullable').ok).toBe(true);
      expect(v.validate(42, 'nullable').ok).toBe(true);
      expect(v.validate('other', 'nullable').ok).toBe(false);
    });

    it('enum deep-equals object members', () => {
      const v2 = new LexiconValidator({
        obj: { enum: [{ x: 1 }, { y: 2 }] },
      });
      expect(v2.validate({ x: 1 }, 'obj').ok).toBe(true);
      expect(v2.validate({ x: 2 }, 'obj').ok).toBe(false);
    });
  });

  describe('errors cap', () => {
    it('caps at maxErrors (default 10)', () => {
      const v = new LexiconValidator({
        many: {
          type: 'array',
          items: { type: 'string' },
        },
      });
      const bad = new Array(20).fill(42);
      const r = v.validate(bad, 'many');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.length).toBe(10);
    });

    it('custom maxErrors respected', () => {
      const v = new LexiconValidator(
        { many: { type: 'array', items: { type: 'string' } } },
        { maxErrors: 3 },
      );
      const bad = new Array(20).fill(42);
      const r = v.validate(bad, 'many');
      if (!r.ok) expect(r.errors.length).toBe(3);
    });
  });

  describe('JSON-pointer path encoding', () => {
    it('escapes "/" in property names', () => {
      const v = new LexiconValidator({
        top: {
          type: 'object',
          properties: {
            'path/with/slashes': { type: 'number' },
          },
          required: ['path/with/slashes'],
        },
      });
      const r = v.validate({}, 'top');
      if (!r.ok) {
        // "/" becomes "~1", "~" becomes "~0"
        expect(r.errors[0]!.path).toBe('/path~1with~1slashes');
      }
    });
  });
});
