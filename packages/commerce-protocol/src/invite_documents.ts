/**
 * The invite ceremony's six messages (TRADE_FIRST_STRATEGY §8) —
 * offered → redeemed → confirmed → acknowledged, with ordered
 * activation, plus the receipt that proves activation and the
 * revocation that unwinds a half-open exchange.
 *
 * DIGEST DISCIPLINE. Every message pins its predecessor's digest and
 * the NONCE keys the whole exchange, so a lost message resolves by
 * idempotent re-send and no message can be replayed into a different
 * exchange. Domains live under their own `dina:commerce:invite:v1:`
 * prefix — a new family beside the closed §9.12 set, the trade/catalog
 * precedent.
 *
 * SIGNATURES. The OFFER alone carries an EMBEDDED signature: the QR /
 * `dinainvite1:` string travels outside any D2D envelope and must prove
 * its own origin. Every relay-delivered message authenticates by its
 * signed envelope, the commerce-records seam — no signature fields on
 * them, ever (`reconcile.ts` states why). Crypto stays out of this
 * package: signing and verification arrive as injected callbacks.
 */

import { bytesToHex, canonicalJson, utf8Bytes } from './canonical';
import { validateDid, validateHex64, validateId, validateIsoUtc, validateProtocolVersionShape } from './common';

import type { Sha256Fn } from './digests';

export const INVITE_DIGEST_PREFIX = 'dina:commerce:invite:v1:';

export const INVITE_DIGEST_DOMAINS = [
  'invite_offer',
  'invite_redemption',
  'invite_confirmation',
  'invite_activation_ack',
  'invite_ack_receipt',
  'invite_revocation',
] as const;
export type InviteDigestDomain = (typeof INVITE_DIGEST_DOMAINS)[number];

export function inviteRecordDigest(
  domain: InviteDigestDomain,
  draft: unknown,
  sha256: Sha256Fn,
): string {
  return bytesToHex(sha256(utf8Bytes(`${INVITE_DIGEST_PREFIX}${domain}\n${canonicalJson(draft)}`)));
}

/** Direction is the INVITER's sentence about the relationship. */
export const INVITE_DIRECTIONS = ['i_supply_you', 'you_supply_me'] as const;
export type InviteDirection = (typeof INVITE_DIRECTIONS)[number];

export const INVITE_REVOCATION_REASONS = ['expired', 'revoked', 'no_activation_proof'] as const;

/** Bounds: an invite names a handful of listings, never a catalog. */
export const MAX_INVITE_RKEYS = 8;
export const MAX_INVITE_CAPABILITIES = 16;

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/consistent-type-definitions --
 * Type aliases, not interfaces, for the same reason the trade documents
 * are: these feed `inviteRecordDigest(draft)` (typed `unknown` →
 * canonical JSON), and interfaces force `as unknown as` double-casts at
 * every digest call — the cast family a prior wire bug shipped through. */

export type InviteOffer = {
  protocol_version: string;
  offer_id: string;
  inviter_did: string;
  /** The inviter's MsgBox relay, so a fresh node can route back. */
  relay_url: string;
  direction: InviteDirection;
  /** The inviter's listing rkeys the grants will be keyed on. */
  service_rkeys: readonly string[];
  /** The capability set the inviter offers to grant. */
  capabilities: readonly string[];
  /** Single-use, unguessable; keys the WHOLE exchange. */
  nonce: string;
  expires_at: string;
  offer_digest: string;
  /** Ed25519 over the digest preimage, hex — see `inviteOfferSigningBytes`. */
  inviter_signature: string;
};

export type InviteRedemption = {
  protocol_version: string;
  redemption_id: string;
  offer_digest: string;
  nonce: string;
  redeemer_did: string;
  /** The redeemer's own rkeys for the REVERSE direction. */
  service_rkeys: readonly string[];
  redeemed_at: string;
  redemption_digest: string;
};

