/**
 * T1G.3 — Staging pipeline state machine.
 *
 * Category A: fixture-based. Verifies all valid/invalid state transitions,
 * retry logic, lease expiry, and item TTL.
 *
 * Source: core/test/staging_inbox_test.go
 */

import {
  isValidTransition,
  validTransitionsFrom,
  shouldRetry,
  isLeaseExpired,
  isItemExpired,
} from '../../src/staging/state_machine';
import type { StagingStatus } from '../../src/staging/state_machine';

describe('Staging State Machine', () => {
  describe('isValidTransition', () => {
    const validCases: Array<[StagingStatus, StagingStatus]> = [
      ['received', 'classifying'],
      ['classifying', 'stored'],
      ['classifying', 'pending_unlock'],
      ['classifying', 'failed'],
      ['classifying', 'received'],
      ['failed', 'received'],
      ['pending_unlock', 'stored'],
      ['pending_unlock', 'failed'],
    ];

    for (const [from, to] of validCases) {
      it(`allows: ${from} → ${to}`, () => {
        expect(isValidTransition(from, to)).toBe(true);
      });
    }

    const invalidCases: Array<[StagingStatus, StagingStatus]> = [
      ['received', 'stored'],
      ['received', 'pending_unlock'],
      ['received', 'failed'],
      ['stored', 'received'],
      ['stored', 'classifying'],
      ['stored', 'failed'],
      ['failed', 'stored'],
      ['failed', 'classifying'],
      ['pending_unlock', 'received'],
      ['pending_unlock', 'classifying'],
    ];

    for (const [from, to] of invalidCases) {
      it(`rejects: ${from} → ${to}`, () => {
        expect(isValidTransition(from, to)).toBe(false);
      });
    }

    it('self-transitions are invalid', () => {
      const states: StagingStatus[] = [
        'received',
        'classifying',
        'stored',
        'pending_unlock',
        'failed',
      ];
      for (const s of states) {
        expect(isValidTransition(s, s)).toBe(false);
      }
    });
  });

  describe('validTransitionsFrom', () => {
    it('received → [classifying]', () => {
      expect(validTransitionsFrom('received')).toEqual(['classifying']);
    });

    it('classifying → 5 options (including pending_approval)', () => {
      const targets = validTransitionsFrom('classifying').sort();
      expect(targets).toEqual([
        'failed',
        'pending_approval',
        'pending_unlock',
        'received',
        'stored',
      ]);
    });

    it('stored → [] (terminal)', () => {
      expect(validTransitionsFrom('stored')).toEqual([]);
    });

    it('failed → [received]', () => {
      expect(validTransitionsFrom('failed')).toEqual(['received']);
    });

    it('pending_unlock → [stored, failed]', () => {
      expect(validTransitionsFrom('pending_unlock').sort()).toEqual(['failed', 'stored']);
    });
  });

  describe('shouldRetry', () => {
    it('retry_count 0 → should retry', () => {
      expect(shouldRetry(0)).toBe(true);
    });

    it('retry_count 3 → should retry (at limit)', () => {
      expect(shouldRetry(3)).toBe(true);
    });

    it('retry_count 4 → should NOT retry (dead-letter)', () => {
      expect(shouldRetry(4)).toBe(false);
    });

    it('respects custom maxRetries', () => {
      expect(shouldRetry(5, 10)).toBe(true);
      expect(shouldRetry(11, 10)).toBe(false);
    });
  });

  describe('isLeaseExpired', () => {
    it('lease in the future → not expired', () => {
      const now = Math.floor(Date.now() / 1000);
      expect(isLeaseExpired(now + 900, now)).toBe(false);
    });

    it('lease in the past → expired', () => {
      const now = Math.floor(Date.now() / 1000);
      expect(isLeaseExpired(now - 100, now)).toBe(true);
    });

    it('lease at exactly now → not expired (boundary)', () => {
      const now = Math.floor(Date.now() / 1000);
      expect(isLeaseExpired(now, now)).toBe(false);
    });
  });

  describe('isItemExpired', () => {
    it('expires_at in the future → not expired', () => {
      const now = Math.floor(Date.now() / 1000);
      expect(isItemExpired(now + 86400, now)).toBe(false);
    });

    it('expires_at in the past → expired', () => {
      const now = Math.floor(Date.now() / 1000);
      expect(isItemExpired(now - 86400, now)).toBe(true);
    });

    it('expires_at at exactly now → not expired (boundary)', () => {
      const now = Math.floor(Date.now() / 1000);
      expect(isItemExpired(now, now)).toBe(false);
    });
  });
});
