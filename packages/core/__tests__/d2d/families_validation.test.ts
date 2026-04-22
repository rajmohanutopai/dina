/**
 * D2D message type validation tests — scenario mapping + body size.
 */

import {
  isValidV1Type,
  mapToVaultItemType,
  shouldStore,
  alwaysPasses,
  msgTypeToScenario,
  validateMessageBody,
  MAX_MESSAGE_BODY_SIZE,
} from '../../src/d2d/families';

describe('D2D Message Families', () => {
  describe('V1 type validation', () => {
    it('accepts all 9 V1 types', () => {
      const v1Types = [
        'presence.signal',
        'coordination.request',
        'coordination.response',
        'social.update',
        'safety.alert',
        'trust.vouch.request',
        'trust.vouch.response',
        'service.query',
        'service.response',
      ];
      for (const t of v1Types) {
        expect(isValidV1Type(t)).toBe(true);
      }
    });

    it('rejects non-V1 types', () => {
      expect(isValidV1Type('dina/query')).toBe(false);
      expect(isValidV1Type('unknown.type')).toBe(false);
      expect(isValidV1Type('')).toBe(false);
    });
  });

  describe('msgTypeToScenario', () => {
    it('maps presence.signal → presence', () => {
      expect(msgTypeToScenario('presence.signal')).toBe('presence');
    });

    it('maps coordination.request → coordination', () => {
      expect(msgTypeToScenario('coordination.request')).toBe('coordination');
    });

    it('maps coordination.response → coordination', () => {
      expect(msgTypeToScenario('coordination.response')).toBe('coordination');
    });

    it('maps social.update → social', () => {
      expect(msgTypeToScenario('social.update')).toBe('social');
    });

    it('maps safety.alert → safety', () => {
      expect(msgTypeToScenario('safety.alert')).toBe('safety');
    });

    it('maps trust.vouch.request → trust', () => {
      expect(msgTypeToScenario('trust.vouch.request')).toBe('trust');
    });

    it('maps trust.vouch.response → trust', () => {
      expect(msgTypeToScenario('trust.vouch.response')).toBe('trust');
    });

    it('maps service.query → service', () => {
      expect(msgTypeToScenario('service.query')).toBe('service');
    });

    it('maps service.response → service', () => {
      expect(msgTypeToScenario('service.response')).toBe('service');
    });

    it('returns empty string for unknown types', () => {
      expect(msgTypeToScenario('unknown.type')).toBe('');
      expect(msgTypeToScenario('')).toBe('');
    });
  });

  describe('validateMessageBody', () => {
    it('accepts body within size limit', () => {
      expect(validateMessageBody('hello world')).toBeNull();
    });

    it('accepts body at exactly max size', () => {
      const body = 'x'.repeat(MAX_MESSAGE_BODY_SIZE);
      expect(validateMessageBody(body)).toBeNull();
    });

    it('rejects body exceeding max size', () => {
      const body = 'x'.repeat(MAX_MESSAGE_BODY_SIZE + 1);
      const err = validateMessageBody(body);
      expect(err).toContain('exceeds maximum size');
    });

    it('accepts Uint8Array within limit', () => {
      expect(validateMessageBody(new Uint8Array(100))).toBeNull();
    });

    it('rejects Uint8Array exceeding limit', () => {
      const err = validateMessageBody(new Uint8Array(MAX_MESSAGE_BODY_SIZE + 1));
      expect(err).toContain('exceeds maximum size');
    });

    it('MAX_MESSAGE_BODY_SIZE is 256 KB', () => {
      expect(MAX_MESSAGE_BODY_SIZE).toBe(256 * 1024);
    });
  });

  describe('vault type mapping', () => {
    it('maps social.update → relationship_note', () => {
      expect(mapToVaultItemType('social.update')).toBe('relationship_note');
    });

    it('maps trust.vouch.response → trust_attestation', () => {
      expect(mapToVaultItemType('trust.vouch.response')).toBe('trust_attestation');
    });

    it('returns null for ephemeral types', () => {
      expect(mapToVaultItemType('presence.signal')).toBeNull();
    });

    it('returns original type for unmapped stored types', () => {
      expect(mapToVaultItemType('coordination.request')).toBe('coordination.request');
    });
  });

  describe('safety.alert always passes', () => {
    it('safety.alert cannot be blocked', () => {
      expect(alwaysPasses('safety.alert')).toBe(true);
    });

    it('other types can be blocked', () => {
      expect(alwaysPasses('social.update')).toBe(false);
      expect(alwaysPasses('presence.signal')).toBe(false);
    });
  });
});
