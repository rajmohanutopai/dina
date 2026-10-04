/**
 * Find suppliers to ask for quotes (ASK_FOR_QUOTES_PLAN §1).
 *
 * A tender needs each supplier's Dina ID and listing key. The buyer types
 * what they want ("cakes") and this finds who sells it, from two AppView
 * sources merged per listing:
 *
 *   - `com.dinakernel.commerce.searchCatalog`: suppliers who publish a
 *     matching catalog item and deliver to the buyer's region (region is a
 *     hard filter there, and the trust floor is already applied);
 *   - `com.dinakernel.service.search` for `request_quote`: public supplier
 *     listings whose own words match, with or without a catalog row.
 *
 * The catalog matches each word as a substring of an item's name, brand or
 * description, so a phrase is searched word by word ("floral cake" would
 * match nothing as one string); a supplier matching more of the words ranks
 * higher, then higher trust. The buyer's blocked suppliers are removed, the
 * preferred ones listed first. A supplier PeerLens sets aside (the owner's own
 * poor review, or a low score over enough reviews: `supplier_trust`) is kept
 * in the list, last, with why. Read-only: nothing here contacts a supplier.
 */

import { AppViewClient } from '@dina/brain';

import { appViewBase, appViewFetch } from '../peerlens/appview_base';

import {
  loadOwnSupplierReviews,
  LOW_TRUST_BELOW,
  setAsideFor,
  type OwnReview,
  type SetAside,
} from './supplier_trust';

import type { CommerceCatalogCandidate, ServiceProfile } from '@dina/brain';

/** The capability a supplier listing answers a quote request on. */
export const REQUEST_QUOTE_CAPABILITY = 'com.dinakernel.commerce.request_quote';

/** How many words of a phrase are searched (each is one catalog query). */
const MAX_WORDS = 3;
const RESULTS_PER_SOURCE = 20;

/** Words that say nothing about what is wanted. */
const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'any',
  'at',
  'do',
  'does',
  'for',
  'from',
  'in',
  'me',
  'my',
  'near',
  'of',
  'on',
  'or',
  'that',
  'the',
  'to',
  'who',
  'with',
]);

export interface SupplierMatch {
  supplierDid: string;
  serviceRkey: string;
  /** The listing's name, or null when the AppView could not name it. */
  name: string | null;
  /** PeerLens trust, 0..1; null when the supplier has no trust history. */
  trustScore: number | null;
  /** How many PeerLens reviews are about the supplier; null when unknown. */
  reviewCount: number | null;
  /** Why PeerLens sets this supplier aside; null when it may be asked. */
  setAside: SetAside | null;
  /** How many of the searched words this supplier matched. */
  wordsMatched: number;
  /** Catalog items that matched, for "3 matching items". */
  itemsMatched: number;
  /** The lowest published indicative price among the matched items. */
  indicativeFrom?: { currency: string; minorUnits: string };
  preferred: boolean;
}

export interface FindSuppliersInput {
  text: string;
  /** The buyer's delivery region, `scheme:value` (e.g. `postal_area:560001`). */
  region?: string;
  preferredSuppliers?: readonly string[];
  blockedSuppliers?: readonly string[];
  /** The owner's own newest review of each supplier, by DID. */
  ownReviews?: ReadonlyMap<string, OwnReview>;
}

export interface FindSuppliersResult {
  suppliers: SupplierMatch[];
  /** The words actually searched, so the screen can show them. */
  words: string[];
}

type Finder = Pick<
  AppViewClient,
  'searchCatalog' | 'searchServices' | 'resolveServiceByUri' | 'getProfile'
>;

/** A plural made singular, for substring matching ("bakeries" → "bakery"). */
function singular(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** The significant words of what the buyer typed, at most `MAX_WORDS`. */
export function searchWords(text: string): string[] {
  const words: string[] = [];
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 3 || STOP_WORDS.has(raw) || words.includes(raw)) continue;
    // "cakes" should find "cake" and "bakeries" "bakery": a plural is made singular.
    const word = singular(raw);
    if (!words.includes(word)) words.push(word);
    if (words.length === MAX_WORDS) break;
  }
  return words;
}

/** `at://<did>/com.dinakernel.service.profile/<rkey>` → rkey. */
function rkeyOf(uri: string | undefined): string | null {
  if (uri === undefined) return null;
  const rkey = uri.split('/').pop() ?? '';
  return rkey === '' ? null : rkey;
}

function lowerPrice(
  a: { currency: string; minorUnits: string } | undefined,
  b: { currency: string; minorUnits: string } | undefined,
): { currency: string; minorUnits: string } | undefined {
  if (a === undefined) return b;
  if (b === undefined || a.currency !== b.currency) return a;
  return BigInt(b.minorUnits) < BigInt(a.minorUnits) ? b : a;
}

