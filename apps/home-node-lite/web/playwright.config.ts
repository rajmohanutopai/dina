/**
 * Playwright config for the Home Node Lite Web SPA + paired-stack tests.
 *
 * Two `webServer` entries, started in dependency order:
 *
 *   1. **core-server** — Fastify Core (SQLCipher vault keeper).
 *      Gets a fresh temp `DINA_VAULT_DIR` so every run starts clean.
 *   2. **brain-server** — Fastify Brain (analyst). Reads a 32-byte
 *      Ed25519 service-key seed we generate into a temp dir at
 *      config-load time, points at the freshly-started Core, and
 *      mounts the SPA at `/web/*`.
 *
 * Why generate the seed in the config file (synchronously, at module
 * load)? Playwright spawns `webServer` entries before any test runs;
 * the env vars are read at spawn time. Doing this in a `globalSetup`
 * hook would be too late — the env var would arrive after Brain had
 * already booted with `DINA_BRAIN_SERVICE_KEY_FILE` set to a missing
 * file. Generating at module load means the seed is on disk by the
 * time Playwright forks the child process.
 *
 * Preconditions Playwright trusts the runner to satisfy:
 *
 *   1. `apps/home-node-lite/web/dist/index.html` must exist. CI
 *      builds it with `npm run -w @dina/home-node-lite-web-e2e
 *      build:bundle`. Locally, run the same script once.
 *   2. Chromium has been installed via `playwright install --with-deps
 *      chromium` (CI does this in the workflow).
 *
 * Source: docs/HOME_NODE_LITE_WEB_UI_TASKS.md Phase 1 (initial) + Phases
 * 5-10 (paired-stack expansion).
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { defineConfig, devices } from '@playwright/test';

const CORE_PORT = Number(process.env.DINA_CORE_E2E_PORT ?? 18298);
const BRAIN_PORT = Number(process.env.DINA_BRAIN_E2E_PORT ?? 18299);
const BASE_URL = `http://127.0.0.1:${BRAIN_PORT}`;

// Fresh per-config-load temp tree. Playwright re-loads the config on
// every run, so each `playwright test` invocation gets a clean stack.
// The OS cleans these tmp dirs up on its usual schedule (no manual
// teardown — keeping a few stale runs around is useful for forensics).
const STACK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-pw-stack-'));
const VAULT_DIR = path.join(STACK_DIR, 'vault');
const SERVICE_KEY_DIR = path.join(STACK_DIR, 'service-keys');
fs.mkdirSync(VAULT_DIR, { recursive: true });
fs.mkdirSync(SERVICE_KEY_DIR, { recursive: true });

const BRAIN_KEY_FILE = 'brain.ed25519';
const BRAIN_KEY_PATH = path.join(SERVICE_KEY_DIR, BRAIN_KEY_FILE);
if (!fs.existsSync(BRAIN_KEY_PATH)) {
  // 32-byte Ed25519 seed. The brain-server reads this verbatim
  // (loadBrainServiceKey expects exactly 32 bytes); the public key
  // is derived, and a `did:key:` is computed from it.
  fs.writeFileSync(BRAIN_KEY_PATH, randomBytes(32), { mode: 0o600 });
}

// Anchor the workspace root so npm --workspace runs from a known cwd.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

export default defineConfig({
  testDir: path.resolve(__dirname, '__e2e__'),
  globalSetup: path.resolve(__dirname, '__e2e__', 'setup.ts'),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    // Core — vault keeper. Must boot first; Brain's healthcheck
    // happens after its own process binds the port, so we can't
    // strict-order via Playwright, but Brain's Core-client reload
    // loop retries until Core is reachable.
    {
      command: 'npm start --workspace=@dina/home-node-lite-core-server',
      cwd: REPO_ROOT,
      url: `http://127.0.0.1:${CORE_PORT}/healthz`,
      timeout: 30_000,
      reuseExistingServer: !process.env.CI,
      env: {
        DINA_CORE_HOST: '127.0.0.1',
        DINA_CORE_PORT: String(CORE_PORT),
        DINA_VAULT_DIR: VAULT_DIR,
        DINA_LOG_LEVEL: 'warn',
        // Tests fire many requests in quick succession (Playwright's
        // resource loaders + repeated /api/v1/* hits). Disable the
        // per-DID rate limiter in test mode so a single test run
        // doesn't trip the 60/min cap.
        DINA_RATE_LIMIT: '100000',
      },
    },
    // Brain — analyst. Reads from Core via signed HTTP.
    {
      command: 'npm start --workspace=@dina/home-node-lite-brain-server',
      cwd: REPO_ROOT,
      url: `${BASE_URL}/healthz`,
      timeout: 30_000,
      reuseExistingServer: !process.env.CI,
      env: {
        DINA_BRAIN_WEB_UI: '1',
        DINA_BRAIN_HOST: '127.0.0.1',
        DINA_BRAIN_PORT: String(BRAIN_PORT),
        DINA_BRAIN_LOG_LEVEL: 'warn',
        DINA_BRAIN_WEB_BUNDLE_DIR: path.resolve(__dirname, 'dist'),
        // Point at the just-started Core. Compose service-name DNS
        // is not in play here — both processes are on loopback.
        DINA_CORE_URL: `http://127.0.0.1:${CORE_PORT}`,
        DINA_SERVICE_KEY_DIR: SERVICE_KEY_DIR,
        DINA_BRAIN_SERVICE_KEY_FILE: BRAIN_KEY_FILE,
      },
    },
  ],
});
