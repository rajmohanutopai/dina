/**
 * Phase 1 web e2e setup — sanity-checks the preconditions Playwright
 * relies on before the suite runs.
 *
 * Playwright's `webServer` block in `playwright.config.ts` already
 * spawns brain-server, so we don't start anything here. We just
 * fail fast with a useful message when the SPA bundle is missing —
 * that's the most common local-setup mistake.
 *
 * To opt into this check, add `globalSetup: './__e2e__/setup.ts'`
 * to `playwright.config.ts`. We register it from the config so the
 * file isn't dead code.
 *
 * Source: docs/HOME_NODE_LITE_WEB_UI_TASKS.md Phase 1.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { FullConfig } from '@playwright/test';

// Which bundle to precheck — the smoke tier serves `dist`, the functional
// tier serves the autopilot `dist-e2e`. Each config sets this before
// defineConfig so the fail-fast message points at the right build command.
const BUNDLE_DIR_NAME = process.env.DINA_E2E_BUNDLE_DIR ?? 'dist';
const BUNDLE_DIR = path.resolve(__dirname, '..', BUNDLE_DIR_NAME);
const INDEX_HTML = path.join(BUNDLE_DIR, 'index.html');
const BUILD_CMD =
  BUNDLE_DIR_NAME === 'dist-e2e'
    ? 'npm run -w @dina/home-node-lite-web-e2e build:bundle:e2e'
    : 'npm run -w @dina/home-node-lite-web-e2e build:bundle';

export default async function globalSetup(_config: FullConfig): Promise<void> {
  if (!fs.existsSync(INDEX_HTML)) {
    throw new Error(
      [
        '',
        'The SPA bundle is missing at:',
        `  ${INDEX_HTML}`,
        '',
        'Build it first with:',
        `  ${BUILD_CMD}`,
        '',
        'CI does this automatically. Locally, run it once after each',
        'change to apps/mobile that should be reflected in the web build.',
      ].join('\n'),
    );
  }
}
