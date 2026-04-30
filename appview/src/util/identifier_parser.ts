/**
 * External-identifier parser (TN-ENRICH-004).
 *
 * **MIRROR of `packages/protocol/src/trust/identifier_parser.ts`**
 * (TN-PROTO-003). The protocol package is the canonical reference;
 * this file mirrors it byte-for-byte semantically because AppView is
 * not yet in the TS workspace (cross-workspace publish path tracked
 * by the TN-PROTO-001 backlog note as future work — same pattern as
 * `appview/src/shared/types/lexicon-types.ts` mirrors
 * `packages/protocol/src/trust/types.ts`).
 *
 * **Parity contract**: every parser in this file MUST agree with its
 * counterpart in the protocol package on every input. The unit tests
 * pin the documented behaviour against shared real-world fixtures
 * (The C Programming Language ISBN-10, GS1 sample UPC, etc.) so a
 * silent divergence would surface there.
 *
 * Why a separate file rather than `import` from `@dina/protocol`:
 * AppView's `package.json` doesn't list `@dina/protocol` because the
 * appview package isn't a workspace member; adding it requires moving
 * the appview directory under `apps/` or `packages/`, which is a
 * bigger restructure than this iteration warrants. When that lands,
 * delete this file and re-export from `@dina/protocol`.
 *
 * Formats covered:
 *   - DOI            10.<registrant>/<suffix>
 *   - arxiv          new (YYMM.NNNNN) and old (archive/YYMMNNN)
 *   - ISBN-13        13 digits, modulo-10 weighted check, 978/979 prefix
 *   - ISBN-10        10 chars, last optionally 'X', modulo-11 check
 *   - EAN-13         13 digits, modulo-10 weighted check (broader)
 *   - UPC-A          12 digits, modulo-10 weighted check
 *   - ASIN           10 alphanumeric, mixed digits+letters required
 *   - place_id       Google Place ID — opaque, structural check only
 *
 * Each individual parser returns `null` on no-match. The aggregate
 * `parseIdentifier()` runs them in priority order — first match wins.
 *
 * Pure functions. Zero deps.
 */

// ─── Public types ─────────────────────────────────────────────────────────

export type IdentifierType =
  | 'asin'
  | 'isbn13'
  | 'isbn10'
  | 'ean13'
  | 'upc'
  | 'doi'
  | 'arxiv'
  | 'place_id'

