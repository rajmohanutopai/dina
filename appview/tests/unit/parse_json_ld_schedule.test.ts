/**
 * §unit — JSON-LD OpeningHours parser (TN-V2-META-010)
 *
 * Pin the parser's contract at the boundaries the META-010 docstring
 * promises. The HTTP fetch + integration into the enricher pipeline
 * is downstream + deferred; these tests exercise the pure parser.
 */

import { describe, it, expect } from 'vitest'
import { parseJsonLdSchedule } from '@/util/parse_json_ld_schedule'

const wrap = (jsonLd: string): string =>
  `<html><head><script type="application/ld+json">${jsonLd}</script></head><body>x</body></html>`

describe('parseJsonLdSchedule — input shape', () => {
  it('returns null for empty / null / non-string input', () => {
    expect(parseJsonLdSchedule('')).toBeNull()
    expect(parseJsonLdSchedule(null)).toBeNull()
    expect(parseJsonLdSchedule(undefined)).toBeNull()
    expect(parseJsonLdSchedule(123 as unknown as string)).toBeNull()
  })

  it('returns null when HTML has no <script type="application/ld+json"> block', () => {
    expect(parseJsonLdSchedule('<html><body>hi</body></html>')).toBeNull()
  })

  it('returns null when JSON-LD is malformed (graceful fallthrough — page intact)', () => {
    expect(parseJsonLdSchedule(wrap('{ broken json'))).toBeNull()
  })

  it('returns null when JSON-LD block has no openingHoursSpecification', () => {
    const ld = JSON.stringify({ '@type': 'Restaurant', name: 'Cafe' })
    expect(parseJsonLdSchedule(wrap(ld))).toBeNull()
  })
})

describe('parseJsonLdSchedule — single-day spec', () => {
  it('extracts a single weekday with HH:MM times', () => {
    const ld = JSON.stringify({
      '@type': 'Restaurant',
      openingHoursSpecification: {
        '@type': 'OpeningHoursSpecification',
        dayOfWeek: 'http://schema.org/Monday',
        opens: '09:00',
        closes: '17:00',
      },
    })
    expect(parseJsonLdSchedule(wrap(ld))).toEqual({
      hours: { mon: { open: '09:00', close: '17:00' } },
    })
  })

  it('accepts https schema.org URI form', () => {
    const ld = JSON.stringify({
      openingHoursSpecification: {
        dayOfWeek: 'https://schema.org/Tuesday',
        opens: '10:00', closes: '14:00',
      },
    })
    expect(parseJsonLdSchedule(wrap(ld))).toEqual({
      hours: { tue: { open: '10:00', close: '14:00' } },
    })
  })

  it('accepts long-form English day name', () => {
    const ld = JSON.stringify({
      openingHoursSpecification: {
        dayOfWeek: 'Wednesday',
        opens: '11:00', closes: '20:00',
      },
    })
    expect(parseJsonLdSchedule(wrap(ld))).toEqual({
      hours: { wed: { open: '11:00', close: '20:00' } },
    })
  })

  it('accepts short-form English day name (case-insensitive)', () => {
    const ld = JSON.stringify({
      openingHoursSpecification: {
        dayOfWeek: 'FRI',
        opens: '08:00', closes: '12:00',
      },
    })
    expect(parseJsonLdSchedule(wrap(ld))).toEqual({
      hours: { fri: { open: '08:00', close: '12:00' } },
    })
  })

  it('truncates HH:MM:SS to HH:MM', () => {
    const ld = JSON.stringify({
      openingHoursSpecification: {
        dayOfWeek: 'Monday',
        opens: '09:00:00', closes: '17:30:45',
      },
    })
    expect(parseJsonLdSchedule(wrap(ld))).toEqual({
      hours: { mon: { open: '09:00', close: '17:30' } },
    })
  })

  it('accepts compact HHMM form', () => {
    const ld = JSON.stringify({
      openingHoursSpecification: {
        dayOfWeek: 'Saturday',
        opens: '0900', closes: '1730',
      },
    })
    expect(parseJsonLdSchedule(wrap(ld))).toEqual({
      hours: { sat: { open: '09:00', close: '17:30' } },
    })
  })

  it('rejects 12-hour format with AM/PM (META-004 contract is 24-hour only)', () => {
    const ld = JSON.stringify({
      openingHoursSpecification: {
        dayOfWeek: 'Monday',
        opens: '9:00 AM', closes: '5:00 PM',
      },
    })
    expect(parseJsonLdSchedule(wrap(ld))).toBeNull()
  })

  it('rejects unrecognised day code', () => {
    const ld = JSON.stringify({
      openingHoursSpecification: {
        dayOfWeek: 'PublicHoliday',
        opens: '10:00', closes: '14:00',
      },
    })
    expect(parseJsonLdSchedule(wrap(ld))).toBeNull()
  })

  it('rejects out-of-range hour (25:00)', () => {
    const ld = JSON.stringify({
      openingHoursSpecification: {
        dayOfWeek: 'Monday',
        opens: '25:00', closes: '17:00',
      },
    })
    expect(parseJsonLdSchedule(wrap(ld))).toBeNull()
  })
})

