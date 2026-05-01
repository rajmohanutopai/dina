/**
 * JSON-LD OpeningHours → schedule parser (TN-V2-META-010).
 *
 * Pure parser: given an HTML string containing schema.org JSON-LD
 * markup with an `openingHoursSpecification` property, return the
 * subject's schedule shape (`{ hours: 7-day map }`) or `null` when
 * no usable signal is present.
 *
 * Falls through to reviewer-declared `schedule` (the META-004 wire
 * field) when the page has no JSON-LD or the markup doesn't include
 * opening hours.
 *
 * **What this parses:**
 *   - `<script type="application/ld+json">{...}</script>` blocks.
 *   - `openingHoursSpecification: { dayOfWeek, opens, closes }` where
 *     `dayOfWeek` is the schema.org day URI (`http://schema.org/Monday`)
 *     OR a simple short-form (`Monday`, `Mon`).
 *   - Multiple specs (one per day) merged into a single 7-day map.
 *
 * **What this does NOT parse:**
 *   - `openingHours` plain-string format (e.g. `"Mo-Fr 09:00-17:00"`)
 *     — that's a separate format, future work.
 *   - Microdata or RDFa — JSON-LD only (the format Google + Bing
 *     recommend; coverage is high enough to satisfy the META-010
 *     "best-effort enrichment" goal).
 *   - `validFrom` / `validThrough` — those would belong on a
 *     `seasonal` mapping but the schema.org shape is too loose to
 *     express our `month[]` cleanly. Reviewer override stays the
 *     authoritative source for seasonal.
 *
 * Pure function. No I/O. Same input always returns the same output.
 * Designed to be fed into the (deferred) HTTP enricher pipeline.
 */

import { extractJsonLdBlocks } from './json_ld_extract'

const DAY_TO_CODE: Record<string, string> = {
  // Schema.org URI form
  'http://schema.org/monday': 'mon',
  'http://schema.org/tuesday': 'tue',
  'http://schema.org/wednesday': 'wed',
  'http://schema.org/thursday': 'thu',
  'http://schema.org/friday': 'fri',
  'http://schema.org/saturday': 'sat',
  'http://schema.org/sunday': 'sun',
  'https://schema.org/monday': 'mon',
  'https://schema.org/tuesday': 'tue',
  'https://schema.org/wednesday': 'wed',
  'https://schema.org/thursday': 'thu',
  'https://schema.org/friday': 'fri',
  'https://schema.org/saturday': 'sat',
  'https://schema.org/sunday': 'sun',
  // Short / long English forms
  monday: 'mon',
  tuesday: 'tue',
  wednesday: 'wed',
  thursday: 'thu',
  friday: 'fri',
  saturday: 'sat',
  sunday: 'sun',
  mon: 'mon',
  tue: 'tue',
  wed: 'wed',
  thu: 'thu',
  fri: 'fri',
  sat: 'sat',
  sun: 'sun',
}

export interface ParsedSchedule {
  hours?: Record<string, { open: string; close: string }>
}

/**
 * Normalise a `dayOfWeek` value to our 3-letter day code, or `null`
 * if unrecognised. Schema.org accepts URI form, English long form,
 * and English short form — we accept all three.
 */
function dayCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  return DAY_TO_CODE[raw.toLowerCase().trim()] ?? null
}

/**
 * Normalise a JSON-LD time string to our `HH:MM` 24-hour shape.
 * Schema.org's `Time` type uses ISO 8601 — we accept:
 *   - `HH:MM` (already canonical)
 *   - `HH:MM:SS` (truncate to minute precision)
 *   - `HH:MM:SS.sss` (truncate)
 *   - `HHMM` (insert separator) — RARE but valid ISO 8601.
 * Returns `null` for anything else (24-hour clock only; we don't
 * accept `9:00 AM` because the META-004 validator would reject it
 * downstream and we want the parser's null-fallthrough to match).
 */
function normaliseTime(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const v = raw.trim()
  // HH:MM (accept directly if shape matches)
  if (/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) return v
  // HH:MM:SS or HH:MM:SS.sss → truncate to minute
  const colonMatch = v.match(/^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?(?:\.\d+)?$/)
  if (colonMatch) return `${colonMatch[1]}:${colonMatch[2]}`
  // HHMM (4-digit compact form)
  const compact = v.match(/^([01]\d|2[0-3])([0-5]\d)$/)
  if (compact) return `${compact[1]}:${compact[2]}`
  return null
}

/**
 * Walk the JSON-LD value (which may be an object, an array of
 * objects, or a `@graph` envelope) and yield every
 * `openingHoursSpecification` object found.
 */
function* iterOpeningHoursSpecs(node: unknown): IterableIterator<Record<string, unknown>> {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) {
    for (const item of node) yield* iterOpeningHoursSpecs(item)
    return
  }
  if (typeof node !== 'object') return
  const obj = node as Record<string, unknown>
  if ('@graph' in obj) yield* iterOpeningHoursSpecs(obj['@graph'])
  if ('openingHoursSpecification' in obj) {
    const spec = obj.openingHoursSpecification
    if (Array.isArray(spec)) {
      for (const s of spec) {
        if (s && typeof s === 'object') yield s as Record<string, unknown>
      }
    } else if (spec && typeof spec === 'object') {
      yield spec as Record<string, unknown>
    }
  }
}

/**
 * Parse JSON-LD markup from an HTML string and extract the schedule
 * object (currently `hours` only). Returns `null` when no usable
 * signal is present:
 *   - HTML is empty / not a string
 *   - No `<script type="application/ld+json">` blocks
 *   - All blocks fail to parse as JSON
 *   - No `openingHoursSpecification` in any block
 *   - `openingHoursSpecification` present but every entry has
 *     unrecognised day codes or unparseable times
 *
 * Conflict policy: if the same day appears in multiple specs, the
 * FIRST valid entry wins. JSON-LD doesn't define a precedence; this
 * matches "more specific markup higher in the document" intuition
 * and the conflict is rare in practice (Google's docs warn against
 * duplicates).
 */
export function parseJsonLdSchedule(html: string | null | undefined): ParsedSchedule | null {
  if (typeof html !== 'string' || html.length === 0) return null
  const blocks = extractJsonLdBlocks(html)
  if (blocks.length === 0) return null

  const hours: Record<string, { open: string; close: string }> = {}
  for (const block of blocks) {
    let parsed: unknown
    try {
      parsed = JSON.parse(block)
    } catch {
      // A malformed JSON-LD block doesn't poison the page —
      // continue to the next. Log-free because this is a pure parser.
      continue
    }
    for (const spec of iterOpeningHoursSpecs(parsed)) {
      const dayRaw = (spec as Record<string, unknown>).dayOfWeek
      const opensRaw = (spec as Record<string, unknown>).opens
      const closesRaw = (spec as Record<string, unknown>).closes
      // dayOfWeek can be a string (one day) OR an array of strings
      // (a range — schema.org allows either shape). Normalise to
      // an iterable of single days.
      const days: string[] = Array.isArray(dayRaw)
        ? dayRaw.filter((d): d is string => typeof d === 'string')
        : typeof dayRaw === 'string'
          ? [dayRaw]
          : []
      const open = normaliseTime(opensRaw)
      const close = normaliseTime(closesRaw)
      if (!open || !close) continue
      for (const d of days) {
        const code = dayCode(d)
        if (!code) continue
        // First valid entry per day wins (see docstring conflict policy).
        if (!(code in hours)) {
          hours[code] = { open, close }
        }
      }
    }
  }

  if (Object.keys(hours).length === 0) return null
  return { hours }
}
