/**
 * briefing_orchestrator tests.
 */

import { NullCoreClient, type CoreOutcome, type VaultItem } from '../src/brain/core_client';
import type { DigestItem } from '../src/brain/digest_assembler';
import { TopicTocStore } from '../src/brain/topic_toc_store';
import {
  DEFAULT_MAX_ITEMS,
  createBriefingOrchestrator,
  type BriefingRequest,
} from '../src/brain/briefing_orchestrator';

function vaultItem(overrides: Partial<VaultItem> = {}): VaultItem {
  return {
    id: 'v1',
    persona: 'general',
    type: 'email',
    source: 'gmail',
    summary: 'Sample summary',
    timestamp: 1_700_000_000,
    ...overrides,
  };
}

function stubCore(items: VaultItem[], error?: string): NullCoreClient {
  const core = new NullCoreClient({ recordCalls: true });
  (core as unknown as { queryVault: (q: unknown) => Promise<CoreOutcome<VaultItem[]>> }).queryVault =
    async () => {
      if (error !== undefined) {
        return { ok: false, error: { code: 'core_error', message: error } };
      }
      return { ok: true, value: items };
    };
  return core;
}

function makeStore(): TopicTocStore {
  return new TopicTocStore({
    nowMsFn: () => 1_700_000_000_000,
  });
}

function base(overrides: Partial<BriefingRequest> = {}): BriefingRequest {
  return { persona: 'general', ...overrides };
}

describe('createBriefingOrchestrator — construction', () => {
  it.each([
    ['core', { topicStore: makeStore() }],
    ['topicStore', { core: new NullCoreClient() }],
  ] as const)('throws without %s', (_l, bad) => {
    expect(() =>
      createBriefingOrchestrator(
        bad as unknown as Parameters<typeof createBriefingOrchestrator>[0],
      ),
    ).toThrow();
  });

  it('DEFAULT_MAX_ITEMS is 30', () => {
    expect(DEFAULT_MAX_ITEMS).toBe(30);
  });
});

describe('createBriefingOrchestrator — input validation', () => {
  const briefing = createBriefingOrchestrator({
    core: new NullCoreClient(),
    topicStore: makeStore(),
  });

  it.each([
    ['null request', null],
    ['empty persona', { persona: '' }],
    ['zero maxItems', { persona: 'p', maxItems: 0 }],
    ['fraction maxItems', { persona: 'p', maxItems: 1.5 }],
    ['non-finite sinceSeconds', { persona: 'p', sinceSeconds: Number.NaN }],
  ] as const)('%s → invalid_input', async (_l, bad) => {
    const r = await briefing(bad as BriefingRequest);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid_input');
  });
});

