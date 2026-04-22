/**
 * T2C.1 — CLI session: PII entity save/load, rehydration.
 *
 * Source: cli/tests/test_session.py
 */

import {
  newSessionId,
  saveSession,
  loadSession,
  rehydrateFromSession,
  clearSessions,
} from '../../src/cli/session';

describe('CLI Session Management', () => {
  beforeEach(() => clearSessions());

  describe('newSessionId', () => {
    it('format is "pii_" + 8 hex chars', () => {
      const id = newSessionId();
      expect(id).toMatch(/^pii_[0-9a-f]{8}$/);
    });

    it('different calls produce different IDs', () => {
      const ids = new Set(Array.from({ length: 10 }, () => newSessionId()));
      expect(ids.size).toBeGreaterThanOrEqual(9);
    });
  });

  describe('saveSession + loadSession', () => {
    it('round-trips PII entities', () => {
      saveSession('pii_abc12345', {
        entities: [{ token: '[EMAIL_1]', type: 'EMAIL', value: 'john@example.com' }],
      });
      const loaded = loadSession('pii_abc12345');
      expect(loaded.entities.length).toBe(1);
      expect(loaded.entities[0].value).toBe('john@example.com');
    });

    it('accepts Python-style lowercase keys', () => {
      saveSession('pii_test1234', {
        entities: [{ token: '[PHONE_1]', type: 'phone', value: '555-1234' }],
      });
      const loaded = loadSession('pii_test1234');
      expect(loaded.entities[0].type).toBe('PHONE'); // normalized to uppercase
    });

    it('load missing session throws', () => {
      expect(() => loadSession('pii_nonexistent')).toThrow('not found');
    });

    it('multiple entities round-trip', () => {
      saveSession('pii_multi123', {
        entities: [
          { token: '[EMAIL_1]', type: 'EMAIL', value: 'a@b.com' },
          { token: '[PHONE_1]', type: 'PHONE', value: '555-0000' },
        ],
      });
      expect(loadSession('pii_multi123').entities.length).toBe(2);
    });
  });

  describe('rehydrateFromSession', () => {
    it('replaces tokens with actual PII values', () => {
      saveSession('pii_rehydrate', {
        entities: [{ token: '[EMAIL_1]', type: 'EMAIL', value: 'john@example.com' }],
      });
      const result = rehydrateFromSession('Contact [EMAIL_1]', 'pii_rehydrate');
      expect(result).toBe('Contact john@example.com');
    });

    it('handles multiple tokens', () => {
      saveSession('pii_multi', {
        entities: [
          { token: '[EMAIL_1]', type: 'EMAIL', value: 'a@b.com' },
          { token: '[PHONE_1]', type: 'PHONE', value: '555-1234' },
        ],
      });
      const result = rehydrateFromSession('[EMAIL_1] and [PHONE_1]', 'pii_multi');
      expect(result).toBe('a@b.com and 555-1234');
    });

    it('throws for missing session', () => {
      expect(() => rehydrateFromSession('text', 'pii_missing')).toThrow('not found');
    });
  });
});
