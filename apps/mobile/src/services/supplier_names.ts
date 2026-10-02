/**
 * Names for suppliers the owner would otherwise see as a DID (the Tender
 * screen's offers, a tender's excluded rows). Core's tender records carry
 * only DIDs, so the name is resolved here: the owner's own contact name
 * first (their word for this supplier), then the supplier's public listing
 * name, else nothing and the caller shows a short DID. The listing
 * placeholder ("Commerce", from a supplier that listed before naming its
 * business) is not a name.
 *
 * Resolved names are cached for the session: the Tender screen refreshes
 * every few seconds and a supplier's name does not change under it.
 */

import { AppViewClient } from '@dina/brain';
import { PLACEHOLDER_LISTING_NAME } from '@dina/core';

import { appViewBase } from '../peerlens/appview_base';

import { loadContacts } from './contacts_source';

import type { PlacedOrderDto } from '@dina/core';

export interface SupplierRef {
  supplierDid: string;
  /** The listing the supplier answered under; `self` when unknown. */
  serviceRkey?: string;
}

export interface SupplierNameSources {
  contacts: () => Promise<readonly { did: string; displayName: string }[]>;
  listingName: (supplierDid: string, serviceRkey: string) => Promise<string | null>;
}

const cache = new Map<string, string | null>();

/** Test seam: forget what was resolved. */
export function resetSupplierNameCache(): void {
  cache.clear();
}

/** DID → name, or null where no name is known. Never throws. */
export async function resolveSupplierNames(
  refs: readonly SupplierRef[],
  sources: SupplierNameSources,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const pending = refs.filter((r) => {
    if (!cache.has(r.supplierDid)) return true;
    out.set(r.supplierDid, cache.get(r.supplierDid) ?? null);
    return false;
  });
  if (pending.length === 0) return out;
  let contacts = new Map<string, string>();
  try {
    contacts = new Map(
      (await sources.contacts())
        .filter((c) => c.displayName.trim() !== '')
        .map((c) => [c.did, c.displayName.trim()]),
    );
  } catch {
    // No contact names this time; the listing names still help.
  }
  await Promise.all(
    pending.map(async (ref) => {
      let name: string | null = contacts.get(ref.supplierDid) ?? null;
      if (name === null) {
        let listed: string | null;
        try {
          listed =
            (await sources.listingName(ref.supplierDid, ref.serviceRkey ?? 'self'))?.trim() ?? null;
        } catch {
          // A failed lookup is not remembered, so the next refresh can try again.
          out.set(ref.supplierDid, null);
          return;
        }
        name =
          listed !== null && listed !== '' && listed !== PLACEHOLDER_LISTING_NAME ? listed : null;
      }
      cache.set(ref.supplierDid, name);
      out.set(ref.supplierDid, name);
    }),
  );
  return out;
}

/** The live sources: the contact directory and the AppView (Brain's proxy on the web). */
export async function supplierNamesHere(
  refs: readonly SupplierRef[],
): Promise<Map<string, string | null>> {
  const appView = new AppViewClient({ appViewURL: await appViewBase() });
  return resolveSupplierNames(refs, {
    contacts: loadContacts,
    listingName: async (did, rkey) =>
      (await appView.resolveServiceByUri(`at://${did}/com.dinakernel.service.profile/${rkey}`))
        ?.name ?? null,
  });
}

/** A placed order's supplier, under the listing the order came from. */
export function placedOrderRefs(orders: readonly PlacedOrderDto[]): SupplierRef[] {
  return orders.map((o) => ({
    supplierDid: o.supplierDid,
    ...(o.serviceRkey ? { serviceRkey: o.serviceRkey } : {}),
  }));
}

/** `did:plc:abcd…wxyz` — enough to tell two suppliers apart. */
export function shortDid(did: string): string {
  return did.length > 20 ? `${did.slice(0, 12)}…${did.slice(-4)}` : did;
}

/**
 * A listing's name is the supplier's own claim, and two suppliers may claim
 * the same one (or copy a trusted one). Where a name is shared on screen, the
 * DID goes beside it so the buyer can tell them apart.
 */
export function supplierLabels(
  suppliers: readonly { supplierDid: string; name: string | null }[],
): Map<string, string> {
  const dids = new Map<string, Set<string>>();
  for (const s of suppliers) {
    if (s.name === null) continue;
    const set = dids.get(s.name) ?? new Set<string>();
    set.add(s.supplierDid);
    dids.set(s.name, set);
  }
  const labels = new Map<string, string>();
  for (const s of suppliers) {
    const shared = s.name !== null && (dids.get(s.name)?.size ?? 0) > 1;
    labels.set(
      s.supplierDid,
      s.name === null
        ? shortDid(s.supplierDid)
        : shared
          ? `${s.name} · ${shortDid(s.supplierDid)}`
          : s.name,
    );
  }
  return labels;
}
