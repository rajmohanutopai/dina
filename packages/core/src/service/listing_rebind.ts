/**
 * Listing rebind on plugin update (§9.13 / §16.5, WS-3.7).
 *
 * A published listing pins the exact `(install_id, manifest CID, capability)`
 * triple it was validated against. When the install adopts a new CID, every
 * listing still naming the old one is unanswerable — ingress compares the
 * pinned CID to the running one and refuses. So the rebind is not bookkeeping;
 * it is what keeps the supplier on the market across an update.
 *
 * WHY THIS IS SYNCHRONOUS. `service_configs` lives in the Tier-0 database
 * alongside `plugin_installs`, so the rewrite can share the install's
 * transaction and the pair genuinely commits together. An async rebind could
 * not: the CID swap would be durable while the listings were still in flight.
 *
 * WHY THE IN-MEMORY CACHE IS UPDATED SEPARATELY. `service_config` answers
 * reads from a process-local map. Updating that map inside a transaction that
 * can still roll back would leave the process serving a binding the database
 * does not have — which is the same class of split-brain the transaction
 * exists to prevent, just in the other direction. So the rewrite returns a
 * committer and the caller runs it after the commit.
 */

import { adoptServiceConfigInMemory } from './service_config';

import type { ServiceConfig } from './service_config';
import type { DatabaseAdapter } from '../storage/db_adapter';

export interface ListingRebindResult {
  /** rkeys whose stored JSON changed. */
  rebound: string[];
  /**
   * Publish the rewritten configs to the in-memory cache. Call ONLY after the
   * enclosing transaction commits; a no-op if nothing changed.
   */
  commit: () => void;
}

/**
 * Rewrite every capability binding on `installId` that pins `fromCid` to
 * `toCid`, across all listings.
 *
 * Only the CID moves. The install id and capability id are untouched: an
 * update replaces the manifest a capability is served from, never which
 * capability a listing offers. A rebind that changed those would silently
 * repoint a published listing at different functionality.
 */
export function rebindListingsForUpdate(
  db: DatabaseAdapter,
  args: { installId: string; fromCid: string; toCid: string },
): ListingRebindResult {
  const rows = db.query<{ rkey: string; config_json: string }>(
    'SELECT rkey, config_json FROM service_configs',
  );
  const rebound: string[] = [];
  const staged: { rkey: string; config: ServiceConfig }[] = [];

  for (const row of rows) {
    let config: ServiceConfig;
    try {
      config = JSON.parse(row.config_json) as ServiceConfig;
    } catch {
      // A row that will not parse cannot be rebound, and rewriting it from
      // scratch here would invent a listing the owner never authored. Leave it;
      // hydration already skips it and a subsequent save replaces it.
      continue;
    }
    const capabilities = config.capabilities ?? {};
    let changed = false;
    for (const cap of Object.values(capabilities)) {
      if (cap.pluginInstallId !== args.installId) continue;
      if (cap.pluginManifestCid !== args.fromCid) continue;
      cap.pluginManifestCid = args.toCid;
      changed = true;
    }
    if (!changed) continue;
    db.execute('UPDATE service_configs SET config_json = ? WHERE rkey = ?', [
      JSON.stringify(config),
      row.rkey,
    ]);
    rebound.push(row.rkey);
    staged.push({ rkey: row.rkey, config });
  }

  return {
    rebound,
    commit: () => {
      for (const entry of staged) adoptServiceConfigInMemory(entry.rkey, entry.config);
    },
  };
}
