/**
 * Contact alias support — matching, precedence, staging override, recall hints.
 *
 * Alias wins over kinship in attribution. Longest-first matching.
 * Case-insensitive. Word-boundary aware. Per-contact deduplication.
 *
 * Source: brain/tests/test_alias_support.py
 */

export interface AliasMatch {
  contactName: string;
  matchedAlias: string;
  matchType: 'alias' | 'name' | 'kinship';
}

/**
 * Match text against contacts using aliases with proper precedence.
 *
 * Longest-first, per-contact dedup, word-boundary, case-insensitive.
 */
export function matchWithAliases(
  text: string,
  contacts: Array<{ name: string; aliases?: string[]; kinship?: string }>,
): AliasMatch[] {
  if (!text || contacts.length === 0) return [];

  const terms: Array<{
    contactName: string;
    term: string;
    matchType: 'alias' | 'name' | 'kinship';
  }> = [];
  for (const contact of contacts) {
    if (contact.name.length >= 2) {
      terms.push({ contactName: contact.name, term: contact.name, matchType: 'name' });
    }
    for (const alias of contact.aliases ?? []) {
      if (alias.length >= 2) {
        terms.push({ contactName: contact.name, term: alias, matchType: 'alias' });
      }
    }
  }

  // Sort longest-first
  terms.sort((a, b) => b.term.length - a.term.length);

  const matches: AliasMatch[] = [];
  const seenContacts = new Set<string>();
  const coveredRanges: Array<[number, number]> = [];

  for (const { contactName, term, matchType } of terms) {
    if (seenContacts.has(contactName)) continue;

    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\b${escaped}\\b`, 'gi');

    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (coveredRanges.some(([s, e]) => start < e && end > s)) continue;
      if (seenContacts.has(contactName)) continue;

      matches.push({ contactName, matchedAlias: m[0], matchType });
      coveredRanges.push([start, end]);
      seenContacts.add(contactName);
      break;
    }
  }

  return matches;
}

/**
 * Determine attribution subject: alias wins over kinship role.
 * Returns first match by precedence (alias/name > kinship) or null.
 */
export function attributeWithPrecedence(
  text: string,
  contacts: Array<{ name: string; aliases?: string[]; kinship?: string }>,
): { subject: string; matchType: string } | null {
  const matches = matchWithAliases(text, contacts);
  if (matches.length === 0) {
    // Try kinship role matching as fallback
    for (const contact of contacts) {
      if (contact.kinship) {
        const escaped = contact.kinship.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`\\b${escaped}\\b`, 'i').test(text)) {
          return { subject: contact.name, matchType: 'kinship' };
        }
      }
    }
    return null;
  }

  // Alias/name have higher precedence
  const aliasOrName = matches.find((m) => m.matchType === 'alias' || m.matchType === 'name');
  if (aliasOrName) {
    return { subject: aliasOrName.contactName, matchType: aliasOrName.matchType };
  }

  return null;
}

/**
 * Override staging responsibility based on alias-identified subject.
 */
export function overrideStagingResponsibility(
  item: Record<string, unknown>,
  aliasMatch: AliasMatch,
): Record<string, unknown> {
  return {
    ...item,
    attributed_contact: aliasMatch.contactName,
    attributed_match_type: aliasMatch.matchType,
    attributed_alias: aliasMatch.matchedAlias,
  };
}

/**
 * Generate recall hints when alias-matched contacts are mentioned.
 */
export function generateRecallHints(
  text: string,
  contacts: Array<{ name: string; aliases?: string[] }>,
): string[] {
  const matches = matchWithAliases(text, contacts);
  return matches.map((m) => `Recall context for ${m.contactName}`);
}
