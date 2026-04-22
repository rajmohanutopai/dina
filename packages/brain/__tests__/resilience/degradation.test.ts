/**
 * T2B.14 — Resilience: error handling, graceful degradation, startup deps.
 *
 * Source: brain/tests/test_resilience.py
 */

import {
  handleUnhandledException,
  checkMemoryHealth,
  gracefulShutdown,
  checkStartupDependencies,
  handleInvalidDID,
} from '../../src/resilience/degradation';

describe('Resilience & Degradation', () => {
  describe('handleUnhandledException', () => {
    it('recovers from unhandled error', () => {
      const result = handleUnhandledException(new Error('test crash'));
      expect(result.recovered).toBe(true);
    });

    it('returns recovered:true with fallback', () => {
      const result = handleUnhandledException(new Error('recoverable'));
      expect(result.recovered).toBe(true);
      expect(result.fallback).toBeTruthy();
    });

    it('returns FTS fallback for LLM timeout', () => {
      const result = handleUnhandledException(new Error('LLM timeout'));
      expect(result.recovered).toBe(true);
      expect(result.fallback).toContain('FTS');
    });

    it('returns retry fallback for Core unreachable', () => {
      const result = handleUnhandledException(new Error('Core unreachable'));
      expect(result.fallback).toContain('Retry');
    });
  });

  describe('checkMemoryHealth', () => {
    it('reports heap usage in MB', () => {
      const result = checkMemoryHealth();
      expect(typeof result.heapUsedMB).toBe('number');
      expect(result.heapUsedMB).toBeGreaterThan(0);
    });

    it('reports healthy status', () => {
      const result = checkMemoryHealth();
      // In test environment, heap should be well under 512MB
      expect(result.healthy).toBe(true);
    });
  });

  describe('gracefulShutdown', () => {
    it('completes without error', async () => {
      await expect(gracefulShutdown()).resolves.toBeUndefined();
    });
  });

  describe('checkStartupDependencies', () => {
    it('returns ready status', async () => {
      const result = await checkStartupDependencies();
      expect(result.ready).toBe(true);
      expect(result.missing).toEqual([]);
    });
  });

  describe('handleInvalidDID', () => {
    it('rejects empty DID', () => {
      const result = handleInvalidDID('');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('empty');
    });

    it('rejects non-DID string', () => {
      const result = handleInvalidDID('not-a-did');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('did:');
    });

    it('accepts valid did:plc format', () => {
      expect(handleInvalidDID('did:plc:test123').valid).toBe(true);
    });

    it('accepts valid did:key format', () => {
      expect(handleInvalidDID('did:key:z6MkTest').valid).toBe(true);
    });

    it('rejects unknown DID method', () => {
      const result = handleInvalidDID('did:unknown:test');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Unknown DID method');
    });

    it('rejects malformed DID (too few parts)', () => {
      const result = handleInvalidDID('did:plc');
      expect(result.valid).toBe(false);
    });
  });
});
