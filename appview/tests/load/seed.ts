/**
 * tests/load/trust_network/seed.ts — TN-TEST-081 corpus seeder.
 *
 * Bulk-INSERTs a power-law-distributed trust corpus into the
 * AppView's Postgres so the k6 read-side load scripts (search /
 * getProfile / networkFeed) see realistic plan shapes — not the
 * empty-table best-case where every threshold passes trivially.
 *
 * **Honest scope-narrowing on Plan §13.6's write-side target**:
 * the Plan calls for "1M attestations indexed in ≤ 30 min" through
 * the JETSTREAM → ingester pipeline. This seeder writes directly
 * via Drizzle bulk INSERT — same destination tables, but bypasses
 * the rate-limiter, schema validator, namespace gate, and
 * subject-enrichment pipeline. That's a deliberate trade:
 *   - 1M HTTP round-trips through `com.dina.test.injectAttestation`
 *     would take hours per seed run, defeating the iterative-debug
 *     workflow the seeder enables.
 *   - The k6 read scripts measure what operators actually report
 *     to users (search latency, profile-read latency); those care
 *     about the corpus *shape*, not how it landed.
 *   - The write-side throughput target is exercised by a separate
 *     test that drives Jetstream with a synthetic relay — that's
 *     a different piece of infrastructure (TN-TEST-WRITE-LOAD,
 *     not yet on the backlog).
 *
 * **Idempotency**: the script generates IDs deterministically from
 * a seed (default: 0). Re-running with the same seed produces the
 * same IDs, so partial-run aborts can be resumed by truncating the
 * `attestations`/`subjects`/`did_profiles` tables and rerunning.
 * If the corpus already exceeds the target counts, the script
 * exits with "already-seeded" — operators looking to refresh
 * truncate first.
 *
 * **Modes**:
 *   - `--smoke`   1k attestations / 200 subjects / 50 DIDs.
 *                 Runs in ~1s. Validates the script + schema
 *                 without committing to a full seed.
 *   - default    1M attestations / 200k subjects / 50k DIDs.
 *                Plan §13.6 targets. Wall-clock varies by hardware
 *                — local M-series Mac sees ~4-6 minutes; CI box
 *                proportional to PG write IOPS.
 *
 * **Distribution**: per-subject attestation count follows a Zipf-
 * style power law — most subjects get 1–3 attestations; a long
 * tail reaches 100s. This matches the production shape that drives
 * realistic FTS rank ordering (a uniform-distribution corpus
 * surfaces every row at rank ≈ 1.0, which masks rank-by-relevance
 * regressions).
 *
 * **Run**:
 *   DATABASE_URL=postgresql://dina:dina@localhost:5433/dina_trust \
 *     npx tsx tests/load/trust_network/seed.ts [--smoke]
 */

// Raw `pg` driver — NOT Drizzle. The seed script lives at the repo
// root outside the AppView's `tsconfig.json` baseUrl, so `@/db/schema`
// path mapping doesn't apply. Rather than couple the seeder to
// AppView's TS layout (would force an awkward tsx --tsconfig flag at
// every invocation), the script speaks SQL directly to Postgres.
// The schema columns it writes are documented inline against
// `appview/src/db/schema/{attestations,subjects,did-profiles}.ts`;
// a column rename there will surface here as a runtime error on the
// first batch INSERT, which is the loud failure mode this seeder
// wants — silently writing into a stale shape would corrupt
// production-like load runs.
import pg from 'pg'

const { Pool } = pg

interface SeedConfig {
  attestationCount: number
  subjectCount: number
  didCount: number
  batchSize: number
  /** Deterministic seed for ID generation. Default 0. */
  rngSeed: number
  /** Postgres connection string. Default: env DATABASE_URL. */
  databaseUrl: string
}

const DEFAULT_CONFIG: SeedConfig = {
  attestationCount: 1_000_000,
  subjectCount: 200_000,
  didCount: 50_000,
  batchSize: 5_000,
  rngSeed: 0,
  databaseUrl: process.env.DATABASE_URL ?? 'postgresql://dina:dina@localhost:5433/dina_trust',
}

const SMOKE_CONFIG: SeedConfig = {
  ...DEFAULT_CONFIG,
  attestationCount: 1_000,
  subjectCount: 200,
  didCount: 50,
  batchSize: 200,
}

// ---------------------------------------------------------------------------
// Deterministic PRNG — mulberry32. Same shape as the property tests
// in `tests/unit/recency_decay_monotonicity.test.ts` use; pure
// function of the seed, byte-stable across Node versions.
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------------------
// Power-law subject sampler. Returns a function `pick()` that yields
// subject indices weighted toward the head. Implementation: Zipf via
// inverse-CDF on a precomputed cumulative table — O(log N) per pick.
// ---------------------------------------------------------------------------
function makeZipfPicker(n: number, alpha: number, rng: () => number): () => number {
  // Precompute cumulative weights: 1/i^alpha for i=1..n.
  const cumulative = new Float64Array(n)
  let total = 0
  for (let i = 0; i < n; i++) {
    total += 1 / Math.pow(i + 1, alpha)
    cumulative[i] = total
  }
  // Normalise.
  for (let i = 0; i < n; i++) cumulative[i] /= total
  return () => {
    const r = rng()
    // Binary search for the first index whose cumulative weight ≥ r.
    let lo = 0
    let hi = n - 1
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (cumulative[mid] < r) lo = mid + 1
      else hi = mid
    }
    return lo
  }
}

