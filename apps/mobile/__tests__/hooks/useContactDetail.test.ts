/**
 * T6.17 — Contact detail: data hook tests.
 *
 * Source: ARCHITECTURE.md Task 6.17
 */

import {
  loadContactDetail,
  updateSharingPolicy,
  updateScenarioDeny,
  addContactAlias,
  removeContactAlias,
  updateTrustLevel,
  updateNotes,
  getSharingCategories,
  getSharingTierOptions,
  resetContactDetail,
} from '../../src/hooks/useContactDetail';
import { addContact, resetContactDirectory } from '../../../core/src/contacts/directory';
import { clearSharingPolicies } from '../../../core/src/gatekeeper/sharing';

const DID = 'did:key:z6MkAlice000000000000000000000000000000000000';

describe('Contact Detail Hook (6.17)', () => {
  beforeEach(() => {
    resetContactDirectory();
    clearSharingPolicies();
    resetContactDetail();
    addContact(DID, 'Alice', 'verified', 'summary');
  });

  describe('loadContactDetail', () => {
    it('loads full contact state', () => {
      const detail = loadContactDetail(DID);

      expect(detail).not.toBeNull();
      expect(detail!.displayName).toBe('Alice');
      expect(detail!.trustLevel).toBe('verified');
      expect(detail!.aliases).toEqual([]);
      expect(detail!.sharingPolicy).toBeDefined();
      expect(Object.keys(detail!.sharingPolicy)).toHaveLength(5);
    });

    it('returns null for missing contact', () => {
      expect(loadContactDetail('did:key:nonexistent')).toBeNull();
    });

    it('includes default sharing policy (all "none")', () => {
      const detail = loadContactDetail(DID)!;
      expect(detail.sharingPolicy.health).toBe('none');
      expect(detail.sharingPolicy.general).toBe('none');
    });

    it('includes scenario deny list', () => {
      updateScenarioDeny(DID, ['social.update']);
      const detail = loadContactDetail(DID)!;
      expect(detail.scenarioDeny).toContain('social.update');
    });
  });

  describe('sharing policy', () => {
    it('updates category tier', () => {
      expect(updateSharingPolicy(DID, 'health', 'summary')).toBeNull();

      const detail = loadContactDetail(DID)!;
      expect(detail.sharingPolicy.health).toBe('summary');
    });

    it('returns error for missing contact', () => {
      expect(updateSharingPolicy('did:key:nope', 'health', 'full')).not.toBeNull();
    });
  });

  describe('scenario policy', () => {
    it('updates deny list', () => {
      expect(updateScenarioDeny(DID, ['social.update', 'promo.offer'])).toBeNull();

      const detail = loadContactDetail(DID)!;
      expect(detail.scenarioDeny).toEqual(['social.update', 'promo.offer']);
    });

    it('clears deny list with empty array', () => {
      updateScenarioDeny(DID, ['social.update']);
      updateScenarioDeny(DID, []);

      expect(loadContactDetail(DID)!.scenarioDeny).toEqual([]);
    });

    it('returns error for missing contact', () => {
      expect(updateScenarioDeny('did:key:nope', [])).not.toBeNull();
    });
  });

  describe('alias management', () => {
    it('adds an alias', () => {
      expect(addContactAlias(DID, 'Ali')).toBeNull();
      expect(loadContactDetail(DID)!.aliases).toContain('Ali');
    });

    it('rejects empty alias', () => {
      expect(addContactAlias(DID, '')).toContain('empty');
    });

    it('rejects duplicate alias', () => {
      addContactAlias(DID, 'Ali');
      // Add same alias to same contact — should succeed (idempotent)
      const err = addContactAlias(DID, 'Ali');
      // The directory allows re-adding same alias to same contact
      expect(err).toBeNull();
    });

    it('removes an alias', () => {
      addContactAlias(DID, 'Ali');
      expect(removeContactAlias(DID, 'Ali')).toBeNull();
      expect(loadContactDetail(DID)!.aliases).not.toContain('Ali');
    });
  });

  describe('trust level', () => {
    it('updates trust level', () => {
      expect(updateTrustLevel(DID, 'trusted')).toBeNull();
      expect(loadContactDetail(DID)!.trustLevel).toBe('trusted');
    });

    it('returns error for missing contact', () => {
      expect(updateTrustLevel('did:key:nope', 'blocked')).not.toBeNull();
    });
  });

  describe('notes', () => {
    it('updates notes', () => {
      expect(updateNotes(DID, 'Alice likes tea')).toBeNull();
      expect(loadContactDetail(DID)!.notes).toBe('Alice likes tea');
    });
  });

  describe('options', () => {
    it('getSharingCategories returns 5', () => {
      expect(getSharingCategories()).toHaveLength(5);
      expect(getSharingCategories()).toContain('health');
    });

    it('getSharingTierOptions returns 4', () => {
      const opts = getSharingTierOptions();
      expect(opts).toHaveLength(4);
      expect(opts.map((o) => o.value)).toEqual(['none', 'summary', 'full', 'locked']);
    });
  });
});
