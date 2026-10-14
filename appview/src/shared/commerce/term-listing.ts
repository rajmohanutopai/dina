/**
 * The term listing as AppView reads it (docs/SHELF_SPACE_NEGOTIATION.md §6.1):
 * the protocol validator, applied to the record as the repo stores it. The
 * record validator (the gate) and the handler (the indexer) both call this, so
 * the two cannot disagree on what a listing is.
 */

import { createHash } from 'node:crypto'

import { validateTermListing, type TermListing } from '@dina/commerce-protocol'

const sha256 = (data: Uint8Array): Uint8Array => new Uint8Array(createHash('sha256').update(data).digest())

/** The PDS stamps `$type` into every stored value; the listing's vocabulary has no such field. */
export function stripRecordType(record: Record<string, unknown>): Record<string, unknown> {
  const { $type: _type, ...rest } = record
  return rest
}

/** The listing a stored record carries, or null when it is not one (any other key, a bad digest). */
export function readTermListingRecord(record: unknown): TermListing | null {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return null
  const stripped = stripRecordType(record as Record<string, unknown>)
  return validateTermListing(stripped, sha256) === null ? (stripped as unknown as TermListing) : null
}
