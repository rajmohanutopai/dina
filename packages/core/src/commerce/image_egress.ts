/**
 * The image-egress gate (PHOTO_COMMERCE_LANES_DESIGN §3 — the lane doc's
 * Hop 1, carried whole).
 *
 * WHAT LEAVES THE NODE, AND HOW. A photograph of a price list or an order
 * page is the most sensitive artifact either lane holds, and extraction
 * sends it to a hosted vision provider. The design's four requirements are
 * each load-bearing here:
 *
 *   1. A Core-authorized gate WITH a data plane that cannot be walked
 *      around. An authorization alone is advisory — Brain is the untrusted
 *      tenant, and Core approving {hash, provider, purpose} does not stop a
 *      different byte stream leaving. So transmission runs through an
 *      injected BROKER — the only component holding a vision-provider
 *      credential — and the gate re-hashes the actual outgoing bytes
 *      against the authorization immediately before the broker is handed
 *      anything, refusing on mismatch.
 *   2. Single use. The authorization is consumed by CAS before the broker
 *      is invoked; a replay refuses without transmitting.
 *   3. Brain never receives the image. `extractRowsThroughGate` takes an
 *      authorization id and returns ROWS; the bytes travel Core → broker
 *      and nowhere else.
 *   4. Fail closed, provably: the tests cover broker bypass, hash
 *      substitution, authorization replay, wrong provider, and mutation
 *      after authorization — each refused with the broker never invoked.
 *
 * WHY CONSUME-THEN-TRANSMIT rather than transmit-then-consume. Consuming
 * first means a crash between the two burns an authorization without a
 * transmission — the seller re-authorizes, an annoyance. Transmitting
 * first means a crash between the two leaves a spent transmission on an
 * unconsumed row — a replay then transmits AGAIN, a disclosure. The lane
 * chooses the annoyance, the same direction every guard here fails.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';

import {
  EXTRACTION_SCHEMA_CATALOG,
  EXTRACTION_SCHEMA_ORDER,
} from '@dina/commerce-protocol';

import type { DatabaseAdapter } from '../storage/db_adapter';

/** How long a minted authorization stands before it expires unused. */
export const IMAGE_EGRESS_AUTHORIZATION_TTL_MS = 5 * 60 * 1000;

/** The two purposes, one per lane. The schema is derived, never chosen. */
export type ImageEgressPurpose = 'catalog_extraction' | 'order_extraction';

export const SCHEMA_BY_PURPOSE: Readonly<Record<ImageEgressPurpose, string>> = {
  catalog_extraction: EXTRACTION_SCHEMA_CATALOG,
  order_extraction: EXTRACTION_SCHEMA_ORDER,
};

export interface ImageEgressAuthorization {
  authorizationId: string;
  purpose: ImageEgressPurpose;
  provider: string;
  /** Ordered page hashes — the exact bytes this authorization permits out. */
  contentHashes: readonly string[];
  maxBytes: number;
  createdAtMs: number;
  expiresAtMs: number;
  consumedAtMs: number | null;
}

export interface ImageEgressAuthorizationRepository {
  put(record: ImageEgressAuthorization): void;
  get(authorizationId: string): ImageEgressAuthorization | null;
  /** Spend it — true only for the call that moved it to consumed. */
  consume(authorizationId: string, nowMs: number): boolean;
}

export function newEgressAuthorizationId(): string {
  return `egr_${bytesToHex(randomBytes(16))}`;
}

/**
 * What the composition root installs: the ONLY component holding a
 * vision-provider credential or transport. It transmits exactly the pages
 * it is handed — which the gate has already re-hashed against the
 * authorization — and returns raw rows. It validates nothing and decides
 * nothing; Brain validates rows against the schema, Core decides
 * everything else.
 */
export interface ImageEgressBroker {
  /** Which provider this broker speaks for. Pinned into authorizations. */
  readonly provider: string;
  extractRows(args: {
    purpose: ImageEgressPurpose;
    schemaId: string;
    /** EXIF-stripped page bytes, in manifest order. */
    pages: readonly Uint8Array[];
  }): Promise<{
    /**
     * Rows WITH their page attribution — §4.1's numbering is continuous
     * across pages in page order, and only the broker (which performs the
     * per-page provider calls) can say which page produced which rows.
     */
    rows: readonly { page_index: number; cells: Record<string, string> }[];
    model: string;
  }>;
}

