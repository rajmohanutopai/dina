/**
 * MemoryService (WM-CORE-06) — service-level contract tests,
 * including the `MergesAcrossPersonas` case from WM-TEST-01 that was
 * deferred when the repository landed (WM-TEST-01 is split: repo
 * cases live in repository.test.ts; service cases live here).
 *
 * The service is entirely synchronous + deterministic given an
 * injected clock + repo resolver, so we build each test fixture as
 * an isolated in-memory `Map<persona, repo>` instead of mutating
 * the module-global accessor.
 */

import { InMemoryTopicRepository, type TopicRepository } from '../../src/memory/repository';
import { MemoryService } from '../../src/memory/service';

const T0 = 1_700_000_000; // unix seconds
const DAY = 86_400;

function makeRepo(): InMemoryTopicRepository {
  return new InMemoryTopicRepository();
}

function makeService(
  repos: Record<string, TopicRepository>,
  opts: {
    listPersonas?: () => string[];
    nowSecFn?: () => number;
    onWarning?: (e: Record<string, unknown>) => void;
  } = {},
): MemoryService {
  return new MemoryService({
    resolve: (p) => repos[p] ?? null,
    listPersonas: opts.listPersonas ?? (() => Object.keys(repos)),
    nowSecFn: opts.nowSecFn ?? (() => T0),
    onWarning: opts.onWarning,
  });
}

describe('MemoryService.toc — empty cases', () => {
  it('limit <= 0 returns []', async () => {
    const svc = makeService({ general: makeRepo() });
    expect(await svc.toc(undefined, 0)).toEqual([]);
    expect(await svc.toc(undefined, -1)).toEqual([]);
  });

  it('no personas wired returns []', async () => {
    const svc = makeService({});
    expect(await svc.toc(undefined, 10)).toEqual([]);
  });

  it('personas with no topics return []', async () => {
    const svc = makeService({ general: makeRepo(), health: makeRepo() });
    expect(await svc.toc(undefined, 10)).toEqual([]);
  });
});

describe('MemoryService.toc — single persona', () => {
  it('returns topics with persona tagged on each entry', async () => {
    const repo = makeRepo();
    await repo.touch({ topic: 'alpha', kind: 'theme', nowUnix: T0 });
    await repo.touch({ topic: 'beta', kind: 'theme', nowUnix: T0 });
    const svc = makeService({ general: repo });
    const toc = await svc.toc(undefined, 10);
    expect(toc.map((e) => e.persona)).toEqual(['general', 'general']);
    expect(toc.map((e) => e.topic).sort()).toEqual(['alpha', 'beta']);
  });

  it('computes salience at the service clock, not the repo clock', async () => {
    const repo = makeRepo();
    await repo.touch({ topic: 'x', kind: 'theme', nowUnix: T0 });
    // Service clock is T0 + 180 days — salience decays to exp(-1)
    // on s_long (≈ 0.368) plus 0.3 * exp(-180/14) ≈ 0.
    const svc = makeService({ general: repo }, { nowSecFn: () => T0 + 180 * DAY });
    const [entry] = await svc.toc(undefined, 1);
    // s_long was 1.0 → salience ≈ exp(-1) + 0.3 * exp(-180/14)
    const expected = Math.exp(-1) + 0.3 * Math.exp(-180 / 14);
    expect(entry.salience).toBeCloseTo(expected, 9);
  });

  it('forwards sample_item_id when set', async () => {
    // PC-CORE-05/07: `live_capability` / `live_provider_did` removed
    // from Topic / TocEntry. Capability bindings live on the contact
    // row now — see PREFERRED_CONTACTS_PORT_TASKS.md + design §6.1.
    const repo = makeRepo();
    await repo.touch({
      topic: 'Dr Carl',
      kind: 'entity',
      nowUnix: T0,
      sampleItemId: 'item-1',
    });
    const svc = makeService({ health: repo });
    const [entry] = await svc.toc(undefined, 10);
    expect(entry.sample_item_id).toBe('item-1');
    // Retired fields must NEVER appear on a ToC entry.
    expect('live_capability' in entry).toBe(false);
    expect('live_provider_did' in entry).toBe(false);
  });

  it('omits empty optional fields (no "undefined" leaked into the shape)', async () => {
    const repo = makeRepo();
    await repo.touch({ topic: 'alpha', kind: 'theme', nowUnix: T0 });
    const svc = makeService({ general: repo });
    const [entry] = await svc.toc(undefined, 1);
    expect('sample_item_id' in entry).toBe(false);
  });
});

