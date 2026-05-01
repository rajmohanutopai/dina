/**
 * Wire-side handle normalization.
 *
 * `did_profiles.handle` uses an internal sentinel scheme:
 *   - `null`  → not yet resolved by `backfill-handles`
 *   - `''`    → resolved, but the DID's PLC doc has no `alsoKnownAs`
 *   - a string → the resolved handle
 *
 * Wire surfaces (xRPC responses) should never expose `''` — clients
 * shouldn't have to know about the sentinel. This helper maps both
 * `null` and `''` to `null` and passes through the string case.
 *
 * Centralized so every xRPC handler that joins `did_profiles.handle`
 * does the same mapping.
 */
export function normalizeHandle(stored: string | null | undefined): string | null {
  if (stored === null || stored === undefined) return null
  if (stored === '') return null
  return stored
}
