/**
 * Plugin standing approvals — `plugin_grants` (PLUGIN_ARCHITECTURE.md
 * §8, migration v18).
 *
 * Keyed `(install_id, capability, approved_scope_hash)`: a same-scope
 * update leaves the hash unchanged and grants survive; scope growth
 * changes the hash, nothing matches, and re-consent happens
 * STRUCTURALLY rather than because a rule remembered to fire.
 *
 * Constraint mechanics (§8 — "constraints are enforceable or they are
 * theater"):
 *   - constraint schemas are VERSIONED; an unknown version or key
 *     FAILS CLOSED (the grant simply doesn't match, the invocation
 *     cards);
 *   - count consumption is atomic check-and-consume at dispatch, keyed
 *     on the LOGICAL EXECUTION (`execution_id`): idempotent
 *     lease-recovery retries under the same execution_id never consume
 *     a second use;
 *   - qualifying constraints have enforced ceilings — a count of a
 *     billion is not a constraint;
 *   - HIGH-class capabilities (`booking`/`write`/`agentic`) may NOT
 *     hold an unconstrained `standing` grant — creation rejects it.
 *
 * Reservations release only when a task provably never executed
 * (never claimed / terminalized stale_authority before any claim); an
 * outcome_unknown ending stays consumed — conservative in the
 * constraint's favor (§8).
 */

import { randomBytes } from '@noble/ciphers/utils.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

export type PluginGrantType = 'once' | 'window' | 'standing';

/** Versioned constraint object (§8). v1 vocabulary. */
export interface PluginGrantConstraints {
  readonly version: 1;
  /** Max logical executions this grant may authorize. */
  readonly max_count?: number;
  /** Resource allowlist — matched against the dispatch's resource tag. */
  readonly resources?: readonly string[];
  /** Value ceiling — matched against the dispatch's declared value. */
  readonly max_value?: number;
}

/** Enforced ceilings — a nominally-constrained grant must not recreate
 * the blank check it exists to prevent (§8). Audit D8: max_value had no
 * ceiling, so a "constrained" grant could carry max_value: 1e18 —
 * theater. The value unit is plugin-defined, so the ceiling is
 * generous; it only rejects the absurd (a quintillion is not a cap). */
export const CONSTRAINT_CEILINGS = Object.freeze({
  MAX_COUNT_CEILING: 1000,
  MAX_VALUE_CEILING: 1_000_000_000_000, // 1e12; tunable, §21
} as const);

const HIGH_ACTION_CLASSES = new Set(['booking', 'write', 'agentic']);

const KNOWN_CONSTRAINT_KEYS = new Set(['version', 'max_count', 'resources', 'max_value']);

export interface PluginGrant {
  grantId: string;
  installId: string;
  capability: string;
  approvedScopeHash: string;
  grantType: PluginGrantType;
  constraints?: PluginGrantConstraints;
  expiresAt?: number;
  revokedAt?: number;
  createdAt: number;
}

export type GrantDenialReason =
  | 'no_grant'
  | 'revoked'
  | 'expired'
  | 'constraints_unparseable' // fail closed (§8)
  | 'count_exhausted'
  | 'resource_not_allowed'
  | 'value_exceeds_cap';

export type GrantCheckResult =
  | { allowed: true; grantId: string }
  | { allowed: false; reason: GrantDenialReason };

export interface AuthorizeArgs {
  installId: string;
  capability: string;
  approvedScopeHash: string;
  /** The logical execution consuming a use (stable across attempts). */
  executionId: string;
  /** Optional dispatch metadata the constraints match against. */
  resource?: string;
  value?: number;
  nowSec: number;
}

export interface PluginGrantRepository {
  /**
   * Create a grant. Throws when a HIGH-class capability requests an
   * unconstrained `standing` grant (§8) or when constraints are
   * malformed / above ceilings — a grant that cannot be enforced must
   * not exist.
   */
  create(grant: Omit<PluginGrant, 'grantId' | 'createdAt'>, actionClass: string, nowMs: number): string;

  /**
   * THE authorization primitive + atomic consume. A use is consumed
   * when `executionId` is FIRST authorized against the grant; the same
   * executionId re-authorizes without consuming again (idempotent
   * lease recovery, §8). Runs check + consume in one transaction.
   */
  authorizeAndConsume(args: AuthorizeArgs): GrantCheckResult;

  /**
   * Release a reservation for a task that provably never executed
   * (never claimed, or stale_authority before any claim). Returns true
   * when a use row was released.
   */
  releaseUse(executionId: string): boolean;

  getById(grantId: string): PluginGrant | null;
  listByInstall(installId: string): PluginGrant[];
  revoke(grantId: string, nowSec: number): boolean;
  /** Cascade on uninstall/device-revoke (revokeForAgent precedent). */
  revokeAllForInstall(installId: string, nowSec: number): number;
}

let repo: PluginGrantRepository | null = null;
export function setPluginGrantRepository(r: PluginGrantRepository | null): void {
  repo = r;
}
export function getPluginGrantRepository(): PluginGrantRepository | null {
  return repo;
}

