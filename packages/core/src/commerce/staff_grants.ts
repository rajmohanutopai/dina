/**
 * Staff grants + the §6.5 threshold gate (TRADE_FIRST_STRATEGY §6).
 *
 * A staff member is a paired device (role 'staff', its own caller type,
 * fail-closed everywhere) acting under a value-capped, install-scoped,
 * owner-created grant. The gate is DETERMINISTIC, COMPILED, NO LLM —
 * the `requireAgentPersonaAccess` shape:
 *
 *   grant exists for (device, scope, install role)   else refuse
 *   scope defines NO cap basis (commerce_confirm)    → allow
 *   currency equals the grant currency               else escalate
 *   value ≤ max_order_minor_units                    else escalate
 *
 * `escalate` means the CALLER creates an owner approval task (Pattern A)
 * — this module only renders the verdict; it performs nothing.
 *
 * The cap basis is decided PER SCOPE because two of the three
 * operations carry no order total: `commerce_confirm` is the pre-quote
 * vouch ceremony (no money exists yet; money control lives at submit,
 * which every confirmed draft must still pass), and
 * `commerce_receive_goods` prices the receipt from the bound quote —
 * a value the CALLER computes and passes, since the chain
 * receipt → note → order → quote makes it computable.
 */

import { moneyMinorUnits, validateMoney, type Money } from '@dina/commerce-protocol';

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

export const STAFF_SCOPES = [
  'commerce_confirm',
  'commerce_submit',
  'commerce_receive_goods',
] as const;
export type StaffScope = (typeof STAFF_SCOPES)[number];

export const STAFF_INSTALL_SCOPES = ['buyer', 'supplier', 'both'] as const;
export type StaffInstallScope = (typeof STAFF_INSTALL_SCOPES)[number];

/** Which scopes compare a money value against the grant's cap. */
const CAPPED_SCOPES: ReadonlySet<StaffScope> = new Set([
  'commerce_submit',
  'commerce_receive_goods',
]);

export interface StaffGrant {
  deviceDid: string;
  scope: StaffScope;
  /** '' on uncapped scopes; canonical minor-unit integer otherwise. */
  maxOrderMinorUnits: string;
  /** '' on uncapped scopes; ISO 4217 otherwise. */
  currency: string;
  installs: StaffInstallScope;
  createdAt: number;
  revokedAt: number | null;
}

export interface StaffGrantRepository {
  /** Owner-created; replaces a prior grant for (device, scope). */
  put(grant: StaffGrant): void;
  get(deviceDid: string, scope: StaffScope): StaffGrant | null;
  listByDevice(deviceDid: string): StaffGrant[];
  /** Stamp every grant of a device revoked — device revocation calls this. */
  revokeDevice(deviceDid: string, atMs: number): void;
}

