/**
 * Finding suppliers on the network (HOSTED_DINA §6.1).
 *
 * The PeerLens AppView indexes every supplier's published catalogue. Core does
 * no I/O, so the host installs a directory that asks the AppView (the server
 * wires `com.dinakernel.commerce.searchCatalog` and `peerlens.getProfile`);
 * Core decides what a finding means: whether its trust is good enough for a
 * tender draft to tick it, and never more than that. A finding is a business
 * that SAYS it sells the thing; what the owner trusts is their own list.
 */

export interface SupplierFindingItem {
  /** The catalogue's product reference, `scheme:value`. */
  product: string;
  indicativePrice?: { currency: string; minorUnits: string };
}

export interface SupplierFinding {
  supplierDid: string;
  /** The listing a quote request goes to. */
  serviceRkey: string;
  /** The listing's own name; null when the AppView gave none. */
  name: string | null;
  items: SupplierFindingItem[];
  trust: {
    /** PeerLens trust, 0..1; null for a business nobody has reviewed. */
    score: number | null;
    /** Reviews ABOUT this business. */
    reviews: number;
  };
}

export interface SupplierSearch {
  /** What is needed, in words ("butter croissants"). */
  text: string;
  /** `scheme:value`, e.g. `postal_area:94103`; absent searches everywhere. */
  region?: string;
  limit?: number;
}

export interface SupplierDirectory {
  findSuppliers(search: SupplierSearch): Promise<SupplierFinding[]>;
}

/**
 * Good enough for a tender draft to tick a business the owner never picked:
 * a verdict from several reviewers, not one, and not a poor one. Below this a
 * finding is still offered, unticked.
 *
 * Low on purpose (decided 2026-10-24): PeerLens weighs each review by its
 * reviewer's own standing, so on a young network two positive reviews from
 * new Dinas score about 0.24. A bar of 0.6 would tick no one. The AppView's
 * own floor (0.2 with confidence) already hides the clearly poor.
 */
export const TRUST_GOOD_SCORE = 0.2;
export const TRUST_GOOD_MIN_REVIEWS = 2;

export function trustIsGood(trust: SupplierFinding['trust']): boolean {
  return (
    trust.score !== null &&
    trust.score >= TRUST_GOOD_SCORE &&
    trust.reviews >= TRUST_GOOD_MIN_REVIEWS
  );
}

let directory: SupplierDirectory | null = null;

export function installSupplierDirectory(next: SupplierDirectory | null): void {
  directory = next;
}

export function getSupplierDirectory(): SupplierDirectory | null {
  return directory;
}
