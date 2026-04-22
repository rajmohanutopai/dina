/**
 * T1F.4 — Sharing tier enforcement: per-contact data category access.
 *
 * Source: core/test/gatekeeper_test.go (sharing tiers section)
 */

import {
  checkSharingPolicy,
  getSharingTier,
  filterByTier,
  setSharingPolicy,
  setBulkPolicy,
  clearSharingPolicies,
  validateSharingTier,
  buildTieredPayload,
  selectPayloadTier,
} from '../../src/gatekeeper/sharing';
import type { SharingTier } from '../../src/gatekeeper/sharing';
import { PHASE1_RECOGNIZED_CATEGORIES } from '@dina/test-harness';

describe('Sharing Tier Enforcement', () => {
  const friendDID = 'did:plc:closeFriend';
  const collegeDID = 'did:plc:workColleague';

  beforeEach(() => {
    clearSharingPolicies();
    setSharingPolicy(friendDID, 'presence', 'full');
    setSharingPolicy(friendDID, 'availability', 'full');
    setSharingPolicy(friendDID, 'context', 'summary');
    setSharingPolicy(friendDID, 'preferences', 'full');
    setSharingPolicy(friendDID, 'location', 'none');
    setSharingPolicy(friendDID, 'health', 'none');
    setSharingPolicy(collegeDID, 'presence', 'summary');
    setSharingPolicy(collegeDID, 'health', 'none');
    setSharingPolicy(collegeDID, 'location', 'none');
  });

  describe('getSharingTier', () => {
    it('returns tier for known contact + category', () => {
      expect(getSharingTier(friendDID, 'presence')).toBe('full');
    });

    it('returns "none" for unknown contact (default-deny)', () => {
      expect(getSharingTier('did:plc:stranger', 'health')).toBe('none');
    });

    it('returns "none" for unknown category', () => {
      expect(getSharingTier(friendDID, 'invented_category')).toBe('none');
    });

    for (const category of PHASE1_RECOGNIZED_CATEGORIES) {
      it(`recognizes category: "${category}"`, () => {
        // Either has an explicit policy or defaults to 'none'
        const tier = getSharingTier(friendDID, category);
        expect([
          'none',
          'summary',
          'full',
          'locked',
          'eta_only',
          'free_busy',
          'exact_location',
        ]).toContain(tier);
      });
    }
  });

  describe('checkSharingPolicy', () => {
    it('allows when all categories are permitted', () => {
      const result = checkSharingPolicy(friendDID, ['presence']);
      expect(result.allowed).toBe(true);
    });

    it('denies when ANY category is restricted', () => {
      const result = checkSharingPolicy(friendDID, ['presence', 'health']);
      expect(result.allowed).toBe(false);
      expect(result.filteredCategories).toContain('health');
    });

    it('allows empty category list', () => {
      const result = checkSharingPolicy(friendDID, []);
      expect(result.allowed).toBe(true);
    });

    it('denies all categories for unknown contact', () => {
      const result = checkSharingPolicy('did:plc:stranger', ['presence']);
      expect(result.allowed).toBe(false);
    });

    it('returns filtered category list in decision', () => {
      const result = checkSharingPolicy(collegeDID, ['presence', 'health', 'location']);
      expect(result.filteredCategories).toContain('health');
      expect(result.filteredCategories).toContain('location');
    });
  });

  describe('filterByTier', () => {
    const fullData = {
      summary: 'Test',
      body: 'Full body text',
      content_l0: 'L0',
      content_l1: 'L1',
    };

    it('full → keeps everything', () => {
      const result = filterByTier(fullData, 'full');
      expect(result).not.toBeNull();
      expect(result!.body).toBe('Full body text');
      expect(result!.summary).toBe('Test');
    });

    it('summary → keeps L0/L1, removes body', () => {
      const result = filterByTier(fullData, 'summary');
      expect(result).not.toBeNull();
      expect(result!.summary).toBe('Test');
      expect(result!.content_l0).toBe('L0');
      expect(result).not.toHaveProperty('body');
    });

    it('none → removes entirely (returns null)', () => {
      expect(filterByTier(fullData, 'none')).toBeNull();
    });

    it('locked → removes entirely (returns null)', () => {
      expect(filterByTier(fullData, 'locked')).toBeNull();
    });

    it('eta_only → keeps only ETA fields', () => {
      const locationData = {
        id: 'v1',
        type: 'location',
        eta: '5 mins',
        body: 'secret',
        lat: 40.7,
        lng: -74.0,
      };
      const result = filterByTier(locationData, 'eta_only');
      expect(result).not.toBeNull();
      expect(result!.eta).toBe('5 mins');
      expect(result!.id).toBe('v1');
      expect(result).not.toHaveProperty('body');
      expect(result).not.toHaveProperty('lat');
    });

    it('free_busy → keeps only status fields', () => {
      const calendarData = {
        id: 'e1',
        type: 'event',
        status: 'busy',
        start_time: 1000,
        body: 'private meeting',
      };
      const result = filterByTier(calendarData, 'free_busy');
      expect(result).not.toBeNull();
      expect(result!.status).toBe('busy');
      expect(result!.start_time).toBe(1000);
      expect(result).not.toHaveProperty('body');
    });

    it('exact_location → keeps everything', () => {
      const locationData = {
        id: 'v1',
        type: 'location',
        lat: 40.7,
        lng: -74.0,
        body: 'meeting point',
      };
      const result = filterByTier(locationData, 'exact_location');
      expect(result).not.toBeNull();
      expect(result!.lat).toBe(40.7);
      expect(result!.body).toBe('meeting point');
    });
  });

  describe('tier validation', () => {
    it('accepts all valid tiers', () => {
      const valid: SharingTier[] = [
        'none',
        'summary',
        'full',
        'locked',
        'eta_only',
        'free_busy',
        'exact_location',
      ];
      for (const tier of valid) {
        expect(validateSharingTier(tier)).toBeNull();
      }
    });

    it('rejects invalid tier', () => {
      expect(validateSharingTier('unlimited')).toContain('invalid');
    });

    it('setSharingPolicy rejects invalid tier', () => {
      expect(() => setSharingPolicy('did:x', 'health', 'bogus' as SharingTier)).toThrow(
        'invalid tier',
      );
    });

    it('setSharingPolicy accepts new tiers', () => {
      expect(() => setSharingPolicy(friendDID, 'location', 'eta_only')).not.toThrow();
      expect(getSharingTier(friendDID, 'location')).toBe('eta_only');
    });
  });

  describe('TieredPayload', () => {
    const itemData = {
      id: 'v1',
      type: 'email',
      summary: 'Test email',
      body: 'Full email body text',
      content_l0: 'L0 headline',
    };

    it('buildTieredPayload creates full + summary pair', () => {
      const payload = buildTieredPayload(itemData);
      expect(payload.full.body).toBe('Full email body text');
      expect(payload.summary.body).toBeUndefined();
      expect(payload.summary.summary).toBe('Test email');
      expect(payload.summary.content_l0).toBe('L0 headline');
    });

    it('selectPayloadTier: full → returns full data', () => {
      const payload = buildTieredPayload(itemData);
      const result = selectPayloadTier(payload, 'full');
      expect(result).not.toBeNull();
      expect(result!.body).toBe('Full email body text');
    });

    it('selectPayloadTier: summary → returns body-stripped data', () => {
      const payload = buildTieredPayload(itemData);
      const result = selectPayloadTier(payload, 'summary');
      expect(result).not.toBeNull();
      expect(result!.summary).toBe('Test email');
      expect(result).not.toHaveProperty('body');
    });

    it('selectPayloadTier: none → returns null', () => {
      const payload = buildTieredPayload(itemData);
      expect(selectPayloadTier(payload, 'none')).toBeNull();
    });

    it('selectPayloadTier: locked → returns null', () => {
      const payload = buildTieredPayload(itemData);
      expect(selectPayloadTier(payload, 'locked')).toBeNull();
    });

    it('full payload is a copy (no mutation risk)', () => {
      const payload = buildTieredPayload(itemData);
      payload.full.body = 'modified';
      expect(itemData.body).toBe('Full email body text'); // original unchanged
    });
  });

  describe('setBulkPolicy', () => {
    it('updates category tier for all contacts', () => {
      const count = setBulkPolicy('health', 'locked');
      // friendDID and collegeDID have policies from beforeEach
      expect(count).toBe(2);
      expect(getSharingTier(friendDID, 'health')).toBe('locked');
      expect(getSharingTier(collegeDID, 'health')).toBe('locked');
    });

    it('adds category to contacts that did not have it', () => {
      setBulkPolicy('new_category', 'summary');
      expect(getSharingTier(friendDID, 'new_category')).toBe('summary');
      expect(getSharingTier(collegeDID, 'new_category')).toBe('summary');
    });

    it('returns 0 when no contacts have policies', () => {
      clearSharingPolicies();
      expect(setBulkPolicy('health', 'none')).toBe(0);
    });

    it('rejects invalid tier', () => {
      expect(() => setBulkPolicy('health', 'bogus' as any)).toThrow('invalid tier');
    });
  });
});
