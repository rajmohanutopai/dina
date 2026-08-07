/**
 * Give the commerce epoch service a real repo (§16.2, WS-2.4).
 *
 * `CommerceEpochService` has always taken its repo as two injected
 * callbacks — a live read and a CAS write — because the PDS client is
 * app-level wiring and Core must not hold one. Nothing supplied them, so
 * the service was never constructed, `currentEpoch()` threw forever, and
 * every commerce operation refused. The engines were reachable; the epoch
 * they must sign at was not.
 *
 * This module supplies the two callbacks over the node's own PDS account.
 *
 * WHY CAS MATTERS HERE. The epoch record is the restore fence. Two nodes
 * restoring from the same backup must not both believe they published
 * epoch N+1 — one has to lose, re-read, and re-increment, or two
 * divergent generations of quotes exist under one business identity. AT
 * Protocol's `swapRecord` is that serialization: the write lands only if
 * the record being replaced is still exactly the one we read.
 *
 * WHY IT FAILS CLOSED. Every path that cannot establish what the live
 * record is refuses. An unreachable repo throws (it is not "no record"),
 * a malformed record throws, and a swap whose predecessor we cannot prove
 * throws rather than overwriting blind. A supplier that cannot reach its
 * own repo does not sign.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import { PDSPublisher, PDSPublisherError } from '@dina/brain';
import {
  COMMERCE_EPOCH_COLLECTION,
  COMMERCE_EPOCH_RKEY,
  validateCommerceEpochRecord,
  type CommerceEpochRecord,
  type Sha256Fn,
} from '@dina/commerce-protocol';
import {
  CommerceEpochService,
  setCommerceEpochService,
  type CommerceReceiptRepository,
  type QuoteFamilyStore,
  type TxRunner,
} from '@dina/core';

import type { PdsIdentity } from '../identity/provision_pds';

const hash: Sha256Fn = (data) => sha256(data);

export interface WireCommerceEpochOptions {
  pdsIdentity: PdsIdentity;
  /** The acting Business DID — must be the repo's own DID. */
  businessDid: string;
  /** The ONE Tier-0 runner; the restore fence writes with commerce state. */
  tx: TxRunner;
  families: QuoteFamilyStore;
  receipts: CommerceReceiptRepository;
  logger: { info: (o: unknown, m: string) => void; warn: (o: unknown, m: string) => void };
  fetch?: typeof globalThis.fetch;
  nowFn?: () => number;
}

export interface WiredCommerceEpoch {
  service: CommerceEpochService;
  /**
   * Publish or adopt the live epoch. Resolves to the adopted record, or to
   * null when the repo could not be reached — commerce then stays disabled
   * rather than the boot failing, because a node with no commerce is a
   * working node.
   */
  establish: () => Promise<CommerceEpochRecord | null>;
}

export function wireCommerceEpoch(options: WireCommerceEpochOptions): WiredCommerceEpoch {
  const { pdsIdentity, businessDid, logger } = options;

  const pds = new PDSPublisher({
    pdsUrl: pdsIdentity.pdsUrl,
    handle: pdsIdentity.handle,
    password: pdsIdentity.password,
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
  });

  /**
   * The CID of the record we last read. A CAS write needs the identity of
   * the thing it replaces, and the `EpochPublisher` contract passes only
   * the record. Caching what we read — and refusing when the caller's
   * `previous` is not that record — keeps the swap honest rather than
   * degrading to a blind overwrite when the two disagree.
   */
  let lastRead: { digest: string; cid: string } | null = null;

  const fetchLive = async (): Promise<CommerceEpochRecord | null> => {
    const found = await pds.getRecord(COMMERCE_EPOCH_COLLECTION, COMMERCE_EPOCH_RKEY);
    if (found === null) {
      lastRead = null;
      return null;
    }
    const invalid = validateCommerceEpochRecord(found.value, hash);
    if (invalid !== null) {
      // Do NOT return null: an unreadable record is not an absent one, and
      // treating it as absent would publish a genesis over a live chain.
      throw new Error(`commerce epoch: live record is invalid — ${invalid}`);
    }
    const record = found.value as unknown as CommerceEpochRecord;
    lastRead = { digest: record.epoch_digest, cid: found.cid };
    return record;
  };

  const publish = async (
    record: CommerceEpochRecord,
    previous: CommerceEpochRecord | null,
  ): Promise<boolean> => {
    let swapRecord: string | null;
    if (previous === null) {
      // Genesis: the write must land only if nothing is there.
      swapRecord = null;
    } else {
      // Being asked to replace a record we have not read. Without its CID
      // there is no swap to make, and a blind write is exactly the
      // divergence the fence exists to prevent.
      //
      // This THROWS rather than returning false, and the difference is
      // deliberate. False means "you lost a race, re-read and retry", and
      // retrying cannot help here: the caller handed us a predecessor we
      // never saw, so the next attempt would hand us the same one. It is a
      // broken contract, not a lost race.
      //
      // Not reachable through `CommerceEpochService`, which re-reads at the
      // top of every attempt and so always passes back the record this
      // closure just cached — I could not construct a case that reaches it,
      // including two overlapping restores. It stands as an assertion on
      // the `EpochPublisher` contract for any future caller, and it is
      // honest to say it is unexercised rather than to claim coverage.
      if (lastRead === null || lastRead.digest !== previous.epoch_digest) {
        throw new Error(
          'commerce epoch: asked to publish against a predecessor this node did not read — refusing to write without a swap (§16.2)',
        );
      }
      swapRecord = lastRead.cid;
    }

    try {
      const written = await pds.putRecord(
        COMMERCE_EPOCH_COLLECTION,
        COMMERCE_EPOCH_RKEY,
        record as unknown as Record<string, unknown>,
        { swapRecord },
      );
      lastRead = { digest: record.epoch_digest, cid: written.cid };
      return true;
    } catch (err) {
      if (err instanceof PDSPublisherError && err.casLost) {
        // Another writer won. The service re-reads and re-increments; that
        // is the serialization working, not a failure.
        lastRead = null;
        return false;
      }
      throw err;
    }
  };

  const service = new CommerceEpochService({
    tx: options.tx,
    families: options.families,
    receipts: options.receipts,
    businessDid,
    fetchLive,
    publish,
    now: options.nowFn ?? (() => Date.now()),
  });

  return {
    service,
    establish: async () => {
      try {
        const record = await service.establish();
        setCommerceEpochService(service);
        logger.info(
          { epoch: record.epoch, reason: record.reason },
          'commerce epoch established — commerce signing enabled',
        );
        return record;
      } catch (err) {
        // Leave the service UNINSTALLED. `commerceAvailability()` then
        // reports `no_epoch` and every commerce operation refuses, which
        // is the §16.2 posture. Installing a service whose `currentEpoch()`
        // throws would report the same thing less clearly.
        logger.warn(
          { error: err instanceof Error ? err.message : String(err) },
          'commerce epoch not established — commerce stays disabled',
        );
        return null;
      }
    },
  };
}
