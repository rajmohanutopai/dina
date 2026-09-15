/**
 * Who the parties to a trade ARE, on paper (RESEARCHER_KERNEL_ARCHITECTURE §5.D).
 *
 * The khata documents identify parties by DID. A filing does not: an e-way bill
 * names the consignor's and the consignee's GSTINs, an invoice names a legal
 * name and a billing address. Nothing in the trade design placed those, which is
 * why the remaining country-pack hooks had nothing to send — so this module is
 * the one definition of a party's paper identity, used by BOTH sides:
 *
 *   - the node's own business → commerce settings (`kind: 'business'`)
 *   - a counterparty → their contact row
 *
 * ONE DEFINITION, because the two sides are the same fact seen from either end:
 * a supplier's `consignor_gstin` is the buyer's `consignee_gstin`. A second
 * spelling would eventually disagree with itself, and a filing is the worst
 * place to discover that.
 *
 * REFUSED, NOT CLAMPED. A registration that fails its scheme's checksum is
 * rejected on the way in, with the reason. A mistyped GSTIN stored "as given"
 * is a filing made under someone else's number; a refusal is a correction the
 * owner can make in a second.
 *
 * NO CREDENTIALS. A registration number is public on an invoice; an API key is
 * not. The settings validator's credential-shaped-key rule still applies to the
 * records that embed these.
 */

import { isGstin, isPan } from '../pii/checksums';

/**
 * The registration schemes the shipped country packs need. A closed set on
 * purpose: an unknown scheme is a typo until a market demands it, and a typo
 * that rides into a filing is worse than a refusal. Extend the table when a
 * pack does.
 */
export const TAX_REGISTRATION_SCHEMES = ['gstin', 'pan', 'ein', 'sales_tax'] as const;
export type TaxRegistrationScheme = (typeof TAX_REGISTRATION_SCHEMES)[number];

export function isTaxRegistrationScheme(value: unknown): value is TaxRegistrationScheme {
  return typeof value === 'string' && (TAX_REGISTRATION_SCHEMES as readonly string[]).includes(value);
}

/** One registration a party holds. `value` is stored in its canonical case. */
export interface TaxRegistration {
  scheme: TaxRegistrationScheme;
  value: string;
}

/**
 * A postal address as a filing prints it. Free text by nature — this module
 * bounds and trims it, and refuses only what would make a document wrong: an
 * empty street or city, or a country that is not an ISO-3166-1 alpha-2 code.
 */
export interface PostalAddress {
  line1: string;
  line2?: string;
  city: string;
  /** State / province / region, as the country prints it. */
  region?: string;
  postalCode?: string;
  /** ISO-3166-1 alpha-2, uppercase. */
  country: string;
}

/** Refusals this module can produce; folded into the settings union. */
export type TradeIdentityRefusal =
  | 'unknown_registration_scheme'
  | 'malformed_registration'
  | 'duplicate_registration'
  | 'too_many_registrations'
  | 'empty_legal_name'
  | 'legal_name_too_long'
  | 'malformed_address'
  /** A channel a rail would message: a phone or an e-mail (§5.D). */
  | 'malformed_channel'
  | 'channel_held_by_another_person';

export interface TradeIdentityFinding {
  refusal: TradeIdentityRefusal;
  field: string;
  detail: string;
}

/** A party holds a handful of registrations, never a directory of them. */
export const MAX_TAX_REGISTRATIONS = 8;
export const MAX_LEGAL_NAME_CHARS = 200;
const MAX_ADDRESS_FIELD_CHARS = 120;
const ISO_COUNTRY = /^[A-Z]{2}$/;

/** Does this value satisfy its scheme's own shape and checksum? */
export function isValidRegistration(scheme: TaxRegistrationScheme, value: string): boolean {
  switch (scheme) {
    case 'gstin':
      return isGstin(value);
    case 'pan':
      return isPan(value);
    case 'ein':
      // A US Employer Identification Number: two digits, a hyphen, seven digits.
      // The IRS publishes no check digit, so the shape is the whole check.
      return /^\d{2}-\d{7}$/.test(value);
    case 'sales_tax':
      // State sales-tax permits have no national format; bound it and keep the
      // characters a permit can actually carry.
      return /^[A-Z0-9][A-Z0-9-]{2,19}$/.test(value);
  }
}