export type InviteConfirmation = {
  protocol_version: string;
  confirmation_id: string;
  redemption_digest: string;
  nonce: string;
  confirmed_at: string;
  confirmation_digest: string;
};

export type InviteActivationAck = {
  protocol_version: string;
  ack_id: string;
  confirmation_digest: string;
  nonce: string;
  activated_at: string;
  ack_digest: string;
};

/** The idempotent pong an ACTIVE inviter answers a re-sent ack with —
 *  the redeemer's activation PROOF (§8: never an idleness guess). */
export type InviteAckReceipt = {
  protocol_version: string;
  receipt_id: string;
  ack_digest: string;
  nonce: string;
  received_at: string;
  receipt_digest: string;
};

export type InviteRevocationNotice = {
  protocol_version: string;
  revocation_id: string;
  nonce: string;
  reason: (typeof INVITE_REVOCATION_REASONS)[number];
  revoked_at: string;
  revocation_digest: string;
};
/* eslint-enable @typescript-eslint/consistent-type-definitions */

// ---------------------------------------------------------------------------
// The offer's embedded signature
// ---------------------------------------------------------------------------

/**
 * The exact bytes the inviter signs: domain-separated over the OFFER
 * DIGEST, not over the JSON — re-canonicalizing at verify time would
 * make the signature's validity depend on a serializer agreeing with
 * itself twice.
 */
export function inviteOfferSigningBytes(offerDigest: string): Uint8Array {
  return utf8Bytes(`${INVITE_DIGEST_PREFIX}offer_signature\n${offerDigest}`);
}

// ---------------------------------------------------------------------------
// Validators — shape first, then digest recomputation
// ---------------------------------------------------------------------------

function validateRkeys(value: unknown, field: string): string | null {
  if (!Array.isArray(value)) return `${field}: must be an array`;
  if (value.length === 0) return `${field}: must name at least one rkey`;
  if (value.length > MAX_INVITE_RKEYS) return `${field}: too many rkeys`;
  for (const [i, entry] of value.entries()) {
    const bad = validateId(entry, `${field}[${String(i)}]`);
    if (bad !== null) return bad;
  }
  if (new Set(value).size !== value.length) return `${field}: duplicate rkeys`;
  return null;
}

function digestMismatch(
  domain: InviteDigestDomain,
  record: Record<string, unknown>,
  digestField: string,
  sha256: Sha256Fn,
  /** Fields OUTSIDE the digest preimage (the offer's signature). */
  alsoExclude: readonly string[] = [],
): string | null {
  const draft: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === digestField || alsoExclude.includes(key)) continue;
    draft[key] = value;
  }
  if (inviteRecordDigest(domain, draft, sha256) !== record[digestField]) {
    return `${digestField}: does not match the record it sits on`;
  }
  return null;
}

export function validateInviteOffer(value: unknown, sha256: Sha256Fn): string | null {
  if (value === null || typeof value !== 'object') return 'offer: must be an object';
  const o = value as Partial<InviteOffer> & Record<string, unknown>;
  return (
    validateProtocolVersionShape(o.protocol_version, 'offer.protocol_version') ??
    validateId(o.offer_id, 'offer.offer_id') ??
    validateDid(o.inviter_did, 'offer.inviter_did') ??
    (typeof o.relay_url === 'string' && /^wss?:\/\//.test(o.relay_url)
      ? null
      : 'offer.relay_url: must be a ws:// or wss:// URL') ??
    ((INVITE_DIRECTIONS as readonly string[]).includes(o.direction as string)
      ? null
      : 'offer.direction: unknown direction') ??
    validateRkeys(o.service_rkeys, 'offer.service_rkeys') ??
    (Array.isArray(o.capabilities) &&
    o.capabilities.length > 0 &&
    o.capabilities.length <= MAX_INVITE_CAPABILITIES &&
    o.capabilities.every((c) => typeof c === 'string' && c !== '' && c.length <= 200)
      ? null
      : 'offer.capabilities: must be 1..16 non-empty strings') ??
    validateHex64(o.nonce, 'offer.nonce') ??
    validateIsoUtc(o.expires_at, 'offer.expires_at') ??
    validateHex64(o.offer_digest, 'offer.offer_digest') ??
    (typeof o.inviter_signature === 'string' && /^[0-9a-f]{128}$/.test(o.inviter_signature)
      ? null
      : 'offer.inviter_signature: must be 128 hex chars') ??
    digestMismatch('invite_offer', o, 'offer_digest', sha256, ['inviter_signature'])
  );
}

