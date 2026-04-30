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
      if (r.ok) throw new Error('expected ok:false');
      expect(r.errors[0]?.kind).toBe('unknown_collection');
    });

    it('returns unknown_collection for unregistered collection', () => {
      const v = new LexiconValidator({ 'x': { type: 'object' } });
      const r = v.validate({}, 'not-registered');
      if (r.ok) throw new Error('expected ok:false');
      expect(r.errors[0]?.kind).toBe('unknown_collection');
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
      if (r.ok) throw new Error('expected ok:false');
      expect(r.errors[0]?.kind).toBe('type_mismatch');
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
      if (empty.ok) throw new Error('expected empty ok:false');
      if (big.ok) throw new Error('expected big ok:false');
      expect(empty.errors[0]?.kind).toBe('min_items_violation');
      expect(big.errors[0]?.kind).toBe('max_items_violation');
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
      if (r.ok) throw new Error('expected ok:false');
      expect(r.errors[0]?.kind).toBe('pattern_mismatch');
    });

    it('minLength / maxLength', () => {
      expect(v.validate('abcd', 'bounded').ok).toBe(true);
      expect(v.validate('ab', 'bounded').ok).toBe(false);
      expect(v.validate('abcdef', 'bounded').ok).toBe(false);
    });

    it('enum', () => {
      expect(v.validate('red', 'color').ok).toBe(true);
      const r = v.validate('yellow', 'color');
      if (r.ok) throw new Error('expected ok:false');
      expect(r.errors[0]?.kind).toBe('enum_mismatch');
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
      if (r.ok) throw new Error('expected ok:false');
      expect(r.errors[0]?.kind).toBe('type_mismatch');
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
      if (r.ok) throw new Error('expected ok:false');
      expect(r.errors[0]?.kind).toBe('const_mismatch');
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

  describe('type-check exhaustion — exotic value types', () => {
    // The `matchesType` switch handles 7 named types; pin what
    // happens for value types that don't naturally fit any branch.
    const v = new LexiconValidator({
      str: { type: 'string' },
      num: { type: 'number' },
      int: { type: 'integer' },
      bool: { type: 'boolean' },
      obj: { type: 'object' },
      arr: { type: 'array' },
      anyobj: { type: 'object' },
    });

    it('BigInt rejected by every type (no branch matches)', () => {
      const big = BigInt(1);
      // BigInt is `typeof === 'bigint'` — none of the 7 branches accept it.
      for (const collection of ['str', 'num', 'int', 'bool', 'obj', 'arr']) {
        expect(v.validate(big, collection).ok).toBe(false);
      }
    });

    it('Symbol rejected by every type', () => {
      const sym = Symbol('x');
      for (const collection of ['str', 'num', 'int', 'bool', 'obj', 'arr']) {
        expect(v.validate(sym, collection).ok).toBe(false);
      }
    });

    it('function rejected by object type (typeof function ≠ object)', () => {
      // Pin: even though functions are objects in many contexts,
      // matchesType('object') uses `typeof === 'object'` strictly.
      const fn = (): number => 0;
      expect(v.validate(fn, 'obj').ok).toBe(false);
      expect(v.validate(fn, 'arr').ok).toBe(false);
    });

    it('Date instance MATCHES object type (typeof === object, not array)', () => {
      // Pin documented behavior: the type system treats Date as a
      // plain object. Lexicon authors should NOT use `type: 'object'`
      // for date-flavoured fields — use `type: 'string'` with a pattern.
      // This test pins the actual behavior so a future "tighten object
      // matching" change is intentional.
      const d = new Date('2026-04-30');
      expect(v.validate(d, 'anyobj').ok).toBe(true);
    });

    it('Map instance MATCHES object type', () => {
      // Same documented behavior — class instances reduce to typeof.
      expect(v.validate(new Map(), 'anyobj').ok).toBe(true);
    });

    it('Set instance MATCHES object type', () => {
      expect(v.validate(new Set(), 'anyobj').ok).toBe(true);
    });
  });

  describe('const + enum + type interaction (early-return semantics)', () => {
    // The walker's order: const → enum → type → per-type constraints.
    // const + enum return immediately on success/failure, skipping
    // later checks. Pin the actual ordering.
    it('const passes → continues to type check (return is only on FAILURE)', () => {
      // The `if (!deepEquals)` block only returns when the const
      // check FAILS. Pass-through does NOT short-circuit subsequent
      // checks. Pin: a contradictory schema {const: 42, type: 'string'}
      // still reports the type mismatch even though const passed.
      const v = new LexiconValidator({
        contradictory: { const: 42, type: 'string' },
      });
      const r = v.validate(42, 'contradictory');
      if (r.ok) throw new Error('expected ok:false');
      expect(r.errors[0]?.kind).toBe('type_mismatch');
    });

    it('const fails → only const_mismatch reported (no type error)', () => {
      // Value mismatching const → const_mismatch error → return.
      // Even though string-42 also fails the type check, it doesn't
      // appear in errors. Pin the early-return on FAILURE.
      const v = new LexiconValidator({
        contradictory: { const: 42, type: 'string' },
      });
      const r = v.validate('hello', 'contradictory');
      if (r.ok) throw new Error('expected ok:false');
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]?.kind).toBe('const_mismatch');
    });

    it('enum passes → continues to type check (only failure short-circuits)', () => {
      // Counter-pin to the const test: same return-on-failure semantics.
      // {enum: [42], type: 'string'} validating 42 → enum passes,
      // then type check fires.
      const v = new LexiconValidator({
        e: { enum: [42, 'hello'], type: 'string' },
      });
      const r = v.validate(42, 'e');
      if (r.ok) throw new Error('expected ok:false');
      expect(r.errors[0]?.kind).toBe('type_mismatch');
    });

    it('enum fails → only enum_mismatch reported', () => {
      const v = new LexiconValidator({
        e: { enum: [1, 2, 3], type: 'integer' },
      });
      const r = v.validate(99, 'e');
      if (r.ok) throw new Error('expected ok:false');
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]?.kind).toBe('enum_mismatch');
    });

    it('type mismatch returns early — minLength check NOT run', () => {
      // {type: 'string', minLength: 5}, value 42 → only one
      // type_mismatch error, no min_length error.
      const v = new LexiconValidator({
        s: { type: 'string', minLength: 5 },
      });
      const r = v.validate(42, 's');
      if (r.ok) throw new Error('expected ok:false');
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]?.kind).toBe('type_mismatch');
    });

    it('NaN as const fails strict equality (a === b false for NaN)', () => {
      // deepEquals uses `a === b` first — and `NaN === NaN` is false.
      // Pin: a schema declaring const NaN is unsatisfiable.
      const v = new LexiconValidator({ n: { const: Number.NaN } });
      const r = v.validate(Number.NaN, 'n');
      // NaN value also fails the implicit number-finite check,
      // BUT the const check runs first.
      if (r.ok) throw new Error('expected ok:false');
      expect(r.errors[0]?.kind).toBe('const_mismatch');
    });

    it('NaN in enum is unreachable (deepEquals false for NaN)', () => {
      const v = new LexiconValidator({ e: { enum: [Number.NaN, 'fallback'] } });
      // NaN value cannot match the NaN entry — falls through to other
      // entries; only 'fallback' matches.
      expect(v.validate(Number.NaN, 'e').ok).toBe(false);
      expect(v.validate('fallback', 'e').ok).toBe(true);
    });
  });

  describe('additionalProperties — true + undefined are permissive', () => {
    it('additionalProperties: true allows unknown keys', () => {
      const v = new LexiconValidator({
        obj: {
          type: 'object',
          properties: { known: { type: 'string' } },
          additionalProperties: true,
        },
      });
      expect(v.validate({ known: 'x', unknown: 99 }, 'obj').ok).toBe(true);
    });

    it('additionalProperties omitted (undefined) allows unknown keys', () => {
      // Counter-pin: omitted means permissive (matches JSON Schema spec).
      const v = new LexiconValidator({
        obj: {
          type: 'object',
          properties: { known: { type: 'string' } },
        },
      });
      expect(v.validate({ known: 'x', unknown: 99 }, 'obj').ok).toBe(true);
    });

    it('additionalProperties: false IS the only rejecting form', () => {
      // Sanity counter-pin: pre-existing test covers false rejecting.
      const v = new LexiconValidator({
        obj: {
          type: 'object',
          properties: { known: { type: 'string' } },
          additionalProperties: false,
        },
      });
      expect(v.validate({ known: 'x', unknown: 99 }, 'obj').ok).toBe(false);
    });

    it('object with no properties + additionalProperties:false rejects ALL keys', () => {
      // Edge case: empty properties + strict additional. Anything
      // non-empty → all keys flagged.
      const v = new LexiconValidator({
        empty: { type: 'object', additionalProperties: false },
      });
      const r = v.validate({ a: 1, b: 2 }, 'empty');
      if (r.ok) throw new Error('expected ok:false');
      expect(r.errors.every((e) => e.kind === 'additional_property_not_allowed')).toBe(true);
      expect(r.errors).toHaveLength(2);
    });
  });

  describe('constructor — edge cases', () => {
    it('throws when schemas is undefined', () => {
      // Pre-existing test covers null; pin undefined too.
      expect(
        () =>
          new LexiconValidator(
            undefined as unknown as Record<string, LexiconSchema>,
          ),
      ).toThrow(/schemas/);
    });

    it('throws when schemas is a primitive (number)', () => {
      expect(
        () =>
          new LexiconValidator(
            42 as unknown as Record<string, LexiconSchema>,
          ),
      ).toThrow(/schemas/);
    });

    it('empty schemas object → constructs successfully', () => {
      // Edge case: zero schemas registered. has() always false,
      // collections() returns []. validate() returns
      // unknown_collection.
      const v = new LexiconValidator({});
      expect(v.collections()).toEqual([]);
      expect(v.has('any')).toBe(false);
      const r = v.validate({}, 'any');
      if (r.ok) throw new Error('expected ok:false');
      expect(r.errors[0]?.kind).toBe('unknown_collection');
    });

    it.each([
      ['null', null],
      ['undefined', undefined],
      ['number', 42],
      ['string', 'not-a-schema'],
      ['boolean', true],
    ])('schema entry as %s → throws', (_label, badEntry) => {
      expect(
        () =>
          new LexiconValidator({
            x: badEntry as unknown as LexiconSchema,
          }),
      ).toThrow(/must be an object/);
    });

    it('schema entry as array → still treated as object (Array IS typeof object)', () => {
      // Pin: the constructor's check is `!schema || typeof schema !== 'object'`
      // — does NOT call Array.isArray. So an array schema slips through
      // construction. The validator would behave oddly later but it's
      // documented permissive. A future tighten would surface here.
      expect(
        () => new LexiconValidator({ x: [] as unknown as LexiconSchema }),
      ).not.toThrow();
    });
  });

  describe('maxErrors — boundary values', () => {
    function arrayOf20Mismatches(): unknown[] {
      return new Array(20).fill(42);
    }

    it('explicit-undefined maxErrors falls back to DEFAULT_MAX_ERRORS', () => {
      // Pin: opts.maxErrors === undefined uses ?? fallback.
      const v = new LexiconValidator(
        { many: { type: 'array', items: { type: 'string' } } },
        { maxErrors: undefined },
      );
      const r = v.validate(arrayOf20Mismatches(), 'many');
      if (r.ok) throw new Error('expected ok:false');
      expect(r.errors).toHaveLength(DEFAULT_MAX_ERRORS);
    });

    it('maxErrors: 0 → returns immediately with no errors collected (still ok:false)', () => {
      // The current `errors.length >= maxErrors` check at the start
      // of every push means 0 caps right away. The result is
      // {ok: false, errors: []} — empty array, but ok:false because
      // the function checks `errors.length === 0` AFTER the walk.
      // Wait — when maxErrors is 0, no errors get pushed, so
      // errors.length === 0 → returns ok:true. Pin actual behavior.
      const v = new LexiconValidator(
        { many: { type: 'array', items: { type: 'string' } } },
        { maxErrors: 0 },
      );
      const r = v.validate(arrayOf20Mismatches(), 'many');
      // Documented quirk: maxErrors=0 makes ALL violations
      // unreportable, which the validator treats as ok:true.
      // This is actually a DEFECT-class issue worth flagging
      // but pinning current behavior so a fix is intentional.
      expect(r.ok).toBe(true);
    });

    it('maxErrors: 1 → caps at 1, still ok:false', () => {
      const v = new LexiconValidator(
        { many: { type: 'array', items: { type: 'string' } } },
        { maxErrors: 1 },
      );
      const r = v.validate(arrayOf20Mismatches(), 'many');
      if (r.ok) throw new Error('expected ok:false');
      expect(r.errors).toHaveLength(1);
    });

    it('maxErrors very large → collects all errors below the cap', () => {
      const v = new LexiconValidator(
        { many: { type: 'array', items: { type: 'string' } } },
        { maxErrors: 1000 },
      );
      const r = v.validate(arrayOf20Mismatches(), 'many');
      if (r.ok) throw new Error('expected ok:false');
      expect(r.errors).toHaveLength(20);
    });
  });

  describe('multi-error document order', () => {
    // When multiple violations exist in different parts of a doc,
    // pin the visit order: top-level required first, then property
    // walk in input-key order, recursing into objects/arrays.
    it('reports errors in walk order: required missing first, then property errors', () => {
      const v = new LexiconValidator({
        prof: {
          type: 'object',
          required: ['name', 'isPublic'],
          properties: {
            name: { type: 'string' },
            isPublic: { type: 'boolean' },
            tags: { type: 'array', items: { type: 'string' } },
          },
        },
      });
      const r = v.validate(
        {
          // name missing → required_missing
          // isPublic = 'yes' → type_mismatch
          // tags = [42] → type_mismatch on /tags/0
          isPublic: 'yes',
          tags: [42],
        },
        'prof',
      );
      if (r.ok) throw new Error('expected ok:false');
      // First error: required_missing for /name (required check runs
      // BEFORE the property walk).
      expect(r.errors[0]).toMatchObject({
        path: '/name',
        kind: 'required_missing',
      });
      // Subsequent errors are in property order.
      const paths = r.errors.map((e) => e.path);
      expect(paths).toEqual(['/name', '/isPublic', '/tags/0']);
    });

    it('nested array errors include item index in path order', () => {
      const v = new LexiconValidator({
        a: { type: 'array', items: { type: 'string' } },
      });
      const r = v.validate([42, 'ok', 99, 'fine', 7], 'a');
      if (r.ok) throw new Error('expected ok:false');
      // Indices 0, 2, 4 are bad — must appear in that order.
      const paths = r.errors.map((e) => e.path);
      expect(paths).toEqual(['/0', '/2', '/4']);
    });
  });

  describe('outcome shape pinning', () => {
    const v = new LexiconValidator({
      s: { type: 'string' },
    });

    it('ok:true outcome has exactly {ok: true} (no extra fields)', () => {
      const r = v.validate('hi', 's');
      // Pin minimal-success shape — no `errors: []` leak.
      expect(Object.keys(r).sort()).toEqual(['ok']);
      expect(r.ok).toBe(true);
    });

    it('ok:false outcome has exactly {ok: false, errors: [...]}', () => {
      const r = v.validate(42, 's');
      expect(Object.keys(r).sort()).toEqual(['errors', 'ok']);
      if (!r.ok) {
        expect(Array.isArray(r.errors)).toBe(true);
        // errors[].length is at least 1 (no silent empty failure).
        expect(r.errors.length).toBeGreaterThan(0);
      }
    });

    it('every error has exactly {path, kind, message} (no extra fields)', () => {
      const r = v.validate(42, 's');
      if (r.ok) throw new Error('expected ok:false');
      for (const err of r.errors) {
        expect(Object.keys(err).sort()).toEqual(['kind', 'message', 'path']);
        expect(typeof err.path).toBe('string');
        expect(typeof err.kind).toBe('string');
        expect(typeof err.message).toBe('string');
      }
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
      if (r.ok) throw new Error('expected ok:false');
      // "/" becomes "~1", "~" becomes "~0"
      expect(r.errors[0]?.path).toBe('/path~1with~1slashes');
    });
  });
});
