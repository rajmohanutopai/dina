/**
 * T1H.2 — Source trust classification.
 *
 * Source: core/test/source_trust_test.go
 */

import {
  classifySourceTrust,
  isSelfSender,
  isContactRing1,
  isMarketingSender,
  addKnownContact,
  clearKnownContacts,
} from '../../src/trust/source_trust';

describe('Source Trust Classification', () => {
  beforeEach(() => {
    clearKnownContacts();
    addKnownContact('did:plc:knownFriend');
    addKnownContact('alice@example.com');
  });

  describe('classifySourceTrust', () => {
    it('user content via CLI → self, high, normal', () => {
      const result = classifySourceTrust('user', 'cli', 'cli');
      expect(result.sender_trust).toBe('self');
      expect(result.confidence).toBe('high');
      expect(result.retrieval_policy).toBe('normal');
    });

    it('user content via chat → self, high, normal', () => {
      const result = classifySourceTrust('user', 'personal', 'chat');
      expect(result.sender_trust).toBe('self');
    });

    it('known contact email → contact_ring1, medium, normal', () => {
      const result = classifySourceTrust('alice@example.com', 'gmail', 'connector');
      expect(result.sender_trust).toBe('contact_ring1');
      expect(result.confidence).toBe('medium');
      expect(result.retrieval_policy).toBe('normal');
    });

    it('unknown sender → unknown, low, caveated', () => {
      const result = classifySourceTrust('stranger@unknown.com', 'gmail', 'connector');
      expect(result.sender_trust).toBe('unknown');
      expect(result.confidence).toBe('low');
      expect(result.retrieval_policy).toBe('caveated');
    });

    it('marketing sender → marketing, low, briefing_only', () => {
      const result = classifySourceTrust('promo@newsletter.com', 'gmail', 'connector');
      expect(result.sender_trust).toBe('marketing');
      expect(result.retrieval_policy).toBe('briefing_only');
    });

    it('D2D from known contact → contact_ring1, high, normal', () => {
      const result = classifySourceTrust('did:plc:knownFriend', 'd2d', 'd2d');
      expect(result.sender_trust).toBe('contact_ring1');
      expect(result.confidence).toBe('high');
    });

    it('D2D from unknown DID → unknown, low, quarantine', () => {
      const result = classifySourceTrust('did:plc:stranger', 'd2d', 'd2d');
      expect(result.sender_trust).toBe('unknown');
      expect(result.retrieval_policy).toBe('quarantine');
    });

    it('telegram source is self', () => {
      const result = classifySourceTrust('user', 'telegram', 'chat');
      expect(result.sender_trust).toBe('self');
    });

    it('user_remember source is self even with empty sender', () => {
      // Mobile chat orchestrator's /remember handler stamps `source:
      // 'user_remember'` and ships no `sender` field. The classifier
      // must still recognise this as self-authored content so the L0
      // enrichment doesn't tag the user's own memories with
      // "(unverified sender)".
      const result = classifySourceTrust('', 'user_remember', '');
      expect(result.sender_trust).toBe('self');
      expect(result.confidence).toBe('high');
      expect(result.retrieval_policy).toBe('normal');
    });
  });

  describe('isSelfSender', () => {
    it('"user" sender → true', () => {
      expect(isSelfSender('user', 'personal')).toBe(true);
    });

    it('CLI source → true', () => {
      expect(isSelfSender('user', 'cli')).toBe(true);
    });

    it('user_remember source → true (mobile /remember turn)', () => {
      expect(isSelfSender('', 'user_remember')).toBe(true);
    });

    it('external email → false', () => {
      expect(isSelfSender('alice@example.com', 'gmail')).toBe(false);
    });
  });

  describe('isContactRing1', () => {
    it('known contact DID → true', () => {
      expect(isContactRing1('did:plc:knownFriend')).toBe(true);
    });

    it('unknown DID → false', () => {
      expect(isContactRing1('did:plc:stranger')).toBe(false);
    });
  });

  describe('isMarketingSender', () => {
    it('noreply sender → true', () => {
      expect(isMarketingSender('noreply@company.com')).toBe(true);
    });

    it('newsletter sender → true', () => {
      expect(isMarketingSender('updates@newsletter.io')).toBe(true);
    });

    it('personal email → false', () => {
      expect(isMarketingSender('alice@example.com')).toBe(false);
    });

    it('empty sender → false', () => {
      expect(isMarketingSender('')).toBe(false);
    });
  });
});
