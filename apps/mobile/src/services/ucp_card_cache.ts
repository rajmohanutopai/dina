/**
 * The comparison card's short memory (UCP plan §4.2 U1): a search the owner's
 * card read from Core, kept five minutes so a chat row drawn again does not
 * ask again. It holds what the owner shopped for, so it is cleared when UCP
 * stops (the vault sealed, sign-out, erase), as other derived data is.
 */

import type { MerchantTrust, OwnerSearchView } from '@dina/core';

/** How long a search read once is reused, and how many are kept. */
const CACHE_MS = 5 * 60_000;
const CACHE_SIZE = 20;

export interface CachedUcpSearch {
  at: number;
  view: OwnerSearchView;
  /** Null until Core's trust answer arrives. */
  trust: ReadonlyMap<string, MerchantTrust> | null;
}

const cache = new Map<string, CachedUcpSearch>();

/** A search read in the last five minutes; an older one is dropped. */
export function cachedUcpSearch(searchId: string): CachedUcpSearch | null {
  const hit = cache.get(searchId);
  if (hit === undefined) return null;
  if (Date.now() - hit.at > CACHE_MS) {
    cache.delete(searchId);
    return null;
  }
  return hit;
}

export function rememberUcpSearch(
  searchId: string,
  view: OwnerSearchView,
  trust: ReadonlyMap<string, MerchantTrust> | null,
): void {
  cache.delete(searchId);
  cache.set(searchId, { at: Date.now(), view, trust });
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
}

/** Forget every search (UCP stopped; tests). */
export function clearUcpCardCache(): void {
  cache.clear();
}
