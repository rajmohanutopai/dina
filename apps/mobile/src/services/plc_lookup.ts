/**
 * PLC document fetcher — used by the IdentityModal to render the full
 * DID document (alsoKnownAs, verification methods, services) on tap.
 *
 * Reads directly from `https://plc.directory/{did}`. The resolver in
 * `@dina/core` already does this for D2D routing, but its return shape
 * is wrapped in a `ResolvedDID` envelope and its cache lifetime is
 * tuned for routing — too long for a "show me what's published right
 * now" UI surface.
 *
 * In-memory cache with a short TTL (60 s) so a user tapping multiple
 * peers in quick succession doesn't refetch each one, but a stale
 * value never lingers across screens.
 */

const PLC_DIRECTORY = 'https://plc.directory';
const TTL_MS = 60_000;

export interface PlcLookupResult {
  /** The DID this document belongs to (echoed for caller convenience). */
  did: string;
  /**
   * Canonical handle from `alsoKnownAs[0]` minus the `at://` scheme
   * prefix. Null when the doc has no `alsoKnownAs` entries — e.g. a
   * brand-new DID whose owner hasn't published a handle yet.
   */
  handle: string | null;
  /** All `alsoKnownAs` entries verbatim (still includes the `at://` prefix). */
  alsoKnownAs: string[];
  /** Verification methods (signing keys) as published. */
  verificationMethods: Array<{
    id: string;
    type: string;
    controller: string;
    publicKeyMultibase?: string;
  }>;
  /** Service endpoints (MsgBox, direct HTTPS, etc) as published. */
  services: Array<{
    id: string;
    type: string;
    serviceEndpoint: string;
  }>;
  /** ISO 8601 PLC creation timestamp when the directory exposes it. */
  created: string | null;
}

interface CacheEntry {
  result: PlcLookupResult;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Fetch a DID document from PLC and project it into the shape the UI
 * actually renders. Throws on network / 404 / malformed-doc; the
 * caller is expected to handle those by showing an error state, not
 * by silent fallback (the modal needs to make it clear that
 * "couldn't reach plc.directory" is different from "this DID has
 * no handle published").
 */
export async function lookupPlc(
  did: string,
  options?: { fetchFn?: typeof globalThis.fetch; plcDirectory?: string },
): Promise<PlcLookupResult> {
  const fetchFn = options?.fetchFn ?? globalThis.fetch;
  const directory = (options?.plcDirectory ?? PLC_DIRECTORY).replace(/\/$/, '');

  const cached = cache.get(did);
  if (cached !== undefined && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  const res = await fetchFn(`${directory}/${did}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(
      res.status === 404
        ? `${did} is not registered on plc.directory`
        : `plc.directory returned HTTP ${res.status}`,
    );
  }
  const doc = (await res.json()) as Record<string, unknown>;
  if (typeof doc.id !== 'string' || doc.id !== did) {
    throw new Error('plc.directory returned a document for a different DID');
  }

  const result = projectDoc(did, doc);
  cache.set(did, { result, expiresAt: Date.now() + TTL_MS });
  return result;
}

function projectDoc(did: string, doc: Record<string, unknown>): PlcLookupResult {
  const alsoKnownAsRaw = doc.alsoKnownAs;
  const alsoKnownAs: string[] = Array.isArray(alsoKnownAsRaw)
    ? alsoKnownAsRaw.filter((v): v is string => typeof v === 'string')
    : [];

  // Strip `at://` prefix so consumers can render `alice.pds.…` rather
  // than `at://alice.pds.…` — the prefix is implementation noise from
  // AT Protocol's URI scheme.
  let handle: string | null = null;
  if (alsoKnownAs.length > 0) {
    const first = alsoKnownAs[0];
    handle = first.startsWith('at://') ? first.slice('at://'.length) : first;
    if (handle === '') handle = null;
  }

  const vmsRaw = doc.verificationMethod;
  const verificationMethods: PlcLookupResult['verificationMethods'] =
    Array.isArray(vmsRaw)
      ? vmsRaw
          .filter((v): v is Record<string, unknown> => v !== null && typeof v === 'object')
          .map((v) => ({
            id: typeof v.id === 'string' ? v.id : '',
            type: typeof v.type === 'string' ? v.type : '',
            controller: typeof v.controller === 'string' ? v.controller : '',
            publicKeyMultibase:
              typeof v.publicKeyMultibase === 'string' ? v.publicKeyMultibase : undefined,
          }))
      : [];

  const svcRaw = doc.service;
  const services: PlcLookupResult['services'] = Array.isArray(svcRaw)
    ? svcRaw
        .filter((v): v is Record<string, unknown> => v !== null && typeof v === 'object')
        .map((v) => ({
          id: typeof v.id === 'string' ? v.id : '',
          type: typeof v.type === 'string' ? v.type : '',
          serviceEndpoint: typeof v.serviceEndpoint === 'string' ? v.serviceEndpoint : '',
        }))
    : [];

  return {
    did,
    handle,
    alsoKnownAs,
    verificationMethods,
    services,
    created: typeof doc.created === 'string' ? doc.created : null,
  };
}

/** Drop the cached entry for one DID — used when "Refresh" is tapped. */
export function invalidatePlcCache(did: string): void {
  cache.delete(did);
}

/** Clear the entire cache — used on local data wipe + tests. */
export function clearPlcCache(): void {
  cache.clear();
}
