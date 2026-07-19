/**
 * MRS-14 global teardown — the server-log half of the log-hygiene sweep.
 *
 * After the run, scan both servers' captured stdout for leaked vault
 * content / secrets / recovery phrases. The browser-console + egress half
 * runs per-test in the human_session fixture. Throwing here fails the run.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  isCoreBootSeedLine,
  scanForLeaks,
  type HygieneViolation,
} from './log_hygiene';

export default async function globalTeardown(): Promise<void> {
  const stackDir = process.env.DINA_E2E_STACK_DIR;
  // A silent no-op here is a VACUOUS pass — the sweep must actually run.
  if (stackDir === undefined) {
    throw new Error(
      'MRS-14: DINA_E2E_STACK_DIR is unset — the server-log hygiene sweep did not run. ' +
        'buildStack (support/stack.ts) must set it.',
    );
  }

  const targets: { file: string; allowMnemonicLine?: (line: string) => boolean }[] = [
    // Core logs its own first-boot master-seed mnemonic (dev warning in a
    // throwaway test stack) — allowlist that one line for the MNEMONIC check
    // only; vault-token / secret checks on it still apply.
    { file: 'core.log', allowMnemonicLine: isCoreBootSeedLine },
    { file: 'brain.log' },
  ];

  const violations: HygieneViolation[] = [];
  for (const { file, allowMnemonicLine } of targets) {
    const p = path.join(stackDir, file);
    if (!fs.existsSync(p)) {
      throw new Error(
        `MRS-14: expected server log ${p} is missing — the sweep would be vacuous. ` +
          'Was the server reused (reuseExistingServer) instead of freshly booted with tee?',
      );
    }
    const text = fs.readFileSync(p, 'utf8');
    if (text.trim() === '') {
      throw new Error(`MRS-14: server log ${file} is empty — nothing was captured to sweep.`);
    }
    violations.push(...scanForLeaks(text, file, { allowMnemonicLine }));
  }

  if (violations.length > 0) {
    const report = violations
      .map((v) => `  [${v.source}] ${v.kind} :: ${v.excerpt}`)
      .join('\n');
    throw new Error(
      `MRS-14 log-hygiene FAILED — vault content / secrets leaked into server logs:\n${report}`,
    );
  }
   
  console.log('[MRS-14] server-log hygiene clean.');
}
