/**
 * Preference extractor (PC-BRAIN-12).
 *
 * When the user writes something like "my dentist Dr Carl is on April
 * 19" or "my accountant is Linda Smith", they're *asserting* a
 * preference: "Dr Carl is who I go to for dental things." This
 * module surfaces those assertions so the staging processor
 * (PC-BRAIN-13) can update the matched contact's `preferredFor` list.
 *
 * Regex-based on purpose — deterministic, no LLM spend, and good
 * enough for the common phrasings. An LLM augmentation layer (for
 * more creative phrasings like "I've been seeing Dr Patel for my
 * teeth for years") can be added later, called only when regex
 * finds nothing.
 *
 * See docs/WORKING_MEMORY_DESIGN.md §6.1 for why this replaces the
 * old auto-enriched `live_capability` stamp — capability metadata
 * belongs in AppView; user preference belongs on the contact.
 *
 * JavaScript-regex note: the Python port uses scoped inline flags
 * (`(?i:...)` / `(?-i:...)`) to mix case-insensitive role words
 * with a case-SENSITIVE name group on the same pattern. JavaScript
 * regex does not support scoped flags, AND `[A-Z]` under the `/i`
 * flag expands to `[A-Za-z]` (so the outer `/i` would break the
 * case-sensitivity anchor on the name group).
 *
 * The workaround is a two-phase match:
 *   1. Anchor pass — runs on the lowercased text without `/i`, so
 *      `my` / role / `is` / `with` / `[a-z]+` filler all match
 *      naturally without touching character-class semantics.
 *   2. Name pass — runs on the ORIGINAL text starting at the anchor
 *      boundary, with a case-sensitive `[A-Z]` guard. Names are
 *      case-anchored; "Dr Carl is on April 19" stops at "Dr Carl"
 *      because "is" starts lowercase.
 */

/**
 * Role word → category (or categories) it implies. Lowercase keys.
 * Categories are the values that end up in `Contact.preferredFor`,
 * so they should be stable, lowercase, human-readable strings. Keep
 * the list conservative — adding a role is cheap; removing one later
 * hurts (back-fill implications).
 */
const ROLE_TO_CATEGORIES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  dentist: ['dental'],
  doctor: ['medical'],
  physician: ['medical'],
  gp: ['medical'],
  paediatrician: ['pediatric'],
  pediatrician: ['pediatric'],
  accountant: ['tax', 'accounting'],
  cpa: ['tax', 'accounting'],
  lawyer: ['legal'],
  attorney: ['legal'],
  mechanic: ['automotive'],
  plumber: ['plumbing'],
  electrician: ['electrical'],
  vet: ['veterinary'],
  veterinarian: ['veterinary'],
  barber: ['hair'],
  hairdresser: ['hair'],
  stylist: ['hair'],
  therapist: ['mental_health'],
  psychiatrist: ['mental_health'],
  psychologist: ['mental_health'],
  trainer: ['fitness'],
  coach: ['fitness'],
  pharmacist: ['pharmacy'],
  optometrist: ['optical'],
  chiropractor: ['chiropractic'],
  physiotherapist: ['physiotherapy'],
  physio: ['physiotherapy'],
  realtor: ['real_estate'],
  broker: ['real_estate'],
  banker: ['banking'],
  florist: ['floral'],
  tailor: ['tailoring'],
  architect: ['architecture'],
  contractor: ['construction'],
  landscaper: ['landscaping'],
  gardener: ['landscaping'],
  nanny: ['childcare'],
  babysitter: ['childcare'],
  tutor: ['education'],
  teacher: ['education'],
});

/** A single preference candidate extracted from free text. */
export interface PreferenceCandidate {
  /** Lowercased role word ("dentist", "lawyer", ...). */
  role: string;
  /** Matched name, casing preserved — "Dr Carl", "Linda Smith". */
  name: string;
  /** Categories the role maps to — e.g. ['dental'] or ['tax', 'accounting']. */
  categories: readonly string[];
}

// -----------------------------------------------------------------------------
// Regex assembly
// -----------------------------------------------------------------------------

