/**
 * Install-time authenticity — the verifier CONTRACT (§5 rule 5) plus
 * the pure pieces: identity-pointer invariants and trust anchors.
 *
 * Authenticity is a repo proof, not a CID: a CID proves integrity of
 * what you fetched, not who published it. The full flow — resolve the
 * publisher's DID document → fetch a proof-carrying CAR (MST inclusion
 * path + signed commit) → verify the commit signature against the
 * DID's registered signing key → only then pin the CID — needs network
 * + CAR decoding, which live core-side. This module owns the SHAPE:
 * inputs `(did, collection, rkey)`, output `(cid, rev)` or a typed
 * failure, so every implementation (and the conformance suite) agrees
 * on the contract. AppView is discovery only, never an authenticity
 * authority.
 *
 * Failure UX contract (§5 rule 5): integrity failure = hard refusal,
 * no "install anyway", no trust-on-first-use; transient failure =
 * retry affordance, still no bypass. The typed failure codes below
 * are split along exactly that line.
 *
 * Trust anchors (§12): private distribution is SIGNED distribution.
 * Repo proof is one anchor, not the only one — org keys and
 * owner-trusted local publisher keys run through the same verifier
 * seam with an explicit, named anchor. Unsigned stays debug-only.
 *
 * Pure functions + types. Zero runtime deps.
 */

import { isValidReleaseRkey } from './release_rkey';
import { hasUnsafeText } from './text_safety';
import { PLUGIN_NSIDS } from './types';

import type { PluginIdentityRecord, PluginManifest } from './types';

/**
 * Round-14 #21: a trust anchor's `orgDid` / `keyId` is owner-facing
 * consent text (rendered at install + in the Activity log). Bound its
 * length so a crafted archive can't smuggle an oversized blob through
 * the anchor field. A did:plc is ~32 chars, a did:web a bit longer;
 * 256 is generous headroom without being a data channel.
 */
const MAX_ANCHOR_FIELD_LENGTH = 256;

/** A non-empty, bounded, spoofing-char-free anchor identifier string. */
function isSafeAnchorField(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value !== '' &&
    value.length <= MAX_ANCHOR_FIELD_LENGTH &&
    !hasUnsafeText(value)
  );
}

/** The exact key set each anchor `kind` is allowed to carry (§12). */
const ANCHOR_ALLOWED_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  repo_proof: new Set(['kind']),
  debug_unsigned: new Set(['kind']),
  org_key: new Set(['kind', 'orgDid']),
  local_publisher_key: new Set(['kind', 'keyId']),
};

// ---------------------------------------------------------------------------
// Verifier contract
// ---------------------------------------------------------------------------

/** Explicit, named trust anchor for an install (§12). */
export type PluginTrustAnchor =
  | { readonly kind: 'repo_proof' } // public ATProto release
  | { readonly kind: 'org_key'; readonly orgDid: string } // owner-approved org registry
  | { readonly kind: 'local_publisher_key'; readonly keyId: string } // owner-trusted at install
  | { readonly kind: 'debug_unsigned' }; // dina-plugin dev — DEBUG BUILDS ONLY

/**
 * Round-13 #16: validate a hydrated/restored trust anchor as a proper
 * discriminated union — not just "an object with a string `kind`". A row (from a
 * divergent-node restore or a crafted archive) could carry an unknown `kind`, or
 * an `org_key`/`local_publisher_key` MISSING its required field, and still cast
 * cleanly into `PluginTrustAnchor`. Callers (registry hydration + archive import)
 * quarantine on `false`.
 */
export function isValidTrustAnchor(value: unknown): value is PluginTrustAnchor {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const a = value as { kind?: unknown; orgDid?: unknown; keyId?: unknown };
  if (typeof a.kind !== 'string') return false;
  // Round-14 #21: reject extra keys — a crafted anchor could smuggle fields
  // (e.g. a bogus `orgDid` on a `repo_proof`, or an unrelated payload) that
  // cast cleanly and later leak into rendering or a divergent-node re-export.
  const allowed = ANCHOR_ALLOWED_KEYS[a.kind];
  if (allowed === undefined) return false; // unknown kind
  for (const key of Object.keys(a as Record<string, unknown>)) {
    if (!allowed.has(key)) return false;
  }
  switch (a.kind) {
    case 'repo_proof':
    case 'debug_unsigned':
      return true;
    case 'org_key':
      // Round-14 #21: bound + spoofing-char-check the consent-facing id.
      return isSafeAnchorField(a.orgDid);
    case 'local_publisher_key':
      return isSafeAnchorField(a.keyId);
    default:
      return false;
  }
}

/**
 * Integrity failures — hard refusal, plain-words explanation, no
 * bypass. Transient failures — retry affordance, still no bypass.
 */
export type RepoProofFailureCode =
  // integrity (hard-fail):
  | 'proof_invalid' // MST inclusion path doesn't verify
  | 'signature_invalid' // commit signature vs DID doc signing key
  | 'rkey_mismatch' // rkey != f(cid) — overwritten/forged release (§5)
  | 'record_malformed'
  | 'deleted' // release removed: new-recipient bootstrap fails clearly (§10.1)
  | 'not_found'
  // transient (retry):
  | 'did_resolution_failed'
  | 'fetch_failed';

