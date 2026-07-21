/**
 * Round-A A-07 — the lite server's OWNER capability (the §12.5 owner-only
 * control boundary for interactive runs + watches).
 *
 * On mobile the owner is the in-app user (in-process dispatch). On the split
 * server the owner is the HUMAN at the browser, so the credential must live
 * with the operator, never with Brain: Core mints/loads it here, the operator
 * pastes it into the SPA once, the browser presents it on every owner call
 * (`x-dina-owner-capability`), and brain-server merely forwards the header as
 * an opaque byte-pipe. Core alone validates it (timing-safe, run/watch surface
 * only) — a compromised Brain can never originate owner commands.
 *
 * Resolution order:
 *   1. `DINA_OWNER_CAPABILITY` env (operator-managed; ≥16 chars enforced).
 *   2. `<vaultDir>/owner_capability` — generated once (32 random bytes, hex)
 *      and persisted 0600 so restarts keep it and the operator can read it.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

const MIN_CAPABILITY_LENGTH = 16;

export interface ResolvedOwnerCapability {
  capability: string;
  /** Where it came from — logged (never the value). */
  source: 'env' | 'file' | 'generated';
  /** The backing file when file-based (for the operator log line). */
  filePath?: string;
}

export function resolveOwnerCapability(
  env: NodeJS.ProcessEnv,
  vaultDir: string,
): ResolvedOwnerCapability {
  const fromEnv = env.DINA_OWNER_CAPABILITY?.trim() ?? '';
  if (fromEnv !== '') {
    if (fromEnv.length < MIN_CAPABILITY_LENGTH) {
      throw new Error(
        `DINA_OWNER_CAPABILITY must be at least ${MIN_CAPABILITY_LENGTH} characters`,
      );
    }
    return { capability: fromEnv, source: 'env' };
  }

  const filePath = path.join(vaultDir, 'owner_capability');
  if (existsSync(filePath)) {
    const stored = readFileSync(filePath, 'utf8').trim();
    if (stored.length >= MIN_CAPABILITY_LENGTH) {
      return { capability: stored, source: 'file', filePath };
    }
    // Corrupt/truncated file: regenerate below (never boot with a weak secret).
  }
  const generated = randomBytes(32).toString('hex');
  writeFileSync(filePath, `${generated}\n`, { mode: 0o600 });
  return { capability: generated, source: 'generated', filePath };
}