describe('createBriefingOrchestrator — happy path', () => {
  it('empty vault + empty topic store → digest with zero items + topics', async () => {
    const core = stubCore([]);
    const briefing = createBriefingOrchestrator({
      core,
      topicStore: makeStore(),
      nowMsFn: () => 1_700_000_000_000,
    });
    const r = await briefing(base());
    if (!r.ok) throw new Error('expected ok');
    expect(r.itemsFetched).toBe(0);
    expect(r.topicsConsidered).toBe(0);
    expect(r.digest.totals.itemsConsidered).toBe(0);
  });

  it('vault items surface in the engagement bucket by default', async () => {
    const core = stubCore([
      vaultItem({ id: 'v-a', summary: 'A', timestamp: 1 }),
      vaultItem({ id: 'v-b', summary: 'B', timestamp: 2 }),
    ]);
    const briefing = createBriefingOrchestrator({
      core,
      topicStore: makeStore(),
      nowMsFn: () => 1_700_000_000_000,
    });
    const r = await briefing(base());
    if (!r.ok) throw new Error('expected ok');
    expect(r.digest.buckets.engagement.items.map((i) => i.id).sort()).toEqual(['v-a', 'v-b']);
  });

  it('topic snapshot flows into the digest (ordered by score)', async () => {
    const store = makeStore();
    store.observe([
      { label: 'meeting', weight: 2 },
      { label: 'project', weight: 1 },
    ]);
    const core = stubCore([]);
    const briefing = createBriefingOrchestrator({
      core,
      topicStore: store,
      nowMsFn: () => 1_700_000_000_000,
    });
    const r = await briefing(base());
    if (!r.ok) throw new Error('expected ok');
    expect(r.topicsConsidered).toBe(2);
    expect(r.digest.topics[0]!.label).toBe('meeting');
  });

  it('maxTopics cap propagates to the digest', async () => {
    const store = makeStore();
    store.observe([
      { label: 'a', weight: 1 },
      { label: 'b', weight: 2 },
      { label: 'c', weight: 3 },
    ]);
    const briefing = createBriefingOrchestrator({
      core: stubCore([]),
      topicStore: store,
      nowMsFn: () => 1_700_000_000_000,
      maxTopics: 2,
    });
    const r = await briefing(base());
    if (!r.ok) throw new Error('expected ok');
    expect(r.digest.topics).toHaveLength(2);
    expect(r.digest.topics[0]!.label).toBe('c');
  });

  it('headline + contacts flow into the digest', async () => {
    const briefing = createBriefingOrchestrator({
      core: stubCore([]),
      topicStore: makeStore(),
    });
    const r = await briefing(
      base({
        headline: 'Good morning',
        contacts: [{ id: 'c1', name: 'Alice' }],
      }),
    );
    if (!r.ok) throw new Error('expected ok');
    expect(r.digest.headline).toBe('Good morning');
    expect(r.digest.contacts).toHaveLength(1);
  });

  it('queryVault receives expected params', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const core = new NullCoreClient();
    (core as unknown as { queryVault: (q: unknown) => Promise<CoreOutcome<VaultItem[]>> }).queryVault =
      async (q: unknown) => {
        calls.push(q as Record<string, unknown>);
        return { ok: true, value: [] };
      };
    const briefing = createBriefingOrchestrator({
      core,
      topicStore: makeStore(),
    });
    await briefing(
      base({
        query: 'today',
        maxItems: 12,
        types: ['email', 'calendar'],
        sinceSeconds: 1_700_000_000,
      }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      persona: 'general',
      query: 'today',
      maxItems: 12,
      types: ['email', 'calendar'],
      sinceSeconds: 1_700_000_000,
    });
  });

  it('item body falls back from body → bodyText', async () => {
    const core = stubCore([
      vaultItem({ id: 'a', body: 'B-real' }),
      vaultItem({ id: 'b', body: undefined, bodyText: 'BT' }),
      vaultItem({ id: 'c', body: undefined, bodyText: undefined }),
    ]);
    const briefing = createBriefingOrchestrator({
      core,
      topicStore: makeStore(),
    });
    const r = await briefing(base());
    if (!r.ok) throw new Error('expected ok');
    const bodies = r.digest.buckets.engagement.items.map((i) => i.body);
    expect(bodies).toContain('B-real');
    expect(bodies).toContain('BT');
    expect(bodies).toContain(undefined);
  });
});

describe('createBriefingOrchestrator — reminders + events fetchers', () => {
  it('reminders + events items merge into the digest', async () => {
    const now = 1_700_000_000;
    const core = stubCore([vaultItem({ id: 'v-1' })]);
    const briefing = createBriefingOrchestrator({
      core,
      topicStore: makeStore(),
      nowMsFn: () => now * 1000,
      reminders: async () => [
        { id: 'r-1', title: 'Pay bill', at: now + 3600, kind: 'reminder' },
      ],
      events: async () => [
        { id: 'e-1', title: 'Meeting', at: now + 1800, kind: 'event' },
      ],
    });
    const r = await briefing(base());
    if (!r.ok) throw new Error('expected ok');
    expect(r.itemsFetched).toBe(3);
    const solicited = r.digest.buckets.solicited.items.map((i) => i.id);
    expect(solicited).toContain('r-1');
    expect(solicited).toContain('e-1');
  });

  it('reminders throws → reminders_failed', async () => {
    const briefing = createBriefingOrchestrator({
      core: stubCore([]),
      topicStore: makeStore(),
      reminders: async () => {
        throw new Error('db down');
      },
    });
    const r = await briefing(base());
    if (r.ok) throw new Error('expected failure');
    expect(r.reason).toBe('reminders_failed');
    expect(r.detail).toBe('db down');
  });

  it('events throws → events_failed', async () => {
    const briefing = createBriefingOrchestrator({
      core: stubCore([]),
      topicStore: makeStore(),
      events: async () => {
        throw new Error('calendar dead');
      },
    });
    const r = await briefing(base());
    if (r.ok) throw new Error('expected failure');
    expect(r.reason).toBe('events_failed');
  });
});

describe('createBriefingOrchestrator — failure paths', () => {
  it('vault query fails → vault_query_failed', async () => {
    const briefing = createBriefingOrchestrator({
      core: stubCore([], 'db unreachable'),
      topicStore: makeStore(),
    });
    const r = await briefing(base());
    if (r.ok) throw new Error('expected failure');
    expect(r.reason).toBe('vault_query_failed');
    expect(r.detail).toBe('db unreachable');
  });
});
