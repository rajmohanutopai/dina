/**
 * The hosted-profile publication contract (UCP plan §3.5, S11): every node's
 * buyer profile is served by the Dina-run host at `<label>.ucp.dinakernel.com`.
 * The node sends signed envelopes straight to the host; nothing goes to a PDS.
 *
 * One envelope schema for the three operations:
 *  - `upload`: the profile document's hash and the keys it lists (thumbprint,
 *    generation, rotation phase and times);
 *  - `pause`: stop serving; retires nothing ("Turn UCP off");
 *  - `retire`: add thumbprints to the label's permanent retired list, then stop
 *    serving ("My key may be compromised").
 *
 * Each claims exactly the host's current revision + 1 (compare-and-set), under
 * a publisher `epoch` bound to the claiming installation's `instance`. The
 * envelope is signed with the node's root Ed25519 key (`dina_signing` in its DID
 * document) over RFC 8785 canonical JSON of every member but `sig`, the
 * `domain` member separating it from every other signed Dina contract.
 *
 * The label is 128 bits derived from the master seed (HKDF, info
 * `dina:ucp:label:v1`, derived in Core), written as 26 lower-case base32
 * characters; the host parses hostnames strictly (§3.5).
 */

import {
  base64Decode,
  base64Encode,
  bytesToHex,
  canonicalize,
  hasOwn,
  isPlainObject,
  LOWER_HEX_64,
  utf8Bytes,
  type Ed25519SignFn,
  type Ed25519VerifyFn,
  type JsonObject,
} from '@dina/a2a';

import { UCP_VERSION } from './version';

import type { Sha256Fn } from './signatures';

export const PUBLICATION_DOMAIN = 'dina:ucp:profile-publication:v1' as const;
/** The production profile host. A test deployment passes its own name to each function below. */
export const UCP_PROFILE_HOST = 'ucp.dinakernel.com';
/** A host name: lower-case DNS labels. */
const HOST_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
export const LABEL_PATTERN = /^[a-z2-7]{26}$/;
/** HKDF info string for deriving a node's label from its master seed. */
export const LABEL_HKDF_INFO = 'dina:ucp:label:v1';

export const DID_RE = /^did:(?:plc:[a-z2-7]{24}|web:[a-z0-9.:%-]{1,253})$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const THUMBPRINT_RE = /^[A-Za-z0-9_-]{43}$/;

export type PublicationOp = 'upload' | 'pause' | 'retire';
export type KeyPhase = 'staged' | 'active' | 'retiring';

export interface PublishedKey {
  thumbprint: string;
  generation: number;
  phase: KeyPhase;
  /** Epoch ms: a staged key becomes active no earlier than this. */
  not_before?: number;
  /** Epoch ms: a retiring key stays listed until this. */
  retire_after?: number;
}

export interface PublicationEnvelope {
  v: 1;
  domain: typeof PUBLICATION_DOMAIN;
  op: PublicationOp;
  did: string;
  label: string;
  /** The host deployment the envelope is for; an envelope for one host is refused by another. */
  host: string;
  epoch: number;
  instance: string;
  revision: number;
  issued_at: number;
  /** upload only: the UCP version → lowercase sha256 hex of the exact profile bytes. */
  documents?: Record<string, string>;
  /** upload only. */
  keys?: PublishedKey[];
  /** retire only. */
  retire?: string[];
  sig: string;
}

export type PublicationFields = Omit<PublicationEnvelope, 'v' | 'domain' | 'host' | 'sig'>;

