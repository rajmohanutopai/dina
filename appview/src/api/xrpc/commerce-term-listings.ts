/**
 * xRPC: com.dinakernel.commerce.searchTermListings and getTermListing
 * (docs/SHELF_SPACE_NEGOTIATION.md §6.1, §6.3).
 *
 * What a directory (Zeev) and a brand's node read to find an open slot:
 * stores, areas, kinds, dates and the categories each store wants. There is
 * no price here because there is none in the record — the listing's closed
 * vocabulary has no money field, so search cannot leak a floor, an asking
 * price or a deal.
 *
 * CANDIDATES, NEVER AN INTRODUCTION. A result says "this store lists this
 * slot"; the brand's own node re-validates the listing (its digest covers it),
 * binds its request to the URI and digest, and the store's node checks that
 * binding against what it publishes NOW. A stale index row costs a refused
 * request, never a deal on terms nobody offered.
 *
 * `getTermListing` serves the deep link from Zeev's app (§6.3): the app hands
 * the Dina app a listing URI and nothing else; the Dina app fetches the record
 * here.
 */

import { and, arrayContains, desc, eq, gte, lte, type SQL } from 'drizzle-orm'
import { z } from 'zod'

import { termListings } from '@/db/schema/index.js'

import type { DrizzleDB } from '@/db/connection.js'

const isoInstant = z.string().datetime()

export const SearchTermListingsParams = z
  .object({
    /** A category (tag) the listing must want. */
    tag: z.string().min(1).max(128).optional(),
    kind: z.string().min(1).max(128).optional(),
    // The schemes a listing may carry (custom is refused at the gate).
    region_scheme: z.enum(['country', 'admin_area', 'postal_area', 'geohash']).optional(),
    region_value: z.string().min(1).max(100).optional(),
    /** A window the listing must cover entirely. */
    available_from: isoInstant.optional(),
    available_to: isoInstant.optional(),
    pack_id: z.string().min(1).max(128).optional(),
    seller: z.string().min(1).max(256).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .refine((p) => (p.region_scheme === undefined) === (p.region_value === undefined), {
    message: 'region_scheme and region_value go together',
  })

export type SearchTermListingsParamsType = z.infer<typeof SearchTermListingsParams>

export interface TermListingResult {
  uri: string
  cid: string | null
  seller_did: string
  /** The record as published — what the brand's node re-validates and binds to. */
  listing: unknown
}

export async function searchTermListings(
  db: DrizzleDB,
  params: SearchTermListingsParamsType,
): Promise<{ listings: TermListingResult[] }> {
  const where: SQL[] = []
  if (params.tag !== undefined) where.push(arrayContains(termListings.tags, [params.tag]))
  if (params.kind !== undefined) where.push(eq(termListings.kind, params.kind))
  if (params.region_scheme !== undefined && params.region_value !== undefined) {
    where.push(eq(termListings.regionScheme, params.region_scheme))
    where.push(eq(termListings.regionValue, params.region_value))
  }
  if (params.available_from !== undefined) where.push(lte(termListings.availableFrom, new Date(params.available_from)))
  if (params.available_to !== undefined) where.push(gte(termListings.availableTo, new Date(params.available_to)))
  if (params.pack_id !== undefined) where.push(eq(termListings.packId, params.pack_id))
  if (params.seller !== undefined) where.push(eq(termListings.sellerDid, params.seller))
  const rows = await db
    .select({
      uri: termListings.uri,
      cid: termListings.cid,
      sellerDid: termListings.sellerDid,
      recordJson: termListings.recordJson,
    })
    .from(termListings)
    .where(where.length === 0 ? undefined : and(...where))
    .orderBy(desc(termListings.indexedAt), termListings.uri)
    .limit(params.limit)
  return {
    listings: rows.map((row) => ({ uri: row.uri, cid: row.cid, seller_did: row.sellerDid, listing: row.recordJson })),
  }
}

export const GetTermListingParams = z.object({
  uri: z
    .string()
    .min(1)
    .max(512)
    .regex(/^at:\/\/did:[a-z0-9]+:[A-Za-z0-9._:%-]+\/com\.dinakernel\.commerce\.termListing\/[A-Za-z0-9._:~-]+$/),
})

export type GetTermListingParamsType = z.infer<typeof GetTermListingParams>

export async function getTermListing(
  db: DrizzleDB,
  params: GetTermListingParamsType,
): Promise<{ listing: TermListingResult | null }> {
  const rows = await db
    .select({
      uri: termListings.uri,
      cid: termListings.cid,
      sellerDid: termListings.sellerDid,
      recordJson: termListings.recordJson,
    })
    .from(termListings)
    .where(eq(termListings.uri, params.uri))
    .limit(1)
  const row = rows[0]
  return {
    listing: row === undefined ? null : { uri: row.uri, cid: row.cid, seller_did: row.sellerDid, listing: row.recordJson },
  }
}
