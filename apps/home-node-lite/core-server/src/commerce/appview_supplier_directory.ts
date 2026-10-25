/**
 * HOSTED_DINA §6.1 — the supplier directory Core asks, backed by the PeerLens
 * AppView: `commerce.searchCatalog` finds who sells the thing in the area,
 * `service.getByUri` gives each listing's name, `peerlens.getProfile` its
 * trust. One finding per supplier; a name or trust read that fails leaves
 * that field empty and keeps the finding.
 */

import type { SupplierDirectory, SupplierFinding } from '@dina/core';

/** The AppView calls this needs; `AppViewClient` has them all. */
export interface SupplierDirectoryAppView {
  searchCatalog(params: { q?: string; region?: string; limit?: number }): Promise<
    {
      supplierDid: string;
      serviceUri: string;
      serviceRkey: string;
      product: { scheme: string; value: string };
      indicativePrice?: { currency: string; minorUnits: string };
    }[]
  >;
  resolveServiceByUri(uri: string): Promise<{ name: string } | null>;
  getProfile(
    did: string,
  ): Promise<{ overallTrustScore: number | null; reviewCount?: number } | null>;
}

/** Suppliers one search looks up names and trust for. */
const MAX_SUPPLIERS = 10;

export function createAppViewSupplierDirectory(
  appView: SupplierDirectoryAppView,
): SupplierDirectory {
  return {
    async listingName(supplierDid, serviceRkey) {
      const listing = await appView.resolveServiceByUri(
        `at://${supplierDid}/com.dinakernel.service.profile/${serviceRkey}`,
      );
      return listing?.name ?? null;
    },
    async findSuppliers({ text, region, limit }) {
      const candidates = await appView.searchCatalog({
        q: text,
        ...(region !== undefined ? { region } : {}),
        limit: 50,
      });
      const bySupplier = new Map<
        string,
        { uri: string; rkey: string; items: SupplierFinding['items'] }
      >();
      for (const c of candidates) {
        let entry = bySupplier.get(c.supplierDid);
        if (entry === undefined) {
          if (bySupplier.size >= Math.min(limit ?? MAX_SUPPLIERS, MAX_SUPPLIERS)) continue;
          entry = { uri: c.serviceUri, rkey: c.serviceRkey, items: [] };
          bySupplier.set(c.supplierDid, entry);
        }
        entry.items.push({
          product: `${c.product.scheme}:${c.product.value}`,
          ...(c.indicativePrice !== undefined ? { indicativePrice: c.indicativePrice } : {}),
        });
      }
      return Promise.all(
        [...bySupplier.entries()].map(async ([did, entry]) => {
          const [listing, profile] = await Promise.all([
            appView.resolveServiceByUri(entry.uri).catch(() => null),
            appView.getProfile(did).catch(() => null),
          ]);
          return {
            supplierDid: did,
            serviceRkey: entry.rkey,
            name: listing?.name ?? null,
            items: entry.items,
            trust: {
              score: profile?.overallTrustScore ?? null,
              reviews: profile?.reviewCount ?? 0,
            },
          };
        }),
      );
    },
  };
}
