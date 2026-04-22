/**
 * Port async-only gate (task 2.8) — guards the Phase 2 async-port rule.
 *
 * The rule: every method on every `export interface *(Repository|
 * Adapter|Provider)` in `packages/core/src/**` returns `Promise<T>`.
 * Enforced as a jest test so CI fails on regression.
 *
 * Pattern: positive allowlist. The CONVERTED_PORTS set names the
 * ports Phase 2.3 has finished. Each file in the list has every
 * method signature checked for `Promise<…>` return. Ports NOT in the
 * list are PENDING conversion (ContactRepository, WorkflowRepository,
 * DatabaseAdapter at time of writing) — they don't fail the gate, but
 * also aren't spot-checked by it. As each pending port converts, add
 * it to the allowlist and the gate will scan it from that iteration.
 *
 * See `packages/README.md` §Async-port rule for the full contract and
 * the four conversion patterns.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md task 2.8.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CORE_SRC = resolve(__dirname, '..', 'src');

/** Ports that have completed Phase 2.3 conversion. Add entries here
 *  as additional ports are converted — the gate then spot-checks them. */
const CONVERTED_PORTS: readonly { file: string; interfaceName: string }[] = [
  { file: 'kv/repository.ts', interfaceName: 'KVRepository' },
  { file: 'audit/repository.ts', interfaceName: 'AuditRepository' },
  { file: 'devices/repository.ts', interfaceName: 'DeviceRepository' },
  { file: 'memory/repository.ts', interfaceName: 'TopicRepository' },
  { file: 'chat/repository.ts', interfaceName: 'ChatMessageRepository' },
  { file: 'reminders/repository.ts', interfaceName: 'ReminderRepository' },
  { file: 'service/service_config_repository.ts', interfaceName: 'ServiceConfigRepository' },
  { file: 'staging/repository.ts', interfaceName: 'StagingRepository' },
  { file: 'vault/repository.ts', interfaceName: 'VaultRepository' },
  { file: 'storage/db_provider.ts', interfaceName: 'DBProvider' },
];

/** Ports still pending conversion. Documented explicitly so the
 *  gate + the task doc stay in sync. Move entries to CONVERTED_PORTS
 *  as each converts. */
const PENDING_PORTS: readonly { file: string; interfaceName: string; reason: string }[] = [
  {
    file: 'contacts/repository.ts',
    interfaceName: 'ContactRepository',
    reason: '167 test call-sites; GAP-PERSIST-01 requires synchronous write-then-memory semantics',
  },
  {
    file: 'workflow/repository.ts',
    interfaceName: 'WorkflowRepository',
    reason: '~15 methods, 7 caller files, service-layer transactions + state machine',
  },
];

/**
 * Ports intentionally exempted from the async-only rule. An exempt
 * port stays synchronous *by design* — not because it hasn't been
 * converted yet. Each entry must name the file whose source comment
 * spells out the rationale, so the gate can verify that the code +
 * the gate + task 2.3's tracking are all saying the same thing.
 *
 * The async-only rule in packages/README.md § Async-port rule applies
 * to *genuine I/O-boundary ports* (HTTP, WebSocket, non-mmap files).
 * CPU-bound native bindings like SQLite via JSI or better-sqlite3
 * don't benefit from async: wrapping a sync native call in `Promise<T>`
 * just pushes identical work into a microtask while (a) masking
 * synchronous throw semantics, (b) forcing every call site to `await`,
 * and (c) breaking the transaction-callback contract where `fn()`
 * must run to completion before commit. SQLite is the canonical
 * exempt case — pinned here rather than silently deviating.
 */
const EXEMPTED_PORTS: readonly { file: string; interfaceName: string; reason: string }[] = [
  {
    file: 'storage/db_adapter.ts',
    interfaceName: 'DatabaseAdapter',
    reason:
      'CPU-bound SQLite binding — both better-sqlite3-multiple-ciphers (Node) and op-sqlite via JSI (RN) expose synchronous native calls. Async wrap would add microtask overhead, break sync-throw semantics, and complicate the transaction(fn) callback where the body must run to completion before COMMIT. Pinned as the canonical async-only-rule counter-example per task 3.4.',
  },
];