export async function findSuppliers(
  appView: Finder,
  input: FindSuppliersInput,
): Promise<FindSuppliersResult> {
  const words = searchWords(input.text);
  if (words.length === 0) return { suppliers: [], words };
  const blocked = new Set(input.blockedSuppliers ?? []);
  const preferred = new Set(input.preferredSuppliers ?? []);

  interface Row {
    supplierDid: string;
    serviceRkey: string;
    serviceUri: string;
    name: string | null;
    trustScore: number | null | undefined;
    reviewCount: number | null | undefined;
    words: Set<string>;
    items: Set<string>;
    indicativeFrom?: { currency: string; minorUnits: string };
  }
  const rows = new Map<string, Row>();
  const rowFor = (did: string, rkey: string, uri: string): Row => {
    const key = `${did}\n${rkey}`;
    let row = rows.get(key);
    if (row === undefined) {
      row = {
        supplierDid: did,
        serviceRkey: rkey,
        serviceUri: uri,
        name: null,
        trustScore: undefined,
        reviewCount: undefined,
        words: new Set(),
        items: new Set(),
      };
      rows.set(key, row);
    }
    return row;
  };

  const catalogHits = await Promise.all(
    words.map(async (word) => ({
      word,
      candidates: await appView.searchCatalog({
        q: word,
        ...(input.region !== undefined && input.region !== '' ? { region: input.region } : {}),
        limit: RESULTS_PER_SOURCE,
      }),
    })),
  );
  for (const { word, candidates } of catalogHits) {
    for (const c of candidates as CommerceCatalogCandidate[]) {
      const row = rowFor(c.supplierDid, c.serviceRkey, c.serviceUri);
      row.words.add(word);
      row.items.add(`${c.product.scheme}:${c.product.value}`);
      row.indicativeFrom = lowerPrice(row.indicativeFrom, c.indicativePrice);
    }
  }

  const listings = (await appView.searchServices({
    capability: REQUEST_QUOTE_CAPABILITY,
    q: words.join(' '),
    limit: RESULTS_PER_SOURCE,
  })) as (ServiceProfile & { trustScore?: number | null })[];
  for (const listing of listings) {
    const rkey = rkeyOf(listing.uri);
    if (rkey === null) continue;
    const row = rowFor(listing.did, rkey, listing.uri ?? '');
    row.name = listing.name;
    if (listing.trustScore !== undefined) row.trustScore = listing.trustScore;
    const haystack = `${listing.name} ${listing.description ?? ''}`.toLowerCase();
    for (const word of words) if (haystack.includes(word)) row.words.add(word);
  }

  const kept = [...rows.values()].filter((row) => !blocked.has(row.supplierDid));

  // Names for catalog-only suppliers, trust for anyone the search did not
  // score. Each lookup that fails leaves the field null: a supplier is shown
  // by its DID rather than dropped.
  await Promise.all(
    kept.map(async (row) => {
      if (row.name === null && row.serviceUri !== '') {
        try {
          row.name = (await appView.resolveServiceByUri(row.serviceUri))?.name ?? null;
        } catch {
          row.name = null;
        }
      }
      // The review count only matters where it could set the supplier aside:
      // no score yet, or a low one the owner has no review of their own to answer.
      const needsCount =
        row.trustScore === undefined ||
        (row.trustScore !== null &&
          row.trustScore < LOW_TRUST_BELOW &&
          input.ownReviews?.has(row.supplierDid) !== true);
      if (needsCount) {
        try {
          const profile = await appView.getProfile(row.supplierDid);
          if (row.trustScore === undefined) row.trustScore = profile?.overallTrustScore ?? null;
          row.reviewCount = profile?.reviewCount ?? null;
        } catch {
          if (row.trustScore === undefined) row.trustScore = null;
          row.reviewCount = null;
        }
      }
    }),
  );

  const suppliers: SupplierMatch[] = kept
    .map((row) => {
      const ownReview = input.ownReviews?.get(row.supplierDid);
      return {
        supplierDid: row.supplierDid,
        serviceRkey: row.serviceRkey,
        name: row.name,
        trustScore: row.trustScore ?? null,
        reviewCount: row.reviewCount ?? null,
        setAside: setAsideFor({
          ...(ownReview !== undefined ? { ownReview } : {}),
          trustScore: row.trustScore ?? null,
          reviewCount: row.reviewCount ?? null,
        }),
        wordsMatched: row.words.size,
        itemsMatched: row.items.size,
        ...(row.indicativeFrom !== undefined ? { indicativeFrom: row.indicativeFrom } : {}),
        preferred: preferred.has(row.supplierDid),
      };
    })
    .sort(
      (a, b) =>
        // Set aside goes last: still listed, never ahead of a supplier to ask.
        Number(a.setAside !== null) - Number(b.setAside !== null) ||
        Number(b.preferred) - Number(a.preferred) ||
        b.wordsMatched - a.wordsMatched ||
        (b.trustScore ?? -1) - (a.trustScore ?? -1) ||
        b.itemsMatched - a.itemsMatched ||
        a.supplierDid.localeCompare(b.supplierDid),
    );
  return { suppliers, words };
}

/**
 * `findSuppliers` against this surface's AppView: the hosted one on the
 * phone, Brain's read-only proxy on the web (`appViewBase`).
 */
export async function findSuppliersHere(input: FindSuppliersInput): Promise<FindSuppliersResult> {
  const client = new AppViewClient({ appViewURL: await appViewBase(), fetch: appViewFetch });
  // Loaded lazily: the booted node is the phone's; the browser has none.
  const { getBootedNode } = await import('../hooks/useNodeBootstrap');
  const ownReviews =
    input.ownReviews ?? (await loadOwnSupplierReviews(getBootedNode()?.did ?? null));
  return findSuppliers(client, { ...input, ownReviews });
}
