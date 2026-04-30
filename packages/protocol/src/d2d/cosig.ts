/**
 * D2D cosig (co-signature) handshake — TN-PROTO-002.
 *
 * The plan-§10 cosig flow lets the author of an attestation ask a
 * peer to endorse it. The handshake is a tiny three-message D2D
 * exchange plus a state machine the requester drives client-side:
 *
 *   author → peer    trust.cosig.request   "would you cosign at://X?"
 *   peer   → author  trust.cosig.accept    "yes — here's my endorsement at://Y"
 *   peer   → author  trust.cosig.reject    "no — reason X"
 *
 * Either reply terminates the request. If neither arrives before
 * `expiresAt`, the requester transitions to `expired` on the next
 * tick.
 *
 * This module defines the wire types and a pure state machine. It
 * carries no clock and no I/O — callers drive ticks, supply events
 * from the D2D layer, and persist the resulting `CosigState`.
 *
 * Zero runtime deps — pure type + function declarations.
 */

// ── Wire types ──────────────────────────────────────────────────────

/**
 * D2D message-type literal for cosig messages. Mirrors the
 * convention in `@dina/protocol` constants for other D2D scenarios.
 */
export const COSIG_REQUEST_TYPE = 'trust.cosig.request' as const;
export const COSIG_ACCEPT_TYPE = 'trust.cosig.accept' as const;
export const COSIG_REJECT_TYPE = 'trust.cosig.reject' as const;

export type CosigMessageType =
  | typeof COSIG_REQUEST_TYPE
  | typeof COSIG_ACCEPT_TYPE
  | typeof COSIG_REJECT_TYPE;

/**
 * Sent by the attestation author to a prospective cosigner.
 *
 * `requestId` must be unique per (author, recipient) pair — the
 * recipient echoes it on the reply so the author can correlate it
 * with the originating request. A UUIDv4 is the obvious choice.
 *
 * `attestationCid` pins the exact record version being asked about,
 * so a later edit doesn't silently drag a cosignature with it.
 */
export interface CosigRequest {
  type: typeof COSIG_REQUEST_TYPE;
  requestId: string;
  attestationUri: string;
  attestationCid: string;
  /** ISO-8601 datetime with offset — past this the sender drops state. */
  expiresAt: string;
  /** Optional human-facing note explaining why the ask was made. */
  reason?: string;
  /** ISO-8601 datetime with offset — when the request was composed. */
  createdAt: string;
}

/**
 * Recipient's positive reply. They've published an endorsement
 * record and pass the AT-URI back so the author can render
 * "X cosigned" UX directly from the wire message.
 */
export interface CosigAccept {
  type: typeof COSIG_ACCEPT_TYPE;
  requestId: string;
  endorsementUri: string;
  endorsementCid: string;
  createdAt: string;
}

/**
 * Closed reason set so the requester can categorise rejections
 * without parsing free-text. Open-ended elaboration goes in `text`.
 */
export type CosigRejectReason = 'declined' | 'unable-to-verify' | 'not-applicable' | 'other';

export interface CosigReject {
  type: typeof COSIG_REJECT_TYPE;
  requestId: string;
  reason: CosigRejectReason;
  /** Optional free-text — surfaced to the author as a note. */
  text?: string;
  createdAt: string;
}

export type CosigMessage = CosigRequest | CosigAccept | CosigReject;

// ── State machine ──────────────────────────────────────────────────

export type CosigStatus = 'pending' | 'accepted' | 'rejected' | 'expired';

interface CosigStateBase {
  status: CosigStatus;
  requestId: string;
}

export interface CosigStatePending extends CosigStateBase {
  status: 'pending';
  expiresAt: string;
}

export interface CosigStateAccepted extends CosigStateBase {
  status: 'accepted';
  endorsementUri: string;
  endorsementCid: string;
  /** ISO-8601 — when the accept message arrived. */
  acceptedAt: string;
}

export interface CosigStateRejected extends CosigStateBase {
  status: 'rejected';
  reason: CosigRejectReason;
  text?: string;
  /** ISO-8601 — when the reject message arrived. */
  rejectedAt: string;
}

export interface CosigStateExpired extends CosigStateBase {
  status: 'expired';
  /** ISO-8601 — the tick that observed expiry (≥ expiresAt). */
  expiredAt: string;
}

export type CosigState =
  | CosigStatePending
  | CosigStateAccepted
  | CosigStateRejected
  | CosigStateExpired;

/**
 * Events the requester feeds into `cosigStep`. The wrapper wraps
 * inbound D2D messages plus a `tick` carrying a clock reading so
 * the state machine itself stays pure (no `Date.now()` inside).
 */
export type CosigEvent =
  | { kind: 'accept'; message: CosigAccept }
  | { kind: 'reject'; message: CosigReject }
  | { kind: 'tick'; now: string };

/** Construct the initial `pending` state from a request. */
export function cosigInitial(req: CosigRequest): CosigStatePending {
  return {
    status: 'pending',
    requestId: req.requestId,
    expiresAt: req.expiresAt,
  };
}

/**
 * Drive the state machine. Returns the next state — or the SAME
 * state object if the event is a no-op (terminal-state event,
 * mismatched requestId, or tick before expiry). Callers should
 * compare by reference if they want to skip a re-render.
 */
