/**
 * Services Playwright config — the REAL push-services loop, deterministic + $0.
 *
 * Boots one Home Node Lite (autopilot bundle) with:
 *   - the deterministic `scripted` LLM provider (so the provider's Tier-1
 *     eta_query answer is fixed and offline — no Gemini, no cost),
 *   - the real MsgBox D2D transport (`msgbox: true` → the node can send +
 *     receive `service.query`/`service.response` over the deployed test relay),
 *   - PDS provisioning (implied by MsgBox — the node needs a reachable did:plc).
 *
 * The single node services ITSELF: it publishes a public eta_query listing and
 * subscribes to its own DID's listing, so the poll goes out over MsgBox and the
 * answer comes back over MsgBox (a public service accepts an eta_query from any
 * sender, including self) — the full signed/relayed path, one stack.
 *
 * Build the autopilot bundle first, then:
 *   npm run -w @dina/home-node-lite-web-e2e test:e2e:services
 */

import path from 'node:path';

import { defineConfig, devices } from '@playwright/test';

import { buildStack } from './__e2e__/support/stack';

process.env.DINA_E2E_BUNDLE_DIR = 'dist-e2e';

const stack = buildStack({
  bundleDir: 'dist-e2e',
  logLevel: 'info',
  msgbox: true,
  scriptedLlmFile: path.resolve(__dirname, '__e2e__', 'fixtures', 'scripted', 'services.json'),
});

export default defineConfig({
  testDir: path.resolve(__dirname, '__e2e__', 'services'),
  testMatch: '**/*.spec.ts',
  globalSetup: path.resolve(__dirname, '__e2e__', 'setup.ts'),
  globalTeardown: path.resolve(__dirname, '__e2e__', 'support', 'log_teardown.ts'),
  // A subscription's first poll is at least 60s out (the hard floor), plus the
  // D2D round-trip over MsgBox (~15s) and the initial provision/onboard. Give
  // the delivery flow real headroom.
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  timeout: 240_000,
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
