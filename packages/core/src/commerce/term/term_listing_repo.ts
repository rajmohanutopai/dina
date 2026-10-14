/**
 * Where a term listing becomes public (SHELF_SPACE_NEGOTIATION §6.1): a record
 * in this node's OWN repo, collection `com.dinakernel.commerce.termListing`,
 * keyed by the listing id — what AppView indexes and what Zeev reads.
 *
 * Core composes and checks the record (closed vocabulary, no money field);
 * the composition root owns the WRITE, because writing to a repo is I/O and
 * Core does none — the catalog publisher's split (catalog_record_writer.ts).
 * The root's implementation re-checks, on every write, that the repo is this
 * node's own: a listing in somebody else's repo would advertise their shelf.
 */

import type { TermEngine } from './term_engine';
import type { TermListing } from '@dina/commerce-protocol';

export interface TermListingRepo {
  /** Write (or overwrite) the listing record; resolves with its CID. */
  put: (listing: TermListing) => Promise<{ cid: string }>;
  /** Remove the listing record; a record already gone is not an error. */
  remove: (listingId: string) => Promise<void>;
}

let repo: TermListingRepo | null = null;

/**
 * Every change to this node's listings — a publish (record, then the local
 * "published"), a withdrawal, a record removal, a policy save with the
 * withdrawals it causes, the sweeper's upkeep — runs one at a time, in order.
 * Nothing can then fall between another change's steps: a removal never
 * deletes a record a publish is writing, a withdrawal is never undone by a
 * publish in flight, and a publish is always checked against the policy that
 * stands when it writes. These are owner acts and a one-minute sweep, so one at
 * a time costs nothing that matters.
 */
let chain: Promise<unknown> = Promise.resolve();

export function withListingsLock<T>(change: () => Promise<T>): Promise<T> {
  const next = chain.catch(() => undefined).then(change);
  chain = next.catch(() => undefined);
  return next;
}

export function installTermListingRepo(value: TermListingRepo | null): void {
  repo = value;
}

export function getTermListingRepo(): TermListingRepo | null {
  return repo;
}

/**
 * Remove one withdrawn listing's public record and note it gone; call only
 * while holding the lock. False when there is no repo or the removal failed:
 * the listing stays marked public, and the sweeper tries again.
 */
async function removeRecordLocked(
  terms: TermEngine,
  listing: { listingId: string; listingDigest: string },
): Promise<boolean> {
  const target = repo;
  if (target === null) return false;
  const still = terms
    .listingsAwaitingRemoval()
    .some((l) => l.listingId === listing.listingId && l.listingDigest === listing.listingDigest);
  if (!still) return true;
  try {
    await target.remove(listing.listingId);
  } catch {
    return false;
  }
  terms.listingRecordRemoved(listing.listingId, listing.listingDigest);
  return true;
}

/** Withdraw here, then remove the record; call only while holding the lock. */
async function withdrawLocked(
  terms: TermEngine,
  listingId: string,
): Promise<{ known: boolean; recordRemoved: boolean }> {
  if (!terms.withdrawListing(listingId)) return { known: false, recordRemoved: false };
  const row = terms.listingsAwaitingRemoval().find((l) => l.listingId === listingId);
  return {
    known: true,
    recordRemoved: row === undefined ? true : await removeRecordLocked(terms, row),
  };
}

/**
 * Withdraw a listing here and remove its public record, as one change.
 * `known` is false for a listing this node never published.
 */
export function withdrawEverywhere(
  terms: TermEngine,
  listingId: string,
): Promise<{ known: boolean; recordRemoved: boolean }> {
  return withListingsLock(() => withdrawLocked(terms, listingId));
}

/**
 * Save the store's policy and withdraw, as the same change, the listings it no
 * longer backs (renting off, a slot's terms removed): a publish cannot slip
 * between the save and the withdrawals, so the answer lists every listing the
 * new policy took down.
 */
export function savePolicyWithdrawing(
  terms: TermEngine,
  policy: unknown,
): Promise<
  | { ok: true; revision: number; withdrawn: { listing_id: string; record_removed: boolean }[] }
  | { ok: false; refusal: string }
> {
  return withListingsLock(async () => {
    const set = terms.setPolicy(policy);
    if (!set.ok) return set;
    const withdrawn: { listing_id: string; record_removed: boolean }[] = [];
    for (const id of terms.listingIdsOutsidePolicy()) {
      const done = await withdrawLocked(terms, id);
      withdrawn.push({ listing_id: id, record_removed: done.recordRemoved });
    }
    return { ok: true, revision: set.revision, withdrawn };
  });
}

/**
 * Bring the directory in line with this node: withdraw listings the policy or
 * pack no longer backs, then one removal attempt per public record still
 * standing (a failed one is tried again next tick). Run by the term sweeper, so
 * a crash, a failed removal or a removed pack is put right on its own.
 */
export function reconcileTermListings(terms: TermEngine): Promise<void> {
  return withListingsLock(async () => {
    for (const id of terms.listingIdsOutsidePolicy()) terms.withdrawListing(id);
    for (const listing of terms.listingsAwaitingRemoval()) await removeRecordLocked(terms, listing);
  });
}
