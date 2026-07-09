/**
 * Relay (two-humans) config — drives the EXTERNAL dina-nodes web UIs.
 *
 * Unlike the other configs, this one has NO webServer: the two full home
 * nodes (alonso :8401, sancho :8402) run out-of-process via `dina-nodes/`
 * (provision + start + connect), against the cloud test relay. Playwright
 * opens each node's `<brain>/web/` as a separate person (§ twoHumans).
 *
 * Prereq: `cd dina-nodes && ./start.sh alonso sancho && ./connect.sh alonso sancho`.
 * Run:    npm run -w @dina/home-node-lite-web-e2e test:e2e:relay
 */
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: path.resolve(__dirname, '__e2e__', 'relay'),
  testMatch: '**/*.spec.ts',
  workers: 1,
  retries: 0,
  reporter: 'list',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  use: { trace: 'on-first-retry', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // MRS-14 (server-log half) for the relay tier: record each dina-node log's
  // size before the run, sweep only this-run's appended lines after.
  globalSetup: path.resolve(__dirname, '__e2e__', 'support', 'relay_setup.ts'),
  globalTeardown: path.resolve(__dirname, '__e2e__', 'support', 'relay_teardown.ts'),
});
