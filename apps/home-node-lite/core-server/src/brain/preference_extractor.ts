/**
 * Task 5.40 — preference extractor.
 *
 * When the user writes "my dentist Dr Carl is on April 19" or "my
 * accountant is Linda Smith", they're asserting a preference: "Dr
 * Carl is who I go to for dental things." This module surfaces those
 * assertions so the staging processor can update the matched
 * contact's `preferred_for` list.
 *
 * **Why regex, not LLM**: deterministic, zero cost, zero latency,
 * good enough for the common phrasings. An LLM layer can be stacked
 * later (for creative phrasings like "I've been seeing Dr Patel for
 * my teeth for years"), called only when regex finds nothing.
 *
 * **Three pattern shapes** cover almost every captured assertion:
 *
 *   1. `my <role> <Name>`          ("my dentist Dr Carl")
 *   2. `my <role> is <Name>`       ("my dentist is Dr Carl")
 *   3. `my <role> … with <Name>`  ("my dentist appointment with Dr Carl")
 *
 * **Word-boundary anchoring** — the regex is case-insensitive for
 * `my` + role + `is` / `with`, but **case-sensitive on the name** so
 * capitalised proper nouns anchor the match. Without that, the name
 * group would happily swallow trailing lowercase words ("my dentist
 * Dr Carl is on April 19" → name = "Dr Carl is on April 19"). The
 * capital-letter anchor stops the regex at the first lowercase token.
 *
 * **De-duplication**: if the same assertion appears twice in one
 * item ("My dentist Dr Carl. Saw my dentist Dr Carl yesterday."),
 * only one candidate is emitted — keyed on `(role, lower(name))`.
 *
 * **Role → category mapping**: each role maps to one or more
 * categories that land in `Contact.preferred_for`. Categories are
 * stable human-readable lowercase strings — adding a role is cheap;
 * removing one is painful (back-fill implications). Match the Python
 * reference `brain/src/service/preference_extractor.py` for the
 * canonical role set.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5e task 5.40.
 */

/** Role word → categories the role implies. Keys are lowercase. */
const ROLE_TO_CATEGORIES: ReadonlyMap<string, readonly string[]> = new Map([
  ['dentist', ['dental']],
  ['doctor', ['medical']],
  ['physician', ['medical']],
  ['gp', ['medical']],
  ['paediatrician', ['pediatric']],
  ['pediatrician', ['pediatric']],
  ['accountant', ['tax', 'accounting']],
  ['cpa', ['tax', 'accounting']],
  ['lawyer', ['legal']],
  ['attorney', ['legal']],
  ['mechanic', ['automotive']],
  ['plumber', ['plumbing']],
  ['electrician', ['electrical']],
  ['vet', ['veterinary']],
  ['veterinarian', ['veterinary']],
  ['barber', ['hair']],
  ['hairdresser', ['hair']],
  ['stylist', ['hair']],
  ['therapist', ['mental_health']],
  ['psychiatrist', ['mental_health']],
  ['psychologist', ['mental_health']],
  ['trainer', ['fitness']],
  ['coach', ['fitness']],
  ['pharmacist', ['pharmacy']],
  ['optometrist', ['optical']],
  ['chiropractor', ['chiropractic']],
  ['physiotherapist', ['physiotherapy']],
  ['physio', ['physiotherapy']],
  ['realtor', ['real_estate']],
  ['broker', ['real_estate']],
  ['banker', ['banking']],
  ['florist', ['floral']],
  ['tailor', ['tailoring']],
  ['architect', ['architecture']],
  ['contractor', ['construction']],
  ['landscaper', ['landscaping']],
  ['gardener', ['landscaping']],
  ['nanny', ['childcare']],
  ['babysitter', ['childcare']],
  ['tutor', ['education']],
  ['teacher', ['education']],
]);

/** A surface (role, name, categories) extracted from text. */
export interface PreferenceCandidate {
  role: string;
  name: string;
  /** The categories that land in `Contact.preferred_for`. */
  categories: string[];
}

// ── Regex construction ─────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Convert a lowercase ASCII word into a case-insensitive regex
 * fragment built from character classes (`dentist` →
 * `[Dd][Ee][Nn][Tt][Ii][Ss][Tt]`). We can't use the regex `i` flag
 * because it would also turn `[A-Z]` in the NAME pattern into a
 * case-insensitive match — swallowing trailing lowercase words like
 * "is" / "on" as part of the name. So we scope case-insensitivity
 * per-keyword, manually.
 */
