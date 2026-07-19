/**
 * Send a single D2D Talk message to the MOBILE app's DID over real MsgBox.
 *
 * The peer side of the app-driven Talk scenarios (MRS-04 enrichment, MRS-05
 * quarantine, and the Talk reminder with/without). It boots ONE sender lite
 * Dina (no brain — it only sends), points it at the cloud test infra, adds
 * the mobile DID as a contact so the egress gate lets the send through, and
 * posts a `social.update` to the mobile DID. The mobile app (running under
 * Maestro) receives it over its own MsgBox subscription, stages + drains it,
 * and a Maestro flow asserts the resulting card.
 *
 *   Run from repo root:
 *     GEMINI_API_KEY=… npx tsx apps/mobile/maestro/harness/live_d2d_send_to_mobile.ts \
 *        --to did:plc:<mobile> --text "…coming over tomorrow morning" --name Alonso
 *
 * Prints `SENDER_DID=did:plc:…` on stdout so the orchestrator can hand it to
 * the iOS contact-add flow (MRS-04) or deliberately NOT add it (MRS-05).
 *
 * Whether the mobile QUARANTINES vs ENRICHES is decided on the MOBILE side
 * (does the iOS app have this sender as a contact?), not here — the sender
 * always adds the mobile DID so its own egress gate passes.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';

import { deriveDIDKey, getPublicKey } from '@dina/core';

const ROOT = process.cwd();
const SCRATCH = `${ROOT}/.d2d-live-scratch/send-run`;
const CORE_DIR = `${ROOT}/apps/home-node-lite/core-server`;
const TX_CORE = 18322;
const rand = randomBytes(3).toString('hex');

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] !== undefined) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
}

const procs: ChildProcess[] = [];
function killAll(): void {
  for (const p of procs) {
    try {
      p.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
}
process.on('exit', killAll);
process.on('SIGINT', () => {
  killAll();
  process.exit(130);
});

function genKey(): { seed: Uint8Array; did: string } {
  const seed = new Uint8Array(randomBytes(32));
  return { seed, did: deriveDIDKey(getPublicKey(seed)) };
}
function log(tag: string, line: string): void {
  process.stdout.write(`[${tag}] ${line}\n`);
}
function pipe(tag: string, p: ChildProcess): void {
  p.stdout?.on('data', (d: Buffer) => {
    for (const l of d.toString().split('\n')) if (l.trim()) log(tag, l.slice(0, 200));
  });
  p.stderr?.on('data', (d: Buffer) => {
    for (const l of d.toString().split('\n')) if (l.trim()) log(tag, l.slice(0, 200));
  });
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
async function waitFor(label: string, fn: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await fn()) {
        log('wait', `${label} ✓`);
        return;
      }
    } catch {
      /* keep polling */
    }
    await sleep(1500);
  }
  throw new Error(`timed out waiting for ${label}`);
}
async function healthz(port: number): Promise<boolean> {
  const r = await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => null);
  return r?.ok ?? false;
}
function readDID(vaultDir: string): string | null {
  const f = `${vaultDir}/pds_identity.json`;
  if (!existsSync(f)) return null;
  try {
    return (JSON.parse(readFileSync(f, 'utf8')) as { did?: string }).did ?? null;
  } catch {
    return null;
  }
}
async function debug(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  const r = await fetch(`http://127.0.0.1:${port}/v1/debug/dispatch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, path, body, query }),
  });
  const text = await r.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* leave as text */
  }
  return { status: r.status, body: parsed };
}

async function main(): Promise<void> {
  const to = arg('to');
  const text = arg('text');
  const name = arg('name', 'Alonso');
  const handlePrefix = arg('handle', `sender${rand}`);
  // Two-phase handoff for MRS-04: write the sender DID so the orchestrator can
  // add it as a contact (+ seed memories) on the mobile side, then signal via
  // wait-file to release the send AFTER that setup is done.
  const didFile = arg('did-file', '');
  const waitFile = arg('wait-file', '');

  rmSync(SCRATCH, { recursive: true, force: true });
  const txVault = `${SCRATCH}/sender/vault`;
  mkdirSync(txVault, { recursive: true });

  log('setup', `booting sender lite-Core (→ ${to})…`);
  const p = spawn('npx', ['tsx', 'src/bin.ts'], {
    cwd: CORE_DIR,
    env: {
      ...process.env,
      DINA_CORE_PORT: String(TX_CORE),
      DINA_ENDPOINT_MODE: 'test',
      DINA_MSGBOX_ENABLED: 'true',
      DINA_PDS_PROVISION: '1',
      DINA_VAULT_DIR: txVault,
      DINA_RATE_LIMIT: '100000',
      DINA_DEBUG_MODE: '1',
      DINA_PDS_HANDLE: `${handlePrefix}.test-pds.dinakernel.com`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  pipe('sender', p);
  procs.push(p);

  await waitFor('sender healthz', () => healthz(TX_CORE), 60_000);
  await waitFor('sender DID provisioned', async () => readDID(txVault) !== null, 60_000);
  const senderDID = readDID(txVault)!;
  log('setup', `SENDER_DID=${senderDID}`);
  if (didFile !== '') writeFileSync(didFile, senderDID);
  // Let the MsgBox WS settle before sending.
  await sleep(5000);

  // Two-phase: hold until the orchestrator finishes mobile-side setup
  // (add contact + seed memory) and signals by creating the wait-file.
  if (waitFile !== '') {
    log('wait', `holding send until ${waitFile} appears…`);
    const deadline = Date.now() + 180_000;
    while (!existsSync(waitFile) && Date.now() < deadline) await sleep(1000);
    log('wait', existsSync(waitFile) ? 'go signal received ✓' : 'wait-file timeout — sending anyway');
  }

  // Add the mobile DID as a contact so the egress gate passes.
  log('seed', JSON.stringify(await debug(TX_CORE, 'POST', '/v1/contacts', { did: to, display_name: 'Mobile', trust_level: 'verified' })));

  log('send', `${name} → mobile: "${text}"`);
  const sent = await debug(TX_CORE, 'POST', '/v1/msg/send', {
    recipient_did: to,
    type: 'social.update',
    body: { text },
  });
  log('send', `msg/send → ${JSON.stringify(sent)}`);
  // Hold the WS open a moment so the relay flushes the frame.
  await sleep(4000);
  log('RESULT', `SENT SENDER_DID=${senderDID}`);
}

main()
  .then(() => {
    killAll();
    process.exit(0);
  })
  .catch((e) => {
    log('RESULT', `FAIL — ${e instanceof Error ? e.message : String(e)}`);
    killAll();
    process.exit(1);
  });
