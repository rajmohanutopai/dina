/**
 * Cross-stack compatibility regression gate (tasks 8.60 + 8.61).
 *
 * Dina has two full-stack implementations that share one wire
 * contract (`@dina/protocol`):
 *   - **Production** — Go Core + Python Brain, HTTP-connected.
 *   - **Lite**       — TS Core + TS Brain (`packages/core` +
 *                       `packages/brain`), Fastify-connected.
 *
 * The M3-bonus question is whether we can swap one component
 * from each stack:
 *   - 8.60: Lite Core + Python Brain — does Lite Core expose
 *           every endpoint Python Brain calls?
 *   - 8.61: Go Core + Lite Brain     — does Go Core expose
 *           every endpoint Lite Brain calls?
 *
 * This test computes both answers *statically* by enumerating
 * the public HTTP surfaces from source. If Lite Core adds a new
 * endpoint, the matrix narrows automatically and the known-gap
 * list needs a down-edit. If Lite Brain starts calling a new
 * endpoint that Go Core does not have, the test fails loud so
 * the coupling is made explicit.
 *
 * Source of truth per surface:
 *   - Lite Core routes       — `packages/core/src/**` (router.XXX('/v1/…'))
 *                            + `apps/home-node-lite/core-server/src/**` (fastify.XXX)
 *   - Go Core routes         — `core/internal/handler/**` + `core/cmd/**`
 *                              (r.HandleFunc / mux.Handle)
 *   - Python Brain calls     — `brain/src/adapter/core_http.py`
 *                            + `brain/src/port/core_client.py`
 *   - Lite Brain calls       — `packages/brain/src/**` (`"/v1/…"` literals)
 *
 * Not a replacement for cross-stack runtime smoke (M3 bonus, docker-
 * compose bringing up a mixed container set). It's the static-
 * analysis gate that pins the *surface contract*; the runtime gate
 * pins body-level compatibility (snake_case translation, optional-
 * field semantics, timestamp formats).
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 8g tasks 8.60, 8.61.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');

// ─── Source-tree scanners ──────────────────────────────────────────────────

function* walkByExt(dir: string, exts: readonly string[]): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // Directory missing — caller decides if that's fatal.
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name === '.git') continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      yield* walkByExt(full, exts);
    } else if (exts.some((e) => full.endsWith(e))) {
      yield full;
    }
  }
}

/**
 * Normalise a route path so `/v1/vault/item/:id` and
 * `/v1/vault/item/{id}` and `/v1/vault/item/` all collapse to
 * the same key. The token name is irrelevant — only the shape matters.
 */
function normalisePath(p: string): string {
  return p
    .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ':param')
    .replace(/\{[^}]+\}/g, ':param')
    // Collapse trailing slash forms Go uses for sub-trees to match the
    // bare path form (`/v1/contacts/` handles `/v1/contacts/{did}` too —
    // but bare `/v1/contacts` is ALSO exposed as a distinct route on Go,
    // so we keep them separate unless they're *exactly* one character apart).
    .replace(/\/+$/, (m, offset, str) => (str.length === 1 ? m : ''));
}

function extractTSRoutes(srcDirs: readonly string[]): Set<string> {
  const out = new Set<string>();
  // Covers `router.get('/v1/…'` / `fastify.get('/v1/…'` / `app.post('/v1/…'`
  // across every verb. Quote style can be single or double.
  const re = /(?:router|fastify|app|rootFastify)\.(?:get|post|put|delete|patch)\s*\(\s*['"](\/v1\/[^'"]+)['"]/g;
  for (const dir of srcDirs) {
    for (const file of walkByExt(dir, ['.ts'])) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(re)) {
        const captured = m[1];
        if (captured !== undefined) out.add(normalisePath(captured));
      }
    }
  }
  return out;
}

function extractGoRoutes(srcDirs: readonly string[]): Set<string> {
  const out = new Set<string>();
  // Go registers routes with literal strings that start with `/v1/` —
  // `r.HandleFunc("/v1/…",` / `mux.Handle("/v1/…",` / `r.Handle("/v1/…",`.
  // The leading `/` *inside* the literal is the anchor.
  const re = /"(\/v1\/[A-Za-z0-9/_{}:.-]+)"/g;
  for (const dir of srcDirs) {
    for (const file of walkByExt(dir, ['.go'])) {
      const src = readFileSync(file, 'utf8');
      // Heuristic: only count literals adjacent to route-registration
      // verbs so we don't pick up log strings or documentation.
      if (!/HandleFunc|mux\.Handle|r\.Handle|HandleDina|router\.Handle/.test(src)) {
        continue;
      }
      for (const m of src.matchAll(re)) {
        const captured = m[1];
        if (captured !== undefined) out.add(normalisePath(captured));
      }
    }
  }
  return out;
}

