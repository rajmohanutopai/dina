/**
 * The scenario fleet (docs/REAL_LIFE_SCENARIOS.md): four local server Home
 * Nodes — Alonso, Sancho, Albert, ChairMaker — each a core-server and a
 * brain-server on the test fleet (test PDS, test MsgBox, test AppView), all on
 * one model through OpenRouter.
 *
 *   npx tsx scripts/scenarios/fleet.ts up        start all four (fresh state)
 *   npx tsx scripts/scenarios/fleet.ts down      stop them
 *   npx tsx scripts/scenarios/fleet.ts status    who is up, with their DIDs
 *
 * Needs OPENROUTER_API_KEY (from the repo's .env). State, logs and keys live
 * in scripts/scenarios/.fleet/ (git-ignored). Nothing here relaxes a node's
 * security: Brain keeps caller auth on, and the runner signs in as a paired
 * owner device.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import * as ed25519 from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { base58 } from '@scure/base';

const edHashes = ed25519.hashes as { sha512?: (...msgs: Uint8Array[]) => Uint8Array };
edHashes.sha512 = (...msgs: Uint8Array[]) => {
  const h = sha512.create();
  for (const m of msgs) h.update(m);
  return h.digest();
};

export const REPO_ROOT = path.resolve(__dirname, '..', '..');
export const FLEET_DIR = path.join(REPO_ROOT, 'scripts', 'scenarios', '.fleet');
const STATE_FILE = path.join(FLEET_DIR, 'state.json');

export const NODE_NAMES = ['alonso', 'sancho', 'albert', 'chairmaker'] as const;
export type NodeName = (typeof NODE_NAMES)[number];

/** The model every node runs (override with SCENARIO_MODEL). */
export const SCENARIO_MODEL = process.env.SCENARIO_MODEL ?? 'deepseek/deepseek-v4.1-flash';

export interface FleetNode {
  name: NodeName;
  core: string;
  brain: string;
  dir: string;
  vaultDir: string;
  ownerCapability: string;
  corePid?: number;
  brainPid?: number;
  did?: string;
  /** Launch env, without the model key (added from .env at each start). */
  coreEnv?: Record<string, string>;
  brainEnv?: Record<string, string>;
}

export interface FleetState {
  startedAt: number;
  model: string;
  runTag: string;
  nodes: Record<NodeName, FleetNode>;
}

function brainDidOf(seed: Uint8Array): string {
  const pub = ed25519.getPublicKey(seed);
  const payload = new Uint8Array(2 + pub.length);
  payload[0] = 0xed;
  payload[1] = 0x01;
  payload.set(pub, 2);
  return `did:key:z${base58.encode(payload)}`;
}

/** KEY=value lines from the repo's .env, without echoing anything. */
export function loadDotEnv(): void {
  const file = path.join(REPO_ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m === null) continue;
    const key = m[1] as string;
    let value = (m[2] as string).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function readState(): FleetState | null {
  if (!fs.existsSync(STATE_FILE)) return null;
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as FleetState;
}

function writeState(state: FleetState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitHealthy(url: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(`${url}/healthz`)).ok) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

function didOf(vaultDir: string): string | undefined {
  const file = path.join(vaultDir, 'pds_identity.json');
  if (!fs.existsSync(file)) return undefined;
  const did = (JSON.parse(fs.readFileSync(file, 'utf8')) as { did?: unknown }).did;
  return typeof did === 'string' ? did : undefined;
}

/** Alonso's Core boots through a wrapper that lets A2A reach the local test agent (area L). */
const CORE_ENTRY: Partial<Record<NodeName, string>> = {
  alonso: path.join(REPO_ROOT, 'scripts', 'scenarios', 'core_with_test_agent.ts'),
};

function launch(cwdRel: string, env: Record<string, string>, logFile: string, entry = 'src/bin.ts'): number {
  const out = fs.openSync(logFile, 'a');
  const child = spawn(path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx'), [entry], {
    cwd: path.join(REPO_ROOT, cwdRel),
    env: { ...process.env, ...env },
    stdio: ['ignore', out, out],
    detached: true,
  });
  child.unref();
  if (child.pid === undefined) throw new Error(`could not start ${cwdRel}`);
  return child.pid;
}