// ------------------------------------------------------------ label

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** 16 bytes (128 bits) → 26 lower-case base32 characters, no padding. */
export function labelFromBytes(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new Error('label: expected 16 bytes');
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const b of bytes) {
    buffer = (buffer << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32[(buffer >> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31];
  return out;
}

/** The label a hostname serves, or null: exactly `<label>.<host>` (S11). */
export function labelForHostname(
  hostname: string,
  profileHost: string = UCP_PROFILE_HOST,
): string | null {
  const suffix = `.${profileHost}`;
  const host = hostname.toLowerCase();
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  return LABEL_PATTERN.test(label) ? label : null;
}

export function profileUrlForLabel(label: string, profileHost: string = UCP_PROFILE_HOST): string {
  if (!LABEL_PATTERN.test(label)) throw new Error('label: bad label');
  if (!HOST_NAME.test(profileHost)) throw new Error('label: bad host');
  return `https://${label}.${profileHost}/.well-known/ucp`;
}

/** The drop-box `webhook_url` a node without a public URL lists (S9): it answers 200 and keeps nothing. */
export function dropBoxWebhookUrl(label: string, profileHost: string = UCP_PROFILE_HOST): string {
  if (!LABEL_PATTERN.test(label)) throw new Error('label: bad label');
  return `https://${label}.${profileHost}/webhooks/orders`;
}

// ------------------------------------------------------------ envelope

export function documentHash(profileBytes: string, sha256: Sha256Fn): string {
  return bytesToHex(sha256(utf8Bytes(profileBytes)));
}

function signingBytes(record: Record<string, unknown>): Uint8Array {
  const { sig: _sig, ...unsigned } = record;
  return utf8Bytes(canonicalize(unsigned as JsonObject));
}

export async function signPublication(
  fields: PublicationFields,
  sign: Ed25519SignFn,
  profileHost: string = UCP_PROFILE_HOST,
): Promise<PublicationEnvelope> {
  const unsigned: Omit<PublicationEnvelope, 'sig'> = {
    v: 1,
    domain: PUBLICATION_DOMAIN,
    host: profileHost,
    ...fields,
  };
  const err = validatePublication(
    { ...unsigned, sig: base64Encode(new Uint8Array(64)) },
    profileHost,
  );
  if (err !== null) throw new Error(`publication: ${err}`);
  const sig = await sign(signingBytes(unsigned as unknown as Record<string, unknown>));
  return { ...unsigned, sig: base64Encode(sig) };
}

/** A safe integer, zero or more: every count, epoch, revision and time in the publication contract. */
export function isNonNegInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function membersFor(op: unknown): string[] {
  const base = [
    'v',
    'domain',
    'op',
    'did',
    'label',
    'host',
    'epoch',
    'instance',
    'revision',
    'issued_at',
    'sig',
  ];
  if (op === 'upload') return [...base, 'documents', 'keys'];
  if (op === 'retire') return [...base, 'retire'];
  return base;
}

const KEY_FIELDS = ['generation', 'phase', 'not_before', 'retire_after'];

/**
 * A key's generation, phase and times, checked: exactly these members (plus
 * `thumbprint` when `withThumbprint`), a staged key with its `not_before`, a
 * retiring key with its `retire_after`. The one reader for every place a key
 * record arrives: an envelope, the host's stored state, a public state.
 */
function readKeyRecord(
  value: unknown,
  withThumbprint: boolean,
): (Omit<PublishedKey, 'thumbprint'> & { thumbprint?: string }) | null {
  if (!isPlainObject(value)) return null;
  const allowed = withThumbprint ? ['thumbprint', ...KEY_FIELDS] : KEY_FIELDS;
  if (Object.keys(value).some((key) => !allowed.includes(key))) return null;
  if (
    withThumbprint &&
    (typeof value.thumbprint !== 'string' || !THUMBPRINT_RE.test(value.thumbprint))
  )
    return null;
  const { generation, phase, not_before, retire_after } = value;
  if (!isNonNegInt(generation)) return null;
  if (phase !== 'staged' && phase !== 'active' && phase !== 'retiring') return null;
  if (not_before !== undefined && !isNonNegInt(not_before)) return null;
  if (retire_after !== undefined && !isNonNegInt(retire_after)) return null;
  if (phase === 'staged' && not_before === undefined) return null;
  if (phase === 'retiring' && retire_after === undefined) return null;
  return {
    ...(withThumbprint ? { thumbprint: value.thumbprint as string } : {}),
    generation,
    phase,
    ...(not_before !== undefined ? { not_before } : {}),
    ...(retire_after !== undefined ? { retire_after } : {}),
  };
}

/** A published key (thumbprint, generation, phase, times), or null. */
export function readPublishedKey(value: unknown): PublishedKey | null {
  return readKeyRecord(value, true) as PublishedKey | null;
}

/** A key record without its thumbprint (the host keys its map by thumbprint), or null. */
export function readKeyFields(value: unknown): Omit<PublishedKey, 'thumbprint'> | null {
  return readKeyRecord(value, false);
}

/** Shape check: exact members per operation, bounded values, canonical encodings. */
export function validatePublication(
  value: unknown,
  profileHost: string = UCP_PROFILE_HOST,
): string | null {
  if (!isPlainObject(value)) return 'not_object';
  const expected = membersFor(value.op);
  const own = Object.keys(value);
  if (own.length !== expected.length || !expected.every((k) => hasOwn(value, k))) return 'members';
  if (value.v !== 1) return 'version';
  if (value.domain !== PUBLICATION_DOMAIN) return 'domain';
  if (value.op !== 'upload' && value.op !== 'pause' && value.op !== 'retire') return 'op';
  if (typeof value.did !== 'string' || !DID_RE.test(value.did)) return 'did';
  if (typeof value.label !== 'string' || !LABEL_PATTERN.test(value.label)) return 'label';
  if (value.host !== profileHost) return 'host';
  if (!isNonNegInt(value.epoch)) return 'epoch';
  if (typeof value.instance !== 'string' || !UUID_RE.test(value.instance)) return 'instance';
  if (!isNonNegInt(value.revision) || value.revision < 1) return 'revision';
  if (!isNonNegInt(value.issued_at)) return 'issued_at';
  if (value.op === 'upload') {
    if (!isPlainObject(value.documents)) return 'documents';
    const versions = Object.keys(value.documents);
    if (versions.length !== 1 || versions[0] !== UCP_VERSION) return 'documents';
    if (
      typeof value.documents[UCP_VERSION] !== 'string' ||
      !LOWER_HEX_64.test(value.documents[UCP_VERSION] as string)
    )
      return 'documents';
    if (
      !Array.isArray(value.keys) ||
      value.keys.length === 0 ||
      !value.keys.every((k) => readPublishedKey(k) !== null)
    )
      return 'keys';
    const prints = (value.keys as PublishedKey[]).map((k) => k.thumbprint);
    if (new Set(prints).size !== prints.length) return 'keys';
    if ((value.keys as PublishedKey[]).filter((k) => k.phase === 'active').length !== 1)
      return 'keys';
  }
  if (value.op === 'retire') {
    if (!Array.isArray(value.retire) || value.retire.length === 0) return 'retire';
    if (!value.retire.every((t) => typeof t === 'string' && THUMBPRINT_RE.test(t))) return 'retire';
  }
  if (typeof value.sig !== 'string' || base64Decode(value.sig)?.length !== 64) return 'sig';
  return null;
}

export interface PublicationContext {
  /** The label the request targets (from its path). */
  label: string;
  /** This host's own name (default: production). */
  profileHost?: string;
  /** For uploads: the exact profile bytes received, to check the hash. */
  profileBytes?: string;
}

export type PublicationCheck =
  | { ok: true; envelope: PublicationEnvelope }
  | { ok: false; reason: string };

/**
 * Full check of an envelope against what arrived with it: shape, the label it
 * targets, the document hash, then the signature with the key the DID document
 * names (`dina_signing`, passed in as `ed25519Verify`). Identity and hash come
 * before the signature, so a replayed but validly signed envelope is refused for
 * the right reason. Ownership, epoch and revision are the host's to check
 * against its registry.
 */
export function verifyPublication(
  value: unknown,
  ctx: PublicationContext,
  sha256: Sha256Fn,
  ed25519Verify: Ed25519VerifyFn,
): PublicationCheck {
  const err = validatePublication(value, ctx.profileHost ?? UCP_PROFILE_HOST);
  if (err !== null) return { ok: false, reason: `publication_${err}` };
  const env = value as unknown as PublicationEnvelope;
  if (env.label !== ctx.label) return { ok: false, reason: 'publication_label_mismatch' };
  if (env.op === 'upload') {
    if (ctx.profileBytes === undefined) return { ok: false, reason: 'publication_no_document' };
    if (
      (env.documents as Record<string, string>)[UCP_VERSION] !==
      documentHash(ctx.profileBytes, sha256)
    ) {
      return { ok: false, reason: 'publication_document_hash' };
    }
  }
  const sig = base64Decode(env.sig) as Uint8Array;
  let good = false;
  try {
    good = ed25519Verify(signingBytes(env as unknown as Record<string, unknown>), sig) === true;
  } catch {
    good = false;
  }
  if (!good) return { ok: false, reason: 'publication_signature' };
  return { ok: true, envelope: env };
}
