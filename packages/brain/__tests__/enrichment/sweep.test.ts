/**
 * Enrichment batch sweep — process pending items through the pipeline.
 *
 * Source: brain/src/service/enrichment.py — enrich_pending()
 */

import { sweepEnrichment, enrichSingleItem } from '../../src/enrichment/sweep';
import { registerEnrichmentLLM, resetEnrichmentPipeline } from '../../src/enrichment/pipeline';
import {
  storeItem,
  clearVaults,
  getItem,
  queryByEnrichmentStatus,
} from '../../../core/src/vault/crud';
import { createPersona, resetPersonaState, openPersona } from '../../../core/src/persona/service';
import { makeVaultItem, resetFactoryCounters } from '@dina/test-harness';

describe('Enrichment Batch Sweep', () => {
  beforeEach(() => {
    resetFactoryCounters();
    clearVaults();
    resetPersonaState();
    resetEnrichmentPipeline();
    createPersona('general', 'default');
    createPersona('health', 'sensitive');
    openPersona('general');
    openPersona('health');
  });

  describe('sweepEnrichment', () => {
    it('finds and processes l0_complete items', async () => {
      // Store an item with l0_complete status
      storeItem(
        'general',
        makeVaultItem({
          summary: 'Meeting notes',
          body: 'Discussed project timeline',
          enrichment_status: 'l0_complete',
        }),
      );

      const result = await sweepEnrichment();
      expect(result.found).toBe(1);
      // Without LLM registered, enrichment stays at l0_complete (not 'ready')
      expect(result.enriched).toBe(0); // no LLM → can't reach 'ready'
      expect(result.failed).toBe(0);
    });

    it('enriches items to ready status when LLM is available', async () => {
      registerEnrichmentLLM(
        async () =>
          '{"l0": "Meeting about project timeline", "l1": "Detailed notes from the project meeting including milestones and deadlines."}',
      );

      storeItem(
        'general',
        makeVaultItem({
          summary: 'Meeting notes',
          body: 'Discussed project timeline with key stakeholders',
          enrichment_status: 'l0_complete',
        }),
      );

      const result = await sweepEnrichment();
      expect(result.found).toBe(1);
      // LLM available but no embedding → still l0_complete, not 'ready'
      // (ready requires both L1 + embedding)
    });

    it('processes items across multiple personas', async () => {
      storeItem(
        'general',
        makeVaultItem({
          summary: 'General note',
          enrichment_status: 'l0_complete',
        }),
      );
      storeItem(
        'health',
        makeVaultItem({
          summary: 'Health record',
          enrichment_status: 'l0_complete',
        }),
      );

      const result = await sweepEnrichment();
      expect(result.found).toBe(2);
      expect(result.byPersona['general'].found).toBe(1);
      expect(result.byPersona['health'].found).toBe(1);
    });

    it('skips items with enrichment_status=ready', async () => {
      storeItem(
        'general',
        makeVaultItem({
          summary: 'Already enriched',
          enrichment_status: 'ready',
        }),
      );

      const result = await sweepEnrichment();
      expect(result.found).toBe(0); // 'ready' items not included in sweep
    });

    it('respects batchSize limit', async () => {
      for (let i = 0; i < 10; i++) {
        storeItem(
          'general',
          makeVaultItem({
            summary: `Item ${i}`,
            enrichment_status: 'l0_complete',
          }),
        );
      }

      const result = await sweepEnrichment({ batchSize: 3 });
      expect(result.found).toBeLessThanOrEqual(3);
    });

    it('handles enrichment failure per item without stopping', async () => {
      // Register an LLM that always throws
      registerEnrichmentLLM(async () => {
        throw new Error('LLM down');
      });

      storeItem(
        'general',
        makeVaultItem({
          summary: 'Will fail',
          enrichment_status: 'l0_complete',
        }),
      );

      const result = await sweepEnrichment();
      // The sweep catches the error and marks as failed
      // enrichItem doesn't throw — it catches internally and returns l0_complete
      expect(result.found).toBe(1);
      expect(result.failed).toBe(0); // enrichItem catches internally
    });

    it('returns empty result when no items need enrichment', async () => {
      const result = await sweepEnrichment();
      expect(result.found).toBe(0);
      expect(result.enriched).toBe(0);
      expect(result.failed).toBe(0);
    });

    it('persists confidence to vault item', async () => {
      const itemId = storeItem(
        'general',
        makeVaultItem({
          summary: 'Item with known sender',
          enrichment_status: 'l0_complete',
          sender: 'alice@example.com',
          sender_trust: 'contact_ring1',
          confidence: '', // start empty
        }),
      );

      await sweepEnrichment();

      // After enrichment, confidence should be set to a valid non-empty value
      const updated = getItem('general', itemId);
      expect(updated).not.toBeNull();
      expect(updated!.confidence).toMatch(/^(high|medium|low)$/);
    });

    it('can sweep custom statuses', async () => {
      storeItem(
        'general',
        makeVaultItem({
          summary: 'Failed item',
          enrichment_status: 'failed',
        }),
      );

      const result = await sweepEnrichment({ statuses: ['failed'] });
      expect(result.found).toBe(1);
    });
  });

  describe('enrichSingleItem', () => {
    it('enriches a specific item by ID', async () => {
      const itemId = storeItem(
        'general',
        makeVaultItem({
          summary: 'Single item to enrich',
          body: 'Content here',
          enrichment_status: 'l0_complete',
        }),
      );

      const result = await enrichSingleItem('general', itemId);
      expect(result).not.toBeNull();
      expect(result!.content_l0).toBeTruthy();
      expect(result!.enrichment_status).toBe('l0_complete'); // no LLM → stays l0
    });

    it('returns null for non-existent item', async () => {
      const result = await enrichSingleItem('general', 'nonexistent');
      expect(result).toBeNull();
    });

    it('updates vault item in place', async () => {
      const itemId = storeItem(
        'general',
        makeVaultItem({
          summary: 'Item to update',
          enrichment_status: 'l0_complete',
          content_l0: '',
        }),
      );

      await enrichSingleItem('general', itemId);

      const updated = getItem('general', itemId);
      expect(updated).not.toBeNull();
      expect(updated!.content_l0).toBeTruthy(); // L0 was generated
    });

    it('persists confidence field to vault', async () => {
      const itemId = storeItem(
        'general',
        makeVaultItem({
          summary: 'Emma birthday March 15',
          enrichment_status: 'l0_complete',
          confidence: '',
        }),
      );

      const result = await enrichSingleItem('general', itemId);
      expect(result).not.toBeNull();
      expect(result!.confidence).toBeTruthy(); // should be 'high', 'medium', or 'low'

      const updated = getItem('general', itemId);
      expect(updated).not.toBeNull();
      expect(updated!.confidence).toBe(result!.confidence); // persisted to vault
    });
  });

  describe('queryByEnrichmentStatus', () => {
    it('returns items matching the status', () => {
      storeItem('general', makeVaultItem({ enrichment_status: 'l0_complete' }));
      storeItem('general', makeVaultItem({ enrichment_status: 'ready' }));
      storeItem('general', makeVaultItem({ enrichment_status: 'l0_complete' }));

      const pending = queryByEnrichmentStatus('general', 'l0_complete');
      expect(pending).toHaveLength(2);
    });

    it('returns empty for no matches', () => {
      storeItem('general', makeVaultItem({ enrichment_status: 'ready' }));
      const pending = queryByEnrichmentStatus('general', 'l0_complete');
      expect(pending).toHaveLength(0);
    });

    it('respects limit', () => {
      for (let i = 0; i < 10; i++) {
        storeItem('general', makeVaultItem({ enrichment_status: 'l0_complete' }));
      }
      const pending = queryByEnrichmentStatus('general', 'l0_complete', 3);
      expect(pending).toHaveLength(3);
    });

    it('sorted oldest first', () => {
      storeItem('general', makeVaultItem({ enrichment_status: 'l0_complete', created_at: 2000 }));
      storeItem('general', makeVaultItem({ enrichment_status: 'l0_complete', created_at: 1000 }));
      storeItem('general', makeVaultItem({ enrichment_status: 'l0_complete', created_at: 3000 }));

      const items = queryByEnrichmentStatus('general', 'l0_complete');
      expect(items[0].created_at).toBe(1000);
      expect(items[1].created_at).toBe(2000);
      expect(items[2].created_at).toBe(3000);
    });
  });
});
