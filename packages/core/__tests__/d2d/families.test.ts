/**
 * T1D.2 — D2D V1 message families: type validation and vault mapping.
 *
 * Category A: fixture-based. Verifies all 7 V1 message types are recognized,
 * storage mapping is correct, and invalid types rejected.
 *
 * Source: core/test/d2d_v1_domain_test.go
 */

import {
  isValidV1Type,
  mapToVaultItemType,
  shouldStore,
  alwaysPasses,
} from '../../src/d2d/families';
import {
  D2D_V1_MESSAGE_TYPES,
  D2D_MEMORY_TYPE_MAP,
  D2D_EPHEMERAL_MESSAGE_TYPES,
} from '@dina/test-harness';

const EPHEMERAL = new Set<string>(D2D_EPHEMERAL_MESSAGE_TYPES);

describe('D2D V1 Message Families', () => {
  describe('isValidV1Type', () => {
    for (const msgType of D2D_V1_MESSAGE_TYPES) {
      it(`accepts "${msgType}"`, () => {
        expect(isValidV1Type(msgType)).toBe(true);
      });
    }

    it('rejects unknown type', () => {
      expect(isValidV1Type('unknown.type')).toBe(false);
    });

    it('rejects empty string', () => {
      expect(isValidV1Type('')).toBe(false);
    });

    it('rejects v0 type format', () => {
      expect(isValidV1Type('dina/social/arrival')).toBe(false);
    });
  });

  describe('mapToVaultItemType', () => {
    it('maps social.update → relationship_note', () => {
      expect(mapToVaultItemType('social.update')).toBe('relationship_note');
    });

    it('maps trust.vouch.response → trust_attestation', () => {
      expect(mapToVaultItemType('trust.vouch.response')).toBe('trust_attestation');
    });

    it('returns null for presence.signal (never stored)', () => {
      expect(mapToVaultItemType('presence.signal')).toBeNull();
    });

    it('returns null for service.query (ephemeral)', () => {
      expect(mapToVaultItemType('service.query')).toBeNull();
    });

    it('returns null for service.response (ephemeral)', () => {
      expect(mapToVaultItemType('service.response')).toBeNull();
    });

    // Verify all documented mappings from test harness
    for (const [msgType, vaultType] of Object.entries(D2D_MEMORY_TYPE_MAP)) {
      it(`maps ${msgType} → ${vaultType}`, () => {
        expect(mapToVaultItemType(msgType)).toBe(vaultType);
      });
    }

    it('unmapped types return the original type', () => {
      expect(mapToVaultItemType('coordination.request')).toBe('coordination.request');
      expect(mapToVaultItemType('safety.alert')).toBe('safety.alert');
    });
  });

  describe('shouldStore', () => {
    for (const msgType of D2D_EPHEMERAL_MESSAGE_TYPES) {
      it(`returns false for ephemeral "${msgType}"`, () => {
        expect(shouldStore(msgType)).toBe(false);
      });
    }

    const storedTypes = D2D_V1_MESSAGE_TYPES.filter((t) => !EPHEMERAL.has(t));
    for (const msgType of storedTypes) {
      it(`returns true for "${msgType}"`, () => {
        expect(shouldStore(msgType)).toBe(true);
      });
    }
  });

  describe('alwaysPasses', () => {
    it('returns true for safety.alert', () => {
      expect(alwaysPasses('safety.alert')).toBe(true);
    });

    const blockableTypes = D2D_V1_MESSAGE_TYPES.filter((t) => t !== 'safety.alert');
    for (const msgType of blockableTypes) {
      it(`returns false for "${msgType}"`, () => {
        expect(alwaysPasses(msgType)).toBe(false);
      });
    }
  });
});
