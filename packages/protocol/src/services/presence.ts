/**
 * Service presence — a node's daily "still here" record
 * (docs/REAL_LIFE_FIXES.md §14).
 *
 * A listing on AppView outlives the node that published it. A node with at
 * least one published listing (public or unlisted) renews one record in its
 * own repository, `com.dinakernel.service.presence/self`, about once a day.
 * AppView judges liveness by when it received the renewals (its own clock),
 * never by anything inside the record, so the record carries no time:
 *
 *   - `n`: a fresh random value per write, so each renewal is a new commit;
 *   - `listings`: the node's published listings as `{rkey, cid}`, so AppView
 *     can withhold a listing whose delete or update it missed;
 *   - `complete`: whether `listings` is the whole set. A node over the
 *     listing limit writes `complete: false` with an empty set and is judged
 *     by its renewals alone.
 */

import { isValidServiceListingRkey } from '../validators';

/** AT-Proto NSID of the presence record. */
export const SERVICE_PRESENCE_COLLECTION = 'com.dinakernel.service.presence';
/** The one record key a node writes presence under. */
export const SERVICE_PRESENCE_RKEY = 'self';
/** Record format version. */
export const SERVICE_PRESENCE_VERSION = 1;
/** Most listings one node may publish; the presence set holds all of them. */
export const MAX_PUBLISHED_LISTINGS = 100;

export interface ServicePresenceListing {
  rkey: string;
  cid: string;
}

export interface ServicePresenceRecord {
  $type?: typeof SERVICE_PRESENCE_COLLECTION;
  v: typeof SERVICE_PRESENCE_VERSION;
  n: string;
  listings: ServicePresenceListing[];
  complete: boolean;
}

const NONCE_RE = /^[0-9a-f]{16}$/;
// A CIDv1 in base32 (`b…`) as atproto writes it; bounded so a record cannot
// smuggle a large blob through a field AppView stores.
const CID_RE = /^b[a-z2-7]{20,120}$/;

/** Validate a presence record. `null` when valid, else the first problem. */
export function validateServicePresenceRecord(record: unknown): string | null {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return 'record must be an object';
  const r = record as Record<string, unknown>;
  if (r.$type !== undefined && r.$type !== SERVICE_PRESENCE_COLLECTION) return 'wrong $type';
  if (r.v !== SERVICE_PRESENCE_VERSION) return 'v must be 1';
  if (typeof r.n !== 'string' || !NONCE_RE.test(r.n)) return 'n must be 16 lowercase hex characters';
  if (typeof r.complete !== 'boolean') return 'complete must be a boolean';
  if (!Array.isArray(r.listings)) return 'listings must be an array';
  if (r.listings.length > MAX_PUBLISHED_LISTINGS) return `listings holds at most ${MAX_PUBLISHED_LISTINGS}`;
  if (!r.complete && r.listings.length > 0) return 'an incomplete set must be empty';
  const seen = new Set<string>();
  for (const entry of r.listings) {
    if (entry === null || typeof entry !== 'object') return 'each listing must be an object';
    const { rkey, cid } = entry as Record<string, unknown>;
    if (typeof rkey !== 'string' || !isValidServiceListingRkey(rkey)) return 'listing rkey is not valid';
    if (typeof cid !== 'string' || !CID_RE.test(cid)) return 'listing cid is not valid';
    if (seen.has(rkey)) return 'listings repeat an rkey';
    seen.add(rkey);
  }
  return null;
}

/** A fresh `n`: 64 random bits as 16 hex characters. */
export function presenceNonce(randomBytes: (n: number) => Uint8Array): string {
  return Array.from(randomBytes(8), (b) => b.toString(16).padStart(2, '0')).join('');
}
