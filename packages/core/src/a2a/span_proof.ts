/**
 * Proof of the owner's words (REAL_LIFE_FIXES §0.1 A).
 *
 * At the start of each chat turn Brain records the owner's message with Core
 * (`POST /v1/a2a/turns`); Core keeps only its digest. To act on some of the
 * owner's words later in that turn (remember them, send them to a contact),
 * Brain presents the WHOLE message plus the offsets of the words it means.
 * Core re-hashes the message, compares it with the newest recorded turn of
 * that conversation, and only then takes the span. Text the owner did not
 * write in this turn (a friend's message, a service reply, a web page)
 * cannot pass: it is not in the recorded message.
 *
 * Limits: the turn must be the conversation's newest and under 10 minutes
 * old, and a proof is used once per action kind. Core still keeps no
 * plaintext. On the server Brain makes the recording, so a compromised Brain
 * could record words the owner never typed; that is within the documented
 * bound (CLAUDE.md: a compromised Brain acts as the owner's analyst).
 */

import { cleanForProvenance, utteranceDigest } from './provenance_text';
import { getA2AReleaseLog } from './release_log';

export interface SpanProof {
  /** The conversation (`chat:<thread>`) the turn was recorded under. */
  releaseSession: string;
  turnId: string;
  /** The owner's whole message for that turn. */
  turnText: string;
  /** Offsets into the CLEANED message (`cleanForProvenance`). */
  start: number;
  end: number;
}

export type SpanProofKind = 'remember' | 'send';

export type SpanProofResult =
  | { ok: true; span: string; turnText: string }
  | { ok: false; reason: SpanProofRefusal };

export type SpanProofRefusal =
  | 'unavailable'
  | 'not_newest_turn'
  | 'digest_mismatch'
  | 'stale_turn'
  | 'bad_span'
  | 'already_used';

export const SPAN_PROOF_MAX_AGE_MS = 10 * 60 * 1000;

/** Used proofs: one per (conversation, turn, kind). Bounded by turn age. */
const used = new Map<string, number>();

function sweepUsed(now: number): void {
  for (const [k, at] of used) if (now - at > SPAN_PROOF_MAX_AGE_MS * 2) used.delete(k);
}

/**
 * Check a proof and, when it holds, mark it used for `kind`. The returned
 * span is the cleaned, trimmed text between the offsets.
 */
export function verifySpanProof(
  proof: SpanProof,
  kind: SpanProofKind,
  now: number = Date.now(),
): SpanProofResult {
  const log = getA2AReleaseLog();
  if (log === null) return { ok: false, reason: 'unavailable' };
  const latest = log.latestUtterance(proof.releaseSession);
  if (latest === null || latest.turn_id !== proof.turnId) return { ok: false, reason: 'not_newest_turn' };
  if (utteranceDigest(proof.turnText) !== latest.digest) return { ok: false, reason: 'digest_mismatch' };
  if (now - Number(latest.recorded_at) > SPAN_PROOF_MAX_AGE_MS) return { ok: false, reason: 'stale_turn' };
  const clean = cleanForProvenance(proof.turnText);
  const { start, end } = proof;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > clean.length || start >= end) {
    return { ok: false, reason: 'bad_span' };
  }
  const span = clean.slice(start, end).trim();
  if (span === '') return { ok: false, reason: 'bad_span' };
  sweepUsed(now);
  const key = `${proof.releaseSession}|${proof.turnId}|${kind}`;
  if (used.has(key)) return { ok: false, reason: 'already_used' };
  used.set(key, now);
  return { ok: true, span, turnText: clean.trim() };
}

/** Test reset. */
export function resetSpanProofs(): void {
  used.clear();
}

// ---------------------------------------------------------------------------
// The owner's request forms, checked by Core (no model in the decision).
// ---------------------------------------------------------------------------

function norm(s: string): string {
  return s
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.!]+$/, '')
    .trim()
    .toLowerCase();
}

/**
 * A plain, positive request to remember, whose object is `span`: the turn
 * starts (after an optional "please") with remember / save / note / keep in
 * mind / don't forget, optionally followed by "that", and the rest of that
 * single sentence is exactly the span. Negations ("don't save"), questions
 * ("do you remember…?"), quoted verbs and a span that is not the verb's
 * object all fail, which only ever narrows: the item then needs a card for
 * a sensitive vault (REAL_LIFE_FIXES §2.5).
 */
export function isPositiveRememberRequest(turnText: string, span: string): boolean {
  const t = turnText.trim();
  if (t === '' || /[?]\s*$/.test(t)) return false;
  // One sentence only: no sentence break before the end.
  const body = t.replace(/[.!]+\s*$/, '');
  if (/[.!?]\s/.test(body)) return false;
  const m = /^(?:please[, ]\s*)?(?:remember|save|note|keep in mind|don'?t forget|do not forget)(?:\s*[:,-])?\s+(?:that\s+)?(.+)$/i.exec(
    body,
  );
  if (m === null) return false;
  const operand = m[1]!.replace(/[,\s]+please$/i, '');
  return norm(operand) === norm(span);
}

/**
 * A plain, positive instruction to send words to one named contact
 * (REAL_LIFE_FIXES §7.2). Returns the recipient phrase and the payload, or
 * null. Forms: "tell / message / text <recipient> (that) <payload>",
 * "let <recipient> know (that) <payload>", "send <recipient> <payload>".
 * Negations, questions and several recipients fail.
 */
export function parseSendInstruction(turnText: string): { recipient: string; payload: string } | null {
  const t = turnText.trim();
  if (t === '' || /[?]\s*$/.test(t)) return null;
  const body = t.replace(/[.!]+\s*$/, '');
  if (/[.!?]\s/.test(body)) return null;
  const pre = /^(?:please[, ]\s*)?/i;
  const head = body.replace(pre, '');
  let m = /^let\s+(.+?)\s+know(?:\s*[:,-])?\s+(?:that\s+)?(.+)$/i.exec(head);
  if (m === null) m = /^(?:tell|message|text)\s+(.+?)(?:\s*[:,-])?\s+(?:that\s+)?(.+)$/i.exec(head);
  if (m === null) m = /^send\s+(.+?)\s*[:,-]\s*(.+)$/i.exec(head);
  if (m === null) return null;
  const recipient = m[1]!.trim();
  const payload = m[2]!.replace(/[,\s]+please$/i, '').trim();
  // One recipient only: no list in the recipient, and a payload that opens
  // with a conjunction means a second recipient ("tell Sam and Juno …").
  if (/\s(?:and|&)\s|,/.test(recipient)) return null;
  if (/^(?:and|&|or)\s/i.test(payload)) return null;
  if (recipient === '' || payload === '') return null;
  return { recipient, payload };
}

/** Do two texts match after the same light normalisation the forms use? */
export function sameWords(a: string, b: string): boolean {
  return norm(a) === norm(b);
}

/**
 * True when every word of `draft` is one of the owner's `words` — the model
 * trimmed the owner's message but added nothing of its own. Callers then
 * send the owner's words, never the draft (a trim could drop a "not").
 */
export function drawsOnlyFrom(draft: string, words: string): boolean {
  const have = new Set(norm(words).split(' ').filter((w) => w !== ''));
  const want = norm(draft).split(' ').filter((w) => w !== '');
  return want.length > 0 && want.every((w) => have.has(w));
}
