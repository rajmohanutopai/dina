/**
 * Permission token — short-lived HMAC-signed capability tokens.
 *
 * Callers that need stateless, short-lived authorization (a
 * "sign once, present the token to unlock the next step" pattern)
 * use this primitive. Typical uses:
 *
 *   - Pre-signed URL for a one-shot export download.
 *   - Review-approval link sent to the operator's email.
 *   - Deferred-action tokens (approve a pending nudge later).
 *
 * **Not JWT.** We don't need RSA / alg-choice / broad ecosystem
 * compat; we need a compact, opinionated, deterministic token that
 * we control end-to-end. Format:
 *
 *   `<base64url(payload-json)>.<base64url(hmac-sha256)>`
 *
 * **Payload shape**:
 *
 *   {
 *     sub: "did:plc:...",     // subject
 *     cap: "export_download", // capability string
 *     exp: 1745000000,        // unix seconds
 *     nbf?: 1744000000,       // optional not-before
 *     iat: 1744950000,        // issued at
 *     jti: "<random-hex>",    // token id (replay guard)
 *     extra?: {...},          // optional payload
 *   }
 *
 * **Signing key** is the full HMAC secret — caller rotates by
 * constructing a new signer. Supports multiple "accepted" keys for
 * zero-downtime rotation (verify tries each).
 *
 * **Never throws from verify** — every failure mode is a tagged
 * outcome. Callers switch on reason to render the right error.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface PermissionTokenPayload<TExtra = unknown> {
  sub: string;
  cap: string;
  exp: number;
  iat: number;
  jti: string;
  nbf?: number;
  extra?: TExtra;
}

export interface IssueInput<TExtra = unknown> {
  sub: string;
  cap: string;
  /** Time-to-live in seconds. */
  ttlSec: number;
  /** Optional not-before offset in seconds. Default 0 (immediately valid). */
  nbfOffsetSec?: number;
  /** Optional payload. Merged into `extra`. */
  extra?: TExtra;
}

export type VerifyReason =
  | 'malformed'
  | 'bad_signature'
  | 'expired'
  | 'not_yet_valid'
  | 'cap_mismatch'
  | 'sub_mismatch';

export type VerifyOutcome<TExtra = unknown> =
  | { ok: true; payload: PermissionTokenPayload<TExtra> }
  | {
      ok: false;
      reason: VerifyReason;
      detail?: string;
      /** Payload surfaced on specific failures (expired / not_yet_valid / cap_mismatch) so caller UIs can show context. */
      payload?: PermissionTokenPayload<TExtra>;
    };

export interface VerifyOptions {
  /** Require the token's `cap` to match this value. */
  expectedCap?: string;
  /** Require the token's `sub` to match this value. */
  expectedSub?: string;
  /** Clock. Defaults to `Date.now` / 1000. */
  nowSecFn?: () => number;
}

export interface PermissionTokenSigner<TExtra = unknown> {
  /** Current signing key's identifier — rotated with the key. */
  readonly keyId: string;
  /** Sign a new token. */
  issue(input: IssueInput<TExtra>): string;
  /** Verify + decode. Never throws. */
  verify(token: string, opts?: VerifyOptions): VerifyOutcome<TExtra>;
}

export interface SignerOptions {
  /** Raw signing key bytes. Generate ≥16 bytes. */
  key: Uint8Array;
  /** Optional key id echoed with issue() output for observability. */
  keyId?: string;
  /**
   * Extra keys accepted by verify() for zero-downtime rotation.
   * Signing uses `key`; verify tries `key` then each of these.
   */
  acceptedVerifyKeys?: ReadonlyArray<{ key: Uint8Array; keyId?: string }>;
  /** Injectable RNG for jti. Defaults to node:crypto randomBytes. */
  randomBytesFn?: (n: number) => Buffer;
  /** Clock. */
  nowSecFn?: () => number;
}

export class PermissionTokenError extends Error {
  constructor(
    public readonly code:
      | 'invalid_key'
      | 'invalid_input'
      | 'invalid_ttl'
      | 'invalid_cap',
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'PermissionTokenError';
  }
}

export const MIN_KEY_BYTES = 16;