/**
 * Parse + validate a constraints JSON blob. Returns null when the
 * object is unknown-versioned, has unknown keys, or is malformed — the
 * caller FAILS CLOSED (§8: "an unknown constraint type fails closed —
 * the grant simply doesn't match and the invocation cards").
 */
export function parseConstraints(raw: unknown): PluginGrantConstraints | null {
  if (raw === null || raw === undefined) return null;
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const c = value as Record<string, unknown>;
  if (c.version !== 1) return null;
  for (const key of Object.keys(c)) {
    if (!KNOWN_CONSTRAINT_KEYS.has(key)) return null;
  }
  if (
    c.max_count !== undefined &&
    (!Number.isInteger(c.max_count) ||
      (c.max_count as number) < 1 ||
      (c.max_count as number) > CONSTRAINT_CEILINGS.MAX_COUNT_CEILING)
  ) {
    return null;
  }
  if (
    c.resources !== undefined &&
    (!Array.isArray(c.resources) || c.resources.some((r) => typeof r !== 'string' || r === ''))
  ) {
    return null;
  }
  if (
    c.max_value !== undefined &&
    (typeof c.max_value !== 'number' ||
      !Number.isFinite(c.max_value) ||
      c.max_value <= 0 ||
      c.max_value > CONSTRAINT_CEILINGS.MAX_VALUE_CEILING)
  ) {
    return null;
  }
  return c as unknown as PluginGrantConstraints;
}

/** At least one enforceable bound (§8: HIGH-class standing needs one). */
export function hasMeaningfulConstraint(c: PluginGrantConstraints | null): boolean {
  if (c === null) return false;
  return c.max_count !== undefined || c.resources !== undefined || c.max_value !== undefined;
}

function rowToGrant(r: DBRow): PluginGrant {
  const constraints = parseConstraints(r.constraints_json ?? null);
  return {
    grantId: String(r.grant_id),
    installId: String(r.install_id),
    capability: String(r.capability),
    approvedScopeHash: String(r.approved_scope_hash),
    grantType: String(r.grant_type) as PluginGrantType,
    ...(constraints !== null ? { constraints } : {}),
    ...(typeof r.expires_at === 'number' ? { expiresAt: r.expires_at } : {}),
    ...(typeof r.revoked_at === 'number' ? { revokedAt: r.revoked_at } : {}),
    createdAt: Number(r.created_at),
  };
}

