#!/usr/bin/env tsx
/**
 * Standalone conformance runner — the external-facing face of task 10.15.
 *
 * The Jest test (`__tests__/conformance_suite.test.ts`) is the CI gate
 * that fails the build if a vector regresses. This CLI exists so an
 * external implementer porting Dina to another runtime can produce
 * the same report without knowing anything about our Jest config.
 *
 * Usage:
 *   npm run conformance            # pretty report, exits non-zero on any fail/skip
 *   npm run conformance -- --json  # machine-readable JSON
 *   npm run conformance -- --allow-skip  # treat skips as OK (debugging)
 *
 * Exit codes:
 *   0 — every frozen vector passed
 *   1 — at least one failure (or skip, unless --allow-skip)
 *   2 — runtime error (missing vectors dir, bad JSON, etc.)
 */

import path from 'node:path';
import process from 'node:process';

import sodium from 'libsodium-wrappers';

import { formatReport, runConformance } from './suite';

const VECTORS_DIR = path.resolve(__dirname, 'vectors');

async function main(): Promise<number> {
  const args = new Set(process.argv.slice(2));
  const asJSON = args.has('--json');
  const allowSkip = args.has('--allow-skip');

  // libsodium's WASM needs ready before the nacl_sealed_box verifier runs.
  await sodium.ready;

  const report = runConformance(VECTORS_DIR);

  if (asJSON) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatReport(report)}\n`);
  }

  const hard = report.summary.failed;
  const soft = allowSkip ? 0 : report.summary.skipped + report.summary.notImplemented;
  return hard + soft > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    process.stderr.write(`conformance runner failed: ${msg}\n`);
    process.exit(2);
  },
);
