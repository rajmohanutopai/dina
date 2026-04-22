/**
 * Tests for the minimal draft-07-subset JSON Schema validator that
 * checks inbound service.query params against the published schema.
 */

import { validateAgainstSchema } from '../../src/service/capabilities/schema_validator';

describe('validateAgainstSchema', () => {
  describe('type', () => {
    it('accepts matching primitive types', () => {
      expect(validateAgainstSchema('hi', { type: 'string' })).toBeNull();
      expect(validateAgainstSchema(42, { type: 'number' })).toBeNull();
      expect(validateAgainstSchema(42, { type: 'integer' })).toBeNull();
      expect(validateAgainstSchema(true, { type: 'boolean' })).toBeNull();
      expect(validateAgainstSchema(null, { type: 'null' })).toBeNull();
      expect(validateAgainstSchema([], { type: 'array' })).toBeNull();
      expect(validateAgainstSchema({}, { type: 'object' })).toBeNull();
    });

    it('rejects mismatches with a one-line error', () => {
      expect(validateAgainstSchema(42, { type: 'string' })).toMatch(/must be a string/);
      expect(validateAgainstSchema('x', { type: 'number' })).toMatch(/finite number/);
      expect(validateAgainstSchema(1.5, { type: 'integer' })).toMatch(/integer/);
      expect(validateAgainstSchema([], { type: 'object' })).toMatch(/JSON object/);
      expect(validateAgainstSchema({}, { type: 'array' })).toMatch(/array/);
    });

    it('supports type unions', () => {
      expect(validateAgainstSchema('x', { type: ['string', 'null'] })).toBeNull();
      expect(validateAgainstSchema(null, { type: ['string', 'null'] })).toBeNull();
      expect(validateAgainstSchema(1, { type: ['string', 'null'] })).toMatch(
        /must be one of types/,
      );
    });

    it('rejects non-finite numbers even for number type', () => {
      expect(validateAgainstSchema(NaN, { type: 'number' })).toMatch(/finite/);
      expect(validateAgainstSchema(Infinity, { type: 'number' })).toMatch(/finite/);
    });
  });

  describe('object validation', () => {
    const schema = {
      type: 'object',
      required: ['patient_id'],
      additionalProperties: false,
      properties: {
        patient_id: { type: 'string', minLength: 1 },
        visit_id: { type: 'string' },
      },
    };

    it('accepts well-formed objects', () => {
      expect(validateAgainstSchema({ patient_id: 'p1', visit_id: 'v1' }, schema)).toBeNull();
      expect(validateAgainstSchema({ patient_id: 'p1' }, schema)).toBeNull();
    });

    it('rejects missing required fields', () => {
      expect(validateAgainstSchema({ visit_id: 'v1' }, schema)).toMatch(/patient_id: required/);
    });

    it('rejects additional properties when additionalProperties=false', () => {
      expect(validateAgainstSchema({ patient_id: 'p1', unknown: 'x' }, schema)).toMatch(
        /unknown: additional property not allowed/,
      );
    });

    it('recurses into properties', () => {
      expect(validateAgainstSchema({ patient_id: '' }, schema)).toMatch(/length ≥ 1/);
    });

    it('rejects undefined required values, not just missing keys', () => {
      expect(validateAgainstSchema({ patient_id: undefined }, schema)).toMatch(
        /patient_id: required/,
      );
    });
  });

  describe('string constraints', () => {
    it('enforces minLength + maxLength', () => {
      const s = { type: 'string', minLength: 2, maxLength: 4 };
      expect(validateAgainstSchema('ab', s)).toBeNull();
      expect(validateAgainstSchema('abcd', s)).toBeNull();
      expect(validateAgainstSchema('a', s)).toMatch(/length ≥ 2/);
      expect(validateAgainstSchema('abcde', s)).toMatch(/length ≤ 4/);
    });

    it('enforces pattern', () => {
      const s = { type: 'string', pattern: '^[A-Z]{3}$' };
      expect(validateAgainstSchema('ABC', s)).toBeNull();
      expect(validateAgainstSchema('abc', s)).toMatch(/must match pattern/);
    });

    it('reports invalid regex patterns gracefully', () => {
      const s = { type: 'string', pattern: '[' };
      expect(validateAgainstSchema('x', s)).toMatch(/invalid pattern/);
    });
  });

  describe('number constraints', () => {
    it('enforces minimum/maximum', () => {
      expect(validateAgainstSchema(1, { type: 'number', minimum: 2 })).toMatch(/≥ 2/);
      expect(validateAgainstSchema(3, { type: 'number', maximum: 2 })).toMatch(/≤ 2/);
    });

    it('enforces exclusive bounds', () => {
      expect(validateAgainstSchema(2, { type: 'number', exclusiveMinimum: 2 })).toMatch(/> 2/);
      expect(validateAgainstSchema(2, { type: 'number', exclusiveMaximum: 2 })).toMatch(/< 2/);
      expect(validateAgainstSchema(3, { type: 'number', exclusiveMinimum: 2 })).toBeNull();
    });
  });

  describe('array constraints', () => {
    it('enforces minItems/maxItems', () => {
      expect(validateAgainstSchema([], { type: 'array', minItems: 1 })).toMatch(/≥ 1 items/);
      expect(validateAgainstSchema([1, 2], { type: 'array', maxItems: 1 })).toMatch(/≤ 1 items/);
    });

    it('recurses into items schema', () => {
      const s = { type: 'array', items: { type: 'string' } };
      expect(validateAgainstSchema(['a', 'b'], s)).toBeNull();
      expect(validateAgainstSchema(['a', 1], s)).toMatch(/params\[1\]: must be a string/);
    });
  });

  describe('enum + const', () => {
    it('enforces enum', () => {
      const s = { type: 'string', enum: ['auto', 'review'] };
      expect(validateAgainstSchema('auto', s)).toBeNull();
      expect(validateAgainstSchema('other', s)).toMatch(/one of/);
    });

    it('enforces const', () => {
      expect(validateAgainstSchema('x', { const: 'x' })).toBeNull();
      expect(validateAgainstSchema('y', { const: 'x' })).toMatch(/must equal/);
    });

    it('enum deep-equal compares objects', () => {
      const s = { enum: [{ kind: 'a' }, { kind: 'b' }] };
      expect(validateAgainstSchema({ kind: 'a' }, s)).toBeNull();
      expect(validateAgainstSchema({ kind: 'c' }, s)).toMatch(/one of/);
    });
  });

  describe('degenerate inputs', () => {
    it('returns null when schema is null / non-object', () => {
      expect(validateAgainstSchema('x', null)).toBeNull();
      expect(validateAgainstSchema('x', 'not-a-schema')).toBeNull();
    });

    it('empty schema accepts anything', () => {
      expect(validateAgainstSchema({ anything: 1 }, {})).toBeNull();
    });

    it('nested paths surface in error messages', () => {
      const s = {
        type: 'object',
        properties: {
          inner: {
            type: 'object',
            required: ['foo'],
            properties: { foo: { type: 'string' } },
          },
        },
      };
      expect(validateAgainstSchema({ inner: {} }, s)).toMatch(/params\.inner\.foo: required/);
    });
  });
});
