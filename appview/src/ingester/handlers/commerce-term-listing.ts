/**
 * Jetstream handler for `com.dinakernel.commerce.termListing`
 * (docs/SHELF_SPACE_NEGOTIATION.md §6.1) — a store's open resource, such as a
 * shelf slot, indexed so a directory (Zeev) and brands can find it.
 *
 * WHAT IT CHECKS, beyond the protocol validator the record validator already
 * ran (closed vocabulary, no money field, digest):
 *
 *   - the record sits in its SELLER's own repo (`seller_did === op.did`), so
 *     nobody can list another store's shelf;
 *   - its record key is its `listing_id`, so the URI a brand's request names
 *     is the URI the store's node checks it against;
 *   - an older repository revision never replaces a newer one.
 *
 * A deletion removes the listing: a store that withdraws a slot stops being
 * found for it. Accepted risk: an older create replayed after the delete
 * (no deletion tombstone is kept) can bring the row back. It is harmless by
 * construction — the store's node answers only a request naming a listing it
 * publishes NOW, so a stale row costs a brand one refused request.
 */

import { TERM_LISTING_COLLECTION, type TermListing } from '@dina/commerce-protocol'
import { eq, sql } from 'drizzle-orm'

import { termListings } from '@/db/schema/index.js'
import { readTermListingRecord } from '@/shared/commerce/term-listing.js'

import type { HandlerContext, RecordHandler, RecordOp } from './index.js'

export type TermListingRead =
  | { ok: true; listing: TermListing }
  | { ok: false; reason: 'unreadable' | 'not_the_sellers_repo' | 'rkey_mismatch' | 'wrong_collection' }

/** Everything a create must satisfy, as a pure function of the operation. */
export function readTermListingOp(op: RecordOp): TermListingRead {
  if (op.collection !== TERM_LISTING_COLLECTION) return { ok: false, reason: 'wrong_collection' }
  const listing = op.record === undefined ? null : readTermListingRecord(op.record)
  if (listing === null) return { ok: false, reason: 'unreadable' }
  if (listing.seller_did !== op.did) return { ok: false, reason: 'not_the_sellers_repo' }
  if (listing.listing_id !== op.rkey) return { ok: false, reason: 'rkey_mismatch' }
  return { ok: true, listing }
}

export const commerceTermListingHandler: RecordHandler = {
  async handleCreate(ctx: HandlerContext, op: RecordOp): Promise<void> {
    const read = readTermListingOp(op)
    if (!read.ok) {
      // Metadata only: the reason and the collection, never the record.
      ctx.logger.warn({ collection: op.collection, reason: read.reason }, '[TermListing] refused')
      ctx.metrics.incr('ingester.term_listing.refused')
      return
    }
    const listing = read.listing
    const row = {
      uri: op.uri,
      sellerDid: listing.seller_did,
      listingId: listing.listing_id,
      cid: op.cid ?? null,
      listingDigest: listing.listing_digest,
      packId: listing.pack.plugin_id,
      schemaMajor: listing.pack.schema_major,
      resourceRef: listing.resource_ref,
      kind: listing.kind,
      regionScheme: listing.region.scheme,
      regionValue: listing.region.value,
      availableFrom: new Date(listing.available.from),
      availableTo: new Date(listing.available.to),
      tags: listing.tags,
      recordJson: listing as unknown as Record<string, unknown>,
      repoRev: op.repoRev ?? null,
      indexedAt: new Date(),
    }
    const { uri: _uri, ...update } = row
    await ctx.db
      .insert(termListings)
      .values(row)
      .onConflictDoUpdate({
        target: termListings.uri,
        set: update,
        // An event from an older revision of the repo never replaces a newer one.
        setWhere: sql`${termListings.repoRev} IS NULL OR excluded.repo_rev IS NULL OR ${termListings.repoRev} <= excluded.repo_rev`,
      })
    ctx.metrics.incr('ingester.term_listing.indexed')
  },

  async handleDelete(ctx: HandlerContext, op: RecordOp): Promise<void> {
    await ctx.db.delete(termListings).where(eq(termListings.uri, op.uri))
    ctx.metrics.incr('ingester.term_listing.deleted')
  },
}
