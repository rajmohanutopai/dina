/**
 * Sponsored content detection — identify and tag promotional content.
 *
 * Source: brain/src/service/guardian.py — sponsored content tagging
 */

import {
  detectSponsored,
  tagSponsored,
  untagSponsored,
  type SponsoredResult,
} from '../../src/enrichment/sponsored';
import { enrichItem, resetEnrichmentPipeline } from '../../src/enrichment/pipeline';

describe('Sponsored Content Detection', () => {
  describe('detectSponsored', () => {
    describe('label-based detection', () => {
      it('detects Gmail promotions label', () => {
        const result = detectSponsored({ labels: ['promotions'] });
        expect(result.isSponsored).toBe(true);
        expect(result.method).toBe('label');
        expect(result.confidence).toBeGreaterThanOrEqual(0.9);
      });

      it('detects sponsored label', () => {
        const result = detectSponsored({ labels: ['sponsored'] });
        expect(result.isSponsored).toBe(true);
      });

      it('case-insensitive label matching', () => {
        const result = detectSponsored({ labels: ['PROMOTIONS'] });
        expect(result.isSponsored).toBe(true);
      });

      it('ignores non-promo labels', () => {
        const result = detectSponsored({ labels: ['primary', 'important'] });
        expect(result.isSponsored).toBe(false);
      });
    });

    describe('trust-level detection', () => {
      it('detects marketing trust level', () => {
        const result = detectSponsored({ sender_trust: 'marketing' });
        expect(result.isSponsored).toBe(true);
        expect(result.method).toBe('trust');
      });

      it('detects spam trust level', () => {
        const result = detectSponsored({ sender_trust: 'spam' });
        expect(result.isSponsored).toBe(true);
      });

      it('does not flag trusted sender', () => {
        const result = detectSponsored({ sender_trust: 'verified' });
        expect(result.isSponsored).toBe(false);
      });
    });

    describe('source-based detection', () => {
      it('detects promo source', () => {
        const result = detectSponsored({ source: 'promo' });
        expect(result.isSponsored).toBe(true);
        expect(result.method).toBe('source');
      });

      it('detects newsletter source', () => {
        const result = detectSponsored({ source: 'newsletter' });
        expect(result.isSponsored).toBe(true);
      });

      it('detects marketing source', () => {
        const result = detectSponsored({ source: 'marketing' });
        expect(result.isSponsored).toBe(true);
      });

      it('does not flag email source', () => {
        const result = detectSponsored({ source: 'email' });
        expect(result.isSponsored).toBe(false);
      });
    });

    describe('sender-based detection', () => {
      it('detects noreply@ sender', () => {
        const result = detectSponsored({ sender: 'noreply@company.com' });
        expect(result.isSponsored).toBe(true);
        expect(result.method).toBe('sender');
      });

      it('detects newsletter@ sender', () => {
        const result = detectSponsored({ sender: 'newsletter@example.com' });
        expect(result.isSponsored).toBe(true);
      });

      it('detects deals@ sender', () => {
        const result = detectSponsored({ sender: 'deals@store.com' });
        expect(result.isSponsored).toBe(true);
      });

      it('does not flag personal sender', () => {
        const result = detectSponsored({ sender: 'alice@example.com' });
        expect(result.isSponsored).toBe(false);
      });
    });

    describe('content-based detection', () => {
      it('detects multiple promotional patterns', () => {
        const result = detectSponsored({
          subject: 'Use code SAVE20 for 50% off',
          body: 'Buy now and save! Free shipping on orders over $50. Unsubscribe here.',
        });
        expect(result.isSponsored).toBe(true);
        expect(result.method).toBe('content');
      });

      it('single pattern is not enough (reduces false positives)', () => {
        const result = detectSponsored({
          body: 'You can unsubscribe from this mailing list.',
        });
        expect(result.isSponsored).toBe(false);
      });

      it('does not flag normal conversation', () => {
        const result = detectSponsored({
          subject: 'Meeting tomorrow',
          body: 'Let me know if 3pm works for you.',
        });
        expect(result.isSponsored).toBe(false);
      });
    });

    describe('priority ordering', () => {
      it('label takes precedence over content', () => {
        const result = detectSponsored({
          labels: ['promotions'],
          body: 'Normal text without promo patterns',
        });
        expect(result.method).toBe('label');
      });

      it('trust takes precedence over source', () => {
        const result = detectSponsored({
          sender_trust: 'marketing',
          source: 'email', // not a promo source
        });
        expect(result.method).toBe('trust');
      });
    });

    describe('edge cases', () => {
      it('handles empty input', () => {
        const result = detectSponsored({});
        expect(result.isSponsored).toBe(false);
      });

      it('handles undefined fields', () => {
        const result = detectSponsored({
          source: undefined,
          sender: undefined,
          body: undefined,
        });
        expect(result.isSponsored).toBe(false);
      });
    });
  });

  describe('tagSponsored', () => {
    it('adds [Sponsored] prefix', () => {
      expect(tagSponsored('Great deal on shoes')).toBe('[Sponsored] Great deal on shoes');
    });

    it('does not double-tag', () => {
      expect(tagSponsored('[Sponsored] Already tagged')).toBe('[Sponsored] Already tagged');
    });
  });

  describe('untagSponsored', () => {
    it('removes [Sponsored] prefix', () => {
      expect(untagSponsored('[Sponsored] Great deal')).toBe('Great deal');
    });

    it('handles text without tag', () => {
      expect(untagSponsored('Normal text')).toBe('Normal text');
    });
  });

  describe('enrichment pipeline integration', () => {
    beforeEach(() => resetEnrichmentPipeline());

    it('tags L0 with [Sponsored] for promotional source', async () => {
      const result = await enrichItem({
        type: 'email',
        source: 'newsletter',
        sender: 'deals@store.com',
        timestamp: Date.now(),
        summary: 'Weekly deals roundup',
        sender_trust: 'marketing',
      });
      expect(result.isSponsored).toBe(true);
      expect(result.content_l0).toMatch(/^\[Sponsored\]/);
    });

    it('does not tag L0 for normal content', async () => {
      const result = await enrichItem({
        type: 'email',
        source: 'gmail',
        sender: 'alice@example.com',
        timestamp: Date.now(),
        summary: 'Meeting tomorrow at 3pm',
      });
      expect(result.isSponsored).toBe(false);
      expect(result.content_l0).not.toMatch(/^\[Sponsored\]/);
    });
  });
});
