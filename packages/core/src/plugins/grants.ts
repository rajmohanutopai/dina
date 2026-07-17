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
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

import { canonicalJson, getCatalogCapability, hasUnsafeText } from '@dina/protocol';

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

export type PluginGrantType = 'once' | 'window' | 'standing';

/** Round-15 #10: the persisted-row hardening allowlist. A `grant_type` outside
 *  this set (schema drift / out-of-app write) is quarantined fail-closed rather
 *  than defaulting to unlimited window/standing behaviour. The DB CHECK is the
 *  primary enforcement; this is the code-level backstop mirroring rowToInstall. */
const VALID_GRANT_TYPE: ReadonlySet<string> = new Set<PluginGrantType>([
  'once',
  'window',
  'standing',
]);

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
  // Round-16 #12: the resources allowlist is a per-authorization linear scan +
  // stored blob. Bound the token count + per-token length so a huge list can't
  // slow every authorization or bloat the row.
  MAX_RESOURCE_TOKENS: 64,
  MAX_RESOURCE_TOKEN_LEN: 256,
} as const);

/** Round-9 #1/#12: the longest a standing/window grant's expiry may sit in
 * the future. An `expiresAt` in the far future (or a ms value mistaken for
 * seconds — ~50,000× too large) is not a "bound"; it recreates the blank
 * check the bounded-standing rule exists to prevent. One year is generous for
 * a standing plugin grant; the owner re-consents past it. */
const MAX_GRANT_WINDOW_SEC = 366 * 24 * 60 * 60; // ~1 year

/** Round-9 #1/#8: `payment` is a first-class effectful ActionClass (moves
 * money). Omitting it here let a canonical `payment` capability escape the
 * bounded-standing requirement (verifiedLowRisk) — a blank check for funds. */
const HIGH_ACTION_CLASSES = new Set(['booking', 'write', 'agentic', 'payment']);

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
  /**
   * Round-11 #14: true when the row carries a non-null `constraints_json`
   * that no longer parses under this node's vocabulary. `authorizeAndConsume`
   * fails such a grant CLOSED (`constraints_unparseable`), but the plain
   * projection previously dropped the unparseable blob and read as an
   * UNCONSTRAINED grant — a fail-open for anything (listing UI, revoke
   * tooling) reading the projected `constraints`. Surfacing the corruption
   * keeps the projection honest with the authorization decision.
   */
  constraintsCorrupt?: boolean;
}

export type GrantDenialReason =
  | 'no_grant'
  | 'revoked'
  | 'expired'
  | 'constraints_unparseable' // fail closed (§8)
  | 'count_exhausted'
  | 'resource_not_allowed'
  | 'value_exceeds_cap'
  | 'invocation_mismatch'; // Round-11 #1: replayed execution_id, different params

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
  /** Round-12 #1: the full invocation params/context — bound into the
   *  invocation digest so a same-execution_id replay must carry the SAME
   *  invocation, not just the same resource/value. Producer-supplied. */
  params?: unknown;
  context?: unknown;
  nowSec: number;
}

export interface PluginGrantRepository {
  /**
   * Create a grant. Throws when a HIGH-class capability requests an
   * unconstrained `standing` grant (§8) or when constraints are
   * malformed / above ceilings — a grant that cannot be enforced must
   * not exist.
   */
  create(
    grant: Omit<PluginGrant, 'grantId' | 'createdAt'>,
    actionClass: string,
    nowMs: number,
  ): string;

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
   * when a use row was released. Round-11 #7: keyed on the SPECIFIC
   * (grantId, executionId) reservation — releasing by executionId alone
   * would delete the reservation on whatever grant happens to share that
   * executionId, not the one that authorized this task.
   */
  releaseUse(grantId: string, executionId: string): boolean;

  /**
   * Round-11 #2: a read-only check that a live (unrevoked, unexpired)
   * grant exists for this exact scope key at `nowSec`, WITHOUT consuming
   * a use. The claim guard uses it to fail a queued plugin task whose
   * authorizing grant was revoked/expired AFTER enqueue but before the
   * consume at dispatch — the produce-time authorization is not proof the
   * grant is still live at claim time.
   */
  hasLiveGrant(
    installId: string,
    capability: string,
    approvedScopeHash: string,
    nowSec: number,
  ): boolean;

