/**
 * Topic-touch pipeline tests (PC-BRAIN-13 + PC-TEST-06).
 *
 * Exercises the ingest-time hook end-to-end with fakes for the
 * extractor, preference extractor, contact resolver, and Core
 * client. Replaces the retired live-capability / discoverability
 * cache tests (PC-BRAIN-14 / PC-TEST-05).
 *
 * Coverage:
 *   - Per-persona fan-out on topic touches.
 *   - Per-topic try/catch — single failure doesn't stop the batch.
 *   - sample_item_id prefixing.
 *   - Empty-persona fallback → ['general'].
 *   - Skipped status logged but counted as "touched" (soft no-op).
 *   - Extractor-throws fail-soft (no memoryTouch calls).
 *   - Preference binding: fires when a candidate matches a contact.
 *   - Preference binding: honorific-stripped fallback lookup.
 *   - Preference binding: no-delta merge skips the network write.
 *   - Preference binding: failing updateContact does not flip
 *     item status (counted as preferencesFailed only).
 *   - Preference binding: no extractor / resolver → skipped silently.
 */

import {
  touchTopicsForItem,
  type TopicTouchCoreClient,
  type TouchableItem,
  type ContactResolver,
  type ResolvedContact,
} from '../../src/enrichment/topic_touch_pipeline';
import { TopicExtractor, type TopicExtractionResult } from '../../src/enrichment/topic_extractor';
import { PreferenceExtractor } from '../../src/enrichment/preference_extractor';

function stubExtractor(result: TopicExtractionResult): TopicExtractor {
  const ex = new TopicExtractor({ llm: async () => '{}' });
  ex.extract = async () => result;
  return ex;
}

interface CoreCapture {
  core: TopicTouchCoreClient;
  touchCalls: Array<Record<string, unknown>>;
  updateCalls: Array<{ did: string; preferredFor?: string[] }>;
  nextUpdateError?: Error;
}

function stubCore(opts: { onUpdateError?: Error } = {}): CoreCapture {
  const touchCalls: Array<Record<string, unknown>> = [];
  const updateCalls: Array<{ did: string; preferredFor?: string[] }> = [];
  const capture: CoreCapture = {
    core: {
      async memoryTouch(req) {
        touchCalls.push(req as unknown as Record<string, unknown>);
        return { status: 'ok' as const, canonical: req.topic };
      },
      async updateContact(did, updates) {
        updateCalls.push({ did, preferredFor: updates.preferredFor });
        if (opts.onUpdateError) throw opts.onUpdateError;
      },
    },
    touchCalls,
    updateCalls,
  };
  return capture;
}

function resolverFrom(contacts: Record<string, ResolvedContact>): ContactResolver {
  // Case-insensitive keyed map.
  const lower = new Map<string, ResolvedContact>();
  for (const [k, v] of Object.entries(contacts)) {
    lower.set(k.toLowerCase(), v);
  }
  return (name) => lower.get(name.toLowerCase()) ?? null;
}

const baseItem: TouchableItem = {
  id: 'stg-42',
  personas: ['health'],
  summary: 'Dr Carl called about the appointment',
};

// ---------------------------------------------------------------------------
// Topic touches (unchanged behaviour from WM-BRAIN-03)
// ---------------------------------------------------------------------------