/**
 * Role alternation, sorted longest-first so "paediatrician" beats the
 * prefix of "pae...". Keys are regex-safe (ASCII only) but escape
 * anyway for defence-in-depth.
 */
const ROLE_ALTERNATION = Object.keys(ROLE_TO_CATEGORIES)
  .map((r) => r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .sort((a, b) => b.length - a.length)
  .join('|');

// Case-sensitive name pattern, anchored at the start of the slice.
// Optional honorific ("Dr ", "Mr. ", ...) followed by 1–3
// capitalised words. `[A-Z]` is case-SENSITIVE (no `/i` flag).
// Apostrophes and hyphens are allowed inside names ("O'Brien",
// "Smith-Jones").
const NAME_WITH_TITLE = new RegExp(
  "^((?:Dr\\.?|Mr\\.?|Mrs\\.?|Ms\\.?|Prof\\.?)\\s+)?([A-Z][a-zA-Z'-]+(?:\\s+[A-Z][a-zA-Z'-]+){0,2})",
);

/**
 * Anchor-pass patterns. Run on LOWERCASED text so no `/i` flag is
 * needed and `[a-z]+` behaves intuitively. Each pattern's full
 * match ends at the exact byte position the name should start from
 * in the original text — see `extract()`.
 *
 * Order is load-bearing: the more specific forms (`is`, `with`) run
 * before `direct` so overlapping direct matches collapse into the
 * specific form during dedup.
 */
const ANCHORS: ReadonlyArray<RegExp> = [
  new RegExp(`\\bmy\\s+(${ROLE_ALTERNATION})\\s+is\\s+`, 'g'),
  new RegExp(`\\bmy\\s+(${ROLE_ALTERNATION})\\s+[a-z]+(?:\\s+[a-z]+){0,3}?\\s+with\\s+`, 'g'),
  new RegExp(`\\bmy\\s+(${ROLE_ALTERNATION})\\s+`, 'g'),
];

// -----------------------------------------------------------------------------
// PreferenceExtractor
// -----------------------------------------------------------------------------

/**
 * Regex-based extractor for user-asserted preference bindings.
 * Stateless — safe to share across threads / concurrent calls.
 */
export class PreferenceExtractor {
  /**
   * Scan `text` for "my <role> <Name>"-style assertions.
   *
   * Deduplicates by `(role, lowercased-name)`: if the same assertion
   * appears twice in one item ("My dentist Dr Carl. I saw my dentist
   * Dr Carl yesterday."), it only counts once.
   *
   * Returns candidates in the order they first appeared in the text.
   * `is` and `with` forms are checked first (more specific) so they
   * win dedup against an overlapping direct match.
   */
  extract(text: string): PreferenceCandidate[] {
    if (!text) return [];
    const lower = text.toLowerCase();
    const seen = new Set<string>();
    const out: PreferenceCandidate[] = [];

    for (const anchor of ANCHORS) {
      // Reset `.lastIndex` on each use — the regex is a shared
      // module-level constant and the `g` flag mutates its state
      // across calls.
      anchor.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = anchor.exec(lower)) !== null) {
        const roleWord = match[1];
        // The anchor's full match ends at the exact byte where the
        // name should start — read the name from the ORIGINAL text
        // (not the lowercased copy) so we can enforce case
        // sensitivity on capitals.
        const nameStart = match.index + match[0].length;
        const tail = text.slice(nameStart);
        const nameMatch = NAME_WITH_TITLE.exec(tail);
        if (nameMatch === null) continue;

        const title = (nameMatch[1] ?? '').trim();
        const name = nameMatch[2];
        const fullName = title !== '' ? `${title} ${name}` : name;
        const key = `${roleWord}|${fullName.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const categories = ROLE_TO_CATEGORIES[roleWord];
        if (categories === undefined) continue;
        out.push({
          role: roleWord,
          name: fullName,
          categories,
        });
      }
    }

    return out;
  }

  /** Sorted list of role words the extractor will recognise. */
  get knownRoles(): readonly string[] {
    return Object.keys(ROLE_TO_CATEGORIES).sort();
  }
}