  /**
   * Round-13 #3/#4: the consumed-use row for `(grantId, executionId)`, or null
   * when this execution never consumed the grant. The claim guard uses it to
   * PROVE a grant-authorized task actually called `authorizeAndConsume` (naming
   * a live grant is not proof of consumption — once/max_count/resource/value are
   * only enforced at consume), and to bind the envelope's pinned digest to the
   * digest that was actually consumed.
   */
  getUse(grantId: string, executionId: string): { invocationDigest: string | null } | null;

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
    // Round-16 #12: require a NON-EMPTY, DEDUPED, bounded token set. An empty
    // array satisfies hasMeaningfulConstraint (counts as "bounded") yet
    // authorizes nothing (`[].includes(x)` is always false) — theater, not a
    // bound; and an unbounded list makes every authorization a linear scan.
    // Consistent with the §8 "unenforceable = must not exist" stance on
    // max_count / max_value ceilings.
    (!Array.isArray(c.resources) ||
      c.resources.length === 0 ||
      c.resources.length > CONSTRAINT_CEILINGS.MAX_RESOURCE_TOKENS ||
      c.resources.some(
        (r) =>
          typeof r !== 'string' ||
          // PLG-27 #15: resource tokens are BOTH authorization inputs
          // (`constraints.resources.includes(args.resource)`) AND owner-visible
          // constraints, so they need the same canonical-token contract as
          // manifest identifiers: reject whitespace-only (renders blank; `r.trim()
          // === ''` also covers the old `=== ''`) and control/bidi/zero-width
          // spoofing chars (space 0x20 passes hasUnsafeText, so both checks are
          // needed).
          r.trim() === '' ||
          r.length > CONSTRAINT_CEILINGS.MAX_RESOURCE_TOKEN_LEN ||
          hasUnsafeText(r),
      ) ||
      new Set(c.resources).size !== c.resources.length)
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

/**
 * Round-11 #1: the digest binding an execution_id to the exact
 * constraint-relevant params it was first authorized under. Only the
 * fields the constraints gate — `resource` (the resources allowlist) and
 * `value` (the value cap) — are bound; the `count` constraint is stateful
 * (a running tally, not a per-invocation param) so it is not part of the
 * digest. A `null` field is canonicalised distinctly from `undefined` so
 * "no resource supplied" cannot collide with "resource: 'null'".
 */
/** JSON round-trip a value into a canonicalJson-safe form: undefined → null,
 *  non-finite numbers → null, unserializable (circular) → null. canonicalJson
 *  throws on non-finite, so params/context (arbitrary caller data) are cleaned
 *  first — the coercion is deterministic, so equal invocations hash equal. */
function jsonSafeForDigest(v: unknown): unknown {
  if (v === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(v)) as unknown;
  } catch {
    return null;
  }
}

export function invocationDigest(args: {
  resource?: string;
  value?: number;
  params?: unknown;
  context?: unknown;
}): string {
  // A non-finite value (NaN/±Infinity) is denied by the value-cap check and
  // never consumed, so its digest is moot — but canonicalJson throws on
  // non-finite numbers, and this runs BEFORE that check. Coerce to null so the
  // digest is always computable (a finite in-cap value is what actually binds).
  const value = typeof args.value === 'number' && Number.isFinite(args.value) ? args.value : null;
  // Round-12 #1: bind the FULL constraint-relevant invocation — resource + value
  // AND the params/context. A retry reusing the same execution_id must replay
  // the SAME recipient/date/body/SKU/account; a retry that changes any of them
  // is a DISTINCT invocation wearing the execution_id, and re-binds to a
  // different digest (→ `invocation_mismatch`). (Round-11 #1 bound only
  // resource+value; that scope was too narrow.)
  const canonical = canonicalJson({
    resource: args.resource ?? null,
    value,
    params: jsonSafeForDigest(args.params),
    context: jsonSafeForDigest(args.context),
  });
  return bytesToHex(sha256(utf8ToBytes(canonical)));
}

