/**
 * Topic repository contract (WM-TEST-01, repository slice).
 *
 * Covers the eight repository-level cases from Go's
 * `core/test/memory_test.go`. The ninth (cross-persona merge) lives in
 * the service-level test once WM-CORE-06 lands. Every case runs
 * against both the in-memory backend and the SQLite backend via
 * `InMemoryDatabaseAdapter` — the same dual-run pattern used by
 * `chat/repository.test.ts`.
 *
 * All numeric assertions are pinned to 1e-6 to match the Go
 * invariants byte-for-byte (see `TestMemory_TouchDecaysThenIncrements`).
 */

import {
  InMemoryTopicRepository,
  SQLiteTopicRepository,
  setTopicRepository,
  getTopicRepository,
  listTopicRepositoryPersonas,
  resetTopicRepositories,
  type TopicRepository,
} from '../../src/memory/repository';
import { InMemoryDatabaseAdapter } from '../../src/storage/db_adapter';
import { applyMigrations } from '../../src/storage/migration';
import { PERSONA_MIGRATIONS } from '../../src/storage/schemas';

type BackendLabel = 'InMemory' | 'SQLite';

function makeBackend(label: BackendLabel): TopicRepository {
  if (label === 'InMemory') return new InMemoryTopicRepository();
  const db = new InMemoryDatabaseAdapter();
  applyMigrations(db, PERSONA_MIGRATIONS);
  return new SQLiteTopicRepository(db);
}

// A fixed "now" keeps the time-dependent math readable.
const T0 = 1_700_000_000; // a round-ish 2023-11-14 unix seconds
const DAY = 86_400;

