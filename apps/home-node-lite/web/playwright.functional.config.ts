/**
 * Functional Playwright config — the human-perspective MRS flows.
 *
 * Distinct from the render-smoke `playwright.config.ts`: this serves the
 * onboarding-AUTOPILOT bundle (`dist-e2e/`, built with
 * EXPO_PUBLIC_DINA_DEV_PASSPHRASE) so a fresh browser auto-onboards →
 * auto-unlocks → lands on Chat, and boots Brain with live Gemini so
 * /remember + /ask actually work. Runs only `__e2e__/functional/**`.
 *
 * Build the bundle first:
 *   EXPO_PUBLIC_DINA_DEV_PASSPHRASE=<pass> EXPO_PUBLIC_DINA_DEV_OWNER=<name> \
 *     npm run -w @dina/home-node-lite-web-e2e build:bundle:e2e
 * Run:
 *   GEMINI_API_KEY=… DINA_E2E_LIVE_JUDGE=1 \
 *     npm run -w @dina/home-node-lite-web-e2e test:e2e:functional
 */

import path from 'node:path';

import { defineConfig, devices } from '@playwright/test';

import { buildStack } from './__e2e__/support/stack';

// The functional config embodies the judge's data-safety contract: it
// boots a FRESH temp vault against TEST endpoints, so everything the judge
// ever sees is seeded test data. Assert the opt-in here so judged specs
// run without each having to set it.
process.env.DINA_E2E_LIVE_JUDGE = '1';
// Precheck the autopilot bundle (not the plain `dist`) in globalSetup.
process.env.DINA_E2E_BUNDLE_DIR = 'dist-e2e';

// `info` (not the default `warn`) so the MRS-14 server-log sweep sees any
// content that leaks at info level, not just warn/error.
// `provisionPds` mints Core a did:plc so the agent/approval workflow plane
// wires (MRS-06/07/08). It also makes the owner-never-gated server-side
// check in MRS-01 active (the plane is present to answer).
const stack = buildStack({ bundleDir: 'dist-e2e', logLevel: 'info', provisionPds: true });

export default defineConfig({
  testDir: path.resolve(__dirname, '__e2e__', 'functional'),
  testMatch: '**/*.spec.ts', // .ts only — ignore any stale compiled *.spec.js
  // Fail fast if the autopilot bundle is missing (points at build:bundle:e2e).
  globalSetup: path.resolve(__dirname, '__e2e__', 'setup.ts'),
  // MRS-14: scan both servers' captured logs for leaks after the run.
  globalTeardown: path.resolve(__dirname, '__e2e__', 'support', 'log_teardown.ts'),
  // One retry for genuine transient LLM hiccups (a real Gemini call can
  // occasionally 5xx / rate-limit). Deterministic cross-test brain-state
  // issues are handled by ORDER instead — the state-perturbing durability
  // reload test runs last (zz_ prefix) so it can't cascade into others.
  // The proper fix (a fresh stack per test) is an open item — see F3.
  retries: 1,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  // Onboarding autopilot provisions a real did:plc against test-pds, then
  // runs the argon2 unlock KDF — comfortably slow. Plus a live-LLM turn can
  // hit a transient Gemini rate-limit backoff under combined load. Give
  // flows headroom for both (see F3).
  timeout: 180_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: stack.baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: stack.webServer,
});