export interface RepoProofRequest {
  readonly did: string;
  readonly collection: string;
  readonly rkey: string;
}

export interface RepoProofSuccess {
  readonly ok: true;
  readonly cid: string;
  readonly rev: string;
  /** The verified record bytes' parsed value. */
  readonly record: unknown;
}

export interface RepoProofFailure {
  readonly ok: false;
  readonly code: RepoProofFailureCode;
  /** True for did_resolution_failed / fetch_failed — retry affordance. */
  readonly transient: boolean;
  readonly message: string;
}

export type RepoProofResult = RepoProofSuccess | RepoProofFailure;

/**
 * The verifier implementations must satisfy. Core wires the real one
 * (network + CAR + crypto); tests wire fakes against the same seam.
 */
export type RepoProofVerifier = (req: RepoProofRequest) => Promise<RepoProofResult>;

export function repoProofFailure(code: RepoProofFailureCode, message: string): RepoProofFailure {
  return {
    ok: false,
    code,
    transient: code === 'did_resolution_failed' || code === 'fetch_failed',
    message,
  };
}

// ---------------------------------------------------------------------------
// Identity-pointer invariants (§5) — five checks; a pointer failing
// any is treated as NO pointer at all.
// ---------------------------------------------------------------------------

export interface IdentityPointerCheckInput {
  /** The fetched identity record. */
  readonly identity: PluginIdentityRecord;
  /** The rkey the identity record was fetched at. */
  readonly identityRkey: string;
  /** The publisher repo DID both records were fetched from. */
  readonly publisherDid: string;
  /** CID of the release record actually fetched at `current.uri`. */
  readonly fetchedReleaseCid: string;
  /** The release record's manifest (already parsed). */
  readonly release: PluginManifest;
}

export type IdentityPointerViolation =
  | 'wrong_repo' // pointed release not in the same publisher repo
  | 'wrong_collection' // not the release collection
  | 'plugin_id_mismatch' // release plugin_id != identity rkey/plugin_id
  | 'cid_mismatch' // record at current.uri doesn't match current.cid
  | 'version_mismatch'; // current.version != release.version (invariant 5)

/**
 * Check the five pointer invariants. Returns the empty array when the
 * pointer is valid; otherwise every violated invariant (all violations
 * reported — a UI showing "pointer invalid" can say exactly why).
 */
export function checkIdentityPointer(input: IdentityPointerCheckInput): IdentityPointerViolation[] {
  const violations: IdentityPointerViolation[] = [];
  const parsed = parseAtUri(input.identity.current.uri);
  if (parsed === null || parsed.did !== input.publisherDid) {
    violations.push('wrong_repo');
  }
  if (parsed !== null && parsed.collection !== PLUGIN_NSIDS.release) {
    violations.push('wrong_collection');
  }
  if (
    input.release.plugin_id !== input.identity.plugin_id ||
    input.release.plugin_id !== input.identityRkey
  ) {
    violations.push('plugin_id_mismatch');
  }
  if (input.identity.current.cid !== input.fetchedReleaseCid) {
    violations.push('cid_mismatch');
  }
  if (input.identity.current.version !== input.release.version) {
    violations.push('version_mismatch');
  }
  return violations;
}

/**
 * Full release verification composite used by installers: repo-proof
 * result + content-derived rkey check (§5). The rkey check is what
 * makes "immutable" enforced, not assumed — an in-place overwrite
 * fails here at every verifier, with no AppView dependence.
 */
export function checkReleaseIntegrity(args: {
  readonly rkey: string;
  readonly cid: string;
}): RepoProofFailure | null {
  if (!isValidReleaseRkey(args.rkey, args.cid)) {
    return repoProofFailure(
      'rkey_mismatch',
      'release rkey does not match its content hash — the record was overwritten or forged (§5)',
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// AT-URI parsing (at://did/collection/rkey) — minimal, for the pointer
// invariants only.
// ---------------------------------------------------------------------------

export interface ParsedAtUri {
  readonly did: string;
  readonly collection: string;
  readonly rkey: string;
}

export function parseAtUri(uri: string): ParsedAtUri | null {
  if (typeof uri !== 'string' || !uri.startsWith('at://')) return null;
  // Round-15 #18: parse CANONICALLY. A bare slice/split accepted query strings,
  // fragments, whitespace, and percent-encoded separators — so the identity-
  // pointer invariant checker could interpret a URI differently from a
  // canonicalizing repository-fetch implementation (a parser differential this
  // module's SHAPE contract exists to prevent). Reject any URI carrying a
  // query/fragment/whitespace, and reject those chars (plus `/` and `%`) inside
  // any segment. A non-canonical URI is "no pointer at all".
  if (uri !== uri.trim() || /[?#\s]/.test(uri)) return null;
  const parts = uri.slice('at://'.length).split('/');
  if (parts.length !== 3) return null;
  const did = parts[0] ?? '';
  const collection = parts[1] ?? '';
  const rkey = parts[2] ?? '';
  if (did === '' || collection === '' || rkey === '') return null;
  if (!did.startsWith('did:')) return null;
  // No reserved/encoded separators or whitespace inside any segment.
  if ([did, collection, rkey].some((s) => /[?#/%\s]/.test(s))) return null;
  return { did, collection, rkey };
}