export class SQLitePluginGrantRepository implements PluginGrantRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  create(
    grant: Omit<PluginGrant, 'grantId' | 'createdAt'>,
    actionClass: string,
    nowMs: number,
  ): string {
    // Constraint validation at CREATION — a grant that cannot be
    // enforced must not exist (§8).
    let constraintsJson: string | null = null;
    if (grant.constraints !== undefined) {
      const parsed = parseConstraints(grant.constraints);
      if (parsed === null) {
        throw new Error('plugin_grants: constraints are malformed or above ceilings (§8)');
      }
      constraintsJson = JSON.stringify(parsed);
    }
    // A 'window' grant is time-bounded by DEFINITION — without an expiry
    // it is a standing grant in disguise (audit D8). Reject it.
    if (grant.grantType === 'window' && grant.expiresAt === undefined) {
      throw new Error('plugin_grants: a window grant must carry an expiry (§8)');
    }
    // HIGH-class capabilities may NEVER hold an UNBOUNDED grant (§8).
    // Audit D8: the old check keyed strictly on grantType==='standing',
    // so a 'window' (no expiry) or 'once' (no enforcement) grant slipped
    // the net. A HIGH grant is bounded iff it is: 'once' (single
    // execution, enforced at consume), OR time-bounded (expiresAt), OR
    // carries a meaningful count/resource/value constraint.
    if (HIGH_ACTION_CLASSES.has(actionClass)) {
      const bounded =
        grant.grantType === 'once' ||
        grant.expiresAt !== undefined ||
        hasMeaningfulConstraint(parseConstraints(grant.constraints ?? null));
      if (!bounded) {
        throw new Error(
          `plugin_grants: a ${actionClass} grant must be bounded (once / expiry / constraint) — no blank checks (§8)`,
        );
      }
    }
    const grantId = `plg_${bytesToHex(randomBytes(12))}`;
    this.db.execute(
      `INSERT INTO plugin_grants
         (grant_id, install_id, capability, approved_scope_hash, grant_type,
          constraints_json, expires_at, revoked_at, created_at)
       VALUES (?,?,?,?,?,?,?,NULL,?)`,
      [
        grantId,
        grant.installId,
        grant.capability,
        grant.approvedScopeHash,
        grant.grantType,
        constraintsJson,
        grant.expiresAt ?? null,
        nowMs,
      ],
    );
    return grantId;
  }

  authorizeAndConsume(args: AuthorizeArgs): GrantCheckResult {
    let result: GrantCheckResult = { allowed: false, reason: 'no_grant' };
    this.db.transaction(() => {
      const rows = this.db.query(
        `SELECT * FROM plugin_grants
         WHERE install_id = ? AND capability = ? AND approved_scope_hash = ?
         ORDER BY created_at DESC`,
        [args.installId, args.capability, args.approvedScopeHash],
      );
      if (rows.length === 0) {
        result = { allowed: false, reason: 'no_grant' };
        return;
      }
      // Evaluate candidates newest-first; the first live grant decides.
      let denial: GrantDenialReason = 'no_grant';
      for (const row of rows) {
        if (typeof row.revoked_at === 'number') {
          denial = 'revoked';
          continue;
        }
        if (typeof row.expires_at === 'number' && row.expires_at <= args.nowSec) {
          denial = 'expired';
          continue;
        }
        // Fail closed on unparseable constraints (§8): stored JSON that
        // no longer parses under this node's vocabulary = no match.
        // Audit D8: an EMPTY-string constraints_json used to be treated
        // as "no constraints" and fail OPEN. A legitimately-unconstrained
        // grant stores NULL, never ''. So ANY non-null constraints value
        // that fails to parse — empty string included — is anomalous and
        // fails CLOSED.
        const hasStoredConstraints =
          row.constraints_json !== null && row.constraints_json !== undefined;
        const constraints = parseConstraints(row.constraints_json ?? null);
        if (hasStoredConstraints && constraints === null) {
          denial = 'constraints_unparseable';
          continue;
        }
        const grantId = String(row.grant_id);
        const grantType = String(row.grant_type);

        // Idempotent re-authorization FIRST: the SAME execution_id
        // always re-authorizes without a second consume (§8:
        // lease-recovery retries), even for a 'once' grant.
        const existingUse = this.db.query(
          'SELECT 1 FROM plugin_grant_uses WHERE grant_id = ? AND execution_id = ? LIMIT 1',
          [grantId, args.executionId],
        );
        if (existingUse.length > 0) {
          result = { allowed: true, grantId };
          return;
        }

        // A 'once' grant authorizes exactly ONE distinct logical
        // execution (audit D8: nothing enforced once-ness before) —
        // an implicit max_count=1 for a NEW execution_id.
        if (grantType === 'once') {
          const used = this.db.query<{ c: number }>(
            'SELECT COUNT(*) AS c FROM plugin_grant_uses WHERE grant_id = ?',
            [grantId],
          );
          if ((used.length > 0 ? Number(used[0].c) : 0) >= 1) {
            denial = 'count_exhausted';
            continue;
          }
        }

        if (constraints !== null) {
          if (constraints.resources !== undefined) {
            if (args.resource === undefined || !constraints.resources.includes(args.resource)) {
              denial = 'resource_not_allowed';
              continue;
            }
          }
          if (constraints.max_value !== undefined) {
            if (args.value === undefined || args.value > constraints.max_value) {
              denial = 'value_exceeds_cap';
              continue;
            }
          }
          if (constraints.max_count !== undefined) {
            const used = this.db.query<{ c: number }>(
              'SELECT COUNT(*) AS c FROM plugin_grant_uses WHERE grant_id = ?',
              [grantId],
            );
            const count = used.length > 0 ? Number(used[0].c) : 0;
            if (count >= constraints.max_count) {
              denial = 'count_exhausted';
              continue;
            }
          }
        }

        // Atomic consume — inside this transaction, so concurrent
        // dispatches cannot jointly exceed max_count (§8: one
        // transaction, never read-then-update).
        this.db.execute(
          'INSERT INTO plugin_grant_uses (grant_id, execution_id, used_at) VALUES (?,?,?)',
          [grantId, args.executionId, args.nowSec],
        );
        result = { allowed: true, grantId };
        return;
      }
      result = { allowed: false, reason: denial };
    });
    return result;
  }

  releaseUse(executionId: string): boolean {
    const affected = this.db.run('DELETE FROM plugin_grant_uses WHERE execution_id = ?', [
      executionId,
    ]);
    return affected > 0;
  }

  getById(grantId: string): PluginGrant | null {
    const rows = this.db.query('SELECT * FROM plugin_grants WHERE grant_id = ?', [grantId]);
    return rows.length === 0 ? null : rowToGrant(rows[0]);
  }

  listByInstall(installId: string): PluginGrant[] {
    const rows = this.db.query(
      'SELECT * FROM plugin_grants WHERE install_id = ? ORDER BY created_at DESC',
      [installId],
    );
    return rows.map(rowToGrant);
  }

  revoke(grantId: string, nowSec: number): boolean {
    const affected = this.db.run(
      'UPDATE plugin_grants SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL',
      [nowSec, grantId],
    );
    return affected > 0;
  }

  revokeAllForInstall(installId: string, nowSec: number): number {
    return this.db.run(
      'UPDATE plugin_grants SET revoked_at = ? WHERE install_id = ? AND revoked_at IS NULL',
      [nowSec, installId],
    );
  }
}
