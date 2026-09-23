/**
 * The catalogue's remembered source (JIFFY_MERCHANT_INTEGRATION_PLAN §3.1,
 * A1).
 *
 * WHY A BINDING EXISTS. The owner's `from_connector` call names a connector
 * kind, a broker credential resource, an operation and a default scheme, and
 * Dina pulls once. A granted integration may later ask for the same pull
 * again — a refresh — but it may not name any of those four: a caller who
 * could would be choosing which credential Dina spends and which endpoint it
 * reads, which is the owner's consent (§6.5) and nobody else's. So the
 * owner's successful bind is written here, keyed by catalogue, and a refresh
 * reads the row and NOTHING from its own body.
 *
 * WHAT IS NOT HERE. The credential (the broker holds it; this is its name),
 * the rows read, and the upload kind — a file the owner uploaded has no
 * source to pull again, so binding one is refused at the type.
 */

import type { ConnectorKind } from './connectors';
import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

/** The kinds a refresh can pull again: networked ones only. */
export type RefreshableConnectorKind = Exclude<ConnectorKind, 'spreadsheet_upload'>;

export interface CatalogSourceBinding {
  catalogId: string;
  kind: RefreshableConnectorKind;
  /** The broker resource NAME, or null for a public endpoint. */
  credentialResource: string | null;
  operation: string;
  defaultScheme: 'gtin' | 'sku';
  /** The listing the catalogue publishes under, when the owner named one. */
  serviceRkey: string | null;
  boundAt: number;
}

export interface CatalogSourceBindingRepository {
  get(catalogId: string): CatalogSourceBinding | null;
  /** Every bound catalogue, by id — the status door lists bound-but-unpublished ones from here. */
  list(): CatalogSourceBinding[];
  /** The owner's bind; replaces the prior binding for the catalogue. */
  put(binding: CatalogSourceBinding): void;
  delete(catalogId: string): void;
}

export function isRefreshableConnectorKind(kind: ConnectorKind): kind is RefreshableConnectorKind {
  return kind === 'spreadsheet_url' || kind === 'rest';
}

function bindingFromRow(row: DBRow): CatalogSourceBinding {
  const kind = String(row.kind);
  const scheme = String(row.default_scheme);
  return {
    catalogId: String(row.catalog_id),
    kind: kind === 'rest' ? 'rest' : 'spreadsheet_url',
    credentialResource:
      row.credential_resource === null || row.credential_resource === undefined
        ? null
        : String(row.credential_resource),
    operation: String(row.operation),
    defaultScheme: scheme === 'sku' ? 'sku' : 'gtin',
    serviceRkey:
      row.service_rkey === null || row.service_rkey === undefined ? null : String(row.service_rkey),
    boundAt: Number(row.bound_at),
  };
}

export class SQLiteCatalogSourceBindingRepository implements CatalogSourceBindingRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  get(catalogId: string): CatalogSourceBinding | null {
    const rows = this.db.query(
      `SELECT * FROM commerce_catalog_source_bindings WHERE catalog_id = ?`,
      [catalogId],
    );
    return rows[0] === undefined ? null : bindingFromRow(rows[0]);
  }

  list(): CatalogSourceBinding[] {
    return this.db
      .query(`SELECT * FROM commerce_catalog_source_bindings ORDER BY catalog_id`)
      .map(bindingFromRow);
  }

  put(binding: CatalogSourceBinding): void {
    this.db.run(
      `INSERT OR REPLACE INTO commerce_catalog_source_bindings
         (catalog_id, kind, credential_resource, operation, default_scheme, service_rkey, bound_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        binding.catalogId,
        binding.kind,
        binding.credentialResource,
        binding.operation,
        binding.defaultScheme,
        binding.serviceRkey,
        binding.boundAt,
      ],
    );
  }

  delete(catalogId: string): void {
    this.db.run(`DELETE FROM commerce_catalog_source_bindings WHERE catalog_id = ?`, [catalogId]);
  }
}

export class InMemoryCatalogSourceBindingRepository implements CatalogSourceBindingRepository {
  private readonly rows = new Map<string, CatalogSourceBinding>();

  get(catalogId: string): CatalogSourceBinding | null {
    const row = this.rows.get(catalogId);
    return row === undefined ? null : { ...row };
  }

  list(): CatalogSourceBinding[] {
    return [...this.rows.values()]
      .map((row) => ({ ...row }))
      .sort((a, b) => a.catalogId.localeCompare(b.catalogId));
  }

  put(binding: CatalogSourceBinding): void {
    this.rows.set(binding.catalogId, { ...binding });
  }

  delete(catalogId: string): void {
    this.rows.delete(catalogId);
  }
}
