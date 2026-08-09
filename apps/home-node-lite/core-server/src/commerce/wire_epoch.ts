/**
 * The server's epoch repo: a `PDSPublisher` built from this node's PDS
 * account, handed to the shared wiring in `@dina/home-node`.
 *
 * The repo protocol — CAS on `swapRecord`, an unreadable record refusing
 * rather than reading as absent, the restore-fence decision — lived here and
 * only here, so the phone had none of it. It moved to the shared plane
 * (§16.2, WS-2.4); what stays behind is the one genuinely server-shaped
 * thing, which is where the credentials come from.
 */

import { PDSPublisher } from '@dina/brain';
import { wireCommerceEpoch as wireShared } from '@dina/home-node';

import type { PdsIdentity } from '../identity/provision_pds';
import type { CommerceReceiptRepository, QuoteFamilyStore, TxRunner } from '@dina/core';
import type { DatabaseAdapter } from '@dina/core/storage';
import type { WiredCommerceEpoch } from '@dina/home-node';

export interface WireCommerceEpochOptions {
  pdsIdentity: PdsIdentity;
  /** The acting Business DID — must be the repo's own DID. */
  businessDid: string;
  /** The ONE Tier-0 runner; the restore fence writes with commerce state. */
  tx: TxRunner;
  families: QuoteFamilyStore;
  receipts: CommerceReceiptRepository;
  logger: { info: (o: unknown, m: string) => void; warn: (o: unknown, m: string) => void };
  /** Tier-0 database, read to decide whether this boot owes a RESTORE fence. */
  adapter: DatabaseAdapter;
  fetch?: typeof globalThis.fetch;
  nowFn?: () => number;
}

export type { WiredCommerceEpoch };

export function wireCommerceEpoch(options: WireCommerceEpochOptions): WiredCommerceEpoch {
  const pds = new PDSPublisher({
    pdsUrl: options.pdsIdentity.pdsUrl,
    handle: options.pdsIdentity.handle,
    password: options.pdsIdentity.password,
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
  });
  return wireShared({
    pds,
    businessDid: options.businessDid,
    tx: options.tx,
    families: options.families,
    receipts: options.receipts,
    logger: options.logger,
    adapter: options.adapter,
    ...(options.nowFn !== undefined ? { nowFn: options.nowFn } : {}),
  });
}
