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
import { VALID_VAULT_ITEM_TYPES } from '../../src/vault/validation';
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

    it('coordination + trust.vouch.request map to "message"', () => {
      // Free-form chat-style D2D payloads land in the vault under the
      // generic "message" type so they pass `validateVaultItem`. Without
      // this mapping the staged row gets dropped at the drain because
      // "coordination.request" isn't in VALID_VAULT_ITEM_TYPES.
      expect(mapToVaultItemType('coordination.request')).toBe('message');
      expect(mapToVaultItemType('coordination.response')).toBe('message');
      expect(mapToVaultItemType('trust.vouch.request')).toBe('message');
    });

    it('safety.alert maps to the generic "message" vault type', () => {
      // Caught by the contract test below: safety.alert is storable but
      // has no dedicated vault item type. Pin to 'message' so the drain
      // can persist it. The original D2D type is preserved in staging
      // metadata for audit / classification.
      expect(mapToVaultItemType('safety.alert')).toBe('message');
    });
  });

  /**
   * Contract: every storable D2D type lands in a valid vault item type.
   *
   * This catches Bug #1 ("D2D-to-reminder pipeline silently halted at
   * drain because coordination.request isn't in VALID_VAULT_ITEM_TYPES")
   * for the WHOLE class of failure rather than the one type we knew
   * about. Add a new V1 message type without registering its vault
   * mapping → this test fails immediately, not in a simulator weeks
   * later.
   *
   * Why a contract test: scenario tests cover the cases the engineer
   * happened to think of. Bug #1 lived in the gap between two parallel
   * data structures (`V1_TYPES` and `VAULT_TYPE_MAP`); no scenario test
   * was going to find it. Iterating the enum is cheap and exhaustive.
   */
  describe('contract: V1 storable types ⊆ VALID_VAULT_ITEM_TYPES', () => {
    const ephemeral = new Set<string>(D2D_EPHEMERAL_MESSAGE_TYPES);
    const storable = D2D_V1_MESSAGE_TYPES.filter((t) => !ephemeral.has(t));

    for (const msgType of storable) {
      it(`mapToVaultItemType("${msgType}") returns a vault-valid type`, () => {
        const vaultType = mapToVaultItemType(msgType);
        expect(vaultType).not.toBeNull();
        expect(VALID_VAULT_ITEM_TYPES.has(vaultType!)).toBe(true);
      });
    }

    it('shouldStore() and mapToVaultItemType() agree about which types persist', () => {
      // Drift detector: if a type says shouldStore=true but the vault
      // mapping returns null (or vice versa) the drain will either
      // claim-then-fail or silently drop messages. Lock them together.
      for (const msgType of D2D_V1_MESSAGE_TYPES) {
        const stores = shouldStore(msgType);
        const vaultType = mapToVaultItemType(msgType);
        expect(vaultType !== null).toBe(stores);
      }
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
