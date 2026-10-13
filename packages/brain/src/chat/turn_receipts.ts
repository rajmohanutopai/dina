/**
 * Receipts on the thread (REAL_LIFE_FIXES_2 §3): each owner turn's action
 * receipts ride on that turn's own message metadata, which Core's chat
 * storage persists, so a later "I sent it earlier" can back onto them. They
 * hold names and message text, so forgetting a person scrubs them (§4.4).
 */

import { getRecentMessages, updateMessageMetadataById } from './thread';

import type { ActionReceipt } from '../guardian/action_claims';

const KEEP_TURNS = 10;

function ownerTurnMessage(thread: string, question: string) {
  const recent = getRecentMessages(thread, 40);
  for (let i = recent.length - 1; i >= 0; i--) {
    const m = recent[i]!;
    if (m.type === 'user' && m.content === question) return m;
  }
  return undefined;
}

/** Record this turn's receipts on the owner's message for the turn. */
export function storeTurnReceipts(thread: string, question: string, receipts: readonly ActionReceipt[]): void {
  if (receipts.length === 0) return;
  const turn = ownerTurnMessage(thread, question);
  if (turn !== undefined) updateMessageMetadataById(thread, turn.id, { receipts });
}

/** Receipts from the thread's earlier turns (the last ten), oldest first. */
export function earlierReceipts(thread: string, question: string): ActionReceipt[] {
  const current = ownerTurnMessage(thread, question);
  const turns = getRecentMessages(thread, 80).filter((m) => m.type === 'user' && m.id !== current?.id);
  const out: ActionReceipt[] = [];
  for (const m of turns.slice(-KEEP_TURNS)) {
    const r = m.metadata?.receipts;
    if (Array.isArray(r)) out.push(...(r as ActionReceipt[]));
  }
  return out;
}
