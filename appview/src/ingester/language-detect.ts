import { franc } from 'franc-min'

/**
 * Language detection (TN-ING-008 / Plan §3.6).
 *
 * Wraps `franc-min` to detect the language of free-text attestation
 * content. The ingester populates `attestations.language` (TN-DB-008)
 * via this function on every attestation insert; the search xRPC's
 * `language=` filter reads back from there.
 *
 * **Returns**: a BCP-47 language tag (`'en'`, `'pt'`, `'zh'`, …) for
 * detected languages, or `null` when:
 *   - no input text (empty / whitespace-only)
 *   - input below `franc`'s minimum-detection threshold (10 chars by
 *     default — short text is too noisy to classify reliably)
 *   - franc returns its `'und'` (undetermined) sentinel
 *
 * **BCP-47 conversion**: franc-min returns ISO 639-3 (3-letter) codes.
 * BCP-47 prefers ISO 639-1 (2-letter) where available — a curated map
 * below covers the top languages by content volume on the web. For
 * languages without a 2-letter equivalent, the 3-letter code is also
 * a valid BCP-47 tag (per RFC 5646 §2.2.1), so we keep it as-is.
 *
 * **Why a hand-coded map** rather than the `iso-639-3` npm package:
 * the package is ~60KB and brings in JSON data for ~7,800 languages.
 * franc-min only knows about ~80 of those. A 30-entry map covers the
 * meaningful subset and ships zero new transitive deps.
 *
 * **Pure function**: same input always returns the same output. No
 * I/O. Safe to call from any thread.
 */

/**
 * ISO 639-3 → ISO 639-1 (2-letter BCP-47 primary subtag) for the
 * languages most likely to appear in trust-attestation content.
 * Anything not in this map falls through with the 3-letter code.
 */
const ISO6393_TO_BCP47: ReadonlyMap<string, string> = new Map([
  ['eng', 'en'],
  ['cmn', 'zh'],
  ['hin', 'hi'],
  ['spa', 'es'],
  ['fra', 'fr'],
  ['arb', 'ar'],
  ['ben', 'bn'],
  ['rus', 'ru'],
  ['por', 'pt'],
  ['ind', 'id'],
  ['urd', 'ur'],
  ['deu', 'de'],
  ['jpn', 'ja'],
  ['swh', 'sw'],
  ['mar', 'mr'],
  ['tel', 'te'],
  ['tur', 'tr'],
  ['tam', 'ta'],
  ['vie', 'vi'],
  ['kor', 'ko'],
  ['ita', 'it'],
  ['pol', 'pl'],
  ['ukr', 'uk'],
  ['nld', 'nl'],
  ['ron', 'ro'],
  ['ell', 'el'],
  ['ces', 'cs'],
  ['hun', 'hu'],
  ['swe', 'sv'],
  ['heb', 'he'],
  ['tha', 'th'],
])

/**
 * Detect the language of the input text. Returns a BCP-47 tag or `null`.
 *
 * The text is conventionally the most signal-rich field available:
 * the caller passes the attestation's `record.text` first, falling
 * back to `record.subject.name` when text is absent.
 */
export function detectLanguage(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (trimmed.length === 0) return null

  // franc returns 'und' for input it can't classify (typically too
  // short — default threshold is 10 chars). We surface that as null.
  const code = franc(trimmed)
  if (code === 'und') return null

  return ISO6393_TO_BCP47.get(code) ?? code
}
