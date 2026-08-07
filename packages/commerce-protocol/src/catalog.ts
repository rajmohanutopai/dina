/**
 * Catalog item and product relationship claims (§9.4, §9.5).
 *
 * The catalog RECORD layer (pointer/snapshot publication, digest
 * root, CAS sequence — §10.2) is Phase 2 work and deliberately not
 * here; this module owns the ITEM and CLAIM canonical shapes the
 * §25.1 vectors pin. `attributes` is bounded so it cannot become an
 * unbounded dump of supplier-controlled prompt text (§9.5); names
 * are labels, never identity; a relationship claim is a signed
 * ASSERTION, never an identity merge (§9.4).
 */

import { isRecord, validateDid, validateId, validateIsoUtc } from './common';
import { validateMoney, type Money } from './money';
import { validateCanonicalPositiveInteger } from './numeric';
import { validateProductRef, type ProductRef } from './product';
import { validateQuantity, type Quantity } from './quantity';
import { validateRegionRef, type RegionRef } from './region';

export interface CatalogItem {
  product: ProductRef;
  supplier_did: string;
  catalog_id: string;
  item_revision: string;
  name: string;
  brand?: string;
  family_ref?: ProductRef;
  formulation_ref?: ProductRef;
  relationship_claim_refs?: string[];
  description?: string;
  category_ids: string[];
  pack: {
    sell_unit: Quantity;
    units_per_pack?: string;
  };
  identifiers?: ProductRef[];
  fulfilment_regions: RegionRef[];
  indicative_price?: Money;
  minimum_order?: Quantity;
  freshness: {
    generated_at: string;
    valid_until?: string;
  };
  attributes?: Record<string, string | number | boolean>;
}

export const MAX_CATALOG_NAME_LENGTH = 200;
export const MAX_CATALOG_DESCRIPTION_LENGTH = 2000;
export const MAX_CATALOG_CATEGORY_IDS = 10;
export const MAX_CATALOG_ATTRIBUTES = 40;
export const MAX_ATTRIBUTE_KEY_LENGTH = 64;
export const MAX_ATTRIBUTE_VALUE_LENGTH = 200;
export const MAX_CATALOG_REGIONS = 50;
export const MAX_CATALOG_IDENTIFIERS = 10;
export const MAX_UNITS_PER_PACK_DIGITS = 6;

