/**
 * Contact service-offer repository — persists `known_only` service offers
 * received over D2D (`service.offer`) as CONTACT metadata in identity.sqlite
 * (`contact_service_offers`, migration v9).
 *
 * A `known_only` listing is never on the network (no PDS/AppView record), so a
 * provider shares it directly with a contact; we store the self-contained offer
 * here. The resolver surfaces it ("my contact offers capability X") before
 * falling back to public discovery, and uses `providerDid` + `serviceUri` +
 * `schemaHash` to issue the eventual `service.query`.
 *
 * **Sync-by-design** — same rationale as `ContactRepository`: a thin wrapper
 * over the exempt sync `DatabaseAdapter`.
 */

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

export interface ServiceOffer {
  /** The provider-issued grant id this offer delivers (PK + upsert key). The
   *  requester echoes it back as `service.query.grant_id`. */
  grantId: string;
  /** Sender DID = the `to_did` for the eventual service.query AND the lookup
   *  key (the resolver maps a contact → DID → offers). Always set. */
  providerDid: string;
  /** The contact, denormalised from the sender DID when cheap; optional. */
  personId?: string;
  capability: string;
  /** The known_only listing's AT-URI (well-formed, not network-resolvable). */
  serviceUri: string;
  serviceName: string;
  schemaHash: string;
  /** Capability params JSON Schema, carried inline on the offer. */
  paramsSchema?: unknown;
  /** Capability result JSON Schema, carried inline on the offer. */
  resultSchema?: unknown;
  defaultTtlSeconds?: number;
  /** Optional offer expiry (unix seconds). */
  expiresAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ServiceOfferRepository {
  /** Insert or replace an offer (keyed by grantId). */
  upsert(offer: ServiceOffer): void;
  /** All offers from a provider DID (newest first). */
  listByProviderDid(providerDid: string): ServiceOffer[];
  /** Offers from a provider DID for a specific capability (newest first). */
  findByProviderDidAndCapability(providerDid: string, capability: string): ServiceOffer[];
  /** All offers, newest first (e.g. for a "services your contacts offer" list). */
  listAll(): ServiceOffer[];
  /** Read one offer by id, or null. */
  get(grantId: string): ServiceOffer | null;
  /** Delete an offer by id. Returns true if a row was removed. */
  remove(grantId: string): boolean;
}

/** Singleton repository (null = not wired / in-memory test). */
let repo: ServiceOfferRepository | null = null;
export function setServiceOfferRepository(r: ServiceOfferRepository | null): void {
  repo = r;
}
export function getServiceOfferRepository(): ServiceOfferRepository | null {
  return repo;
}

function parseJson(v: unknown): unknown {
  if (typeof v !== 'string' || v === '') return undefined;
  try {
    return JSON.parse(v);
  } catch {
    return undefined;
  }
}

function numOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function rowToOffer(r: DBRow): ServiceOffer {
  return {
    grantId: String(r.grant_id),
    providerDid: String(r.provider_did),
    ...(r.person_id != null && r.person_id !== '' ? { personId: String(r.person_id) } : {}),
    capability: String(r.capability),
    serviceUri: String(r.service_uri),
    serviceName: typeof r.service_name === 'string' ? r.service_name : '',
    schemaHash: typeof r.schema_hash === 'string' ? r.schema_hash : '',
    paramsSchema: parseJson(r.params_schema_json),
    resultSchema: parseJson(r.result_schema_json),
    defaultTtlSeconds: numOrUndef(r.default_ttl_seconds),
    expiresAt: numOrUndef(r.expires_at),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

export class SQLiteServiceOfferRepository implements ServiceOfferRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  upsert(offer: ServiceOffer): void {
    if (offer.grantId === '') throw new Error('service_offers.repository: grantId is required');
    if (offer.providerDid === '')
      throw new Error('service_offers.repository: providerDid is required');
    this.db.execute(
      `INSERT INTO contact_service_offers
         (grant_id, provider_did, person_id, capability, service_uri, service_name,
          schema_hash, params_schema_json, result_schema_json, default_ttl_seconds,
          expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(grant_id) DO UPDATE SET
         provider_did = excluded.provider_did,
         person_id = excluded.person_id,
         capability = excluded.capability,
         service_uri = excluded.service_uri,
         service_name = excluded.service_name,
         schema_hash = excluded.schema_hash,
         params_schema_json = excluded.params_schema_json,
         result_schema_json = excluded.result_schema_json,
         default_ttl_seconds = excluded.default_ttl_seconds,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at`,
      [
        offer.grantId,
        offer.providerDid,
        offer.personId ?? null,
        offer.capability,
        offer.serviceUri,
        offer.serviceName,
        offer.schemaHash,
        offer.paramsSchema !== undefined ? JSON.stringify(offer.paramsSchema) : null,
        offer.resultSchema !== undefined ? JSON.stringify(offer.resultSchema) : null,
        offer.defaultTtlSeconds ?? null,
        offer.expiresAt ?? null,
        offer.createdAt,
        offer.updatedAt,
      ],
    );
  }

  listByProviderDid(providerDid: string): ServiceOffer[] {
    const rows = this.db.query(
      'SELECT * FROM contact_service_offers WHERE provider_did = ? ORDER BY updated_at DESC',
      [providerDid],
    );
    return rows.map(rowToOffer);
  }

  findByProviderDidAndCapability(providerDid: string, capability: string): ServiceOffer[] {
    const rows = this.db.query(
      'SELECT * FROM contact_service_offers WHERE provider_did = ? AND capability = ? ORDER BY updated_at DESC',
      [providerDid, capability],
    );
    return rows.map(rowToOffer);
  }

  listAll(): ServiceOffer[] {
    const rows = this.db.query('SELECT * FROM contact_service_offers ORDER BY updated_at DESC');
    return rows.map(rowToOffer);
  }

  get(grantId: string): ServiceOffer | null {
    const rows = this.db.query('SELECT * FROM contact_service_offers WHERE grant_id = ?', [grantId]);
    return rows.length === 0 ? null : rowToOffer(rows[0]);
  }

  remove(grantId: string): boolean {
    const before = this.db.query('SELECT 1 FROM contact_service_offers WHERE grant_id = ?', [
      grantId,
    ]);
    if (before.length === 0) return false;
    this.db.execute('DELETE FROM contact_service_offers WHERE grant_id = ?', [grantId]);
    return true;
  }
}
