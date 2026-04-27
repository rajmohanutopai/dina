/**
 * Staging Pipeline End-to-End Integration — complete ingest → resolve lifecycle.
 *
 * Exercises every module in the staging chain:
 *   Ingest → dedup → claim → classify → enrich → resolve → post-publish → reminder
 *
 * Source: ARCHITECTURE.md Tasks 2.41–2.47, 3.12–3.16, 3.28–3.29
 */

import {
  ingest,
  claim,
  resolve,
  fail,
  sweep,
  getItem,
  resetStagingState,
} from '../../../core/src/staging/service';
import { classifyItem, enrichItem, applyTrustScoring } from '../../src/staging/processor';
import { handlePostPublish } from '../../src/pipeline/post_publish';
import { planReminders } from '../../src/pipeline/reminder_planner';
import { isDuplicate, markSeen, resetDedupState } from '../../../core/src/sync/dedup';
import {
  createPersona,
  isPersonaOpen,
  openPersona,
  resetPersonaState,
} from '../../../core/src/persona/service';
import { clearVaults, queryVault, storeItem } from '../../../core/src/vault/crud';
import { resetReminderState, listByPersona } from '../../../core/src/reminders/service';
import { addContact, resetContactDirectory } from '../../../core/src/contacts/directory';
import { resetFactoryCounters } from '@dina/test-harness';

