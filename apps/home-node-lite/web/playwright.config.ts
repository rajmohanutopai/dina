/**
 * Render-smoke Playwright config — the HTTP-surface + route-render tier.
 *
 * Serves the plain `dist/` bundle (no onboarding autopilot) and runs the
 * smoke specs directly under `__e2e__/` (smoke, onboarding render-walk,
 * chat-API, tab-routes, d2d-websocket). It deliberately EXCLUDES the
 * functional MRS flows (`__e2e__/functional/**`, which need the autopilot
 * bundle + live Gemini) and the judge calibration (needs a Gemini key) —
 * those run under `playwright.functional.config.ts`, keeping this tier
 * hermetic and secret-free.
 *
 * The core+brain webServer wiring is shared with the functional config via
 * `buildStack` (fresh temp vault, brain service-key allowlisted in Core,
 * debug-dispatch on, conditional Gemini) — see `__e2e__/support/stack.ts`.
 *
 * Preconditions: `dist/index.html` exists (`npm run … build:bundle`) and
 * Chromium is installed (`… test:e2e:install`).
 */

import path from 'node:path';

import { defineConfig, devices } from '@playwright/test';

import { buildStack } from './__e2e__/support/stack';

const stack = buildStack({ bundleDir: 'dist' });

export default defineConfig({
  testDir: path.resolve(__dirname, '__e2e__'),
  // Only run TypeScript sources — Playwright's default testMatch also
  // matches compiled `*.spec.js`, so a stale build artifact would run twice
  // (or run an out-of-date copy). The .ts is the single source of truth.
  testMatch: '**/*.spec.ts',
  // Keep this tier hermetic: the functional MRS flows + judge calibration
  // need the autopilot bundle and/or a Gemini key, and run under
  // playwright.functional.config.ts.
  testIgnore: ['**/functional/**', '**/judge.calibration.spec.ts'],
  globalSetup: path.resolve(__dirname, '__e2e__', 'setup.ts'),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: stack.baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: stack.webServer,
});
