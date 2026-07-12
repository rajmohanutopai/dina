/**
 * Phase 1 web e2e setup — builds the SPA bundle FRESH before the suite,
 * then sanity-checks it exists.
 *
 * Why build here, not just check: a Playwright run must never test a
 * STALE bundle. The plugin-substrate F1 regression (`node:crypto` reaching
 * `@dina/core`, breaking the Metro bundle) slipped a "full validation"
 * precisely because the E2E served a prebuilt bundle from a prior day — so
 * it validated the Node backend + an old UI and never re-bundled the
 * changed code. Building in `globalSetup` means the export runs however
 * Playwright is launched (`npm run test:e2e`, `npx playwright test`, an IDE
 * runner), so a Metro resolution break now fails the E2E run itself.
 *
 * Which bundle: the smoke tier serves `dist`; the functional/PR tiers set
 * `DINA_E2E_BUNDLE_DIR=dist-e2e` (the onboarding-autopilot build) before
 * `defineConfig`. Each maps to its own build script.
 *
 * Escape hatches (both skip the rebuild and fall back to a fail-fast
 * existence check):
 *   - `DINA_E2E_PREBUILT=1`     — CI already ran `build:bundle` in an
 *     explicit step; don't build twice.
 *   - `DINA_E2E_SKIP_BUNDLE=1`  — fast local iteration on specs only, when
 *     the app code hasn't changed.
 *
 * Shared by playwright.config.ts, playwright.pr.config.ts, and
 * playwright.functional.config.ts. (The relay config uses its own setup.)
 *
 * Source: docs/HOME_NODE_LITE_WEB_UI_TASKS.md Phase 1.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { FullConfig } from '@playwright/test';

// Which bundle to build/precheck — the smoke tier serves `dist`, the
// functional/PR tiers serve the autopilot `dist-e2e`. Each config sets
// this before defineConfig so we build (and point any error at) the right
// one.
const BUNDLE_DIR_NAME = process.env.DINA_E2E_BUNDLE_DIR ?? 'dist';
const BUNDLE_DIR = path.resolve(__dirname, '..', BUNDLE_DIR_NAME);
const INDEX_HTML = path.join(BUNDLE_DIR, 'index.html');
const BUILD_SCRIPT = BUNDLE_DIR_NAME === 'dist-e2e' ? 'build:bundle:e2e' : 'build:bundle';
// Argument array (no shell) — BUILD_SCRIPT is one of two hardcoded
// literals, so there's no injection surface, but execFileSync keeps it
// shell-free regardless. BUILD_CMD is the display form for messages only.
const BUILD_ARGS = ['run', '-w', '@dina/home-node-lite-web-e2e', BUILD_SCRIPT];
const BUILD_CMD = `npm ${BUILD_ARGS.join(' ')}`;
// npm workspace commands resolve from the repo root.
// __dirname = apps/home-node-lite/web/__e2e__ → repo root is four up.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

const SKIP_BUILD =
  process.env.DINA_E2E_PREBUILT === '1' || process.env.DINA_E2E_SKIP_BUNDLE === '1';

export default async function globalSetup(_config: FullConfig): Promise<void> {
  if (!SKIP_BUILD) {
    // Build the bundle fresh so the suite can never test a stale one. A
    // Metro resolution error (e.g. a `node:crypto` import in portable
    // Core) throws here and aborts the run with the build output visible —
    // exactly the failure that must not slip through again.
    console.log(`[e2e] building fresh SPA bundle (${BUNDLE_DIR_NAME}) via \`${BUILD_SCRIPT}\`…`);
    try {
      execFileSync('npm', BUILD_ARGS, { cwd: REPO_ROOT, stdio: 'inherit' });
    } catch {
      throw new Error(
        [
          '',
          `The SPA bundle build failed (\`${BUILD_CMD}\`).`,
          'The web E2E rebuilds the bundle from apps/mobile before running so it',
          'never tests a stale bundle — a Metro resolution error (e.g. a Node-only',
          'import reaching @dina/core) fails here rather than silently serving old JS.',
          'Fix the bundle error above, or set DINA_E2E_SKIP_BUNDLE=1 to run against',
          'the existing bundle for fast spec-only iteration.',
          '',
        ].join('\n'),
      );
    }
  }

  if (!fs.existsSync(INDEX_HTML)) {
    throw new Error(
      [
        '',
        'The SPA bundle is missing at:',
        `  ${INDEX_HTML}`,
        '',
        SKIP_BUILD
          ? `Bundle build was skipped (DINA_E2E_PREBUILT / DINA_E2E_SKIP_BUNDLE). Build it with:\n  ${BUILD_CMD}`
          : 'The build ran but produced no index.html — inspect the build output above.',
        '',
      ].join('\n'),
    );
  }
}
