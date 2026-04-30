/**
 * Identifier parser tests (TN-ENRICH-004).
 *
 * Pins the parser behaviour against documented real-world fixtures
 * (so a divergence from the protocol-package mirror would surface
 * here):
 *
 *   - DOI: `10.1126/science.169.3946.635` (real Science paper)
 *   - ISBN-10: `0131103628` (The C Programming Language, 2nd ed.)
 *   - ISBN-13: `9780131103627` (same book, 13-digit form)
 *   - UPC: `036000291452` (GS1 sample)
 *   - arxiv (modern): `2103.00020` (CLIP paper)
 *   - arxiv (pre-2007): `cond-mat/9612001`
 *
 * Plus rules around URL/scheme prefixes, hyphen/space stripping,
 * checksum validation, ASIN false-positive filtering, place_id
 * structural validation, and the priority order in
 * `parseIdentifier()`.
 *
 * Pure functions — runs under vitest.
 */

import { describe, it, expect } from 'vitest'
import {
  parseAsin,
  parseArxiv,
  parseDoi,
  parseEan13,
  parseIdentifier,
  parseIsbn10,
  parseIsbn13,
  parsePlaceId,
  parseUpc,
} from '@/util/identifier_parser'

// ─── DOI ──────────────────────────────────────────────────────────────────

describe('parseDoi', () => {
  it('matches a bare 10.x/y form', () => {
    expect(parseDoi('10.1126/science.169.3946.635')).toEqual({
      type: 'doi',
      value: '10.1126/science.169.3946.635',
      raw: '10.1126/science.169.3946.635',
    })
  })

  it('strips `doi:` prefix', () => {
    const r = parseDoi('doi:10.1126/science.169.3946.635')
    expect(r?.type).toBe('doi')
    expect(r?.value).toBe('10.1126/science.169.3946.635')
  })

  it('strips https://doi.org/ URL', () => {
    expect(parseDoi('https://doi.org/10.1126/science.169.3946.635')?.value).toBe(
      '10.1126/science.169.3946.635',
    )
  })

  it('strips https://dx.doi.org/ URL', () => {
    expect(parseDoi('https://dx.doi.org/10.1126/science.169.3946.635')?.value).toBe(
      '10.1126/science.169.3946.635',
    )
  })

  it('lowercases the canonical value', () => {
    expect(parseDoi('10.1126/SCIENCE.169.3946.635')?.value).toBe(
      '10.1126/science.169.3946.635',
    )
  })

  it('rejects a non-DOI string', () => {
    expect(parseDoi('not a doi')).toBeNull()
    expect(parseDoi('10.123/short-registrant')).toBeNull() // <4 digits
    expect(parseDoi('10.12345')).toBeNull() // missing suffix
  })

  it('rejects empty input', () => {
    expect(parseDoi('')).toBeNull()
    expect(parseDoi('   ')).toBeNull()
  })
})

// ─── arxiv ────────────────────────────────────────────────────────────────

describe('parseArxiv', () => {
  it('matches the modern YYMM.NNNNN form (CLIP paper)', () => {
    expect(parseArxiv('2103.00020')).toEqual({
      type: 'arxiv',
      value: '2103.00020',
      raw: '2103.00020',
    })
  })

  it('matches modern with version suffix', () => {
    expect(parseArxiv('2103.00020v2')?.value).toBe('2103.00020v2')
  })

  it('strips `arxiv:` prefix', () => {
    const r = parseArxiv('arXiv:2103.00020')
    expect(r?.type).toBe('arxiv')
    expect(r?.value).toBe('2103.00020')
  })

  it('matches the pre-2007 archive/YYMMNNN form', () => {
    expect(parseArxiv('cond-mat/9612001')).toEqual({
      type: 'arxiv',
      value: 'cond-mat/9612001',
      raw: 'cond-mat/9612001',
    })
  })

  it('matches pre-2007 with subject suffix (e.g. math.AP/0123456)', () => {
    expect(parseArxiv('math.AP/0123456')?.value).toBe('math.AP/0123456')
  })

  it('rejects non-arxiv strings', () => {
    expect(parseArxiv('not arxiv')).toBeNull()
    expect(parseArxiv('123.456')).toBeNull() // wrong YYMM length
  })
})

