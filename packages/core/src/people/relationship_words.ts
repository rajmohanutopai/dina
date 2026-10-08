/**
 * Relationship words are roles, not names (REAL_LIFE_FIXES §5.1).
 *
 * "my mom", "our boss" and "Sancho's mother" describe how someone relates to
 * a person; they are not that someone's name. Current practice (Siri's
 * related names, Mem0's user entity) stores a relationship as a typed link
 * from the owner (or another person) to a person, filled in with a real
 * name once one is known. This module is the one shared reading of such a
 * phrase, used by the people graph and the PII name lists.
 */

/**
 * Words that name a relationship and are never anyone's given name. The PII
 * name list never hides a word in this set, so it stays short: a real name
 * here would leak. A relationship word missing from it only means a phrase
 * is stored as a name surface, as before.
 */
export const RELATIONSHIP_WORDS: ReadonlySet<string> = new Set([
  'mom',
  'mum',
  'mother',
  'dad',
  'father',
  'wife',
  'husband',
  'son',
  'daughter',
  'brother',
  'sister',
  'grandmother',
  'grandfather',
  'grandma',
  'grandpa',
  'aunt',
  'uncle',
  'cousin',
  'nephew',
  'niece',
  'boss',
]);

/** A relationship phrase read apart: whose relation, and which relation. */
export interface RelationshipPhrase {
  /** `self` for "my / our / bare word"; otherwise the possessor as written ("Sancho"). */
  owner: string;
  /** The relationship word, lower case ("mother"). */
  role: string;
  /** The canonical surface: "my mother" or "sancho's mother". */
  phrase: string;
}

function squeeze(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Read `text` as a relationship phrase, or null when it is not one. Accepts
 * "my X", "our X", a bare "X", and "<Name>'s X" where X is a relationship
 * word. Anything else (a real name, "my friend Juno") is not a phrase.
 */
export function parseRelationshipPhrase(text: string): RelationshipPhrase | null {
  const t = squeeze(text).replace(/[’]/g, "'");
  if (t === '') return null;
  const lower = t.toLowerCase();
  const own = /^(?:my|our)\s+(.+)$/.exec(lower);
  if (own !== null) {
    const role = own[1]!;
    return RELATIONSHIP_WORDS.has(role) ? { owner: 'self', role, phrase: `my ${role}` } : null;
  }
  if (RELATIONSHIP_WORDS.has(lower)) return { owner: 'self', role: lower, phrase: `my ${lower}` };
  const poss = /^(.+?)'s?\s+(\S+)$/.exec(t);
  if (poss !== null) {
    const role = poss[2]!.toLowerCase();
    const who = squeeze(poss[1]!);
    if (RELATIONSHIP_WORDS.has(role) && who !== '' && !/^(?:my|our)$/i.test(who)) {
      return { owner: who, role, phrase: `${who.toLowerCase()}'s ${role}` };
    }
  }
  return null;
}

/** True when `text` names a relationship rather than a person. */
export function isRelationshipPhrase(text: string): boolean {
  return parseRelationshipPhrase(text) !== null;
}
