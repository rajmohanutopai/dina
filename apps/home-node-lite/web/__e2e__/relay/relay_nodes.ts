/**
 * Relay-tier node helper — the two-human `dina-nodes/` setup (§3.2, §9.5).
 *
 * The relay tier drives two REAL Home Node Lite nodes (alonso, sancho) that run
 * out-of-process via `dina-nodes/` (provision + start + connect) against the
 * cloud test relay. Each node = a `did:plc`, a Core (debug-dispatch enabled), a
 * Brain, and a web SPA. This helper wraps: per-node backstage dispatch, a
 * reachability probe (so relay flows SKIP LOUDLY when the nodes aren't running,
 * never silently pass — §10.5), a FRESHNESS probe (so a node running STALE
 * code skips LOUD instead of failing mid-flow), and DID resolution.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface RelayNode {
  name: string;
  web: string; // SPA URL
  core: string; // Core (debug-dispatch) URL
  brain: string; // Brain URL (SPA API + healthz)
}

export const NODES: Record<'alonso' | 'sancho', RelayNode> = {
  alonso: { name: 'alonso', web: 'http://127.0.0.1:8401/web/', core: 'http://127.0.0.1:8301', brain: 'http://127.0.0.1:8401' },
  sancho: { name: 'sancho', web: 'http://127.0.0.1:8402/web/', core: 'http://127.0.0.1:8302', brain: 'http://127.0.0.1:8402' },
};

/**
 * Debug-channel headers. Attaches the fenced `x-debug-token` when the relay
 * stack requires one (`DINA_DEBUG_TOKEN` in env). Without it a token-gated Core
 * returns 403 and any backstage step would fail mid-flow — `relayReachable`
 * probes with these same headers and treats a 403 as NOT reachable, so the
 * tier skips LOUD instead. Shared by every debug-endpoint caller (dispatch, the
 * reachability probe, spec-level seeds like quarantine-seed).
 */
export function debugHeaders(): Record<string, string> {
  const token = process.env.DINA_DEBUG_TOKEN;
  return {
    'content-type': 'application/json',
    ...(token !== undefined && token !== '' ? { 'x-debug-token': token } : {}),
  };
}

