/**
 * Task 6.6 — `resolveDid` → PLC doc.
 *
 * The PLC directory (`plc.directory` by default) is the authority
 * for `did:plc:*` identifiers. Dina Core uses it to resolve a
 * remote peer's DID → full DID document (verification methods,
 * service endpoints, handles) before signing D2D messages or
 * rendering contact cards.
 *
 * This module is the resolver primitive. Three pieces:
 *
 *   1. **`parsePlcDoc(raw)`** — pure parser. Takes a JSON object,
 *      validates the required W3C DID Core + did:plc fields,
 *      returns a structured `PlcDoc` or `null`.
 *   2. **`resolveDid(did, fetchFn)`** — orchestrator. Validates the
 *      DID format + calls the injected `fetchFn` + parses the
 *      response + returns the parsed doc.
 *   3. **Error taxonomy** — `PlcResolveError` with kinds that
 *      discriminate: `invalid_did`, `not_found`, `malformed_doc`,
 *      `network_error`.
 *
 * **Why `fetchFn` is injected**: we don't hardcode the PLC
 * directory URL. Production wires a signed-HTTP client; tests pass
 * scripted fixtures. Caching belongs in a separate module
 * (`CachingPLCResolver` task 6.10) so this primitive stays simple.
 *
 * **Never throws during normal operation** — every failure path
 * funnels into a `{ok: false, kind, detail}` outcome. Callers
 * switch on the kind + decide retry policy.
 *
 * **DID format** — the spec permits `did:plc:[a-z2-7]{24}`
 * (base32-sortable, exactly 24 chars). We validate that; anything
 * else is rejected with `invalid_did`.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 6c task 6.6.
 */

/** AT Protocol DID — `did:plc:<24-char-base32>`. */
export type Did = string;

/** One verification method entry in a DID doc. */
export interface PlcVerificationMethod {
  id: string;
  type: string;
  controller: string;
  /** Multibase-encoded public key (e.g. `zM…` for K-256, `zQ…` for Ed25519). */
  publicKeyMultibase: string;
}

/** One service entry (e.g. PDS endpoint). */
export interface PlcService {
  id: string;
  type: string;
  serviceEndpoint: string;
}

/** Parsed did:plc DID document. */
export interface PlcDoc {
  did: Did;
  /** `at://<handle>` entries — the human-readable aliases for this DID. */
  handles: string[];
  verificationMethods: PlcVerificationMethod[];
  services: PlcService[];
  /** The raw JSON body the PLC directory returned — preserved for audit. */
  raw: Record<string, unknown>;
}

/**
 * Fetcher that production wires to `fetch(plcDirectory + did)`.
 * Returns the parsed JSON body on 200 OK, `null` on 404, throws
 * on other errors (network / 5xx).
 */
export type PlcFetchFn = (did: Did) => Promise<Record<string, unknown> | null>;

export type PlcResolveOutcome =
  | { ok: true; doc: PlcDoc }
  | { ok: false; kind: 'invalid_did'; detail: string }
  | { ok: false; kind: 'not_found' }
  | { ok: false; kind: 'malformed_doc'; detail: string }
  | { ok: false; kind: 'network_error'; error: string };

/** `did:plc:` followed by exactly 24 lowercase base32-sortable chars. */
const DID_PLC_RE = /^did:plc:[a-z2-7]{24}$/;

/**
 * Validate a `did:plc:` identifier. Returns the DID on success
 * (trimmed + normalised) or throws `TypeError` with a specific
 * rejection reason.
 */
export function validatePlcDid(did: unknown): Did {
  if (typeof did !== 'string') {
    throw new TypeError('did must be a string');
  }
  const trimmed = did.trim();
  if (trimmed === '') throw new TypeError('did is empty');
  if (!DID_PLC_RE.test(trimmed)) {
    throw new TypeError(
      `did does not match did:plc:[a-z2-7]{24} (got "${trimmed}")`,
    );
  }
  return trimmed;
}

/**
 * Parse a raw PLC directory response into a structured `PlcDoc`.
 * Returns `null` on any required-field violation. Pure — no I/O.
 */
export function parsePlcDoc(raw: unknown): PlcDoc | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const id = obj.id;
  if (typeof id !== 'string' || !DID_PLC_RE.test(id)) return null;

  const handles = parseHandles(obj.alsoKnownAs);
  const verificationMethods = parseVerificationMethods(obj.verificationMethod);
  if (verificationMethods === null) return null;
  const services = parseServices(obj.service);
  if (services === null) return null;

  return {
    did: id,
    handles,
    verificationMethods,
    services,
    raw: obj,
  };
}

/**
 * Resolve a `did:plc` identifier to its DID document. Orchestrates
 * the three steps: validate → fetch → parse. Never throws.
 */
export async function resolveDid(
  did: Did,
  fetchFn: PlcFetchFn,
): Promise<PlcResolveOutcome> {
  if (typeof fetchFn !== 'function') {
    throw new TypeError('resolveDid: fetchFn is required');
  }
  let normalisedDid: Did;
  try {
    normalisedDid = validatePlcDid(did);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, kind: 'invalid_did', detail: msg };
  }
  let raw: Record<string, unknown> | null;
  try {
    raw = await fetchFn(normalisedDid);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, kind: 'network_error', error: msg };
  }
  if (raw === null) {
    return { ok: false, kind: 'not_found' };
  }
  const doc = parsePlcDoc(raw);
  if (doc === null) {
    return {
      ok: false,
      kind: 'malformed_doc',
      detail: 'required field missing or wrong type',
    };
  }
  if (doc.did !== normalisedDid) {
    // Mismatched `id` — the directory returned a doc for a
    // different DID. Treat as malformed to avoid silent confusion.
    return {
      ok: false,
      kind: 'malformed_doc',
      detail: `doc.id "${doc.did}" does not match requested "${normalisedDid}"`,
    };
  }
  return { ok: true, doc };
}

// ── Internals ──────────────────────────────────────────────────────────

function parseHandles(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v === 'string' && v.startsWith('at://')) {
      out.push(v);
    }
  }
  return out;
}

function parseVerificationMethods(
  raw: unknown,
): PlcVerificationMethod[] | null {
  if (!Array.isArray(raw)) return [];
  const out: PlcVerificationMethod[] = [];
  for (const v of raw) {
    if (v === null || typeof v !== 'object') continue;
    const rec = v as Record<string, unknown>;
    if (typeof rec.id !== 'string' || rec.id === '') return null;
    if (typeof rec.type !== 'string' || rec.type === '') return null;
    if (typeof rec.controller !== 'string' || rec.controller === '') return null;
    if (
      typeof rec.publicKeyMultibase !== 'string' ||
      rec.publicKeyMultibase === ''
    ) {
      return null;
    }
    out.push({
      id: rec.id,
      type: rec.type,
      controller: rec.controller,
      publicKeyMultibase: rec.publicKeyMultibase,
    });
  }
  return out;
}

function parseServices(raw: unknown): PlcService[] | null {
  if (!Array.isArray(raw)) return [];
  const out: PlcService[] = [];
  for (const v of raw) {
    if (v === null || typeof v !== 'object') continue;
    const rec = v as Record<string, unknown>;
    if (typeof rec.id !== 'string' || rec.id === '') return null;
    if (typeof rec.type !== 'string' || rec.type === '') return null;
    if (typeof rec.serviceEndpoint !== 'string' || rec.serviceEndpoint === '') {
      return null;
    }
    out.push({
      id: rec.id,
      type: rec.type,
      serviceEndpoint: rec.serviceEndpoint,
    });
  }
  return out;
}