function ci(word: string): string {
  let out = '';
  for (const ch of word) {
    if (/[a-zA-Z]/.test(ch)) {
      const lo = ch.toLowerCase();
      const hi = ch.toUpperCase();
      out += `[${lo}${hi}]`;
    } else {
      out += escapeRegex(ch);
    }
  }
  return out;
}

/** Longest-first so `paediatrician` wins over a hypothetical subrole. */
const ROLE_ALTERNATION = Array.from(ROLE_TO_CATEGORIES.keys())
  .map(ci)
  .sort((a, b) => b.length - a.length)
  .join('|');

/** Titles: Dr / Dr. / Mr / Mr. / ... — also CI. */
const TITLE_SOURCE = `(?:${['Dr', 'Mr', 'Mrs', 'Ms', 'Prof']
  .map((t) => `${ci(t)}\\.?`)
  .join('|')})`;

// Name: capital-first + allowed name chars; up to 3 capitalised words.
// Case-SENSITIVE because the regex has NO `i` flag.
const NAME_SOURCE = "[A-Z][a-zA-Z'-]+(?:\\s+[A-Z][a-zA-Z'-]+){0,2}";

/**
 * "my <role> is <Name>" — most specific, runs first so the dedupe
 * key (role, lower(name)) catches it before the direct form sees it.
 */
const PATTERN_IS = new RegExp(
  `\\b${ci('my')}\\s+(${ROLE_ALTERNATION})\\s+${ci('is')}\\s+((?:${TITLE_SOURCE})\\s+)?(${NAME_SOURCE})`,
  'g',
);

/**
 * "my <role> ... with <Name>" — bridges filler ("appointment",
 * "consultation", "session") with up to 4 lowercase tokens before
 * `with`. Non-greedy so it stops at the first `with`.
 */
const PATTERN_WITH = new RegExp(
  `\\b${ci('my')}\\s+(${ROLE_ALTERNATION})\\s+[a-z]+(?:\\s+[a-z]+){0,3}?\\s+${ci('with')}\\s+((?:${TITLE_SOURCE})\\s+)?(${NAME_SOURCE})`,
  'g',
);

/** "my <role> <Name>" — baseline pattern; runs after the specific ones. */
const PATTERN_DIRECT = new RegExp(
  `\\b${ci('my')}\\s+(${ROLE_ALTERNATION})\\s+((?:${TITLE_SOURCE})\\s+)?(${NAME_SOURCE})`,
  'g',
);

/**
 * Stateless regex-based preference extractor. Safe to share across
 * concurrent calls — no mutable state, no allocation in the hot path
 * beyond the result array.
 */
export class PreferenceExtractor {
  /**
   * Extract every preference candidate from `text`. Returns `[]` for
   * empty input. De-duplicates overlapping matches across the 3
   * patterns by `(role, lower(name))`.
   */
  extract(text: string): PreferenceCandidate[] {
    if (typeof text !== 'string' || text.length === 0) return [];
    const seen = new Set<string>();
    const out: PreferenceCandidate[] = [];

    // Order matters: specific patterns first so their matches register
    // in `seen` before the baseline catches the same phrase.
    for (const pattern of [PATTERN_IS, PATTERN_WITH, PATTERN_DIRECT]) {
      pattern.lastIndex = 0; // shared regex instance — reset iterator
      for (const match of text.matchAll(pattern)) {
        const roleWord = match[1]!.toLowerCase();
        const title = (match[2] ?? '').trim();
        const nameRaw = match[3]!.trim();
        const fullName = title ? `${title} ${nameRaw}` : nameRaw;
        const key = `${roleWord}::${fullName.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const cats = ROLE_TO_CATEGORIES.get(roleWord);
        if (!cats) continue; // should never fire — regex restricts
        out.push({
          role: roleWord,
          name: fullName,
          categories: [...cats],
        });
      }
    }
    return out;
  }

  /**
   * Sorted list of role words the extractor will recognise. Exposed
   * for diagnostics + admin UI listings; tests pin this to catch
   * accidental role drift.
   */
  get knownRoles(): readonly string[] {
    return Array.from(ROLE_TO_CATEGORIES.keys()).sort();
  }

  /** Categories for a role, or `[]` if the role is unknown. */
  categoriesFor(role: string): readonly string[] {
    return ROLE_TO_CATEGORIES.get(role.toLowerCase()) ?? [];
  }
}
