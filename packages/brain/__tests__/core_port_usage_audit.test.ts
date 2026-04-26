/**
 * Brain layer-hygiene gate — core-repository direct-import audit (task 2.5).
 *
 * Architectural invariant: **Brain reaches Core only via `CoreClient`.**
 * Direct imports of Core's domain repositories (`KVRepository`,
 * `VaultRepository`, etc.) couple Brain to Core's internal schema
 * and defeat the point of the hexagonal boundary. Every Brain↔Core
 * interaction should go through the `CoreClient` interface (task 1.28)
 * so the mobile (in-process) and server (HTTP) builds swap transports
 * without Brain even noticing.
 *
 * Where we stand today (the task 2.5 audit finding): Brain has
 * **one** direct-to-core-repository import — `getChatMessageRepository`
 * in `packages/brain/src/chat/thread.ts`. This exists because the
 * in-memory chat `threads: Map<threadId, ChatMessage[]>` is the
 * session cache and the repository is the restart-durability backing
 * store; the read-through (hydrate) + write-through (fire-and-forget
 * persist) pattern is genuinely Brain-owned concurrency, not a
 * Core call. The call site uses the async interface correctly:
 * `await repo.listByThread(…)`, `void repo.append(…).catch(…)`.
 *
 * This test pins that finding: Brain may import core repositories
 * from the allowlisted file only. A new offender — a Brain subsystem
 * reaching into Core's repo layer — fails the gate and has to either
 * (a) migrate to a CoreClient method, or (b) justify a new allowlist
 * entry with accompanying architectural review.
 *
 * Pattern matches the dep_hygiene gate (task 1.33) and the port-async
 * gate (task 2.8) — jest-as-lint, no extra tooling, runs on every
 * `npm test`.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 2 task 2.5.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const BRAIN_SRC = resolve(__dirname, '..', 'src');

/**
 * Allowlisted files that may import from `packages/core/src/**\/repository`.
 * Each entry is a path relative to `packages/brain/src/`. Add entries
 * only after architectural review — the point of this gate is that
 * adding an entry is a conscious act, not a silent convenience.
 */
const ALLOWED_REPO_IMPORTERS: readonly { file: string; rationale: string }[] = [
  {
    file: 'chat/thread.ts',
    rationale:
      'Chat thread cache — in-memory threads Map is authoritative for reads; ChatMessageRepository provides restart durability. Write-through is fire-and-forget per task 2.3 fire-and-forget pattern.',
  },
  {
    file: 'notifications/inbox.ts',
    rationale:
      'Notifications inbox (task 5.66) — in-memory items array is authoritative for reads; NotificationLogRepository is an optional persistence backing. Same dual-write pattern as chat/thread.ts: hydrate on boot, fire-and-forget persist, swallow errors so a failing repo never breaks subscriber fan-out.',
  },
];

/**
 * Regex that matches imports reaching into Core's repository layer.
 *   `from '../../../core/src/chat/repository'`      ← old-style relative
 *   `from '@dina/core/src/vault/repository'`        ← workspace-style
 *   `from '../../core/src/memory/repository.js'`    ← .js extension
 *
 * The core-src path fragment is the shape that all such imports share.
 * We deliberately don't match the bare `@dina/core` entry-point — Brain
 * SHOULD import CoreClient / types from there. Only deep imports
 * targeting `core/src/.../repository(.ts|.js)?` are flagged.
 */
const REPO_IMPORT_RE =
  /from\s+['"][^'"]*\bcore\/src\/[a-z_]+\/repository(?:\.(?:ts|js))?['"]/g;

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

describe('Brain core-port usage audit (task 2.5)', () => {
  const files = [...walkTs(BRAIN_SRC)];

  it('discovers source files', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('every brain file importing a core repository is on the allowlist', () => {
    const offenders: { file: string; match: string }[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const matches = [...src.matchAll(REPO_IMPORT_RE)];
      if (matches.length === 0) continue;
      const rel = relative(BRAIN_SRC, f);
      const allowed = ALLOWED_REPO_IMPORTERS.some((a) => a.file === rel);
      if (!allowed) {
        for (const m of matches) {
          offenders.push({ file: rel, match: m[0] });
        }
      }
    }
    // Fail loud — list every offender so reviewers see the full scope.
    expect(offenders).toEqual([]);
  });

  it('every allowlist entry points to a real file that actually imports a core repository', () => {
    // Prevents stale allowlist: if a file on the list is deleted or
    // stops touching core repositories (e.g. gets rewritten to go
    // through CoreClient), the entry should come off the list.
    const stale: { file: string; issue: string }[] = [];
    for (const { file } of ALLOWED_REPO_IMPORTERS) {
      const full = join(BRAIN_SRC, file);
      let src: string;
      try {
        src = readFileSync(full, 'utf8');
      } catch {
        stale.push({ file, issue: 'file missing' });
        continue;
      }
      if (![...src.matchAll(REPO_IMPORT_RE)].length) {
        stale.push({ file, issue: 'no core-repository import' });
      }
    }
    expect(stale).toEqual([]);
  });

  it('every allowlist entry has a substantive rationale', () => {
    // The rationale is the architectural-review artefact. Short
    // rationales = lazy additions; keep the bar high.
    for (const { rationale } of ALLOWED_REPO_IMPORTERS) {
      expect(rationale.length).toBeGreaterThanOrEqual(50);
    }
  });

  describe('self-check — the gate actually detects real offenders', () => {
    // Synthetic import snippets so a future refactor that breaks
    // REPO_IMPORT_RE fails HERE before silently green-lighting actual
    // offenders.
    const shouldFlag = [
      `import { getKVRepository } from '../../../core/src/kv/repository';`,
      `import { getVaultRepository } from '@dina/core/src/vault/repository';`,
      `import { X } from '../../core/src/workflow/repository.js';`,
      `import { Y } from '../../core/src/contacts/repository.ts';`,
    ];
    const shouldNotFlag = [
      `import { CoreClient } from '@dina/core';`,                         // portable CoreClient
      `import { VaultItem } from '@dina/core/src/domain/types';`,         // domain type, not repo
      `import { signRequest } from '../../core/src/auth/canonical';`,     // auth layer, not repo
      `import type { TocEntry } from '../../core/src/memory/domain';`,    // domain-layer type
    ];

    it.each(shouldFlag.map((s) => [s]))('flags repo import: %s', (snippet) => {
      expect([...snippet.matchAll(REPO_IMPORT_RE)].length).toBeGreaterThan(0);
    });

    it.each(shouldNotFlag.map((s) => [s]))('does NOT flag: %s', (snippet) => {
      expect([...snippet.matchAll(REPO_IMPORT_RE)].length).toBe(0);
    });
  });
});
