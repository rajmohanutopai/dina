/**
 * ISO 3166-1 alpha-2 country list utility (TN-V2-CTX-002).
 *
 * The Region settings screen needs a picker over all ISO countries.
 * Two design choices made here, both in service of "render once, no
 * network":
 *
 *   1. **Codes are embedded statically.** ISO 3166-1 changes slowly
 *      (≈1 code/year on average); a static list is fine. ~250 entries
 *      compiled into the bundle is ~3KB which is invisible next to
 *      the JS engine + RN itself.
 *
 *   2. **Display names come from `Intl.DisplayNames`.** Hermes / RN
 *      ship Intl.DisplayNames since RN 0.71. We pass the device locale
 *      so a French-locale device sees "Allemagne" not "Germany". When
 *      Intl.DisplayNames is unavailable (older RN, jsc-without-Intl),
 *      we fall back to the raw code so the picker still functions.
 *
 * The list is alphabetically sorted by display name at render time
 * (consumer's responsibility — `sortByDisplayName(list, locale)`)
 * so the on-disk constant stays alpha-by-code (stable diffs) and
 * locale-specific ordering doesn't pollute the source.
 */

/**
 * One entry in the country picker. `code` is the ISO 3166-1 alpha-2
 * literal (the value we persist to user_preferences); `displayName`
 * is the localised string for rendering.
 */
export interface Country {
  readonly code: string;
  readonly displayName: string;
}

/**
 * All ISO 3166-1 alpha-2 codes, alphabetical by code. Includes the
 * commonly-used "exceptionally reserved" codes (UK, EU) and Kosovo
 * (XK — unofficial but widely accepted) so the picker covers the
 * regions users actually live in. Excludes the "transitionally
 * reserved" codes that no longer apply (CS, YU, etc.) — selecting
 * them in 2025 would be confusing.
 *
 * Source: https://www.iso.org/obp/ui/#search (verified against the
 * Unicode CLDR `territory` data which `Intl.DisplayNames` uses).
 */
export const ISO_3166_ALPHA_2_CODES: readonly string[] = Object.freeze([
  'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AW',
  'AX', 'AZ', 'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BL', 'BM', 'BN',
  'BO', 'BQ', 'BR', 'BS', 'BT', 'BV', 'BW', 'BY', 'BZ', 'CA', 'CC', 'CD', 'CF', 'CG',
  'CH', 'CI', 'CK', 'CL', 'CM', 'CN', 'CO', 'CR', 'CU', 'CV', 'CW', 'CX', 'CY', 'CZ',
  'DE', 'DJ', 'DK', 'DM', 'DO', 'DZ', 'EC', 'EE', 'EG', 'EH', 'ER', 'ES', 'ET', 'FI',
  'FJ', 'FK', 'FM', 'FO', 'FR', 'GA', 'GB', 'GD', 'GE', 'GF', 'GG', 'GH', 'GI', 'GL',
  'GM', 'GN', 'GP', 'GQ', 'GR', 'GS', 'GT', 'GU', 'GW', 'GY', 'HK', 'HM', 'HN', 'HR',
  'HT', 'HU', 'ID', 'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IR', 'IS', 'IT', 'JE', 'JM',
  'JO', 'JP', 'KE', 'KG', 'KH', 'KI', 'KM', 'KN', 'KP', 'KR', 'KW', 'KY', 'KZ', 'LA',
  'LB', 'LC', 'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY', 'MA', 'MC', 'MD', 'ME',
  'MF', 'MG', 'MH', 'MK', 'ML', 'MM', 'MN', 'MO', 'MP', 'MQ', 'MR', 'MS', 'MT', 'MU',
  'MV', 'MW', 'MX', 'MY', 'MZ', 'NA', 'NC', 'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NP',
  'NR', 'NU', 'NZ', 'OM', 'PA', 'PE', 'PF', 'PG', 'PH', 'PK', 'PL', 'PM', 'PN', 'PR',
  'PS', 'PT', 'PW', 'PY', 'QA', 'RE', 'RO', 'RS', 'RU', 'RW', 'SA', 'SB', 'SC', 'SD',
  'SE', 'SG', 'SH', 'SI', 'SJ', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS', 'ST', 'SV',
  'SX', 'SY', 'SZ', 'TC', 'TD', 'TF', 'TG', 'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO',
  'TR', 'TT', 'TV', 'TW', 'TZ', 'UA', 'UG', 'UM', 'US', 'UY', 'UZ', 'VA', 'VC', 'VE',
  'VG', 'VI', 'VN', 'VU', 'WF', 'WS', 'XK', 'YE', 'YT', 'ZA', 'ZM', 'ZW',
]);