export function createPermissionTokenSigner<TExtra = unknown>(
  opts: SignerOptions,
): PermissionTokenSigner<TExtra> {
  if (!opts || !(opts.key instanceof Uint8Array)) {
    throw new PermissionTokenError('invalid_key', 'key must be a Uint8Array');
  }
  if (opts.key.byteLength < MIN_KEY_BYTES) {
    throw new PermissionTokenError(
      'invalid_key',
      `key must be ≥ ${MIN_KEY_BYTES} bytes, got ${opts.key.byteLength}`,
    );
  }
  const primaryKey = Buffer.from(opts.key);
  const primaryKeyId = opts.keyId ?? 'k0';
  const verifyKeys: Array<{ key: Buffer; keyId: string }> = [{ key: primaryKey, keyId: primaryKeyId }];
  for (const extra of opts.acceptedVerifyKeys ?? []) {
    if (!(extra.key instanceof Uint8Array) || extra.key.byteLength < MIN_KEY_BYTES) {
      throw new PermissionTokenError('invalid_key', 'acceptedVerifyKeys entries must be ≥ MIN_KEY_BYTES');
    }
    verifyKeys.push({ key: Buffer.from(extra.key), keyId: extra.keyId ?? `k${verifyKeys.length}` });
  }
  const rng = opts.randomBytesFn ?? ((n: number) => randomBytes(n));
  const nowSecFn = opts.nowSecFn ?? (() => Math.floor(Date.now() / 1000));

  return {
    keyId: primaryKeyId,
    issue(input: IssueInput<TExtra>): string {
      if (!input || typeof input !== 'object') {
        throw new PermissionTokenError('invalid_input', 'input required');
      }
      if (typeof input.sub !== 'string' || input.sub === '') {
        throw new PermissionTokenError('invalid_input', 'sub required');
      }
      if (typeof input.cap !== 'string' || input.cap === '') {
        throw new PermissionTokenError('invalid_cap', 'cap required');
      }
      if (!Number.isInteger(input.ttlSec) || input.ttlSec < 1) {
        throw new PermissionTokenError('invalid_ttl', 'ttlSec must be a positive integer');
      }
      if (input.nbfOffsetSec !== undefined) {
        if (!Number.isInteger(input.nbfOffsetSec) || input.nbfOffsetSec < 0) {
          throw new PermissionTokenError('invalid_ttl', 'nbfOffsetSec must be a non-negative integer');
        }
      }
      const iat = nowSecFn();
      const exp = iat + input.ttlSec;
      const jti = rng(16).toString('hex');
      const payload: PermissionTokenPayload<TExtra> = {
        sub: input.sub,
        cap: input.cap,
        exp,
        iat,
        jti,
      };
      if (input.nbfOffsetSec !== undefined && input.nbfOffsetSec > 0) {
        payload.nbf = iat + input.nbfOffsetSec;
      }
      if (input.extra !== undefined) {
        payload.extra = input.extra;
      }
      return encodeToken(payload, primaryKey);
    },
    verify(token: string, verifyOpts: VerifyOptions = {}): VerifyOutcome<TExtra> {
      if (typeof token !== 'string' || token === '') {
        return { ok: false, reason: 'malformed', detail: 'empty token' };
      }
      const parts = token.split('.');
      if (parts.length !== 2 || parts[0]!.length === 0 || parts[1]!.length === 0) {
        return { ok: false, reason: 'malformed', detail: 'expected <payload>.<sig>' };
      }
      const [b64Payload, b64Sig] = parts;
      let payloadJson: string;
      try {
        payloadJson = decodeB64Url(b64Payload!);
      } catch (err) {
        return { ok: false, reason: 'malformed', detail: (err as Error).message };
      }
      let payload: PermissionTokenPayload<TExtra>;
      try {
        payload = JSON.parse(payloadJson) as PermissionTokenPayload<TExtra>;
      } catch {
        return { ok: false, reason: 'malformed', detail: 'payload JSON invalid' };
      }
      if (!validatePayload(payload)) {
        return { ok: false, reason: 'malformed', detail: 'payload shape invalid' };
      }

      // Try each accepted key.
      let sigBytes: Buffer;
      try {
        sigBytes = Buffer.from(b64Sig!.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
      } catch {
        return { ok: false, reason: 'malformed', detail: 'sig not base64url' };
      }
      const dataBytes = Buffer.from(b64Payload!, 'utf8');
      let verified = false;
      for (const { key } of verifyKeys) {
        const expected = createHmac('sha256', key).update(dataBytes).digest();
        if (expected.length === sigBytes.length && timingSafeEqual(expected, sigBytes)) {
          verified = true;
          break;
        }
      }
      if (!verified) {
        return { ok: false, reason: 'bad_signature' };
      }

      const now = (verifyOpts.nowSecFn ?? nowSecFn)();
      if (payload.nbf !== undefined && now < payload.nbf) {
        return { ok: false, reason: 'not_yet_valid', payload };
      }
      if (now >= payload.exp) {
        return { ok: false, reason: 'expired', payload };
      }
      if (verifyOpts.expectedSub !== undefined && payload.sub !== verifyOpts.expectedSub) {
        return { ok: false, reason: 'sub_mismatch', detail: `expected ${verifyOpts.expectedSub}, got ${payload.sub}` };
      }
      if (verifyOpts.expectedCap !== undefined && payload.cap !== verifyOpts.expectedCap) {
        return { ok: false, reason: 'cap_mismatch', detail: `expected ${verifyOpts.expectedCap}, got ${payload.cap}`, payload };
      }
      return { ok: true, payload };
    },
  };
}

// ── Internals ──────────────────────────────────────────────────────────

function encodeToken(payload: PermissionTokenPayload, key: Buffer): string {
  const json = JSON.stringify(payload);
  const b64 = toB64Url(Buffer.from(json, 'utf8'));
  const sig = createHmac('sha256', key).update(Buffer.from(b64, 'utf8')).digest();
  const b64Sig = toB64Url(sig);
  return `${b64}.${b64Sig}`;
}

function toB64Url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function decodeB64Url(text: string): string {
  const padLen = (4 - (text.length % 4)) % 4;
  const padded = text + '='.repeat(padLen);
  const standard = padded.replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*=*$/.test(standard)) {
    throw new Error('payload is not valid base64url');
  }
  return Buffer.from(standard, 'base64').toString('utf8');
}

function validatePayload(p: unknown): p is PermissionTokenPayload {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;
  if (typeof o.sub !== 'string' || o.sub === '') return false;
  if (typeof o.cap !== 'string' || o.cap === '') return false;
  if (!Number.isInteger(o.exp)) return false;
  if (!Number.isInteger(o.iat)) return false;
  if (typeof o.jti !== 'string' || o.jti === '') return false;
  if (o.nbf !== undefined && !Number.isInteger(o.nbf)) return false;
  return true;
}
