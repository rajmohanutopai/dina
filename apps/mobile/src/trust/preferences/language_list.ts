/**
 * BCP-47 language list utility (TN-V2-CTX-004).
 *
 * The Languages settings screen needs a multi-select picker over a
 * sensible set of languages. Two design choices, paralleling
 * `country_list.ts`:
 *
 *   1. **Tags are embedded statically.** ISO 639 has ~7000 codes
 *      across all variants; a mobile picker over all of them is
 *      hostile UX. We embed the ~80 tags with substantial digital
 *      content (≥ 1M Wikipedia articles or ≥ 50M speakers), with
 *      regional variants only where the variant is meaningful for
 *      content (zh-Hans vs zh-Hant, pt-BR vs pt-PT).
 *
 *   2. **Display names come from `Intl.DisplayNames({ type: 'language' })`.**
 *      Same plumbing as country_list: localised at render time, falls
 *      back through the device locale → English → raw tag.
 *
 * Sort + filter helpers are provided so the screen stays a thin
 * renderer. The list is stored alpha-by-tag; the screen sorts by
 * localised display name when it builds the picker list.
 */

/**
 * One entry in the language picker. `tag` is the BCP-47 literal we
 * persist (e.g. `'en-US'`, `'zh-Hans'`); `displayName` is the
 * localised string for rendering.
 */
export interface Language {
  readonly tag: string;
  readonly displayName: string;
}

/**
 * Curated BCP-47 list. Inclusion criteria: ≥ 50M native speakers OR
 * ≥ 1M Wikipedia articles (a digital-content-availability proxy that
 * matters for the trust network's filtering use). Regional variants
 * only when the variant has substantially different written content
 * (zh-Hans vs zh-Hant: different scripts; pt-BR vs pt-PT: different
 * orthography post-1990 reform; en-US vs en-GB: ignored — same script
 * + close-enough orthography for a content-filter use).
 *
 * Source: cross-referenced ISO-639-1 with ethnologue speaker counts
 * and CLDR `locales/*` directories that ship with ICU.
 *
 * Alphabetised by tag for stable diffs.
 */
export const BCP47_LANGUAGE_TAGS: readonly string[] = Object.freeze([
  'af', // Afrikaans
  'am', // Amharic
  'ar', // Arabic
  'az', // Azerbaijani
  'be', // Belarusian
  'bg', // Bulgarian
  'bn', // Bengali
  'bs', // Bosnian
  'ca', // Catalan
  'cs', // Czech
  'da', // Danish
  'de', // German
  'el', // Greek
  'en', // English
  'es', // Spanish
  'et', // Estonian
  'eu', // Basque
  'fa', // Persian (Farsi)
  'fi', // Finnish
  'fil', // Filipino
  'fr', // French
  'ga', // Irish
  'gl', // Galician
  'gu', // Gujarati
  'he', // Hebrew
  'hi', // Hindi
  'hr', // Croatian
  'hu', // Hungarian
  'hy', // Armenian
  'id', // Indonesian
  'is', // Icelandic
  'it', // Italian
  'ja', // Japanese
  'jv', // Javanese
  'ka', // Georgian
  'kk', // Kazakh
  'km', // Khmer
  'kn', // Kannada
  'ko', // Korean
  'lo', // Lao
  'lt', // Lithuanian
  'lv', // Latvian
  'mk', // Macedonian
  'ml', // Malayalam
  'mn', // Mongolian
  'mr', // Marathi
  'ms', // Malay
  'my', // Burmese
  'nb', // Norwegian Bokmål
  'ne', // Nepali
  'nl', // Dutch
  'nn', // Norwegian Nynorsk
  'pa', // Punjabi
  'pl', // Polish
  'pt-BR', // Portuguese (Brazil)
  'pt-PT', // Portuguese (Portugal)
  'ro', // Romanian
  'ru', // Russian
  'si', // Sinhala
  'sk', // Slovak
  'sl', // Slovenian
  'so', // Somali
  'sq', // Albanian
  'sr', // Serbian
  'sv', // Swedish
  'sw', // Swahili
  'ta', // Tamil
  'te', // Telugu
  'th', // Thai
  'tr', // Turkish
  'uk', // Ukrainian
  'ur', // Urdu
  'uz', // Uzbek
  'vi', // Vietnamese
  'zh-Hans', // Chinese (Simplified)
  'zh-Hant', // Chinese (Traditional)
  'zu', // Zulu
]);

/** Lookup map for fast validity checks (e.g. pre-selecting a stored tag). */
export const BCP47_TAG_SET: ReadonlySet<string> = new Set(BCP47_LANGUAGE_TAGS);

/**
 * Localised name lookup with the same fallback chain as
 * `getCountryName`: device-locale → English → raw tag. Cached
 * per-(tag, locale).
 */