/** Run any Core route as the in-process owner (debug-dispatch, §8). */
export async function dispatch(
  node: RelayNode,
  method: string,
  path: string,
  opts: { query?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${node.core}/v1/debug/dispatch`, {
    method: 'POST',
    headers: debugHeaders(),
    body: JSON.stringify({ method, path, query: opts.query ?? {}, body: opts.body }),
  });
  const body = (await res.json().catch(() => ({}))) as { status?: number; body?: unknown };
  return { status: body.status ?? res.status, body: body.body ?? body };
}

/**
 * True when BOTH nodes are fully reachable for relay flows — the gate for
 * `test.skip`. Every relay flow drives the browser (Brain/web) AND backstage
 * via Core's `/v1/debug/dispatch`, so a Brain-only healthz probe is
 * insufficient: a node whose Brain is up but whose Core is down — or whose
 * debug-dispatch is disabled (DINA_DEBUG_MODE off) — would pass the gate and
 * then FAIL mid-flow instead of skipping LOUD. So probe, per node: Brain
 * healthz, Core healthz, AND that debug-dispatch actually answers (a disabled
 * route returns 404 through the dispatch wrapper).
 */
export async function relayReachable(): Promise<boolean> {
  const nodeReachable = async (node: RelayNode): Promise<boolean> => {
    try {
      const [brainOk, coreOk] = await Promise.all([
        fetch(`${node.brain}/healthz`).then((r) => r.ok).catch(() => false),
        fetch(`${node.core}/healthz`).then((r) => r.ok).catch(() => false),
      ]);
      if (!brainOk || !coreOk) return false;
      // Debug-dispatch must be ENABLED — relay backstage runs through it. Probe
      // ROUTE-AGNOSTICALLY (different relay flows dispatch different routes on
      // different nodes, and node builds vary in which feature routes they
      // carry): POST the dispatch endpoint with a bogus wrapped path. An ENABLED
      // dispatch processes it and reports the WRAPPED path missing ("no route
      // for GET /__relay…"); a DISABLED one 404s the dispatch ENDPOINT itself,
      // whose error names `/v1/debug/dispatch`. So dispatch is up iff the error
      // is NOT about the dispatch endpoint.
      const res = await fetch(`${node.core}/v1/debug/dispatch`, {
        method: 'POST',
        headers: debugHeaders(),
        body: JSON.stringify({
          method: 'GET',
          path: '/__relay_reachable_probe__',
          query: {},
          body: null,
        }),
      });
      // Token-gated debug channel with no/invalid DINA_DEBUG_TOKEN → 403. We
      // CAN'T run backstage without it, so treat it as NOT reachable → skip
      // LOUD rather than fail mid-flow on the first dispatch.
      if (res.status === 403) return false;
      const text = await res.text().catch(() => '');
      return !text.includes('/v1/debug/dispatch');
    } catch {
      return false;
    }
  };
  const [a, s] = await Promise.all([nodeReachable(NODES.alonso), nodeReachable(NODES.sancho)]);
  return a && s;
}

// ---------------------------------------------------------------------------
// Freshness — is a REACHABLE node running the CURRENT code?
//
// `relayReachable` only proves the nodes are alive; a node started from an
// OLD checkout (the common dev-loop trap: edit code, forget to restart the
// long-lived dina-nodes) is alive but stale, so the relay flows drive it and
// fail confusingly. So additionally check that each node BOOTED AFTER the
// newest source edit. The node advertises its boot time via `/healthz`
// (`startedAt`); a node on code predating that field is treated as stale.
// ---------------------------------------------------------------------------

// relay_nodes.ts is apps/home-node-lite/web/__e2e__/relay/ → five up to root.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');

// The SERVER source a running dina-node executes via tsx (source, no build):
// the @dina/* packages + the two Lite servers. A post-boot edit here makes
// the node stale — and a `stop.sh && start.sh` restart FIXES it (tsx re-reads
// source). `apps/mobile/src` is deliberately EXCLUDED: the node serves a
// prebuilt web bundle that a restart does NOT rebuild, so keying freshness on
// it would make an auto-restart loop forever without ever converging.
const NODE_SOURCE_DIRS = [
  'packages',
  'apps/home-node-lite/core-server/src',
  'apps/home-node-lite/brain-server/src',
];
const SKIP_WALK_DIR = new Set([
  'node_modules',
  'dist',
  'dist-e2e',
  'coverage',
  'test-results',
  '__tests__',
  '.git',
]);
// Editing a test/spec must NOT mark the running node stale — only the code
// the node actually runs matters.
const SKIP_WALK_FILE = /\.(test|spec)\.[cm]?tsx?$/;
const SOURCE_FILE = /\.[cm]?tsx?$/;

let cachedNewestMtimeMs: number | null = null;
/** Newest mtime (ms) across the source the dina-nodes run. Cached per process. */
function newestSourceMtimeMs(): number {
  if (cachedNewestMtimeMs !== null) return cachedNewestMtimeMs;
  let newest = 0;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // dir absent / unreadable — ignore
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_WALK_DIR.has(entry.name)) walk(path.join(dir, entry.name));
      } else if (SOURCE_FILE.test(entry.name) && !SKIP_WALK_FILE.test(entry.name)) {
        try {
          const m = fs.statSync(path.join(dir, entry.name)).mtimeMs;
          if (m > newest) newest = m;
        } catch {
          /* transient stat failure — ignore */
        }
      }
    }
  };
  for (const rel of NODE_SOURCE_DIRS) walk(path.resolve(REPO_ROOT, rel));
  cachedNewestMtimeMs = newest;
  return newest;
}

/** Stale reason for one node, or null when it booted after the last edit. */
async function nodeStaleReason(node: RelayNode): Promise<string | null> {
  let startedAt: unknown;
  try {
    const r = await fetch(`${node.brain}/healthz`);
    if (!r.ok) return null; // liveness is relayReachable's job
    startedAt = ((await r.json()) as { startedAt?: unknown }).startedAt;
  } catch {
    return null;
  }
  if (typeof startedAt !== 'number') {
    return `${node.name} is on code that predates the /healthz build stamp`;
  }
  const newest = newestSourceMtimeMs();
  if (newest > startedAt) {
    const ageMin = Math.round((newest - startedAt) / 60_000);
    return `${node.name} booted ~${ageMin} min before the latest source edit`;
  }
  return null;
}

/**
 * The single gate the relay specs skip on. Returns null when the fleet is
 * ready, or a human, ACTIONABLE reason to `test.skip` with — distinguishing
 * "not running" from "STALE" so a dev knows to RESTART (not just start) the
 * nodes. Never lets a stale/absent fleet fail a spec mid-flow.
 */
export async function relaySkipReason(): Promise<string | null> {
  if (!(await relayReachable())) {
    return (
      'relay: dina-nodes (alonso/sancho) not running — ' +
      'cd dina-nodes && ./start.sh alonso sancho && ./connect.sh alonso sancho'
    );
  }
  for (const node of [NODES.alonso, NODES.sancho]) {
    const stale = await nodeStaleReason(node);
    if (stale !== null) {
      return (
        `relay: dina-nodes are STALE (${stale}) — restart them with the latest code: ` +
        'cd dina-nodes && ./stop.sh && ./start.sh alonso sancho && ./connect.sh alonso sancho'
      );
    }
  }
  return null;
}

/**
 * Resolve `node`'s own `did:plc` by reading `peer`'s contact directory (which
 * lists `node` by the mutual `connect.sh` link). Uses the F4 brain contacts
 * proxy — so it also exercises that fix. `connect.sh` is a relay prerequisite.
 */
export async function nodeDid(node: RelayNode, peer: RelayNode): Promise<string> {
  const r = await fetch(`${peer.brain}/api/v1/contacts`);
  if (!r.ok) throw new Error(`relay: cannot read ${peer.name} contacts (${r.status})`);
  const body = (await r.json()) as { contacts?: { displayName: string; did: string }[] };
  const match = (body.contacts ?? []).find(
    (c) => c.displayName.toLowerCase() === node.name.toLowerCase(),
  );
  if (match === undefined) {
    throw new Error(`relay: ${peer.name} has no contact for ${node.name} (run connect.sh)`);
  }
  return match.did;
}
