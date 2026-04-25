/**
 * BriefingHistoryStore — adapter pattern + record/list/get/purge
 * surface, with bounded retention via the in-memory adapter's cap.
 */

import {
  BriefingHistoryStore,
  DEFAULT_LIST_LIMIT,
  DEFAULT_MAX_ENTRIES,
  InMemoryBriefingHistoryAdapter,
  MAX_LIST_LIMIT,
  type BriefingHistoryEntry,
  type BriefingHistoryEvent,
  type BriefingHistoryItem,
  type BriefingHistoryRecordInput,
} from '../src/brain/briefing_history';

function fixedClock(start = 1_700_000_000_000) {
  let now = start;
  return {
    nowMsFn: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    set: (ms: number) => {
      now = ms;
    },
  };
}

const sampleItem: BriefingHistoryItem = {
  id: 'vault-1',
  title: 'Lunch with Pam tomorrow',
  priority: 'engagement',
  kind: 'event',
};

const sampleInput: BriefingHistoryRecordInput = {
  persona: 'general',
  items: [sampleItem],
  totalConsidered: 1,
};

describe('Constants', () => {
  it('export expected defaults', () => {
    expect(DEFAULT_LIST_LIMIT).toBe(50);
    expect(MAX_LIST_LIMIT).toBe(1000);
    expect(DEFAULT_MAX_ENTRIES).toBe(1000);
  });
});

describe('InMemoryBriefingHistoryAdapter', () => {
  it('insert + get round-trips a defensive copy', async () => {
    const adapter = new InMemoryBriefingHistoryAdapter();
    const entry: BriefingHistoryEntry = {
      id: 'e1',
      persona: 'general',
      sentAtMs: 1000,
      items: [sampleItem],
      totalConsidered: 1,
      itemCount: 1,
    };
    await adapter.insert(entry);
    const got = await adapter.get('e1');
    expect(got).toEqual(entry);
    // Defensive copy semantics
    expect(got).not.toBe(entry);
    expect(got!.items).not.toBe(entry.items);
  });

  it('duplicate insert throws', async () => {
    const adapter = new InMemoryBriefingHistoryAdapter();
    const e: BriefingHistoryEntry = {
      id: 'e1',
      persona: 'general',
      sentAtMs: 1,
      items: [],
      totalConsidered: 0,
      itemCount: 0,
    };
    await adapter.insert(e);
    await expect(adapter.insert(e)).rejects.toThrow(/duplicate id/);
  });

  it('get returns null for unknown id', async () => {
    const adapter = new InMemoryBriefingHistoryAdapter();
    expect(await adapter.get('ghost')).toBeNull();
  });

  it('eviction: at capacity, oldest by sentAtMs is dropped', async () => {
    const evicted: string[] = [];
    const adapter = new InMemoryBriefingHistoryAdapter({
      maxEntries: 2,
      onEvict: (id) => evicted.push(id),
    });
    const mk = (id: string, sentAtMs: number): BriefingHistoryEntry => ({
      id,
      persona: 'general',
      sentAtMs,
      items: [],
      totalConsidered: 0,
      itemCount: 0,
    });
    await adapter.insert(mk('a', 100));
    await adapter.insert(mk('b', 200));
    await adapter.insert(mk('c', 300));
    expect(evicted).toEqual(['a']);
    expect(await adapter.get('a')).toBeNull();
    expect(await adapter.get('b')).not.toBeNull();
    expect(await adapter.get('c')).not.toBeNull();
  });

  it('rejects bad maxEntries', () => {
    expect(() => new InMemoryBriefingHistoryAdapter({ maxEntries: 0 })).toThrow(
      /positive integer/,
    );
    expect(() => new InMemoryBriefingHistoryAdapter({ maxEntries: -1 })).toThrow(
      /positive integer/,
    );
    expect(() => new InMemoryBriefingHistoryAdapter({ maxEntries: 1.5 })).toThrow(
      /positive integer/,
    );
  });

  it('query sorts DESC by sentAtMs', async () => {
    const adapter = new InMemoryBriefingHistoryAdapter();
    const mk = (id: string, sentAtMs: number): BriefingHistoryEntry => ({
      id,
      persona: 'general',
      sentAtMs,
      items: [],
      totalConsidered: 0,
      itemCount: 0,
    });
    await adapter.insert(mk('a', 100));
    await adapter.insert(mk('c', 300));
    await adapter.insert(mk('b', 200));
    const got = await adapter.query({});
    expect(got.map((e) => e.id)).toEqual(['c', 'b', 'a']);
  });

  it('purgeOlderThan drops entries strictly below cutoff', async () => {
    const adapter = new InMemoryBriefingHistoryAdapter();
    const mk = (id: string, sentAtMs: number): BriefingHistoryEntry => ({
      id,
      persona: 'general',
      sentAtMs,
      items: [],
      totalConsidered: 0,
      itemCount: 0,
    });
    await adapter.insert(mk('a', 100));
    await adapter.insert(mk('b', 200));
    await adapter.insert(mk('c', 300));
    expect(await adapter.purgeOlderThan(250)).toBe(2);
    expect(await adapter.query({})).toHaveLength(1);
    expect((await adapter.query({}))[0]!.id).toBe('c');
  });
});

