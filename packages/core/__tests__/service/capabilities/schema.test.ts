/**
 * Tests for the minimal draft-07-subset JSON Schema validator that
 * checks inbound service.query params against the published schema.
 */

import { serviceSchemaError } from '../../../src/service/capabilities/schema';

describe('serviceSchemaError', () => {
  describe('type', () => {
    it('accepts matching primitive types', () => {
      expect(serviceSchemaError('hi', { type: 'string' })).toBeNull();
      expect(serviceSchemaError(42, { type: 'number' })).toBeNull();
      expect(serviceSchemaError(42, { type: 'integer' })).toBeNull();
      expect(serviceSchemaError(true, { type: 'boolean' })).toBeNull();
      expect(serviceSchemaError(null, { type: 'null' })).toBeNull();
      expect(serviceSchemaError([], { type: 'array' })).toBeNull();
      expect(serviceSchemaError({}, { type: 'object' })).toBeNull();
    });

    it('rejects mismatches with a one-line error', () => {
      expect(serviceSchemaError(42, { type: 'string' })).toMatch(/must be a string/);
      expect(serviceSchemaError('x', { type: 'number' })).toMatch(/finite number/);
      expect(serviceSchemaError(1.5, { type: 'integer' })).toMatch(/integer/);
      expect(serviceSchemaError([], { type: 'object' })).toMatch(/JSON object/);
      expect(serviceSchemaError({}, { type: 'array' })).toMatch(/array/);
    });

    it('supports type unions', () => {
      expect(serviceSchemaError('x', { type: ['string', 'null'] })).toBeNull();
      expect(serviceSchemaError(null, { type: ['string', 'null'] })).toBeNull();
      expect(serviceSchemaError(1, { type: ['string', 'null'] })).toMatch(
        /must be one of types/,
      );
    });

    it('rejects non-finite numbers even for number type', () => {
      expect(serviceSchemaError(NaN, { type: 'number' })).toMatch(/finite/);
      expect(serviceSchemaError(Infinity, { type: 'number' })).toMatch(/finite/);
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
      expect(serviceSchemaError({ patient_id: 'p1', visit_id: 'v1' }, schema)).toBeNull();
      expect(serviceSchemaError({ patient_id: 'p1' }, schema)).toBeNull();
    });

    it('rejects missing required fields', () => {
      expect(serviceSchemaError({ visit_id: 'v1' }, schema)).toMatch(/patient_id: required/);
    });

    it('rejects additional properties when additionalProperties=false', () => {
      expect(serviceSchemaError({ patient_id: 'p1', unknown: 'x' }, schema)).toMatch(
        /unknown: additional property not allowed/,
      );
    });

    it('recurses into properties', () => {
      expect(serviceSchemaError({ patient_id: '' }, schema)).toMatch(/length ≥ 1/);
    });

    it('rejects undefined required values, not just missing keys', () => {
      expect(serviceSchemaError({ patient_id: undefined }, schema)).toMatch(
        /patient_id: required/,
      );
    });
  });

  describe('string constraints', () => {
    it('enforces minLength + maxLength', () => {
      const s = { type: 'string', minLength: 2, maxLength: 4 };
      expect(serviceSchemaError('ab', s)).toBeNull();
      expect(serviceSchemaError('abcd', s)).toBeNull();
      expect(serviceSchemaError('a', s)).toMatch(/length ≥ 2/);
      expect(serviceSchemaError('abcde', s)).toMatch(/length ≤ 4/);
    });

    it('enforces pattern', () => {
      const s = { type: 'string', pattern: '^[A-Z]{3}$' };
      expect(serviceSchemaError('ABC', s)).toBeNull();
      expect(serviceSchemaError('abc', s)).toMatch(/must match pattern/);
    });

    it('reports invalid regex patterns gracefully', () => {
      const s = { type: 'string', pattern: '[' };
      expect(serviceSchemaError('x', s)).toMatch(/invalid pattern/);
    });
  });

  describe('number constraints', () => {
    it('enforces minimum/maximum', () => {
      expect(serviceSchemaError(1, { type: 'number', minimum: 2 })).toMatch(/≥ 2/);
      expect(serviceSchemaError(3, { type: 'number', maximum: 2 })).toMatch(/≤ 2/);
    });

    it('enforces exclusive bounds', () => {
      expect(serviceSchemaError(2, { type: 'number', exclusiveMinimum: 2 })).toMatch(/> 2/);
      expect(serviceSchemaError(2, { type: 'number', exclusiveMaximum: 2 })).toMatch(/< 2/);
      expect(serviceSchemaError(3, { type: 'number', exclusiveMinimum: 2 })).toBeNull();
    });
  });

  describe('array constraints', () => {
    it('enforces minItems/maxItems', () => {
      expect(serviceSchemaError([], { type: 'array', minItems: 1 })).toMatch(/≥ 1 items/);
      expect(serviceSchemaError([1, 2], { type: 'array', maxItems: 1 })).toMatch(/≤ 1 items/);
    });

    it('recurses into items schema', () => {
      const s = { type: 'array', items: { type: 'string' } };
      expect(serviceSchemaError(['a', 'b'], s)).toBeNull();
      expect(serviceSchemaError(['a', 1], s)).toMatch(/params\[1\]: must be a string/);
    });
  });

  describe('enum + const', () => {
    it('enforces enum', () => {
      const s = { type: 'string', enum: ['auto', 'review'] };
      expect(serviceSchemaError('auto', s)).toBeNull();
      expect(serviceSchemaError('other', s)).toMatch(/one of/);
    });

    it('enforces const', () => {
      expect(serviceSchemaError('x', { const: 'x' })).toBeNull();
      expect(serviceSchemaError('y', { const: 'x' })).toMatch(/must equal/);
    });

    it('enum deep-equal compares objects', () => {
      const s = { enum: [{ kind: 'a' }, { kind: 'b' }] };
      expect(serviceSchemaError({ kind: 'a' }, s)).toBeNull();
      expect(serviceSchemaError({ kind: 'c' }, s)).toMatch(/one of/);
    });
  });

  describe('degenerate inputs', () => {
    it('returns null when schema is null / non-object', () => {
      expect(serviceSchemaError('x', null)).toBeNull();
      expect(serviceSchemaError('x', 'not-a-schema')).toBeNull();
    });

    it('empty schema accepts anything', () => {
      expect(serviceSchemaError({ anything: 1 }, {})).toBeNull();
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
      expect(serviceSchemaError({ inner: {} }, s)).toMatch(/params\.inner\.foo: required/);
    });
  });
});
