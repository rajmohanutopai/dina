/**
 * The paper identity of a party (§5.D): what a filing prints, validated where
 * the owner types it. One definition for both ends of a trade — the node's own
 * business (settings) and a counterparty (their contact row).
 *
 * The discipline under test is "refused, not clamped": a registration that
 * fails its scheme's own check is rejected with a reason, never stored as
 * given, because a filing made under a mistyped number is worse than one the
 * owner had to correct.
 */

import {
  isValidRegistration,
  MAX_TAX_REGISTRATIONS,
  normaliseLegalName,
  normalisePostalAddress,
  normaliseTaxRegistrations,
  registrationFor,
  TAX_REGISTRATION_SCHEMES,
  validatePostalAddress,
  validateTaxRegistrations,
  type TaxRegistration,
} from '../../src/commerce/trade_identity';

const GSTIN = '27AAPFU0939F1ZV';
const OTHER_GSTIN = '29AAGCB7383J1Z4';

describe('registrations are normalised before they are judged', () => {
  it('trims, upper-cases the value, lower-cases the scheme, and keeps first-seen order', () => {
    expect(
      normaliseTaxRegistrations([
        { scheme: ' GSTIN ', value: ` ${GSTIN.toLowerCase()} ` } as unknown as TaxRegistration,
        { scheme: 'pan', value: 'aapfu0939f' } as unknown as TaxRegistration,
      ]),
    ).toEqual([
      { scheme: 'gstin', value: GSTIN },
      { scheme: 'pan', value: 'AAPFU0939F' },
    ]);
  });

  it('drops entries with no scheme or no value, and anything that is not an object', () => {
    expect(
      normaliseTaxRegistrations([
        { scheme: '', value: GSTIN },
        { scheme: 'gstin', value: '   ' },
        null,
        'gstin',
      ] as unknown as TaxRegistration[]),
    ).toEqual([]);
  });
});

describe('what a registration must satisfy', () => {
  it('checks each scheme by its own rule', () => {
    expect(isValidRegistration('gstin', GSTIN)).toBe(true);
    expect(isValidRegistration('gstin', '27AAPFU0939F1ZW')).toBe(false);
    expect(isValidRegistration('pan', 'AAPFU0939F')).toBe(true);
    expect(isValidRegistration('pan', 'AAPXU0939F')).toBe(false); // 'X' is not a holder type
    expect(isValidRegistration('ein', '12-3456789')).toBe(true);
    expect(isValidRegistration('ein', '123456789')).toBe(false);
    expect(isValidRegistration('sales_tax', 'CA-12345678')).toBe(true);
    expect(isValidRegistration('sales_tax', '#12')).toBe(false);
  });

  it('every shipped scheme has a rule — a new scheme cannot be added without one', () => {
    for (const scheme of TAX_REGISTRATION_SCHEMES) {
      expect(typeof isValidRegistration(scheme, 'ZZZZZ')).toBe('boolean');
    }
  });
});

describe('validateTaxRegistrations', () => {
  it('accepts a well-formed set', () => {
    expect(
      validateTaxRegistrations(
        [
          { scheme: 'gstin', value: GSTIN },
          { scheme: 'pan', value: 'AAPFU0939F' },
        ],
        'registrations',
      ),
    ).toEqual([]);
  });

  it('refuses an unknown scheme by name, and names the entry', () => {
    const findings = validateTaxRegistrations(
      [{ scheme: 'abn' as never, value: '12345678901' }],
      'registrations',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ refusal: 'unknown_registration_scheme', field: 'registrations[0]' });
    expect(findings[0].detail).toContain('gstin');
  });

  it('refuses a malformed value WITHOUT echoing it — findings travel into logs and cards', () => {
    const findings = validateTaxRegistrations([{ scheme: 'gstin', value: '27AAPFU0939F1ZW' }], 'registrations');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ refusal: 'malformed_registration', field: 'registrations[0]' });
    expect(findings[0].detail).not.toContain('27AAPFU0939F1ZW');
  });

  it('refuses the same registration listed twice, but allows two different GSTINs (a business registers per state)', () => {
    expect(
      validateTaxRegistrations(
        [
          { scheme: 'gstin', value: GSTIN },
          { scheme: 'gstin', value: GSTIN },
        ],
        'registrations',
      ).map((f) => f.refusal),
    ).toEqual(['duplicate_registration']);
    expect(
      validateTaxRegistrations(
        [
          { scheme: 'gstin', value: GSTIN },
          { scheme: 'gstin', value: OTHER_GSTIN },
        ],
        'registrations',
      ),
    ).toEqual([]);
  });

  it('bounds the list — a party holds a handful, never a directory', () => {
    const many = Array.from({ length: MAX_TAX_REGISTRATIONS + 1 }, () => ({
      scheme: 'gstin' as const,
      value: GSTIN,
    }));
    expect(validateTaxRegistrations(many, 'registrations').map((f) => f.refusal)).toContain('too_many_registrations');
  });
});

describe('the address a filing prints', () => {
  it('trims, bounds and upper-cases the country; absent optional parts stay absent', () => {
    const normalised = normalisePostalAddress({
      line1: `  12 Nehru Road${' '.repeat(4)}`,
      line2: '   ',
      city: ' Bengaluru ',
      region: '',
      postalCode: ' 560001 ',
      country: ' in ',
    });
    expect(normalised).toEqual({
      line1: '12 Nehru Road',
      city: 'Bengaluru',
      postalCode: '560001',
      country: 'IN',
    });
    expect(normalisePostalAddress({ line1: 'x'.repeat(500), city: 'c', country: 'IN' }).line1).toHaveLength(120);
  });

  it('refuses only what would make a document wrong: no street, no city, no country code', () => {
    expect(validatePostalAddress({ line1: '12 Nehru Road', city: 'Bengaluru', country: 'IN' }, 'address')).toEqual([]);
    const findings = validatePostalAddress({ line1: '', city: '', country: 'India' }, 'address');
    expect(findings.map((f) => f.field)).toEqual(['address.line1', 'address.city', 'address.country']);
    expect(findings.every((f) => f.refusal === 'malformed_address')).toBe(true);
  });
});

describe('legal name + lookup', () => {
  it('collapses whitespace and bounds the name', () => {
    expect(normaliseLegalName('  Utopai   Furniture   LLP  ')).toBe('Utopai Furniture LLP');
    expect(normaliseLegalName(42)).toBe('');
    expect(normaliseLegalName('x'.repeat(400))).toHaveLength(200);
  });

  it('finds the registration for a scheme, or null — never a guess', () => {
    const registrations: TaxRegistration[] = [
      { scheme: 'pan', value: 'AAPFU0939F' },
      { scheme: 'gstin', value: GSTIN },
    ];
    expect(registrationFor(registrations, 'gstin')).toBe(GSTIN);
    expect(registrationFor(registrations, 'ein')).toBeNull();
    expect(registrationFor(undefined, 'gstin')).toBeNull();
  });
});
