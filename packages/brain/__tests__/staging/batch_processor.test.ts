/**
 * T3.13/3.16 — Full staging batch processor: classify → enrich → resolve → post-publish.
 *
 * Source: ARCHITECTURE.md Tasks 3.13, 3.16
 */

import { processClaimedBatch } from '../../src/staging/batch_processor';
import { ingest, claim, getItem, resetStagingState } from '../../../core/src/staging/service';
import { createPersona, openPersona, resetPersonaState } from '../../../core/src/persona/service';
import { clearVaults } from '../../../core/src/vault/crud';
import { resetReminderState } from '../../../core/src/reminders/service';
import { resetContactDirectory } from '../../../core/src/contacts/directory';
import { resetPersonaSelector } from '../../src/routing/persona_selector';
import { resetFactoryCounters } from '@dina/test-harness';

describe('Staging Batch Processor', () => {
  beforeEach(() => {
    resetStagingState();
    resetPersonaState();
    clearVaults();
    resetReminderState();
    resetContactDirectory();
    resetPersonaSelector();
    resetFactoryCounters();

    createPersona('general', 'default');
    createPersona('health', 'sensitive');
    createPersona('financial', 'sensitive');
    openPersona('general');
  });

  describe('processClaimedBatch', () => {
    it('processes a single item: classify → enrich → resolve', async () => {
      ingest({
        source: 'gmail',
        source_id: 'e1',
        data: { summary: 'Hello from a friend', body: 'Just checking in', type: 'email' },
      });
      const claimed = claim(10);
      const result = await processClaimedBatch(claimed);

      expect(result.processed).toBe(1);
      expect(result.stored).toBe(1); // general is open
      expect(result.results[0].enriched).toBe(true);
      expect(result.results[0].status).toBe('stored');
    });

    it('classifies health items to health persona', async () => {
      ingest({
        source: 'gmail',
        source_id: 'e2',
        data: { summary: 'Lab results from doctor', body: 'blood test', type: 'email' },
      });
      const claimed = claim(10);
      const result = await processClaimedBatch(claimed);

      expect(result.results[0].persona).toBe('health');
      expect(result.results[0].status).toBe('pending_unlock'); // health not open
      expect(result.pendingUnlock).toBe(1);
    });

    it('processes multiple items in batch', async () => {
      ingest({
        source: 'gmail',
        source_id: 'b1',
        data: { summary: 'Meeting notes', type: 'email' },
      });
      ingest({
        source: 'gmail',
        source_id: 'b2',
        data: { summary: 'Invoice payment due', type: 'email' },
      });
      ingest({ source: 'gmail', source_id: 'b3', data: { summary: 'Hello world', type: 'email' } });
      const claimed = claim(10);
      const result = await processClaimedBatch(claimed);

      expect(result.processed).toBe(3);
      expect(result.stored + result.pendingUnlock + result.failed).toBe(3);
    });

    it('runs post-publish for stored items', async () => {
      ingest({
        source: 'gmail',
        source_id: 'pp1',
        data: { summary: 'Alice sent email', type: 'email', sender_did: 'did:plc:alice' },
      });
      const claimed = claim(10);
      const result = await processClaimedBatch(claimed);

      if (result.results[0].status === 'stored') {
        expect(result.results[0].postPublishResult).toBeDefined();
      }
    });

    it('failed item is marked failed in staging', async () => {
      // Create an item that will fail during processing
      ingest({ source: 'gmail', source_id: 'fail1', data: {} });
      const claimed = claim(10);

      // Manually break the item to cause failure
      (claimed[0] as any).data = null;
      const result = await processClaimedBatch(claimed);

      expect(result.failed).toBe(1);
      expect(result.results[0].status).toBe('failed');
      expect(result.results[0].error).toBeTruthy();
    });

    it('empty batch returns zero counts', async () => {
      const result = await processClaimedBatch([]);
      expect(result.processed).toBe(0);
      expect(result.stored).toBe(0);
    });

    it('error in one item does not stop batch', async () => {
      ingest({ source: 'gmail', source_id: 'ok1', data: { summary: 'Good email', type: 'email' } });
      ingest({
        source: 'gmail',
        source_id: 'ok2',
        data: { summary: 'Another good one', type: 'email' },
      });
      const claimed = claim(10);

      // Corrupt the first item
      (claimed[0] as any).data = null;
      const result = await processClaimedBatch(claimed);

      expect(result.processed).toBe(2);
      expect(result.failed).toBeGreaterThanOrEqual(1);
      // Second item should still be processed
    });
  });
});
