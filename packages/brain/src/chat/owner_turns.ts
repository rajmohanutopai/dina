/**
 * The owner's current turn per chat thread, and proofs built from it
 * (REAL_LIFE_FIXES §0.1 A).
 *
 * The orchestrator records each owner message with Core before any model
 * sees it, and keeps it here. A tool that acts on the owner's words (remember
 * them, send them) quotes the words it means; `proveOwnerWords` turns that
 * quote into a span proof over the recorded message, which Core verifies
 * against the digest it stored. Only words in the owner's own message can be
 * proven, so text from a friend, a service or a web page never passes.
 *
 * Small and dependency-light on purpose: both the chat orchestrator and the
 * per-ask tool factory import it.
 */

import { cleanForProvenance, type OwnerWordsProof } from '@dina/core';

export interface OwnerTurn {
  /** `chat:<thread>` — the conversation the turn was recorded under. */
  releaseSession: string;
  turnId: string;
  text: string;
  at: number;
}

const turns = new Map<string, OwnerTurn>();

/** Keep `thread`'s newest recorded owner turn (only after Core recorded it). */
export function setCurrentOwnerTurn(thread: string, turn: OwnerTurn): void {
  turns.set(thread, turn);
}

export function getCurrentOwnerTurn(thread: string): OwnerTurn | null {
  return turns.get(thread) ?? null;
}

export function resetOwnerTurns(): void {
  turns.clear();
}

/**
 * A span proof for `words` within `thread`'s current owner turn, or an error
 * the model can act on (quote the owner exactly).
 */
export function proveOwnerWords(
  thread: string,
  words: string,
): { ok: true; proof: OwnerWordsProof; span: string } | { ok: false; error: string } {
  const turn = getCurrentOwnerTurn(thread);
  if (turn === null) return { ok: false, error: "no owner message is on record for this turn" };
  const wanted = cleanForProvenance(words).trim();
  if (wanted === '') return { ok: false, error: 'quote the words to use' };
  const clean = cleanForProvenance(turn.text);
  let start = clean.indexOf(wanted);
  if (start < 0) {
    // Case-insensitive fallback; offsets stay valid when lowering keeps length.
    const lowerClean = clean.toLowerCase();
    const lowerWanted = wanted.toLowerCase();
    if (lowerClean.length === clean.length && lowerWanted.length === wanted.length) {
      start = lowerClean.indexOf(lowerWanted);
    }
  }
  if (start < 0) {
    return {
      ok: false,
      error: "those words are not in the owner's message; quote the owner's own words exactly",
    };
  }
  const end = start + wanted.length;
  return {
    ok: true,
    span: clean.slice(start, end),
    proof: {
      releaseSession: turn.releaseSession,
      turnId: turn.turnId,
      turnText: turn.text,
      start,
      end,
    },
  };
}

// ---------------------------------------------------------------------------
// Remembering the owner's words from chat (REAL_LIFE_FIXES §2.5).
// ---------------------------------------------------------------------------

export interface RememberChatOutcome {
  status: 'stored' | 'duplicate' | 'pending_approval' | 'pending_unlock' | 'parked' | 'failed';
  personas: string[];
  /** Content-free reason for failed / parked outcomes. */
  reason?: string;
}

export type OwnerWordsRememberer = (thread: string, words: string) => Promise<RememberChatOutcome>;

let rememberer: OwnerWordsRememberer | null = null;

/** Installed by the chat orchestrator, which owns the remember path. */
export function installOwnerWordsRememberer(fn: OwnerWordsRememberer | null): void {
  rememberer = fn;
}

export function getOwnerWordsRememberer(): OwnerWordsRememberer | null {
  return rememberer;
}
