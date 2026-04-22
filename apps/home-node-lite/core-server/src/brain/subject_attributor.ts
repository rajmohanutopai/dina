/**
 * Subject attributor (GAP.md row #23 closure — M2 blocker).
 *
 * Answers: **"who is this content about?"**
 *
 * The nudge assembler + reminder planner need a subject to render
 * useful output:
 *
 *   - "Your dentist appointment tomorrow" (subject = self)
 *   - "Alice's birthday is Friday" (subject = alice contact)
 *   - "Something happened" (subject = unknown; drop the nudge)
 *
 * This primitive maps text + a known contact set → a structured
 * attribution: `{ subject, confidence, evidence[] }` where `subject`
 * is one of:
 *
 *   - `self`     — first-person references dominate.
 *   - `contact:<id>` — a contact from the known list is the dominant
 *                      third-person referent.
 *   - `group`    — plural first-person ("we", "us") — family / team
 *                  context.
 *   - `unknown`  — no clear subject signal.
 *
 * **Algorithm** (heuristic, zero-dep):
 *
 *   1. Count first-person singular markers (I, me, my, mine, myself)
 *      → self evidence.
 *   2. Count first-person plural markers (we, us, our, ours) → group
 *      evidence.
 *   3. For each known contact, scan for name matches (full name,
 *      first name, case-insensitive word boundaries) → contact
 *      evidence keyed by contact id.
 *   4. Weight: explicit full-name match 2.0, single-token match 1.0,
 *      each pronoun occurrence 1.0.
 *   5. Subject is the winner if its weighted score exceeds the
 *      runner-up by the configured `marginRequired` (default 1.5).
 *      Otherwise → `unknown`.
 *   6. Confidence = winner_score / (winner_score + runner_up_score).
 *
 * **Contact-name false-positive guard**: single-token name matches
 * skip when the only occurrence is a capitalised sentence-start
 * that happens to match the name. E.g. "May" as a contact first
 * name matches "May 3rd" — we deliberately don't exclude that
 * because the cost of false subject attribution is low (wrong nudge
 * drops to unknown in the downstream scorer). Callers who want
 * stricter matching pass `requireFullName: true`.
 *
 * **Deterministic**: same input → same output. No RNG, no async.
 *
 * Source: GAP.md (task 5.46 follow-up) — M2 persona-tier +
 * nudge/reminder pipelines gate.
 */

export interface Contact {
  /** Stable contact id. */
  id: string;
  /** Full display name — used for "Alice Smith" style matches. */
  fullName: string;
  /** Alternative names / aliases. First token of fullName is auto-added. */
  aliases?: ReadonlyArray<string>;
}

export type Subject =
  | { kind: 'self' }
  | { kind: 'contact'; contactId: string }
  | { kind: 'group' }
  | { kind: 'unknown' };

export interface AttributionEvidence {
  /** What the evidence refers to. */
  kind: 'self_pronoun' | 'group_pronoun' | 'contact_name';
  /** For contact_name: the contact id. Otherwise undefined. */
  contactId?: string;
  /** The matched substring. */
  match: string;
  /** Score contribution (weighted). */
  weight: number;
  /** Character range. */
  span: { start: number; end: number };
}

export interface SubjectAttribution {
  subject: Subject;
  /** Confidence in [0, 1]. 0 when `unknown`. */
  confidence: number;
  /** Every match the attributor found, in document order. */
  evidence: AttributionEvidence[];
}

export interface AttributeSubjectOptions {
  /** Known contacts to match against. Defaults to empty. */
  contacts?: ReadonlyArray<Contact>;
  /** Require full-name matches (disable single-token matches). Default false. */
  requireFullName?: boolean;
  /** Minimum margin by which the winner must beat the runner-up. Default 1.5. */
  marginRequired?: number;
}

const SELF_PRONOUNS: ReadonlySet<string> = new Set([
  'i', 'me', 'my', 'mine', 'myself',
]);
const GROUP_PRONOUNS: ReadonlySet<string> = new Set([
  'we', 'us', 'our', 'ours', 'ourselves',
]);

const WEIGHT_SELF_PRONOUN = 1.0;
const WEIGHT_GROUP_PRONOUN = 1.0;
const WEIGHT_CONTACT_FIRST_NAME = 1.0;
const WEIGHT_CONTACT_FULL_NAME = 2.0;

export const DEFAULT_MARGIN_REQUIRED = 1.5;

/**
 * Attribute a subject to the text. Returns `unknown` when no signal
 * beats the configured margin.
 */
