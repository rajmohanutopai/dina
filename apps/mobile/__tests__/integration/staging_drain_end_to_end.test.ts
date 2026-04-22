/**
 * End-to-end integration: staging drain → classify → enrich → resolve
 * → topic touch → preference binding, all wired through the same
 * shape the bootstrap uses.
 *
 * This test doesn't spin up the full `createNode` (which requires a
 * MsgBox / transport / PDS wiring). Instead it exercises the exact
 * compositional path bootstrap hands to `StagingDrainScheduler`:
 *
 *   core.claimStagingItems → drain pipeline → core.resolveStagingItem
 *   → topicTouch.buildStagingEnrichment → preference binder →
 *   core.updateContact.
 *
 * Pins the invariant flagged in GAP-RT-02 + PC-BRAIN-13 — "ingesting
 * an item that mentions `my dentist Dr Carl` ends with Dr Carl's
 * contact carrying `preferredFor: ['dental']`."
 */

import { StagingDrainScheduler } from '../../../brain/src/staging/scheduler';
import type { StagingDrainCoreClient } from '../../../brain/src/staging/drain';
import { buildStagingEnrichment } from '../../src/services/staging_enrichment';
import type { BrainCoreClient } from '../../../brain/src/core_client/http';
import {
  resetContactDirectory,
  addContact,
  getContact,
} from '../../../core/src/contacts/directory';