/**
 * Trim, canonicalise case, and drop empties — WITHOUT judging validity, so a
 * caller can normalise then validate and report on exactly what will be stored.
 * Order is first-seen (an owner's first GSTIN stays their first).
 */
export function normaliseTaxRegistrations(raw: readonly TaxRegistration[]): TaxRegistration[] {
  const out: TaxRegistration[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const scheme = typeof entry.scheme === 'string' ? entry.scheme.trim().toLowerCase() : '';
    const value = typeof entry.value === 'string' ? entry.value.trim().toUpperCase() : '';
    if (scheme === '' || value === '') continue;
    out.push({ scheme: scheme as TaxRegistrationScheme, value });
  }
  return out;
}

/**
 * Validate an already-normalised registration list. Every finding names the
 * offending entry by index, so an owner fixing one does not have to guess.
 */
export function validateTaxRegistrations(
  registrations: readonly TaxRegistration[],
  field: string,
): TradeIdentityFinding[] {
  const findings: TradeIdentityFinding[] = [];
  if (registrations.length > MAX_TAX_REGISTRATIONS) {
    findings.push({
      refusal: 'too_many_registrations',
      field,
      detail: `a party holds at most ${String(MAX_TAX_REGISTRATIONS)} registrations, not ${String(registrations.length)}`,
    });
  }
  const seen = new Set<string>();
  registrations.forEach((entry, index) => {
    const at = `${field}[${String(index)}]`;
    if (!isTaxRegistrationScheme(entry.scheme)) {
      findings.push({
        refusal: 'unknown_registration_scheme',
        field: at,
        detail: `"${entry.scheme}" is not one of: ${TAX_REGISTRATION_SCHEMES.join(', ')}`,
      });
      return;
    }
    if (!isValidRegistration(entry.scheme, entry.value)) {
      findings.push({
        refusal: 'malformed_registration',
        field: at,
        // The VALUE is not echoed: a mistyped registration is still the
        // owner's identifier, and findings travel into logs and cards.
        detail: `the ${entry.scheme} does not pass its own format check`,
      });
      return;
    }
    const key = `${entry.scheme}:${entry.value}`;
    if (seen.has(key)) {
      findings.push({ refusal: 'duplicate_registration', field: at, detail: `this ${entry.scheme} is listed twice` });
      return;
    }
    seen.add(key);
  });
  return findings;
}

/** Trim and bound an address; absent optional parts stay absent. */
export function normalisePostalAddress(raw: PostalAddress): PostalAddress {
  const text = (value: unknown): string =>
    typeof value === 'string' ? value.trim().slice(0, MAX_ADDRESS_FIELD_CHARS) : '';
  const line2 = text(raw.line2);
  const region = text(raw.region);
  const postalCode = text(raw.postalCode);
  return {
    line1: text(raw.line1),
    ...(line2 !== '' ? { line2 } : {}),
    city: text(raw.city),
    ...(region !== '' ? { region } : {}),
    ...(postalCode !== '' ? { postalCode } : {}),
    country: text(raw.country).toUpperCase(),
  };
}

/** Validate an already-normalised address. */
export function validatePostalAddress(address: PostalAddress, field: string): TradeIdentityFinding[] {
  const findings: TradeIdentityFinding[] = [];
  if (address.line1 === '') {
    findings.push({ refusal: 'malformed_address', field: `${field}.line1`, detail: 'a street line is required' });
  }
  if (address.city === '') {
    findings.push({ refusal: 'malformed_address', field: `${field}.city`, detail: 'a city is required' });
  }
  if (!ISO_COUNTRY.test(address.country)) {
    findings.push({
      refusal: 'malformed_address',
      field: `${field}.country`,
      detail: 'country must be an ISO-3166-1 alpha-2 code, e.g. IN or US',
    });
  }
  return findings;
}

/** Trim and bound a legal name; validation is separate, as everywhere here. */
export function normaliseLegalName(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ').slice(0, MAX_LEGAL_NAME_CHARS) : '';
}

/** The registration for a scheme, when the party holds one. */
export function registrationFor(
  registrations: readonly TaxRegistration[] | undefined,
  scheme: TaxRegistrationScheme,
): string | null {
  return registrations?.find((r) => r.scheme === scheme)?.value ?? null;
}