const cache = new Map<string, string>();

export function getLanguageName(tag: string, locale?: string): string {
  const cacheKey = `${locale ?? ''}:${tag}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;
  const name = resolveLanguageName(tag, locale);
  cache.set(cacheKey, name);
  return name;
}

/**
 * Static English-name fallback table — covers every tag in
 * {@link BCP47_LANGUAGE_TAGS}. Keep in sync if the tag list changes.
 *
 * Why this exists: Hermes (the JS engine on iOS / Android Expo
 * builds) does NOT ship `Intl.DisplayNames` data — the constructor
 * succeeds but `names.of(tag)` returns the input tag unchanged. Node
 * + most browsers DO ship the data, so the test environment looked
 * fine while production rendered raw codes. Falling through to this
 * table when `Intl.DisplayNames` returns the input keeps the picker
 * readable everywhere.
 */
const EN_LANGUAGE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  af: 'Afrikaans', am: 'Amharic', ar: 'Arabic', az: 'Azerbaijani',
  be: 'Belarusian', bg: 'Bulgarian', bn: 'Bengali', bs: 'Bosnian',
  ca: 'Catalan', cs: 'Czech', da: 'Danish', de: 'German',
  el: 'Greek', en: 'English', es: 'Spanish', et: 'Estonian',
  eu: 'Basque', fa: 'Persian', fi: 'Finnish', fil: 'Filipino',
  fr: 'French', ga: 'Irish', gl: 'Galician', gu: 'Gujarati',
  he: 'Hebrew', hi: 'Hindi', hr: 'Croatian', hu: 'Hungarian',
  hy: 'Armenian', id: 'Indonesian', is: 'Icelandic', it: 'Italian',
  ja: 'Japanese', jv: 'Javanese', ka: 'Georgian', kk: 'Kazakh',
  km: 'Khmer', kn: 'Kannada', ko: 'Korean', lo: 'Lao',
  lt: 'Lithuanian', lv: 'Latvian', mk: 'Macedonian', ml: 'Malayalam',
  mn: 'Mongolian', mr: 'Marathi', ms: 'Malay', my: 'Burmese',
  nb: 'Norwegian Bokmål', ne: 'Nepali', nl: 'Dutch', nn: 'Norwegian Nynorsk',
  pa: 'Punjabi', pl: 'Polish', 'pt-BR': 'Portuguese (Brazil)',
  'pt-PT': 'Portuguese (Portugal)', ro: 'Romanian', ru: 'Russian',
  si: 'Sinhala', sk: 'Slovak', sl: 'Slovenian', so: 'Somali',
  sq: 'Albanian', sr: 'Serbian', sv: 'Swedish', sw: 'Swahili',
  ta: 'Tamil', te: 'Telugu', th: 'Thai', tr: 'Turkish',
  uk: 'Ukrainian', ur: 'Urdu', uz: 'Uzbek', vi: 'Vietnamese',
  'zh-Hans': 'Chinese (Simplified)', 'zh-Hant': 'Chinese (Traditional)',
  zu: 'Zulu',
});

function resolveLanguageName(tag: string, locale: string | undefined): string {
  try {
    const names = new (Intl as any).DisplayNames(locale ? [locale] : undefined, {
      type: 'language',
    });
    const out = names.of(tag);
    if (typeof out === 'string' && out.length > 0 && out !== tag) return out;
  } catch {
    /* fall through */
  }
  if (locale !== 'en') {
    try {
      const names = new (Intl as any).DisplayNames(['en'], { type: 'language' });
      const out = names.of(tag);
      if (typeof out === 'string' && out.length > 0 && out !== tag) return out;
    } catch {
      /* fall through */
    }
  }
  // Static en-name fallback — Hermes path. Better than rendering the
  // raw tag when neither device-locale nor en Intl data is shipped.
  const fallback = EN_LANGUAGE_NAMES[tag];
  if (typeof fallback === 'string') return fallback;
  return tag;
}

/**
 * Build the localised + sorted list for the picker. Mirrors
 * `country_list.buildCountryList()`: build the array, then sort by
 * display name with a locale-aware Collator.
 */
export function buildLanguageList(locale?: string): readonly Language[] {
  const out: Language[] = BCP47_LANGUAGE_TAGS.map((tag) => ({
    tag,
    displayName: getLanguageName(tag, locale),
  }));
  let cmp: (a: string, b: string) => number;
  try {
    const coll = new Intl.Collator(locale);
    cmp = (a, b) => coll.compare(a, b);
  } catch {
    cmp = (a, b) =>
      a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0;
  }
  out.sort((a, b) => cmp(a.displayName, b.displayName));
  return out;
}

/** Test helper — clears the per-locale name cache between tests. */
export function clearLanguageListCacheForTest(): void {
  cache.clear();
}
