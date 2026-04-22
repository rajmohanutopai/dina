/**
 * Pairing-QR payload builder — pure (de)serializer for device pairing.
 *
 * During device pairing, the host device (laptop / admin UI) displays
 * a QR code the phone scans. The QR encodes everything the phone
 * needs to initiate the pairing handshake:
 *
 *   - `did`          — the home-node's DID.
 *   - `endpoint`     — signed-HTTP base URL the phone will hit.
 *   - `challenge`    — one-shot nonce the host stored; phone echoes it
 *                      back in the pair-complete request.
 *   - `expiresAtSec` — when the challenge goes stale (unix seconds).
 *   - `deviceName?`  — human label shown in the admin UI ("Alonso's iPad").
 *   - `version`      — pinned to `1` so the protocol can evolve.
 *
 * **Format** — compact URL the QR reader can pick up as a deep link:
 *
 *   `dina://pair/v1/<base64url-json-payload>`
 *
 * Base64url-encoded JSON with no padding. Keeps the QR dense but
 * keeps parsing trivial on the phone side (one base64 decode + JSON
 * parse).
 *
 * **Parser is lenient on version prefix**: accepts `dina://pair/v1/...`
 * and surfaces any version mismatch as a structured error so the
 * phone UI can say "this QR is from a newer Dina; please update the
 * app".
 *
 * **Never throws** from `parseQrPayload` — every failure mode maps to
 * a tagged `ParseQrError`.
 */

export interface PairingQrPayload {
  version: 1;
  did: string;
  endpoint: string;
  challenge: string;
  expiresAtSec: number;
  deviceName?: string;
}

export interface BuildQrInput {
  did: string;
  endpoint: string;
  challenge: string;
  expiresAtSec: number;
  deviceName?: string;
}

export type ParseQrFailure =
  | { ok: false; reason: 'empty'; detail: string }
  | { ok: false; reason: 'bad_scheme'; detail: string }
  | { ok: false; reason: 'bad_version'; detail: string; version: string }
  | { ok: false; reason: 'bad_encoding'; detail: string }
  | { ok: false; reason: 'bad_payload'; detail: string }
  | { ok: false; reason: 'expired'; detail: string; expiresAtSec: number; nowSec: number };

export type ParseQrSuccess = { ok: true; payload: PairingQrPayload };
export type ParseQrResult = ParseQrSuccess | ParseQrFailure;

export const QR_SCHEME = 'dina://pair/v1/';
export const PAIRING_PROTOCOL_VERSION = 1 as const;

export class BuildQrError extends Error {
  constructor(
    public readonly code:
      | 'invalid_did'
      | 'invalid_endpoint'
      | 'empty_challenge'
      | 'invalid_expiry'
      | 'invalid_device_name'
      | 'invalid_input',
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'BuildQrError';
  }
}

/**
 * Build a `dina://pair/v1/<...>` URL. Throws `BuildQrError` on bad input.
 */
export function buildPairingQr(input: BuildQrInput): string {
  if (!input || typeof input !== 'object') {
    throw new BuildQrError('invalid_input', 'input required');
  }
  if (typeof input.did !== 'string' || !input.did.startsWith('did:')) {
    throw new BuildQrError('invalid_did', `did must start with "did:" (got ${JSON.stringify(input.did)})`);
  }
  if (typeof input.endpoint !== 'string' || input.endpoint === '') {
    throw new BuildQrError('invalid_endpoint', 'endpoint required');
  }
  try {
    const parsed = new URL(input.endpoint);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('scheme');
    }
  } catch {
    throw new BuildQrError('invalid_endpoint', `endpoint must be an http(s) URL (got ${input.endpoint})`);
  }
  if (typeof input.challenge !== 'string' || input.challenge === '') {
    throw new BuildQrError('empty_challenge', 'challenge required');
  }
  if (!Number.isFinite(input.expiresAtSec) || input.expiresAtSec <= 0) {
    throw new BuildQrError('invalid_expiry', 'expiresAtSec must be a positive finite number');
  }

  const payload: PairingQrPayload = {
    version: 1,
    did: input.did,
    endpoint: input.endpoint,
    challenge: input.challenge,
    expiresAtSec: input.expiresAtSec,
  };
  if (input.deviceName !== undefined) {
    if (typeof input.deviceName !== 'string') {
      throw new BuildQrError('invalid_device_name', 'deviceName must be a string');
    }
    payload.deviceName = input.deviceName;
  }
  const encoded = toBase64Url(JSON.stringify(payload));
  return `${QR_SCHEME}${encoded}`;
}