export function validateInviteRedemption(value: unknown, sha256: Sha256Fn): string | null {
  if (value === null || typeof value !== 'object') return 'redemption: must be an object';
  const r = value as Partial<InviteRedemption> & Record<string, unknown>;
  return (
    validateProtocolVersionShape(r.protocol_version, 'redemption.protocol_version') ??
    validateId(r.redemption_id, 'redemption.redemption_id') ??
    validateHex64(r.offer_digest, 'redemption.offer_digest') ??
    validateHex64(r.nonce, 'redemption.nonce') ??
    validateDid(r.redeemer_did, 'redemption.redeemer_did') ??
    validateRkeys(r.service_rkeys, 'redemption.service_rkeys') ??
    validateIsoUtc(r.redeemed_at, 'redemption.redeemed_at') ??
    validateHex64(r.redemption_digest, 'redemption.redemption_digest') ??
    digestMismatch('invite_redemption', r, 'redemption_digest', sha256)
  );
}

export function validateInviteConfirmation(value: unknown, sha256: Sha256Fn): string | null {
  if (value === null || typeof value !== 'object') return 'confirmation: must be an object';
  const c = value as Partial<InviteConfirmation> & Record<string, unknown>;
  return (
    validateProtocolVersionShape(c.protocol_version, 'confirmation.protocol_version') ??
    validateId(c.confirmation_id, 'confirmation.confirmation_id') ??
    validateHex64(c.redemption_digest, 'confirmation.redemption_digest') ??
    validateHex64(c.nonce, 'confirmation.nonce') ??
    validateIsoUtc(c.confirmed_at, 'confirmation.confirmed_at') ??
    validateHex64(c.confirmation_digest, 'confirmation.confirmation_digest') ??
    digestMismatch('invite_confirmation', c, 'confirmation_digest', sha256)
  );
}

export function validateInviteActivationAck(value: unknown, sha256: Sha256Fn): string | null {
  if (value === null || typeof value !== 'object') return 'ack: must be an object';
  const a = value as Partial<InviteActivationAck> & Record<string, unknown>;
  return (
    validateProtocolVersionShape(a.protocol_version, 'ack.protocol_version') ??
    validateId(a.ack_id, 'ack.ack_id') ??
    validateHex64(a.confirmation_digest, 'ack.confirmation_digest') ??
    validateHex64(a.nonce, 'ack.nonce') ??
    validateIsoUtc(a.activated_at, 'ack.activated_at') ??
    validateHex64(a.ack_digest, 'ack.ack_digest') ??
    digestMismatch('invite_activation_ack', a, 'ack_digest', sha256)
  );
}

export function validateInviteAckReceipt(value: unknown, sha256: Sha256Fn): string | null {
  if (value === null || typeof value !== 'object') return 'receipt: must be an object';
  const r = value as Partial<InviteAckReceipt> & Record<string, unknown>;
  return (
    validateProtocolVersionShape(r.protocol_version, 'receipt.protocol_version') ??
    validateId(r.receipt_id, 'receipt.receipt_id') ??
    validateHex64(r.ack_digest, 'receipt.ack_digest') ??
    validateHex64(r.nonce, 'receipt.nonce') ??
    validateIsoUtc(r.received_at, 'receipt.received_at') ??
    validateHex64(r.receipt_digest, 'receipt.receipt_digest') ??
    digestMismatch('invite_ack_receipt', r, 'receipt_digest', sha256)
  );
}