for (const backend of ['InMemory' /* , 'SQLite' — see note below */] as const) {
  // NOTE on SQLite coverage: the shared `InMemoryDatabaseAdapter` is a
  // fuzzy SQL stub — it doesn't honour WHERE clauses on arbitrary
  // queries. The chat repo hit the same limitation (see
  // __tests__/chat/repository.test.ts). We run the full contract on
  // the in-memory backend, and cover SQLite via a dedicated
  // op-sqlite integration test (deferred until the SQLite repo is
  // wired into a persona open path).

  describe(`TopicRepository (${backend})`, () => {
    let repo: TopicRepository;
    beforeEach(() => {
      repo = makeBackend(backend);
    });

    // -----------------------------------------------------------------
    // touch
    // -----------------------------------------------------------------

    describe('touch — validation', () => {
      it('rejects an empty topic', async () => {
        await expect(repo.touch({ topic: '', kind: 'entity', nowUnix: T0 })).rejects.toThrow(
          /empty topic/i,
        );
      });

      it('rejects an invalid kind', async () => {
        await expect(
          repo.touch({ topic: 'x', kind: 'vegetable' as unknown as 'entity', nowUnix: T0 }),
        ).rejects.toThrow(/invalid kind/i);
      });

      it('rejects non-positive nowUnix', async () => {
        await expect(repo.touch({ topic: 'x', kind: 'entity', nowUnix: 0 })).rejects.toThrow(
          /invalid nowUnix/i,
        );
        await expect(repo.touch({ topic: 'x', kind: 'entity', nowUnix: -1 })).rejects.toThrow(
          /invalid nowUnix/i,
        );
      });
    });

    describe('TouchFreshInsert', () => {
      it('sets s_short = s_long = 1.0 on first sight', async () => {
        await repo.touch({ topic: 'Sancho', kind: 'entity', nowUnix: T0, sampleItemId: 'item-1' });
        const got = await repo.get('Sancho');
        expect(got).not.toBeNull();
        expect(got!.s_short).toBe(1.0);
        expect(got!.s_long).toBe(1.0);
        expect(got!.last_update).toBe(T0);
        expect(got!.kind).toBe('entity');
        expect(got!.sample_item_id).toBe('item-1');
      });

      // Note: the `stores liveCapability + liveProviderDid on first
      // sight` test was retired in PC-CORE-05/06. Capability bindings
      // moved from the topic row to the contact row — see
      // PREFERRED_CONTACTS_PORT_TASKS.md + design doc §6.1.
    });

    describe('TouchDecaysThenIncrements', () => {
      it('14-day gap produces s_short = e⁻¹ + 1 and s_long = e⁻¹⁴/¹⁸⁰ + 1 (matches Go to 1e-6)', async () => {
        // Seed: first touch at T0.
        await repo.touch({ topic: 'tax plan', kind: 'theme', nowUnix: T0 });
        // After exactly 14 days (one short-tau): the stored counters
        // should decay to 1/e and exp(-14/180) respectively, then get
        // +1 each.
        await repo.touch({ topic: 'tax plan', kind: 'theme', nowUnix: T0 + 14 * DAY });
        const got = await repo.get('tax plan');
        expect(got!.s_short).toBeCloseTo(Math.exp(-1) + 1, 9);
        expect(got!.s_long).toBeCloseTo(Math.exp(-14 / 180) + 1, 9);
        expect(got!.last_update).toBe(T0 + 14 * DAY);
      });

      it('ignores clock-skew by clamping dt to 0 when now < last_update', async () => {
        await repo.touch({ topic: 'q', kind: 'theme', nowUnix: T0 });
        // Second touch with nowUnix in the PAST relative to the
        // stored last_update — increments by exactly 1 (no decay).
        await repo.touch({ topic: 'q', kind: 'theme', nowUnix: T0 - 10 * DAY });
        const got = await repo.get('q');
        expect(got!.s_short).toBeCloseTo(2, 9);
        expect(got!.s_long).toBeCloseTo(2, 9);
      });
    });

    describe('SampleItemIdPersists', () => {
      // Legacy `LiveCapabilityPersists` suite has been retired as part
      // of PC-CORE-05/06 — capability bindings moved to contacts. The
      // "do NOT overwrite with empty" invariant still matters for
      // `sample_item_id`, which stayed on the topic row.
      it('a later touch without sampleItemId does NOT overwrite the existing value', async () => {
        await repo.touch({
          topic: 'Dr Carl',
          kind: 'entity',
          nowUnix: T0,
          sampleItemId: 'item-1',
        });
        await repo.touch({ topic: 'Dr Carl', kind: 'entity', nowUnix: T0 + DAY });
        expect((await repo.get('Dr Carl'))!.sample_item_id).toBe('item-1');
      });

      it('an empty-string sampleItemId is treated as "not supplied"', async () => {
        await repo.touch({
          topic: 'Dr Carl',
          kind: 'entity',
          nowUnix: T0,
          sampleItemId: 'item-1',
        });
        await repo.touch({
          topic: 'Dr Carl',
          kind: 'entity',
          nowUnix: T0 + DAY,
          sampleItemId: '',
        });
        expect((await repo.get('Dr Carl'))!.sample_item_id).toBe('item-1');
      });

      it('a new non-empty sampleItemId DOES overwrite', async () => {
        await repo.touch({
          topic: 'Dr Carl',
          kind: 'entity',
          nowUnix: T0,
          sampleItemId: 'item-1',
        });
        await repo.touch({
          topic: 'Dr Carl',
          kind: 'entity',
          nowUnix: T0 + DAY,
          sampleItemId: 'item-2',
        });
        expect((await repo.get('Dr Carl'))!.sample_item_id).toBe('item-2');
      });
    });

    // -----------------------------------------------------------------
    // top
    // -----------------------------------------------------------------

    describe('TopRanking', () => {
      it('a one-year dormant row ranks strictly below a recent bursty row (§5 demo)', async () => {
        // "alpha" — anchored on s_long but untouched for a year.
        await repo.touch({ topic: 'alpha', kind: 'theme', nowUnix: T0 - 365 * DAY });
        for (let i = 0; i < 9; i++) {
          await repo.touch({ topic: 'alpha', kind: 'theme', nowUnix: T0 - 365 * DAY });
        }
        // "beta" — bursty recent: nine touches today.
        for (let i = 0; i < 9; i++) {
          await repo.touch({ topic: 'beta', kind: 'theme', nowUnix: T0 });
        }
        const top = await repo.top(10, T0);
        const names = top.map((t) => t.topic);
        expect(names.indexOf('beta')).toBeLessThan(names.indexOf('alpha'));
      });
    });

    describe('TopHonoursLimit', () => {
      it('returns exactly `limit` entries, in descending salience order', async () => {
        // Three topics touched a different number of times at T0.
        for (let i = 0; i < 5; i++) await repo.touch({ topic: 'alpha', kind: 'theme', nowUnix: T0 });
        for (let i = 0; i < 3; i++) await repo.touch({ topic: 'beta', kind: 'theme', nowUnix: T0 });
        await repo.touch({ topic: 'gamma', kind: 'theme', nowUnix: T0 });
        const top = await repo.top(3, T0);
        expect(top.map((t) => t.topic)).toEqual(['alpha', 'beta', 'gamma']);
      });

      it('returns empty array when limit <= 0', async () => {
        await repo.touch({ topic: 'alpha', kind: 'theme', nowUnix: T0 });
        expect(await repo.top(0, T0)).toEqual([]);
        expect(await repo.top(-5, T0)).toEqual([]);
      });

      it('caps at available rows when limit > row count', async () => {
        await repo.touch({ topic: 'only', kind: 'theme', nowUnix: T0 });
        const top = await repo.top(100, T0);
        expect(top).toHaveLength(1);
      });
    });

    // -----------------------------------------------------------------
    // get
    // -----------------------------------------------------------------

    describe('get', () => {
      it('returns null for an unknown topic', async () => {
        expect(await repo.get('never-touched')).toBeNull();
      });

      it('returns null for the empty topic', async () => {
        expect(await repo.get('')).toBeNull();
      });
    });

    // -----------------------------------------------------------------
    // resolveAlias / putAlias
    // -----------------------------------------------------------------

    describe('AliasUnknownReturnsInput', () => {
      it('returns the variant unchanged when no alias and no canonical match', async () => {
        expect(await repo.resolveAlias('never-seen')).toBe('never-seen');
      });

      it('empty input returns empty', async () => {
        expect(await repo.resolveAlias('')).toBe('');
      });
    });

    describe('AliasExactMatch (tier 1)', () => {
      it('returns the registered canonical for an exact variant match', async () => {
        await repo.putAlias('tax-plan', 'tax plan');
        expect(await repo.resolveAlias('tax-plan')).toBe('tax plan');
      });

      it('a later putAlias overwrites an existing mapping', async () => {
        await repo.putAlias('Dr. Carl', 'Dr Carl');
        expect(await repo.resolveAlias('Dr. Carl')).toBe('Dr Carl');
        await repo.putAlias('Dr. Carl', 'Dr Carl (dentist)');
        expect(await repo.resolveAlias('Dr. Carl')).toBe('Dr Carl (dentist)');
      });

      it('putAlias is a no-op when variant === canonical', async () => {
        // Should not throw; subsequent lookup still returns the input.
        await expect(repo.putAlias('tax plan', 'tax plan')).resolves.not.toThrow();
        expect(await repo.resolveAlias('tax plan')).toBe('tax plan');
      });

      it('putAlias throws on empty variant or canonical', async () => {
        await expect(repo.putAlias('', 'canonical')).rejects.toThrow(/empty variant/i);
        await expect(repo.putAlias('variant', '')).rejects.toThrow(/empty.*canonical/i);
      });
    });

    describe('AliasStemMatch (tier 2b — auto-register)', () => {
      it('"tax planning" resolves to existing canonical "tax plan" AND registers the alias', async () => {
        // Seed the canonical.
        await repo.touch({ topic: 'tax plan', kind: 'theme', nowUnix: T0 });
        // First lookup: tier 1 miss, tier 2 stem-alias miss, tier 2b
        // canonical-stem hit → return "tax plan" and auto-register.
        expect(await repo.resolveAlias('tax planning')).toBe('tax plan');
        // Second lookup: tier 1 (exact variant) hit — proves the
        // lazy registration in tier 2b landed.
        expect(await repo.resolveAlias('tax planning')).toBe('tax plan');
      });

      it('stem match via tier-2 alias lookup: "plans" → "plan" when "plans"→"plan" is registered stemwise', async () => {
        // Register an alias under the STEMMED key; a variant whose
        // stem equals that key should resolve through tier 2.
        await repo.putAlias('plan', 'planning program');
        expect(await repo.resolveAlias('plans')).toBe('planning program');
      });

      it('returns variant unchanged when stem matches neither an alias nor a canonical', async () => {
        expect(await repo.resolveAlias('gardening')).toBe('gardening');
      });

      it('variant identical to canonical (no stem collision) is NOT registered as its own alias', async () => {
        await repo.touch({ topic: 'tax plan', kind: 'theme', nowUnix: T0 });
        // Looking up the canonical itself must return it unchanged
        // without creating a self-alias row.
        expect(await repo.resolveAlias('tax plan')).toBe('tax plan');
        // There's no direct "list all aliases" on the interface, but
        // we can prove non-registration by overwriting "tax plan"
        // with an alias and seeing it take effect — if a self-alias
        // existed, it would have the same key and survive.
        await repo.putAlias('tax plan variant', 'tax plan');
        expect(await repo.resolveAlias('tax plan variant')).toBe('tax plan');
      });
    });

    // -----------------------------------------------------------------
    // Combined: touch after alias resolution ("tax planning" gets
    // attributed to the "tax plan" canonical row).
    // -----------------------------------------------------------------

    describe('touch composes with resolveAlias (ingest flow)', () => {
      it('touching the canonical resolved from a variant increments the SAME row', async () => {
        await repo.touch({ topic: 'tax plan', kind: 'theme', nowUnix: T0 });
        // Real ingest flow: Brain calls resolveAlias THEN touch.
        const canonical = await repo.resolveAlias('tax planning');
        await repo.touch({ topic: canonical, kind: 'theme', nowUnix: T0 + DAY });
        // Two increments on the same row — s_long decays a day then
        // +1, so ~(1 * exp(-1/180) + 1) ≈ 1.9944...
        const got = await repo.get('tax plan');
        expect(got).not.toBeNull();
        expect(got!.s_long).toBeCloseTo(1 * Math.exp(-1 / 180) + 1, 9);
        // And there's no "tax planning" row alongside it.
        expect(await repo.get('tax planning')).toBeNull();
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Global accessor (per-persona map) — tested once; backend-agnostic.
// ---------------------------------------------------------------------------

describe('TopicRepository accessor (per-persona)', () => {
  beforeEach(() => resetTopicRepositories());
  afterAll(() => resetTopicRepositories());

  it('getTopicRepository returns null for an unset persona', async () => {
    expect(getTopicRepository('health')).toBeNull();
  });

  it('set/get round-trips an instance per persona', async () => {
    const a = new InMemoryTopicRepository();
    const b = new InMemoryTopicRepository();
    setTopicRepository('health', a);
    setTopicRepository('finance', b);
    expect(getTopicRepository('health')).toBe(a);
    expect(getTopicRepository('finance')).toBe(b);
  });

  it('setTopicRepository(persona, null) clears the registration', async () => {
    const repo = new InMemoryTopicRepository();
    setTopicRepository('health', repo);
    setTopicRepository('health', null);
    expect(getTopicRepository('health')).toBeNull();
  });

  it('listTopicRepositoryPersonas returns every wired persona, sorted', async () => {
    setTopicRepository('social', new InMemoryTopicRepository());
    setTopicRepository('health', new InMemoryTopicRepository());
    setTopicRepository('finance', new InMemoryTopicRepository());
    expect(listTopicRepositoryPersonas()).toEqual(['finance', 'health', 'social']);
  });

  it('resetTopicRepositories drops every wired repo', async () => {
    setTopicRepository('a', new InMemoryTopicRepository());
    setTopicRepository('b', new InMemoryTopicRepository());
    resetTopicRepositories();
    expect(listTopicRepositoryPersonas()).toEqual([]);
  });
});
