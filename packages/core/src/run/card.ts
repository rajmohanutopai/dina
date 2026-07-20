/**
 * ISVC-10 (E76-05) — the pull-message PAYLOAD integrity boundary. `verifyRunMessage`
 * proves the provider SIGNED a `card_digest` + `params_digest`; this proves the
 * unsealed plaintext actually HASHES to those signed digests and that the card is
 * a valid, bounded `CardSpec`. Without it Core would persist an arbitrary payload
 * under a signed-but-unrelated digest (§6.1-6.2/§13).
 *
 * Wire envelope (the unsealed plaintext `payload`): canonical UTF-8 JSON
 *   { "card": "<serialized CardSpec JSON>", "params": "<serialized params JSON>" }
 * `card`/`params` are PRE-SERIALIZED strings so Core hashes their EXACT bytes —
 * no re-canonicalization — and the recomputed digest equals the provider's signed
 * digest byte-for-byte. The card is additionally validated as UNTRUSTED
 * (`validateCardSpec`, so provider-forged trust pills are dropped). Fail-closed.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { validateCardSpec, type CardSpec } from '@dina/protocol';

/** Hard bound on the whole card+params envelope (defense against oversized cards). */
export const MAX_RUN_PAYLOAD_BYTES = 64 * 1024;
/** Length caps on the bounded classify-view text handed to Brain (§6.2/§12.6). */
const MAX_VIEW_TITLE = 200;
const MAX_VIEW_BODY = 2000;

const enc = new TextEncoder();
const dec = new TextDecoder();

export type ParseRunPayloadResult =
  | { ok: true; card: CardSpec; params: unknown }
  | {
      ok: false;
      reason:
        | 'oversized'
        | 'malformed_envelope'
        | 'card_digest_mismatch'
        | 'params_digest_mismatch'
        | 'invalid_card';
    };

/**
 * Parse + integrity-verify a provider pull-message payload against its SIGNED
 * `card_digest`/`params_digest` (already authenticated by `verifyRunMessage`).
 * Recomputes both digests from the EXACT serialized bytes and validates the card.
 */
export function parseRunMessagePayload(
  payload: Uint8Array,
  signedCardDigest: string,
  signedParamsDigest: string,
): ParseRunPayloadResult {
  if (payload.length > MAX_RUN_PAYLOAD_BYTES) return { ok: false, reason: 'oversized' };
  let env: unknown;
  try {
    env = JSON.parse(dec.decode(payload));
  } catch {
    return { ok: false, reason: 'malformed_envelope' };
  }
  if (env === null || typeof env !== 'object') return { ok: false, reason: 'malformed_envelope' };
  const e = env as Record<string, unknown>;
  if (typeof e.card !== 'string' || typeof e.params !== 'string') {
    return { ok: false, reason: 'malformed_envelope' };
  }
  // Recompute over the EXACT provider-serialized bytes (constant-vocabulary hex
  // compare; a single differing byte flips the digest → reject).
  if (bytesToHex(sha256(enc.encode(e.card))) !== signedCardDigest) {
    return { ok: false, reason: 'card_digest_mismatch' };
  }
  if (bytesToHex(sha256(enc.encode(e.params))) !== signedParamsDigest) {
    return { ok: false, reason: 'params_digest_mismatch' };
  }
  let cardValue: unknown;
  let paramsValue: unknown;
  try {
    cardValue = JSON.parse(e.card);
    paramsValue = JSON.parse(e.params);
  } catch {
    return { ok: false, reason: 'malformed_envelope' };
  }
  // Untrusted validation: a provider/LLM cannot forge a Dina trust pill (§card-spec).
  const card = validateCardSpec(cardValue, { trusted: false });
  if (card === null) return { ok: false, reason: 'invalid_card' };
  return { ok: true, card, params: paramsValue };
}

export type ParseResultCardResult =
  | { ok: true; card: CardSpec }
  | { ok: false; reason: 'oversized' | 'card_digest_mismatch' | 'malformed' | 'invalid_card' };

/**
 * 81B-04 — the completion RESULT-CARD integrity boundary. `verifyRunResult` proves
 * the provider SIGNED a `result_card_digest`; this proves the serialized result-card
 * bytes actually HASH to that signed digest and are a valid, bounded `CardSpec`,
 * before Core envelope-encrypts + persists them under its OWN content-addressed ref
 * (§5.1/§6.2/§13). Without it Core would store a provider-supplied ref string (or an
 * arbitrary card) under a signed-but-unrelated digest. The result card is a bare
 * serialized CardSpec (no `params` envelope), so the digest is over the EXACT card
 * bytes. Untrusted validation drops provider-forged trust pills. Fail-closed.
 */
export function parseResultCardPayload(
  payload: Uint8Array,
  signedCardDigest: string,
): ParseResultCardResult {
  if (payload.length > MAX_RUN_PAYLOAD_BYTES) return { ok: false, reason: 'oversized' };
  if (bytesToHex(sha256(payload)) !== signedCardDigest) {
    return { ok: false, reason: 'card_digest_mismatch' };
  }
  let cardValue: unknown;
  try {
    cardValue = JSON.parse(dec.decode(payload));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const card = validateCardSpec(cardValue, { trusted: false });
  if (card === null) return { ok: false, reason: 'invalid_card' };
  return { ok: true, card };
}

/**
 * Render a validated CardSpec into the bounded owner-facing title + body the Core
 * classify-view hands Brain (§6.2/§12.6). Title = the first `title` block's text;
 * body = the joined text of `body`/`section` blocks. Both length-capped. NO
 * `params`, NO vault context — the classify-view is card display text only.
 */
export function renderCardView(card: CardSpec): { title: string; body: string } {
  let title = '';
  const bodyParts: string[] = [];
  for (const block of card.blocks as { kind: string; text?: unknown; label?: unknown }[]) {
    if (block.kind === 'title' && title === '') title = String(block.text ?? '');
    else if (block.kind === 'body') bodyParts.push(String(block.text ?? ''));
    else if (block.kind === 'section') bodyParts.push(String(block.label ?? ''));
  }
  return { title: title.slice(0, MAX_VIEW_TITLE), body: bodyParts.join('\n').slice(0, MAX_VIEW_BODY) };
}

/**
 * Decode a STORED payload envelope (already integrity-verified at ingest, E76-05)
 * into the classify-view text. Decode-and-render only — a malformed/locked payload
 * yields empty text, never throws (E76-06).
 */
export function renderRunPayloadView(plaintext: Uint8Array): { title: string; body: string } {
  try {
    const env = JSON.parse(dec.decode(plaintext)) as { card?: unknown };
    if (typeof env.card !== 'string') return { title: '', body: '' };
    const card = validateCardSpec(JSON.parse(env.card), { trusted: false });
    if (card === null) return { title: '', body: '' };
    return renderCardView(card);
  } catch {
    return { title: '', body: '' };
  }
}
