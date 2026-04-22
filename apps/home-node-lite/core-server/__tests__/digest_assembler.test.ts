/**
 * digest_assembler tests.
 */

import {
  DEFAULT_DUE_WITHIN_SEC,
  DEFAULT_EVENT_WINDOW_SEC,
  DEFAULT_MAX_PER_BUCKET,
  assembleDigest,
  type DigestItem,
} from '../src/brain/digest_assembler';

function item(overrides: Partial<DigestItem> = {}): DigestItem {
  return {
    id: 'v1',
    title: 'An item',
    at: 1_700_000_000,
    kind: 'vault',
    ...overrides,
  };
}

describe('assembleDigest — input validation', () => {
  it.each([
    ['null input', null],
    ['non-object input', 'bogus'],
  ] as const)('rejects %s', (_l, bad) => {
    expect(() =>
      assembleDigest(bad as unknown as Parameters<typeof assembleDigest>[0]),
    ).toThrow(/input/);
  });

  it('rejects non-finite nowSec', () => {
    expect(() =>
      assembleDigest({ nowSec: Number.POSITIVE_INFINITY }),
    ).toThrow(/nowSec/);
  });

  it('empty input produces empty buckets', () => {
    const d = assembleDigest({ nowSec: 0 });
    expect(d.buckets.fiduciary.items).toEqual([]);
    expect(d.buckets.solicited.items).toEqual([]);
    expect(d.buckets.engagement.items).toEqual([]);
    expect(d.totals.itemsConsidered).toBe(0);
  });
});

describe('assembleDigest — bucketing rules', () => {
  const now = 1_700_000_000;

  it('explicit priority on item → that bucket', () => {
    const d = assembleDigest({
      nowSec: now,
      items: [
        item({ id: 'a', priority: 'fiduciary', kind: 'nudge' }),
        item({ id: 'b', priority: 'solicited', kind: 'vault' }),
        item({ id: 'c', priority: 'engagement', kind: 'vault' }),
      ],
    });
    expect(d.buckets.fiduciary.items.map((i) => i.id)).toEqual(['a']);
    expect(d.buckets.solicited.items.map((i) => i.id)).toEqual(['b']);
    expect(d.buckets.engagement.items.map((i) => i.id)).toEqual(['c']);
  });

  it('reminder due within window → solicited', () => {
    const d = assembleDigest({
      nowSec: now,
      items: [
        item({ id: 'r-soon', kind: 'reminder', at: now + 3600 }), // 1h away
        item({ id: 'r-late', kind: 'reminder', at: now + DEFAULT_DUE_WITHIN_SEC + 1 }),
        item({ id: 'r-past', kind: 'reminder', at: now - 60 }), // already fired
      ],
    });
    expect(d.buckets.solicited.items.map((i) => i.id)).toEqual(['r-soon']);
    expect(d.buckets.engagement.items.map((i) => i.id).sort()).toEqual(['r-late', 'r-past']);
  });

  it('event within window → solicited', () => {
    const d = assembleDigest({
      nowSec: now,
      items: [
        item({ id: 'e-today', kind: 'event', at: now + 600 }),
        item({ id: 'e-later', kind: 'event', at: now + DEFAULT_EVENT_WINDOW_SEC + 1 }),
      ],
    });
    expect(d.buckets.solicited.items.map((i) => i.id)).toEqual(['e-today']);
    expect(d.buckets.engagement.items.map((i) => i.id)).toEqual(['e-later']);
  });

  it('vault item without priority → engagement', () => {
    const d = assembleDigest({
      nowSec: now,
      items: [item({ id: 'v', kind: 'vault' })],
    });
    expect(d.buckets.engagement.items.map((i) => i.id)).toEqual(['v']);
  });

  it('custom dueWithinSec window applies', () => {
    const d = assembleDigest(
      {
        nowSec: now,
        items: [
          item({ id: 'r', kind: 'reminder', at: now + 3600 }),
        ],
      },
      { dueWithinSec: 1800 }, // stricter than 1h
    );
    expect(d.buckets.engagement.items.map((i) => i.id)).toEqual(['r']);
  });
});

