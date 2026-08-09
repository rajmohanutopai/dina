/**
 * Give the commerce epoch service a real repo (§16.2, WS-2.4).
 *
 * `CommerceEpochService` takes its repo as two injected callbacks — a live
 * read and a CAS write — because the PDS client is app-level wiring and Core
 * must not hold one. This module supplies them over the node's own PDS
 * account, and it lives in the SHARED plane because both composition roots
 * need it and the phone had none: `getCommerceEpochService()` was read on
 * mobile in two places and set in neither, so `currentEpoch()` threw for
 * ever and every commerce operation on the product surface refused. Failing
 * closed is what a correctly-refusing node also looks like, which is why
 * that went unnoticed.
 *
 * WHY CAS MATTERS HERE. The epoch record is the restore fence. Two nodes
 * restoring from the same backup must not both believe they published epoch
 * N+1 — one has to lose, re-read, and re-increment, or two divergent
 * generations of quotes exist under one business identity. AT Protocol's
 * `swapRecord` is that serialization: the write lands only if the record
 * being replaced is still exactly the one we read.
 *
 * WHY IT FAILS CLOSED. Every path that cannot establish what the live record
 * is refuses. An unreachable repo throws (it is not "no record"), a malformed
 * record throws, and a swap whose predecessor we cannot prove throws rather
 * than overwriting blind. A supplier that cannot reach its own repo does not
 * sign.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import { PDSPublisherError } from '@dina/brain';
import {
  COMMERCE_EPOCH_COLLECTION,
  COMMERCE_EPOCH_RKEY,
  validateCommerceEpochRecord,
  type CommerceEpochRecord,
  type Sha256Fn,
} from '@dina/commerce-protocol';
import {
  CommerceEpochService,
  clearCommerceRestorePending,
  isCommerceRestorePending,
  setCommerceEpochService,
  CommerceTransaction,
  type CommerceReceiptRepository,
  type QuoteFamilyStore,
  type TxRunner,
} from '@dina/core';

import type { DatabaseAdapter } from '@dina/core/storage';

const hash: Sha256Fn = (data) => sha256(data);

/**
 * The slice of `PDSPublisher` this needs. Narrowed on purpose: an epoch
 * writer that could reach the rest of the publisher could publish anything
 * to the owner's repo, and the two calls below are the whole job.
 */
export interface EpochRepoClient {
  getRecord: (
    collection: string,
    rkey: string,
  ) => Promise<{ value: Record<string, unknown>; cid: string } | null>;
  putRecord: (
    collection: string,
    rkey: string,
    record: Record<string, unknown>,
    // OPTIONAL, and the absence is meaningful: no `swapRecord` key at all is a
    // blind overwrite, which is what a content-addressed record needs so a
    // retry writing identical bytes does not fail on success.
    options: { swapRecord?: string | null },
  ) => Promise<{ cid: string }>;
}

export interface WireCommerceEpochOptions {
  /** The node's own repo client. */
  pds: EpochRepoClient;
  /** The acting Business DID — must be the repo's own DID. */
  businessDid: string;
  /** The ONE Tier-0 runner; the restore fence writes with commerce state. */
  tx: TxRunner;
  families: QuoteFamilyStore;
  receipts: CommerceReceiptRepository;
  logger: { info: (o: unknown, m: string) => void; warn: (o: unknown, m: string) => void };
  /**
   * Tier-0 database, read to decide whether this boot owes a RESTORE fence
   * (§16.2 / WS-4.2). The archive import writes a durable marker inside its
   * own transaction; a boot that finds it must increment the epoch and void
   * capacity rather than adopt the live epoch unchanged.
   */
  adapter: DatabaseAdapter;
  nowFn?: () => number;
  /** Override §16.2's re-read cadence and staleness bound (tests). */
  revalidationIntervalMs?: number;
  maxStalenessMs?: number;
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
  const { pds, businessDid, logger } = options;

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
    // ARCH-0c — the epoch service takes a coordinator rather than a raw
    // runner, so the one place a transaction can begin is the same place for
    // every commerce engine.
    transaction: new CommerceTransaction(options.tx),
    families: options.families,
    receipts: options.receipts,
    businessDid,
    fetchLive,
    publish,
    now: options.nowFn ?? (() => Date.now()),
    ...(options.revalidationIntervalMs !== undefined
      ? { revalidationIntervalMs: options.revalidationIntervalMs }
      : {}),
    ...(options.maxStalenessMs !== undefined ? { maxStalenessMs: options.maxStalenessMs } : {}),
  });

  return {
    service,
    establish: async () => {
      // §16.2 — which path this boot takes is decided by whether a restore
      // fence is owed, NOT by configuration. `establish()` adopts the live
      // epoch; after a restore that would leave every restored quote head
      // matching the current epoch, and the backup's spent capacity would be
      // spendable again.
      const restorePending = isCommerceRestorePending(options.adapter);
      try {
        const record = restorePending
          ? await service.establishAfterRestore()
          : await service.establish();
        setCommerceEpochService(service);
        if (restorePending) {
          // Clear ONLY now: the higher epoch is published and the capacity
          // void committed. Clearing before either would let the next boot
          // skip a fence that never ran.
          clearCommerceRestorePending(options.adapter);
          logger.info(
            { epoch: record.epoch },
            'commerce restore fence complete — capacity voided, epoch incremented',
          );
        }
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
        // The marker is deliberately LEFT SET on failure: the obligation
        // survives until it is discharged, so a node that could not reach
        // its repo retries the fence on the next boot instead of quietly
        // adopting the live epoch later.
        logger.warn(
          {
            error: err instanceof Error ? err.message : String(err),
            restorePending,
          },
          'commerce epoch not established — commerce stays disabled',
        );
        return null;
      }
    },
  };
}
