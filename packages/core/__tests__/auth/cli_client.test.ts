/**
 * T2C.3 — CLI client utilities: error handling, signing headers, body extraction.
 *
 * Source: cli/tests/test_client.py
 */

import {
  handleConnectionError,
  handleAuthError,
  hasSigningHeaders,
  hasNoBearerHeader,
  extractBody,
} from '../../src/cli/client';

describe('CLI Client Utilities', () => {
  describe('handleConnectionError', () => {
    it('ECONNREFUSED is retryable', () => {
      const result = handleConnectionError(new Error('ECONNREFUSED'));
      expect(result.retryable).toBe(true);
      expect(result.message).toContain('running');
    });

    it('timeout is retryable', () => {
      const result = handleConnectionError(new Error('timeout'));
      expect(result.retryable).toBe(true);
      expect(result.message).toContain('retry');
    });

    it('unknown error has descriptive message', () => {
      const result = handleConnectionError(new Error('something unexpected'));
      expect(result.message).toContain('something unexpected');
    });
  });

  describe('handleAuthError', () => {
    it('provides message and action for 401', () => {
      const result = handleAuthError();
      expect(result.message).toContain('401');
      expect(result.action).toContain('pair');
    });
  });

  describe('hasSigningHeaders', () => {
    it('returns true when all 4 headers present', () => {
      expect(
        hasSigningHeaders({
          'X-DID': 'did:key:z6MkTest',
          'X-Timestamp': '2026-04-09T12:00:00Z',
          'X-Nonce': 'abc',
          'X-Signature': 'deadbeef',
        }),
      ).toBe(true);
    });

    it('returns false when headers missing', () => {
      expect(hasSigningHeaders({})).toBe(false);
    });

    it('returns false when partial headers', () => {
      expect(hasSigningHeaders({ 'X-DID': 'did:key:z6MkTest' })).toBe(false);
    });

    it('returns false when any header is empty', () => {
      expect(
        hasSigningHeaders({
          'X-DID': 'did:key:z6MkTest',
          'X-Timestamp': '',
          'X-Nonce': 'abc',
          'X-Signature': 'def',
        }),
      ).toBe(false);
    });
  });

  describe('hasNoBearerHeader', () => {
    it('true when no Authorization header', () => {
      expect(hasNoBearerHeader({})).toBe(true);
    });

    it('false when Bearer present', () => {
      expect(hasNoBearerHeader({ Authorization: 'Bearer token123' })).toBe(false);
    });

    it('true when non-Bearer auth (e.g., Basic)', () => {
      expect(hasNoBearerHeader({ Authorization: 'Basic abc123' })).toBe(true);
    });
  });

  describe('extractBody', () => {
    it('JSON with compact separators', () => {
      const result = extractBody({ source: 'gmail', type: 'email' });
      expect(result).toBe('{"source":"gmail","type":"email"}');
      expect(result).not.toContain(': ');
    });

    it('handles string content', () => {
      expect(extractBody('plain text')).toBe('plain text');
    });

    it('handles undefined', () => {
      expect(extractBody(undefined)).toBe('');
    });

    it('handles null', () => {
      expect(extractBody(null)).toBe('');
    });
  });
});