describe('touchTopicsForItem — topic touches', () => {
  it('touches one entity + one theme per persona', async () => {
    const extractor = stubExtractor({ entities: ['Dr Carl'], themes: ['knee rehab'] });
    const { core, touchCalls } = stubCore();
    const result = await touchTopicsForItem(
      { ...baseItem, personas: ['health', 'general'] },
      { extractor, core },
    );
    expect(result.touched).toBe(4);
    expect(result.failed).toBe(0);
    expect(result.preferencesBound).toBe(0);
    expect(touchCalls).toHaveLength(4);
    expect(touchCalls.filter((c) => c.persona === 'health')).toHaveLength(2);
    expect(touchCalls.filter((c) => c.persona === 'general')).toHaveLength(2);
  });

  it('forwards sample_item_id as stg-<id>', async () => {
    const extractor = stubExtractor({ entities: ['Sancho'], themes: [] });
    const { core, touchCalls } = stubCore();
    await touchTopicsForItem({ ...baseItem, id: '42' }, { extractor, core });
    expect(touchCalls[0].sampleItemId).toBe('stg-42');
  });

  it('falls back to ["general"] when item.personas is empty', async () => {
    const extractor = stubExtractor({ entities: ['Alpha'], themes: [] });
    const { core, touchCalls } = stubCore();
    await touchTopicsForItem({ ...baseItem, personas: [] }, { extractor, core });
    expect(touchCalls).toHaveLength(1);
    expect(touchCalls[0].persona).toBe('general');
  });

  it('tags entity rows with kind:entity and theme rows with kind:theme', async () => {
    const extractor = stubExtractor({ entities: ['Dr Carl'], themes: ['knee rehab'] });
    const { core, touchCalls } = stubCore();
    await touchTopicsForItem(baseItem, { extractor, core });
    expect(touchCalls.find((c) => c.topic === 'Dr Carl')!.kind).toBe('entity');
    expect(touchCalls.find((c) => c.topic === 'knee rehab')!.kind).toBe('theme');
  });

  it('per-topic try/catch: one failed touch does not stop the batch', async () => {
    const extractor = stubExtractor({ entities: ['A', 'B'], themes: ['c'] });
    const touchCalls: Array<Record<string, unknown>> = [];
    const core: TopicTouchCoreClient = {
      async memoryTouch(req) {
        touchCalls.push(req as unknown as Record<string, unknown>);
        if (req.topic === 'B') throw new Error('transient');
        return { status: 'ok', canonical: req.topic };
      },
      async updateContact() {
        /* unused */
      },
    };
    const logs: Array<Record<string, unknown>> = [];
    const res = await touchTopicsForItem(baseItem, {
      extractor,
      core,
      logger: (e) => logs.push(e),
    });
    expect(res.touched).toBe(2);
    expect(res.failed).toBe(1);
    expect(touchCalls.map((c) => c.topic)).toEqual(['A', 'B', 'c']);
    const fail = logs.find((l) => l.event === 'memory_touch.failed');
    expect(fail!.topic).toBe('B');
  });

  it('logs a skipped status but counts it as touched', async () => {
    const extractor = stubExtractor({ entities: ['Alpha'], themes: [] });
    const logs: Array<Record<string, unknown>> = [];
    const core: TopicTouchCoreClient = {
      async memoryTouch() {
        return { status: 'skipped', reason: 'persona not open' };
      },
      async updateContact() {
        /* unused */
      },
    };
    const res = await touchTopicsForItem(baseItem, {
      extractor,
      core,
      logger: (e) => logs.push(e),
    });
    expect(res.touched).toBe(1);
    expect(res.failed).toBe(0);
    expect(logs.find((l) => l.event === 'memory_touch.skipped')!.reason).toBe('persona not open');
  });

  it('returns 0/0 + logs when the extractor throws (belt-and-braces)', async () => {
    const extractor = new TopicExtractor({ llm: async () => '{}' });
    extractor.extract = async () => {
      throw new Error('extractor boom');
    };
    const { core, touchCalls, updateCalls } = stubCore();
    const logs: Array<Record<string, unknown>> = [];
    const res = await touchTopicsForItem(baseItem, {
      extractor,
      core,
      logger: (e) => logs.push(e),
    });
    expect(res).toEqual({
      touched: 0,
      failed: 0,
      preferencesBound: 0,
      preferencesFailed: 0,
    });
    expect(touchCalls).toHaveLength(0);
    expect(updateCalls).toHaveLength(0);
    expect(logs.find((l) => l.event === 'memory_touch.extract_failed')).toMatchObject({
      item_id: 'stg-42',
      error: 'extractor boom',
    });
  });
});

// ---------------------------------------------------------------------------
// Preference bindings (PC-BRAIN-13 / PC-TEST-06)
// ---------------------------------------------------------------------------