// ─── ISBN-13 ──────────────────────────────────────────────────────────────

describe('parseIsbn13', () => {
  it('matches "The C Programming Language" 13-digit form', () => {
    expect(parseIsbn13('9780131103627')).toEqual({
      type: 'isbn13',
      value: '9780131103627',
      raw: '9780131103627',
    })
  })

  it('strips hyphens', () => {
    expect(parseIsbn13('978-0-13-110362-7')?.value).toBe('9780131103627')
  })

  it('strips `ISBN:` / `ISBN-13:` prefix', () => {
    expect(parseIsbn13('ISBN-13: 978-0-13-110362-7')?.value).toBe('9780131103627')
    expect(parseIsbn13('ISBN: 978-0-13-110362-7')?.value).toBe('9780131103627')
  })

  it('rejects non-978/979 prefixes (would be EAN-13, not ISBN-13)', () => {
    // Construct a 13-digit number with valid EAN checksum but not 978/979.
    expect(parseIsbn13('5901234123457')).toBeNull()
  })

  it('rejects bad checksum', () => {
    expect(parseIsbn13('9780131103620')).toBeNull() // last digit wrong
  })

  it('rejects wrong length', () => {
    expect(parseIsbn13('978013110362')).toBeNull() // 12
    expect(parseIsbn13('97801311036270')).toBeNull() // 14
  })
})

// ─── ISBN-10 ──────────────────────────────────────────────────────────────

describe('parseIsbn10', () => {
  it('matches "The C Programming Language" 10-digit form', () => {
    expect(parseIsbn10('0131103628')).toEqual({
      type: 'isbn10',
      value: '0131103628',
      raw: '0131103628',
    })
  })

  it('handles the X check digit (case-normalised to upper)', () => {
    // Real ISBN-10 with X check: "Harry Potter and the Order of the
    // Phoenix" UK 1st ed = 043935806X. Manual checksum:
    //   0×10 + 4×9 + 3×8 + 9×7 + 3×6 + 5×5 + 8×4 + 0×3 + 6×2 + 10×1 = 220
    //   220 mod 11 = 0 ✓
    expect(parseIsbn10('043935806X')?.value).toBe('043935806X')
    expect(parseIsbn10('043935806x')?.value).toBe('043935806X')
  })

  it('strips hyphens', () => {
    expect(parseIsbn10('0-13-110362-8')?.value).toBe('0131103628')
  })

  it('rejects bad checksum', () => {
    expect(parseIsbn10('0131103620')).toBeNull()
  })

  it('rejects wrong length', () => {
    expect(parseIsbn10('013110362')).toBeNull() // 9
    expect(parseIsbn10('01311036280')).toBeNull() // 11
  })

  it('rejects non-digit / non-X chars', () => {
    expect(parseIsbn10('013110362A')).toBeNull()
  })
})

// ─── EAN-13 ──────────────────────────────────────────────────────────────

describe('parseEan13', () => {
  it('accepts a valid 13-digit barcode', () => {
    // Standard GS1 sample: 5901234123457 has a valid EAN checksum.
    expect(parseEan13('5901234123457')).toEqual({
      type: 'ean13',
      value: '5901234123457',
      raw: '5901234123457',
    })
  })

  it('strips hyphens/spaces', () => {
    expect(parseEan13('5 901234 123457')?.value).toBe('5901234123457')
  })

  it('also accepts 978/979 ISBN-13 (caller picks via priority order)', () => {
    // EAN-13 is structurally a superset; parseEan13 itself doesn't
    // reject 978/979.
    expect(parseEan13('9780131103627')?.type).toBe('ean13')
  })

  it('rejects bad checksum', () => {
    expect(parseEan13('5901234123450')).toBeNull()
  })
})

// ─── UPC-A ────────────────────────────────────────────────────────────────

describe('parseUpc', () => {
  it('matches the GS1 sample UPC', () => {
    expect(parseUpc('036000291452')).toEqual({
      type: 'upc',
      value: '036000291452',
      raw: '036000291452',
    })
  })

  it('strips spaces / hyphens', () => {
    expect(parseUpc('0 36000 29145 2')?.value).toBe('036000291452')
  })

  it('rejects bad checksum', () => {
    expect(parseUpc('036000291450')).toBeNull()
  })

  it('rejects wrong length', () => {
    expect(parseUpc('03600029145')).toBeNull() // 11
    expect(parseUpc('0360002914520')).toBeNull() // 13
  })
})