// ---------------------------------------------------------------------------
// ID + handle generators. Deterministic for given (kind, index, rngSeed).
// ---------------------------------------------------------------------------
const SENTIMENTS = ['positive', 'neutral', 'negative'] as const
const CATEGORIES = [
  'office_furniture',
  'service',
  'tech',
  'restaurant',
  'book',
  'place',
  'person',
] as const
const LANGUAGES = ['en', 'es', 'fr', 'pt-BR', 'ja'] as const

function authorDid(i: number): string {
  return `did:plc:loadtest-author-${String(i).padStart(6, '0')}`
}

function subjectId(i: number): string {
  return `subj-loadtest-${String(i).padStart(6, '0')}`
}

function attestationUri(authorIdx: number, attIdx: number): string {
  return `at://${authorDid(authorIdx)}/com.dina.trust.attestation/loadtest-${String(attIdx).padStart(7, '0')}`
}

function syntheticHandle(i: number): string {
  return `loadtest-author-${i}.test`
}

// Synthetic CID — production CIDs are dag-cbor `bafy*` strings;
// the ingester regex (`/^bafy[a-z2-7]{50,}$/`) is enforced ONLY in
// the jetstream-consumer path, not in direct DB writes. We emit
// well-formed bafy strings anyway because some downstream queries
// may format them for display.
function syntheticCid(uri: string): string {
  // Stable fake CID — `bafy` + 56 alphabet chars derived from the
  // URI. Not crypto-strong; just realistic-looking for display.
  let h = 5381
  for (let i = 0; i < uri.length; i++) h = (h * 33 + uri.charCodeAt(i)) >>> 0
  const tail = h.toString(36).repeat(10).slice(0, 56)
  return `bafy${tail}`
}

// ---------------------------------------------------------------------------
// Idempotency check — abort if the corpus already at-or-above target.
// ---------------------------------------------------------------------------
async function checkIdempotency(client: pg.Pool, cfg: SeedConfig) {
  const counts = await client.query(`
    SELECT
      (SELECT COUNT(*) FROM attestations) AS attestations,
      (SELECT COUNT(*) FROM subjects)     AS subjects,
      (SELECT COUNT(*) FROM did_profiles) AS dids
  `)
  const row = counts.rows[0] as { attestations: string; subjects: string; dids: string }
  const att = Number(row.attestations)
  const subj = Number(row.subjects)
  const dids = Number(row.dids)
  if (att >= cfg.attestationCount && subj >= cfg.subjectCount && dids >= cfg.didCount) {
    console.error(
      `[seed] corpus already meets targets — attestations=${att} subjects=${subj} dids=${dids}. Truncate first if you want to refresh.`,
    )
    return true
  }
  if (att > 0 || subj > 0 || dids > 0) {
    console.error(
      `[seed] partial corpus detected — attestations=${att} subjects=${subj} dids=${dids}. Truncating affected tables before refill.`,
    )
    await client.query(`TRUNCATE TABLE attestations, subjects, did_profiles CASCADE`)
  }
  return false
}

// ---------------------------------------------------------------------------
// Bulk INSERT helper — one round-trip per batch. Build a multi-row
// VALUES clause with parameterised placeholders. `pg`'s default
// driver caps single-statement parameter count at ~65k (Postgres
// protocol limit); the caller's batchSize × column count must stay
// under that. With our largest-row schema (attestations, ~12 cols)
// and batchSize 5000, that's 60k params — within budget.
// ---------------------------------------------------------------------------
async function bulkInsert(
  client: pg.Pool,
  table: string,
  columns: string[],
  rows: unknown[][],
): Promise<void> {
  if (rows.length === 0) return
  const colList = columns.join(', ')
  const placeholderRows: string[] = []
  const params: unknown[] = []
  let p = 0
  for (const row of rows) {
    const placeholders = row.map(() => `$${++p}`)
    placeholderRows.push(`(${placeholders.join(', ')})`)
    params.push(...row)
  }
  const stmt = `INSERT INTO ${table} (${colList}) VALUES ${placeholderRows.join(', ')}`
  await client.query(stmt, params)
}