describe('BriefingHistoryStore construction', () => {
  it('throws when adapter missing', () => {
    expect(
      () =>
        // @ts-expect-error testing runtime guard
        new BriefingHistoryStore({}),
    ).toThrow(/adapter is required/);
  });

  it('throws when options not an object', () => {
    expect(
      () =>
        // @ts-expect-error testing runtime guard
        new BriefingHistoryStore(null),
    ).toThrow(/options required/);
  });

  it('uses Date.now by default; idFn generates bh-N counter', async () => {
    const adapter = new InMemoryBriefingHistoryAdapter();
    const store = new BriefingHistoryStore({ adapter });
    const e1 = await store.record(sampleInput);
    const e2 = await store.record(sampleInput);
    expect(e1.id).toBe('bh-1');
    expect(e2.id).toBe('bh-2');
    expect(typeof e1.sentAtMs).toBe('number');
  });
});

describe('BriefingHistoryStore.record', () => {
  it('records a valid entry + emits event with defensive copy', async () => {
    const clock = fixedClock();
    const adapter = new InMemoryBriefingHistoryAdapter();
    const events: BriefingHistoryEvent[] = [];
    const store = new BriefingHistoryStore({
      adapter,
      nowMsFn: clock.nowMsFn,
      onEvent: (e) => events.push(e),
    });
    const entry = await store.record({
      ...sampleInput,
      headline: 'Good morning, Alonso',
      meta: { renderMode: 'markdown' },
    });
    expect(entry.id).toBe('bh-1');
    expect(entry.persona).toBe('general');
    expect(entry.sentAtMs).toBe(clock.nowMsFn());
    expect(entry.itemCount).toBe(1);
    expect(entry.totalConsidered).toBe(1);
    expect(entry.headline).toBe('Good morning, Alonso');
    expect(entry.meta).toEqual({ renderMode: 'markdown' });
    expect(events).toHaveLength(1);
    if (events[0]!.kind === 'recorded') {
      expect(events[0].entry.id).toBe('bh-1');
      // Event entry is a defensive copy, mutating it doesn't poison the store
      (events[0].entry as { headline?: string }).headline = 'tampered';
      expect((await store.get('bh-1'))?.headline).toBe('Good morning, Alonso');
    }
  });

  it('honours sentAtMs override', async () => {
    const adapter = new InMemoryBriefingHistoryAdapter();
    const store = new BriefingHistoryStore({ adapter });
    const e = await store.record({ ...sampleInput, sentAtMs: 999 });
    expect(e.sentAtMs).toBe(999);
  });

  it('honours id override', async () => {
    const adapter = new InMemoryBriefingHistoryAdapter();
    const store = new BriefingHistoryStore({ adapter });
    const e = await store.record({ ...sampleInput, id: 'custom-id' });
    expect(e.id).toBe('custom-id');
  });

  it.each([
    ['missing input', null, /input required/],
    ['missing persona', { items: [], totalConsidered: 0 }, /persona is required/],
    [
      'items not array',
      { persona: 'p', items: 'not-array', totalConsidered: 0 },
      /items must be an array/,
    ],
    [
      'totalConsidered negative',
      { persona: 'p', items: [], totalConsidered: -1 },
      /non-negative finite/,
    ],
    [
      'totalConsidered NaN',
      { persona: 'p', items: [], totalConsidered: NaN },
      /non-negative finite/,
    ],
    [
      'sentAtMs not finite',
      { persona: 'p', items: [], totalConsidered: 0, sentAtMs: Infinity },
      /sentAtMs must be finite/,
    ],
    [
      'empty id override',
      { persona: 'p', items: [], totalConsidered: 0, id: '' },
      /id must be non-empty/,
    ],
  ])('rejects %s', async (_label, badInput, regex) => {
    const adapter = new InMemoryBriefingHistoryAdapter();
    const store = new BriefingHistoryStore({ adapter });
    await expect(store.record(badInput as never)).rejects.toThrow(regex as RegExp);
  });

  it('rejects invalid item shapes', async () => {
    const adapter = new InMemoryBriefingHistoryAdapter();
    const store = new BriefingHistoryStore({ adapter });

    await expect(
      store.record({
        persona: 'p',
        items: [{ id: '', title: 't', priority: 'engagement' }],
        totalConsidered: 0,
      }),
    ).rejects.toThrow(/items\[0\]\.id must be a non-empty string/);

    await expect(
      store.record({
        persona: 'p',
        // @ts-expect-error testing runtime guard
        items: [{ id: 'x', title: 42, priority: 'engagement' }],
        totalConsidered: 0,
      }),
    ).rejects.toThrow(/items\[0\]\.title must be a string/);

    await expect(
      store.record({
        persona: 'p',
        // @ts-expect-error testing runtime guard
        items: [{ id: 'x', title: 't', priority: 'urgent' }],
        totalConsidered: 0,
      }),
    ).rejects.toThrow(/items\[0\]\.priority must be one of/);
  });

  it('caller mutation of input items does not poison the stored entry', async () => {
    const adapter = new InMemoryBriefingHistoryAdapter();
    const store = new BriefingHistoryStore({ adapter });
    const items: BriefingHistoryItem[] = [
      { id: 'i1', title: 'orig', priority: 'engagement' },
    ];
    await store.record({ persona: 'p', items, totalConsidered: 1 });
    items[0]!.title = 'tampered';
    const got = (await store.list())[0]!;
    expect(got.items[0]!.title).toBe('orig');
  });

  it('caller mutation of nested meta does not poison the stored entry (deep clone)', async () => {
    const adapter = new InMemoryBriefingHistoryAdapter();
    const store = new BriefingHistoryStore({ adapter });
    const meta = { context: { client: 'cli', tags: ['morning'] } };
    await store.record({ ...sampleInput, meta });
    // Mutate caller's nested values
    (meta.context as { client: string }).client = 'TAMPERED';
    meta.context.tags.push('TAMPERED');

    const stored = (await store.list())[0]!;
    expect(stored.meta).toBeDefined();
    const ctx = stored.meta!['context'] as { client: string; tags: string[] };
    expect(ctx.client).toBe('cli');
    expect(ctx.tags).toEqual(['morning']);
  });

  it('returned-entry mutation does not poison the store (defensive output copy)', async () => {
    const adapter = new InMemoryBriefingHistoryAdapter();
    const store = new BriefingHistoryStore({ adapter });
    const recorded = await store.record({
      ...sampleInput,
      meta: { context: { tags: ['a'] } },
    });
    // Mutate the returned entry's nested data
    const meta = recorded.meta!['context'] as { tags: string[] };
    meta.tags.push('TAMPERED');

    const fresh = (await store.list())[0]!;
    const freshTags = (fresh.meta!['context'] as { tags: string[] }).tags;
    expect(freshTags).toEqual(['a']);
  });
});