// ─── ASIN ─────────────────────────────────────────────────────────────────

describe('parseAsin', () => {
  it('matches a typical ASIN', () => {
    expect(parseAsin('B07XYZ1234')).toEqual({
      type: 'asin',
      value: 'B07XYZ1234',
      raw: 'B07XYZ1234',
    })
  })

  it('uppercases', () => {
    expect(parseAsin('b07xyz1234')?.value).toBe('B07XYZ1234')
  })

  it('rejects pure-digit input (would clash with ISBN-10)', () => {
    expect(parseAsin('0131103628')).toBeNull()
  })

  it('rejects pure-letter 10-char words', () => {
    expect(parseAsin('basketball')).toBeNull()
    expect(parseAsin('typewriter')).toBeNull()
  })

  it('rejects wrong length', () => {
    expect(parseAsin('B07XYZ123')).toBeNull() // 9
    expect(parseAsin('B07XYZ12345')).toBeNull() // 11
  })

  it('rejects non-alphanumeric', () => {
    expect(parseAsin('B07-XYZ123')).toBeNull() // hyphen stripped → 9
  })
})

// ─── place_id ─────────────────────────────────────────────────────────────

describe('parsePlaceId', () => {
  it('matches a ChIJ-prefixed Place ID', () => {
    const id = 'ChIJ2eUgeAK6j4ARbn5u_wAGqWA'
    expect(parsePlaceId(id)).toEqual({
      type: 'place_id',
      value: id,
      raw: id,
    })
  })

  it('matches an Eo-prefixed Place ID', () => {
    const id = 'EoasdfASDF1234567890_-'
    expect(parsePlaceId(id)?.type).toBe('place_id')
  })

  it('rejects too-short input (<20 chars)', () => {
    expect(parsePlaceId('ChIJ-short')).toBeNull()
  })

  it('rejects unknown prefix', () => {
    expect(parsePlaceId('XyZQ123456789012345678')).toBeNull()
  })

  it('rejects whitespace-poisoned input', () => {
    expect(parsePlaceId('ChIJ has spaces inside the id')).toBeNull()
  })
})

// ─── parseIdentifier — priority + null cases ─────────────────────────────

describe('parseIdentifier — priority + null cases', () => {
  it('returns null for empty / non-string input', () => {
    expect(parseIdentifier('')).toBeNull()
    expect(parseIdentifier('   ')).toBeNull()
    // @ts-expect-error — runtime guard
    expect(parseIdentifier(null)).toBeNull()
    // @ts-expect-error — runtime guard
    expect(parseIdentifier(undefined)).toBeNull()
  })

  it('DOI takes priority over everything else', () => {
    expect(parseIdentifier('10.1126/science.169.3946.635')?.type).toBe('doi')
  })

  it('arxiv takes priority over numeric-only formats', () => {
    expect(parseIdentifier('2103.00020')?.type).toBe('arxiv')
  })

  it('ISBN-13 (978/979 prefix) wins over EAN-13', () => {
    expect(parseIdentifier('9780131103627')?.type).toBe('isbn13')
  })

  it('non-978/979 13-digit goes to EAN-13', () => {
    expect(parseIdentifier('5901234123457')?.type).toBe('ean13')
  })

  it('UPC matches a valid 12-digit barcode', () => {
    expect(parseIdentifier('036000291452')?.type).toBe('upc')
  })

  it('ISBN-10 takes priority over ASIN for pure-digit 10-char input', () => {
    expect(parseIdentifier('0131103628')?.type).toBe('isbn10')
  })

  it('ASIN matches when ISBN-10 wouldn\'t', () => {
    expect(parseIdentifier('B07XYZ1234')?.type).toBe('asin')
  })

  it('place_id is the structural fallback', () => {
    expect(parseIdentifier('ChIJ2eUgeAK6j4ARbn5u_wAGqWA')?.type).toBe('place_id')
  })

  it('returns null when nothing matches', () => {
    expect(parseIdentifier('hello world')).toBeNull()
    expect(parseIdentifier('1234')).toBeNull()
  })
})
