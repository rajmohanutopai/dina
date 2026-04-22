/**
 * Tasks 3.18 + 11.4 — perf smoke: 10K items, FTS5 p95 <50ms.
 *
 * Satisfies both the Phase 3 storage-backend smoke (task 3.18) and
 * the Phase 11 "FTS5 p95 <50ms at 10K items" perf gate (task 11.4).
 * Same budget, same corpus — one test, two task IDs. The Phase 11
 * view is "the Phase 3 guarantee still holds under the Lite stack";
 * re-running this test IS the Phase 11 check.
 *
 * Smoke-level benchmark. Not a rigorous perf harness — the full
 * Phase 11 SLO work (throughput 11.3, soak 11.7-10, Pi 11.17-20)
 * lives elsewhere. This test just catches order-of-magnitude drift
 * so a library swap or adapter regression won't silently cripple the
 * hybrid-search path.
 *
 * **Shape**:
 *   1. Open an encrypted DB with the full Dina pragma set (task 3.14
 *      applies — WAL + synchronous=NORMAL).
 *   2. Bulk-insert 10 000 rows into an FTS5 `docs(body)` table inside
 *      one explicit transaction.
 *   3. Warm up — 50 queries discarded to let the SQLite statement
 *      cache + OS page cache settle.
 *   4. Measure — 100 queries, collect per-call `performance.now()`
 *      deltas, compute p95.
 *   5. Assert p95 < 50ms (task target). An env-gated `PERF_P95_MS`
 *      override exists for slower CI arches.
 *
 * Deterministic content is generated from a seeded linear-congruential
 * RNG so the same seed always produces the same corpus — prevents
 * flakes from lucky/unlucky term distributions.
 *
 * The test is skipped when `PERF_SMOKE=0` so it can be opted-out of
 * on constrained CI runners without touching the main gate.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '../src/adapter';

const KEY = '0'.repeat(64);
const P95_BUDGET_MS = Number(process.env.PERF_P95_MS ?? 50);
const ROW_COUNT = 10_000;
const WARMUP_QUERIES = 50;
const MEASURED_QUERIES = 100;

const WORDS = [
  'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel',
  'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa',
  'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey',
  'xray', 'yankee', 'zulu', 'apple', 'banana', 'cherry', 'date', 'elder',
  'fig', 'grape', 'huckleberry', 'kiwi', 'lemon', 'melon', 'orange',
  'peach', 'plum', 'quince', 'raspberry', 'strawberry', 'tangerine',
];

/** Seeded LCG — stable across runs. */
function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

function pickWord(rng: () => number): string {
  return WORDS[Math.floor(rng() * WORDS.length)]!;
}

function buildBody(rng: () => number, wordCount: number): string {
  const out: string[] = [];
  for (let i = 0; i < wordCount; i += 1) out.push(pickWord(rng));
  return out.join(' ');
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx]!;
}

const describeMaybe = process.env.PERF_SMOKE === '0' ? describe.skip : describe;

describeMaybe('perf smoke — 10K items, FTS5 p95 < 50ms (tasks 3.18 + 11.4)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-sqlite-perf-'));
  const dbPath = path.join(tmpDir, 'perf.sqlite');
  let a: NodeSQLiteAdapter;

  beforeAll(() => {
    a = new NodeSQLiteAdapter({
      path: dbPath,
      passphraseHex: KEY,
      journalMode: 'WAL',
      synchronous: 'NORMAL',
    });
    a.execute(`
      CREATE VIRTUAL TABLE docs USING fts5(
        body,
        tokenize = "unicode61 remove_diacritics 1"
      );
    `);

    // Seed the corpus in one explicit transaction — >100x faster than
    // autocommit-per-insert and exercises task 3.9's form too.
    const rng = seededRng(0x51EED);
    a.beginTransaction();
    try {
      for (let i = 0; i < ROW_COUNT; i += 1) {
        a.run('INSERT INTO docs(body) VALUES (?)', [buildBody(rng, 12)]);
      }
      a.commitTransaction();
    } catch (e) {
      a.rollbackTransaction();
      throw e;
    }
  });

  afterAll(() => {
    try { a.close(); } catch { /* swallow */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* swallow */ }
  });

  it(`row count matches seed (${ROW_COUNT})`, () => {
    const rows = a.query<{ n: number }>('SELECT count(*) AS n FROM docs');
    expect(rows[0]!.n).toBe(ROW_COUNT);
  });

  it(`FTS5 query p95 under ${P95_BUDGET_MS}ms`, () => {
    const rngQueries = seededRng(0xDECAF);
    // Warm up — SQLite's prepared-statement cache + page cache settle.
    for (let i = 0; i < WARMUP_QUERIES; i += 1) {
      a.query(
        'SELECT body FROM docs WHERE docs MATCH ? ORDER BY rank LIMIT 10',
        [pickWord(rngQueries)],
      );
    }

    const latencies: number[] = [];
    for (let i = 0; i < MEASURED_QUERIES; i += 1) {
      const term = pickWord(rngQueries);
      const t0 = performance.now();
      a.query(
        'SELECT body FROM docs WHERE docs MATCH ? ORDER BY rank LIMIT 10',
        [term],
      );
      const t1 = performance.now();
      latencies.push(t1 - t0);
    }
    latencies.sort((x, y) => x - y);
    const p50 = percentile(latencies, 0.5);
    const p95 = percentile(latencies, 0.95);
    const p99 = percentile(latencies, 0.99);
    // Emit a summary line so CI logs show the measured numbers on
    // both pass and fail — helps triage when the budget tightens.
    // eslint-disable-next-line no-console
    console.log(`[perf_smoke] queries=${MEASURED_QUERIES} p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms p99=${p99.toFixed(2)}ms budget=${P95_BUDGET_MS}ms`);
    expect(p95).toBeLessThan(P95_BUDGET_MS);
  }, 60_000); // long timeout — 10K-insert + 150 queries fit easily, but avoid flakes on cold CI
});
