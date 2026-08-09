/**
 * The phone's commerce background plane (§9.9 step 3, §16.2, §12.7).
 *
 * The server gets these ticks from its boot; the phone got none of them,
 * because the shared workflow plane that used to start the admission sweep is
 * server-only and the epoch service was never constructed here at all. On a
 * phone that meant: no abandoned reservation ever timed out (its quote
 * capacity was held for ever and the buyer was answered `received_processing`
 * for ever), and `currentEpoch()` threw on every commerce operation because
 * nothing had ever established an epoch.
 *
 * The mobile app is the product, so both were real gaps rather than staging
 * decisions.
 *
 * WHY A MODULE GLOBAL. The plane's lifetime is the identity's, not a React
 * component's: it starts when storage and identity are both up and must stop
 * when the identity is torn down, which happens in `teardownStorage` far from
 * the boot that started it. Every other Tier-0 singleton in that teardown is
 * reached the same way.
 */

import {
  getUpdateRebindCoordinator,
  getDrainAuthorizationRepository,
  startCommerceSweepers,
  getCommerceRuntime,
  getCommerceEpochService,
  getCommerceServiceQueryDispatch,
  installCatalogRecordReader,
  installCatalogRecordWriter,
  makeServiceQueryReconcileSend,
} from '@dina/core';
import { makeCatalogRepoAccess, wireCommerceEpoch } from '@dina/home-node';

import type { CommerceSweepers } from '@dina/core';
import type { DatabaseAdapter } from '@dina/core/storage';
import type { EpochRepoClient } from '@dina/home-node';

let sweepers: CommerceSweepers | null = null;

export interface MobileCommercePlaneOptions {
  /** Tier-0 adapter — the restore-fence marker and the fence's own writes. */
  adapter: DatabaseAdapter;
  /** This node's own repo client; absent on a node with no PDS session. */
  pds: EpochRepoClient | undefined;
  /** The acting Business DID. */
  businessDid: string;
  /** The ONE Tier-0 transaction runner. */
  tx: (fn: () => void) => void;
  log: (entry: Record<string, unknown>) => void;
  /**
   * Injectable timer pair. Production omits it and gets the built-ins; a test
   * that could not observe the timers could not tell a plane that started its
   * ticks from one that started nothing.
   */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

/**
 * Establish the epoch (when this node has a repo) and start the ticks.
 *
 * A node with no PDS has no repo to publish an epoch to, so commerce simply
 * stays disabled there — but the ADMISSION tick still starts, because
 * reservations recorded while commerce was live must still time out and
 * refund even after the repo becomes unreachable.
 */
export async function startMobileCommercePlane(options: MobileCommercePlaneOptions): Promise<void> {
  // Idempotent: a second boot in the same JS process (identity switch, warm
  // restart) must not leave the previous pair of timers running.
  stopMobileCommercePlane();

  const runtime = getCommerceRuntime();
  if (runtime === null) return;

  if (options.pds !== undefined) {
    await wireCommerceEpoch({
      pds: options.pds,
      businessDid: options.businessDid,
      tx: options.tx,
      families: runtime.families,
      receipts: runtime.receipts,
      adapter: options.adapter,
      logger: {
        info: (o, m) => options.log({ event: 'commerce.epoch', message: m, ...asObject(o) }),
        warn: (o, m) => options.log({ event: 'commerce.epoch_warn', message: m, ...asObject(o) }),
      },
    }).establish();
    // §10.2 — CATALOG PUBLICATION, on the phone too.
    //
    // Only the server installed these, so `POST /v1/commerce/catalog/publish`
    // and `/withdraw` refused `no_record_writer` on a deployment that ships a
    // PDS session and already publishes its restore epoch through this very
    // client. The §10.3 reasoning that keeps a phone from FETCHING a
    // supplier's feed does not apply: this is a write to the node's OWN repo,
    // not an outbound connection whose address the phone cannot report.
    const catalogRepo = makeCatalogRepoAccess({
      pds: options.pds,
      ownerDid: options.businessDid,
    });
    installCatalogRecordWriter(catalogRepo.writer);
    installCatalogRecordReader(catalogRepo.reader);
  } else {
    options.log({ event: 'commerce.epoch_skipped', reason: 'no_pds_repo' });
  }

  sweepers = startCommerceSweepers({
    ...(options.setInterval !== undefined ? { setInterval: options.setInterval } : {}),
    ...(options.clearInterval !== undefined ? { clearInterval: options.clearInterval } : {}),
    admission: {
      engine: () => getCommerceRuntime()?.admission ?? null,
      onTimedOut: (purchaseOrderId) =>
        options.log({ event: 'commerce.admission_timed_out', purchaseOrderId }),
      // A stuck reservation is NOT an error and must not be reported as one:
      // the sweep succeeded and found a row it cannot decide.
      onStuck: (skip) =>
        options.log({
          event: 'commerce.admission_stuck',
          purchaseOrderId: skip.purchaseOrderId,
          reason: skip.reason,
        }),
      onError: (err) =>
        options.log({ event: 'commerce.admission_sweep_error', error: String(err) }),
    },
    epoch: {
      service: () => getCommerceEpochService(),
      onOutcome: (outcome) => {
        if (outcome.kind === 'current') return;
        // Anything else means this node's right to sign is in question, and
        // this line is the only place the owner can learn it before a
        // counterparty tells them.
        options.log({ event: 'commerce.epoch_revalidation', ...outcome });
      },
      onError: (err) =>
        options.log({ event: 'commerce.epoch_revalidation_error', error: String(err) }),
    },
    // §9.13 — retire a prior manifest's lifecycle lane once its last order
    // is finished. Continuity authorizations carry no expiry, so without
    // this every update leaves another one behind holding authority for
    // ever. `releaseContinuity` re-reads the count and refuses while work
    // remains, so this sweep can only ever be LATE, never early.
    continuity: {
      intervalMs: 15 * 60 * 1000,
      releasable: () => getDrainAuthorizationRepository()?.listLiveContinuity(Date.now()) ?? [],
      release: (installId, previousCid, capabilityId) =>
        getUpdateRebindCoordinator()?.releaseContinuity(installId, previousCid, capabilityId) ?? {
          released: false,
          openOrders: 0,
        },
    },
    reconcile: {
      // §12.7 — ask a supplier again about an order whose outcome this node
      // does not know. Resolved per tick, never captured: the outbound lane is
      // installed after storage and torn down on an identity switch, and a tick
      // holding the previous identity's sender would ask that identity's
      // suppliers about this one's orders.
      send: () => {
        const dispatch = getCommerceServiceQueryDispatch();
        return dispatch === null ? null : makeServiceQueryReconcileSend({ dispatch });
      },
      onSweep: (result) => options.log({ event: 'commerce.reconcile_sweep', ...result }),
      onError: (err) =>
        options.log({ event: 'commerce.reconcile_sweep_error', error: String(err) }),
    },
  });
}

/** Stop the ticks. Idempotent, so a teardown that runs twice is harmless. */
export function stopMobileCommercePlane(): void {
  sweepers?.stop();
  sweepers = null;
  // CLEARED with the ticks. Both are bound to the identity's repo session, and
  // a writer left installed across an identity switch would publish the new
  // owner's catalog into the previous owner's repo — the exact failure the
  // per-write identity check exists to catch, arriving from our own boot.
  installCatalogRecordWriter(null);
  installCatalogRecordReader(null);
}

/** Spread a logger's structured argument without assuming its shape. */
function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}