describe('staging drain end-to-end — GAP-RT-02 / PC-BRAIN-13', () => {
  beforeEach(() => resetContactDirectory());
  afterEach(() => resetContactDirectory());

  it('ingesting an item mentioning "my dentist Dr Carl" binds the dental preference on his contact', async () => {
    // Seed the directory with Dr Carl, no preferences yet.
    addContact('did:plc:drcarl', 'Dr Carl', 'trusted', 'summary', 'acquaintance');
    expect(getContact('did:plc:drcarl')!.preferredFor ?? []).toEqual([]);

    // Capture core calls to verify the shape of the wire contract.
    const resolveCalls: Array<{ itemId: string; persona: string | string[]; data: unknown }> = [];
    const updateContactCalls: Array<{ did: string; preferredFor?: string[] }> = [];
    const memoryTouches: Array<{ topic: string }> = [];

    const core = {
      // Drain-facing surface
      async claimStagingItems() {
        return [
          {
            id: 'stg-1',
            type: 'note',
            source: 'clinic', // health source hint → 0.90 confidence → health persona
            sender: 'self',
            subject: 'dental appointment — prescription update',
            body: 'My dentist Dr Carl booked me in for next Tuesday. New prescription ready.',
            summary: 'prescription update from Dr Carl',
            timestamp: 1_700_000_000,
          },
        ];
      },
      async resolveStagingItem(itemId: string, persona: string | string[], data: unknown) {
        resolveCalls.push({ itemId, persona, data });
        return { ok: true };
      },
      async failStagingItem() {
        /* happy path only */
      },
      // TopicTouchCoreClient-facing surface
      async memoryTouch(req: { topic: string }) {
        memoryTouches.push(req);
        return { status: 'ok' as const, canonical: req.topic };
      },
      async updateContact(did: string, updates: { preferredFor?: string[] }) {
        updateContactCalls.push({ did, preferredFor: updates.preferredFor });
      },
    } as unknown as BrainCoreClient & StagingDrainCoreClient;

    // Build the enrichment bundle with NO LLM — preference binder only.
    // Preference extraction is regex-based, so a live LLM is not needed
    // to prove the dental binding fires.
    const topicTouch = buildStagingEnrichment({ core });

    // Wrap the scheduler with injectable timers — drive ticks manually
    // via `flush()` so the test is deterministic.
    const scheduler = new StagingDrainScheduler({
      core,
      drain: { topicTouch },
      setInterval: () => 1,
      clearInterval: () => {
        /* noop */
      },
    });
    scheduler.start();
    await scheduler.flush();

    // 1. Ingest actually resolved to the vault. The enrichment payload
    //    landed in the resolve call, carrying the classified persona(s).
    // GAP-MULTI-01: resolve now receives an array so a multi-persona
    // fanout writes one vault row per persona.
    expect(resolveCalls).toHaveLength(1);
    expect(resolveCalls[0].itemId).toBe('stg-1');
    expect(resolveCalls[0].persona).toContain('health');

    // 2. Preference binder ran against the item body and wrote through
    //    core.updateContact with the new dental category.
    expect(updateContactCalls).toHaveLength(1);
    expect(updateContactCalls[0].did).toBe('did:plc:drcarl');
    expect(updateContactCalls[0].preferredFor).toEqual(['dental']);
  });

  it('re-ingesting the same item is a no-op on the contact (no duplicate preferredFor write)', async () => {
    // Pre-seed Dr Carl with the dental preference already set.
    addContact('did:plc:drcarl', 'Dr Carl', 'trusted', 'summary', 'acquaintance');
    const { setPreferredFor } = await import('../../../core/src/contacts/directory');
    setPreferredFor('did:plc:drcarl', ['dental']);

    const updateContactCalls: Array<{ did: string }> = [];
    const core = {
      async claimStagingItems() {
        return [
          {
            id: 'stg-2',
            type: 'note',
            source: 'chat',
            sender: 'self',
            body: 'My dentist Dr Carl again.',
            summary: 'another dental visit',
          },
        ];
      },
      async resolveStagingItem() {
        return { ok: true };
      },
      async failStagingItem() {
        /* noop */
      },
      async memoryTouch(req: { topic: string }) {
        return { status: 'ok' as const, canonical: req.topic };
      },
      async updateContact(did: string) {
        updateContactCalls.push({ did });
      },
    } as unknown as BrainCoreClient & StagingDrainCoreClient;

    const topicTouch = buildStagingEnrichment({ core });
    const scheduler = new StagingDrainScheduler({
      core,
      drain: { topicTouch },
      setInterval: () => 1,
      clearInterval: () => {
        /* noop */
      },
    });
    scheduler.start();
    await scheduler.flush();

    // No-delta merge: the category was already on the contact, so the
    // pipeline must skip the write entirely. This is the invariant
    // flagged by main-dina 630d217 / PC-BRAIN-13's acceptance criteria.
    expect(updateContactCalls).toHaveLength(0);
  });

  it('preference binder is fail-soft: core.updateContact throwing does not flip the drain to failed', async () => {
    addContact('did:plc:drcarl', 'Dr Carl', 'trusted', 'summary', 'acquaintance');

    const resolveCalls: unknown[] = [];
    const core = {
      async claimStagingItems() {
        return [
          {
            id: 'stg-3',
            type: 'note',
            source: 'chat',
            sender: 'self',
            body: 'My dentist Dr Carl.',
            summary: 'dental',
          },
        ];
      },
      async resolveStagingItem(...args: unknown[]) {
        resolveCalls.push(args);
        return { ok: true };
      },
      async failStagingItem() {
        /* not expected to fire */
      },
      async memoryTouch(req: { topic: string }) {
        return { status: 'ok' as const, canonical: req.topic };
      },
      async updateContact() {
        throw new Error('core offline');
      },
    } as unknown as BrainCoreClient & StagingDrainCoreClient;

    const topicTouch = buildStagingEnrichment({ core });
    const scheduler = new StagingDrainScheduler({
      core,
      drain: { topicTouch },
      setInterval: () => 1,
      clearInterval: () => {
        /* noop */
      },
    });
    scheduler.start();
    await scheduler.flush();

    // Resolve still fires (item lands in vault). The updateContact
    // throw must not escape — it's counted as `preferencesFailed`
    // inside the pipeline, never as an ingest failure.
    expect(resolveCalls).toHaveLength(1);
  });
});
