/**
 * T2B.6 — Staging processor: claim → classify → enrich → resolve.
 *
 * Source: brain/tests/test_staging_processor.py
 */

import {
  processPendingItems,
  classifyItem,
  enrichItem,
  applyTrustScoring,
  resolveContactDID,
  clearPendingItems,
  addPendingItem,
} from '../../src/staging/processor';
import { resetFactoryCounters } from '@dina/test-harness';
import { addKnownContact, clearKnownContacts } from '../../../core/src/trust/source_trust';

const rec = (overrides?: Record<string, unknown>) =>
  ({
    id: 'stg-001',
    type: 'email',
    source: 'gmail',
    sender: 'alice@example.com',
    summary: '',
    body: '',
    timestamp: 1700000000,
    ...overrides,
  }) as Record<string, unknown>;

describe('Staging Processor', () => {
  beforeEach(() => {
    resetFactoryCounters();
    clearKnownContacts();
    clearPendingItems();
  });

  describe('processPendingItems', () => {
    it('processes pending items and returns results', async () => {
      addPendingItem(rec({ id: 'item-1', summary: 'Lab results' }));
      addPendingItem(rec({ id: 'item-2', summary: 'Team meeting' }));
      const results = await processPendingItems(10);
      expect(results).toHaveLength(2);
      expect(results[0].itemId).toBe('item-1');
      expect(results[0].status).toBe('stored');
      expect(results[0].enriched).toBe(true);
    });

    it('respects limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        addPendingItem(rec({ id: `item-${i}` }));
      }
      const results = await processPendingItems(2);
      expect(results).toHaveLength(2);
    });

    it('no pending items → returns empty', async () => {
      const results = await processPendingItems();
      expect(results).toEqual([]);
    });

    it('assigns persona based on domain classification', async () => {
      addPendingItem(rec({ id: 'health-item', summary: 'Lab results from doctor' }));
      const results = await processPendingItems();
      expect(results[0].persona).toBe('health');
    });

    it('defaults to general for unclassifiable items', async () => {
      addPendingItem(rec({ id: 'generic', summary: 'Hello world' }));
      const results = await processPendingItems();
      expect(results[0].persona).toBe('general');
    });
  });

  describe('classifyItem', () => {
    it('classifies health-related item', async () => {
      const result = await classifyItem(rec({ summary: 'Lab results from clinic' }));
      expect(result.persona).toBe('health');
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('classifies financial item', async () => {
      const result = await classifyItem(rec({ summary: 'Invoice payment due' }));
      expect(result.persona).toBe('financial');
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('classifies email to general when no domain match', async () => {
      const result = await classifyItem(rec({ summary: 'Random chat message' }));
      expect(result.persona).toBe('general');
    });

    it('uses body text for classification', async () => {
      const result = await classifyItem(
        rec({ summary: 'Update', body: 'Your prescription is ready' }),
      );
      expect(result.persona).toBe('health');
    });
  });

  describe('enrichItem', () => {
    it('enriches with L0 summary', async () => {
      const enriched = await enrichItem(rec({ summary: 'Doctor appointment' }));
      expect(enriched.content_l0).toBeTruthy();
      expect(String(enriched.content_l0)).toContain('Doctor appointment');
    });

    it('generates L0 from metadata when no summary', async () => {
      const enriched = await enrichItem(
        rec({ summary: '', type: 'email', sender: 'bob@example.com' }),
      );
      expect(enriched.content_l0).toBeTruthy();
      expect(String(enriched.content_l0)).toContain('Email');
      expect(String(enriched.content_l0)).toContain('bob@example.com');
    });

    it('sets enrichment_status to l0_complete', async () => {
      const enriched = await enrichItem(rec());
      expect(enriched.enrichment_status).toBe('l0_complete');
    });

    it('sets enrichment_version', async () => {
      const enriched = await enrichItem(rec());
      expect(enriched.enrichment_version).toBe('deterministic-v1');
    });

    it('preserves original item fields', async () => {
      const enriched = await enrichItem(rec({ sender: 'alice@example.com', source: 'gmail' }));
      expect(enriched.sender).toBe('alice@example.com');
      expect(enriched.source).toBe('gmail');
    });

    it('adds trust caveat for unknown sender', async () => {
      const enriched = await enrichItem(rec({ summary: 'Message', sender_trust: 'unknown' }));
      expect(String(enriched.content_l0)).toContain('unverified');
    });
  });

  describe('applyTrustScoring', () => {
    it('assigns sender_trust based on sender identity', () => {
      const item = rec({ sender: 'user', source: 'personal' });
      const scored = applyTrustScoring(item);
      expect(scored.sender_trust).toBe('self');
      expect(scored.confidence).toBe('high');
    });

    it('unknown sender → unknown trust', () => {
      const item = rec({ sender: 'stranger@unknown.com', source: 'gmail' });
      const scored = applyTrustScoring(item);
      expect(scored.sender_trust).toBe('unknown');
      expect(scored.retrieval_policy).toBe('caveated');
    });

    it('marketing sender → marketing trust', () => {
      const item = rec({ sender: 'noreply@promo.com', source: 'gmail' });
      const scored = applyTrustScoring(item);
      expect(scored.sender_trust).toBe('marketing');
      expect(scored.retrieval_policy).toBe('briefing_only');
    });

    it('known contact → contact_ring1', () => {
      addKnownContact('alice@example.com');
      const item = rec({ sender: 'alice@example.com', source: 'gmail' });
      const scored = applyTrustScoring(item);
      expect(scored.sender_trust).toBe('contact_ring1');
    });

    it('preserves original item fields', () => {
      const item = rec({ sender: 'user', source: 'personal', summary: 'My note' });
      const scored = applyTrustScoring(item);
      expect(scored.summary).toBe('My note');
    });
  });

  describe('resolveContactDID', () => {
    it('resolves by explicit DID', () => {
      expect(resolveContactDID('did:plc:alice123')).toBe('did:plc:alice123');
    });

    it('returns null for non-DID sender', () => {
      expect(resolveContactDID('Ali')).toBeNull();
    });

    it('returns null for unknown sender', () => {
      expect(resolveContactDID('stranger@unknown.com')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(resolveContactDID('')).toBeNull();
    });
  });

  // -------------------------------------------------------------------
  // WM-BRAIN-03 — topic-touch hook wiring
  // -------------------------------------------------------------------

  describe('processPendingItems + topicTouch hook', () => {
    it('invokes touchTopicsForItem after each successful store and records counts', async () => {
      addPendingItem(rec({ id: 'item-a', summary: 'Dr Carl called' }));
      addPendingItem(rec({ id: 'item-b', summary: 'Knee rehab plan' }));
      const touchCalls: string[] = [];
      const core = {
        async memoryTouch(req: {
          persona: string;
          topic: string;
          kind: 'entity' | 'theme';
          sampleItemId?: string;
        }) {
          touchCalls.push(`${req.persona}:${req.topic}`);
          return { status: 'ok' as const, canonical: req.topic };
        },
        // PC-BRAIN-13 added updateContact to the pipeline's core
        // surface. Unused here but required by the type.
        async updateContact() {
          /* unused */
        },
      };
      // Minimal extractor stub — the hook takes it as-is and forwards the item.
      const { TopicExtractor } = await import('../../src/enrichment/topic_extractor');
      const extractor = new TopicExtractor({ llm: async () => '{}' });
      extractor.extract = async (input) =>
        (input.summary ?? '').includes('Dr Carl')
          ? { entities: ['Dr Carl'], themes: [] }
          : { entities: [], themes: ['knee rehab'] };

      const results = await processPendingItems({
        limit: 10,
        topicTouch: { extractor, core },
      });

      expect(results).toHaveLength(2);
      expect(results[0].topics).toMatchObject({ touched: 1, failed: 0 });
      expect(results[1].topics).toMatchObject({ touched: 1, failed: 0 });
      // Both topics reached Core, each on the classified persona (default 'general').
      expect(touchCalls).toHaveLength(2);
      expect(touchCalls[0]).toMatch(/:Dr Carl$/);
      expect(touchCalls[1]).toMatch(/:knee rehab$/);
    });

    it('does NOT invoke the hook when topicTouch option is omitted (legacy numeric limit)', async () => {
      addPendingItem(rec({ id: 'item-c', summary: 'anything' }));
      const results = await processPendingItems(5);
      expect(results[0].topics).toBeUndefined();
    });

    it('a failing topicTouch does NOT mark the item as failed', async () => {
      addPendingItem(rec({ id: 'item-d', summary: 'Dr Carl' }));
      const { TopicExtractor } = await import('../../src/enrichment/topic_extractor');
      const extractor = new TopicExtractor({ llm: async () => '{}' });
      extractor.extract = async () => ({ entities: ['Dr Carl'], themes: [] });
      const core = {
        async memoryTouch() {
          throw new Error('core down');
        },
        async updateContact() {
          /* unused */
        },
      };
      const results = await processPendingItems({ topicTouch: { extractor, core } });
      expect(results[0].status).toBe('stored'); // ingest still succeeded
      // Pipeline now returns the full TopicTouchResult shape with
      // preference counts; the test checks the touch counters.
      expect(results[0].topics).toMatchObject({ touched: 0, failed: 1 });
    });
  });
});