async function up(): Promise<void> {
  loadDotEnv();
  const key = process.env.OPENROUTER_API_KEY ?? '';
  if (key === '') throw new Error('OPENROUTER_API_KEY is not set (.env)');
  const existing = readState();
  if (existing !== null && NODE_NAMES.some((n) => alive(existing.nodes[n].corePid))) {
    throw new Error('the fleet is already up; run `down` first');
  }
  fs.rmSync(FLEET_DIR, { recursive: true, force: true });
  fs.mkdirSync(FLEET_DIR, { recursive: true });
  const runTag = randomBytes(3).toString('hex');
  const nodes = {} as Record<NodeName, FleetNode>;
  // Brain starts only once its Core answers, as the CLI supervisor does: Brain
  // reads Core's persona list once at boot (a known gap: no retry — see
  // docs/REAL_LIFE_SCENARIOS.md findings).
  const brainEnv = {} as Record<NodeName, Record<string, string>>;

  NODE_NAMES.forEach((name, i) => {
    const corePort = 18311 + i;
    const brainPort = 18411 + i;
    const dir = path.join(FLEET_DIR, name);
    const vaultDir = path.join(dir, 'vault');
    const keyDir = path.join(dir, 'service-keys');
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.mkdirSync(keyDir, { recursive: true });
    const seed = randomBytes(32);
    fs.writeFileSync(path.join(keyDir, 'brain.ed25519'), seed, { mode: 0o600 });
    const brainDid = brainDidOf(new Uint8Array(seed));
    const ownerCapability = randomBytes(24).toString('hex');
    const core = `http://127.0.0.1:${corePort}`;
    const brain = `http://127.0.0.1:${brainPort}`;
    const coreEnvFor = (_n: NodeName): Record<string, string> => ({
        DINA_CORE_HOST: '127.0.0.1',
        DINA_CORE_PORT: String(corePort),
        DINA_VAULT_DIR: vaultDir,
        DINA_LOG_LEVEL: 'info',
        DINA_RATE_LIMIT: '100000',
        DINA_BRAIN_DID: brainDid,
        DINA_BRAIN_URL: brain,
        DINA_DEBUG_MODE: '1',
        DINA_ENDPOINT_MODE: 'test',
        DINA_MSGBOX_ENABLED: 'true',
        DINA_PDS_PROVISION: '1',
        DINA_PDS_HANDLE: `sc${runTag}${name.slice(0, 6)}.test-pds.dinakernel.com`,
        DINA_OWNER_CAPABILITY: ownerCapability,
      });
    const corePid = launch('apps/home-node-lite/core-server', coreEnvFor(name), path.join(dir, 'core.log'), CORE_ENTRY[name]);
    nodes[name] = { name, core, brain, dir, vaultDir, ownerCapability, corePid, coreEnv: coreEnvFor(name) };
    brainEnv[name] = {
        DINA_BRAIN_HOST: '127.0.0.1',
        DINA_BRAIN_PORT: String(brainPort),
        DINA_BRAIN_LOG_LEVEL: 'info',
        DINA_CORE_URL: core,
        DINA_SERVICE_KEY_DIR: keyDir,
        DINA_BRAIN_SERVICE_KEY_FILE: 'brain.ed25519',
        DINA_BRAIN_LLM_PROVIDER: 'openrouter',
        DINA_OPENROUTER_MODEL: SCENARIO_MODEL,
      };
  });
  const state: FleetState = { startedAt: Date.now(), model: SCENARIO_MODEL, runTag, nodes };
  writeState(state);

  for (const name of NODE_NAMES) {
    const n = state.nodes[name];
    const coreUp = await waitHealthy(n.core, 120_000);
    n.brainEnv = brainEnv[name];
    n.brainPid = launch('apps/home-node-lite/brain-server', withKey(n.brainEnv), path.join(n.dir, 'brain.log'));
    writeState(state);
    const brainUp = await waitHealthy(n.brain, 60_000);
    // The did:plc is minted on the test PDS during Core's boot.
    const end = Date.now() + 90_000;
    while (n.did === undefined && Date.now() < end) {
      n.did = didOf(n.vaultDir);
      if (n.did === undefined) await new Promise((r) => setTimeout(r, 1000));
    }
    console.log(`${name}: core ${coreUp ? 'up' : 'DOWN'}, brain ${brainUp ? 'up' : 'DOWN'}, ${n.did ?? 'no did:plc'}`);
  }
  writeState(state);
}

