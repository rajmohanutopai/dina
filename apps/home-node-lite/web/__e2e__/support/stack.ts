/**
 * Shared two-server stack builder for the Playwright configs.
 *
 * Both the render-smoke config (`playwright.config.ts`, serves the plain
 * `dist/`) and the functional config (`playwright.functional.config.ts`,
 * serves the onboarding-autopilot `dist-e2e/`) need the same core+brain
 * webServer wiring: a fresh temp vault, a brain Ed25519 service key whose
 * did:key is pre-registered in Core's allowlist, debug-dispatch on, and
 * conditional live Gemini. This module builds that once, parameterized by
 * the SPA bundle directory, so neither config duplicates it.
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as ed25519 from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { base58 } from '@scure/base';

// @noble/ed25519 v3+ needs explicit SHA-512 — mirror
// packages/core/src/crypto/ed25519.ts so the derived did:key matches the
// one brain-server derives at boot from the same seed.
const edHashes = ed25519.hashes as { sha512?: (...msgs: Uint8Array[]) => Uint8Array };
edHashes.sha512 = (...msgs: Uint8Array[]) => {
  const h = sha512.create();
  for (const m of msgs) h.update(m);
  return h.digest();
};

function deriveBrainDidKey(seed: Uint8Array): string {
  const publicKey = ed25519.getPublicKey(seed);
  const payload = new Uint8Array(2 + publicKey.length);
  payload[0] = 0xed; // Ed25519 multicodec varint prefix
  payload[1] = 0x01;
  payload.set(publicKey, 2);
  return `did:key:z${base58.encode(payload)}`;
}

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const WEB_DIR = path.resolve(__dirname, '..', '..');

const GEMINI_KEY =
  process.env.DINA_GEMINI_API_KEY ??
  process.env.GEMINI_API_KEY ??
  process.env.GOOGLE_API_KEY ??
  '';

/** Minimal structural type — avoids importing Playwright's WebServer type
 *  (keeps this module a plain helper, not a Playwright-typed file). */
export interface WebServerEntry {
  command: string;
  cwd: string;
  url: string;
  timeout: number;
  reuseExistingServer: boolean;
  env: Record<string, string>;
}

export interface BuiltStack {
  corePort: number;
  brainPort: number;
  baseURL: string;
  /** True when a Gemini key is present → Brain boots the real provider. */
  live: boolean;
  /** Server stdout log files (for the MRS-14 log-hygiene teardown). */
  coreLogPath: string;
  brainLogPath: string;
  webServer: WebServerEntry[];
}

/**
 * Build the core+brain webServer pair serving `bundleDir` (relative to the
 * web package). Each call mints a fresh temp vault + service-key dir, so
 * every `playwright test` invocation starts clean.
 *
 * `logLevel` controls both servers' verbosity. The functional tier passes
 * a verbose level so the MRS-14 log-hygiene sweep can see any leak — a
 * `warn`-only sweep would miss content logged at info/debug.
 *
 * `provisionPds` mints a real did:plc for Core on test-pds (unique handle
 * per stack) — REQUIRED for the agent tier, because Core only wires the
 * workflow/approval plane (`/v1/agent/validate`, `/v1/workflow/*`) when it
 * has a PDS identity. It adds ~5-15s to Core boot (network + PLC), so the
 * render-smoke tier leaves it off.
 */
