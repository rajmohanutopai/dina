/**
 * Hermetic PR-gate config — the every-PR functional tier (docs/E2E_TESTING.md
 * §4.4, §11 "PR gate").
 *
 * The agent-safety flows (MRS-06 delegation, MRS-07 vault-access perimeter,
 * MRS-08 risk ladder + approval state machine) are DETERMINISTIC — they
 * exercise the gatekeeper, the workflow/approval state machine, and the
 * signed-agent authorization perimeter, none of which touch the product LLM.
 * So they run with Brain in `noLlm` mode: NO Gemini key, NO judge, NO secrets,
 * NO relay — direct Playwright assertions on real Core state. This is the
 * cheap, hermetic gate the repo lacked.
 *
 * (The LLM-driven flows — MRS-01/02/03 remember/ask/reminder — need either
 * live Gemini + the judge (nightly, playwright.functional.config.ts) or a
 * scripted product LLM. The scripted variant is an open item: the spec's
 * honesty rule keeps "persona routing" real, but routing is an agentic LLM
 * call in the shipped brain, so a scripted LLM would stub it too — see F5.)
 *
 * Run: npm run -w @dina/home-node-lite-web-e2e test:e2e:pr
 */

import path from 'node:path';

import { defineConfig, devices } from '@playwright/test';

import { buildStack } from './__e2e__/support/stack';

process.env.DINA_E2E_BUNDLE_DIR = 'dist-e2e';

// noLlm: Brain boots with no provider; provisionPds: still wire the workflow
// plane (the agent specs need it); info level: the MRS-14 sweep still runs.
const stack = buildStack({
  bundleDir: 'dist-e2e',
  logLevel: 'info',
  provisionPds: true,
  noLlm: true,
});

export default defineConfig({
  testDir: path.resolve(__dirname, '__e2e__', 'functional'),
  // The deterministic, LLM-free flows: the agent-safety specs (gatekeeper /
  // workflow / signed-agent perimeter) + the PeerLens read (an AppView HTTP
  // query, results-or-empty). None touch the product LLM.
  testMatch: ['**/agent_*.spec.ts', '**/peerlens_read.spec.ts'],
  globalSetup: path.resolve(__dirname, '__e2e__', 'setup.ts'),
  globalTeardown: path.resolve(__dirname, '__e2e__', 'support', 'log_teardown.ts'),
  // Deterministic → no retries needed (a failure is a real failure).
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  // PDS provisioning + argon2 unlock; no LLM latency to absorb.
  timeout: 90_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: stack.baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: stack.webServer,
});