/**
 * Where the gate fetches stored, EXIF-stripped page bytes. Implemented by
 * the §6 image artifact store; injected so this module stays pure over the
 * adapter.
 */
export type CommerceImageReader = (artifactId: string) => Uint8Array | null;

let broker: ImageEgressBroker | null = null;

/** Composition-root injection, the `installCatalogRecordWriter` pattern. */
export function installImageEgressBroker(value: ImageEgressBroker | null): void {
  broker = value;
}

export function imageEgressBrokerInstalled(): boolean {
  return broker !== null;
}

/** The installed broker's provider, or null. Authorization mints pin it. */
export function installedEgressProvider(): string | null {
  return broker?.provider ?? null;
}

export type ExtractionThroughGate =
  | {
      ok: true;
      rows: readonly { page_index: number; cells: Record<string, string> }[];
      model: string;
      schemaId: string;
    }
  | { ok: false; refusal: string };

/**
 * The gate. Takes an AUTHORIZATION ID and page artifact ids — never bytes
 * from the caller, never a provider choice, never a schema choice. Refuses
 * before the broker sees anything; the broker is invoked exactly once, on
 * exactly the bytes the authorization pinned.
 */
export async function extractRowsThroughGate(args: {
  authorizations: ImageEgressAuthorizationRepository;
  readImage: CommerceImageReader;
  authorizationId: string;
  /** The manifest's artifact ids, in page order. */
  artifactIds: readonly string[];
  nowMs: number;
}): Promise<ExtractionThroughGate> {
  const installed = broker;
  if (installed === null) {
    return { ok: false, refusal: 'no_egress_broker: this node cannot transmit images' };
  }

  const authorization = args.authorizations.get(args.authorizationId);
  if (authorization === null) {
    return { ok: false, refusal: 'unknown_authorization' };
  }
  if (authorization.consumedAtMs !== null) {
    return { ok: false, refusal: 'authorization_consumed: single use means single use' };
  }
  const age = args.nowMs - authorization.createdAtMs;
  if (age < 0 || args.nowMs >= authorization.expiresAtMs) {
    return { ok: false, refusal: 'authorization_expired' };
  }
  if (authorization.provider !== installed.provider) {
    // The owner consented to ONE provider. A broker for another one is a
    // different disclosure and needs its own authorization.
    return { ok: false, refusal: 'wrong_provider: authorization names a different provider' };
  }
  if (args.artifactIds.length !== authorization.contentHashes.length) {
    return { ok: false, refusal: 'page_count_mismatch' };
  }

  // Fetch and RE-HASH immediately before transmission. The stored artifact
  // may have been mutated, swapped, or replaced since the authorization was
  // minted — the pinned hashes are what the owner's consent covered, and
  // anything else refuses.
  const pages: Uint8Array[] = [];
  let totalBytes = 0;
  for (const [i, artifactId] of args.artifactIds.entries()) {
    const bytes = args.readImage(artifactId);
    if (bytes === null) {
      return { ok: false, refusal: `page_unavailable: ${artifactId}` };
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > authorization.maxBytes) {
      return { ok: false, refusal: 'over_authorized_size' };
    }
    if (bytesToHex(sha256(bytes)) !== authorization.contentHashes[i]) {
      return {
        ok: false,
        refusal: 'content_hash_mismatch: these are not the bytes the owner authorized',
      };
    }
    pages.push(bytes);
  }

  // Consume BEFORE transmitting (see the module comment for why this
  // direction). Losing the CAS means someone else already spent it.
  if (!args.authorizations.consume(args.authorizationId, args.nowMs)) {
    return { ok: false, refusal: 'authorization_consumed: single use means single use' };
  }

  const schemaId = SCHEMA_BY_PURPOSE[authorization.purpose];
  try {
    const result = await installed.extractRows({
      purpose: authorization.purpose,
      schemaId,
      pages,
    });
    return { ok: true, rows: result.rows, model: result.model, schemaId };
  } catch {
    // The transmission may or may not have happened; the authorization
    // stays spent either way, because "maybe transmitted" is exactly the
    // case a replay must not retransmit.
    return { ok: false, refusal: 'provider_failed: extraction did not return rows' };
  }
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

interface AuthorizationRow {
  [column: string]: string | number | Uint8Array | null;
  authorization_id: string;
  purpose: string;
  provider: string;
  content_hashes_json: string;
  max_bytes: number;
  created_at_ms: number;
  expires_at_ms: number;
  consumed_at_ms: number;
}

const HEX64 = /^[0-9a-f]{64}$/;

function hydrate(row: AuthorizationRow): ImageEgressAuthorization | null {
  const purpose = String(row.purpose);
  if (purpose !== 'catalog_extraction' && purpose !== 'order_extraction') return null;
  let hashes: unknown;
  try {
    hashes = JSON.parse(String(row.content_hashes_json));
  } catch {
    return null;
  }
  if (!Array.isArray(hashes) || hashes.length === 0) return null;
  for (const h of hashes) {
    if (typeof h !== 'string' || !HEX64.test(h)) return null;
  }
  return {
    authorizationId: String(row.authorization_id),
    purpose,
    provider: String(row.provider),
    contentHashes: hashes as string[],
    maxBytes: Number(row.max_bytes),
    createdAtMs: Number(row.created_at_ms),
    expiresAtMs: Number(row.expires_at_ms),
    consumedAtMs: Number(row.consumed_at_ms) === 0 ? null : Number(row.consumed_at_ms),
  };
}

export class SQLiteImageEgressAuthorizationRepository
  implements ImageEgressAuthorizationRepository
{
  constructor(private readonly db: DatabaseAdapter) {}

  put(record: ImageEgressAuthorization): void {
    this.db.run(
      `INSERT OR REPLACE INTO commerce_image_egress_authorizations
         (authorization_id, purpose, provider, content_hashes_json, max_bytes,
          created_at_ms, expires_at_ms, consumed_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.authorizationId,
        record.purpose,
        record.provider,
        JSON.stringify(record.contentHashes),
        record.maxBytes,
        record.createdAtMs,
        record.expiresAtMs,
        record.consumedAtMs ?? 0,
      ],
    );
  }

  get(authorizationId: string): ImageEgressAuthorization | null {
    const rows = this.db.query<AuthorizationRow>(
      `SELECT * FROM commerce_image_egress_authorizations WHERE authorization_id = ?`,
      [authorizationId],
    );
    return rows[0] === undefined ? null : hydrate(rows[0]);
  }

  consume(authorizationId: string, nowMs: number): boolean {
    // READ-THEN-WRITE in one transaction rather than `run`'s return value,
    // for the same platform-parity reason every CAS in this package reads
    // back: the base adapter's affected-rows answer differs across
    // adapters, and a CAS that miscounts is not a CAS.
    let spent = false;
    this.db.transaction(() => {
      const before = this.db.query<{ consumed_at_ms: number }>(
        `SELECT consumed_at_ms FROM commerce_image_egress_authorizations
          WHERE authorization_id = ?`,
        [authorizationId],
      );
      if (before[0] === undefined || Number(before[0].consumed_at_ms) !== 0) return;
      this.db.run(
        `UPDATE commerce_image_egress_authorizations SET consumed_at_ms = ?
          WHERE authorization_id = ? AND consumed_at_ms = 0`,
        [nowMs, authorizationId],
      );
      spent = true;
    });
    return spent;
  }
}

export class InMemoryImageEgressAuthorizationRepository
  implements ImageEgressAuthorizationRepository
{
  private readonly rows = new Map<string, ImageEgressAuthorization>();

  put(record: ImageEgressAuthorization): void {
    this.rows.set(record.authorizationId, { ...record, contentHashes: [...record.contentHashes] });
  }

  get(authorizationId: string): ImageEgressAuthorization | null {
    const row = this.rows.get(authorizationId);
    return row === undefined ? null : { ...row, contentHashes: [...row.contentHashes] };
  }

  consume(authorizationId: string, nowMs: number): boolean {
    const row = this.rows.get(authorizationId);
    if (row === undefined || row.consumedAtMs !== null) return false;
    this.rows.set(authorizationId, { ...row, consumedAtMs: nowMs });
    return true;
  }
}
