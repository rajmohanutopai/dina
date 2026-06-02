/**
 * Listing rkey generation (multi-listing provider model).
 *
 * Each service listing is published as `com.dinakernel.service.profile/<rkey>`,
 * and an inbound query's `service_uri` carries the same rkey so the provider
 * answers for the right listing. The DEFAULT listing uses `self`; a NEW listing
 * created in the "My listings" UI needs its own rkey.
 *
 * `slugifyRkey` derives a stable, valid, UNIQUE rkey from the listing's display
 * name. Valid charset matches `@dina/protocol`'s `isValidServiceListingRkey`
 * (`[A-Za-z0-9._~-]{1,512}`). Pure — no I/O — so it's unit-tested directly.
 */

/** Reserved rkey for the default listing — a new listing never reuses it. */
export const DEFAULT_LISTING_RKEY = 'self';

/** Cap generated rkeys well under the protocol's 512 limit for readable URIs. */
const MAX_RKEY_LEN = 64;

/**
 * Derive a valid, unique listing rkey from `name`, avoiding every rkey in
 * `taken` (pass the existing listings' rkeys) and the reserved `self`.
 *
 * - Lowercases, replaces any out-of-charset run with a single `-`, trims
 *   leading/trailing separators, caps length.
 * - Falls back to `listing` when the name has no usable characters.
 * - On collision (or `self`), appends `-2`, `-3`, … until unique.
 */
export function slugifyRkey(name: string, taken: Iterable<string> = []): string {
  const reserved = new Set<string>([DEFAULT_LISTING_RKEY, ...taken]);

  let base = name
    .toLowerCase()
    .replace(/[^a-z0-9._~-]+/g, '-') // out-of-charset runs → single '-'
    .replace(/^[-._~]+|[-._~]+$/g, '') // trim leading/trailing separators
    .slice(0, MAX_RKEY_LEN)
    .replace(/[-._~]+$/g, ''); // re-trim if the slice landed on a separator

  if (base === '') base = 'listing';

  if (!reserved.has(base)) return base;
  for (let n = 2; ; n++) {
    // Reserve room for the suffix BEFORE truncating, so a 64-char base doesn't
    // produce `base-2` sliced straight back to `base` (which would loop
    // forever). The suffix grows (`-2` … `-10` …); re-trim per iteration.
    const suffix = `-${n}`;
    const candidate = base.slice(0, MAX_RKEY_LEN - suffix.length) + suffix;
    if (!reserved.has(candidate)) return candidate;
  }
}
