/**
 * Drain authorizations (COMMERCE_PROCUREMENT_PLUGIN_ARCHITECTURE.md
 * §9.13): the ONLY path by which the claim guard admits a task whose
 * envelope pins a manifest CID the install no longer runs.
 *
 * A same-major plugin update performs an atomic rebind (new manifest
 * CID); the claim guard rejects stale CIDs by default. Two authorized
 * exceptions, each a bounded row here:
 *
 *   - 'drain': tasks ALREADY CREATED under the previous CID complete
 *     against their pinned schemas until the drain deadline;
 *   - 'lifecycle_continuity': NEW lifecycle tasks (order_status,
 *     order_reconcile, cancel_order) bound to non-terminal prior-major
 *     orders keep flowing to the retained handler set until the last
 *     such order is terminal (the commerce pack manages these rows'
 *     lifecycle; the guard just honors them).
 *
 * Each row pins the AUTHORIZED prior capability values (scope hash,
 * config revision, action class, retry contract, result schema) so the
 * guard validates a prior-CID envelope against what the owner had
 * consented to under that CID — the current manifest cannot vouch for
 * it. Rows are live authority: never exported, revoked with the
 * install.
 */

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

export type DrainAuthorizationKind = 'drain' | 'lifecycle_continuity';

export interface DrainAuthorization {
  installId: string;
  previousCid: string;
  capabilityId: string;
  kind: DrainAuthorizationKind;
  approvedScopeHash: string;
  configRevision: number;
  actionClass: string;
  effectsIdempotency: 'supported' | 'unsupported';
  /** JSON of the prior capability's result schema ('null' when none). */
  resultSchemaJson: string;
  /** JSON of the prior capability's params schema ('null' when none) —
   *  drained tasks are judged against the PRIOR contract, never the
   *  current manifest's. */
  paramsSchemaJson: string;
  /** Prior data_scope.max_context_items (null = unbounded default). */
  maxContextItems: number | null;
  /** Epoch ms; null = until explicitly released (lifecycle continuity). */
  expiresAt: number | null;
  createdAt: number;
}

export interface DrainAuthorizationRepository {
  /** First-writer-wins per (install, cid, capability, kind). */
  put(authorization: DrainAuthorization): boolean;
  /**
   * ALL live (unexpired) entries for the tuple. Both kinds can be live
   * at once after a rebind — a `drain` entry covering in-flight tasks
   * and a `lifecycle_continuity` entry admitting NEW prior-major
   * lifecycle work (§9.13). Returning only one would let the drain
   * entry's pre-rebind rule mask the continuity entry and terminalize
   * exactly the tasks the spec says must keep flowing.
   */
  listLive(
    installId: string,
    previousCid: string,
    capabilityId: string,
    nowMs: number,
  ): DrainAuthorization[];
  /** Release lifecycle-continuity entries once orders are terminal. */
  release(
    installId: string,
    previousCid: string,
    capabilityId: string,
    kind: DrainAuthorizationKind,
  ): boolean;
  /** Revocation cleanup: drop every entry for an install. */
  removeByInstall(installId: string): number;
}

function rowToAuthorization(row: DBRow): DrainAuthorization {
  return {
    installId: String(row.install_id),
    previousCid: String(row.previous_cid),
    capabilityId: String(row.capability_id),
    kind: String(row.kind) as DrainAuthorizationKind,
    approvedScopeHash: String(row.approved_scope_hash),
    configRevision: Number(row.config_revision),
    actionClass: String(row.action_class),
    effectsIdempotency: String(row.effects_idempotency) as 'supported' | 'unsupported',
    resultSchemaJson: String(row.result_schema_json),
    paramsSchemaJson: String(row.params_schema_json),
    maxContextItems: row.max_context_items === null ? null : Number(row.max_context_items),
    expiresAt: row.expires_at === null ? null : Number(row.expires_at),
    createdAt: Number(row.created_at),
  };
}

export class SQLiteDrainAuthorizationRepository implements DrainAuthorizationRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  put(authorization: DrainAuthorization): boolean {
    const affected = this.db.run(
      `INSERT INTO plugin_drain_authorizations (
         install_id, previous_cid, capability_id, kind, approved_scope_hash,
         config_revision, action_class, effects_idempotency, result_schema_json,
         params_schema_json, max_context_items, expires_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(install_id, previous_cid, capability_id, kind) DO NOTHING`,
      [
        authorization.installId,
        authorization.previousCid,
        authorization.capabilityId,
        authorization.kind,
        authorization.approvedScopeHash,
        authorization.configRevision,
        authorization.actionClass,
        authorization.effectsIdempotency,
        authorization.resultSchemaJson,
        authorization.paramsSchemaJson,
        authorization.maxContextItems,
        authorization.expiresAt,
        authorization.createdAt,
      ],
    );
    return affected > 0;
  }

  listLive(
    installId: string,
    previousCid: string,
    capabilityId: string,
    nowMs: number,
  ): DrainAuthorization[] {
    return this.db
      .query(
        `SELECT * FROM plugin_drain_authorizations
         WHERE install_id = ? AND previous_cid = ? AND capability_id = ?
           AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY kind`,
        [installId, previousCid, capabilityId, nowMs],
      )
      .map(rowToAuthorization);
  }

  release(
    installId: string,
    previousCid: string,
    capabilityId: string,
    kind: DrainAuthorizationKind,
  ): boolean {
    const affected = this.db.run(
      `DELETE FROM plugin_drain_authorizations
       WHERE install_id = ? AND previous_cid = ? AND capability_id = ? AND kind = ?`,
      [installId, previousCid, capabilityId, kind],
    );
    return affected > 0;
  }

  removeByInstall(installId: string): number {
    return this.db.run(`DELETE FROM plugin_drain_authorizations WHERE install_id = ?`, [installId]);
  }
}

export class InMemoryDrainAuthorizationRepository implements DrainAuthorizationRepository {
  private readonly rows = new Map<string, DrainAuthorization>();

  private key(installId: string, cid: string, capabilityId: string, kind: string): string {
    return `${installId} ${cid} ${capabilityId} ${kind}`;
  }

  put(authorization: DrainAuthorization): boolean {
    const key = this.key(
      authorization.installId,
      authorization.previousCid,
      authorization.capabilityId,
      authorization.kind,
    );
    if (this.rows.has(key)) return false;
    this.rows.set(key, { ...authorization });
    return true;
  }

  listLive(
    installId: string,
    previousCid: string,
    capabilityId: string,
    nowMs: number,
  ): DrainAuthorization[] {
    const live: DrainAuthorization[] = [];
    for (const kind of ['drain', 'lifecycle_continuity'] as const) {
      const row = this.rows.get(this.key(installId, previousCid, capabilityId, kind));
      if (row && (row.expiresAt === null || row.expiresAt > nowMs)) live.push({ ...row });
    }
    return live;
  }

  release(
    installId: string,
    previousCid: string,
    capabilityId: string,
    kind: DrainAuthorizationKind,
  ): boolean {
    return this.rows.delete(this.key(installId, previousCid, capabilityId, kind));
  }

  removeByInstall(installId: string): number {
    let removed = 0;
    for (const key of [...this.rows.keys()]) {
      if (key.startsWith(`${installId} `)) {
        this.rows.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}

let repository: DrainAuthorizationRepository | null = null;

export function setDrainAuthorizationRepository(repo: DrainAuthorizationRepository | null): void {
  repository = repo;
}

export function getDrainAuthorizationRepository(): DrainAuthorizationRepository | null {
  return repository;
}
