/**
 * This node's own repo, as term listings need it (SHELF_SPACE_NEGOTIATION
 * §6.1) — the catalog repo helper's rules for a second record kind: write
 * only to this node's repo, re-checked on EVERY write, because a listing in
 * somebody else's repo would advertise their shelf under this store's terms.
 */

import { TERM_LISTING_COLLECTION, type TermListing } from '@dina/commerce-protocol';

import type { TermListingRepo } from '@dina/core';

/** The two repo operations a listing needs; the PDS publisher has both. */
export interface TermListingRepoClient {
  putRecord: (
    collection: string,
    rkey: string,
    record: Record<string, unknown>,
    options: { swapRecord?: string | null },
  ) => Promise<{ cid: string }>;
  deleteRecord: (collection: string, rkey: string) => Promise<void>;
}

export function makeTermListingRepo(options: {
  pds: TermListingRepoClient;
  /** The DID this node publishes under — the listing's `seller_did`. */
  ownerDid: string;
  /** Re-read the live repo identity. Omit when the client cannot rebind. */
  authenticate?: () => Promise<string>;
}): TermListingRepo {
  const assertOwnRepo = async (): Promise<void> => {
    if (options.authenticate === undefined) return;
    const actual = await options.authenticate();
    if (actual !== options.ownerDid)
      throw new Error(`term listing: repo identity ${actual} is not ${options.ownerDid}`);
  };
  return {
    put: async (listing: TermListing) => {
      if (listing.seller_did !== options.ownerDid) {
        throw new Error('term listing: the listing names another seller');
      }
      await assertOwnRepo();
      // A blind overwrite: republishing a listing replaces it.
      return options.pds.putRecord(
        TERM_LISTING_COLLECTION,
        listing.listing_id,
        listing as unknown as Record<string, unknown>,
        {},
      );
    },
    remove: async (listingId: string) => {
      await assertOwnRepo();
      await options.pds.deleteRecord(TERM_LISTING_COLLECTION, listingId);
    },
  };
}
