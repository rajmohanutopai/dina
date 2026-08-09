import type { CredentialStatus, CredentialStore } from './credential_broker';
import type { DatabaseAdapter } from '../storage/db_adapter';

/**
 * Where connector credentials live (§8.3, §18.3 — WS-9.3).
 *
 * TIER 0, WITH THE REST OF THE NODE'S SECRETS. `identity.sqlite` is SQLCipher
 * over a per-persona DEK derived from the master seed, so the material is
 * encrypted at rest by the same key that protects the vault. A second
 * application-level wrapping was considered and rejected: its key would have to
 * live in the same place, so it would add a step without adding a boundary, and
 * a rotation path with two ways to fail is a rotation path owners avoid.
 *
 * THE MATERIAL LEAVES THIS FILE THROUGH EXACTLY ONE DOOR — `useSecret`, which
 * hands it to a callback and never returns it. `describe` and `list` read the
 * status columns and never the material column, which is why the SELECTs name
 * their columns instead of using `*`: a `SELECT *` here would put the secret in
 * whatever the caller logged.
 *
 * ROTATION IS A REPLACE, NOT A VERSION. Keeping the old material "just in case"
 * is how a revoked credential keeps working; the row holds one value and the
 * moment the owner set it.
 */

export interface RotationInput {
  resource: string;
  /** The install permitted to use it. */
  installId: string;
  /** What it may be used for. Empty means it may be used for nothing. */
  operations: string[];
  /** The credential. Read once, stored, never returned. */
  material: string;
  nowMs: number;
}

export type RotationRefusal =
  | 'empty_resource'
  | 'empty_install'
  | 'empty_material'
  | 'no_operations';

export type RotationVerdict = { ok: true } | { ok: false; refusal: RotationRefusal; error: string };

/** The write side. Held by the owner surface; the broker never sees it. */
export interface RotatableCredentialStore extends CredentialStore {
  /** Set or replace the material for a resource. */
  rotate(input: RotationInput): RotationVerdict;
  /** Remove it. Returns false when there was nothing to remove. */
  forget(resource: string): boolean;
}

/**
 * Shared refusals, so the SQLite and in-memory stores cannot drift.
 *
 * `no_operations` is the one worth stating: a credential granted no operations
 * can never be used, so accepting it would store a secret that does nothing —
 * all of the risk of holding it and none of the use.
 */
function checkRotation(input: RotationInput): RotationVerdict {
  if (input.resource === '') {
    return { ok: false, refusal: 'empty_resource', error: 'a credential needs a name' };
  }
  if (input.installId === '') {
    return {
      ok: false,
      refusal: 'empty_install',
      error: 'a credential belongs to one install; an empty id names none',
    };
  }
  if (input.material === '') {
    return {
      ok: false,
      refusal: 'empty_material',
      error: 'empty material would store a credential that authenticates nothing',
    };
  }
  if (input.operations.length === 0) {
    return {
      ok: false,
      refusal: 'no_operations',
      error: 'a credential with no operations can never be used; remove it instead',
    };
  }
  return { ok: true };
}

interface CredentialRow {
  resource: string;
  install_id: string;
  operations_json: string;
  rotated_at_ms: number;
  last_result: string;
  last_checked_at_ms: number | null;
}

/** Operations, or an empty list when the stored JSON is unreadable. */
function readOperations(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    // An unreadable or wrong-shaped list means this credential may be used for
    // NOTHING, which fails toward refusing. Believing a partially-parsed list
    // would let a corrupted row widen what a secret is good for.
    return Array.isArray(parsed) ? parsed.filter((op): op is string => typeof op === 'string') : [];
  } catch {
    return [];
  }
}

function toStatus(row: CredentialRow): CredentialStatus {
  const result = row.last_result;
  return {
    resource: row.resource,
    installId: row.install_id,
    operations: readOperations(row.operations_json),
    rotatedAtMs: row.rotated_at_ms,
    // An unrecognised value reads as `never_used` rather than `ok`: a status
    // this build cannot interpret has not earned the reassurance.
    lastResult: result === 'ok' || result === 'failed' ? result : 'never_used',
    lastCheckedAtMs: row.last_checked_at_ms,
  };
}

const STATUS_COLUMNS =
  'resource, install_id, operations_json, rotated_at_ms, last_result, last_checked_at_ms';

export class SQLiteCredentialStore implements RotatableCredentialStore {
  constructor(private readonly db: DatabaseAdapter) {}