// ---------------------------------------------------------------------------
// Seeder.
// ---------------------------------------------------------------------------
async function seed(cfg: SeedConfig): Promise<void> {
  const startedAt = Date.now()
  console.error(
    `[seed] target: ${cfg.attestationCount} attestations / ${cfg.subjectCount} subjects / ${cfg.didCount} dids`,
  )

  const pool = new Pool({ connectionString: cfg.databaseUrl, max: 4 })
  try {
    if (await checkIdempotency(pool, cfg)) return

    const rng = mulberry32(cfg.rngSeed)
    const subjectPicker = makeZipfPicker(cfg.subjectCount, 1.07, rng)
    const authorPicker = makeZipfPicker(cfg.didCount, 1.15, rng)

    // Phase 1 — subjects.
    console.error(`[seed] phase 1 — subjects (${cfg.subjectCount})`)
    for (let i = 0; i < cfg.subjectCount; i += cfg.batchSize) {
      const rows: unknown[][] = []
      const end = Math.min(i + cfg.batchSize, cfg.subjectCount)
      for (let j = i; j < end; j++) {
        const cat = CATEGORIES[j % CATEGORIES.length]
        rows.push([
          subjectId(j),
          `LoadTest Subject ${j}`,
          'product',
          cat,
          // Non-empty metadata so RANK-001's region predicate has
          // something to filter on; alternates between US/GB so
          // viewerRegion-aware tests see realistic selectivity.
          JSON.stringify({ availability: { regions: [j % 2 === 0 ? 'US' : 'GB'] } }),
          LANGUAGES[j % LANGUAGES.length],
        ])
      }
      await bulkInsert(
        pool,
        'subjects',
        ['id', 'name', 'subject_type', 'category', 'metadata', 'language'],
        rows,
      )
      if ((i / cfg.batchSize) % 10 === 0) {
        process.stderr.write(`  inserted ${end}/${cfg.subjectCount}\r`)
      }
    }
    process.stderr.write('\n')

    // Phase 2 — did_profiles.
    console.error(`[seed] phase 2 — did_profiles (${cfg.didCount})`)
    for (let i = 0; i < cfg.didCount; i += cfg.batchSize) {
      const rows: unknown[][] = []
      const end = Math.min(i + cfg.batchSize, cfg.didCount)
      const computedAt = new Date().toISOString()
      for (let j = i; j < end; j++) {
        rows.push([
          authorDid(j),
          syntheticHandle(j),
          rng().toFixed(4),
          0, // total_attestations_about — bumped during scoring; seeder leaves at 0.
          computedAt,
        ])
      }
      await bulkInsert(
        pool,
        'did_profiles',
        ['did', 'handle', 'overall_trust_score', 'total_attestations_about', 'computed_at'],
        rows,
      )
    }

    // Phase 3 — attestations. Author + subject sampled via the
    // Zipf picker so a few high-volume reviewers / popular subjects
    // dominate (matches production shape).
    console.error(`[seed] phase 3 — attestations (${cfg.attestationCount})`)
    let attIdx = 0
    for (let i = 0; i < cfg.attestationCount; i += cfg.batchSize) {
      const rows: unknown[][] = []
      const end = Math.min(i + cfg.batchSize, cfg.attestationCount)
      const now = new Date()
      for (let j = i; j < end; j++) {
        const subjIdx = subjectPicker()
        const authorIdx = authorPicker()
        const sentiment = SENTIMENTS[j % SENTIMENTS.length]
        const cat = CATEGORIES[j % CATEGORIES.length]
        const uri = attestationUri(authorIdx, attIdx++)
        // Stagger record_created_at backward so cursor-based search
        // pagination tests see realistic timestamp distribution.
        const ageMinutes = j * 0.001 // 1M rows spread across ~16 hours
        const recordCreatedAt = new Date(now.getTime() - ageMinutes * 60_000)
        rows.push([
          uri,
          authorDid(authorIdx),
          syntheticCid(uri),
          subjectId(subjIdx),
          JSON.stringify({ type: 'product', name: `LoadTest Subject ${subjIdx}` }),
          cat,
          sentiment,
          'Sturdy build. Fast shipping. Good for everyday use.',
          // tags as text[] — pg expects PG-array literal `{a,b}`.
          `{${cat},${sentiment}}`,
          `LoadTest Subject ${subjIdx} ${cat} ${sentiment} sturdy fast shipping good everyday`,
          LANGUAGES[j % LANGUAGES.length],
          recordCreatedAt.toISOString(),
        ])
      }
      await bulkInsert(
        pool,
        'attestations',
        [
          'uri',
          'author_did',
          'cid',
          'subject_id',
          'subject_ref_raw',
          'category',
          'sentiment',
          'text',
          'tags',
          'search_content',
          'language',
          'record_created_at',
        ],
        rows,
      )
      if ((i / cfg.batchSize) % 10 === 0) {
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0)
        process.stderr.write(`  inserted ${end}/${cfg.attestationCount} (${elapsed}s)\r`)
      }
    }
    process.stderr.write('\n')

    const totalSec = ((Date.now() - startedAt) / 1000).toFixed(1)
    console.error(`[seed] done in ${totalSec}s`)
  } finally {
    await pool.end()
  }
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------
const args = process.argv.slice(2)
const cfg = args.includes('--smoke') ? SMOKE_CONFIG : DEFAULT_CONFIG

seed(cfg).catch((err) => {
  console.error('[seed] failed:', err)
  process.exit(1)
})
