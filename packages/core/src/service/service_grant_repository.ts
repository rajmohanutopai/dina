/**
 * Provider-side service-grant repository (`service_grants`, migration v10).
 *
 * A grant is the AUTHORITY that lets a specific grantee invoke a specific
 * listing's capability. It is the source of truth checked at ingress — NOT
 * contact membership, NOT `service_uri` possession. The `grant_id` is a wire
 * SELECTOR (echoed on `service.offer` / `service.query`), never a secret:
 * authorization is `grant_id` AND the transport-authenticated caller DID.
 *
 * Independent of discoverability: V1 enforces grants for `known_only` listings,
 * but the table is general so a public/unlisted listing can require one later.
 * V1 ships only `grant_type='standing'` (valid until expiry/revoke); mutable
 * usage state for quota/one_time is a future `service_grant_usage` table.
 *
 * **Sync-by-design** — same rationale as `ContactRepository`.
 */

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

export interface ServiceGrant {
  /** PK + wire selector. NOT a secret (auth = grant_id + authenticated DID). */
  grantId: string;
  /** Who may invoke — compared to `authenticatedFromDID` at ingress. */
  granteeDid: string;
  /** Which listing (the `service_uri` rkey). */
  serviceRkey: string;
  /** Which capability (canonical or namespaced custom NSID). */
  capability: string;
  /** V1: 'standing'. Discriminator for future types (quota/one_time/role/…). */
  grantType: string;
  /** V1: undefined. The future per-type extension surface. */
  constraints?: unknown;
  /** Optional expiry (unix seconds). */
  expiresAt?: number;
  /** Set to revoke; execution denies thereafter. */
  revokedAt?: number;
  createdAt: number;
}

export interface ServiceGrantRepository {
  /** Insert (or replace by grant_id) a grant. */
  create(grant: ServiceGrant): void;
  /** Read a grant by id, or null. */
  getById(grantId: string): ServiceGrant | null;
  /**
   * THE authorization primitive. True iff an ACTIVE grant (not revoked, not
   * expired at `nowSec`) authorizes `(granteeDid, serviceRkey, capability)`.
   * When `grantId` is given it must also match — pinning the exact grant the
   * requester echoed. Callers MUST pass the transport-authenticated caller DID
   * as `granteeDid` (never an inner-body field).
   */
  isAuthorized(args: {
    granteeDid: string;
    serviceRkey: string;
    capability: string;
    grantId?: string;
    nowSec: number;
  }): boolean;
  /** All grants issued to a grantee (newest first). */
  listByGrantee(granteeDid: string): ServiceGrant[];
  /** Revoke a grant. Returns true if a row was updated. */
  revoke(grantId: string, nowSec: number): boolean;
}

/** Singleton repository (null = not wired). */
let repo: ServiceGrantRepository | null = null;
export function setServiceGrantRepository(r: ServiceGrantRepository | null): void {
  repo = r;
}
export function getServiceGrantRepository(): ServiceGrantRepository | null {
  return repo;
}

function numOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function rowToGrant(r: DBRow): ServiceGrant {
  let constraints: unknown;
  if (typeof r.constraints_json === 'string' && r.constraints_json !== '') {
    try {
      constraints = JSON.parse(r.constraints_json);
    } catch {
      constraints = undefined;
    }
  }
  return {
    grantId: String(r.grant_id),
    granteeDid: String(r.grantee_did),
    serviceRkey: String(r.service_rkey),
    capability: String(r.capability),
    grantType: typeof r.grant_type === 'string' ? r.grant_type : 'standing',
    ...(constraints !== undefined ? { constraints } : {}),
    expiresAt: numOrUndef(r.expires_at),
    revokedAt: numOrUndef(r.revoked_at),
    createdAt: Number(r.created_at),
  };
}

export class SQLiteServiceGrantRepository implements ServiceGrantRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  create(grant: ServiceGrant): void {
    if (grant.grantId === '') throw new Error('service_grants.repository: grantId is required');
    if (grant.granteeDid === '')
      throw new Error('service_grants.repository: granteeDid is required');
    this.db.execute(
      `INSERT INTO service_grants
         (grant_id, grantee_did, service_rkey, capability, grant_type,
          constraints_json, expires_at, revoked_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(grant_id) DO UPDATE SET
         grantee_did = excluded.grantee_did,
         service_rkey = excluded.service_rkey,
         capability = excluded.capability,
         grant_type = excluded.grant_type,
         constraints_json = excluded.constraints_json,
         expires_at = excluded.expires_at,
         revoked_at = excluded.revoked_at`,
      [
        grant.grantId,
        grant.granteeDid,
        grant.serviceRkey,
        grant.capability,
        grant.grantType,
        grant.constraints !== undefined ? JSON.stringify(grant.constraints) : null,
        grant.expiresAt ?? null,
        grant.revokedAt ?? null,
        grant.createdAt,
      ],
    );
  }

  getById(grantId: string): ServiceGrant | null {
    const rows = this.db.query('SELECT * FROM service_grants WHERE grant_id = ?', [grantId]);
    return rows.length === 0 ? null : rowToGrant(rows[0]);
  }

  isAuthorized(args: {
    granteeDid: string;
    serviceRkey: string;
    capability: string;
    grantId?: string;
    nowSec: number;
  }): boolean {
    if (args.granteeDid === '') return false;
    const params: unknown[] = [
      args.granteeDid,
      args.serviceRkey,
      args.capability,
      args.nowSec,
    ];
    let sql =
      `SELECT 1 FROM service_grants
       WHERE grantee_did = ? AND service_rkey = ? AND capability = ?
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > ?)`;
    if (args.grantId !== undefined && args.grantId !== '') {
      sql += ' AND grant_id = ?';
      params.push(args.grantId);
    }
    return this.db.query(sql + ' LIMIT 1', params).length > 0;
  }

  listByGrantee(granteeDid: string): ServiceGrant[] {
    const rows = this.db.query(
      'SELECT * FROM service_grants WHERE grantee_did = ? ORDER BY created_at DESC',
      [granteeDid],
    );
    return rows.map(rowToGrant);
  }

  revoke(grantId: string, nowSec: number): boolean {
    const before = this.db.query(
      'SELECT 1 FROM service_grants WHERE grant_id = ? AND revoked_at IS NULL',
      [grantId],
    );
    if (before.length === 0) return false;
    this.db.execute('UPDATE service_grants SET revoked_at = ? WHERE grant_id = ?', [
      nowSec,
      grantId,
    ]);
    return true;
  }
}
