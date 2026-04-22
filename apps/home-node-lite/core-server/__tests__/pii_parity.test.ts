/**
 * Task 4.80 — Pattern parity audit vs Go Tier 1 regex scrubber.
 *
 * Runs a fixture corpus that mirrors every `core/test/pii_test.go`
 * scenario through the TypeScript `@dina/core.scrubPII` and asserts
 * the same invariants the Go tests assert: the expected `[TYPE_N]`
 * token family is produced, the raw PII is gone, and the non-PII
 * text (including multilingual + SQL payloads) is preserved.
 *
 * This is the cross-runtime parity audit the task plan calls for —
 * diffing TS output against Go's expectations on a fixed corpus.
 * When a future regex tweak drifts the TS side, this test catches
 * it before it ships. Each fixture carries a pointer back to its Go
 * counterpart so regressions can be traced bidirectionally.
 */

import { scrubPII, type PIIMatch } from '@dina/core';

/** One parity fixture. */
interface Fixture {
  /** Short human-readable name for test output. */
  name: string;
  /** Corresponds to a Go TestPII_5_N function. */
  goRef: string;
  /** Input text. */
  input: string;
  /** Tokens that MUST appear in the scrubbed output. */
  mustContainTokens: string[];
  /** Strings that must NOT appear in the scrubbed output (raw PII). */
  mustNotContain?: string[];
  /** Strings that MUST appear unchanged (e.g. multilingual text, SQL payloads). */
  mustContainLiteral?: string[];
  /** Expected types (sorted) of detected entities. */
  expectedTypes?: string[];
}

const FIXTURES: Fixture[] = [
  // Go: TestPII_5_1_EmailDetection
  {
    name: 'single email',
    goRef: 'TestPII_5_1_EmailDetection',
    input: 'Email me at john@example.com',
    mustContainTokens: ['[EMAIL_1]'],
    mustNotContain: ['john@example.com'],
    expectedTypes: ['EMAIL'],
  },
  // Go: TestPII_5_2_PhoneDetection (US format)
  {
    name: 'US phone',
    goRef: 'TestPII_5_2_PhoneDetection',
    input: 'Call 555-123-4567',
    mustContainTokens: ['[PHONE_1]'],
    mustNotContain: ['555-123-4567'],
  },
  // Go: TestPII_5_3_SSNDetection
  {
    name: 'SSN',
    goRef: 'TestPII_5_3_SSNDetection',
    input: 'SSN 123-45-6789',
    mustContainTokens: ['[SSN_1]'],
    mustNotContain: ['123-45-6789'],
  },
  // Go: TestPII_5_4_CreditCardDetection (Luhn-valid Visa test number)
  {
    name: 'credit card with separators',
    goRef: 'TestPII_5_4_CreditCardDetection',
    input: 'Card 4111-1111-1111-1111',
    mustContainTokens: ['[CREDIT_CARD_1]'],
    mustNotContain: ['4111-1111-1111-1111'],
  },
  // Go: TestPII_5_5_MultipleEmails — sequential numbering
  {
    name: 'three emails get _1/_2/_3',
    goRef: 'TestPII_5_5_MultipleEmails',
    input: 'Mail a@a.com, then b@b.com, then c@c.com please',
    mustContainTokens: ['[EMAIL_1]', '[EMAIL_2]', '[EMAIL_3]'],
    mustNotContain: ['a@a.com', 'b@b.com', 'c@c.com'],
  },
  // Go: TestPII_5_6_NoPII — passthrough
  {
    name: 'no PII passthrough',
    goRef: 'TestPII_5_6_NoPII',
    input: 'The weather is nice today',
    mustContainTokens: [],
    mustContainLiteral: ['The weather is nice today'],
  },
  // Go fixture: ADDRESS detection.
  {
    name: 'US street address',
    goRef: 'TestPII_5_ADDRESS',
    input: 'I live at 42 Baker Street',
    mustContainTokens: ['[ADDRESS_1]'],
    mustNotContain: ['42 Baker Street'],
  },
  // Go fixture: Aadhaar (Indian 12-digit ID).
  {
    name: 'Aadhaar',
    goRef: 'TestPII_5_AADHAAR',
    input: 'Aadhaar: 2345 6789 0123 (reference)',
    mustContainTokens: ['[AADHAAR_1]'],
    mustNotContain: ['2345 6789 0123'],
  },
  // Go fixture: PAN (Indian tax ID).
  {
    name: 'PAN',
    goRef: 'TestPII_5_PAN',
    input: 'PAN ABCDE1234F attached',
    mustContainTokens: ['[PAN_1]'],
    mustNotContain: ['ABCDE1234F'],
  },
  // Go fixture: IFSC (Indian bank branch code).
  {
    name: 'IFSC',
    goRef: 'TestPII_5_IFSC',
    input: 'Branch HDFC0001234 is fine',
    mustContainTokens: ['[IFSC_1]'],
    mustNotContain: ['HDFC0001234'],
  },
  // Go fixture: IP address with octet-range validation.
  {
    name: 'IP address',
    goRef: 'TestPII_5_IP',
    input: 'The server is 192.168.1.1 today',
    mustContainTokens: ['[IP_1]'],
    mustNotContain: ['192.168.1.1'],
  },
  // Go fixture: malformed IP (each octet > 255) must NOT be scrubbed.
  {
    name: 'malformed IP is not matched',
    goRef: 'TestPII_5_IP_invalid',
    input: '999.999.999.999 is not an IP',
    mustContainTokens: [],
    mustContainLiteral: ['999.999.999.999'],
  },
  // Go fixture: SQL payload must survive scrubbing; embedded email is scrubbed.
  {
    name: 'SQL survives + embedded email scrubbed',
    goRef: 'TestPII_5_EmailSQL',
    input: "Contact john@evil.com' DROP TABLE users --",
    mustContainTokens: ['[EMAIL_1]'],
    mustNotContain: ['john@evil.com'],
    mustContainLiteral: ['DROP TABLE users'],
  },
  // Go fixture: multilingual text (Devanagari) survives.
  {
    name: 'Devanagari text survives',
    goRef: 'TestPII_5_Multilingual',
    input: 'नमस्ते email me at x@y.com',
    mustContainTokens: ['[EMAIL_1]'],
    mustContainLiteral: ['नमस्ते'],
    mustNotContain: ['x@y.com'],
  },
  // Go fixture: email + phone in the same input.
  {
    name: 'email + phone combo',
    goRef: 'TestPII_5_EmailPhone',
    input: 'Ping x@y.com or 555-123-4567',
    mustContainTokens: ['[EMAIL_1]', '[PHONE_1]'],
    mustNotContain: ['x@y.com', '555-123-4567'],
  },
  // Go fixture: email + SSN combo.
  {
    name: 'email + SSN combo',
    goRef: 'TestPII_5_EmailSSN',
    input: 'x@y.com / SSN 123-45-6789',
    mustContainTokens: ['[EMAIL_1]', '[SSN_1]'],
    mustNotContain: ['x@y.com', '123-45-6789'],
  },
];

