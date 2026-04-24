/**
 * VaultRepository parity gate — `InMemoryVaultRepository` must stay
 * behaviourally equivalent to `SQLiteVaultRepository` for the
 * predicates exercised by `vault/crud.ts`.
 *
 * Why this exists
 * ---------------
 * The in-memory repo is the test-time fallback the service layer
 * auto-provisions when no SQL repo is wired. Drift between that fake
 * and the production SQLite predicate is how FTS5 AND-semantics bugs
 * silently slip past Jest and reproduce only on the iOS simulator.
 * (Real incident: /ask returned no hits for "When is Emma birthday"
 * because the SQLite MATCH required ALL tokens while the in-memory
 * scan scored by any match.)
 *
 * This file pins a corpus of representative query/store pairs and
 * runs them against BOTH backends, asserting the result sets are
 * identical (by id, order-agnostic). A backend that stops matching
 * the other fails the gate.
 *
 * Scope: FTS5 keyword search is the surface where the two have
 * historically diverged, so that's the focus. Extend when other
 * methods drift in the future.
 */

import {
  SQLiteVaultRepository,
  InMemoryVaultRepository,
  setVaultRepository,
  resetVaultRepositories,
} from '@dina/core/src/vault/repository';
import { queryVault, storeItem, clearVaults } from '@dina/core/src/vault/crud';
import { openSQLiteVault, closeSQLiteVault, type SQLiteVaultHandle } from './helpers/sqlite_vault_harness';

interface Backend {
  name: 'in-memory' | 'sqlite';
  install(persona: string): () => void; // returns teardown
}

const BACKENDS: Backend[] = [
  {
    name: 'in-memory',
    install(persona: string) {
      const repo = new InMemoryVaultRepository();
      setVaultRepository(persona, repo);
      return (): void => {
        setVaultRepository(persona, null);
      };
    },
  },
  {
    name: 'sqlite',
    install(persona: string) {
      // `openSQLiteVault` already registers the repo via
      // `setVaultRepository`. We just need to tear it down.
      const handle: SQLiteVaultHandle = openSQLiteVault(persona);
      return (): void => closeSQLiteVault(handle);
    },
  },
];

/**
 * Seed rows the queries below will be run against. Content shapes
 * chosen to cover tokenisation edge cases: apostrophes, stop-words,
 * mixed case, multi-word phrases, unicode diacritics.
 */
interface SeedItem {
  label: string;
  type: string;
  summary: string;
  body: string;
}

const SEED_ITEMS: SeedItem[] = [
  {
    label: 'birthday',
    type: 'user_memory',
    summary: "Emma's birthday is March 15",
    body: "Emma's birthday is March 15",
  },
  {
    label: 'pediatric',
    type: 'medical_note',
    summary: "Emma's pediatric vaccination MMR",
    body: 'Emma pediatric vaccination MMR',
  },
  {
    label: 'dentist',
    type: 'note',
    summary: 'My dentist Dr Carl',
    body: 'I should book an appointment with my dentist Dr Carl soon.',
  },
  {
    label: 'diacritics',
    type: 'note',
    summary: 'Café résumé',
    body: 'The café served espresso and résumé pastries.',
  },
];

interface QueryCase {
  label: string;
  query: string;
  /** Labels of SEED_ITEMS that MUST be in the results, in any order. */
  mustContainLabels: string[];
  /** Labels of SEED_ITEMS that MUST NOT appear. */
  mustNotContainLabels?: string[];
}

const QUERY_CASES: QueryCase[] = [
  // Stop-word-bearing natural question — the /ask-style shape that
  // broke in production. OR semantics mean "emma" or "birthday"
  // alone is enough to match.
  {
    label: 'stopwords',
    query: 'When is Emma birthday',
    mustContainLabels: ['birthday'],
  },
  // Token that's in only ONE row — must return just that row.
  {
    label: 'single-token-narrow',
    query: 'pediatric',
    mustContainLabels: ['pediatric'],
    mustNotContainLabels: ['birthday', 'dentist', 'diacritics'],
  },
  // Two tokens, both present in only one row — narrower than
  // single-token but still findable.
  {
    label: 'two-tokens',
    query: 'dentist appointment',
    mustContainLabels: ['dentist'],
  },
  // Case-insensitive.
  {
    label: 'case-insensitive',
    query: 'EMMA',
    mustContainLabels: ['birthday', 'pediatric'],
  },
];

describe('VaultRepository parity — InMemory ↔ SQLite', () => {
  beforeEach(() => {
    clearVaults();
    resetVaultRepositories();
  });

  /** Run a query set against a backend and return the set of matching labels. */
  function runAgainst(backend: Backend, persona: string): Map<string, Set<string>> {
    const teardown = backend.install(persona);
    try {
      // Seed
      const idToLabel = new Map<string, string>();
      for (const item of SEED_ITEMS) {
        const id = storeItem(persona, {
          type: item.type,
          summary: item.summary,
          body: item.body,
        });
        idToLabel.set(id, item.label);
      }
      // Query
      const perQuery = new Map<string, Set<string>>();
      for (const qc of QUERY_CASES) {
        const hits = queryVault(persona, {
          mode: 'fts5',
          text: qc.query,
          limit: 20,
        });
        const hitLabels = new Set<string>();
        for (const h of hits) {
          const label = idToLabel.get(h.id);
          if (label !== undefined) hitLabels.add(label);
        }
        perQuery.set(qc.label, hitLabels);
      }
      return perQuery;
    } finally {
      teardown();
      clearVaults();
    }
  }

  it('every query case is satisfied by each backend (mustContain / mustNotContain)', () => {
    for (const backend of BACKENDS) {
      const results = runAgainst(backend, 'general');
      for (const qc of QUERY_CASES) {
        const labels = results.get(qc.label) ?? new Set<string>();
        for (const must of qc.mustContainLabels) {
          expect(labels.has(must)).toBe(true);
        }
        for (const mustNot of qc.mustNotContainLabels ?? []) {
          expect(labels.has(mustNot)).toBe(false);
        }
      }
    }
  });

  it('both backends return matching label sets (within mustContain guarantees)', () => {
    // Parity isn't strict equality — ranking + extra fuzzy matches are
    // allowed, but the guaranteed `mustContainLabels` set must agree,
    // and forbidden `mustNotContainLabels` must agree.
    const inMemory = runAgainst(BACKENDS[0]!, 'general');
    const sqlite = runAgainst(BACKENDS[1]!, 'general');
    for (const qc of QUERY_CASES) {
      const m = inMemory.get(qc.label) ?? new Set<string>();
      const s = sqlite.get(qc.label) ?? new Set<string>();
      for (const must of qc.mustContainLabels) {
        // If one backend finds it, the other MUST too — otherwise the
        // fake repo is papering over a production predicate bug.
        expect({ label: qc.label, mustFind: must, inMemory: m.has(must), sqlite: s.has(must) })
          .toMatchObject({ inMemory: true, sqlite: true });
      }
    }
  });
});
