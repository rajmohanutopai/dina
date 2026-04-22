/**
 * T1F.3 — Brain-denied actions: hardcoded deny list.
 *
 * Category A: fixture-based. These 5 actions can NEVER be performed by
 * automated reasoning — they require direct user interaction through the UI.
 *
 * The list is hardcoded and not configurable:
 *   did_sign, did_rotate, vault_backup, persona_unlock, seed_export
 *
 * Source: core/test/gatekeeper_test.go (brain-denied section)
 */

import { isBrainDenied } from '../../src/gatekeeper/intent';
import { BRAIN_DENIED_ACTIONS } from '@dina/test-harness';

describe('Brain-Denied Actions', () => {
  describe('isBrainDenied', () => {
    for (const action of BRAIN_DENIED_ACTIONS) {
      it(`denies: "${action}"`, () => {
        expect(isBrainDenied(action)).toBe(true);
      });
    }

    const allowedActions = ['search', 'query', 'remember', 'store', 'send_small', 'purchase'];
    for (const action of allowedActions) {
      it(`allows: "${action}"`, () => {
        expect(isBrainDenied(action)).toBe(false);
      });
    }

    it('empty action is not brain-denied', () => {
      expect(isBrainDenied('')).toBe(false);
    });

    it('unknown action is not brain-denied', () => {
      expect(isBrainDenied('some_random_action')).toBe(false);
    });
  });

  describe('brain-denied list is complete (5 actions)', () => {
    it('BRAIN_DENIED_ACTIONS has exactly 5 entries', () => {
      expect(BRAIN_DENIED_ACTIONS).toHaveLength(5);
    });

    it('includes did_sign', () => {
      expect(BRAIN_DENIED_ACTIONS).toContain('did_sign');
    });

    it('includes did_rotate', () => {
      expect(BRAIN_DENIED_ACTIONS).toContain('did_rotate');
    });

    it('includes vault_backup', () => {
      expect(BRAIN_DENIED_ACTIONS).toContain('vault_backup');
    });

    it('includes persona_unlock', () => {
      expect(BRAIN_DENIED_ACTIONS).toContain('persona_unlock');
    });

    it('includes seed_export', () => {
      expect(BRAIN_DENIED_ACTIONS).toContain('seed_export');
    });
  });
});