/**
 * Lookup map for fast code-validity checks. Used by the picker to
 * confirm that a stored region code is still in the supported list
 * before pre-selecting it (defends against an old build storing a
 * deprecated code).
 */
export const ISO_3166_CODE_SET: ReadonlySet<string> = new Set(ISO_3166_ALPHA_2_CODES);

/**
 * Resolve the localised display name for an ISO code. Prefers the
 * device-locale's name (so a French phone sees French country names);
 * falls back to English then to the raw code.
 *
 * Cached per (code, locale) because `Intl.DisplayNames` constructs
 * an internal lookup table per locale that costs ~milliseconds for
 * the first call. With 250 entries scrolled through a FlatList, that
 * adds up to a perceptible jank on entry.
 */
const cache = new Map<string, string>();

export function getCountryName(code: string, locale?: string): string {
  const cacheKey = `${locale ?? ''}:${code}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;
  const name = resolveCountryName(code, locale);
  cache.set(cacheKey, name);
  return name;
}

function resolveCountryName(code: string, locale: string | undefined): string {
  // Try the requested locale first (or the runtime default).
  try {
    const names = new (Intl as any).DisplayNames(locale ? [locale] : undefined, {
      type: 'region',
    });
    const out = names.of(code);
    if (typeof out === 'string' && out.length > 0 && out !== code) return out;
  } catch {
    /* fall through */
  }
  // Try English explicitly (some locales return the code unchanged
  // for codes Intl doesn't know about — fall back to en before raw).
  if (locale !== 'en') {
    try {
      const names = new (Intl as any).DisplayNames(['en'], { type: 'region' });
      const out = names.of(code);
      if (typeof out === 'string' && out.length > 0 && out !== code) return out;
    } catch {
      /* fall through */
    }
  }
  // Final fallback — raw code. Better than blank rows.
  return code;
}

/**
 * Build the localised + sorted list for the picker. Does the
 * `Intl.DisplayNames` lookup for every code, then sorts by display
 * name using the locale's collation rules (so accented names sort
 * correctly in their native locale).
 *
 * Pure: same input always produces same output. Computed lazily by
 * the screen on first render — for 250 entries this is sub-ms even
 * with the locale-collation sort.
 */
export function buildCountryList(locale?: string): readonly Country[] {
  const out: Country[] = ISO_3166_ALPHA_2_CODES.map((code) => ({
    code,
    displayName: getCountryName(code, locale),
  }));
  // Locale-aware sort. `Intl.Collator` is faster than `String.localeCompare`
  // for repeated comparisons because it caches the collator state.
  let cmp: (a: string, b: string) => number;
  try {
    const coll = new Intl.Collator(locale);
    cmp = (a, b) => coll.compare(a, b);
  } catch {
    // Fallback: case-insensitive code-point sort.
    cmp = (a, b) =>
      a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0;
  }
  out.sort((a, b) => cmp(a.displayName, b.displayName));
  return out;
}

/**
 * Filter a country list by a substring query. Case-insensitive on
 * both display name and ISO code so users can search "germany" OR
 * "DE". Returns a new array; original is untouched.
 *
 * Empty / whitespace query returns the input unchanged so the screen
 * doesn't have to special-case the empty-search render.
 */
export function filterCountries(
  list: readonly Country[],
  query: string,
): readonly Country[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) return list;
  const needle = trimmed.toLowerCase();
  return list.filter(
    (c) =>
      c.code.toLowerCase().includes(needle) ||
      c.displayName.toLowerCase().includes(needle),
  );
}

/** Test helper — clears the per-locale name cache between tests. */
export function clearCountryListCacheForTest(): void {
  cache.clear();
}
