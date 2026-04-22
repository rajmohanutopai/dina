/**
 * Task 4.12 (version half) — resolve the server's version string at runtime.
 *
 * Priority order:
 *   1. `DINA_CORE_VERSION` env override (CI injects this during release
 *      pipelines so the emitted version matches the release tag, not
 *      whatever happened to be in `package.json` at build time).
 *   2. `package.json`'s `version` field — the build-time canonical
 *      source. Resolved by walking up from `__dirname` until we find
 *      the nearest `package.json` (works under `tsx src/...` dev runs
 *      AND under `node dist/...` built runs).
 *   3. Fallback `"0.0.0-unknown"` — never crashes the server just
 *      because the build layout surprised us.
 *
 * **Why runtime, not compile-time.** Embedding the version at
 * compile time would require a build step we don't have today
 * (apps/home-node-lite/core-server runs via tsx, not tsc + node).
 * Runtime resolution is a single readFileSync on boot, cached.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

let cached: string | undefined;

export function getServerVersion(): string {
  if (cached !== undefined) return cached;
  cached = resolveVersion();
  return cached;
}

function resolveVersion(): string {
  const envOverride = process.env['DINA_CORE_VERSION'];
  if (envOverride && envOverride.length > 0) return envOverride;

  const pkgPath = findPackageJson(__dirname);
  if (!pkgPath) return '0.0.0-unknown';
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
      version?: unknown;
    };
    if (typeof pkg.version === 'string' && pkg.version.length > 0) return pkg.version;
  } catch {
    // fall through
  }
  return '0.0.0-unknown';
}

function findPackageJson(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, 'package.json');
    try {
      readFileSync(candidate, 'utf-8');
      return candidate;
    } catch {
      // not here — walk up
    }
    const parent = dirname(dir);
    if (parent === dir) return null; // hit filesystem root
    dir = parent;
  }
  return null;
}

/** Reset the cache — tests call this between runs. */
export function resetVersionCache(): void {
  cached = undefined;
}