describe('Staging Pipeline End-to-End Integration', () => {
  beforeEach(() => {
    resetStagingState();
    resetDedupState();
    resetPersonaState();
    clearVaults();
    resetReminderState();
    resetContactDirectory();
    resetFactoryCounters();

    createPersona('general', 'default');
    createPersona('health', 'sensitive');
    createPersona('financial', 'sensitive');
    openPersona('general');
  });

  describe('happy path: email → vault', () => {
    it('complete flow: ingest → claim → classify → enrich → resolve → vault', async () => {
      // 1. Dedup check
      expect(isDuplicate('gmail', 'msg-001')).toBe(false);
      markSeen('gmail', 'msg-001');

      // 2. Ingest
      const { id, duplicate } = ingest({
        source: 'gmail',
        source_id: 'msg-001',
        data: {
          summary: 'Team meeting notes',
          body: 'Discussed Q4 goals',
          sender: 'alice@work.com',
        },
      });
      expect(duplicate).toBe(false);

      // 3. Claim
      const claimed = claim(10);
      expect(claimed).toHaveLength(1);
      expect(claimed[0].status).toBe('classifying');

      // 4. Classify
      const classification = await classifyItem(claimed[0].data as Record<string, unknown>);
      expect(classification.persona).toBeTruthy();

      // 5. Trust scoring
      const scored = applyTrustScoring(claimed[0].data as Record<string, unknown>);
      expect(scored.sender_trust).toBeTruthy();

      // 6. Enrich
      const enriched = await enrichItem(claimed[0].data as Record<string, unknown>);
      expect(enriched.content_l0).toBeTruthy();

      // 7. Resolve to open persona — pass enriched data for vault storage
      const vaultItem = {
        ...(claimed[0].data as Record<string, unknown>),
        content_l0: enriched.content_l0,
        content_l1: enriched.content_l1 || '',
        enrichment_status: enriched.enrichment_status,
        enrichment_version:
          typeof enriched.enrichment_version === 'string'
            ? enriched.enrichment_version
            : JSON.stringify(enriched.enrichment_version),
        confidence: enriched.confidence,
        sender_trust: scored.sender_trust,
      };
      resolve(id, 'general', true, vaultItem);
      expect(getItem(id)!.status).toBe('stored');

      // 8. Verify item reached the vault with enriched fields
      const vaultResults = queryVault('general', { mode: 'fts5', text: 'meeting', limit: 10 });
      expect(vaultResults.length).toBeGreaterThanOrEqual(1);

      const stored = vaultResults[0];
      expect(stored.content_l0).toBeTruthy();
      expect(stored.enrichment_status).toBe('l0_complete');
      expect(stored.confidence).toMatch(/^(high|medium|low)$/);
    });
  });

  describe('dedup prevents double-ingest', () => {
    it('same email ingested twice → second rejected', () => {
      markSeen('gmail', 'msg-dup');
      ingest({ source: 'gmail', source_id: 'msg-dup' });
      const r2 = ingest({ source: 'gmail', source_id: 'msg-dup' });
      expect(r2.duplicate).toBe(true);
    });
  });

  describe('locked persona → pending_unlock → drain', () => {
    it('item resolved to locked persona, then drained on unlock', () => {
      const { id } = ingest({
        source: 'gmail',
        source_id: 'health-item',
        data: { summary: 'Lab results' },
      });
      claim(10);
      resolve(id, 'health', false); // health is locked
      expect(getItem(id)!.status).toBe('pending_unlock');

      // User unlocks health persona
      openPersona('health', true);
      const { drainForPersona } = require('../../../core/src/staging/service');
      const drained = drainForPersona('health');
      expect(drained).toBe(1);
      expect(getItem(id)!.status).toBe('stored');
    });

    it('drained item with enriched data reaches vault with content_l0', async () => {
      // Enrich the item before resolving to locked persona
      const { id } = ingest({
        source: 'gmail',
        source_id: 'health-enriched',
        data: { summary: 'Blood pressure reading 120/80', sender: 'doctor@hospital.com' },
      });
      claim(10);

      // Enrich
      const enriched = await enrichItem({
        type: 'email',
        sender: 'doctor@hospital.com',
        timestamp: Date.now(),
        summary: 'Blood pressure reading 120/80',
      });

      // Resolve to locked health persona WITH enriched data
      const vaultItem = {
        summary: 'Blood pressure reading 120/80',
        content_l0: enriched.content_l0,
        enrichment_status: enriched.enrichment_status,
        confidence: enriched.confidence,
      };
      resolve(id, 'health', false, vaultItem); // health is locked
      expect(getItem(id)!.status).toBe('pending_unlock');

      // Unlock and drain
      openPersona('health', true);
      const { drainForPersona } = require('../../../core/src/staging/service');
      drainForPersona('health');

      // Verify vault item has enriched content
      const vaultResults = queryVault('health', { mode: 'fts5', text: 'blood', limit: 10 });
      expect(vaultResults.length).toBeGreaterThanOrEqual(1);
      expect(vaultResults[0].content_l0).toBeTruthy();
      expect(vaultResults[0].enrichment_status).toBe('l0_complete');
    });
  });

  describe('failure → retry → dead-letter', () => {
    it('failed item requeued by sweep, then dead-lettered after max retries', () => {
      const { id } = ingest({ source: 'gmail', source_id: 'fail-item' });
      claim(10);
      fail(id);
      expect(getItem(id)!.retry_count).toBe(1);

      // Sweep requeues
      sweep();
      expect(getItem(id)!.status).toBe('received');

      // Fail 3 more times → dead-letter
      for (let i = 0; i < 3; i++) {
        claim(10);
        fail(id);
        sweep();
      }
      // retry_count is now 4 → should be dead-lettered
      expect(getItem(id)!.status).toBe('failed');
    });
  });

  describe('post-publish: reminder extraction', () => {
    it('item with event signal triggers post-publish handler', async () => {
      const itemData = {
        id: 'item-birthday',
        type: 'email' as const,
        summary: 'Birthday party on December 25',
        body: 'Join us for the celebration',
        timestamp: Date.now(),
        persona: 'general',
      };

      const result = await handlePostPublish(itemData);
      // Reminders may or may not be created depending on date parsing
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('contact integration', () => {
    it('post-publish updates known contact interaction', async () => {
      addContact('did:plc:alice', 'Alice');
      const result = await handlePostPublish({
        id: 'item-from-alice',
        type: 'email',
        summary: 'Hello from Alice',
        body: 'text',
        timestamp: Date.now(),
        persona: 'general',
        sender_did: 'did:plc:alice',
      });
      expect(result.contactUpdated).toBe(true);
    });
  });

  describe('classification → persona routing', () => {
    it('health keyword routes to health persona', async () => {
      const result = await classifyItem({
        type: 'email',
        summary: 'Lab results from your doctor',
        body: 'Blood test results attached',
      });
      expect(result.persona).toBe('health');
    });

    it('financial keyword routes to financial persona', async () => {
      const result = await classifyItem({
        type: 'email',
        summary: 'Invoice payment due',
        body: 'Your monthly statement',
      });
      expect(result.persona).toBe('financial');
    });

    it('ambiguous content routes to general', async () => {
      const result = await classifyItem({
        type: 'email',
        summary: 'Hello world',
        body: 'Nice weather today',
      });
      expect(result.persona).toBe('general');
    });
  });

  describe('enrichment pipeline', () => {
    it('L0 enrichment generates headline from metadata', async () => {
      const enriched = await enrichItem({
        type: 'email',
        sender: 'alice@example.com',
        timestamp: Date.now(),
      });
      expect(enriched.content_l0).toBeTruthy();
      expect(enriched.enrichment_status).toBe('l0_complete');
    });

    it('trust scoring adds sender_trust field', () => {
      const scored = applyTrustScoring({
        sender: 'noreply@promo.com',
        source: 'gmail',
      });
      expect(scored.sender_trust).toBe('marketing');
    });
  });
});
