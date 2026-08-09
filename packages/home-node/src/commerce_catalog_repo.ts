/**
 * This node's own repo, as the catalog surface needs it (§10.2).
 *
 * ONE PLACE, because there are two composition roots and the rules are
 * identical: write the snapshot with no condition, write the head under CAS,
 * and never touch a repo that is not this node's. The server grew its own
 * version first; the phone grew none at all, so catalog publish and withdrawal
 * were simply unavailable on a deployment that ships a PDS session and already
 * publishes its restore epoch through the same client.
 *
 * THE IDENTITY RE-CHECK IS THE LOAD-BEARING PART. Writing a catalog into
 * somebody else's repo publishes this business's terms under another
 * supplier's name, and a session can be rebound between boot and write. It is
 * checked on EVERY write rather than once at wiring time.
 */

import type { EpochRepoClient } from './commerce_epoch';
import type { CatalogRecordReader, CatalogRecordWriter } from '@dina/core';

export interface CatalogRepoAccess {
  writer: CatalogRecordWriter;
  reader: CatalogRecordReader;
}

/**
 * Build the pair from a repo client and the DID that repo must belong to.
 *
 * `authenticate` is asked per write, not cached: the answer is the question
 * "whose repo am I about to write to", and a stale yes is the failure mode
 * that matters.
 */
export function makeCatalogRepoAccess(options: {
  pds: EpochRepoClient;
  /** The DID this node publishes under. */
  ownerDid: string;
  /** Re-read the live repo identity. Omit when the client cannot rebind. */
  authenticate?: () => Promise<string>;
}): CatalogRepoAccess {
  const assertOwnRepo = async (): Promise<void> => {
    if (options.authenticate === undefined) return;
    const actual = await options.authenticate();
    if (actual !== options.ownerDid) {
      throw new Error(`catalog: repo identity ${actual} is not ${options.ownerDid}`);
    }
  };

  return {
    writer: async (write) => {
      await assertOwnRepo();
      // FORWARDED ONLY WHEN PRESENT. An absent `swapRecord` is a blind
      // overwrite; `null` means "only if nothing is there". Passing
      // `{ swapRecord: undefined }` would still put the key in the object,
      // which the publisher reads as null — and that turns a safe retry of a
      // content-addressed snapshot into a reported failure.
      return options.pds.putRecord(
        write.collection,
        write.rkey,
        write.record,
        'swapRecord' in write ? { swapRecord: write.swapRecord ?? null } : {},
      );
    },
    reader: async ({ collection, rkey }) => {
      await assertOwnRepo();
      const found = await options.pds.getRecord(collection, rkey);
      return found === null ? null : { record: found.value, cid: found.cid };
    },
  };
}