function rowToGrant(r: DBRow): PluginGrant {
  const constraints = parseConstraints(r.constraints_json ?? null);
  // Same fail-closed test as authorizeAndConsume: a stored non-null
  // constraints blob that fails to parse is anomalous — the grant is in a
  // fail-closed state (it will never authorize). Empty string included:
  // a legitimately-unconstrained grant stores NULL, never ''.
  const hasStoredConstraints = r.constraints_json !== null && r.constraints_json !== undefined;
  // Round-15 #10: an unknown grant_type is a fail-closed state — treat it as
  // corrupt so claim-guard check 7 (which honors constraintsCorrupt) refuses it,
  // rather than the projection defaulting it into window/standing behaviour.
  const grantTypeValid = VALID_GRANT_TYPE.has(String(r.grant_type));
  const constraintsCorrupt = (hasStoredConstraints && constraints === null) || !grantTypeValid;
  // Round-14 #9: revoked_at / expires_at feed claim_guard's live/dead predicate
  // (`revokedAt === undefined` → live; `expiresAt === undefined` → never
  // expires), so coerce defensively rather than trusting the JS type. A value
  // stored as a STRING (divergent-node restore, SQLite type affinity) slips
  // past a bare `typeof === 'number'` — the field is dropped and the grant
  // projects as LIVE (fail OPEN on a revoked or expired grant). Any present
  // non-null revoked_at marks revoked; a present non-finite expires_at is an
  // unenforceable bound → project as already-expired (epoch 0, ≤ any nowSec).
  const revokedPresent = r.revoked_at !== null && r.revoked_at !== undefined;
  const revokedAtNum = revokedPresent ? Number(r.revoked_at) : undefined;
  const expiresPresent = r.expires_at !== null && r.expires_at !== undefined;
  const expiresAtNum = expiresPresent ? Number(r.expires_at) : undefined;
  return {
    grantId: String(r.grant_id),
    installId: String(r.install_id),
    capability: String(r.capability),
    approvedScopeHash: String(r.approved_scope_hash),
    grantType: String(r.grant_type) as PluginGrantType,
    ...(constraints !== null ? { constraints } : {}),
    ...(constraintsCorrupt ? { constraintsCorrupt: true } : {}),
    ...(expiresPresent
      ? {
          expiresAt:
            typeof expiresAtNum === 'number' && Number.isFinite(expiresAtNum) ? expiresAtNum : 0,
        }
      : {}),
    ...(revokedPresent
      ? {
          revokedAt:
            typeof revokedAtNum === 'number' && Number.isFinite(revokedAtNum) ? revokedAtNum : 0,
        }
      : {}),
    createdAt: Number(r.created_at),
  };
}

