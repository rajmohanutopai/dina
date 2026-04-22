/**
 * T2A.1b — API contract type guards: error responses, list responses,
 * content type, 404 validation.
 *
 * Category B: contract test (unit level, no HTTP server).
 *
 * Source: core/test/apicontract_test.go
 */

import {
  isValidErrorResponse,
  isValidListResponse,
  expectedContentType,
  isValid404Response,
} from '../../src/api/contract';

describe('API Contract Type Guards', () => {
  describe('isValidErrorResponse', () => {
    it('accepts valid error response', () => {
      expect(isValidErrorResponse({ error: 'not found' })).toBe(true);
    });

    it('accepts error with message and detail', () => {
      expect(
        isValidErrorResponse({
          error: 'validation_error',
          message: 'Missing field',
          detail: 'persona is required',
        }),
      ).toBe(true);
    });

    it('rejects null', () => {
      expect(isValidErrorResponse(null)).toBe(false);
    });

    it('rejects string', () => {
      expect(isValidErrorResponse('error')).toBe(false);
    });

    it('rejects object without error field', () => {
      expect(isValidErrorResponse({ message: 'oops' })).toBe(false);
    });

    it('rejects empty error string', () => {
      expect(isValidErrorResponse({ error: '' })).toBe(false);
    });

    it('rejects non-string error', () => {
      expect(isValidErrorResponse({ error: 42 })).toBe(false);
    });

    it('rejects non-string message', () => {
      expect(isValidErrorResponse({ error: 'bad', message: 123 })).toBe(false);
    });
  });

  describe('isValidListResponse', () => {
    it('accepts response with items array', () => {
      expect(isValidListResponse({ items: [] })).toBe(true);
    });

    it('accepts response with items and total', () => {
      expect(isValidListResponse({ items: [{ id: 'a' }], total: 1 })).toBe(true);
    });

    it('accepts response with cursor', () => {
      expect(isValidListResponse({ items: [], cursor: 'next-page' })).toBe(true);
    });

    it('rejects null', () => {
      expect(isValidListResponse(null)).toBe(false);
    });

    it('rejects object without items', () => {
      expect(isValidListResponse({ total: 5 })).toBe(false);
    });

    it('rejects non-array items', () => {
      expect(isValidListResponse({ items: 'not-array' })).toBe(false);
    });

    it('rejects non-number total', () => {
      expect(isValidListResponse({ items: [], total: 'five' })).toBe(false);
    });
  });

  describe('expectedContentType', () => {
    it('returns application/json', () => {
      expect(expectedContentType()).toBe('application/json');
    });
  });

  describe('isValid404Response', () => {
    it('accepts 404 with "not found" error', () => {
      expect(isValid404Response(404, { error: 'not found' })).toBe(true);
    });

    it('accepts case-insensitive "Not Found"', () => {
      expect(isValid404Response(404, { error: 'Not Found' })).toBe(true);
    });

    it('rejects non-404 status', () => {
      expect(isValid404Response(200, { error: 'not found' })).toBe(false);
    });

    it('rejects 404 without error body', () => {
      expect(isValid404Response(404, null)).toBe(false);
    });

    it('rejects 404 with non-"not found" error', () => {
      expect(isValid404Response(404, { error: 'server error' })).toBe(false);
    });

    it('rejects 404 with empty body', () => {
      expect(isValid404Response(404, {})).toBe(false);
    });
  });
});
