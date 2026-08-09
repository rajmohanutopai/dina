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
  /**
   * §9.13 — the protocol version the PRIOR manifest declared.
   *
   * A row said WHICH CID was authorized and nothing about which CONTRACT it
   * speaks, so a lifecycle continuation across a major dispatched to the
   * current adapter and the runner could not tell it was answering for an
   * older major. Empty string for rows written before this existed, which
   * reads as "unknown" rather than as any particular version.
   */
  priorVersion: string;
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
  /**
   * Every live LIFECYCLE-CONTINUITY lane, across installs (§9.13).
   *
   * Continuity entries carry no expiry — no clock knows when an order ends —
   * so nothing retires them but an explicit release, and until now nothing
   * could even enumerate the candidates. The lanes accumulated: one per
   * capability per update, held by CIDs that stopped serving anything long
   * ago.
   */
  listLiveContinuity(
    nowMs: number,
  ): { installId: string; previousCid: string; capabilityId: string }[];
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
    priorVersion: String(row.prior_version ?? ''),
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
         params_schema_json, max_context_items, prior_version, expires_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        authorization.priorVersion,
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

  listLiveContinuity(
    nowMs: number,
  ): { installId: string; previousCid: string; capabilityId: string }[] {
    return this.db
      .query(
        `SELECT DISTINCT install_id, previous_cid, capability_id
           FROM plugin_drain_authorizations
          WHERE kind = 'lifecycle_continuity'
            AND (expires_at IS NULL OR expires_at > ?)
          ORDER BY install_id, previous_cid, capability_id`,
        [nowMs],
      )
      .map((row) => ({
        installId: String(row.install_id),
        previousCid: String(row.previous_cid),
        capabilityId: String(row.capability_id),
      }));
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

  listLiveContinuity(
    nowMs: number,
  ): { installId: string; previousCid: string; capabilityId: string }[] {
    const seen = new Set<string>();
    const out: { installId: string; previousCid: string; capabilityId: string }[] = [];
    for (const e of this.rows.values()) {
      if (e.kind !== 'lifecycle_continuity') continue;
      if (e.expiresAt !== null && e.expiresAt <= nowMs) continue;
      const key = `${e.installId}\u0000${e.previousCid}\u0000${e.capabilityId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        installId: e.installId,
        previousCid: e.previousCid,
        capabilityId: e.capabilityId,
      });
    }
    return out.sort((a, b) =>
      `${a.installId}${a.previousCid}${a.capabilityId}`.localeCompare(
        `${b.installId}${b.previousCid}${b.capabilityId}`,
      ),
    );
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
