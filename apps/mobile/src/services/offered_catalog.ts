/**
 * What a supplier's own catalogue says about an item it offered, and what
 * PeerLens says about the supplier — the two things the Tender screen shows
 * beside a quote so it reads like the catalogue it came from.
 *
 * The catalogue is read from the supplier's OWN repo, not AppView: AppView
 * indexes a catalogue for search and keeps no photos or pack. The supplier's
 * DID names its PDS (PLC, `#atproto_pds`), the PDS serves the pointer and the
 * snapshot it names (public records, no session), and Core's
 * `readPublishedItem` checks the digests before anything is shown.
 *
 * Presentation only, and never fatal: every failure is "nothing to add", so
 * the screen keeps the quote's own words. Loading a photo does tell the photo
 * host this phone's address, as any image on the web does; the URLs are the
 * supplier's published choice.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import { AppViewClient } from '@dina/brain';
import { defaultFetch, readPublishedItem } from '@dina/core';

import { appViewBase } from '../peerlens/appview_base';

import { lookupPlc } from './plc_lookup';

import type { CatalogItem, ProductRef } from '@dina/core';

const POINTER_NSID = 'com.dinakernel.commerce.catalog';
const SNAPSHOT_NSID = 'com.dinakernel.commerce.catalogSnapshot';
/** A catalogue changes when its supplier republishes; a tender screen is minutes. */
const TTL_MS = 5 * 60_000;

export interface CatalogReadDeps {
  fetchFn?: typeof globalThis.fetch;
  /** The supplier's PDS, from its DID document. */
  pdsOf?: (did: string) => Promise<string | null>;
  now?: () => number;
}

async function pdsFromPlc(did: string): Promise<string | null> {
  const doc = await lookupPlc(did);
  const pds = doc.services.find(
    (s) => s.id.endsWith('#atproto_pds') || s.type === 'AtprotoPersonalDataServer',
  );
  const endpoint = pds?.serviceEndpoint ?? '';
  return endpoint.startsWith('https://') ? endpoint.replace(/\/$/, '') : null;
}

async function getJson(
  fetchFn: typeof globalThis.fetch,
  url: string,
): Promise<Record<string, unknown> | null> {
  const res = await fetchFn(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) return null;
  const body: unknown = await res.json();
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null;
}

/**
 * A product as the tender story names it: the quote line's reference, whose
 * scheme the view carries as plain text. Matching compares scheme and value
 * only, so an unknown scheme simply matches nothing.
 */
export interface OfferedProduct {
  scheme: string;
  value: string;
  issuer_did?: string;
}

const itemCache = new Map<string, { item: CatalogItem | null; expiresAt: number }>();

/** Tests start clean. */
export function resetOfferedCatalogCacheForTest(): void {
  itemCache.clear();
}

/**
 * The supplier's published catalogue item for `product`, verified; null when
 * it lists none, its records do not verify, or it cannot be reached.
 */
export async function publishedItemFor(
  supplierDid: string,
  product: OfferedProduct,
  deps: CatalogReadDeps = {},
): Promise<CatalogItem | null> {
  const now = deps.now ?? Date.now;
  const key = `${supplierDid}|${product.scheme}|${product.value}|${product.issuer_did ?? ''}`;
  const cached = itemCache.get(key);
  if (cached !== undefined && cached.expiresAt > now()) return cached.item;

  const fetchFn = deps.fetchFn ?? defaultFetch();
  let item: CatalogItem | null = null;
  try {
    const pds = await (deps.pdsOf ?? pdsFromPlc)(supplierDid);
    if (pds === null) return null;
    const repo = encodeURIComponent(supplierDid);
    const listed = await getJson(
      fetchFn,
      `${pds}/xrpc/com.atproto.repo.listRecords?repo=${repo}&collection=${POINTER_NSID}&limit=20`,
    );
    const pointers = Array.isArray(listed?.records) ? (listed.records as unknown[]) : [];
    for (const record of pointers) {
      const pointer = (record as { value?: unknown }).value;
      const rkey = (pointer as { snapshot_rkey?: unknown } | undefined)?.snapshot_rkey;
      if (typeof rkey !== 'string' || rkey === '') continue;
      const snapshot = await getJson(
        fetchFn,
        `${pds}/xrpc/com.atproto.repo.getRecord?repo=${repo}&collection=${SNAPSHOT_NSID}&rkey=${encodeURIComponent(rkey)}`,
      );
      const read = readPublishedItem({
        supplierDid,
        pointer,
        snapshotRecord: snapshot?.value,
        product: product as ProductRef,
        sha256,
      });
      if (read.ok && read.item !== null) {
        item = read.item;
        break;
      }
    }
  } catch {
    item = null;
  }
  itemCache.set(key, { item, expiresAt: now() + TTL_MS });
  return item;
}

/** The supplier's PeerLens trust: score and review count, null when unreachable. */
export async function supplierTrustFor(
  supplierDid: string,
): Promise<{ score: number | null; reviewCount: number | null } | null> {
  try {
    const client = new AppViewClient({ appViewURL: await appViewBase() });
    const profile = await client.getProfile(supplierDid);
    return {
      score: profile?.overallTrustScore ?? null,
      reviewCount: profile?.reviewCount ?? null,
    };
  } catch {
    return null;
  }
}