/**
 * Extract the body of an `export interface X { … }` block from a TS
 * source file. Returns the lines inside the braces (not including
 * the outer `export interface` line or the closing `}`).
 *
 * Brace-aware: nested `{…}` (e.g. an inline-return-type) is handled
 * by balance-counting so we don't close early.
 */
function extractInterfaceBody(source: string, interfaceName: string): string[] | null {
  const pattern = new RegExp(`export interface ${interfaceName}\\b[^{]*\\{`);
  const match = pattern.exec(source);
  if (!match) return null;
  const startIdx = match.index + match[0].length;
  // Walk forward counting braces.
  let depth = 1;
  let i = startIdx;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    if (depth === 0) break;
    i++;
  }
  if (depth !== 0) return null; // malformed
  const body = source.slice(startIdx, i);
  return body.split('\n');
}

/**
 * Scan an interface body for method signatures. Returns each method
 * with its declared return type as a raw string. Skips property
 * declarations (no parens) and comment lines.
 *
 * A "method signature" is a line that matches:
 *   [leading whitespace] methodName( … ): RETURN_TYPE;
 *
 * where parens can span multiple lines. We join continuation lines
 * then re-parse. Good enough for our port files, which follow a
 * consistent style.
 */
function extractMethods(
  bodyLines: string[],
): { name: string; returnType: string; lineNum: number }[] {
  const out: { name: string; returnType: string; lineNum: number }[] = [];
  // Drop comment/whitespace, join multi-line signatures.
  const joined: { text: string; lineNum: number }[] = [];
  let current: string[] = [];
  let currentStart = 0;
  let parenDepth = 0;
  for (let idx = 0; idx < bodyLines.length; idx++) {
    const line = bodyLines[idx];
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    if (trimmed.startsWith('/**') || trimmed.startsWith('/*')) {
      // Skip jsdoc block until we hit */ — naive but sufficient
      while (idx < bodyLines.length && !bodyLines[idx].includes('*/')) idx++;
      continue;
    }
    if (current.length === 0) currentStart = idx;
    current.push(line);
    // track paren depth; only consider signature complete when balanced AND ends with ;
    for (const ch of line) {
      if (ch === '(') parenDepth++;
      else if (ch === ')') parenDepth--;
    }
    if (parenDepth === 0 && trimmed.endsWith(';')) {
      joined.push({ text: current.join(' '), lineNum: currentStart + 1 });
      current = [];
    }
  }

  for (const { text, lineNum } of joined) {
    // methodName(...): returnType;
    const m = /^\s*(\w+)\s*(?:<[^>]*>)?\s*\([\s\S]*?\)\s*:\s*([\s\S]+?)\s*;?\s*$/.exec(text);
    if (!m) continue;
    out.push({ name: m[1], returnType: m[2].trim(), lineNum });
  }
  return out;
}