export class SQLiteStaffGrantRepository implements StaffGrantRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  put(grant: StaffGrant): void {
    this.db.run(
      `INSERT OR REPLACE INTO commerce_staff_grants
         (device_did, scope, max_order_minor_units, currency, installs, created_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        grant.deviceDid,
        grant.scope,
        grant.maxOrderMinorUnits,
        grant.currency,
        grant.installs,
        grant.createdAt,
        grant.revokedAt,
      ],
    );
  }

  get(deviceDid: string, scope: StaffScope): StaffGrant | null {
    const rows = this.db.query(
      `SELECT * FROM commerce_staff_grants WHERE device_did = ? AND scope = ?`,
      [deviceDid, scope],
    );
    return rows[0] === undefined ? null : grantFromRow(rows[0]);
  }

  listByDevice(deviceDid: string): StaffGrant[] {
    return this.db
      .query(`SELECT * FROM commerce_staff_grants WHERE device_did = ? ORDER BY scope`, [deviceDid])
      .map(grantFromRow);
  }

  revokeDevice(deviceDid: string, atMs: number): void {
    this.db.run(
      `UPDATE commerce_staff_grants SET revoked_at = ? WHERE device_did = ? AND revoked_at IS NULL`,
      [atMs, deviceDid],
    );
  }
}

function grantFromRow(row: DBRow): StaffGrant {
  return {
    deviceDid: String(row.device_did),
    scope: String(row.scope) as StaffScope,
    maxOrderMinorUnits: String(row.max_order_minor_units),
    currency: String(row.currency),
    installs: String(row.installs) as StaffInstallScope,
    createdAt: Number(row.created_at),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
  };
}

/** Test double. A production caller would be the bug. */
export class InMemoryStaffGrantRepository implements StaffGrantRepository {
  private readonly rows = new Map<string, StaffGrant>();

  private key(deviceDid: string, scope: StaffScope): string {
    return `${deviceDid} ${scope}`;
  }

  put(grant: StaffGrant): void {
    this.rows.set(this.key(grant.deviceDid, grant.scope), { ...grant });
  }

  get(deviceDid: string, scope: StaffScope): StaffGrant | null {
    const grant = this.rows.get(this.key(deviceDid, scope));
    return grant === undefined ? null : { ...grant };
  }

  listByDevice(deviceDid: string): StaffGrant[] {
    return [...this.rows.values()]
      .filter((g) => g.deviceDid === deviceDid)
      .sort((a, b) => a.scope.localeCompare(b.scope))
      .map((g) => ({ ...g }));
  }

  revokeDevice(deviceDid: string, atMs: number): void {
    for (const [key, grant] of this.rows) {
      if (grant.deviceDid === deviceDid && grant.revokedAt === null) {
        this.rows.set(key, { ...grant, revokedAt: atMs });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Grant validation (owner ceremony input)
// ---------------------------------------------------------------------------

/** Refuse a malformed grant BEFORE it is stored — never default. */
export function validateStaffGrantInput(args: {
  scope: StaffScope;
  installs: StaffInstallScope;
  maxOrderMinorUnits?: string;
  currency?: string;
}): string | null {
  if (!STAFF_SCOPES.includes(args.scope)) return 'staffGrant: unknown scope';
  if (!STAFF_INSTALL_SCOPES.includes(args.installs)) return 'staffGrant: unknown install scope';
  if (CAPPED_SCOPES.has(args.scope)) {
    if (args.maxOrderMinorUnits === undefined || args.currency === undefined) {
      return 'staffGrant: a capped scope requires max_order_minor_units and currency';
    }
    const shaped: Money = { currency: args.currency, minor_units: args.maxOrderMinorUnits };
    const moneyError = validateMoney(shaped);
    if (moneyError) return `staffGrant: ${moneyError}`;
  } else if (args.maxOrderMinorUnits !== undefined || args.currency !== undefined) {
    return 'staffGrant: commerce_confirm carries no cap — money control lives at submit';
  }
  return null;
}

// ---------------------------------------------------------------------------
// The gate (§6.5)
// ---------------------------------------------------------------------------

export type StaffGateVerdict =
  | { verdict: 'allow' }
  | { verdict: 'refuse'; reason: string }
  /** Above the cap or off-currency: the CALLER opens an owner approval. */
  | { verdict: 'escalate'; reason: string };

export function checkStaffOperation(args: {
  repository: StaffGrantRepository;
  deviceDid: string;
  scope: StaffScope;
  /** The operation's install role, derived from STORED state by the route. */
  installRole: 'buyer' | 'supplier';
  /** The cap basis for capped scopes; undefined for commerce_confirm. */
  value?: Money;
}): StaffGateVerdict {
  const grant = args.repository.get(args.deviceDid, args.scope);
  if (grant === null || grant.revokedAt !== null) {
    return { verdict: 'refuse', reason: 'no live staff grant for this scope' };
  }
  if (grant.installs !== 'both' && grant.installs !== args.installRole) {
    return { verdict: 'refuse', reason: `grant covers ${grant.installs}, operation is ${args.installRole}` };
  }
  if (!CAPPED_SCOPES.has(args.scope)) {
    return { verdict: 'allow' };
  }
  if (args.value === undefined) {
    // A capped operation whose caller could not compute a value is not
    // allowed to slip under the cap by omission.
    return { verdict: 'escalate', reason: 'no computable value for a capped scope' };
  }
  const valueError = validateMoney(args.value);
  if (valueError) return { verdict: 'refuse', reason: valueError };
  if (args.value.currency !== grant.currency) {
    // Minor units across currencies never compare (§6.5).
    return { verdict: 'escalate', reason: 'value currency differs from the grant currency' };
  }
  if (moneyMinorUnits(args.value) > BigInt(grant.maxOrderMinorUnits)) {
    return { verdict: 'escalate', reason: 'value exceeds the grant cap' };
  }
  return { verdict: 'allow' };
}
