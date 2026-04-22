/**
 * CORE-P0-013/014/015/T05 — Crockford Base32 + pairing code tests.
 */

import {
  CROCKFORD_ALPHABET,
  PAIRING_CODE_LENGTH,
  PAIRING_CODE_BYTES,
  encodeCrockford,
  decodeCrockford,
  canonicalizeCrockford,
  generatePairingCode,
} from '../../src/pairing/crockford';

describe('CROCKFORD_ALPHABET', () => {
  it('has 32 characters', () => {
    expect(CROCKFORD_ALPHABET).toHaveLength(32);
  });

  it('excludes I, L, O, U (visual / profanity filter)', () => {
    expect(CROCKFORD_ALPHABET).not.toMatch(/[ILOU]/);
  });

  it('starts with digits 0-9 then letters A..Z minus the excluded set', () => {
    expect(CROCKFORD_ALPHABET.slice(0, 10)).toBe('0123456789');
    expect(CROCKFORD_ALPHABET.slice(10)).toBe('ABCDEFGHJKMNPQRSTVWXYZ');
  });
});

describe('encodeCrockford / decodeCrockford', () => {
  it('encodes 0 as "0"', () => {
    expect(encodeCrockford(0n)).toBe('0');
  });

  it('encodes 31 as the last alphabet character "Z"', () => {
    expect(encodeCrockford(31n)).toBe('Z');
  });

  it('encodes 32 as "10" (symbol overflow)', () => {
    expect(encodeCrockford(32n)).toBe('10');
  });

  it('rejects negative inputs', () => {
    expect(() => encodeCrockford(-1n)).toThrow(/non-negative/);
  });

  it('decodes "Z" to 31', () => {
    expect(decodeCrockford('Z')).toBe(31n);
  });

  it('rejects empty string', () => {
    expect(() => decodeCrockford('')).toThrow(/empty/);
  });

  it('rejects unknown characters post-canonicalisation', () => {
    expect(() => decodeCrockford('?')).toThrow(/unexpected character/);
  });

  // CORE-P0-T05: round-trip property for 1000 random n
  it('decode(encode(n)) === n for 1000 random non-negative bigints', () => {
    for (let i = 0; i < 1000; i++) {
      // Random 40-bit value (pairing-code codespace)
      const high = BigInt(Math.floor(Math.random() * 2 ** 20));
      const low = BigInt(Math.floor(Math.random() * 2 ** 20));
      const n = (high << 20n) | low;
      expect(decodeCrockford(encodeCrockford(n))).toBe(n);
    }
  });
});

describe('canonicalizeCrockford', () => {
  it('uppercases lowercase input', () => {
    expect(canonicalizeCrockford('abc123')).toBe('ABC123');
  });

  it('maps I / L → 1', () => {
    // i → 1, l → 1, o → 0, v, e, i → 1, t
    expect(canonicalizeCrockford('iloveit')).toBe('110VE1T');
  });

  it('maps O → 0', () => {
    expect(canonicalizeCrockford('okoko')).toBe('0K0K0');
  });

  it('strips whitespace and hyphens', () => {
    expect(canonicalizeCrockford(' AB-CD\tEF\n')).toBe('ABCDEF');
  });

  it('handles a realistic user-entered pairing code', () => {
    // User types with lowercase + hyphens (common paper UX)
    expect(canonicalizeCrockford('abcd-1234')).toBe('ABCD1234');
  });
});

describe('generatePairingCode', () => {
  it('produces an 8-character code for 5 input bytes', () => {
    const bytes = new Uint8Array([0, 0, 0, 0, 0]);
    const code = generatePairingCode(bytes);
    expect(code).toHaveLength(PAIRING_CODE_LENGTH);
    expect(code).toBe('00000000'); // all-zero bytes → all-zero code
  });

  it('left-pads with "0" for low-value random bytes', () => {
    const bytes = new Uint8Array([0, 0, 0, 0, 1]);
    const code = generatePairingCode(bytes);
    expect(code).toHaveLength(PAIRING_CODE_LENGTH);
    expect(code.endsWith('1')).toBe(true);
    expect(code.startsWith('0')).toBe(true);
  });

  it('produces the maximum-value code for all-0xFF bytes', () => {
    const bytes = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff]);
    const code = generatePairingCode(bytes);
    expect(code).toHaveLength(PAIRING_CODE_LENGTH);
    // 2^40 - 1 encoded in Crockford — eight Z's? No: ZZZZZZZZ = 32^8 - 1 > 2^40 - 1
    // 2^40 - 1 = 1099511627775; encoded in base32 = 8 chars, all 31 (= "Z")
    expect(code).toBe('ZZZZZZZZ');
  });

  it('rejects non-5-byte inputs', () => {
    expect(() => generatePairingCode(new Uint8Array([0, 0, 0, 0]))).toThrow(/expected 5 bytes/);
    expect(() => generatePairingCode(new Uint8Array([0, 0, 0, 0, 0, 0]))).toThrow(
      /expected 5 bytes/,
    );
  });

  it(`round-trip: decode(generatePairingCode(bytes)) equals bytes-as-bigint`, () => {
    const bytes = new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x9a]);
    const code = generatePairingCode(bytes);
    const n = decodeCrockford(code);
    // Verify the bits match
    let expected = 0n;
    for (const b of bytes) {
      expected = (expected << 8n) | BigInt(b);
    }
    expect(n).toBe(expected);
  });

  it(`PAIRING_CODE_BYTES = ${PAIRING_CODE_BYTES} gives exactly 40 bits of entropy`, () => {
    expect(PAIRING_CODE_BYTES * 8).toBe(PAIRING_CODE_LENGTH * 5);
  });
});
