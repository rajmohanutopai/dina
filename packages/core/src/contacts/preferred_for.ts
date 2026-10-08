/**
 * Preferred-for normalisation (PC-CORE-04).
 *
 * `Contact.preferredFor` is a user-asserted list of service categories
 * ("dental", "tax", ...) that marks a contact as the user's go-to for
 * those categories. The values ultimately drive the provider-services
 * resolver: `findByPreferredFor('dental')` returns the contact(s) the
 * user has picked as their dentist.
 *
 * Callers pass raw human input — voice transcripts, extracted
 * phrases from vault text, UI form fields — so the canonical shape
 * must be enforced in one place and reused by:
 *
 *   - `Contact` domain writes (setPreferredFor on the repository),
 *   - the HTTP `PUT /v1/contacts/{did}` handler (body arrives pre-
 *     validation),
 *   - the `findByPreferredFor` lookup (category argument must be
 *     normalised the same way the stored values are),
 *   - the staging processor's `_apply_preference_bindings` hook
 *     (merge step needs matching case/whitespace semantics).
 *
 * Rules (verbatim port of main-dina's `normalisePreferredFor`):
 *
 *   1. Lowercase.
 *   2. Trim surrounding whitespace.
 *   3. Drop empties (after trim).
 *   4. Dedup (by lowercased + trimmed form).
 *   5. Preserve first-seen ordering — so callers that care about
 *      the "primary" entry being first can rely on input order.
 *
 * Returns a fresh array; never mutates the input.
 */

/**
 * Clean a list of category strings into the canonical shape used for
 * storage and comparison.
 *
 * @example
 *   normalisePreferredForCategories(['  Dental  ', 'dental', '', 'TAX'])
 *   // → ['dental', 'tax']
 *
 * @example
 *   normalisePreferredForCategories([])
 *   // → []  (valid — meaning "clear all preferences")
 */
export function normalisePreferredForCategories(input: readonly string[]): string[] {
  if (!Array.isArray(input) || input.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const cleaned = raw.trim().toLowerCase();
    if (cleaned === '' || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

/**
 * Normalise a single category to the same shape `preferredFor` entries
 * are stored in. Used by `findByPreferredFor(category)` so the lookup
 * value comes into comparison range with the stored values.
 *
 * Returns empty string for invalid / blank input — callers treat an
 * empty normalised category as "don't match anything" (matching
 * main-dina's `FindByPreferredFor` behaviour).
 */
export function normalisePreferredForCategory(input: string): string {
  if (typeof input !== 'string') return '';
  return input.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// One vocabulary for roles and categories (REAL_LIFE_FIXES §5.3).
// ---------------------------------------------------------------------------

/**
 * Role words and the service categories they map to. The preference binder
 * (Brain) and the lookup (Core) share this one table, so "my plumber" and a
 * search for "plumbing" meet. Keep it conservative: adding a role is cheap;
 * removing one later changes what stored values match.
 */
export const PREFERRED_ROLE_TO_CATEGORIES: Readonly<Record<string, readonly string[]>> = Object.freeze({
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

/** Every role and category in a group → the group's first category. */
const CATEGORY_KEY: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  for (const [role, cats] of Object.entries(PREFERRED_ROLE_TO_CATEGORIES)) {
    const key = cats[0];
    if (key === undefined) continue;
    if (!m.has(role)) m.set(role, key);
    for (const c of cats) if (!m.has(c)) m.set(c, key);
  }
  return m;
})();

/**
 * The matching key of a preferred-for value: role and category forms of one
 * service fold together ("plumber", "plumbing", "plumbers" → "plumbing";
 * "accountant", "tax", "accounting" → "tax"). A word not in the table is
 * kept as given (lowercased), so unknown roles still match exactly.
 */
export function preferredForKey(input: string): string {
  const v = normalisePreferredForCategory(input).replace(/\s+/g, '_');
  if (v === '') return '';
  const direct = CATEGORY_KEY.get(v);
  if (direct !== undefined) return direct;
  // Plurals: "dentists" → "dentist", "plumbers" → "plumber".
  if (v.length > 3 && v.endsWith('s')) {
    const single = CATEGORY_KEY.get(v.slice(0, -1));
    if (single !== undefined) return single;
  }
  return v;
}