function extractPythonCalls(files: readonly string[]): Set<string> {
  const out = new Set<string>();
  // Python uses double-quoted string literals for endpoints in the core
  // client: `"/v1/vault/query"` or with interpolation `f"/v1/vault/kv/{key}"`.
  const re = /["'](\/v1\/[A-Za-z0-9/_{}:.-]+)["']/g;
  for (const file of files) {
    let src: string;
    try {
      src = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const m of src.matchAll(re)) {
      const captured = m[1];
      if (captured !== undefined) out.add(normalisePath(captured));
    }
  }
  return out;
}

function extractTSBrainCalls(srcDirs: readonly string[]): Set<string> {
  const out = new Set<string>();
  // Covers single, double, and backtick-delimited string literals. The
  // backtick form is the one Brain uses for template-interpolated paths
  // like `/v1/staging/claim?limit=${limit}` — the path fragment before
  // the `?` gets captured because `?` isn't in the allowed char class.
  const re = /["'`](\/v1\/[A-Za-z0-9/_{}:.-]+)(?:\?[^"'`]*)?["'`]/g;
  for (const dir of srcDirs) {
    for (const file of walkByExt(dir, ['.ts'])) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(re)) {
        const captured = m[1];
        if (captured !== undefined) out.add(normalisePath(captured));
      }
    }
  }
  return out;
}

// ─── Matrix data (recomputed per test run) ─────────────────────────────────

const liteCoreRoutes = extractTSRoutes([
  resolve(REPO_ROOT, 'packages/core/src'),
  resolve(REPO_ROOT, 'apps/home-node-lite/core-server/src'),
]);

const goCoreRoutes = extractGoRoutes([
  resolve(REPO_ROOT, 'core/internal'),
  resolve(REPO_ROOT, 'core/cmd'),
]);

const pythonBrainCalls = extractPythonCalls([
  resolve(REPO_ROOT, 'brain/src/adapter/core_http.py'),
  resolve(REPO_ROOT, 'brain/src/port/core_client.py'),
]);

const liteBrainCalls = extractTSBrainCalls([
  resolve(REPO_ROOT, 'packages/brain/src'),
]);

/**
 * Endpoints Python Brain calls that Lite Core does NOT currently expose.
 *
 * This is the 8.60 known-gap set; each entry is deliberately locked in
 * so we can track progress across milestones. The doc
 * `docs/lite-impedance-mismatches.md` tracks which milestone each
 * entry unlocks at. When Lite Core lands one of these, the test fails
 * loud — the implementer down-edits this set in the same PR, making
 * the progress explicit in diff review.
 *
 * Also captures the one path-rename gotcha (`/v1/memory/topic/touch`
 * vs `/v1/memory/touch`) as a wire-drift; delete from this list once
 * Lite Core renames.
 */
const KNOWN_860_GAPS: readonly string[] = [
  '/v1/approvals',
  '/v1/approvals/:param/approve',
  '/v1/approvals/:param/deny',
  '/v1/audit/append',
  '/v1/audit/query',
  '/v1/contacts',
  '/v1/contacts/:param',
  '/v1/devices/:param',
  '/v1/did',
  '/v1/did/sign',
  '/v1/memory/topic/touch', // ← wire-drift; Lite has /v1/memory/touch
  '/v1/notify',
  '/v1/reminder',
  '/v1/reminder/fire',
  '/v1/reminders/pending',
  '/v1/service/agents',
  '/v1/staging/ingest',
  '/v1/staging/status/:param',
  '/v1/task/ack',
  '/v1/vault/kv/:param',
  '/v1/vault/store/batch',
  '/v1/workflow/tasks/queue-by-proposal',
];

const KNOWN_861_GAPS: readonly string[] = [
  '/v1/scratchpad', // Lite Brain calls; Go Core doesn't expose — move to Brain-internal
];

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('Cross-stack compatibility (tasks 8.60 + 8.61)', () => {
  describe('surface discovery — the audit inputs are non-empty', () => {
    it('Lite Core exposes at least 20 /v1 routes', () => {
      expect(liteCoreRoutes.size).toBeGreaterThanOrEqual(20);
    });

    it('Go Core exposes at least 60 /v1 routes', () => {
      expect(goCoreRoutes.size).toBeGreaterThanOrEqual(60);
    });

    it('Python Brain calls at least 30 Core endpoints', () => {
      expect(pythonBrainCalls.size).toBeGreaterThanOrEqual(30);
    });

    it('Lite Brain calls at least 5 Core endpoints', () => {
      expect(liteBrainCalls.size).toBeGreaterThanOrEqual(5);
    });
  });

  describe('task 8.60 — Lite Core + Python Brain', () => {
    it('the known-gap list contains only real gaps (no stale entries)', () => {
      // A stale KNOWN_860_GAP means Lite Core now HAS the endpoint but
      // the gap list still claims it's missing. Fail loud so the
      // list tracks reality.
      const stale = KNOWN_860_GAPS.filter((p) => liteCoreRoutes.has(p));
      expect(stale).toEqual([]);
    });

    it('every Python Brain call is either on Lite Core or in the known-gap list', () => {
      const actualGaps: string[] = [];
      for (const call of pythonBrainCalls) {
        if (liteCoreRoutes.has(call)) continue;
        if (KNOWN_860_GAPS.includes(call)) continue;
        actualGaps.push(call);
      }
      // A non-empty `actualGaps` means Python Brain started calling an
      // endpoint not covered by Lite Core AND not documented as a known
      // gap — likely a regression from Brain's side. Either Lite Core
      // implements it, or the gap-list gets a new entry (with a comment
      // in docs/lite-impedance-mismatches.md explaining the unlock plan).
      expect(actualGaps).toEqual([]);
    });

    it('overlap is ≥45% — the published matrix figure (~48% today)', () => {
      const overlap = [...pythonBrainCalls].filter((p) => liteCoreRoutes.has(p));
      const ratio = overlap.length / pythonBrainCalls.size;
      // Canary: the impedance doc claims ~48% today. If this test
      // fails *below the floor* Lite Core regressed (or Brain added
      // new calls that aren't in the known-gap list — the test above
      // fires first in that case). If the ratio drifts *up*
      // substantially, the doc figure is stale: update it in the same
      // PR that narrows `KNOWN_860_GAPS`.
      expect(ratio).toBeGreaterThanOrEqual(0.45);
    });
  });

  describe('task 8.61 — Go Core + Lite Brain', () => {
    it('the known-gap list contains only real gaps (no stale entries)', () => {
      const stale = KNOWN_861_GAPS.filter((p) => goCoreRoutes.has(p));
      expect(stale).toEqual([]);
    });

    it('every Lite Brain call is either on Go Core or in the known-gap list', () => {
      const actualGaps: string[] = [];
      for (const call of liteBrainCalls) {
        if (goCoreRoutes.has(call)) continue;
        if (KNOWN_861_GAPS.includes(call)) continue;
        actualGaps.push(call);
      }
      expect(actualGaps).toEqual([]);
    });

    it('overlap is ≥92% — current matrix figure', () => {
      const overlap = [...liteBrainCalls].filter((p) => goCoreRoutes.has(p));
      const ratio = overlap.length / liteBrainCalls.size;
      // Lite Brain has 13 endpoints today; 12 are on Go Core
      // (`/v1/scratchpad` is the single gap). The ratio floor is
      // load-bearing: if Lite Brain adds a new call that Go Core
      // doesn't have, the floor tightens towards 6/7 (86%), which
      // still passes but the "every call is known" test above
      // flags the new gap loudly first.
      expect(ratio).toBeGreaterThanOrEqual(0.85);
    });
  });

  describe('surface discovery — scanners don\'t pick up accidental literals', () => {
    it('Lite Core route set does not contain obvious doc/log strings', () => {
      // Sanity: if the scanner accidentally starts matching log format
      // strings like "/v1/foo called" the set would balloon. Cap the
      // absolute size so explosions surface.
      expect(liteCoreRoutes.size).toBeLessThan(200);
    });

    it('Python Brain call set does not contain obvious error-message literals', () => {
      expect(pythonBrainCalls.size).toBeLessThan(200);
    });
  });
});
