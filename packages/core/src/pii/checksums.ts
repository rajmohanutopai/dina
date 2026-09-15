/**
 * Check-digit and structure rules for the Indian identifiers the PII tiers
 * scrub (RESEARCHER_KERNEL §5.D3 — PII patterns for Aadhaar / PAN). A shape
 * match alone over-scrubs: any twelve digits read as an Aadhaar, any five
 * letters + four digits + letter as a PAN, and a catalog SKU or an invoice
 * reference became "personal data" the owner could not send. Both identifiers
 * carry structure the issuer fixed, and both tiers check it here, once.
 *
 * Aadhaar: twelve digits whose last is a Verhoeff check digit over the first
 * eleven (UIDAI), first digit 2–9. PAN: `AAAAA0000A` whose FOURTH letter names
 * the holder type from a closed set (Individual, Company, Firm, HUF, Trust,
 * Government, Local authority, Body of individuals, Association of persons,
 * Artificial juridical person). The fifth letter is the holder's name initial
 * and cannot be checked without the name.
 */

// Verhoeff tables (Wikipedia / UIDAI reference implementation).
const D: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const P: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/** True when `digits` (check digit last) passes the Verhoeff check. */
export function verhoeffValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let c = 0;
  const reversed = [...digits].reverse();
  for (let i = 0; i < reversed.length; i++) {
    const row = D[c];
    const perm = P[i % 8];
    if (row === undefined || perm === undefined) return false;
    const digit = perm[Number(reversed[i])];
    if (digit === undefined) return false;
    const next = row[digit];
    if (next === undefined) return false;
    c = next;
  }
  return c === 0;
}

/**
 * An Aadhaar number, separators already removed: twelve digits, first 2–9,
 * Verhoeff-valid. (UIDAI reserves leading 0 and 1.)
 */
export function isAadhaarNumber(digits: string): boolean {
  return /^[2-9]\d{11}$/.test(digits) && verhoeffValid(digits);
}

/** PAN holder-type letters (the fourth character). */
export const PAN_HOLDER_TYPES: ReadonlySet<string> = new Set([
  'A', // association of persons
  'B', // body of individuals
  'C', // company
  'F', // firm
  'G', // government
  'H', // Hindu undivided family
  'J', // artificial juridical person
  'L', // local authority
  'P', // individual
  'T', // trust
]);

/** A PAN: five letters (the fourth a holder type), four digits, one letter. */
export function isPan(value: string): boolean {
  if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(value)) return false;
  return PAN_HOLDER_TYPES.has(value.charAt(3));
}

/** The GSTIN alphabet — a digit or capital letter is its index in this string. */
const GSTIN_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * A GSTIN: a 2-digit state code, the holder's PAN, an entity number, the
 * literal `Z`, and a check character over the first fourteen.
 *
 * The check is the GST Network's published rule: each character's alphabet
 * index is multiplied by an alternating weight (1, 2, 1, 2, …), the quotient
 * and remainder of that product over 36 are summed across all fourteen, and
 * the check character is the alphabet entry at `(36 - sum % 36) % 36`. A typed
 * GSTIN with one character wrong fails it, which is the point: a filing sent
 * under a mistyped registration is worse than one refused.
 */
export function isGstin(value: string): boolean {
  if (!/^[0-3][0-9][A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(value)) return false;
  const stateCode = Number(value.slice(0, 2));
  // 01–38 are the states and union territories; 97 (other territory) and 99
  // (centre jurisdiction) exist but carry a different prefix shape, so the
  // regex above already excludes them.
  if (stateCode < 1 || stateCode > 38) return false;
  if (!isPan(value.slice(2, 12))) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const index = GSTIN_ALPHABET.indexOf(value.charAt(i));
    if (index < 0) return false;
    const product = index * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_ALPHABET.charAt((36 - (sum % 36)) % 36) === value.charAt(14);
}