export function buildStack(opts: {
  bundleDir: string;
  logLevel?: string;
  provisionPds?: boolean;
  /** Force Brain to boot with NO LLM provider (hermetic PR tier). The
   *  deterministic agent-safety flows (gatekeeper / workflow / agent
   *  perimeter) need no product LLM, so they run with zero secrets. */
  noLlm?: boolean;
}): BuiltStack {
  const corePort = Number(process.env.DINA_CORE_E2E_PORT ?? 18298);
  const brainPort = Number(process.env.DINA_BRAIN_E2E_PORT ?? 18299);
  const baseURL = `http://127.0.0.1:${brainPort}`;

  const stackDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-pw-stack-'));
  const vaultDir = path.join(stackDir, 'vault');
  const serviceKeyDir = path.join(stackDir, 'service-keys');
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.mkdirSync(serviceKeyDir, { recursive: true });

  const brainKeyFile = 'brain.ed25519';
  const brainKeyPath = path.join(serviceKeyDir, brainKeyFile);
  fs.writeFileSync(brainKeyPath, randomBytes(32), { mode: 0o600 });
  const brainDid = deriveBrainDidKey(new Uint8Array(fs.readFileSync(brainKeyPath)));

  // Explicit env override wins; else the caller's choice; else warn. The
  // functional (hygiene) tier passes a verbose level so the MRS-14 sweep
  // sees content logged below warn.
  const logLevel = process.env.DINA_E2E_LOG_LEVEL ?? opts.logLevel ?? 'warn';
  const bundleAbs = path.resolve(WEB_DIR, opts.bundleDir);

  // Capture each server's stdout to a file (via tee, so Playwright still
  // shows it) for the MRS-14 log-hygiene sweep. Publish the stack dir so
  // the global teardown can find the logs.
  const coreLogPath = path.join(stackDir, 'core.log');
  const brainLogPath = path.join(stackDir, 'brain.log');
  process.env.DINA_E2E_STACK_DIR = stackDir;

  // Agent tier: a unique PDS handle per stack (derived from the random
  // mkdtemp suffix, tied to this vault) so a fresh vault mints a fresh
  // did:plc rather than colliding on a taken handle.
  const pdsEnv: Record<string, string> = opts.provisionPds
    ? {
        DINA_PDS_PROVISION: '1',
        DINA_PDS_HANDLE: `e2e${path
          .basename(stackDir)
          .replace(/[^a-z0-9]/gi, '')
          .toLowerCase()
          .slice(-12)}.test-pds.dinakernel.com`,
      }
    : {};
  // Provisioning is a network round-trip (createAccount + PLC) — give Core
  // a longer boot window when it's on.
  const coreBootTimeout = opts.provisionPds ? 90_000 : 30_000;

  const brainLlmEnv: Record<string, string> = opts.noLlm
    ? { DINA_BRAIN_LLM_PROVIDER: 'none' }
    : GEMINI_KEY !== ''
      ? {
          DINA_BRAIN_LLM_PROVIDER: 'gemini',
          DINA_GEMINI_API_KEY: GEMINI_KEY,
          ...(process.env.DINA_GEMINI_MODEL !== undefined
            ? { DINA_GEMINI_MODEL: process.env.DINA_GEMINI_MODEL }
            : {}),
        }
      : {};
  const live = !opts.noLlm && GEMINI_KEY !== '';

  return {
    corePort,
    brainPort,
    baseURL,
    live,
    coreLogPath,
    brainLogPath,
    webServer: [
      {
        command: `npm start --workspace=@dina/home-node-lite-core-server 2>&1 | tee ${JSON.stringify(coreLogPath)}`,
        cwd: REPO_ROOT,
        url: `http://127.0.0.1:${corePort}/healthz`,
        timeout: coreBootTimeout,
        // Always boot fresh — reusing a lingering server would run tests
        // against a stale vault and (worse) leave the MRS-14 log tee empty,
        // making the hygiene sweep pass vacuously. A port clash here is a
        // real signal to clean up, not something to paper over.
        reuseExistingServer: false,
        env: {
          DINA_CORE_HOST: '127.0.0.1',
          DINA_CORE_PORT: String(corePort),
          DINA_VAULT_DIR: vaultDir,
          DINA_LOG_LEVEL: logLevel,
          DINA_RATE_LIMIT: '100000',
          DINA_BRAIN_DID: brainDid,
          // Backstage hook (loopback-only owner-bypass); refuses release
          // endpoints, so keep the endpoint mode test.
          DINA_DEBUG_MODE: '1',
          DINA_ENDPOINT_MODE: 'test',
          ...pdsEnv,
        },
      },
      {
        command: `npm start --workspace=@dina/home-node-lite-brain-server 2>&1 | tee ${JSON.stringify(brainLogPath)}`,
        cwd: REPO_ROOT,
        url: `${baseURL}/healthz`,
        timeout: 30_000,
        // Always boot fresh — reusing a lingering server would run tests
        // against a stale vault and (worse) leave the MRS-14 log tee empty,
        // making the hygiene sweep pass vacuously. A port clash here is a
        // real signal to clean up, not something to paper over.
        reuseExistingServer: false,
        env: {
          DINA_BRAIN_WEB_UI: '1',
          DINA_BRAIN_HOST: '127.0.0.1',
          DINA_BRAIN_PORT: String(brainPort),
          DINA_BRAIN_LOG_LEVEL: logLevel,
          DINA_BRAIN_WEB_BUNDLE_DIR: bundleAbs,
          DINA_CORE_URL: `http://127.0.0.1:${corePort}`,
          DINA_SERVICE_KEY_DIR: serviceKeyDir,
          DINA_BRAIN_SERVICE_KEY_FILE: brainKeyFile,
          ...brainLlmEnv,
        },
      },
    ],
  };
}
