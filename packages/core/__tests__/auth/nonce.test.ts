/**
 * T1B.3 — Nonce replay cache.
 *
 * Category A: fixture-based. Verifies double-buffer nonce tracking
 * rejects duplicates within the window.
 *
 * Source: core/test/signature_test.go (nonce replay)
 */

import { NonceCache } from '../../src/auth/nonce';
import { hasFixture, loadVectors } from '@dina/test-harness';

describe('Nonce Replay Cache', () => {
  it('constructs without error', () => {
    expect(() => new NonceCache()).not.toThrow();
  });

  describe('check', () => {
    it('accepts a fresh nonce', () => {
      const cache = new NonceCache();
      expect(cache.check('abc123')).toBe(true);
    });

    it('rejects a duplicate nonce', () => {
      const cache = new NonceCache();
      expect(cache.check('abc123')).toBe(true);
      expect(cache.check('abc123')).toBe(false);
    });

    it('accepts different nonces', () => {
      const cache = new NonceCache();
      expect(cache.check('nonce1')).toBe(true);
      expect(cache.check('nonce2')).toBe(true);
      expect(cache.check('nonce3')).toBe(true);
    });

    it('rejects empty nonce', () => {
      const cache = new NonceCache();
      expect(cache.check('')).toBe(false);
    });
  });

  describe('rotate', () => {
    it('nonce survives one rotation (in previous buffer)', () => {
      const cache = new NonceCache();
      cache.check('old-nonce');
      cache.rotate();
      // "old-nonce" is now in previous buffer — still rejected
      expect(cache.check('old-nonce')).toBe(false);
    });

    it('nonce accepted after two rotations (evicted)', () => {
      const cache = new NonceCache();
      cache.check('old-nonce');
      cache.rotate(); // old-nonce moves to previous
      cache.rotate(); // previous discarded → old-nonce gone
      expect(cache.check('old-nonce')).toBe(true);
    });

    it('fresh nonces accepted after rotation', () => {
      const cache = new NonceCache();
      cache.check('a');
      cache.rotate();
      expect(cache.check('b')).toBe(true);
    });

    it('multiple rotations work correctly', () => {
      const cache = new NonceCache();
      cache.check('round1');
      cache.rotate();
      cache.check('round2');
      cache.rotate();
      // round1 evicted (2 rotations), round2 in previous
      expect(cache.check('round1')).toBe(true); // fresh again
      expect(cache.check('round2')).toBe(false); // still in previous
    });
  });

  describe('size', () => {
    it('starts at 0', () => {
      expect(new NonceCache().size()).toBe(0);
    });

    it('increases with each new nonce', () => {
      const cache = new NonceCache();
      cache.check('a');
      cache.check('b');
      expect(cache.size()).toBe(2);
    });

    it('counts both buffers', () => {
      const cache = new NonceCache();
      cache.check('a');
      cache.check('b');
      cache.rotate();
      cache.check('c');
      // previous: {a, b}, current: {c}
      expect(cache.size()).toBe(3);
    });

    it('decreases after rotation evicts old buffer', () => {
      const cache = new NonceCache();
      cache.check('a');
      cache.check('b');
      cache.rotate();
      cache.check('c');
      cache.rotate();
      // previous: {c}, current: empty. {a,b} evicted.
      expect(cache.size()).toBe(1);
    });

    it('duplicate nonce does not increase size', () => {
      const cache = new NonceCache();
      cache.check('same');
      cache.check('same'); // rejected, no insert
      expect(cache.size()).toBe(1);
    });
  });

  describe('auto-rotation on size threshold', () => {
    it('auto-rotates when current buffer exceeds maxEntries', () => {
      const cache = new NonceCache({ maxEntries: 5 });

      // Fill the buffer to threshold
      cache.check('n1');
      cache.check('n2');
      cache.check('n3');
      cache.check('n4');
      cache.check('n5');
      expect(cache.size()).toBe(5);

      // Next check triggers auto-rotation: current (5) moves to previous, fresh current
      cache.check('n6');
      // n6 is in new current (1 entry), n1-n5 are in previous (5 entries)
      expect(cache.size()).toBe(6);

      // n1 should still be in previous buffer (rejected)
      expect(cache.check('n1')).toBe(false);
    });

    it('prevents unbounded growth under DoS', () => {
      const cache = new NonceCache({ maxEntries: 10 });

      // Simulate 25 unique nonces — without cap, size would grow to 25
      for (let i = 0; i < 25; i++) {
        cache.check(`dos-${i}`);
      }

      // After auto-rotations, size is bounded (at most maxEntries * 2)
      expect(cache.size()).toBeLessThanOrEqual(20); // 2 buffers × 10
    });
  });

  describe('auto-rotation on time threshold', () => {
    it('auto-rotates after rotationIntervalMs', () => {
      // Use a very short interval for testing
      const cache = new NonceCache({ rotationIntervalMs: 1 });

      cache.check('before-rotation');

      // Wait just over the threshold
      const start = Date.now();
      while (Date.now() - start < 5) {
        /* busy wait 5ms */
      }

      // Next check should trigger time-based rotation
      cache.check('after-rotation');

      // 'before-rotation' is now in previous buffer — still rejected
      expect(cache.check('before-rotation')).toBe(false);
    });
  });

  describe('constructor options', () => {
    it('accepts custom maxEntries', () => {
      const cache = new NonceCache({ maxEntries: 50 });
      expect(cache).toBeDefined();
    });

    it('accepts custom rotationIntervalMs', () => {
      const cache = new NonceCache({ rotationIntervalMs: 60_000 });
      expect(cache).toBeDefined();
    });

    it('uses defaults when no options provided', () => {
      const cache = new NonceCache();
      expect(cache).toBeDefined();
    });
  });

  // ------------------------------------------------------------------
  // Cross-language verification against Go fixtures
  // ------------------------------------------------------------------

  const fixture = 'auth/nonce_replay.json';
  const suite = hasFixture(fixture) ? describe : describe.skip;
  suite('cross-language: nonce replay (Go fixtures)', () => {
    const vectors = loadVectors<{ nonce: string; seen_before: string }, { accepted: boolean }>(
      fixture,
    );

    it('fresh → accepted, replay → rejected, different → accepted', () => {
      const cache = new NonceCache();

      for (const v of vectors) {
        if (v.inputs.seen_before === 'true') {
          // Simulate "seen before" by checking the same nonce first
          cache.check(v.inputs.nonce);
        }
        const result = cache.check(v.inputs.nonce);
        expect(result).toBe(v.expected.accepted);
      }
    });
  });
});