export function cosigStep(state: CosigState, event: CosigEvent): CosigState {
  // Terminal states: ignore all events. Replays are safe.
  if (state.status !== 'pending') return state;

  switch (event.kind) {
    case 'accept': {
      if (event.message.requestId !== state.requestId) return state;
      return {
        status: 'accepted',
        requestId: state.requestId,
        endorsementUri: event.message.endorsementUri,
        endorsementCid: event.message.endorsementCid,
        acceptedAt: event.message.createdAt,
      };
    }
    case 'reject': {
      if (event.message.requestId !== state.requestId) return state;
      // `text` is genuinely optional on the wire — only carry it
      // through when the sender included it. (Spreading conditionally
      // keeps the resulting object compatible with the package's
      // exactOptionalPropertyTypes setting.)
      const next: CosigStateRejected = {
        status: 'rejected',
        requestId: state.requestId,
        reason: event.message.reason,
        rejectedAt: event.message.createdAt,
        ...(event.message.text !== undefined ? { text: event.message.text } : {}),
      };
      return next;
    }
    case 'tick': {
      const nowMs = Date.parse(event.now);
      const expMs = Date.parse(state.expiresAt);
      // Bad timestamps → no-op. The state machine doesn't crash on
      // garbage clock input; the caller is expected to feed valid
      // ISO strings.
      if (Number.isNaN(nowMs) || Number.isNaN(expMs)) return state;
      if (nowMs < expMs) return state;
      return {
        status: 'expired',
        requestId: state.requestId,
        expiredAt: event.now,
      };
    }
  }
}

// ── Validators ─────────────────────────────────────────────────────

const ISO_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const REJECT_REASONS: ReadonlySet<CosigRejectReason> = new Set([
  'declined',
  'unable-to-verify',
  'not-applicable',
  'other',
]);

const MAX_REQUEST_ID_LEN = 200;
const MAX_URI_LEN = 2048;
const MAX_CID_LEN = 256;
const MAX_REASON_TEXT_LEN = 1000;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function checkString(
  errors: string[],
  field: string,
  value: unknown,
  opts: { maxLen?: number; minLen?: number; pattern?: RegExp } = {},
): void {
  if (typeof value !== 'string') {
    errors.push(`${field} must be a string`);
    return;
  }
  if (opts.minLen !== undefined && value.length < opts.minLen) {
    errors.push(`${field} must be ≥${opts.minLen} chars`);
  }
  if (opts.maxLen !== undefined && value.length > opts.maxLen) {
    errors.push(`${field} must be ≤${opts.maxLen} chars`);
  }
  if (opts.pattern && !opts.pattern.test(value)) {
    errors.push(`${field} fails format check`);
  }
}

/**
 * Validate a `CosigRequest` against the wire contract. Returns
 * an array of human-readable errors — empty when valid. Used
 * before the requester writes the message to D2D and before the
 * recipient surfaces it in their inbox.
 */
export function validateCosigRequest(msg: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(msg)) return ['message must be an object'];
  if (msg.type !== COSIG_REQUEST_TYPE) errors.push(`type must be ${COSIG_REQUEST_TYPE}`);
  checkString(errors, 'requestId', msg.requestId, { minLen: 1, maxLen: MAX_REQUEST_ID_LEN });
  checkString(errors, 'attestationUri', msg.attestationUri, {
    minLen: 1,
    maxLen: MAX_URI_LEN,
  });
  checkString(errors, 'attestationCid', msg.attestationCid, { minLen: 1, maxLen: MAX_CID_LEN });
  checkString(errors, 'expiresAt', msg.expiresAt, { pattern: ISO_REGEX });
  checkString(errors, 'createdAt', msg.createdAt, { pattern: ISO_REGEX });
  if (msg.reason !== undefined) {
    checkString(errors, 'reason', msg.reason, { maxLen: MAX_REASON_TEXT_LEN });
  }
  return errors;
}

export function validateCosigAccept(msg: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(msg)) return ['message must be an object'];
  if (msg.type !== COSIG_ACCEPT_TYPE) errors.push(`type must be ${COSIG_ACCEPT_TYPE}`);
  checkString(errors, 'requestId', msg.requestId, { minLen: 1, maxLen: MAX_REQUEST_ID_LEN });
  checkString(errors, 'endorsementUri', msg.endorsementUri, { minLen: 1, maxLen: MAX_URI_LEN });
  checkString(errors, 'endorsementCid', msg.endorsementCid, { minLen: 1, maxLen: MAX_CID_LEN });
  checkString(errors, 'createdAt', msg.createdAt, { pattern: ISO_REGEX });
  return errors;
}

export function validateCosigReject(msg: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(msg)) return ['message must be an object'];
  if (msg.type !== COSIG_REJECT_TYPE) errors.push(`type must be ${COSIG_REJECT_TYPE}`);
  checkString(errors, 'requestId', msg.requestId, { minLen: 1, maxLen: MAX_REQUEST_ID_LEN });
  if (typeof msg.reason !== 'string' || !REJECT_REASONS.has(msg.reason as CosigRejectReason)) {
    errors.push(`reason must be one of: ${[...REJECT_REASONS].sort().join(', ')}`);
  }
  if (msg.text !== undefined) {
    checkString(errors, 'text', msg.text, { maxLen: MAX_REASON_TEXT_LEN });
  }
  checkString(errors, 'createdAt', msg.createdAt, { pattern: ISO_REGEX });
  return errors;
}
