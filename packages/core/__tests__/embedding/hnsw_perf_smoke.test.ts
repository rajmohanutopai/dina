/**
 * Task 11.5 — HNSW semantic-search p95 < 100 ms at 10 000 items.
 *
 * Mirrors `@dina/storage-node`'s FTS5 perf smoke (task 3.18): seed a
 * representative-scale corpus, warm up, measure, assert p95 against
 * a budget. Catches order-of-magnitude regressions in the HNSW
 * greedy-descent / neighbour-selection code before they ship.
 *
 * Shape:
 *   1. Create an HNSWIndex with dimensions = 768 (Dina's embedding
 *      dim, matches EmbeddingGemma + gemini-embedding-001 output).
 *   2. Insert 10 000 deterministic-but-uncorrelated vectors. Seeded
 *      LCG keeps corpus stable across runs; uncorrelated bytes exercise
 *      realistic neighbour-selection cost (correlated/near-duplicate
 *      data paths through HNSW would be ~10× faster + not reveal
 *      regressions).
 *   3. Warm up — 50 queries discarded so JIT + cache lines settle.
 *   4. Measure — 100 queries, collect per-call `performance.now()`
 *      deltas, compute p95.
 *   5. Assert p95 < 100 ms (task budget) with env override
 *      `HNSW_P95_MS` for slower CI arches.
 *
 * Opt-out via `HNSW_PERF_SMOKE=0` for constrained runners.
 *
 * Build time (inserting 10 000 into HNSW) is order-of-magnitude
 * longer than the measurement phase; we set Jest's per-test timeout
 * to 120 s so cold CI runners don't flake.
 */

import { HNSWIndex } from '../../src/embedding/hnsw';

const P95_BUDGET_MS = Number(process.env.HNSW_P95_MS ?? 100);
const ROW_COUNT = Number(process.env.HNSW_ROW_COUNT ?? 10_000);
const WARMUP_QUERIES = 50;
const MEASURED_QUERIES = 100;
const DIMENSIONS = 768;

/** Seeded LCG — deterministic pseudorandom ≈ uniform in [0, 1). */
function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

function makeVector(rng: () => number): Float32Array {
  // Sample uniformly in [-1, 1) so the magnitude is meaningful for
  // cosine distance (HNSW's similarity metric). Float32Array is what
  // the index stores natively — no conversion cost at insert time.
  const v = new Float32Array(DIMENSIONS);
  for (let i = 0; i < DIMENSIONS; i += 1) v[i] = rng() * 2 - 1;
  return v;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx]!;
}

const describeMaybe = process.env.HNSW_PERF_SMOKE === '0' ? describe.skip : describe;

describeMaybe(`HNSW perf smoke — ${ROW_COUNT} items, p95 < ${P95_BUDGET_MS} ms (task 11.5)`, () => {
  let index: HNSWIndex;

  beforeAll(() => {
    index = new HNSWIndex({ dimensions: DIMENSIONS });
    const rng = seededRng(0x11_5CAFE);
    for (let i = 0; i < ROW_COUNT; i += 1) {
      index.insert(`v-${i}`, makeVector(rng));
    }
  }, 120_000);

  it(`index has ${ROW_COUNT} items`, () => {
    expect(index.size).toBe(ROW_COUNT);
  });

  it(`query p95 < ${P95_BUDGET_MS} ms`, () => {
    const rngQueries = seededRng(0xDE_CAFE);
    // Warm up — JIT + CPU cache settle.
    for (let i = 0; i < WARMUP_QUERIES; i += 1) {
      index.search(makeVector(rngQueries), 10);
    }

    const latencies: number[] = [];
    for (let i = 0; i < MEASURED_QUERIES; i += 1) {
      const q = makeVector(rngQueries);
      const t0 = performance.now();
      index.search(q, 10);
      const t1 = performance.now();
      latencies.push(t1 - t0);
    }
    latencies.sort((x, y) => x - y);
    const p50 = percentile(latencies, 0.5);
    const p95 = percentile(latencies, 0.95);
    const p99 = percentile(latencies, 0.99);
    // Summary on stdout so CI dashboards surface the numbers on both
    // pass and fail. Format matches storage-node's FTS5 perf smoke for
    // grep'able consistency.
    // eslint-disable-next-line no-console
    console.log(
      `[hnsw_perf] queries=${MEASURED_QUERIES} p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms p99=${p99.toFixed(2)}ms budget=${P95_BUDGET_MS}ms`,
    );
    expect(p95).toBeLessThan(P95_BUDGET_MS);
  }, 30_000);
});