describe('MemoryService.toc — MergesAcrossPersonas (WM-TEST-01 last case)', () => {
  it('interleaves topics from two personas by decayed salience', async () => {
    const general = makeRepo();
    const health = makeRepo();

    // general: two touches on "alpha" at T0.
    await general.touch({ topic: 'alpha', kind: 'theme', nowUnix: T0 });
    await general.touch({ topic: 'alpha', kind: 'theme', nowUnix: T0 });
    // health: three touches on "Dr Carl" at T0.
    for (let i = 0; i < 3; i++) {
      await health.touch({ topic: 'Dr Carl', kind: 'entity', nowUnix: T0 });
    }
    // general: one touch on "gamma" at T0 - 200 days (dormant).
    await general.touch({ topic: 'gamma', kind: 'theme', nowUnix: T0 - 200 * DAY });

    const svc = makeService({ general, health });
    const toc = await svc.toc(undefined, 10);

    // Ranking: Dr Carl (highest s on 3 recent) > alpha (2 recent) > gamma (dormant).
    expect(toc.map((e) => e.topic)).toEqual(['Dr Carl', 'alpha', 'gamma']);
    expect(toc.map((e) => e.persona)).toEqual(['health', 'general', 'general']);
    // Confirm persona tagging matches the repo the topic came from.
  });

  it('a missing persona (locked mid-read) is silently skipped and other personas still return', async () => {
    const general = makeRepo();
    await general.touch({ topic: 'alpha', kind: 'theme', nowUnix: T0 });
    const warnings: Array<Record<string, unknown>> = [];

    const svc = new MemoryService({
      resolve: (p) => (p === 'general' ? general : null),
      listPersonas: () => ['general', 'health', 'finance'],
      nowSecFn: () => T0,
      onWarning: (e) => warnings.push(e),
    });

    const toc = await svc.toc(undefined, 10);
    expect(toc.map((e) => e.topic)).toEqual(['alpha']);
    // Two warnings — one per missing persona.
    const locked = warnings.filter((w) => w.event === 'memory.toc.persona_locked');
    expect(locked).toHaveLength(2);
    expect(locked.map((w) => w.persona).sort()).toEqual(['finance', 'health']);
  });

  it('skips the Tier-0 `identity` persona even when explicitly requested', async () => {
    const identity = makeRepo();
    // If we accidentally walked identity, this would show up in the
    // ToC. The service MUST skip it regardless of the caller.
    identity.touch({ topic: 'DO_NOT_LEAK', kind: 'entity', nowUnix: T0 });
    const general = makeRepo();
    await general.touch({ topic: 'alpha', kind: 'theme', nowUnix: T0 });

    const svc = makeService({ identity, general });
    // Caller explicitly asks for identity AND general.
    const toc = await svc.toc(['identity', 'general'], 10);
    expect(toc.map((e) => e.topic)).toEqual(['alpha']);
    expect(toc.every((e) => e.persona !== 'identity')).toBe(true);
  });

  it('honours the caller-supplied persona list (does NOT walk beyond it)', async () => {
    const health = makeRepo();
    await health.touch({ topic: 'Dr Carl', kind: 'entity', nowUnix: T0 });
    const finance = makeRepo();
    finance.touch({ topic: 'HDFC FD', kind: 'entity', nowUnix: T0 });

    const svc = makeService({ health, finance });
    // Caller asks only for health → finance topics MUST NOT appear.
    const toc = await svc.toc(['health'], 10);
    expect(toc.map((e) => e.topic)).toEqual(['Dr Carl']);
  });

  it('empty explicit persona list falls back to all unlocked (mirrors the Go default)', async () => {
    const general = makeRepo();
    await general.touch({ topic: 'alpha', kind: 'theme', nowUnix: T0 });
    const svc = makeService({ general });
    // Empty array → falls back to listPersonas().
    expect((await svc.toc([], 10)).map((e) => e.topic)).toEqual(['alpha']);
  });
});

describe('MemoryService.toc — errors and limits', () => {
  it('repo that throws "no such table" on top() → skipped + logged as missing_table', async () => {
    const broken: TopicRepository = {
      touch: async () => {
        /* unused */
      },
      top: async () => {
        throw new Error('no such table: topic_salience');
      },
      get: async () => null,
      resolveAlias: async (v) => v,
      putAlias: async () => {
        /* unused */
      },
    };
    const general = makeRepo();
    await await general.touch({ topic: 'alpha', kind: 'theme', nowUnix: T0 });
    const warnings: Array<Record<string, unknown>> = [];
    const svc = makeService({ general, stale: broken }, { onWarning: (e) => warnings.push(e) });
    const toc = await svc.toc(undefined, 10);
    expect(toc.map((e) => e.topic)).toEqual(['alpha']);
    expect(warnings.find((w) => w.event === 'memory.toc.missing_table')).toMatchObject({
      event: 'memory.toc.missing_table',
      persona: 'stale',
    });
  });

  it('repo that throws an unrelated error → skipped + logged as persona_failed', async () => {
    const broken: TopicRepository = {
      touch: async () => {
        /* unused */
      },
      top: async () => {
        throw new Error('disk I/O blew up');
      },
      get: async () => null,
      resolveAlias: async (v) => v,
      putAlias: async () => {
        /* unused */
      },
    };
    const warnings: Array<Record<string, unknown>> = [];
    const svc = makeService({ broken }, { onWarning: (e) => warnings.push(e) });
    expect(await svc.toc(undefined, 10)).toEqual([]);
    expect(warnings[0]).toMatchObject({
      event: 'memory.toc.persona_failed',
      persona: 'broken',
      error: 'disk I/O blew up',
    });
  });

  it('truncates the merged list to `limit` after sorting', async () => {
    const a = makeRepo();
    const b = makeRepo();
    a.touch({ topic: 'x', kind: 'theme', nowUnix: T0 });
    a.touch({ topic: 'y', kind: 'theme', nowUnix: T0 });
    b.touch({ topic: 'z', kind: 'entity', nowUnix: T0 });
    const svc = makeService({ a, b });
    const toc = await svc.toc(undefined, 2);
    expect(toc).toHaveLength(2);
    // First two by salience — ties broken by stable-sort (insertion order).
    expect(toc.map((e) => e.topic)).toEqual(['x', 'y']);
  });
});