describe('parseJsonLdSchedule — multi-day specs', () => {
  it('merges multiple specs into a single 7-day map', () => {
    const ld = JSON.stringify({
      '@type': 'Restaurant',
      openingHoursSpecification: [
        { dayOfWeek: 'Monday', opens: '09:00', closes: '17:00' },
        { dayOfWeek: 'Tuesday', opens: '09:00', closes: '17:00' },
        { dayOfWeek: 'Saturday', opens: '10:00', closes: '14:00' },
      ],
    })
    expect(parseJsonLdSchedule(wrap(ld))).toEqual({
      hours: {
        mon: { open: '09:00', close: '17:00' },
        tue: { open: '09:00', close: '17:00' },
        sat: { open: '10:00', close: '14:00' },
      },
    })
  })

  it('handles dayOfWeek as an array (range form)', () => {
    const ld = JSON.stringify({
      openingHoursSpecification: {
        dayOfWeek: ['Monday', 'Tuesday', 'Wednesday'],
        opens: '08:00', closes: '20:00',
      },
    })
    const r = parseJsonLdSchedule(wrap(ld))
    expect(r).toEqual({
      hours: {
        mon: { open: '08:00', close: '20:00' },
        tue: { open: '08:00', close: '20:00' },
        wed: { open: '08:00', close: '20:00' },
      },
    })
  })

  it('first valid entry wins on duplicate day (deterministic conflict policy)', () => {
    const ld = JSON.stringify({
      openingHoursSpecification: [
        { dayOfWeek: 'Monday', opens: '09:00', closes: '17:00' },
        // Second entry for the same day — the parser keeps the first.
        { dayOfWeek: 'Monday', opens: '07:00', closes: '23:00' },
      ],
    })
    expect(parseJsonLdSchedule(wrap(ld))).toEqual({
      hours: { mon: { open: '09:00', close: '17:00' } },
    })
  })

  it('skips an entry with missing opens/closes but keeps siblings', () => {
    const ld = JSON.stringify({
      openingHoursSpecification: [
        { dayOfWeek: 'Monday', opens: '09:00', closes: '17:00' },
        { dayOfWeek: 'Tuesday' }, // missing opens/closes — drop only this entry
        { dayOfWeek: 'Wednesday', opens: '09:00', closes: '17:00' },
      ],
    })
    expect(parseJsonLdSchedule(wrap(ld))).toEqual({
      hours: {
        mon: { open: '09:00', close: '17:00' },
        wed: { open: '09:00', close: '17:00' },
      },
    })
  })

  it('returns null when all entries have unrecognised days', () => {
    const ld = JSON.stringify({
      openingHoursSpecification: [
        { dayOfWeek: 'Foo', opens: '09:00', closes: '17:00' },
        { dayOfWeek: 'Bar', opens: '09:00', closes: '17:00' },
      ],
    })
    expect(parseJsonLdSchedule(wrap(ld))).toBeNull()
  })
})

describe('parseJsonLdSchedule — JSON-LD envelope shapes', () => {
  it('extracts hours from a `@graph` envelope', () => {
    const ld = JSON.stringify({
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'WebSite', name: 'Foo' },
        {
          '@type': 'Restaurant',
          openingHoursSpecification: {
            dayOfWeek: 'Sunday',
            opens: '11:00', closes: '21:00',
          },
        },
      ],
    })
    expect(parseJsonLdSchedule(wrap(ld))).toEqual({
      hours: { sun: { open: '11:00', close: '21:00' } },
    })
  })

  it('processes multiple JSON-LD blocks in a page (merge across blocks)', () => {
    const ld1 = JSON.stringify({
      openingHoursSpecification: {
        dayOfWeek: 'Monday', opens: '09:00', closes: '17:00',
      },
    })
    const ld2 = JSON.stringify({
      openingHoursSpecification: {
        dayOfWeek: 'Friday', opens: '09:00', closes: '20:00',
      },
    })
    const html = `<script type="application/ld+json">${ld1}</script>
                  <script type="application/ld+json">${ld2}</script>`
    expect(parseJsonLdSchedule(html)).toEqual({
      hours: {
        mon: { open: '09:00', close: '17:00' },
        fri: { open: '09:00', close: '20:00' },
      },
    })
  })

  it('one block invalid + one valid → returns the valid (graceful degrade)', () => {
    const ld2 = JSON.stringify({
      openingHoursSpecification: {
        dayOfWeek: 'Monday', opens: '09:00', closes: '17:00',
      },
    })
    const html = `<script type="application/ld+json">{ broken json</script>
                  <script type="application/ld+json">${ld2}</script>`
    expect(parseJsonLdSchedule(html)).toEqual({
      hours: { mon: { open: '09:00', close: '17:00' } },
    })
  })

  it('case-insensitive script type attribute', () => {
    const ld = JSON.stringify({
      openingHoursSpecification: {
        dayOfWeek: 'Monday', opens: '09:00', closes: '17:00',
      },
    })
    expect(parseJsonLdSchedule(`<script type="APPLICATION/LD+JSON">${ld}</script>`)).toEqual({
      hours: { mon: { open: '09:00', close: '17:00' } },
    })
  })

  it('output is META-004 wire-compatible (passes Zod validator round-trip)', async () => {
    const { validateRecord } = await import('@/ingester/record-validator')
    const ld = JSON.stringify({
      openingHoursSpecification: [
        { dayOfWeek: 'Monday', opens: '09:00', closes: '17:00' },
        { dayOfWeek: 'Saturday', opens: '10:00', closes: '14:00' },
      ],
    })
    const parsed = parseJsonLdSchedule(wrap(ld))!
    // The parser output should round-trip cleanly through the
    // META-004 validator — i.e. the enricher's auto-fill matches the
    // wire contract for reviewer-declared schedules. This is the
    // hard-pin against schema drift between the two paths.
    const r = validateRecord('com.dina.trust.attestation', {
      subject: { type: 'place', name: 'Place' },
      category: 'place',
      sentiment: 'positive',
      schedule: parsed,
      createdAt: new Date().toISOString(),
    })
    expect(r.success).toBe(true)
  })
})
