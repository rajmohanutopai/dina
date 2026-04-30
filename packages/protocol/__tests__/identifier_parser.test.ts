/**
 * Identifier parser — checksum + structural tests (TN-PROTO-003).
 *
 * The fixtures below are real, public identifiers (or
 * cryptographically-correct synthesised ones for fakes) so we're
 * actually verifying the checksum math, not just the shape.
 */

import {
  parseIdentifier,
  parseAsin,
  parseDoi,
  parseArxiv,
  parseIsbn13,
  parseIsbn10,
  parseEan13,
  parseUpc,
  parsePlaceId,
} from '../src/index';

describe('identifier parser (TN-PROTO-003)', () => {
  describe('parseDoi', () => {
    it('accepts bare DOI form', () => {
      const r = parseDoi('10.1038/nature12373');
      expect(r?.type).toBe('doi');
      expect(r?.value).toBe('10.1038/nature12373');
    });

    it('accepts doi: prefix and lower-cases the canonical form', () => {
      const r = parseDoi('doi:10.1109/MC.2024.123');
      expect(r?.type).toBe('doi');
      expect(r?.value).toBe('10.1109/mc.2024.123');
      expect(r?.raw).toBe('doi:10.1109/MC.2024.123');
    });

    it('accepts https://doi.org/ URL form', () => {
      const r = parseDoi('https://doi.org/10.5555/12345678');
      expect(r?.value).toBe('10.5555/12345678');
    });

    it('accepts dx.doi.org subdomain form', () => {
      const r = parseDoi('https://dx.doi.org/10.1000/xyz123');
      expect(r?.value).toBe('10.1000/xyz123');
    });

    it('rejects without 10. prefix', () => {
      expect(parseDoi('11.1234/foo')).toBeNull();
    });

    it('rejects without registrant code', () => {
      expect(parseDoi('10./foo')).toBeNull();
    });

    it('rejects without suffix', () => {
      expect(parseDoi('10.1234/')).toBeNull();
    });
  });

  describe('parseArxiv', () => {
    it('accepts modern YYMM.NNNNN form', () => {
      const r = parseArxiv('2501.12345');
      expect(r?.type).toBe('arxiv');
      expect(r?.value).toBe('2501.12345');
    });

    it('accepts modern 4-digit form', () => {
      // Pre-Jan-2015 numbering allowed 4-digit suffixes.
      const r = parseArxiv('1412.6980');
      expect(r?.value).toBe('1412.6980');
    });

    it('accepts version suffix', () => {
      const r = parseArxiv('2501.12345v3');
      expect(r?.value).toBe('2501.12345v3');
    });

    it('accepts arXiv: prefix and lower-cases version', () => {
      const r = parseArxiv('arXiv:2501.12345');
      expect(r?.value).toBe('2501.12345');
    });

    it('accepts pre-2007 archive/YYMMNNN form', () => {
      const r = parseArxiv('cs/0301001');
      expect(r?.value).toBe('cs/0301001');
    });

    it('accepts pre-2007 with subject prefix', () => {
      const r = parseArxiv('cond-mat/9612001');
      expect(r?.value).toBe('cond-mat/9612001');
    });

    it('rejects bare digits without dot', () => {
      expect(parseArxiv('250112345')).toBeNull();
    });

    it('rejects 3-digit suffix (too short)', () => {
      expect(parseArxiv('2501.123')).toBeNull();
    });
  });

  describe('parseIsbn13', () => {
    it('accepts a known-valid 13-digit ISBN', () => {
      // The Phoenix Project — ISBN 978-0-9886-1095-2
      const r = parseIsbn13('9780988610958');
      expect(r?.type).toBe('isbn13');
      expect(r?.value).toBe('9780988610958');
    });

    it('accepts hyphenated form', () => {
      const r = parseIsbn13('978-0-9886-1095-8');
      expect(r?.value).toBe('9780988610958');
    });

    it('accepts ISBN: prefix', () => {
      const r = parseIsbn13('ISBN-13: 978-0-9886-1095-8');
      expect(r?.value).toBe('9780988610958');
    });

    it('rejects 13-digit number with bad checksum', () => {
      expect(parseIsbn13('9780988610959')).toBeNull();
    });

    it('rejects 13-digit number not starting with 978/979', () => {
      // Valid EAN checksum but not an ISBN registrant prefix.
      expect(parseIsbn13('5901234123457')).toBeNull();
    });

    it('rejects non-13 length', () => {
      expect(parseIsbn13('978098861095')).toBeNull();
    });
  });

  describe('parseIsbn10', () => {
    it('accepts a digits-only ISBN-10 with valid checksum', () => {
      // The C Programming Language — ISBN 0-13-110362-8
      const r = parseIsbn10('0131103628');
      expect(r?.type).toBe('isbn10');
      expect(r?.value).toBe('0131103628');
    });

    it('accepts hyphenated form', () => {
      const r = parseIsbn10('0-13-110362-8');
      expect(r?.value).toBe('0131103628');
    });

    it('accepts trailing X check character', () => {
      // The Art of Computer Programming Vol 1 — 0-201-89683-4 has
      // many siblings; pick one with X check digit.
      // ISBN 0-8044-2957-X — Faraday's Loops & Knots
      const r = parseIsbn10('080442957X');
      expect(r?.type).toBe('isbn10');
      expect(r?.value).toBe('080442957X');
    });

    it('upper-cases lowercase x', () => {
      const r = parseIsbn10('080442957x');
      expect(r?.value).toBe('080442957X');
    });

    it('rejects bad checksum', () => {
      expect(parseIsbn10('0131103627')).toBeNull();
    });

    it('rejects X not in the last position', () => {
      expect(parseIsbn10('X131103628')).toBeNull();
    });
  });

  describe('parseEan13', () => {
    it('accepts a non-ISBN EAN-13 with valid checksum', () => {
      // Standard EAN-13 fixture: 5-9012-3412-345-7
      const r = parseEan13('5901234123457');
      expect(r?.type).toBe('ean13');
      expect(r?.value).toBe('5901234123457');
    });

    it('accepts hyphenated form', () => {
      const r = parseEan13('5-9012-3412-345-7');
      expect(r?.value).toBe('5901234123457');
    });

    it('rejects bad checksum', () => {
      expect(parseEan13('5901234123458')).toBeNull();
    });
  });

  describe('parseUpc', () => {
    it('accepts known-valid 12-digit UPC-A', () => {
      // Test fixture from the GS1 documentation.
      const r = parseUpc('036000291452');
      expect(r?.type).toBe('upc');
      expect(r?.value).toBe('036000291452');
    });

    it('accepts hyphenated UPC', () => {
      const r = parseUpc('0-36000-29145-2');
      expect(r?.value).toBe('036000291452');
    });

    it('rejects bad checksum', () => {
      expect(parseUpc('036000291453')).toBeNull();
    });

    it('rejects non-12 length', () => {
      expect(parseUpc('03600029145')).toBeNull();
    });
  });

  describe('parseAsin', () => {
    it('accepts a typical ASIN starting with B0', () => {
      const r = parseAsin('B07XJ8C8F5');
      expect(r?.type).toBe('asin');
      expect(r?.value).toBe('B07XJ8C8F5');
    });

    it('upper-cases lowercase input', () => {
      const r = parseAsin('b07xj8c8f5');
      expect(r?.value).toBe('B07XJ8C8F5');
    });

    it('rejects pure-numeric 10-digit input (clashes with ISBN-10)', () => {
      expect(parseAsin('0131103628')).toBeNull();
    });

    it('rejects non-10 length', () => {
      expect(parseAsin('B07XJ8C8F')).toBeNull();
    });

    it('rejects non-alphanumeric', () => {
      expect(parseAsin('B07-J8C8F5')).toBeNull();
    });
  });

  describe('parsePlaceId', () => {
    it('accepts ChIJ-style modern Place ID', () => {
      const r = parsePlaceId('ChIJOwg_06VPwokRYv534QaPC8g');
      expect(r?.type).toBe('place_id');
      expect(r?.value).toBe('ChIJOwg_06VPwokRYv534QaPC8g');
    });

    it('accepts Eo-style legacy Place ID', () => {
      const r = parsePlaceId('Eo38Y29uZmlnLmpzb24KCg__abcdef');
      expect(r?.type).toBe('place_id');
    });

    it('rejects too-short input', () => {
      expect(parsePlaceId('ChIJ12345')).toBeNull();
    });

    it('rejects unknown prefix', () => {
      expect(parsePlaceId('XYZABCDEFGHIJKLMNOPQRSTUVW')).toBeNull();
    });
  });

  describe('parseIdentifier (aggregate)', () => {
    it('detects DOI', () => {
      expect(parseIdentifier('10.1038/nature12373')?.type).toBe('doi');
    });

    it('detects arxiv', () => {
      expect(parseIdentifier('2501.12345')?.type).toBe('arxiv');
    });

    it('detects ISBN-13 ahead of generic EAN-13', () => {
      // 978... is a valid ISBN-13 → should NOT be reported as ean13.
      expect(parseIdentifier('9780988610958')?.type).toBe('isbn13');
    });

    it('falls through to EAN-13 for non-ISBN 13-digit input', () => {
      expect(parseIdentifier('5901234123457')?.type).toBe('ean13');
    });

    it('detects UPC-A', () => {
      expect(parseIdentifier('036000291452')?.type).toBe('upc');
    });

    it('detects ISBN-10 ahead of ASIN for digit-only 10-char input', () => {
      // Pure-digit 10 chars with a valid ISBN-10 checksum → ISBN-10.
      // ASIN parser rejects pure-digit input on purpose to keep
      // this disambiguation clean.
      expect(parseIdentifier('0131103628')?.type).toBe('isbn10');
    });

    it('detects ASIN for 10-char alphanumeric (non-ISBN) input', () => {
      expect(parseIdentifier('B07XJ8C8F5')?.type).toBe('asin');
    });

    it('detects place_id as the structural fallback', () => {
      const r = parseIdentifier('ChIJOwg_06VPwokRYv534QaPC8g');
      expect(r?.type).toBe('place_id');
    });

    it('returns null on empty / whitespace input', () => {
      expect(parseIdentifier('')).toBeNull();
      expect(parseIdentifier('   ')).toBeNull();
    });

    it('returns null on garbage input', () => {
      expect(parseIdentifier('hello world')).toBeNull();
    });

    it('returns null on non-string input', () => {
      // Defensive — JS callers may pass undefined.
      expect(parseIdentifier(undefined as unknown as string)).toBeNull();
    });

    it('preserves raw input in the parsed result', () => {
      const r = parseIdentifier('  978-0-9886-1095-8  ');
      expect(r?.value).toBe('9780988610958');
      expect(r?.raw).toBe('978-0-9886-1095-8'); // trimmed
    });
  });
});
