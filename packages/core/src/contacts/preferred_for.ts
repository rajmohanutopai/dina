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