export interface ParsedIdentifier {
  type: IdentifierType
  /** Canonical form: digits-only / uppercase / strip prefixes. */
  value: string
  /** Raw input after `.trim()` — preserved for diagnostics. */
  raw: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function stripSeparators(s: string): string {
  // Strip the human-readable separators that show up in pasted
  // identifiers: spaces, hyphens, em/en dashes. Case is preserved
  // because UPC/ASIN/etc are case-sensitive in different ways.
  return s.replace(/[\s\-–—]/g, '')
}

function isDigitsOnly(s: string): boolean {
  return /^[0-9]+$/.test(s)
}

function isAlnumUpper(s: string): boolean {
  return /^[A-Z0-9]+$/.test(s)
}

// ─── Checksum primitives ──────────────────────────────────────────────────

/**
 * EAN-13 / ISBN-13 checksum: Σ(d_i × w_i) mod 10 == 0,
 * weights 1, 3, 1, 3, ..., 1 across positions 0..12.
 */
function ean13Checksum(digits: string): boolean {
  if (digits.length !== 13 || !isDigitsOnly(digits)) return false
  let sum = 0
  for (let i = 0; i < 13; i += 1) {
    const d = digits.charCodeAt(i) - 48
    sum += i % 2 === 0 ? d : d * 3
  }
  return sum % 10 === 0
}

/** UPC-A checksum: 12 digits, weights 3, 1, 3, 1, ..., 3, 1. */
function upcChecksum(digits: string): boolean {
  if (digits.length !== 12 || !isDigitsOnly(digits)) return false
  let sum = 0
  for (let i = 0; i < 12; i += 1) {
    const d = digits.charCodeAt(i) - 48
    sum += i % 2 === 0 ? d * 3 : d
  }
  return sum % 10 === 0
}

/**
 * ISBN-10 checksum: Σ(d_i × (10 - i)) mod 11 == 0, where the last
 * character may be 'X' (= 10). Hyphens/spaces are stripped by caller.
 */
function isbn10Checksum(input: string): boolean {
  if (input.length !== 10) return false
  let sum = 0
  for (let i = 0; i < 10; i += 1) {
    const ch = input.charAt(i)
    let d: number
    if (i === 9 && (ch === 'X' || ch === 'x')) {
      d = 10
    } else if (ch >= '0' && ch <= '9') {
      d = ch.charCodeAt(0) - 48
    } else {
      return false
    }
    sum += d * (10 - i)
  }
  return sum % 11 === 0
}

// ─── Individual parsers ───────────────────────────────────────────────────

/**
 * Parse a DOI. Accepts bare `10.x/y`, `doi:10.x/y`, and
 * `https?://(dx.)?doi.org/10.x/y` forms. Canonical value drops the
 * URL/`doi:` prefix and lower-cases the registrant prefix.
 */
export function parseDoi(input: string): ParsedIdentifier | null {
  const raw = input.trim()
  let body = raw
  body = body.replace(/^doi:\s*/i, '')
  body = body.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
  const m = body.match(/^10\.\d{4,9}\/\S+$/)
  if (!m) return null
  return { type: 'doi', value: body.toLowerCase(), raw }
}

/**
 * Parse an arxiv identifier. Recognises both modern (`YYMM.NNNNN`,
 * optional `vN`) and pre-2007 (`archive/YYMMNNN`) forms.
 */
export function parseArxiv(input: string): ParsedIdentifier | null {
  const raw = input.trim()
  const body = raw.replace(/^arxiv:\s*/i, '')
  if (/^\d{4}\.\d{4,5}(?:v\d+)?$/.test(body)) {
    return { type: 'arxiv', value: body.toLowerCase(), raw }
  }
  if (/^[a-z][a-z\-]*(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?$/.test(body)) {
    return { type: 'arxiv', value: body, raw }
  }
  return null
}

/**
 * Parse an ISBN-13. Hyphens/spaces stripped; canonical 13-digit form.
 * Rejects valid 13-digit barcodes that aren't 978/979 ISBN registrant.
 */
export function parseIsbn13(input: string): ParsedIdentifier | null {
  const raw = input.trim()
  let body = raw.replace(/^isbn(?:-13)?:?\s*/i, '')
  body = stripSeparators(body)
  if (body.length !== 13 || !isDigitsOnly(body)) return null
  if (!body.startsWith('978') && !body.startsWith('979')) return null
  if (!ean13Checksum(body)) return null
  return { type: 'isbn13', value: body, raw }
}

/**
 * Parse an ISBN-10. Hyphens/spaces stripped; canonical 10-character
 * form with the optional final `X` upper-cased.
 */
export function parseIsbn10(input: string): ParsedIdentifier | null {
  const raw = input.trim()
  let body = raw.replace(/^isbn(?:-10)?:?\s*/i, '')
  body = stripSeparators(body).toUpperCase()
  if (body.length !== 10) return null
  if (!isbn10Checksum(body)) return null
  return { type: 'isbn10', value: body, raw }
}

/**
 * Parse an EAN-13. Same checksum as ISBN-13; covers the broader
 * product-barcode space (everything that isn't 978/979 ISBN).
 */
export function parseEan13(input: string): ParsedIdentifier | null {
  const raw = input.trim()
  const body = stripSeparators(raw)
  if (body.length !== 13 || !isDigitsOnly(body)) return null
  if (!ean13Checksum(body)) return null
  return { type: 'ean13', value: body, raw }
}

/** Parse a UPC-A barcode. 12 digits + checksum. */
export function parseUpc(input: string): ParsedIdentifier | null {
  const raw = input.trim()
  const body = stripSeparators(raw)
  if (body.length !== 12 || !isDigitsOnly(body)) return null
  if (!upcChecksum(body)) return null
  return { type: 'upc', value: body, raw }
}

/**
 * Parse an Amazon ASIN. 10 upper-case alphanumeric characters with
 * at least one digit AND at least one letter. The mixed-alphanum
 * requirement filters two false-positive classes:
 *   - pure-digit input (would clash with ISBN-10)
 *   - pure-letter 10-character words
 */
export function parseAsin(input: string): ParsedIdentifier | null {
  const raw = input.trim()
  const body = stripSeparators(raw).toUpperCase()
  if (body.length !== 10) return null
  if (!isAlnumUpper(body)) return null
  const hasDigit = /[0-9]/.test(body)
  const hasLetter = /[A-Z]/.test(body)
  if (!hasDigit || !hasLetter) return null
  return { type: 'asin', value: body, raw }
}

/**
 * Parse a Google Place ID. Opaque server-issued tokens; structural
 * validation only. Modern IDs start with `ChIJ` or `Eo` and are at
 * least 20 chars of URL-safe base64.
 */
export function parsePlaceId(input: string): ParsedIdentifier | null {
  const raw = input.trim()
  if (raw.length < 20) return null
  if (!/^(?:ChIJ|Eo)[A-Za-z0-9_\-]{16,}$/.test(raw)) return null
  return { type: 'place_id', value: raw, raw }
}

// ─── Aggregate ────────────────────────────────────────────────────────────

/**
 * Detect the identifier type of a free-form input string.
 *
 * Tries each parser in priority order:
 *   1. DOI       — distinctive `10.x/y` prefix
 *   2. arxiv     — distinctive YYMM.NNNNN / archive/NNN forms
 *   3. ISBN-13   — 13 digits, 978/979 prefix, valid checksum
 *   4. EAN-13    — any other valid 13-digit barcode
 *   5. UPC-A     — 12 digits, valid checksum
 *   6. ISBN-10   — 10 digits/X, valid checksum
 *   7. ASIN      — 10 alphanumeric (mixed required)
 *   8. place_id  — ChIJ.../Eo... structural fallback
 *
 * Returns `null` if no parser matches.
 */
export function parseIdentifier(input: string): ParsedIdentifier | null {
  if (typeof input !== 'string' || input.trim().length === 0) return null
  return (
    parseDoi(input) ??
    parseArxiv(input) ??
    parseIsbn13(input) ??
    parseEan13(input) ??
    parseUpc(input) ??
    parseIsbn10(input) ??
    parseAsin(input) ??
    parsePlaceId(input) ??
    null
  )
}