export function validateInviteRevocationNotice(value: unknown, sha256: Sha256Fn): string | null {
  if (value === null || typeof value !== 'object') return 'revocation: must be an object';
  const r = value as Partial<InviteRevocationNotice> & Record<string, unknown>;
  return (
    validateProtocolVersionShape(r.protocol_version, 'revocation.protocol_version') ??
    validateId(r.revocation_id, 'revocation.revocation_id') ??
    validateHex64(r.nonce, 'revocation.nonce') ??
    ((INVITE_REVOCATION_REASONS as readonly string[]).includes(r.reason as string)
      ? null
      : 'revocation.reason: unknown reason') ??
    validateIsoUtc(r.revoked_at, 'revocation.revoked_at') ??
    validateHex64(r.revocation_digest, 'revocation.revocation_digest') ??
    digestMismatch('invite_revocation', r, 'revocation_digest', sha256)
  );
}

// ---------------------------------------------------------------------------
// The QR / paste string
// ---------------------------------------------------------------------------

/**
 * `dinainvite1:` + base64url(JSON of the offer). A DISTINCT prefix from
 * the `dina1:` device setup code, deliberately: the pairing parser must
 * never swallow an invite (an invite creates a PEER, never a device —
 * §8's hard rule), and a distinct prefix closes that at the first byte.
 */
export const INVITE_CODE_PREFIX = 'dinainvite1:';

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function b64urlEncode(bytes: Uint8Array): string {
  const at = (index: number): number => bytes[index] ?? 0;
  const ch = (index: number): string => B64URL[index] ?? '';
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (at(i) << 16) | (at(i + 1) << 8) | at(i + 2);
    out += ch((n >> 18) & 63) + ch((n >> 12) & 63) + ch((n >> 6) & 63) + ch(n & 63);
  }
  if (i < bytes.length) {
    const remaining = bytes.length - i;
    const n = (at(i) << 16) | ((remaining > 1 ? at(i + 1) : 0) << 8);
    out += ch((n >> 18) & 63) + ch((n >> 12) & 63);
    if (remaining > 1) out += ch((n >> 6) & 63);
  }
  return out;
}

function b64urlDecode(text: string): Uint8Array | null {
  const values: number[] = [];
  for (const ch of text) {
    const v = B64URL.indexOf(ch);
    if (v === -1) return null;
    values.push(v);
  }
  const out: number[] = [];
  for (let i = 0; i + 1 < values.length; i += 4) {
    const n =
      ((values[i] ?? 0) << 18) |
      ((values[i + 1] ?? 0) << 12) |
      ((values[i + 2] ?? 0) << 6) |
      (values[i + 3] ?? 0);
    out.push((n >> 16) & 255);
    if (i + 2 < values.length) out.push((n >> 8) & 255);
    if (i + 3 < values.length) out.push(n & 255);
  }
  return new Uint8Array(out);
}

export function encodeInviteCode(offer: InviteOffer): string {
  return INVITE_CODE_PREFIX + b64urlEncode(utf8Bytes(JSON.stringify(offer)));
}

/** Decode + VALIDATE, or say why not. Never returns an unchecked shape. */
export function decodeInviteCode(
  raw: string,
  sha256: Sha256Fn,
): { offer: InviteOffer } | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed.startsWith(INVITE_CODE_PREFIX)) {
    return { error: 'not an invite code' };
  }
  const bytes = b64urlDecode(trimmed.slice(INVITE_CODE_PREFIX.length));
  if (bytes === null) return { error: 'invite code is not base64url' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { error: 'invite code does not decode to JSON' };
  }
  const bad = validateInviteOffer(parsed, sha256);
  if (bad !== null) return { error: bad };
  return { offer: parsed as InviteOffer };
}
