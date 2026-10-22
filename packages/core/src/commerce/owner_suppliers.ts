/**
 * The owner's own supplier list (HOSTED_DINA §6).
 *
 * A new Dina has no orders and no tenders, so `knownSuppliers()` would find no
 * one to draft a tender with, and the dot must not name suppliers itself. The
 * owner adds them here: a supplier's Dina ID and the listing key its quote
 * requests go to. Only owner routes write it; nothing an agent sends can.
 */

import { isValidServiceListingRkey } from '@dina/protocol';

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

/** How many suppliers one owner list holds. */
export const MAX_OWNER_SUPPLIERS = 200;
/** The longest label the owner may give a supplier. */
export const MAX_SUPPLIER_LABEL = 80;

export interface OwnerSupplier {
  supplierDid: string;
  serviceRkey: string;
  /** The owner's own name for the supplier; '' when none was given. */
  label: string;
  addedAt: number;
}

export interface OwnerSupplierRepository {
  /** Newest first. */
  list(): OwnerSupplier[];
  count(): number;
  /** Adds, or replaces the listing key and label of a supplier already listed. */
  put(supplier: OwnerSupplier): void;
  /** False when the supplier was not listed. */
  remove(supplierDid: string): boolean;
}

function supplierFromRow(row: DBRow): OwnerSupplier {
  return {
    supplierDid: String(row.supplier_did),
    serviceRkey: String(row.service_rkey),
    label: String(row.label),
    addedAt: Number(row.added_at),
  };
}

export class SQLiteOwnerSupplierRepository implements OwnerSupplierRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  list(): OwnerSupplier[] {
    return this.db
      .query(`SELECT * FROM commerce_owner_suppliers ORDER BY added_at DESC, supplier_did`)
      .map(supplierFromRow);
  }

  count(): number {
    const rows = this.db.query(`SELECT COUNT(*) AS n FROM commerce_owner_suppliers`);
    return Number(rows[0]?.n ?? 0);
  }

  put(supplier: OwnerSupplier): void {
    this.db.run(
      `INSERT INTO commerce_owner_suppliers (supplier_did, service_rkey, label, added_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(supplier_did) DO UPDATE SET service_rkey = excluded.service_rkey,
                                               label = excluded.label`,
      [supplier.supplierDid, supplier.serviceRkey, supplier.label, supplier.addedAt],
    );
  }

  remove(supplierDid: string): boolean {
    return (
      this.db.run(`DELETE FROM commerce_owner_suppliers WHERE supplier_did = ?`, [supplierDid]) > 0
    );
  }
}

export type OwnerSupplierInput =
  | { ok: true; supplier: Omit<OwnerSupplier, 'addedAt'> }
  | { ok: false; error: string };

/** Check what the owner typed: a Dina ID, a listing key, an optional label. */
export function parseOwnerSupplier(body: Record<string, unknown>): OwnerSupplierInput {
  const did = typeof body.supplier_did === 'string' ? body.supplier_did.trim() : '';
  if (!/^did:[a-z0-9]+:[A-Za-z0-9._:%-]{1,2048}$/.test(did)) {
    return { ok: false, error: 'supplier_did must be a Dina ID (did:…)' };
  }
  const rkey = typeof body.service_rkey === 'string' ? body.service_rkey.trim() : '';
  if (!isValidServiceListingRkey(rkey)) {
    return { ok: false, error: 'service_rkey must be the supplier’s listing key' };
  }
  const label = typeof body.label === 'string' ? body.label.trim() : '';
  if (label.length > MAX_SUPPLIER_LABEL) {
    return { ok: false, error: `label must be at most ${MAX_SUPPLIER_LABEL} characters` };
  }
  return { ok: true, supplier: { supplierDid: did, serviceRkey: rkey, label } };
}
