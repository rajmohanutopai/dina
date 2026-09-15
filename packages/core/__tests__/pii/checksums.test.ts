/**
 * §5.D3 — the Indian identifiers are checksum-honest. A shape match alone
 * over-scrubbed: any twelve digits read as an Aadhaar and any five letters +
 * four digits + letter as a PAN, so a SKU or an invoice reference became
 * "personal data". These pin the issuer's structure: Verhoeff for Aadhaar
 * (UIDAI), the holder-type fourth letter for PAN.
 */

import { isAadhaarNumber, isGstin, isPan, PAN_HOLDER_TYPES, verhoeffValid } from '../../src/pii/checksums';
import { detectPII } from '../../src/pii/patterns';

describe('verhoeffValid', () => {
  it('accepts a number whose last digit is its Verhoeff check digit', () => {
    // Computed with the reference tables over the first eleven digits.
    expect(verhoeffValid('234567890124')).toBe(true);
    expect(verhoeffValid('987654321096')).toBe(true);
    // The canonical Wikipedia example: 236 → check digit 3.
    expect(verhoeffValid('2363')).toBe(true);
  });

  it('rejects a wrong check digit, a transposition, and non-digits', () => {
    expect(verhoeffValid('234567890123')).toBe(false);
    expect(verhoeffValid('324567890124')).toBe(false); // adjacent transposition — the property Verhoeff exists for
    expect(verhoeffValid('23456789012a')).toBe(false);
    expect(verhoeffValid('')).toBe(false);
  });
});

describe('isAadhaarNumber', () => {
  it('needs twelve digits, a 2–9 lead, and a valid check digit', () => {
    expect(isAadhaarNumber('234567890124')).toBe(true);
    expect(isAadhaarNumber('234567890123')).toBe(false); // check digit
    expect(isAadhaarNumber('134567890124')).toBe(false); // reserved lead (even if the check digit fit)
    expect(isAadhaarNumber('23456789012')).toBe(false); // eleven digits
  });
});

describe('isPan', () => {
  it('needs the AAAAA0000A shape with a holder-type fourth letter', () => {
    expect(isPan('ABCPE1234F')).toBe(true); // P — individual
    expect(isPan('ABCCE1234F')).toBe(true); // C — company
    expect(isPan('ABCDE1234F')).toBe(false); // D is not a holder type
    expect(isPan('ABCPE1234')).toBe(false);
    for (const letter of PAN_HOLDER_TYPES) expect(isPan(`XYZ${letter}Q0001Z`)).toBe(true);
  });
});

describe('detectPII honours the checksums (Tier 1)', () => {
  it('a twelve-digit reference with a bad check digit is not an Aadhaar', () => {
    const matches = detectPII('ref 2345 6789 0123 shipped');
    expect(matches.filter((m) => m.type === 'AADHAAR')).toEqual([]);
  });

  it('a valid Aadhaar still scrubs, with either separator', () => {
    for (const sample of ['2345 6789 0124', '2345-6789-0124', '234567890124']) {
      const matches = detectPII(`Aadhaar ${sample}`);
      expect(matches.map((m) => m.type)).toEqual(['AADHAAR']);
    }
  });

  it('a five-letter word plus four digits plus a letter is not a PAN unless the fourth letter is a holder type', () => {
    expect(detectPII('lot ABCDE1234F').filter((m) => m.type === 'PAN')).toEqual([]);
    expect(detectPII('PAN ABCPE1234F').map((m) => m.type)).toEqual(['PAN']);
  });
});

/**
 * GSTIN (§5.D — the paper identity a filing prints). The published example
 * `27AAPFU0939F1ZV` pins the algorithm against an outside source; everything
 * else checks the guards around it.
 */
describe('isGstin', () => {
  it('accepts the GST Network’s published example', () => {
    expect(isGstin('27AAPFU0939F1ZV')).toBe(true);
  });

  it.each(['29AAGCB7383J1Z4', '07AAACB2894G1ZP', '33AAACT2803M1ZI', '19AABCT3518Q1ZT', '09AAACH7409R1ZZ'])(
    'accepts a well-formed, correctly-checksummed GSTIN (%s)',
    (gstin) => {
      expect(isGstin(gstin)).toBe(true);
    },
  );

  it('refuses a wrong check character — a filing under a mistyped number is worse than a refusal', () => {
    expect(isGstin('27AAPFU0939F1ZW')).toBe(false);
    expect(isGstin('27AAPFU0939F1Z0')).toBe(false);
  });

  it('refuses a transposition inside the number, which the checksum exists to catch', () => {
    // The published example with two PAN characters swapped.
    expect(isGstin('27AAPFU9039F1ZV')).toBe(false);
  });

  it.each([
    ['', 'empty'],
    ['27AAPFU0939F1Z', 'fourteen characters'],
    ['27AAPFU0939F1ZVX', 'sixteen characters'],
    ['27aapfu0939f1zv', 'lowercase'],
    ['27AAPFU0939F1YV', 'the fixed Z is not a Z'],
    ['00AAPFU0939F1ZV', 'state code 00'],
    ['39AAPFU0939F1ZV', 'state code past 38'],
    ['27AAPFU0939F0ZV', 'entity number 0'],
    ['27AAXFU0939F1ZV', 'a PAN holder type that does not exist'],
    ['27 AAPFU0939F1ZV', 'a space'],
  ])('refuses %j (%s)', (value) => {
    expect(isGstin(value)).toBe(false);
  });
});
