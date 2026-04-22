/**
 * T1J.4 — Vault item type → tier classification.
 *
 * Category A: fixture-based. Verifies partition is correct,
 * exhaustive, and disjoint.
 *
 * Source: brain/tests/test_tier_classifier.py
 */

import {
  classifyTier,
  getTier1Types,
  getTier2Types,
  areTiersDisjoint,
} from '../../src/trust/tier_classifier';
import { VAULT_ITEM_TYPES } from '@dina/test-harness';

describe('Vault Item Tier Classifier', () => {
  describe('classifyTier', () => {
    it('classifies note as Tier 1', () => {
      expect(classifyTier('note')).toBe(1);
    });

    it('classifies event as Tier 1', () => {
      expect(classifyTier('event')).toBe(1);
    });

    it('classifies contact_card as Tier 1', () => {
      expect(classifyTier('contact_card')).toBe(1);
    });

    it('classifies purchase_decision as Tier 1', () => {
      expect(classifyTier('purchase_decision')).toBe(1);
    });

    it('classifies email as Tier 2', () => {
      expect(classifyTier('email')).toBe(2);
    });

    it('classifies message as Tier 2', () => {
      expect(classifyTier('message')).toBe(2);
    });

    it('classifies bookmark as Tier 2', () => {
      expect(classifyTier('bookmark')).toBe(2);
    });

    it('unknown type defaults to Tier 2', () => {
      expect(classifyTier('invented_type')).toBe(2);
    });

    it('empty type defaults to Tier 2', () => {
      expect(classifyTier('')).toBe(2);
    });
  });

  describe('getTier1Types', () => {
    it('returns non-empty list of Tier 1 types', () => {
      const types = getTier1Types();
      expect(types.length).toBeGreaterThan(0);
    });

    it('includes note', () => {
      expect(getTier1Types()).toContain('note');
    });

    it('includes health-related types', () => {
      const types = getTier1Types();
      expect(types).toContain('medical_record');
      expect(types).toContain('health_context');
    });
  });

  describe('getTier2Types', () => {
    it('returns non-empty list of Tier 2 types', () => {
      const types = getTier2Types();
      expect(types.length).toBeGreaterThan(0);
    });

    it('includes email', () => {
      expect(getTier2Types()).toContain('email');
    });
  });

  describe('areTiersDisjoint', () => {
    it('Tier 1 and Tier 2 have no overlap', () => {
      expect(areTiersDisjoint()).toBe(true);
    });
  });

  describe('exhaustiveness', () => {
    it('all known vault item types are classified to 1 or 2', () => {
      for (const type of VAULT_ITEM_TYPES) {
        const tier = classifyTier(type);
        expect(tier === 1 || tier === 2).toBe(true);
      }
    });

    it('all VAULT_ITEM_TYPES appear in either Tier 1 or Tier 2 sets', () => {
      const allKnown = new Set([...getTier1Types(), ...getTier2Types()]);
      for (const type of VAULT_ITEM_TYPES) {
        expect(allKnown.has(type)).toBe(true);
      }
    });
  });
});
