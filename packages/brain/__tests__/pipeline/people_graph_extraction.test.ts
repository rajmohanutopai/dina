/**
 * `applyPeopleGraphExtraction` — bridges the LLM identity-link
 * extractor (`extractPersonLinks`) into the people-graph repo.
 *
 * Tests run against a real SQLCipher database via `@dina/storage-node`
 * because the underlying `peopleRepo.applyExtraction` depends on
 * SQLite-specific JOINs (role_phrase exclusivity check, surface
 * upsert) the in-memory adapter doesn't honour.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  applyMigrations,
  IDENTITY_MIGRATIONS,
  SQLitePeopleRepository,
} from '@dina/core';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  registerPersonLinkProvider,
  resetPersonLinkProvider,
} from '../../src/person/linking';
import {
  applyPeopleGraphExtraction,
  linksToExtractionResult,
  PEOPLE_GRAPH_EXTRACTOR_VERSION,
} from '../../src/pipeline/people_graph_extraction';

interface Harness {
  adapter: NodeSQLiteAdapter;
  repo: SQLitePeopleRepository;
  cleanup: () => void;
}

function openHarness(): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-people-graph-extract-'));
  const dbPath = path.join(dir, 'identity.sqlite');
  const passphraseHex = randomBytes(32).toString('hex');
  const adapter = new NodeSQLiteAdapter({
    path: dbPath,
    passphraseHex,
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  const repo = new SQLitePeopleRepository(adapter);
  return {
    adapter,
    repo,
    cleanup: () => {
      try {
        adapter.close();
      } catch {
        /* idempotent */
      }
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

/**
 * Stub LLM provider — returns a JSON envelope shaped like the
 * `PERSON_IDENTITY_EXTRACTION` prompt expects.
 */
function stubLinkProvider(payload: unknown) {
  return async (_text: string): Promise<string> => JSON.stringify(payload);
}

describe('linksToExtractionResult (pure converter)', () => {
  it('emits both name and role_phrase surfaces when present', () => {
    const result = linksToExtractionResult(
      [
        {
          name: 'Sancho',
          role_phrase: 'my brother',
          relationship: 'sibling',
          confidence: 'high',
          evidence: 'Sancho is my brother',
        },
      ],
      'item-1',
      'llm-v1',
      'Sancho is my brother — fragment',
    );
    expect(result.sourceItemId).toBe('item-1');
    expect(result.extractorVersion).toBe('llm-v1');
    expect(result.results).toHaveLength(1);
    const link = result.results[0];
    expect(link.canonicalName).toBe('Sancho');
    expect(link.relationshipHint).toBe('sibling');
    expect(link.surfaces).toEqual([
      { surface: 'Sancho', surfaceType: 'name', confidence: 'high' },
      { surface: 'my brother', surfaceType: 'role_phrase', confidence: 'high' },
    ]);
    expect(link.sourceExcerpt).toBe('Sancho is my brother');
  });

  it('drops links whose name and role_phrase are both empty', () => {
    const result = linksToExtractionResult(
      [
        // First link survives.
        { name: 'Alice', confidence: 'medium' },
        // Second is empty — drop.
        { name: '', confidence: 'high' },
        // Third has only a role_phrase surface and still survives.
        { name: '', role_phrase: 'my dentist', confidence: 'high' },
      ],
      'item-2',
      'llm-v1',
    );
    expect(result.results.map((l) => l.canonicalName)).toEqual(['Alice', 'my dentist']);
  });

  it('coerces unknown confidence to "medium" (Python parity default)', () => {
    const result = linksToExtractionResult(
      [{ name: 'Bob', confidence: 'wat' as unknown as 'high' }],
      'item-3',
      'llm-v1',
    );
    expect(result.results[0].surfaces[0].confidence).toBe('medium');
  });

  it('defaults missing relationship to "other" (Python parity)', () => {
    const result = linksToExtractionResult(
      [{ name: 'Bob', confidence: 'high' }],
      'item-rel',
      'llm-v1',
    );
    expect(result.results[0].relationshipHint).toBe('other');
  });

  it('caps explicit evidence at 200 chars', () => {
    const long = 'x'.repeat(500);
    const result = linksToExtractionResult(
      [{ name: 'Carl', confidence: 'low', evidence: long }],
      'item-4',
      'llm-v1',
    );
    expect(result.results[0].sourceExcerpt.length).toBe(200);
  });

  it('falls back to first 100 chars of fullText when evidence is empty (Python parity)', () => {
    const result = linksToExtractionResult(
      [{ name: 'Dee', confidence: 'low' }],
      'item-5',
      'llm-v1',
      'Dee was at the meeting',
    );
    // Short fullText → fits under the 100-char fallback cap → returned in full.
    expect(result.results[0].sourceExcerpt).toBe('Dee was at the meeting');
  });

  it('caps fullText fallback at 100 chars (Python parity)', () => {
    const long = 'y'.repeat(500);
    const result = linksToExtractionResult(
      [{ name: 'Eve', confidence: 'low' }],
      'item-cap',
      'llm-v1',
      long,
    );
    expect(result.results[0].sourceExcerpt.length).toBe(100);
  });
});