describe('touchTopicsForItem — preference bindings', () => {
  it('fires when a candidate matches a contact — categories merged, updateContact called', async () => {
    const extractor = stubExtractor({ entities: [], themes: [] });
    const preferenceExtractor = new PreferenceExtractor();
    const { core, updateCalls } = stubCore();
    const resolveContact = resolverFrom({
      'Dr Carl': { did: 'did:plc:drcarl', preferredFor: [] },
    });
    const res = await touchTopicsForItem(
      { ...baseItem, body: 'my dentist Dr Carl is on April 19' },
      { extractor, core, preferenceExtractor, resolveContact },
    );
    expect(res.preferencesBound).toBe(1);
    expect(res.preferencesFailed).toBe(0);
    expect(updateCalls).toEqual([{ did: 'did:plc:drcarl', preferredFor: ['dental'] }]);
  });

  it('scans summary + body together', async () => {
    const extractor = stubExtractor({ entities: [], themes: [] });
    const preferenceExtractor = new PreferenceExtractor();
    const { core, updateCalls } = stubCore();
    const resolveContact = resolverFrom({
      Linda: { did: 'did:plc:linda', preferredFor: [] },
    });
    await touchTopicsForItem(
      { ...baseItem, summary: 'quick note', body: 'my accountant is Linda' },
      { extractor, core, preferenceExtractor, resolveContact },
    );
    expect(updateCalls[0].did).toBe('did:plc:linda');
    // Accountant → ['tax', 'accounting'] (multi-category role).
    expect(updateCalls[0].preferredFor).toEqual(['tax', 'accounting']);
  });

  it('merges categories into an existing preferredFor (set-union)', async () => {
    const extractor = stubExtractor({ entities: [], themes: [] });
    const preferenceExtractor = new PreferenceExtractor();
    const { core, updateCalls } = stubCore();
    const resolveContact = resolverFrom({
      // Linda already handles `tax`; the extractor will add `accounting`.
      Linda: { did: 'did:plc:linda', preferredFor: ['tax'] },
    });
    await touchTopicsForItem(
      { ...baseItem, body: 'my accountant Linda is great' },
      { extractor, core, preferenceExtractor, resolveContact },
    );
    expect(updateCalls[0].preferredFor).toEqual(['tax', 'accounting']);
  });

  it('skips the update when the merge yields no new categories (no network write)', async () => {
    const extractor = stubExtractor({ entities: [], themes: [] });
    const preferenceExtractor = new PreferenceExtractor();
    const { core, updateCalls } = stubCore();
    const resolveContact = resolverFrom({
      'Dr Carl': { did: 'did:plc:drcarl', preferredFor: ['dental'] },
    });
    const res = await touchTopicsForItem(
      { ...baseItem, body: 'my dentist Dr Carl is on April 19' },
      { extractor, core, preferenceExtractor, resolveContact },
    );
    // Merge is already a subset — no delta, no write.
    expect(updateCalls).toHaveLength(0);
    expect(res.preferencesBound).toBe(0);
    expect(res.preferencesFailed).toBe(0);
  });

  it('secondary lookup: honorific-stripped name matches contact keyed on bare name', async () => {
    const extractor = stubExtractor({ entities: [], themes: [] });
    const preferenceExtractor = new PreferenceExtractor();
    const { core, updateCalls } = stubCore();
    // Contact stored as "Carl Jones" — no alias for "Dr Carl". The
    // pipeline's secondary lookup strips the "Dr " honorific and
    // retries with "Carl" which... actually that won't match either.
    // Let me index "Carl Jones" and expect it to be found when
    // the candidate is "Dr Carl Jones".
    const resolveContact = resolverFrom({
      'Carl Jones': { did: 'did:plc:carl', preferredFor: [] },
    });
    await touchTopicsForItem(
      { ...baseItem, body: 'my dentist Dr Carl Jones is on Tue' },
      { extractor, core, preferenceExtractor, resolveContact },
    );
    expect(updateCalls).toEqual([{ did: 'did:plc:carl', preferredFor: ['dental'] }]);
  });

  it('logs no_contact when nothing resolves (does not throw)', async () => {
    const extractor = stubExtractor({ entities: [], themes: [] });
    const preferenceExtractor = new PreferenceExtractor();
    const { core, updateCalls } = stubCore();
    const resolveContact = resolverFrom({});
    const logs: Array<Record<string, unknown>> = [];
    const res = await touchTopicsForItem(
      { ...baseItem, body: 'my dentist Dr Carl is on April 19' },
      {
        extractor,
        core,
        preferenceExtractor,
        resolveContact,
        logger: (e) => logs.push(e),
      },
    );
    expect(res.preferencesBound).toBe(0);
    expect(res.preferencesFailed).toBe(0);
    expect(updateCalls).toHaveLength(0);
    const miss = logs.find((l) => l.event === 'preference_bind.no_contact');
    expect(miss).toMatchObject({ role: 'dentist', name: 'Dr Carl' });
  });

  it('fail-soft: updateContact throwing counts as preferencesFailed — no ingest failure', async () => {
    const extractor = stubExtractor({ entities: [], themes: [] });
    const preferenceExtractor = new PreferenceExtractor();
    const { core, updateCalls } = stubCore({
      onUpdateError: new Error('core 503'),
    });
    const resolveContact = resolverFrom({
      'Dr Carl': { did: 'did:plc:drcarl', preferredFor: [] },
    });
    const logs: Array<Record<string, unknown>> = [];
    const res = await touchTopicsForItem(
      { ...baseItem, body: 'my dentist Dr Carl' },
      {
        extractor,
        core,
        preferenceExtractor,
        resolveContact,
        logger: (e) => logs.push(e),
      },
    );
    // The update was attempted (and threw). Fail-soft: pipeline
    // returns with preferencesFailed=1, NOT a thrown exception.
    expect(updateCalls).toHaveLength(1);
    expect(res.preferencesBound).toBe(0);
    expect(res.preferencesFailed).toBe(1);
    expect(logs.find((l) => l.event === 'preference_bind.update_failed')).toMatchObject({
      did: 'did:plc:drcarl',
      error: 'core 503',
    });
  });

  it('skips preference binding when preferenceExtractor is omitted', async () => {
    const extractor = stubExtractor({ entities: [], themes: [] });
    const { core, updateCalls } = stubCore();
    const resolveContact = resolverFrom({
      'Dr Carl': { did: 'did:plc:drcarl', preferredFor: [] },
    });
    await touchTopicsForItem(
      { ...baseItem, body: 'my dentist Dr Carl is on Tue' },
      { extractor, core, resolveContact }, // no preferenceExtractor
    );
    expect(updateCalls).toEqual([]);
  });

  it('skips preference binding when resolveContact is omitted', async () => {
    const extractor = stubExtractor({ entities: [], themes: [] });
    const preferenceExtractor = new PreferenceExtractor();
    const { core, updateCalls } = stubCore();
    await touchTopicsForItem(
      { ...baseItem, body: 'my dentist Dr Carl is on Tue' },
      { extractor, core, preferenceExtractor }, // no resolveContact
    );
    expect(updateCalls).toEqual([]);
  });

  it('no text (empty summary + body) skips preference binding entirely', async () => {
    const extractor = stubExtractor({ entities: [], themes: [] });
    const preferenceExtractor = new PreferenceExtractor();
    const { core, updateCalls } = stubCore();
    const resolveContact: ContactResolver = jest.fn(() => null);
    await touchTopicsForItem(
      { ...baseItem, summary: '', body: '' },
      { extractor, core, preferenceExtractor, resolveContact },
    );
    expect(resolveContact).not.toHaveBeenCalled();
    expect(updateCalls).toEqual([]);
  });

  it('topic touches still run even when preference binding is misconfigured', async () => {
    // The preference block runs AFTER topic touches; extractor-only
    // errors in the preference flow must not affect the topic count.
    const extractor = stubExtractor({ entities: ['Dr Carl'], themes: [] });
    const preferenceExtractor = new PreferenceExtractor();
    const { core, touchCalls } = stubCore({
      onUpdateError: new Error('core 500'),
    });
    const resolveContact = resolverFrom({
      'Dr Carl': { did: 'did:plc:drcarl', preferredFor: [] },
    });
    const res = await touchTopicsForItem(
      { ...baseItem, body: 'my dentist Dr Carl' },
      { extractor, core, preferenceExtractor, resolveContact },
    );
    expect(res.touched).toBe(1); // topic touch landed
    expect(touchCalls).toHaveLength(1);
    expect(res.preferencesFailed).toBe(1); // update threw
  });

  it('multiple candidates in one ingest fan out into multiple updates', async () => {
    const extractor = stubExtractor({ entities: [], themes: [] });
    const preferenceExtractor = new PreferenceExtractor();
    const { core, updateCalls } = stubCore();
    const resolveContact = resolverFrom({
      'Dr Carl': { did: 'did:plc:drcarl', preferredFor: [] },
      'Kate Jones': { did: 'did:plc:kate', preferredFor: [] },
    });
    const text = 'My dentist Dr Carl is on April 19. My lawyer Kate Jones is good.';
    const res = await touchTopicsForItem(
      { ...baseItem, body: text },
      { extractor, core, preferenceExtractor, resolveContact },
    );
    expect(res.preferencesBound).toBe(2);
    expect(updateCalls).toEqual([
      { did: 'did:plc:drcarl', preferredFor: ['dental'] },
      { did: 'did:plc:kate', preferredFor: ['legal'] },
    ]);
  });
});