describe('BriefingHistoryStore.get / list / count', () => {
  async function seed(store: BriefingHistoryStore): Promise<void> {
    let t = 1_700_000_000_000;
    await store.record({ ...sampleInput, persona: 'general', sentAtMs: t });
    t += 1000;
    await store.record({ ...sampleInput, persona: 'health', sentAtMs: t });
    t += 1000;
    await store.record({ ...sampleInput, persona: 'general', sentAtMs: t });
  }

  it('list returns DESC by sentAtMs', async () => {
    const adapter = new InMemoryBriefingHistoryAdapter();
    const store = new BriefingHistoryStore({ adapter });
    await seed(store);
    const list = await store.list();
    expect(list.map((e) => e.persona)).toEqual(['general', 'health', 'general']);
    expect(list[0]!.sentAtMs).toBeGreaterThan(list[1]!.sentAtMs);
  });

  it('list filters by persona', async () => {
    const adapter = new InMemoryBriefingHistoryAdapter();
    const store = new BriefingHistoryStore({ adapter });
    await seed(store);
    const list = await store.list({ persona: 'general' });
    expect(list.map((e) => e.persona)).toEqual(['general', 'general']);
  });

  it('list filters by sinceMs and beforeMs', async () => {
    const adapter = new InMemoryBriefingHistoryAdapter();
    const store = new BriefingHistoryStore({ adapter });
    await seed(store);
    const since = 1_700_000_001_000;
    const list = await store.list({ sinceMs: since });
    // Only entries with sentAtMs >= since (the second + third entry)
    expect(list).toHaveLength(2);
    const list2 = await store.list({ beforeMs: since });
    // Only entries with sentAtMs < since (the first entry)
    expect(list2).toHaveLength(1);
  });

  it('list paginates via offset + limit', async () => {
    const adapter = new InMemoryBriefingHistoryAdapter();
    const store = new BriefingHistoryStore({ adapter });
    await seed(store);
    const page1 = await store.list({ limit: 2 });
    expect(page1).toHaveLength(2);
    const page2 = await store.list({ limit: 2, offset: 2 });
    expect(page2).toHaveLength(1);
  });

  it('list clamps limit to MAX_LIST_LIMIT', async () => {
    const adapter = new InMemoryBriefingHistoryAdapter();
    const store = new BriefingHistoryStore({ adapter });
    await seed(store);
    const list = await store.list({ limit: 999_999 });
    expect(list.length).toBeLessThanOrEqual(MAX_LIST_LIMIT);
  });

  it('list invalid limit values fall back to default', async () => {
    const adapter = new InMemoryBriefingHistoryAdapter();
    const store = new BriefingHistoryStore({ adapter });
    await seed(store);
    // 0 and negative both fall back to DEFAULT_LIST_LIMIT (which is > our seed).
    expect(await store.list({ limit: 0 })).toHaveLength(3);
    expect(await store.list({ limit: -5 })).toHaveLength(3);
  });

  it('count matches list length when no pagination is set', async () => {
    const adapter = new InMemoryBriefingHistoryAdapter();
    const store = new BriefingHistoryStore({ adapter });
    await seed(store);
    expect(await store.count()).toBe(3);
    expect(await store.count({ persona: 'health' })).toBe(1);
    expect(await store.count({ persona: 'unknown' })).toBe(0);
  });

  it('get(unknown) returns null', async () => {
    const adapter = new InMemoryBriefingHistoryAdapter();
    const store = new BriefingHistoryStore({ adapter });
    expect(await store.get('ghost')).toBeNull();
  });

  it('get(empty) returns null without hitting adapter', async () => {
    const adapter = new InMemoryBriefingHistoryAdapter();
    const spy = jest.spyOn(adapter, 'get');
    const store = new BriefingHistoryStore({ adapter });
    expect(await store.get('')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('BriefingHistoryStore.purgeOlderThan', () => {
  it('purges + emits event', async () => {
    const adapter = new InMemoryBriefingHistoryAdapter();
    const events: BriefingHistoryEvent[] = [];
    const store = new BriefingHistoryStore({
      adapter,
      onEvent: (e) => events.push(e),
    });
    await store.record({ ...sampleInput, sentAtMs: 100 });
    await store.record({ ...sampleInput, sentAtMs: 200 });
    await store.record({ ...sampleInput, sentAtMs: 300 });

    const purged = await store.purgeOlderThan(250);
    expect(purged).toBe(2);
    expect(events.filter((e) => e.kind === 'purged')).toEqual([
      { kind: 'purged', count: 2, cutoffMs: 250 },
    ]);
    expect(await store.count()).toBe(1);
  });

  it('zero-purged emits no event', async () => {
    const adapter = new InMemoryBriefingHistoryAdapter();
    const events: BriefingHistoryEvent[] = [];
    const store = new BriefingHistoryStore({
      adapter,
      onEvent: (e) => events.push(e),
    });
    await store.record(sampleInput);
    const before = events.length;
    const purged = await store.purgeOlderThan(0);
    expect(purged).toBe(0);
    // Recorded event was emitted; no new purged event after.
    expect(events.length).toBe(before);
  });

  it('rejects non-finite cutoff', async () => {
    const adapter = new InMemoryBriefingHistoryAdapter();
    const store = new BriefingHistoryStore({ adapter });
    await expect(store.purgeOlderThan(NaN)).rejects.toThrow(/cutoffMs must be finite/);
    await expect(store.purgeOlderThan(Infinity)).rejects.toThrow(/cutoffMs must be finite/);
  });
});

describe('BriefingHistoryStore end-to-end', () => {
  it('full flow: seed → list → filter → purge', async () => {
    const clock = fixedClock(1_700_000_000_000);
    const adapter = new InMemoryBriefingHistoryAdapter();
    const events: BriefingHistoryEvent[] = [];
    const store = new BriefingHistoryStore({
      adapter,
      nowMsFn: clock.nowMsFn,
      onEvent: (e) => events.push(e),
    });

    // Day 1: morning briefing for general persona
    await store.record({
      persona: 'general',
      headline: 'Good morning, Alonso',
      items: [
        { id: 'r1', title: 'Lunch with Pam', priority: 'engagement' },
        { id: 'e1', title: 'Bus 42 in 12 min', priority: 'solicited' },
      ],
      totalConsidered: 2,
    });

    clock.advance(60_000); // 1 min later
    // Health briefing
    await store.record({
      persona: 'health',
      items: [{ id: 'h1', title: 'Refill prescription', priority: 'fiduciary' }],
      totalConsidered: 1,
    });

    clock.advance(24 * 60 * 60 * 1000); // next day
    // Day 2: morning briefing for general
    await store.record({
      persona: 'general',
      items: [{ id: 'r2', title: 'Dentist tomorrow', priority: 'solicited' }],
      totalConsidered: 1,
    });

    expect(await store.count()).toBe(3);
    expect(await store.count({ persona: 'general' })).toBe(2);

    const generalList = await store.list({ persona: 'general' });
    expect(generalList).toHaveLength(2);
    expect(generalList[0]!.items[0]!.title).toBe('Dentist tomorrow'); // newest first

    // Retention sweep — drop everything from day 1
    const dayCutoff = clock.nowMsFn() - 12 * 60 * 60 * 1000;
    const purged = await store.purgeOlderThan(dayCutoff);
    expect(purged).toBe(2);
    expect(await store.count()).toBe(1);
    expect((await store.list())[0]!.persona).toBe('general');

    // Events emitted: 3 recorded + 1 purged = 4
    expect(events).toHaveLength(4);
    expect(events.filter((e) => e.kind === 'recorded')).toHaveLength(3);
    expect(events.filter((e) => e.kind === 'purged')).toHaveLength(1);
  });

  it('bounded retention via maxEntries cap evicts oldest automatically', async () => {
    const evicted: string[] = [];
    const adapter = new InMemoryBriefingHistoryAdapter({
      maxEntries: 3,
      onEvict: (id) => evicted.push(id),
    });
    const clock = fixedClock();
    const store = new BriefingHistoryStore({ adapter, nowMsFn: clock.nowMsFn });

    for (let i = 0; i < 5; i += 1) {
      await store.record({ ...sampleInput, sentAtMs: 100 + i });
    }
    expect(evicted).toEqual(['bh-1', 'bh-2']);
    expect(await store.count()).toBe(3);
    const list = await store.list();
    expect(list.map((e) => e.id)).toEqual(['bh-5', 'bh-4', 'bh-3']);
  });
});