export class SQLitePluginGrantRepository implements PluginGrantRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  create(
    grant: Omit<PluginGrant, 'grantId' | 'createdAt'>,
    // Round-8 #1: the declared action class is a consent LABEL, retained for
    // callers but NO LONGER trusted for the bounding decision below — the true
    // risk is derived from the catalog (or treated as high for a custom cap).
    _declaredActionClass: string,
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
    // Round-9 #1/#12: if an expiry is supplied it must be a REAL bound — a
    // finite integer Unix time in SECONDS, strictly in the future, and within
    // the policy window. Validated BEFORE the window/standing checks below so
    // an `expiresAt` can only count as "bounded" if it actually bounds. Without
    // this, `NaN` (NaN <= nowSec is always false → the grant never expires), a
    // millisecond value mistaken for seconds (~50,000× too large), or a
    // far-future timestamp would satisfy "bounded" while granting effectively
    // permanent silent authority.
    if (grant.expiresAt !== undefined) {
      const nowSec = Math.floor(nowMs / 1000);
      if (
        !Number.isInteger(grant.expiresAt) ||
        grant.expiresAt <= nowSec ||
        grant.expiresAt > nowSec + MAX_GRANT_WINDOW_SEC
      ) {
        throw new Error(
          'plugin_grants: expiresAt must be an integer Unix time in seconds, in the future, and within the policy window (§8)',
        );
      }
    }
    // A 'window' grant is time-bounded by DEFINITION — without an expiry
    // it is a standing grant in disguise (audit D8). Reject it.
    if (grant.grantType === 'window' && grant.expiresAt === undefined) {
      throw new Error('plugin_grants: a window grant must carry an expiry (§8)');
    }
    // Round-8 #1: a grant that authorizes SILENT repeated execution (a
    // 'standing' grant) may only be UNBOUNDED when the capability's low-risk
    // class is VERIFIED — i.e. it is a canonical CATALOG capability whose
    // action_class is not HIGH. A CUSTOM capability (publisher-declared class,
    // unverifiable — "a consent label, not proof", §8) or a HIGH catalog
    // capability must carry a bound (expiry / meaningful constraint); 'once' and
    // 'window' are bounded by their own rules above. This closes the "custom
    // capability declares read → unconstrained standing grant → runs silent"
    // hole. (Today every plugin id is custom under the reverse-DNS grammar, so
    // in practice all standing grants need a bound; the catalog exemption is the
    // forward-compatible path for when canonical ids become installable.)
    const catalog = getCatalogCapability(grant.capability);
    const verifiedLowRisk = catalog !== null && !HIGH_ACTION_CLASSES.has(catalog.action_class);
    if (grant.grantType === 'standing' && !verifiedLowRisk) {
      const bounded =
        grant.expiresAt !== undefined ||
        hasMeaningfulConstraint(parseConstraints(grant.constraints ?? null));
      if (!bounded) {
        throw new Error(
          'plugin_grants: a standing grant for a custom or high-class capability must be bounded (expiry / constraint) — a publisher-declared class is not proof (§8)',
        );
      }
    }
    const grantId = `plg_${bytesToHex(randomBytes(12))}`;
    // Round-11 #15: at most ONE live grant per scope key. Without this,
    // approving the same scope twice leaves two live grants; the owner
    // revoking "the grant" (the newest) leaves an OLDER one live, and
    // authorizeAndConsume's newest-first scan `continue`s past the revoked
    // row to silently re-authorize under the stale older grant. Tombstoning
    // prior same-scope live grants makes the new grant the sole authority
    // and a revoke of it actually terminal. Atomic with the insert so a
    // reader never sees zero live grants for a scope that has one.
    this.db.transaction(() => {
      const nowSec = Math.floor(nowMs / 1000);
      this.db.run(
        `UPDATE plugin_grants SET revoked_at = ?
         WHERE install_id = ? AND capability = ? AND approved_scope_hash = ?
           AND revoked_at IS NULL`,
        [nowSec, grant.installId, grant.capability, grant.approvedScopeHash],
      );
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
    });
    return grantId;
  }

  authorizeAndConsume(args: AuthorizeArgs): GrantCheckResult {
    let result: GrantCheckResult = { allowed: false, reason: 'no_grant' };
    // Round-11 #1: the constraint-relevant params this execution binds to.
    const digest = invocationDigest(args);
    this.db.transaction(() => {
      // PLG-29 #19: load only NON-REVOKED candidates. Every re-consent tombstones
      // the prior grant (revoked_at set), so revoked rows are the unbounded growth
      // vector — pulling the ENTIRE history into JS on every authorize made the
      // hot path scale with churn. `revoked_at IS NULL` is type-affinity SAFE (a
      // string revoked_at is not null → still excluded → fail CLOSED), unlike an
      // SQL `expires_at > ?` comparison which SQLite would read as live for a
      // TEXT-typed expires_at (Round-14 #9) — so the expires_at liveness check
      // stays in JS below. Only the 'revoked' denial reason needs the excluded
      // rows; it is recovered by a bounded probe on the no-live-grant path.
      const rows = this.db.query(
        `SELECT * FROM plugin_grants
         WHERE install_id = ? AND capability = ? AND approved_scope_hash = ?
           AND revoked_at IS NULL
         ORDER BY created_at DESC`,
        [args.installId, args.capability, args.approvedScopeHash],
      );
      // Evaluate candidates newest-first; the first live grant decides.
      let denial: GrantDenialReason = 'no_grant';
      for (const row of rows) {
        // Round-14 #9: coerce defensively — an expires_at stored as a STRING
        // (divergent-node restore, SQLite type affinity) slips past a bare
        // `typeof === 'number'` and the candidate reads as LIVE (fail OPEN). A
        // present non-finite expires_at is an unenforceable bound → treat as
        // expired. (revoked_at is now excluded in SQL, above.)
        if (row.expires_at !== null && row.expires_at !== undefined) {
          const exp = Number(row.expires_at);
          if (!Number.isFinite(exp) || exp <= args.nowSec) {
            denial = 'expired';
            continue;
          }
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
        // Round-15 #10: an unknown grant_type (schema drift / out-of-app write)
        // would fall through both the 'once' single-use check and the
        // constraints block and authorize EVERY invocation like an unlimited
        // standing grant. Fail closed — a grant we can't classify never
        // authorizes. (The DB CHECK is the primary guard; this is the backstop.)
        if (!VALID_GRANT_TYPE.has(grantType)) {
          denial = 'constraints_unparseable';
          continue;
        }

        // Idempotent re-authorization FIRST: the SAME execution_id
        // re-authorizes without a second consume (§8: lease-recovery
        // retries), even for a 'once' grant — BUT only when it replays the
        // SAME constraint-relevant params. Round-11 #1: the reservation
        // pinned an invocation_digest (resource + value) at first consume;
        // a replay carrying a different resource/value is a DISTINCT
        // invocation wearing the same execution_id to skip the resource/
        // value/count checks below. Re-bind to the pinned digest; a
        // mismatch denies (never falls through — this execution's use row
        // lives on THIS grant, so an older grant would double-spend it).
        const existingUse = this.db.query<{ invocation_digest: string | null }>(
          'SELECT invocation_digest FROM plugin_grant_uses WHERE grant_id = ? AND execution_id = ? LIMIT 1',
          [grantId, args.executionId],
        );
        if (existingUse.length > 0) {
          const pinned = existingUse[0].invocation_digest;
          // A null pin only exists for pre-Round-11 rows (none pre-launch);
          // treat it as unbindable and fail closed rather than trust it.
          if (pinned !== digest) {
            result = { allowed: false, reason: 'invocation_mismatch' };
            return;
          }
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
            // Round-7 #4: the value is caller-supplied. A NaN slips past
            // `value > max` (NaN comparisons are always false), DEFEATING the
            // cap; a negative value is likewise not a real transaction value. A
            // value-capped grant requires a FINITE, NON-NEGATIVE value within
            // the cap — anything else fails closed. (Pinning the value to the
            // validated invocation params remains the dispatch producer's job.)
            if (
              args.value === undefined ||
              !Number.isFinite(args.value) ||
              args.value < 0 ||
              args.value > constraints.max_value
            ) {
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
          'INSERT INTO plugin_grant_uses (grant_id, execution_id, used_at, invocation_digest) VALUES (?,?,?,?)',
          [grantId, args.executionId, args.nowSec, digest],
        );
        result = { allowed: true, grantId };
        return;
      }
      // PLG-29 #19: `denial` stays 'no_grant' only when the non-revoked query
      // returned zero rows AND set no live-candidate reason (count_exhausted /
      // resource_not_allowed / …). Distinguish "a grant existed but was revoked"
      // from "no grant ever" with ONE bounded existence probe — kept off the hot
      // (authorize / live-deny) path so grant churn no longer costs the caller.
      if (denial === 'no_grant') {
        const revoked = this.db.query(
          `SELECT 1 FROM plugin_grants
           WHERE install_id = ? AND capability = ? AND approved_scope_hash = ?
             AND revoked_at IS NOT NULL
           LIMIT 1`,
          [args.installId, args.capability, args.approvedScopeHash],
        );
        if (revoked.length > 0) denial = 'revoked';
      }
      result = { allowed: false, reason: denial };
    });
    return result;
  }

  releaseUse(grantId: string, executionId: string): boolean {
    const affected = this.db.run(
      'DELETE FROM plugin_grant_uses WHERE grant_id = ? AND execution_id = ?',
      [grantId, executionId],
    );
    return affected > 0;
  }

  getUse(grantId: string, executionId: string): { invocationDigest: string | null } | null {
    const rows = this.db.query<{ invocation_digest: string | null }>(
      'SELECT invocation_digest FROM plugin_grant_uses WHERE grant_id = ? AND execution_id = ? LIMIT 1',
      [grantId, executionId],
    );
    if (rows.length === 0) return null;
    const d = rows[0].invocation_digest;
    return { invocationDigest: d === null || d === undefined ? null : String(d) };
  }

  hasLiveGrant(
    installId: string,
    capability: string,
    approvedScopeHash: string,
    nowSec: number,
  ): boolean {
    // Mirror the liveness test in authorizeAndConsume's candidate scan: a
    // grant counts as live when it is unrevoked and either has no expiry or
    // an expiry strictly in the future. Constraint state is intentionally
    // NOT considered — this only answers "is there still an approval for
    // this scope," not "would this specific invocation pass."
    const rows = this.db.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM plugin_grants
       WHERE install_id = ? AND capability = ? AND approved_scope_hash = ?
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > ?)`,
      [installId, capability, approvedScopeHash, nowSec],
    );
    return rows.length > 0 && Number(rows[0].c) > 0;
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
