/**
 * T2.9 — Structured logging: PII-safe, never log body.
 *
 * Source: ARCHITECTURE.md Task 2.9
 */

import {
  logRequest,
  logResponse,
  logError,
  log,
  sanitizeForLog,
  isRedactedField,
  getLogBuffer,
  clearLogBuffer,
  resetLogSink,
} from '../../src/logging/structured';

describe('Structured Logging', () => {
  beforeEach(() => {
    resetLogSink();
    clearLogBuffer();
  });

  describe('logRequest', () => {
    it('logs path + method + DID', () => {
      logRequest({ path: '/v1/vault/query', method: 'POST', did: 'did:key:z6MkBrain' });
      const entries = getLogBuffer();
      expect(entries).toHaveLength(1);
      expect(entries[0].path).toBe('/v1/vault/query');
      expect(entries[0].method).toBe('POST');
      expect(entries[0].did).toBe('did:key:z6MkBrain');
    });

    it('includes requestId and callerType', () => {
      logRequest({
        path: '/v1/vault/store',
        method: 'POST',
        did: 'did:key:z6MkBrain',
        callerType: 'service',
        requestId: 'req-abc',
      });
      const entry = getLogBuffer()[0];
      expect(entry.callerType).toBe('service');
      expect(entry.requestId).toBe('req-abc');
    });

    it('has ISO timestamp', () => {
      logRequest({ path: '/', method: 'GET' });
      expect(getLogBuffer()[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('level is info', () => {
      logRequest({ path: '/', method: 'GET' });
      expect(getLogBuffer()[0].level).toBe('info');
    });
  });

  describe('logResponse', () => {
    it('logs status + latency', () => {
      logResponse({
        path: '/v1/vault/query',
        method: 'POST',
        status: 200,
        latencyMs: 42,
        did: 'did:key:z6Mk',
      });
      const entry = getLogBuffer()[0];
      expect(entry.status).toBe(200);
      expect(entry.latencyMs).toBe(42);
      expect(entry.message).toContain('200');
      expect(entry.message).toContain('42ms');
    });

    it('200 → info level', () => {
      logResponse({ path: '/', method: 'GET', status: 200, latencyMs: 5 });
      expect(getLogBuffer()[0].level).toBe('info');
    });

    it('401 → warn level', () => {
      logResponse({ path: '/', method: 'GET', status: 401, latencyMs: 1 });
      expect(getLogBuffer()[0].level).toBe('warn');
    });

    it('500 → error level', () => {
      logResponse({ path: '/', method: 'GET', status: 500, latencyMs: 100 });
      expect(getLogBuffer()[0].level).toBe('error');
    });
  });

  describe('logError', () => {
    it('logs error message', () => {
      logError('Connection failed', new Error('ECONNREFUSED'));
      const entry = getLogBuffer()[0];
      expect(entry.level).toBe('error');
      expect(entry.message).toBe('Connection failed');
      expect(entry.error).toBe('ECONNREFUSED');
    });
  });

  describe('sanitizeForLog', () => {
    it('redacts body field', () => {
      const sanitized = sanitizeForLog({ path: '/test', body: '{"secret":"data"}' });
      expect(sanitized.path).toBe('/test');
      expect(sanitized.body).toBe('[REDACTED]');
    });

    it('redacts password and passphrase', () => {
      const sanitized = sanitizeForLog({ password: 'secret', passphrase: 'secret' });
      expect(sanitized.password).toBe('[REDACTED]');
      expect(sanitized.passphrase).toBe('[REDACTED]');
    });

    it('redacts PII fields', () => {
      const sanitized = sanitizeForLog({ email: 'john@example.com', phone: '555-1234' });
      expect(sanitized.email).toBe('[REDACTED]');
      expect(sanitized.phone).toBe('[REDACTED]');
    });

    it('redacts auth fields', () => {
      const sanitized = sanitizeForLog({
        'X-Signature': 'deadbeef',
        'X-Nonce': 'abc123',
        token: 'bearer-xyz',
      });
      expect(sanitized['X-Signature']).toBe('[REDACTED]');
      expect(sanitized['X-Nonce']).toBe('[REDACTED]');
      expect(sanitized.token).toBe('[REDACTED]');
    });

    it('truncates long values', () => {
      const sanitized = sanitizeForLog({ longField: 'x'.repeat(500) });
      expect((sanitized.longField as string).length).toBeLessThan(250);
      expect(sanitized.longField).toContain('[truncated]');
    });

    it('passes safe fields through', () => {
      const sanitized = sanitizeForLog({ path: '/v1/test', method: 'GET', status: 200 });
      expect(sanitized.path).toBe('/v1/test');
      expect(sanitized.method).toBe('GET');
      expect(sanitized.status).toBe(200);
    });
  });

  describe('isRedactedField', () => {
    it('body is redacted', () => expect(isRedactedField('body')).toBe(true));
    it('password is redacted', () => expect(isRedactedField('password')).toBe(true));
    it('privateKey is redacted', () => expect(isRedactedField('privateKey')).toBe(true));
    it('seed is redacted', () => expect(isRedactedField('seed')).toBe(true));
    it('path is NOT redacted', () => expect(isRedactedField('path')).toBe(false));
    it('status is NOT redacted', () => expect(isRedactedField('status')).toBe(false));
  });

  describe('log sink', () => {
    it('custom sink receives entries', () => {
      const captured: Array<Record<string, unknown>> = [];
      const { setLogSink } = require('../../src/logging/structured');
      setLogSink((entry: Record<string, unknown>) => {
        captured.push(entry);
      });
      log('info', 'test message');
      expect(captured).toHaveLength(1);
      expect(captured[0].message).toBe('test message');
    });
  });
});
