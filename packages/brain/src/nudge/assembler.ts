/**
 * Nudge assembler — gather vault context for contact-specific nudges.
 *
 * A nudge is a context-aware suggestion shown before/during a contact
 * interaction. It gathers recent messages, relationship notes, pending
 * promises, and upcoming events for a contact.
 *
 * Returns null if there's nothing useful to surface (Silence First).
 *
 * Source: ARCHITECTURE.md Task 3.24
 */

import { queryVault } from '../../../core/src/vault/crud';

// ---------------------------------------------------------------
// 7-day frequency cap — prevent nudge spam per contact
//
// Matching Python's nudge frequency cap: no nudge for the same
// contact within 7 days. Prevents repeated notifications.
// ---------------------------------------------------------------

/** Frequency cap: minimum 7 days between nudges for the same contact. */
const NUDGE_FREQUENCY_CAP_MS = 7 * 24 * 60 * 60 * 1000;

/** Last nudge timestamp per contact DID. */
const lastNudgeAt = new Map<string, number>();

/**
 * Check if a nudge is allowed for a contact (frequency cap).
 * Returns true if no nudge was sent within the last 7 days.
 */
export function isNudgeAllowed(contactDID: string, now?: number): boolean {
  const currentTime = now ?? Date.now();
  const lastTime = lastNudgeAt.get(contactDID);
  if (lastTime === undefined) return true;
  return currentTime - lastTime >= NUDGE_FREQUENCY_CAP_MS;
}

/** Record that a nudge was generated for a contact. */
export function recordNudgeSent(contactDID: string, now?: number): void {
  lastNudgeAt.set(contactDID, now ?? Date.now());
}

/** Reset frequency cap state (for testing). */
export function resetNudgeFrequency(): void {
  lastNudgeAt.clear();
}

export interface NudgeItem {
  type: 'message' | 'note' | 'promise' | 'event' | 'preference';
  text: string;
  source: string;
  timestamp: number;
}

export interface Nudge {
  contactDID: string;
  items: NudgeItem[];
  summary: string;
  generatedAt: number;
}

/**
 * Assemble a nudge for a specific contact.
 *
 * Searches the vault for items related to the contact (by DID or alias).
 * Returns null if no relevant context is found (Silence First — no empty nudges).
 *
 * @param contactDID — the contact's DID
 * @param contactName — display name or alias (used for vault search)
 * @param personas — personas to search (default: ['general'])
 */
export function assembleNudge(
  contactDID: string,
  contactName: string,
  personas?: string[],
  now?: number,
): Nudge | null {
  // 7-day frequency cap: don't nudge the same contact too often
  if (!isNudgeAllowed(contactDID, now)) {
    return null;
  }

  const searchPersonas = personas ?? ['general'];
  const allItems: NudgeItem[] = [];

  for (const persona of searchPersonas) {
    // Search by contact name
    const results = queryVault(persona, { mode: 'fts5', text: contactName, limit: 10 });

    for (const item of results) {
      allItems.push({
        type: classifyNudgeType(item.type, item.summary),
        text: item.content_l0 || item.summary || '',
        source: persona,
        timestamp: item.timestamp,
      });
    }
  }

  if (allItems.length === 0) return null;

  // Sort by recency
  allItems.sort((a, b) => b.timestamp - a.timestamp);

  // Take top 5 most relevant
  const topItems = allItems.slice(0, 5);

  // Record nudge for frequency cap
  const currentTime = now ?? Date.now();
  recordNudgeSent(contactDID, currentTime);

  return {
    contactDID,
    items: topItems,
    summary: buildNudgeSummary(contactName, topItems),
    generatedAt: currentTime,
  };
}

// ---------------------------------------------------------------
// Promise detection — 6 regex patterns (matching Python nudge.py)
//
// Detects explicit promises, obligations, and lending patterns
// in vault item text. Used for promise-aware nudge assembly.
// ---------------------------------------------------------------

const PROMISE_PATTERNS = [
  /\bi'?ll\s+bring/i, // "I'll bring the book"
  /\bi\s+owe/i, // "I owe Bob $20"
  /\bpromised?\s+to/i, // "promised to lend", "promise to call"
  /\bpromised\b/i, // "Promised Alice coffee" (standalone)
  /\bi\s+need\s+to\s+return/i, // "I need to return the charger"
  /\blend\s+(?:you|him|her|them)/i, // "lend you my umbrella"
  /\bremind\s+me\s+to\s+give/i, // "remind me to give Alice the book"
];

/**
 * Check if text contains a promise pattern.
 *
 * Uses 6 regex patterns matching Python's promise detection:
 * "I'll bring", "I owe", "promised to", "I need to return",
 * "lend you/him/her/them", "remind me to give".
 */
export function isPromise(text: string): boolean {
  return PROMISE_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Classify the nudge item type from vault item metadata.
 *
 * Uses regex-based promise detection (6 patterns from Python)
 * instead of basic substring matching.
 */
function classifyNudgeType(itemType: string, summary: string): NudgeItem['type'] {
  const text = summary || '';

  if (isPromise(text)) {
    return 'promise';
  }
  if (/\b(?:birthday|meeting|appointment|deadline|event)\b/i.test(text)) {
    return 'event';
  }
  if (/\b(?:prefer|likes?|favou?rite)/i.test(text)) {
    return 'preference';
  }
  if (itemType === 'relationship_note' || itemType === 'social') {
    return 'note';
  }

  return 'message';
}

/**
 * Build a human-readable nudge summary.
 */
function buildNudgeSummary(contactName: string, items: NudgeItem[]): string {
  if (items.length === 0) return '';

  const parts: string[] = [];

  const promises = items.filter((i) => i.type === 'promise');
  if (promises.length > 0) {
    parts.push(`${promises.length} pending promise${promises.length > 1 ? 's' : ''}`);
  }

  const events = items.filter((i) => i.type === 'event');
  if (events.length > 0) {
    parts.push(`${events.length} upcoming event${events.length > 1 ? 's' : ''}`);
  }

  const preferences = items.filter((i) => i.type === 'preference');
  if (preferences.length > 0) {
    parts.push(`${preferences.length} known preference${preferences.length > 1 ? 's' : ''}`);
  }

  const messages = items.filter((i) => i.type === 'message' || i.type === 'note');
  if (messages.length > 0) {
    parts.push(`${messages.length} recent interaction${messages.length > 1 ? 's' : ''}`);
  }

  if (parts.length === 0) return `Context for ${contactName}`;
  return `${contactName}: ${parts.join(', ')}`;
}