describe('assembleDigest — ordering + dedupe', () => {
  it('items within a bucket are sorted by `at` desc', () => {
    const d = assembleDigest({
      nowSec: 1_000,
      items: [
        item({ id: 'old', at: 100, priority: 'engagement' }),
        item({ id: 'new', at: 500, priority: 'engagement' }),
        item({ id: 'mid', at: 300, priority: 'engagement' }),
      ],
    });
    expect(d.buckets.engagement.items.map((i) => i.id)).toEqual(['new', 'mid', 'old']);
  });

  it('duplicate ids kept only once (first occurrence wins)', () => {
    const d = assembleDigest({
      nowSec: 0,
      items: [
        item({ id: 'dup', priority: 'fiduciary', title: 'first' }),
        item({ id: 'dup', priority: 'engagement', title: 'second' }),
      ],
    });
    expect(d.buckets.fiduciary.items).toHaveLength(1);
    expect(d.buckets.fiduciary.items[0]!.title).toBe('first');
    expect(d.buckets.engagement.items).toHaveLength(0);
    expect(d.totals.itemsDropped).toBe(1);
  });
});

describe('assembleDigest — overflow + caps', () => {
  it('bucket fills to maxPerBucket then overflows', () => {
    const many = Array.from({ length: 15 }, (_, i) =>
      item({ id: `v${i}`, priority: 'engagement', at: i }),
    );
    const d = assembleDigest({ nowSec: 0, items: many });
    expect(d.buckets.engagement.items).toHaveLength(DEFAULT_MAX_PER_BUCKET);
    expect(d.buckets.engagement.overflow).toBe(5);
    expect(d.totals.itemsDropped).toBe(5);
  });

  it('custom maxPerBucket respected', () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      item({ id: `x${i}`, priority: 'fiduciary', at: i }),
    );
    const d = assembleDigest({ nowSec: 0, items: many }, { maxPerBucket: 2 });
    expect(d.buckets.fiduciary.items).toHaveLength(2);
    expect(d.buckets.fiduciary.overflow).toBe(3);
  });

  it('DEFAULT_MAX_PER_BUCKET is 10', () => {
    expect(DEFAULT_MAX_PER_BUCKET).toBe(10);
  });
});

describe('assembleDigest — topics + contacts', () => {
  it('topics sorted by salience desc + capped', () => {
    const d = assembleDigest(
      {
        nowSec: 0,
        topics: [
          { label: 'a', salience: 0.2 },
          { label: 'b', salience: 0.9 },
          { label: 'c', salience: 0.5 },
        ],
      },
      { maxTopics: 2 },
    );
    expect(d.topics.map((t) => t.label)).toEqual(['b', 'c']);
  });

  it('contacts preserved + capped + deep-copied', () => {
    const contacts = [
      { id: 'c1', name: 'Alice', note: 'spouse' },
      { id: 'c2', name: 'Bob' },
      { id: 'c3', name: 'Carol' },
    ];
    const d = assembleDigest(
      { nowSec: 0, contacts },
      { maxContacts: 2 },
    );
    expect(d.contacts).toHaveLength(2);
    // Mutating output doesn't affect input.
    d.contacts[0]!.name = 'hacked';
    expect(contacts[0]!.name).toBe('Alice');
  });
});

describe('assembleDigest — headline + totals', () => {
  it('headline echoed when provided', () => {
    const d = assembleDigest({ nowSec: 0, headline: 'Good morning' });
    expect(d.headline).toBe('Good morning');
  });

  it('headline null when omitted', () => {
    const d = assembleDigest({ nowSec: 0 });
    expect(d.headline).toBeNull();
  });

  it('totals reconcile: considered = included + dropped', () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      item({ id: `v${i}`, priority: 'engagement', at: i }),
    );
    const d = assembleDigest({ nowSec: 0, items: many });
    expect(d.totals.itemsConsidered).toBe(25);
    expect(d.totals.itemsIncluded + d.totals.itemsDropped).toBe(25);
  });
});
