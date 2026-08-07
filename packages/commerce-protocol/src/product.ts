/**
 * Product references (§9.3): identifier-first, issuer-bound identity.
 *
 * Identity precedence is a RESOLUTION policy (verified GTIN, then
 * manufacturer DID + SKU, then Dina subject, then qualified custom).
 * This module enforces the structural half: scoped schemes
 * (`manufacturer_sku`, `custom`) REQUIRE `issuer_did` — an identifier
 * is a signed assertion by its issuer, and an unattributed scoped ID
 * is invalid everywhere it appears (§9.5 applies the same rule to
 * catalog `identifiers`). Names are labels, never identity.
 */

import { isRecord, validateDid, validateHex64 } from './common';

export interface ProductRef {
  scheme: 'gtin' | 'manufacturer_sku' | 'dina_subject' | 'custom';
  value: string;
  issuer_did?: string; // required for manufacturer_sku / custom
  variant_digest?: string;
}

export const MAX_PRODUCT_VALUE_LENGTH = 128;

const GTIN_SHAPE = /^[0-9]{8,14}$/;
const SCOPED_SCHEMES: ReadonlySet<string> = new Set(['manufacturer_sku', 'custom']);
const PRODUCT_SCHEMES: ReadonlySet<string> = new Set([
  'gtin',
  'manufacturer_sku',
  'dina_subject',
  'custom',
]);

export function validateProductRef(product: unknown): string | null {
  if (!isRecord(product)) return 'product: must be an object';
  if (typeof product.scheme !== 'string' || !PRODUCT_SCHEMES.has(product.scheme)) {
    return 'product: scheme must be gtin | manufacturer_sku | dina_subject | custom';
  }
  if (typeof product.value !== 'string' || product.value.length === 0) {
    return 'product: value must be a non-empty string';
  }
  if (product.value.length > MAX_PRODUCT_VALUE_LENGTH) {
    return `product: value exceeds ${MAX_PRODUCT_VALUE_LENGTH} characters`;
  }
  if (product.scheme === 'gtin' && !GTIN_SHAPE.test(product.value)) {
    return 'product: gtin value must be 8-14 digits';
  }
  if (SCOPED_SCHEMES.has(product.scheme)) {
    const didError = validateDid(product.issuer_did, 'product.issuer_did');
    if (didError)
      return `product: scoped scheme "${product.scheme}" requires issuer_did — ${didError}`;
  } else if (product.issuer_did !== undefined) {
    const didError = validateDid(product.issuer_did, 'product.issuer_did');
    if (didError) return didError;
  }
  if (product.variant_digest !== undefined) {
    const hexError = validateHex64(product.variant_digest, 'product.variant_digest');
    if (hexError) return hexError;
  }
  return null;
}

/**
 * Exact-variant equality for transaction authority (§9.4): scheme,
 * value, issuer, and variant digest must all match. Different pack
 * sizes are different variants; a label match means nothing here.
 */
export function productRefsEqual(a: ProductRef, b: ProductRef): boolean {
  return (
    a.scheme === b.scheme &&
    a.value === b.value &&
    (a.issuer_did ?? null) === (b.issuer_did ?? null) &&
    (a.variant_digest ?? null) === (b.variant_digest ?? null)
  );
}