export function validateCatalogItem(item: unknown): string | null {
  if (!isRecord(item)) return 'catalogItem: must be an object';
  const checks: (string | null)[] = [
    validateProductRef(item.product),
    validateDid(item.supplier_did, 'catalogItem.supplier_did'),
    validateId(item.catalog_id, 'catalogItem.catalog_id'),
    validateId(item.item_revision, 'catalogItem.item_revision'),
  ];
  for (const err of checks) if (err) return err;

  if (
    typeof item.name !== 'string' ||
    item.name.length === 0 ||
    item.name.length > MAX_CATALOG_NAME_LENGTH
  ) {
    return `catalogItem.name: must be a non-empty string of at most ${MAX_CATALOG_NAME_LENGTH} characters`;
  }
  if (
    item.brand !== undefined &&
    (typeof item.brand !== 'string' ||
      item.brand.length === 0 ||
      item.brand.length > MAX_CATALOG_NAME_LENGTH)
  ) {
    return 'catalogItem.brand: must be a non-empty bounded string when present';
  }
  if (
    item.description !== undefined &&
    (typeof item.description !== 'string' ||
      item.description.length > MAX_CATALOG_DESCRIPTION_LENGTH)
  ) {
    return `catalogItem.description: exceeds ${MAX_CATALOG_DESCRIPTION_LENGTH} characters`;
  }
  for (const field of ['family_ref', 'formulation_ref'] as const) {
    if (item[field] !== undefined) {
      const err = validateProductRef(item[field]);
      if (err) return `catalogItem.${field}: ${err}`;
    }
  }
  if (item.relationship_claim_refs !== undefined) {
    if (!Array.isArray(item.relationship_claim_refs) || item.relationship_claim_refs.length > 20) {
      return 'catalogItem.relationship_claim_refs: must be an array of at most 20';
    }
    for (const ref of item.relationship_claim_refs) {
      const err = validateId(ref, 'catalogItem.relationship_claim_refs[]');
      if (err) return err;
    }
  }

  if (
    !Array.isArray(item.category_ids) ||
    item.category_ids.length === 0 ||
    item.category_ids.length > MAX_CATALOG_CATEGORY_IDS
  ) {
    return `catalogItem.category_ids: must be a non-empty array of at most ${MAX_CATALOG_CATEGORY_IDS}`;
  }
  for (const id of item.category_ids) {
    const err = validateId(id, 'catalogItem.category_ids[]');
    if (err) return err;
  }

  if (!isRecord(item.pack)) return 'catalogItem.pack: must be an object';
  const sellUnitError = validateQuantity(item.pack.sell_unit, { require_positive: true });
  if (sellUnitError) return `catalogItem.pack.sell_unit: ${sellUnitError}`;
  if (item.pack.units_per_pack !== undefined) {
    const err = validateCanonicalPositiveInteger(
      item.pack.units_per_pack as string,
      MAX_UNITS_PER_PACK_DIGITS,
    );
    if (err) return `catalogItem.pack.units_per_pack: ${err}`;
  }

  if (item.identifiers !== undefined) {
    if (!Array.isArray(item.identifiers) || item.identifiers.length > MAX_CATALOG_IDENTIFIERS) {
      return `catalogItem.identifiers: must be an array of at most ${MAX_CATALOG_IDENTIFIERS}`;
    }
    // Same issuer-binding rules as 9.3 — a scoped scheme without
    // issuer_did is invalid here too (§9.5).
    for (const ref of item.identifiers) {
      const err = validateProductRef(ref);
      if (err) return `catalogItem.identifiers[]: ${err}`;
    }
  }

  if (
    !Array.isArray(item.fulfilment_regions) ||
    item.fulfilment_regions.length === 0 ||
    item.fulfilment_regions.length > MAX_CATALOG_REGIONS
  ) {
    return `catalogItem.fulfilment_regions: must be a non-empty array of at most ${MAX_CATALOG_REGIONS}`;
  }
  for (const region of item.fulfilment_regions) {
    const err = validateRegionRef(region);
    if (err) return `catalogItem.fulfilment_regions[]: ${err}`;
  }

  if (item.indicative_price !== undefined) {
    const err = validateMoney(item.indicative_price);
    if (err) return `catalogItem.indicative_price: ${err}`;
  }
  if (item.minimum_order !== undefined) {
    const err = validateQuantity(item.minimum_order, { require_positive: true });
    if (err) return `catalogItem.minimum_order: ${err}`;
  }

  if (!isRecord(item.freshness)) return 'catalogItem.freshness: must be an object';
  const generatedError = validateIsoUtc(
    item.freshness.generated_at,
    'catalogItem.freshness.generated_at',
  );
  if (generatedError) return generatedError;
  if (item.freshness.valid_until !== undefined) {
    const err = validateIsoUtc(item.freshness.valid_until, 'catalogItem.freshness.valid_until');
    if (err) return err;
  }

  if (item.attributes !== undefined) {
    if (!isRecord(item.attributes)) return 'catalogItem.attributes: must be an object';
    const entries = Object.entries(item.attributes);
    if (entries.length > MAX_CATALOG_ATTRIBUTES) {
      return `catalogItem.attributes: exceeds ${MAX_CATALOG_ATTRIBUTES} entries (bounded, category-governed — §9.5)`;
    }
    for (const [key, value] of entries) {
      if (key.length === 0 || key.length > MAX_ATTRIBUTE_KEY_LENGTH) {
        return `catalogItem.attributes: key exceeds ${MAX_ATTRIBUTE_KEY_LENGTH} characters`;
      }
      if (typeof value === 'string') {
        if (value.length > MAX_ATTRIBUTE_VALUE_LENGTH) {
          return `catalogItem.attributes["${key}"]: exceeds ${MAX_ATTRIBUTE_VALUE_LENGTH} characters`;
        }
      } else if (typeof value === 'number') {
        if (!Number.isFinite(value)) return `catalogItem.attributes["${key}"]: non-finite number`;
      } else if (typeof value !== 'boolean') {
        return `catalogItem.attributes["${key}"]: must be string | number | boolean`;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Product relationship claims (§9.4)
// ---------------------------------------------------------------------------

export type ProductRelationship =
  | 'manufactured_by'
  | 'marketed_under'
  | 'variant_of'
  | 'packaging_variant_of'
  | 'same_formulation_as'
  | 'replaces'
  | 'sold_by';

export interface ProductRelationshipClaim {
  claim_id: string;
  subject: ProductRef;
  relationship: ProductRelationship;
  object: ProductRef | { did: string };
  issuer_did: string;
  effective_from?: string;
  effective_until?: string;
  evidence_refs?: string[];
}

const RELATIONSHIPS: ReadonlySet<string> = new Set([
  'manufactured_by',
  'marketed_under',
  'variant_of',
  'packaging_variant_of',
  'same_formulation_as',
  'replaces',
  'sold_by',
]);

/** Relationships whose object is a DID (an operator), not a product. */
const DID_OBJECT_RELATIONSHIPS: ReadonlySet<string> = new Set([
  'manufactured_by',
  'marketed_under',
  'sold_by',
]);

export function validateProductRelationshipClaim(claim: unknown): string | null {
  if (!isRecord(claim)) return 'relationshipClaim: must be an object';
  const checks: (string | null)[] = [
    validateId(claim.claim_id, 'relationshipClaim.claim_id'),
    validateProductRef(claim.subject),
    validateDid(claim.issuer_did, 'relationshipClaim.issuer_did'),
  ];
  for (const err of checks) if (err) return err;

  if (typeof claim.relationship !== 'string' || !RELATIONSHIPS.has(claim.relationship)) {
    return 'relationshipClaim.relationship: unknown relationship';
  }
  if (!isRecord(claim.object)) return 'relationshipClaim.object: must be an object';
  const objectIsDid = typeof (claim.object as Record<string, unknown>).did === 'string';
  if (objectIsDid) {
    if (!DID_OBJECT_RELATIONSHIPS.has(claim.relationship)) {
      return `relationshipClaim: "${claim.relationship}" relates products — object must be a ProductRef`;
    }
    const err = validateDid(
      (claim.object as Record<string, unknown>).did,
      'relationshipClaim.object.did',
    );
    if (err) return err;
  } else {
    const err = validateProductRef(claim.object);
    if (err) return `relationshipClaim.object: ${err}`;
  }

  // Temporal validity (§25.1 "temporal validity"): optional, ordered.
  if (claim.effective_from !== undefined) {
    const err = validateIsoUtc(claim.effective_from, 'relationshipClaim.effective_from');
    if (err) return err;
  }
  if (claim.effective_until !== undefined) {
    const err = validateIsoUtc(claim.effective_until, 'relationshipClaim.effective_until');
    if (err) return err;
    if (
      claim.effective_from !== undefined &&
      Date.parse(claim.effective_until as string) <= Date.parse(claim.effective_from as string)
    ) {
      return 'relationshipClaim: effective_until must be after effective_from';
    }
  }
  if (claim.evidence_refs !== undefined) {
    if (!Array.isArray(claim.evidence_refs) || claim.evidence_refs.length > 20) {
      return 'relationshipClaim.evidence_refs: must be an array of at most 20';
    }
    for (const ref of claim.evidence_refs) {
      if (typeof ref !== 'string' || ref.length === 0 || ref.length > 512) {
        return 'relationshipClaim.evidence_refs[]: must be non-empty strings of at most 512 characters';
      }
    }
  }
  return null;
}
