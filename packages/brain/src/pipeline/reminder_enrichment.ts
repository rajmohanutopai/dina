/**
 * Reminder context enrichment — enrich fired reminders with vault context.
 *
 * When a reminder fires:
 * 1. Search vault for items related to the reminder (by subject/contact)
 * 2. Extract preferences, relationship notes, pending promises
 * 3. Build an enriched message with additional context
 *
 * Example:
 *   Original: "James's birthday tomorrow"
 *   Enriched: "James's birthday tomorrow — he loves craft beer (from conversation 2 months ago)"
 *
 * Source: ARCHITECTURE.md Task 5.3
 */

import { queryVault } from '../../../core/src/vault/crud';
import type { Reminder } from '../../../core/src/reminders/service';

export interface EnrichedReminder {
  originalMessage: string;
  enrichedMessage: string;
  contextItems: Array<{ id: string; summary: string; relevance: string }>;
  persona: string;
}

/**
 * Enrich a fired reminder with vault context.
 *
 * Searches the vault for items related to the reminder's message,
 * extracts relevant context, and builds an enriched message.
 *
 * Returns the original message if no relevant context is found.
 */
export function enrichReminder(reminder: Reminder, personas?: string[]): EnrichedReminder {
  const searchPersonas = personas ?? [reminder.persona || 'general'];
  const contextItems: EnrichedReminder['contextItems'] = [];

  // Extract search terms from the reminder message
  const searchTerms = extractSearchTerms(reminder.message);

  for (const persona of searchPersonas) {
    for (const term of searchTerms) {
      if (term.length < 2) continue;
      const results = queryVault(persona, { mode: 'fts5', text: term, limit: 5 });

      for (const item of results) {
        // Skip if already collected
        if (contextItems.some((c) => c.id === item.id)) continue;

        const relevance = classifyRelevance(item.summary, item.body, reminder.message);
        if (relevance !== 'none') {
          contextItems.push({
            id: item.id,
            summary: item.content_l0 || item.summary || '',
            relevance,
          });
        }
      }
    }
  }

  // Build enriched message
  const enrichedMessage =
    contextItems.length > 0
      ? buildEnrichedMessage(reminder.message, contextItems)
      : reminder.message;

  return {
    originalMessage: reminder.message,
    enrichedMessage,
    contextItems,
    persona: reminder.persona,
  };
}

/**
 * Extract meaningful search terms from a reminder message.
 * Filters out common stop words.
 */
function extractSearchTerms(message: string): string[] {
  const STOP_WORDS = new Set([
    'the',
    'a',
    'an',
    'is',
    'are',
    'was',
    'were',
    'be',
    'been',
    'to',
    'of',
    'in',
    'for',
    'on',
    'at',
    'by',
    'with',
    'from',
    'and',
    'or',
    'but',
    'not',
    'no',
    'this',
    'that',
    'it',
    'do',
    'does',
    'did',
    'will',
    'would',
    'can',
    'could',
    'has',
    'have',
    'had',
    'about',
    'up',
    'out',
    'so',
    'if',
  ]);

  return message
    .split(/\s+/)
    .map((w) => w.replace(/[^a-zA-Z0-9]/g, '').toLowerCase())
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
}

/**
 * Classify how relevant a vault item is to a reminder.
 */
function classifyRelevance(itemSummary: string, itemBody: string, reminderMessage: string): string {
  const text = `${itemSummary} ${itemBody}`.toLowerCase();
  const reminder = reminderMessage.toLowerCase();

  // Check for preferences
  if (text.includes('prefer') || text.includes('likes') || text.includes('favorite')) {
    return 'preference';
  }

  // Check for promises
  if (text.includes('promise') || text.includes('lend') || text.includes('owe')) {
    return 'promise';
  }

  // Check for relationship notes
  if (text.includes('relationship') || text.includes('last saw') || text.includes('met at')) {
    return 'relationship';
  }

  // Check for keyword overlap
  const reminderWords = new Set(reminder.split(/\s+/).filter((w) => w.length >= 3));
  const itemWords = text.split(/\s+/).filter((w) => w.length >= 3);
  const overlap = itemWords.filter((w) => reminderWords.has(w));
  if (overlap.length >= 2) return 'related';

  return 'none';
}

/**
 * Build an enriched reminder message from context items.
 */
function buildEnrichedMessage(
  originalMessage: string,
  contextItems: EnrichedReminder['contextItems'],
): string {
  const additions: string[] = [];

  const preferences = contextItems.filter((c) => c.relevance === 'preference');
  if (preferences.length > 0) {
    additions.push(preferences[0].summary);
  }

  const promises = contextItems.filter((c) => c.relevance === 'promise');
  if (promises.length > 0) {
    additions.push(`Pending: ${promises[0].summary}`);
  }

  if (additions.length === 0) {
    const related = contextItems.filter((c) => c.relevance === 'related');
    if (related.length > 0) {
      additions.push(`Related: ${related[0].summary}`);
    }
  }

  if (additions.length === 0) return originalMessage;
  return `${originalMessage} — ${additions.join('. ')}`;
}
