/**
 * MRS-14 relay-tier teardown — the server-log half of the log-hygiene sweep for
 * the two-human relay flows (§7 MRS-14, §4.3, and MRS-04's "no D2D plaintext in
 * either server's logs"). Scans ONLY the log lines this run appended (window
 * recorded by relay_setup.ts) across both dina-nodes' Core + Brain stdout, and
 * FAILS the run on any leaked vault token / secret / recovery phrase / D2D
 * plaintext. The browser-console + egress half is asserted per-test in the
 * relay specs (relay_hygiene.ts).
 */

import fs from 'node:fs';

import { isCoreBootSeedLine, scanForLeaks, type HygieneViolation } from './log_hygiene';
import { OFFSET_FILE, relayLogPath } from './relay_setup';

export default async function globalTeardown(): Promise<void> {
  if (!fs.existsSync(OFFSET_FILE)) {
    // eslint-disable-next-line no-console
    console.log('[MRS-14 relay] no offset file — relay setup did not run; nothing to sweep.');
    return;
  }
  const offsets = JSON.parse(fs.readFileSync(OFFSET_FILE, 'utf8')) as Record<string, number>;

  const violations: HygieneViolation[] = [];
  let scanned = 0;
  for (const [key, startOffset] of Object.entries(offsets)) {
    const [node, file] = key.split('/');
    const p = relayLogPath(node, file);
    if (!fs.existsSync(p)) continue; // node not run this session
    const buf = fs.readFileSync(p);
    // Only THIS run's appended bytes — the dina-nodes are long-lived + shared.
    const appended = buf.subarray(startOffset).toString('utf8');
    if (appended.trim() === '') continue;
    const allowMnemonicLine = file === 'core.log' ? isCoreBootSeedLine : undefined;
    violations.push(...scanForLeaks(appended, key, { allowMnemonicLine }));
    scanned += 1;
  }
  fs.rmSync(OFFSET_FILE, { force: true });

  if (scanned === 0) {
    // eslint-disable-next-line no-console
    console.log('[MRS-14 relay] relay flows did not run (no appended node logs).');
    return;
  }
  if (violations.length > 0) {
    const report = violations.map((v) => `  [${v.source}] ${v.kind} :: ${v.excerpt}`).join('\n');
    throw new Error(
      `MRS-14 relay log-hygiene FAILED — vault content / secrets / D2D plaintext leaked into ` +
        `dina-nodes logs this run:\n${report}`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(`[MRS-14 relay] server-log hygiene clean (${scanned} node logs, this-run window).`);
}