function withKey(env: Record<string, string>): Record<string, string> {
  return { ...env, DINA_OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? '' };
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* gone */
    }
  }
}

/** Stop one node (both processes); its vault and identity stay. */
export function stopNode(name: NodeName): void {
  const state = readState();
  if (state === null) throw new Error('no fleet');
  killGroup(state.nodes[name].brainPid);
  killGroup(state.nodes[name].corePid);
}

/**
 * Start one stopped node again with the same vault, identity and env, plus
 * any overrides for this start only (the error scenarios restart a node with
 * no model, or an unreachable AppView). An override set to '' removes the var.
 */
export async function startNode(
  name: NodeName,
  overrides: { core?: Record<string, string>; brain?: Record<string, string> } = {},
): Promise<void> {
  loadDotEnv();
  const state = readState();
  if (state === null) throw new Error('no fleet');
  const n = state.nodes[name];
  if (n.coreEnv === undefined || n.brainEnv === undefined) throw new Error(`${name}: no launch env recorded`);
  const merge = (base: Record<string, string>, extra: Record<string, string> = {}): Record<string, string> => {
    const out = { ...base, ...extra };
    for (const [k, v] of Object.entries(extra)) if (v === '') delete out[k];
    return out;
  };
  n.corePid = launch('apps/home-node-lite/core-server', merge(n.coreEnv, overrides.core), path.join(n.dir, 'core.log'), CORE_ENTRY[name]);
  if (!(await waitHealthy(n.core, 120_000))) throw new Error(`${name}: core did not come back`);
  n.brainPid = launch('apps/home-node-lite/brain-server', merge(withKey(n.brainEnv), overrides.brain), path.join(n.dir, 'brain.log'));
  if (!(await waitHealthy(n.brain, 60_000))) throw new Error(`${name}: brain did not come back`);
  writeState(state);
}

function down(): void {
  const state = readState();
  if (state === null) return;
  for (const name of NODE_NAMES) {
    for (const pid of [state.nodes[name].corePid, state.nodes[name].brainPid]) {
      if (pid === undefined) continue;
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          /* gone */
        }
      }
    }
  }
  console.log('fleet stopped');
}

async function status(): Promise<void> {
  const state = readState();
  if (state === null) {
    console.log('no fleet');
    return;
  }
  for (const name of NODE_NAMES) {
    const n = state.nodes[name];
    const c = await fetch(`${n.core}/healthz`).then((r) => r.ok).catch(() => false);
    const b = await fetch(`${n.brain}/healthz`).then((r) => r.ok).catch(() => false);
    console.log(`${name}: core ${c ? 'up' : 'down'} ${n.core}, brain ${b ? 'up' : 'down'} ${n.brain}, ${n.did ?? '-'}`);
  }
}

if (require.main === module) {
  const cmd = process.argv[2];
  const run = cmd === 'up' ? up() : cmd === 'down' ? Promise.resolve(down()) : status();
  run.catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
