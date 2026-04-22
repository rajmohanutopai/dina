/**
 * T1J.3 — Trust scorer: sender identity → trust metadata.
 *
 * Category A: fixture-based. Verifies scoring rules match server for
 * self, contact, service, unknown, marketing senders.
 * Also tests ingress channel dispatch (connector anti-spoofing, D2D).
 *
 * Source: brain/tests/test_trust_scorer.py
 */

import { scoreSender, matchSenderToContact, matchByAlias } from '../../src/trust/scorer';

describe('Trust Scorer', () => {
  const contacts = [
    { name: 'Alice', email: 'alice@example.com', aliases: ['Ali'] },
    { name: 'Bob', email: 'bob@work.com' },
  ];

  describe('scoreSender — normal pipeline', () => {
    it('user content → self, high, normal', () => {
      const score = scoreSender('user', 'personal', 'chat', contacts);
      expect(score.sender_trust).toBe('self');
      expect(score.confidence).toBe('high');
      expect(score.retrieval_policy).toBe('normal');
      expect(score.source_type).toBe('self');
    });

    it('CLI source → self', () => {
      const score = scoreSender('user', 'cli', 'cli', contacts);
      expect(score.sender_trust).toBe('self');
    });

    it('telegram source → self', () => {
      const score = scoreSender('user', 'telegram', 'chat', contacts);
      expect(score.sender_trust).toBe('self');
    });

    it('admin source → self (matching Go self-source strings)', () => {
      const score = scoreSender('admin', 'admin', 'cli', contacts);
      expect(score.sender_trust).toBe('self');
      expect(score.source_type).toBe('self');
    });

    it('dina-cli source → self', () => {
      const score = scoreSender('user', 'dina-cli', 'cli', contacts);
      expect(score.sender_trust).toBe('self');
    });

    it('known contact by email → contact_ring1, medium, normal', () => {
      const score = scoreSender('alice@example.com', 'gmail', 'chat', contacts);
      expect(score.sender_trust).toBe('contact_ring1');
      expect(score.confidence).toBe('medium');
      expect(score.retrieval_policy).toBe('normal');
      expect(score.source_type).toBe('contact');
    });

    it('known contact by name → contact_ring1', () => {
      const score = scoreSender('Alice', 'gmail', 'chat', contacts);
      expect(score.sender_trust).toBe('contact_ring1');
    });

    it('known contact by alias → contact_ring1', () => {
      const score = scoreSender('Ali', 'gmail', 'chat', contacts);
      expect(score.sender_trust).toBe('contact_ring1');
    });

    it('unknown sender → unknown, low, caveated', () => {
      const score = scoreSender('stranger@unknown.com', 'gmail', 'chat', contacts);
      expect(score.sender_trust).toBe('unknown');
      expect(score.confidence).toBe('low');
      expect(score.retrieval_policy).toBe('caveated');
      expect(score.source_type).toBe('unknown');
    });

    it('marketing sender → marketing, low, briefing_only', () => {
      const score = scoreSender('noreply@promo.com', 'gmail', 'chat', contacts);
      expect(score.sender_trust).toBe('marketing');
      expect(score.confidence).toBe('low');
      expect(score.retrieval_policy).toBe('briefing_only');
      expect(score.source_type).toBe('marketing');
    });

    it('empty sender → unknown (caveated)', () => {
      const score = scoreSender('', 'gmail', 'chat', contacts);
      expect(score.sender_trust).toBe('unknown');
      expect(score.retrieval_policy).toBe('caveated');
    });

    it('newsletter sender → marketing', () => {
      const score = scoreSender('newsletter@tech.com', 'gmail', 'chat', contacts);
      expect(score.sender_trust).toBe('marketing');
    });
  });

  describe('verified service domains', () => {
    it('chase.com → service, medium, normal', () => {
      const score = scoreSender('alerts@chase.com', 'gmail', 'chat', []);
      expect(score.sender_trust).toBe('service');
      expect(score.confidence).toBe('medium');
      expect(score.retrieval_policy).toBe('normal');
      expect(score.source_type).toBe('service');
    });

    it('google.com → service', () => {
      const score = scoreSender('support@google.com', 'gmail', 'chat', []);
      expect(score.sender_trust).toBe('service');
    });

    it('irs.gov → service', () => {
      const score = scoreSender('notices@irs.gov', 'gmail', 'chat', []);
      expect(score.sender_trust).toBe('service');
    });

    it('paypal.com → service', () => {
      const score = scoreSender('service@paypal.com', 'gmail', 'chat', []);
      expect(score.sender_trust).toBe('service');
    });

    it('unknown domain → not service', () => {
      const score = scoreSender('admin@randomsite.com', 'gmail', 'chat', []);
      expect(score.sender_trust).not.toBe('service');
    });

    it('contact match takes priority over verified service', () => {
      // bob@work.com is a known contact AND could be a service domain
      const score = scoreSender('bob@work.com', 'gmail', 'chat', contacts);
      expect(score.sender_trust).toBe('contact_ring1');
    });
  });

  describe('marketing subdomain patterns', () => {
    it('@notifications. subdomain → marketing', () => {
      const score = scoreSender('deals@notifications.shop.com', 'gmail', 'chat', []);
      expect(score.sender_trust).toBe('marketing');
    });

    it('@bounce. subdomain → marketing', () => {
      const score = scoreSender('mailer@bounce.newsletter.com', 'gmail', 'chat', []);
      expect(score.sender_trust).toBe('marketing');
    });

    it('@updates. subdomain → marketing', () => {
      const score = scoreSender('news@updates.platform.com', 'gmail', 'chat', []);
      expect(score.sender_trust).toBe('marketing');
    });
  });

  describe('ingress channel dispatch', () => {
    describe('connector anti-spoofing', () => {
      it('connector → service/medium/normal regardless of sender', () => {
        // Even if the sender matches a contact, connector gets service trust
        const score = scoreSender('alice@example.com', 'gmail', 'connector', contacts);
        expect(score.sender_trust).toBe('service');
        expect(score.confidence).toBe('medium');
        expect(score.retrieval_policy).toBe('normal');
        expect(score.source_type).toBe('service');
      });

      it('connector with source=telegram does NOT get self trust', () => {
        // Anti-spoofing: a connector claiming telegram source must not get self
        const score = scoreSender('user', 'telegram', 'connector', contacts);
        expect(score.sender_trust).toBe('service');
        expect(score.sender_trust).not.toBe('self');
      });

      it('connector with marketing sender still gets service trust', () => {
        const score = scoreSender('noreply@spam.com', 'gmail', 'connector', contacts);
        expect(score.sender_trust).toBe('service');
      });
    });

    describe('D2D channel', () => {
      it('D2D with known contact → contact_ring1, medium', () => {
        const score = scoreSender('Alice', 'p2p', 'd2d', contacts);
        expect(score.sender_trust).toBe('contact_ring1');
        expect(score.confidence).toBe('medium');
        expect(score.source_type).toBe('contact');
      });

      it('D2D with unknown sender → unknown, quarantine', () => {
        const score = scoreSender('stranger@x.com', 'p2p', 'd2d', contacts);
        expect(score.sender_trust).toBe('unknown');
        expect(score.retrieval_policy).toBe('quarantine');
      });

      it('D2D with self-like source does NOT get self trust', () => {
        // D2D channel overrides source-based self detection
        const score = scoreSender('user', 'telegram', 'd2d', []);
        expect(score.sender_trust).toBe('unknown');
        expect(score.retrieval_policy).toBe('quarantine');
      });
    });
  });

  describe('matchSenderToContact', () => {
    it('matches by email', () => {
      const result = matchSenderToContact('alice@example.com', contacts);
      expect(result.matched).toBe(true);
      expect(result.contactName).toBe('Alice');
    });

    it('matches by name (case-insensitive)', () => {
      const result = matchSenderToContact('ALICE', contacts);
      expect(result.matched).toBe(true);
      expect(result.contactName).toBe('Alice');
    });

    it('matches by alias', () => {
      const result = matchSenderToContact('Ali', contacts);
      expect(result.matched).toBe(true);
      expect(result.contactName).toBe('Alice');
    });

    it('returns no match for unknown sender', () => {
      const result = matchSenderToContact('stranger@x.com', contacts);
      expect(result.matched).toBe(false);
      expect(result.contactName).toBeUndefined();
    });

    it('empty sender → no match', () => {
      const result = matchSenderToContact('', contacts);
      expect(result.matched).toBe(false);
    });
  });

  describe('matchByAlias', () => {
    it('matches exact alias', () => {
      expect(matchByAlias('Ali', ['Ali', 'Ally'])).toBe(true);
    });

    it('case-insensitive', () => {
      expect(matchByAlias('ali', ['Ali'])).toBe(true);
    });

    it('no match', () => {
      expect(matchByAlias('Charlie', ['Ali'])).toBe(false);
    });

    it('empty alias list', () => {
      expect(matchByAlias('Ali', [])).toBe(false);
    });

    it('empty sender', () => {
      expect(matchByAlias('', ['Ali'])).toBe(false);
    });
  });
});