export function attributeSubject(
  text: string,
  opts: AttributeSubjectOptions = {},
): SubjectAttribution {
  if (typeof text !== 'string' || text.trim() === '') {
    return { subject: { kind: 'unknown' }, confidence: 0, evidence: [] };
  }

  const contacts = opts.contacts ?? [];
  const requireFullName = opts.requireFullName ?? false;
  const marginRequired = opts.marginRequired ?? DEFAULT_MARGIN_REQUIRED;

  const evidence: AttributionEvidence[] = [];
  const scores = new Map<string, number>(); // key: 'self' | 'group' | `contact:${id}`

  const addScore = (key: string, weight: number): void => {
    scores.set(key, (scores.get(key) ?? 0) + weight);
  };

  // 1. Pronoun scan — iterate words.
  const wordPattern = /\b[\p{L}][\p{L}'-]*\b/gu;
  let match: RegExpExecArray | null;
  while ((match = wordPattern.exec(text)) !== null) {
    const lower = match[0].toLowerCase();
    const span = { start: match.index, end: match.index + match[0].length };
    if (SELF_PRONOUNS.has(lower)) {
      evidence.push({
        kind: 'self_pronoun',
        match: match[0],
        weight: WEIGHT_SELF_PRONOUN,
        span,
      });
      addScore('self', WEIGHT_SELF_PRONOUN);
    } else if (GROUP_PRONOUNS.has(lower)) {
      evidence.push({
        kind: 'group_pronoun',
        match: match[0],
        weight: WEIGHT_GROUP_PRONOUN,
        span,
      });
      addScore('group', WEIGHT_GROUP_PRONOUN);
    }
  }

  // 2. Contact-name scan.
  for (const contact of contacts) {
    validateContact(contact);
    // Full-name match first (heavier weight).
    for (const fullMatch of findWordMatches(text, contact.fullName)) {
      evidence.push({
        kind: 'contact_name',
        contactId: contact.id,
        match: fullMatch.text,
        weight: WEIGHT_CONTACT_FULL_NAME,
        span: fullMatch.span,
      });
      addScore(`contact:${contact.id}`, WEIGHT_CONTACT_FULL_NAME);
    }
    if (requireFullName) continue;

    // Single-token fallback: aliases + auto-derived first name.
    const singleTokens = new Set<string>(
      (contact.aliases ?? []).map((a) => a.trim()).filter((a) => a !== ''),
    );
    const firstToken = contact.fullName.trim().split(/\s+/)[0];
    if (firstToken) singleTokens.add(firstToken);

    for (const token of singleTokens) {
      if (!/^\S+$/.test(token)) continue; // single word only
      for (const tokenMatch of findWordMatches(text, token)) {
        // Don't double-count a span that's inside the fullName match.
        if (evidence.some(
          (e) =>
            e.contactId === contact.id &&
            e.span.start <= tokenMatch.span.start &&
            e.span.end >= tokenMatch.span.end,
        )) continue;
        evidence.push({
          kind: 'contact_name',
          contactId: contact.id,
          match: tokenMatch.text,
          weight: WEIGHT_CONTACT_FIRST_NAME,
          span: tokenMatch.span,
        });
        addScore(`contact:${contact.id}`, WEIGHT_CONTACT_FIRST_NAME);
      }
    }
  }

  // 3. Decide subject.
  evidence.sort((a, b) => a.span.start - b.span.start);

  if (scores.size === 0) {
    return { subject: { kind: 'unknown' }, confidence: 0, evidence };
  }

  const ranked = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]);
  const [winnerKey, winnerScore] = ranked[0]!;
  const runnerUpScore = ranked[1]?.[1] ?? 0;

  // Margin check — winner must exceed runner-up by at least marginRequired.
  if (runnerUpScore > 0 && winnerScore < runnerUpScore * marginRequired) {
    return { subject: { kind: 'unknown' }, confidence: 0, evidence };
  }

  const subject = decodeSubjectKey(winnerKey);
  // winnerScore is strictly positive here — scores only accumulate
  // from actual matches. Skip the 0/0 fallback path.
  const confidence = winnerScore / (winnerScore + runnerUpScore);

  return { subject, confidence, evidence };
}

// ── Internals ──────────────────────────────────────────────────────────

function validateContact(contact: Contact): void {
  if (typeof contact.id !== 'string' || contact.id === '') {
    throw new TypeError('Contact.id must be a non-empty string');
  }
  if (typeof contact.fullName !== 'string' || contact.fullName.trim() === '') {
    throw new TypeError(`Contact.fullName must be a non-empty string (contact ${contact.id})`);
  }
}

function decodeSubjectKey(key: string): Subject {
  if (key === 'self') return { kind: 'self' };
  if (key === 'group') return { kind: 'group' };
  if (key.startsWith('contact:')) {
    return { kind: 'contact', contactId: key.slice('contact:'.length) };
  }
  return { kind: 'unknown' };
}

/** Find whole-word matches of `needle` in `haystack`, case-insensitive. */
function findWordMatches(
  haystack: string,
  needle: string,
): Array<{ text: string; span: { start: number; end: number } }> {
  const trimmed = needle.trim();
  if (trimmed === '') return [];
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Use unicode-aware boundaries: `(?<!\p{L})` and `(?!\p{L})` so
  // "May" in "Maya" doesn't match. Fallback to `\b` if lookbehind
  // fails (older runtime) — Node 22 supports it.
  const pattern = new RegExp(`(?<!\\p{L})${escaped}(?!\\p{L})`, 'giu');
  const out: Array<{ text: string; span: { start: number; end: number } }> = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(haystack)) !== null) {
    out.push({
      text: match[0],
      span: { start: match.index, end: match.index + match[0].length },
    });
    if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
  }
  return out;
}