  async useSecret<T>(resource: string, fn: (secret: string) => Promise<T>): Promise<T> {
    const rows = this.db.query(`SELECT material FROM commerce_credentials WHERE resource = ?`, [
      resource,
    ]) as unknown as { material: string }[];
    const row = rows[0];
    if (row === undefined) {
      // The broker checks presence first, so reaching here means the row was
      // removed between the check and the use. Throwing is right: silently
      // running an operation with an empty credential would send an
      // unauthenticated request to somebody's ERP.
      throw new Error(`commerce credential ${resource} is not configured`);
    }
    return fn(row.material);
  }

  describe(resource: string): CredentialStatus | null {
    const rows = this.db.query(
      `SELECT ${STATUS_COLUMNS} FROM commerce_credentials WHERE resource = ?`,
      [resource],
    ) as unknown as CredentialRow[];
    const row = rows[0];
    return row === undefined ? null : toStatus(row);
  }

  list(): CredentialStatus[] {
    const rows = this.db.query(
      `SELECT ${STATUS_COLUMNS} FROM commerce_credentials ORDER BY resource`,
    ) as unknown as CredentialRow[];
    return rows.map(toStatus);
  }

  recordResult(resource: string, ok: boolean, nowMs: number): void {
    this.db.run(
      `UPDATE commerce_credentials SET last_result = ?, last_checked_at_ms = ? WHERE resource = ?`,
      [ok ? 'ok' : 'failed', nowMs, resource],
    );
  }

  rotate(input: RotationInput): RotationVerdict {
    const verdict = checkRotation(input);
    if (!verdict.ok) return verdict;
    this.db.run(
      `INSERT INTO commerce_credentials
         (resource, install_id, operations_json, material, rotated_at_ms, last_result, last_checked_at_ms)
       VALUES (?, ?, ?, ?, ?, 'never_used', NULL)
       ON CONFLICT(resource) DO UPDATE SET
         install_id = excluded.install_id,
         operations_json = excluded.operations_json,
         material = excluded.material,
         rotated_at_ms = excluded.rotated_at_ms,
         -- RESET, not carried over. The previous verdict was about the
         -- previous material; keeping an ok here would tell an owner their
         -- new credential works before anything has used it.
         last_result = 'never_used',
         last_checked_at_ms = NULL`,
      [
        input.resource,
        input.installId,
        JSON.stringify(input.operations),
        input.material,
        input.nowMs,
      ],
    );
    return { ok: true };
  }

  forget(resource: string): boolean {
    const before = this.db.query(`SELECT resource FROM commerce_credentials WHERE resource = ?`, [
      resource,
    ]) as unknown as { resource: string }[];
    if (before.length === 0) return false;
    this.db.run(`DELETE FROM commerce_credentials WHERE resource = ?`, [resource]);
    return true;
  }
}

/** Test double. A production caller would be the bug. */
export class InMemoryCredentialStore implements RotatableCredentialStore {
  private readonly rows = new Map<string, CredentialStatus & { material: string }>();

  async useSecret<T>(resource: string, fn: (secret: string) => Promise<T>): Promise<T> {
    const row = this.rows.get(resource);
    if (row === undefined) throw new Error(`commerce credential ${resource} is not configured`);
    return fn(row.material);
  }

  describe(resource: string): CredentialStatus | null {
    const row = this.rows.get(resource);
    if (row === undefined) return null;
    const { material: _material, ...status } = row;
    return { ...status, operations: [...status.operations] };
  }

  list(): CredentialStatus[] {
    return [...this.rows.keys()]
      .sort()
      .map((resource) => this.describe(resource))
      .filter((status): status is CredentialStatus => status !== null);
  }

  recordResult(resource: string, ok: boolean, nowMs: number): void {
    const row = this.rows.get(resource);
    if (row === undefined) return;
    row.lastResult = ok ? 'ok' : 'failed';
    row.lastCheckedAtMs = nowMs;
  }

  rotate(input: RotationInput): RotationVerdict {
    const verdict = checkRotation(input);
    if (!verdict.ok) return verdict;
    this.rows.set(input.resource, {
      resource: input.resource,
      installId: input.installId,
      operations: [...input.operations],
      material: input.material,
      rotatedAtMs: input.nowMs,
      lastResult: 'never_used',
      lastCheckedAtMs: null,
    });
    return { ok: true };
  }

  forget(resource: string): boolean {
    return this.rows.delete(resource);
  }
}
