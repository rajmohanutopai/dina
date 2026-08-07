/**
 * Canonical numeric string rules (§9.1, §9.2).
 *
 * Every money and quantity value on the commerce wire is a STRING in
 * exactly one spelling, so canonical JSON bytes — and therefore every
 * digest — are deterministic. Floating point never appears at any
 * stage: parsing yields BigInt/rational values, arithmetic is exact,
 * and only the final subtotal rounding step (arithmetic.ts) rounds.
 *
 * Canonical non-negative integer: `0` or `[1-9][0-9]*`. No sign, no
 * leading zeros, no exponent, no separators.
 *
 * Canonical decimal: canonical integer part, optionally `.` plus a
 * fraction with NO trailing zeros. `1.50` is invalid (its canonical
 * spelling is `1.5`), `.5` is invalid (`0.5`), `1.` is invalid (`1`).
 * A value that would round-trip differently is rejected, never
 * repaired — silent repair would let two byte-different documents
 * carry the same commercial meaning.
 *
 * Validators return `null` on success / error string on failure,
 * matching the @dina/protocol convention.
 */

const CANONICAL_INTEGER = /^(0|[1-9][0-9]*)$/;
const CANONICAL_DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/;

/** Validate a canonical non-negative integer string with a digit bound. */
export function validateCanonicalInteger(value: string, maxDigits: number): string | null {
  if (typeof value !== 'string' || value.length === 0) {
    return 'numeric: value must be a non-empty string';
  }
  if (!CANONICAL_INTEGER.test(value)) {
    return `numeric: "${value}" is not a canonical non-negative integer`;
  }
  if (value.length > maxDigits) {
    return `numeric: "${value}" exceeds the ${maxDigits}-digit magnitude bound`;
  }
  return null;
}

/** Validate a canonical POSITIVE integer string (>= 1) with a digit bound. */
export function validateCanonicalPositiveInteger(value: string, maxDigits: number): string | null {
  const err = validateCanonicalInteger(value, maxDigits);
  if (err) return err;
  if (value === '0') return 'numeric: value must be a positive integer';
  return null;
}

export interface ParsedDecimal {
  /** Digits with the decimal point removed, as a BigInt. */
  scaled: bigint;
  /** Number of fraction digits present (0 when no fraction). */
  scale: number;
}

/**
 * Validate + parse a canonical decimal string.
 *
 * `max_integer_digits` bounds the integer part; `max_scale` bounds the
 * fraction length (per-unit scale from the unit vocabulary). A value
 * exceeding the declared scale is INVALID, not rounded (§9.1).
 */
export function parseCanonicalDecimal(
  value: string,
  max_integer_digits: number,
  max_scale: number,
): { parsed: ParsedDecimal | null; error: string | null } {
  if (typeof value !== 'string' || value.length === 0) {
    return { parsed: null, error: 'numeric: value must be a non-empty string' };
  }
  if (!CANONICAL_DECIMAL.test(value)) {
    return { parsed: null, error: `numeric: "${value}" is not a canonical decimal` };
  }
  const [intPart, fracPart = ''] = value.split('.') as [string, string?];
  if (intPart.length > max_integer_digits) {
    return {
      parsed: null,
      error: `numeric: "${value}" exceeds the ${max_integer_digits}-integer-digit magnitude bound`,
    };
  }
  if (fracPart.length > max_scale) {
    return {
      parsed: null,
      error: `numeric: "${value}" exceeds the declared scale of ${max_scale}`,
    };
  }
  return { parsed: { scaled: BigInt(intPart + fracPart), scale: fracPart.length }, error: null };
}

/** 10^n as BigInt (n >= 0). */
export function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}
