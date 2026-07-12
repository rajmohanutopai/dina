/**
 * Relay-tier setup. Two jobs:
 *
 *   1. AUTO-RESTART the dedicated dina-nodes when they're down or running
 *      STALE code, so the relay flows run against fresh servers instead of
 *      skipping. The dina-nodes exist ONLY for this tier and hold no state
 *      worth preserving, so a `stop.sh && start.sh && connect.sh` is safe and
 *      is the whole point of the launcher.
 *
 *   2. MRS-14 log window — record each node log's current byte-length (AFTER
 *      any restart) so the teardown sweep scans only this run's appended lines.
 *
 * No-op restart when the `dina-nodes/` launcher is absent (CI, a fresh clone):
 * the specs' own `relaySkipReason` gate then skips the relay flows.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { relaySkipReason } from '../relay/relay_nodes';

// support/ → __e2e__ → web → home-node-lite → apps → <repo>
const DINA_NODES_DIR = path.resolve(__dirname, '..', '..', '..', '..', '..', 'dina-nodes');
const NODES_DIR = path.join(DINA_NODES_DIR, 'nodes');
export const RELAY_NODES = ['alonso', 'sancho'] as const;
export const RELAY_LOG_FILES = ['core.log', 'brain.log'] as const;
export const OFFSET_FILE = path.join(os.tmpdir(), 'dina-relay-log-offsets.json');

export function relayLogPath(node: string, file: string): string {
  return path.join(NODES_DIR, node, 'logs', file);
}

/**
 * Restart the dedicated relay dina-nodes with the CURRENT code when they're
 * down or stale. No-op when the launcher is absent or the fleet is already
 * reachable + fresh. Every step is best-effort — a launcher failure degrades
 * to "skip" (via the freshness poll below), never a hard abort of the run.
 */
async function ensureFreshRelayNodes(): Promise<void> {
  if (!fs.existsSync(path.join(DINA_NODES_DIR, 'start.sh'))) return; // no launcher
  if ((await relaySkipReason()) === null) return; // already reachable + fresh

  const names = [...RELAY_NODES];
  // BOUND every step. start.sh blocks on each node's healthz + did:plc waits
  // (~90s each), and if the nodes can't reach the cloud test-pds/MsgBox it
  // would otherwise hang globalSetup for many minutes. On timeout execFileSync
  // kills the child and throws; we swallow it and let the freshness poll below
  // be the arbiter (→ specs skip), so a broken/unreachable fleet degrades to a
  // bounded skip instead of a multi-minute hang.
  const run = (script: string, args: string[], timeoutMs: number): void => {
    try {
      execFileSync(path.join(DINA_NODES_DIR, script), args, {
        cwd: DINA_NODES_DIR,
        stdio: 'inherit',
        timeout: timeoutMs,
      });
    } catch {
      // Best-effort: stop.sh fails when nodes are already down; start.sh can
      // fail/timeout on a setup problem (no cloud PDS, missing web bundle, no
      // tsx). The freshness poll below is the real readiness gate.
    }
  };

  console.log('[relay] dina-nodes down or stale — restarting with the current code…');
  run('stop.sh', names, 30_000); // frees the port listeners (tsx launcher/worker orphan)
  run('start.sh', names, 180_000); // boots fresh from source via tsx (bounded)
  run('connect.sh', names, 30_000); // re-link mutual contacts (idempotent)

  // start.sh blocks until healthz, but confirm freshness with a bounded poll.
  const deadline = Date.now() + 60_000;
  for (;;) {
    const reason = await relaySkipReason();
    if (reason === null) {
      console.log('[relay] dina-nodes restarted and fresh.');
      return;
    }
    if (Date.now() > deadline) {
      console.warn(`[relay] dina-nodes still not ready after restart (${reason}); specs will skip.`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

export default async function globalSetup(): Promise<void> {
  // Refresh the nodes FIRST so the log window below captures only this run.
  await ensureFreshRelayNodes();

  const offsets: Record<string, number> = {};
  for (const node of RELAY_NODES) {
    for (const file of RELAY_LOG_FILES) {
      const p = relayLogPath(node, file);
      offsets[`${node}/${file}`] = fs.existsSync(p) ? fs.statSync(p).size : 0;
    }
  }
  fs.writeFileSync(OFFSET_FILE, JSON.stringify(offsets));
}
