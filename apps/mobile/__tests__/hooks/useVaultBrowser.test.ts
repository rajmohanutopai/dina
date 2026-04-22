/**
 * T9.12 — Vault browser: data hook tests.
 *
 * Source: ARCHITECTURE.md Task 9.12
 */

import {
  getPersonaList,
  searchVault,
  getItemDetail,
  getTieredContent,
  isPersonaBrowsable,
} from '../../src/hooks/useVaultBrowser';
import { createPersona, openPersona, resetPersonaState } from '../../../core/src/persona/service';
import { storeItem, clearVaults } from '../../../core/src/vault/crud';

describe('Vault Browser Hook (9.12)', () => {
  beforeEach(() => {
    resetPersonaState();
    clearVaults();
  });

  describe('getPersonaList', () => {
    it('returns empty when no personas', () => {
      expect(getPersonaList()).toHaveLength(0);
    });

    it('returns personas with tier and open state', () => {
      createPersona('general', 'default');
      createPersona('health', 'sensitive');
      openPersona('general', true);

      const list = getPersonaList();
      expect(list).toHaveLength(2);

      const general = list.find((p) => p.name === 'general');
      expect(general!.isOpen).toBe(true);
      expect(general!.tier).toBe('default');

      const health = list.find((p) => p.name === 'health');
      expect(health!.isOpen).toBe(false);
    });

    it('shows item count for open personas', () => {
      createPersona('general', 'default');
      openPersona('general', true);
      storeItem('general', { summary: 'Item 1', type: 'note' });
      storeItem('general', { summary: 'Item 2', type: 'note' });

      const list = getPersonaList();
      const general = list.find((p) => p.name === 'general');
      expect(general!.itemCount).toBe(2);
    });

    it('shows 0 items for closed personas', () => {
      createPersona('health', 'sensitive');
      const list = getPersonaList();
      expect(list.find((p) => p.name === 'health')!.itemCount).toBe(0);
    });
  });

  describe('searchVault', () => {
    beforeEach(() => {
      createPersona('general', 'default');
      openPersona('general', true);
      storeItem('general', {
        summary: 'Meeting with Alice about budget',
        type: 'note',
        content_l0: 'Budget meeting',
      });
      storeItem('general', { summary: 'Grocery list for weekend', type: 'note' });
    });

    it('returns matching items', () => {
      const results = searchVault('general', 'budget');
      expect(results).toHaveLength(1);
      expect(results[0].summary).toContain('budget');
      expect(results[0].persona).toBe('general');
    });

    it('returns empty for no match', () => {
      expect(searchVault('general', 'nonexistent')).toHaveLength(0);
    });

    it('returns empty for closed persona', () => {
      createPersona('health', 'sensitive');
      expect(searchVault('health', 'anything')).toHaveLength(0);
    });

    it('returns empty for empty query', () => {
      expect(searchVault('general', '')).toHaveLength(0);
      expect(searchVault('general', '   ')).toHaveLength(0);
    });

    it('respects limit', () => {
      for (let i = 0; i < 10; i++) {
        storeItem('general', { summary: `Item ${i} matching`, type: 'note' });
      }
      expect(searchVault('general', 'matching', 3)).toHaveLength(3);
    });

    it('includes contentL0 in results', () => {
      const results = searchVault('general', 'budget');
      expect(results[0].contentL0).toBeTruthy();
    });
  });

  describe('getItemDetail', () => {
    it('returns full item detail', () => {
      createPersona('general', 'default');
      openPersona('general', true);
      const id = storeItem('general', {
        summary: 'Test item',
        type: 'email',
        body: 'Full body content here',
        content_l0: 'L0 headline',
        content_l1: 'L1 paragraph summary',
        sender: 'alice@example.com',
        sender_trust: 'contact_ring1',
      });

      const detail = getItemDetail('general', id);

      expect(detail).not.toBeNull();
      expect(detail!.id).toBe(id);
      expect(detail!.type).toBe('email');
      expect(detail!.summary).toBe('Test item');
      expect(detail!.body).toBe('Full body content here');
      expect(detail!.contentL0).toBe('L0 headline');
      expect(detail!.contentL1).toBe('L1 paragraph summary');
      expect(detail!.sender).toBe('alice@example.com');
      expect(detail!.senderTrust).toBe('contact_ring1');
    });

    it('returns null for closed persona', () => {
      createPersona('health', 'sensitive');
      expect(getItemDetail('health', 'any-id')).toBeNull();
    });

    it('returns null for missing item', () => {
      createPersona('general', 'default');
      openPersona('general', true);
      expect(getItemDetail('general', 'nonexistent')).toBeNull();
    });
  });

  describe('getTieredContent', () => {
    it('returns L0, L1, L2 tiers', () => {
      createPersona('general', 'default');
      openPersona('general', true);
      const id = storeItem('general', {
        summary: 'Summary',
        content_l0: 'Headline',
        content_l1: 'Paragraph',
        body: 'Full body',
        type: 'note',
      });

      const tiers = getTieredContent('general', id);

      expect(tiers).not.toBeNull();
      expect(tiers!.l0).toBe('Headline');
      expect(tiers!.l1).toBe('Paragraph');
      expect(tiers!.l2).toBe('Full body');
      expect(tiers!.hasL1).toBe(true);
      expect(tiers!.hasL2).toBe(true);
    });

    it('falls back to summary when L0 empty', () => {
      createPersona('general', 'default');
      openPersona('general', true);
      const id = storeItem('general', {
        summary: 'My Summary',
        type: 'note',
      });

      const tiers = getTieredContent('general', id);
      expect(tiers!.l0).toBe('My Summary');
      expect(tiers!.hasL1).toBe(false);
      expect(tiers!.hasL2).toBe(false);
    });
  });

  describe('isPersonaBrowsable', () => {
    it('true when open', () => {
      createPersona('general', 'default');
      openPersona('general', true);
      expect(isPersonaBrowsable('general')).toBe(true);
    });

    it('false when closed', () => {
      createPersona('health', 'sensitive');
      expect(isPersonaBrowsable('health')).toBe(false);
    });
  });
});
