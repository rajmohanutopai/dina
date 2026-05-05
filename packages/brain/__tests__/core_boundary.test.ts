/**
 * Brain → Core boundary gate (CA-29).
 *
 * The narrower `core_port_usage_audit` test only flagged direct imports
 * of `core/src/**\/repository`. CA-29 widens the rule: production Brain
 * source under `packages/brain/src/**` may not deep-import ANY
 * `@dina/core/src/**` or `../../../core/src/**` path. The only legal
 * Core consumption surface is the public `@dina/core` package — root
 * barrel and explicit subpaths (`@dina/core/reminders`,
 * `@dina/core/audit`, `@dina/core/d2d`, etc.).
 *
 * Why widen now:
 *   - The architecture-cleanup work added `exports` maps and made
 *     production mobile clean. Brain is the largest remaining
 *     deep-import offender.
 *   - Mobile bundles Brain into the same JS VM as Core, so deep
 *     imports compile fine — but server (HTTP transport) consumers
 *     can't see private paths. Without this gate, Brain code keeps
 *     drifting back to relative-path imports that work locally and
 *     break in server form factor.
 *
 * Mirrors the pattern in `dep_hygiene.test.ts` and the Core-side
 * `architecture/dep_hygiene.test.ts` added in CA-31.
 *
 * Source: docs/ARCHITECTURE_CLEANUP_CODE_ARCHITECTURE.md CA-29.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const BRAIN_SRC = resolve(__dirname, '..', 'src');

/**
 * Forbidden specifier shapes — both the workspace-style
 * `@dina/core/src/...` and the relative `../../../core/src/...` paths
 * point at the same private files. The boundary cleanup left them all
 * unreachable through the public exports map at runtime, but the
 * compile-time edge still works in the monorepo. This regex catches
 * both flavours.
 */
const DEEP_CORE_IMPORT_RE =
  /from\s+['"](?:@dina\/core\/src|(?:\.\.\/)+core\/src)\/[^'"]+['"]/g;

/**
 * The same shape inside `import(...)` and `require(...)` calls.
 */
const DEEP_CORE_DYNAMIC_RE =
  /(?:import|require)\(\s*['"](?:@dina\/core\/src|(?:\.\.\/)+core\/src)\/[^'"]+['"]\s*\)/g;

/**
 * Allowlisted files. Empty by design after CA-29: every Brain
 * production import of Core now goes through the public package
 * surface. New entries require an architectural-review rationale —
 * the point of this gate is that backsliding is a conscious choice,
 * not silent convenience.
 */
const ALLOWED: readonly { file: string; rationale: string }[] = [];

function* walkTs(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      yield* walkTs(full);
    } else if (full.endsWith('.ts') && !full.endsWith('.d.ts')) {
      yield full;
    }
  }
}

describe('Brain → Core public-surface boundary (CA-29)', () => {
  const files = [...walkTs(BRAIN_SRC)];

  it('discovers Brain source files (sanity — empty walk would silently pass)', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('production Brain source imports Core only through the public package surface', () => {
    const offenders: { file: string; match: string }[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const rel = relative(BRAIN_SRC, f);
      const allowed = ALLOWED.some((a) => a.file === rel);
      if (allowed) continue;
      for (const m of [
        ...src.matchAll(DEEP_CORE_IMPORT_RE),
        ...src.matchAll(DEEP_CORE_DYNAMIC_RE),
      ]) {
        offenders.push({ file: rel, match: m[0] });
      }
    }
    // Fail loud — every offender visible at once.
    expect(offenders).toEqual([]);
  });

  it('every allowlist entry has a substantive rationale', () => {
    for (const { rationale } of ALLOWED) {
      expect(rationale.length).toBeGreaterThanOrEqual(50);
    }
  });

  describe('self-check — the gate actually detects real offenders', () => {
    const shouldFlag = [
      `import { X } from '@dina/core/src/vault/crud';`,
      `import { Y } from '../../../core/src/persona/service';`,
      `import { Z } from '../../core/src/contacts/directory';`,
      `import type { T } from '@dina/core/src/workflow/domain';`,
      `const m = await import('@dina/core/src/staging/service');`,
      `const m = require('../../../core/src/auth/canonical');`,
    ];
    const shouldNotFlag = [
      `import { CoreClient } from '@dina/core';`,
      `import { createReminder } from '@dina/core/reminders';`,
      `import type { D2DEnvelope } from '@dina/protocol';`,
      `import { foo } from './local_helper';`,
      `import { ApprovalManager } from '@dina/core';`,
    ];

    it.each(shouldFlag.map((s) => [s]))('flags `%s`', (snippet) => {
      const total =
        [...snippet.matchAll(DEEP_CORE_IMPORT_RE)].length +
        [...snippet.matchAll(DEEP_CORE_DYNAMIC_RE)].length;
      expect(total).toBeGreaterThan(0);
    });

    it.each(shouldNotFlag.map((s) => [s]))('does NOT flag `%s`', (snippet) => {
      const total =
        [...snippet.matchAll(DEEP_CORE_IMPORT_RE)].length +
        [...snippet.matchAll(DEEP_CORE_DYNAMIC_RE)].length;
      expect(total).toBe(0);
    });
  });
});