describe('Tier 1 regex parity vs Go scrubber (task 4.80)', () => {
  for (const fixture of FIXTURES) {
    it(`${fixture.name} — parity with ${fixture.goRef}`, () => {
      const result = scrubPII(fixture.input);
      for (const token of fixture.mustContainTokens) {
        expect(result.scrubbed).toContain(token);
      }
      for (const banned of fixture.mustNotContain ?? []) {
        expect(result.scrubbed).not.toContain(banned);
      }
      for (const literal of fixture.mustContainLiteral ?? []) {
        expect(result.scrubbed).toContain(literal);
      }
      if (fixture.expectedTypes !== undefined) {
        const gotTypes = [...new Set(result.entities.map((e) => e.type))].sort();
        expect(gotTypes).toEqual(fixture.expectedTypes.slice().sort());
      }
    });
  }

  describe('overlap resolution (Go TestPII_5_Overlaps)', () => {
    it('prefers the longest matching span when two regexes overlap', () => {
      // UPI regex `name@handle` can match a substring of an EMAIL regex's
      // `name@handle.tld`. The Go scrubber's `resolveOverlaps` keeps the
      // longer match (EMAIL) and drops the contained UPI.
      const result = scrubPII('ping alice@dina.app now');
      const types = result.entities.map((e) => e.type);
      expect(types).toEqual(['EMAIL']);
      expect(result.scrubbed).toBe('ping [EMAIL_1] now');
    });
  });

  describe('rehydrate round-trip (Go ScrubRehydrate parity)', () => {
    it('scrub → rehydrate restores every input byte-for-byte', async () => {
      const { rehydratePII: rehydrate } = await import('@dina/core');
      const original =
        'email a@b.com, call 555-123-4567, SSN 123-45-6789, PAN ABCDE1234F';
      const scrubbed = scrubPII(original);
      const restored = rehydrate(
        scrubbed.scrubbed,
        scrubbed.entities.map((e) => ({ token: e.token, value: e.value })),
      );
      expect(restored).toBe(original);
    });
  });

  describe('entity metadata parity', () => {
    it('every entity carries {type,start,end,value,token} — matches Go struct', () => {
      const result = scrubPII('email john@example.com');
      expect(result.entities).toHaveLength(1);
      const e = result.entities[0]!;
      const keys = Object.keys(e).sort();
      expect(keys).toEqual(['end', 'start', 'token', 'type', 'value']);
      expect(e.type).toBe('EMAIL');
      expect(e.start).toBe(6);
      expect(e.end).toBe(6 + 'john@example.com'.length);
      expect(e.value).toBe('john@example.com');
      expect(e.token).toBe('[EMAIL_1]');
      // Assert the entity satisfies the exported PIIMatch shape.
      const asMatch: PIIMatch = { type: e.type, start: e.start, end: e.end, value: e.value };
      expect(asMatch.value).toBe('john@example.com');
    });
  });
});