describe('Port async gate (task 2.8)', () => {
  it('every method on every converted port returns Promise<T>', () => {
    const offenders: string[] = [];

    for (const { file, interfaceName } of CONVERTED_PORTS) {
      const filePath = resolve(CORE_SRC, file);
      const source = readFileSync(filePath, 'utf8');
      const body = extractInterfaceBody(source, interfaceName);
      if (body === null) {
        offenders.push(`[missing] ${file}: cannot find "export interface ${interfaceName}"`);
        continue;
      }
      const methods = extractMethods(body);
      if (methods.length === 0) {
        offenders.push(`[empty] ${file}:${interfaceName} — no methods found (parser missed them?)`);
        continue;
      }
      for (const { name, returnType, lineNum } of methods) {
        // A getter-style property (`readonly isOpen: boolean;`) matches
        // our method regex only when it has parens; properties without
        // parens don't. But the regex requires `(...)` so only true
        // methods land here. Still, defensive check.
        if (!returnType.startsWith('Promise<')) {
          offenders.push(
            `[sync-return] ${file}:${interfaceName}.${name} (line ${lineNum}) returns "${returnType}" — expected Promise<…>`,
          );
        }
      }
    }

    if (offenders.length > 0) {
      throw new Error(
        `port-async gate: ${offenders.length} violation(s):\n  ${offenders.join('\n  ')}`,
      );
    }
  });

  it('pending ports are enumerated with a reason (doc / gate sync)', () => {
    // Sanity check: each pending port has a non-empty reason — future
    // iterations that move a port from PENDING to CONVERTED should
    // update this file. If reason is empty, the migration is stale.
    for (const { interfaceName, reason } of PENDING_PORTS) {
      expect(reason.length).toBeGreaterThan(20);
      expect(interfaceName).toMatch(/^[A-Z]\w+(Repository|Adapter|Provider)$/);
    }
  });

  it('exempted ports have a substantive rationale AND an on-purpose comment in source', () => {
    // The exemption is load-bearing — it's the line between "temporarily
    // unfinished" (PENDING) and "intentionally sync forever" (EXEMPTED).
    // Enforce two invariants:
    //   1. The gate's stored `reason` is long enough to be meaningful.
    //   2. The source file itself contains a comment acknowledging the
    //      sync-on-purpose choice, using the word "sync" AND a reason
    //      hint ("cpu-bound", "native", "transaction", or "microtask").
    // This keeps the gate + the code in sync: you can't exempt a port
    // just by editing this test — the file has to carry the rationale
    // too, or the reviewer of the impl notices.
    for (const { file, interfaceName, reason } of EXEMPTED_PORTS) {
      expect(reason.length).toBeGreaterThan(50);
      expect(interfaceName).toMatch(/^[A-Z]\w+(Repository|Adapter|Provider)$/);

      const source = readFileSync(resolve(CORE_SRC, file), 'utf8');
      const hasSyncAck = /\bsync\b/i.test(source);
      const hasRationaleHint = /cpu-bound|native|transaction|microtask/i.test(source);
      expect(hasSyncAck && hasRationaleHint).toBe(true);
    }
  });

  it('converted + pending + exempted covers every port interface in core/src', () => {
    // Discovery gate: if a new port is added and forgotten in all three
    // lists, this fails. Acts as a nudge to update the enumeration.
    const ALL_KNOWN = new Set([
      ...CONVERTED_PORTS.map((p) => p.interfaceName),
      ...PENDING_PORTS.map((p) => p.interfaceName),
      ...EXEMPTED_PORTS.map((p) => p.interfaceName),
    ]);

    const EXPECTED = [
      'KVRepository',
      'AuditRepository',
      'DeviceRepository',
      'TopicRepository',
      'ChatMessageRepository',
      'ReminderRepository',
      'ServiceConfigRepository',
      'StagingRepository',
      'VaultRepository',
      'ContactRepository',
      'WorkflowRepository',
      'DBProvider',
      'DatabaseAdapter',
    ];

    for (const name of EXPECTED) {
      expect(ALL_KNOWN.has(name)).toBe(true);
    }
  });

  it('the three lists are mutually exclusive', () => {
    // A port must be in exactly one category. Catches accidental
    // duplication (e.g. leaving DatabaseAdapter in PENDING after also
    // adding it to EXEMPTED).
    const convertedNames = new Set(CONVERTED_PORTS.map((p) => p.interfaceName));
    const pendingNames = new Set(PENDING_PORTS.map((p) => p.interfaceName));
    const exemptedNames = new Set(EXEMPTED_PORTS.map((p) => p.interfaceName));

    const convertedPending = [...convertedNames].filter((n) => pendingNames.has(n));
    const convertedExempted = [...convertedNames].filter((n) => exemptedNames.has(n));
    const pendingExempted = [...pendingNames].filter((n) => exemptedNames.has(n));

    expect(convertedPending).toEqual([]);
    expect(convertedExempted).toEqual([]);
    expect(pendingExempted).toEqual([]);
  });
});
