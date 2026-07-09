/**
 * MRS-14 relay-tier setup — records the current byte-length of each dina-node
 * server log so the teardown sweep (relay_teardown.ts) scans ONLY the lines
 * this run appended. The dina-nodes are long-lived and shared across sessions,
 * so a whole-file scan would fail on unrelated history; the per-run window
 * keeps the sweep honest and scoped.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// support/ → __e2e__ → web → home-node-lite → apps → <repo>
const NODES_DIR = path.resolve(__dirname, '..', '..', '..', '..', '..', 'dina-nodes', 'nodes');
export const RELAY_NODES = ['alonso', 'sancho'] as const;
export const RELAY_LOG_FILES = ['core.log', 'brain.log'] as const;
export const OFFSET_FILE = path.join(os.tmpdir(), 'dina-relay-log-offsets.json');

export function relayLogPath(node: string, file: string): string {
  return path.join(NODES_DIR, node, 'logs', file);
}

export default async function globalSetup(): Promise<void> {
  const offsets: Record<string, number> = {};
  for (const node of RELAY_NODES) {
    for (const file of RELAY_LOG_FILES) {
      const p = relayLogPath(node, file);
      offsets[`${node}/${file}`] = fs.existsSync(p) ? fs.statSync(p).size : 0;
    }
  }
  fs.writeFileSync(OFFSET_FILE, JSON.stringify(offsets));
}
