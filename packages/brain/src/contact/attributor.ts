/**
 * Subject attribution — determines WHO a piece of text is about.
 *
 * Subjects: self, known contact (external), household, third party, unresolved
 *
 * Priority (highest first):
 *   1. Self: first-person pronouns (I, my, me, myself, mine)
 *   2. External: known contact name mentioned
 *   3. Household: household member name or family role ("my daughter")
 *   4. Third party: proper nouns not in contacts (unknown names)
 *   5. Unresolved: no subject indicators found
 *
 * When self AND external appear, self wins (user is primary subject).
 *
 * Source: brain/tests/test_subject_attributor.py
 */

export type SubjectType = 'self' | 'external' | 'household' | 'third_party' | 'unresolved';

export interface SubjectAttribution {
  subjectType: SubjectType;
  subjectName?: string;
  contactDID?: string;
  confidence: number;
}

export interface AttributorContext {
  contacts: Array<{ name: string; did: string; relationship?: string }>;
  householdMembers?: string[];
}

/** First-person indicators (word-boundary, case-insensitive). */
const SELF_PATTERN = /\b(I|my|me|myself|mine|I'm|I've|I'll|I'd)\b/i;

/** Household role phrases that indicate a household member. */
const HOUSEHOLD_ROLE_PATTERNS = [
  /\bmy\s+(daughter|son|wife|husband|partner|child|kid|baby|mother|father|mom|dad|sister|brother)\b/i,
];

/**
 * Attribute the subject of a text segment.
 */
export function attributeSubject(text: string, context: AttributorContext): SubjectAttribution {
  if (!text || text.trim().length === 0) {
    return { subjectType: 'unresolved', confidence: 0.0 };
  }

  const selfRef = isSelfReference(text);
  const contactName = mentionsContact(
    text,
    context.contacts.map((c) => c.name),
  );
  const householdName = mentionsHousehold(text, context.householdMembers ?? []);
  const householdRole = matchesHouseholdRole(text);

  // Priority 1: Self reference wins (user is primary subject)
  if (selfRef) {
    // Check for household role phrases like "my daughter"
    if (householdRole) {
      return { subjectType: 'household', subjectName: householdRole, confidence: 0.8 };
    }
    return { subjectType: 'self', confidence: 0.9 };
  }

  // Priority 2: Known contact mentioned
  if (contactName) {
    const contact = context.contacts.find(
      (c) => c.name.toLowerCase() === contactName.toLowerCase(),
    );
    return {
      subjectType: 'external',
      subjectName: contactName,
      contactDID: contact?.did,
      confidence: 0.85,
    };
  }

  // Priority 3: Household member mentioned
  if (householdName) {
    return { subjectType: 'household', subjectName: householdName, confidence: 0.8 };
  }

  // Priority 4: Unknown proper noun → third party
  const unknownName = findUnknownProperNoun(text, context);
  if (unknownName) {
    return { subjectType: 'third_party', subjectName: unknownName, confidence: 0.5 };
  }

  // Priority 5: No indicators
  return { subjectType: 'unresolved', confidence: 0.3 };
}

/**
 * Check if text uses first-person indicators (I, my, me, myself).
 */
export function isSelfReference(text: string): boolean {
  if (!text) return false;
  return SELF_PATTERN.test(text);
}

/**
 * Check if text mentions a known contact by name.
 * Returns the matched contact name or null.
 */
export function mentionsContact(text: string, contactNames: string[]): string | null {
  if (!text || !contactNames || contactNames.length === 0) return null;

  const textLower = text.toLowerCase();
  // Sort longest-first to match "Dr. Shah" before "Shah"
  const sorted = [...contactNames].sort((a, b) => b.length - a.length);

  for (const name of sorted) {
    if (name.length < 2) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\b${escaped}\\b`, 'i');
    if (pattern.test(text)) {
      return name;
    }
  }

  return null;
}

/**
 * Check if text mentions a household member.
 * Returns the matched member name or null.
 */
export function mentionsHousehold(text: string, householdMembers: string[]): string | null {
  if (!text || !householdMembers || householdMembers.length === 0) return null;

  for (const member of householdMembers) {
    if (member.length < 2) continue;
    const escaped = member.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\b${escaped}\\b`, 'i');
    if (pattern.test(text)) {
      return member;
    }
  }

  return null;
}

/** Check if text contains household role phrases ("my daughter", "my son", etc). */
function matchesHouseholdRole(text: string): string | null {
  for (const pattern of HOUSEHOLD_ROLE_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      return match[1]; // return the role (e.g., "daughter")
    }
  }
  return null;
}

/** Common English words to exclude from proper noun detection. */
const COMMON_WORDS = new Set([
  'the',
  'and',
  'but',
  'for',
  'not',
  'you',
  'all',
  'can',
  'her',
  'was',
  'one',
  'quarterly',
  'annual',
  'monthly',
  'weekly',
  'daily',
  'summary',
  'report',
  'sales',
  'status',
  'update',
  'meeting',
  'project',
  'review',
  'beautiful',
]);

/** Find proper nouns not in contacts or household. */
function findUnknownProperNoun(text: string, context: AttributorContext): string | null {
  const knownNames = new Set([
    ...context.contacts.map((c) => c.name.toLowerCase()),
    ...(context.householdMembers ?? []).map((m) => m.toLowerCase()),
  ]);

  // Split into words, skip the first word of each sentence (often capitalized)
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);

  for (const sentence of sentences) {
    const words = sentence.trim().split(/\s+/);
    for (let i = 0; i < words.length; i++) {
      const cleaned = words[i].replace(/[^a-zA-Z]/g, '');
      if (
        cleaned.length >= 3 &&
        /^[A-Z][a-z]+$/.test(cleaned) &&
        !knownNames.has(cleaned.toLowerCase()) &&
        !COMMON_WORDS.has(cleaned.toLowerCase())
      ) {
        // For the first word: only treat as a name if the next word
        // is lowercase (a name followed by a verb, e.g., "Charlie called")
        if (i === 0 && words.length > 1) {
          const nextWord = words[1]?.replace(/[^a-zA-Z]/g, '');
          if (nextWord && /^[a-z]/.test(nextWord)) {
            return cleaned; // Likely a name at sentence start
          }
          continue; // Likely just a capitalized sentence start
        }
        return cleaned;
      }
    }
  }

  return null;
}