/**
 * Parse a `dina://pair/v1/<...>` URL back into its payload. Returns
 * tagged outcome — never throws.
 */
export function parseQrPayload(
  qr: string,
  opts: { nowSec?: number } = {},
): ParseQrResult {
  if (typeof qr !== 'string' || qr === '') {
    return { ok: false, reason: 'empty', detail: 'qr value is empty' };
  }
  if (!qr.startsWith('dina://pair/')) {
    return {
      ok: false,
      reason: 'bad_scheme',
      detail: `expected scheme "dina://pair/..." got ${qr.slice(0, 16)}`,
    };
  }
  // Extract version token + remainder.
  const rest = qr.slice('dina://pair/'.length);
  const slashIdx = rest.indexOf('/');
  if (slashIdx === -1 || slashIdx === 0) {
    return { ok: false, reason: 'bad_version', detail: 'missing version segment', version: '' };
  }
  const versionToken = rest.slice(0, slashIdx);
  const body = rest.slice(slashIdx + 1);
  if (versionToken !== 'v1') {
    return {
      ok: false,
      reason: 'bad_version',
      detail: `unsupported protocol version ${versionToken}`,
      version: versionToken,
    };
  }
  if (body === '') {
    return { ok: false, reason: 'bad_encoding', detail: 'empty payload' };
  }

  let jsonStr: string;
  try {
    jsonStr = fromBase64Url(body);
  } catch (err) {
    return {
      ok: false,
      reason: 'bad_encoding',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    return {
      ok: false,
      reason: 'bad_payload',
      detail: `JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const validation = validatePayload(parsed);
  if (validation.ok === false) return validation;

  const payload = validation.payload;
  if (opts.nowSec !== undefined && Number.isFinite(opts.nowSec)) {
    if (payload.expiresAtSec <= opts.nowSec) {
      return {
        ok: false,
        reason: 'expired',
        detail: `challenge expired at ${payload.expiresAtSec}`,
        expiresAtSec: payload.expiresAtSec,
        nowSec: opts.nowSec,
      };
    }
  }
  return { ok: true, payload };
}

// ── Internals ──────────────────────────────────────────────────────────

function validatePayload(
  raw: unknown,
):
  | { ok: true; payload: PairingQrPayload }
  | Extract<ParseQrFailure, { reason: 'bad_payload' }> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'bad_payload', detail: 'payload must be an object' };
  }
  const o = raw as Record<string, unknown>;
  if (o.version !== 1) {
    return { ok: false, reason: 'bad_payload', detail: `payload.version must be 1 (got ${String(o.version)})` };
  }
  if (typeof o.did !== 'string' || !o.did.startsWith('did:')) {
    return { ok: false, reason: 'bad_payload', detail: 'payload.did must be a DID string' };
  }
  if (typeof o.endpoint !== 'string' || o.endpoint === '') {
    return { ok: false, reason: 'bad_payload', detail: 'payload.endpoint required' };
  }
  try {
    const u = new URL(o.endpoint);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('scheme');
  } catch {
    return { ok: false, reason: 'bad_payload', detail: `payload.endpoint must be http(s) URL` };
  }
  if (typeof o.challenge !== 'string' || o.challenge === '') {
    return { ok: false, reason: 'bad_payload', detail: 'payload.challenge required' };
  }
  if (!Number.isFinite(o.expiresAtSec) || (o.expiresAtSec as number) <= 0) {
    return {
      ok: false,
      reason: 'bad_payload',
      detail: 'payload.expiresAtSec must be a positive number',
    };
  }
  const payload: PairingQrPayload = {
    version: 1,
    did: o.did,
    endpoint: o.endpoint,
    challenge: o.challenge,
    expiresAtSec: o.expiresAtSec as number,
  };
  if (o.deviceName !== undefined) {
    if (typeof o.deviceName !== 'string') {
      return {
        ok: false,
        reason: 'bad_payload',
        detail: 'payload.deviceName must be a string when present',
      };
    }
    payload.deviceName = o.deviceName;
  }
  return { ok: true, payload };
}

function toBase64Url(text: string): string {
  return Buffer.from(text, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fromBase64Url(text: string): string {
  // Restore padding + standard base64 charset.
  const padLen = (4 - (text.length % 4)) % 4;
  const padded = text + '='.repeat(padLen);
  const standard = padded.replace(/-/g, '+').replace(/_/g, '/');
  // Node's Buffer.from tolerates bad chars silently — sniff with a regex first.
  if (!/^[A-Za-z0-9+/]*=*$/.test(standard)) {
    throw new Error('payload is not valid base64url');
  }
  return Buffer.from(standard, 'base64').toString('utf8');
}