describe('applyPeopleGraphExtraction', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = openHarness();
  });

  afterEach(() => {
    harness.cleanup();
    resetPersonLinkProvider();
  });

  it('returns empty_text for blank input', async () => {
    registerPersonLinkProvider(stubLinkProvider({ identity_links: [] }));
    expect(await applyPeopleGraphExtraction('', 'item-1', { repo: harness.repo })).toEqual({
      ok: false,
      reason: 'empty_text',
    });
    expect(
      await applyPeopleGraphExtraction('   ', 'item-1', { repo: harness.repo }),
    ).toEqual({ ok: false, reason: 'empty_text' });
  });

  it('returns no_repo when neither override nor singleton is set', async () => {
    registerPersonLinkProvider(stubLinkProvider({ identity_links: [{ name: 'X', confidence: 'high' }] }));
    // No `repo` option, and the singleton (default null in this test
    // process) isn't installed — should fail-soft.
    const outcome = await applyPeopleGraphExtraction('Sancho is here', 'item-1');
    expect(outcome).toEqual({ ok: false, reason: 'no_repo' });
  });

  it('returns no_links when the extractor produces no usable links', async () => {
    registerPersonLinkProvider(stubLinkProvider({ identity_links: [] }));
    const outcome = await applyPeopleGraphExtraction('Generic text', 'item-1', {
      repo: harness.repo,
    });
    expect(outcome).toEqual({ ok: false, reason: 'no_links' });
    expect(harness.repo.listPeople()).toEqual([]);
  });

  it('returns extractor_failed when the LLM provider throws', async () => {
    registerPersonLinkProvider(async () => {
      throw new Error('llm timeout');
    });
    const outcome = await applyPeopleGraphExtraction('Sancho is my brother', 'item-1', {
      repo: harness.repo,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('extractor_failed');
      if (outcome.reason === 'extractor_failed') {
        expect(outcome.error).toBe('llm timeout');
      }
    }
    // Nothing written to the repo.
    expect(harness.repo.listPeople()).toEqual([]);
  });

  it('writes a confirmed person + surfaces on a high-confidence link', async () => {
    registerPersonLinkProvider(
      stubLinkProvider({
        identity_links: [
          {
            name: 'Sancho',
            role_phrase: 'my brother',
            relationship: 'sibling',
            confidence: 'high',
            evidence: 'Sancho is my brother',
          },
        ],
      }),
    );
    const outcome = await applyPeopleGraphExtraction(
      'Sancho is my brother and he visits often',
      'item-1',
      { repo: harness.repo },
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.linkCount).toBe(1);
      expect(outcome.applied.created).toBe(1);
      expect(outcome.applied.updated).toBe(0);
      expect(outcome.applied.skipped).toBe(false);
      expect(outcome.applied.conflicts).toEqual([]);
    }
    const people = harness.repo.listPeople();
    expect(people).toHaveLength(1);
    expect(people[0].canonicalName).toBe('Sancho');
    expect(people[0].status).toBe('confirmed');
    expect(people[0].relationshipHint).toBe('sibling');
    const surfaces = people[0].surfaces?.map((s) => ({
      surface: s.surface,
      type: s.surfaceType,
      status: s.status,
    }));
    expect(surfaces).toEqual([
      { surface: 'Sancho', type: 'name', status: 'confirmed' },
      { surface: 'my brother', type: 'role_phrase', status: 'confirmed' },
    ]);
  });

  it('is idempotent — re-applying the same link set under the same version is skipped', async () => {
    registerPersonLinkProvider(
      stubLinkProvider({
        identity_links: [
          {
            name: 'Alonso',
            confidence: 'high',
            evidence: 'Alonso came over',
          },
        ],
      }),
    );
    const first = await applyPeopleGraphExtraction('Alonso came over', 'item-1', {
      repo: harness.repo,
    });
    const second = await applyPeopleGraphExtraction('Alonso came over', 'item-1', {
      repo: harness.repo,
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.applied.skipped).toBe(true);
      expect(second.applied.created).toBe(0);
      expect(second.applied.updated).toBe(0);
    }
    expect(harness.repo.listPeople()).toHaveLength(1);
  });

  it('uses the configured extractor version stamp on every surface', async () => {
    registerPersonLinkProvider(
      stubLinkProvider({
        identity_links: [{ name: 'Stamped', confidence: 'high', evidence: 'x' }],
      }),
    );
    const outcome = await applyPeopleGraphExtraction('Stamped was here', 'item-1', {
      repo: harness.repo,
      extractorVersion: 'custom-v2',
    });
    expect(outcome.ok).toBe(true);
    const people = harness.repo.listPeople();
    expect(people[0].surfaces?.[0].extractorVersion).toBe('custom-v2');
  });

  it('default extractor version is the module constant', async () => {
    registerPersonLinkProvider(
      stubLinkProvider({
        identity_links: [{ name: 'Default', confidence: 'high', evidence: 'x' }],
      }),
    );
    await applyPeopleGraphExtraction('Default was here', 'item-1', { repo: harness.repo });
    const people = harness.repo.listPeople();
    expect(people[0].surfaces?.[0].extractorVersion).toBe(PEOPLE_GRAPH_EXTRACTOR_VERSION);
  });

  it('propagates the empty conflicts array through to the success outcome', async () => {
    // The natural pipeline can't surface a role_phrase conflict — the
    // LLM emits one role_phrase per link, so the converter never
    // bundles two role phrases into a single ExtractionPersonLink, and
    // step (1) of `findOrAssignPersonId` always routes the link's lone
    // role_phrase to the existing owner. The repo's conflict path is
    // covered by `__tests__/people/repository.test.ts`. This pipeline
    // test asserts that the success path correctly carries the
    // (empty) conflicts list through to the outcome.
    registerPersonLinkProvider(
      stubLinkProvider({
        identity_links: [
          {
            name: 'Plain',
            role_phrase: 'my friend',
            confidence: 'high',
            evidence: 'Plain is my friend',
          },
        ],
      }),
    );
    const outcome = await applyPeopleGraphExtraction(
      'Plain is my friend',
      'item-no-conflict',
      { repo: harness.repo },
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.applied.conflicts).toEqual([]);
    }
  });
});
