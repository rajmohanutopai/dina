/**
 * Contact name matching — finds mentioned contacts in text.
 *
 * Features:
 *   - Case-insensitive matching
 *   - Word-boundary aware (no partial matches inside words)
 *   - Longest-first matching (avoids partial overlaps)
 *   - Deduplication (same contact mentioned twice → one match per contact)
 *   - Span positions returned for highlighting
 *   - Minimum name length: 3 characters (avoids false positives on "Al", "Ed")
 *
 * Source: brain/tests/test_contact_matcher.py
 */

export interface ContactMatch {
  contactName: string;
  start: number;
  end: number;
  matchedText: string;
}

export interface ContactInfo {
  name: string;
  aliases?: string[];
}

/** Minimum characters for a matchable name. */
const MIN_NAME_LENGTH = 3;

/**
 * Find all contact name mentions in text.
 *
 * @param text - Input text to search
 * @param contacts - Known contacts with names and aliases
 * @returns Array of matches with positions (deduplicated per contact, longest-first)
 */
export function matchContacts(text: string, contacts: ContactInfo[]): ContactMatch[] {
  if (!text || contacts.length === 0) return [];

  // Build search terms: (canonicalName, searchTerm) sorted by length descending
  const terms: Array<{ contactName: string; term: string }> = [];
  for (const contact of contacts) {
    if (contact.name.length >= MIN_NAME_LENGTH) {
      terms.push({ contactName: contact.name, term: contact.name });
    }
    for (const alias of contact.aliases ?? []) {
      if (alias.length >= MIN_NAME_LENGTH) {
        terms.push({ contactName: contact.name, term: alias });
      }
    }
  }

  // Sort longest first — ensures "Alice Cooper" matches before "Alice"
  terms.sort((a, b) => b.term.length - a.term.length);

  const matches: ContactMatch[] = [];
  const coveredRanges: Array<[number, number]> = [];
  const seenContacts = new Set<string>();

  for (const { contactName, term } of terms) {
    // Build word-boundary regex for this term
    const escaped = escapeRegex(term);
    const pattern = new RegExp(`\\b${escaped}\\b`, 'gi');

    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;

      // Skip if this range overlaps with an already-matched range
      if (coveredRanges.some(([s, e]) => start < e && end > s)) {
        continue;
      }

      // Deduplicate: only first occurrence per contact
      if (seenContacts.has(contactName)) {
        continue;
      }

      matches.push({
        contactName,
        start,
        end,
        matchedText: m[0],
      });
      coveredRanges.push([start, end]);
      seenContacts.add(contactName);
    }
  }

  // Sort by position in text
  matches.sort((a, b) => a.start - b.start);
  return matches;
}

/**
 * Check if a single contact name appears in text (word-boundary, case-insensitive).
 */
export function containsContact(text: string, contactName: string): boolean {
  if (!text || !contactName || contactName.length < MIN_NAME_LENGTH) return false;
  const escaped = escapeRegex(contactName);
  const pattern = new RegExp(`\\b${escaped}\\b`, 'i');
  return pattern.test(text);
}

/** Escape special regex characters in a string. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
