/**
 * Public search requirements (§9.6).
 *
 * The v1 DEFAULT builds requirements from closed fields only —
 * identifiers, category IDs, governed constraints — with NO free
 * text; that structural property is what makes the privacy guarantee
 * enforceable. `query_text` is an owner-opt-in exception: bounded
 * here; produced by the Core projection path and scrubbed for
 * structured identifiers THERE (the scrub needs Core's PII patterns
 * and owner-visibility surface, which a zero-dep wire package cannot
 * and should not own). Exact address, buyer history, budget ledger,
 * and staff identity have no fields here at all — the type cannot
 * carry them.
 */

import { isRecord, validateIsoUtc } from './common';
import { validateMoney } from './money';
import { validateProductRef, type ProductRef } from './product';
import { validateQuantity, type Quantity } from './quantity';
import { validateRegionRef, type RegionRef } from './region';

import type { Money } from './money';

export interface ProductSearchRequirements {
  query_text?: string;
  identifiers?: ProductRef[];
  category_ids?: string[];
  quantity?: Quantity;
  delivery_region?: RegionRef;
  required_by?: string;
  constraints?: {
    maximum_indicative_unit_price?: Money;
    allowed_brands?: string[];
    excluded_ingredients_or_attributes?: string[];
    minimum_shelf_life_days?: number;
  };
}

export const MAX_QUERY_TEXT_LENGTH = 256;
export const MAX_SEARCH_IDENTIFIERS = 20;
export const MAX_SEARCH_CATEGORY_IDS = 20;
export const MAX_SEARCH_LIST_ENTRIES = 50;
export const MAX_SEARCH_LIST_ENTRY_LENGTH = 100;

function validateBoundedStringArray(
  value: unknown,
  field: string,
  max_entries: number,
): string | null {
  if (!Array.isArray(value)) return `${field}: must be an array`;
  if (value.length > max_entries) return `${field}: exceeds ${max_entries} entries`;
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0) {
      return `${field}: entries must be non-empty strings`;
    }
    if (entry.length > MAX_SEARCH_LIST_ENTRY_LENGTH) {
      return `${field}: entry exceeds ${MAX_SEARCH_LIST_ENTRY_LENGTH} characters`;
    }
  }
  return null;
}

export function validateProductSearchRequirements(requirements: unknown): string | null {
  if (!isRecord(requirements)) return 'search: must be an object';
  if (requirements.query_text !== undefined) {
    if (typeof requirements.query_text !== 'string' || requirements.query_text.length === 0) {
      return 'search.query_text: must be a non-empty string when present';
    }
    if (requirements.query_text.length > MAX_QUERY_TEXT_LENGTH) {
      return `search.query_text: exceeds ${MAX_QUERY_TEXT_LENGTH} characters (owner-opt-in free text is bounded)`;
    }
  }
  if (requirements.identifiers !== undefined) {
    if (!Array.isArray(requirements.identifiers)) return 'search.identifiers: must be an array';
    if (requirements.identifiers.length > MAX_SEARCH_IDENTIFIERS) {
      return `search.identifiers: exceeds ${MAX_SEARCH_IDENTIFIERS}`;
    }
    for (const ref of requirements.identifiers) {
      const err = validateProductRef(ref);
      if (err) return `search.identifiers[]: ${err}`;
    }
  }
  if (requirements.category_ids !== undefined) {
    const err = validateBoundedStringArray(
      requirements.category_ids,
      'search.category_ids',
      MAX_SEARCH_CATEGORY_IDS,
    );
    if (err) return err;
  }
  if (requirements.quantity !== undefined) {
    const err = validateQuantity(requirements.quantity, { require_positive: true });
    if (err) return `search.quantity: ${err}`;
  }
  if (requirements.delivery_region !== undefined) {
    const err = validateRegionRef(requirements.delivery_region);
    if (err) return `search.delivery_region: ${err}`;
  }
  if (requirements.required_by !== undefined) {
    const err = validateIsoUtc(requirements.required_by, 'search.required_by');
    if (err) return err;
  }
  if (requirements.constraints !== undefined) {
    if (!isRecord(requirements.constraints)) return 'search.constraints: must be an object';
    const c = requirements.constraints;
    if (c.maximum_indicative_unit_price !== undefined) {
      const err = validateMoney(c.maximum_indicative_unit_price);
      if (err) return `search.constraints.maximum_indicative_unit_price: ${err}`;
    }
    for (const field of ['allowed_brands', 'excluded_ingredients_or_attributes'] as const) {
      if (c[field] !== undefined) {
        const err = validateBoundedStringArray(
          c[field],
          `search.constraints.${field}`,
          MAX_SEARCH_LIST_ENTRIES,
        );
        if (err) return err;
      }
    }
    if (
      c.minimum_shelf_life_days !== undefined &&
      (typeof c.minimum_shelf_life_days !== 'number' ||
        !Number.isInteger(c.minimum_shelf_life_days) ||
        c.minimum_shelf_life_days < 0 ||
        c.minimum_shelf_life_days > 36500)
    ) {
      return 'search.constraints.minimum_shelf_life_days: must be an integer in [0, 36500]';
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Search results (§10.5)
// ---------------------------------------------------------------------------

/**
 * What a catalog AppView returns: a bounded CANDIDATE REFERENCE.
 *
 * Every field here is discovery evidence. None of it is a commitment: the
 * price is indicative (§10.4), the snapshot reference is what the supplier
 * published rather than what they will honour today, and `retrieval_score` is
 * how the index ranked its own recall — NOT permission and NOT the buyer's
 * ranking, which happens in the buyer's own node against signed quotes.
 *
 * The type is deliberately narrow. §10.6 permits multiple AppViews, so a
 * candidate must carry enough source evidence for a buyer to identify where it
 * came from and verify the supplier live before committing; it must NOT carry
 * anything that could be mistaken for a current contractual offer (FR-A7),
 * which is why there is no stock field and no authorization field to populate.
 */
export interface CommerceSearchCandidate {
  supplier_did: string;
  service_uri: string;
  service_rkey: string;
  product: ProductRef;
  /** The snapshot digest this candidate was projected from (FR-A5). */
  catalog_snapshot_ref: string;
  /** Evidence supporting a projected relationship, when one was used (§10.7). */
  relationship_evidence_refs?: string[];
  /** Which fields matched, so a buyer can see WHY this was returned. */
  matched_fields: string[];
  indicative_price?: Money;
  fulfilment_regions: RegionRef[];
  generated_at: string;
  valid_until?: string;
  /**
   * Recall confidence in basis points, 0–10000. Basis points rather than a
   * float because the whole commerce surface carries exact integers and a
   * float here would be the one place a value drifts between languages.
   */
  retrieval_score_bp: number;
}

/** A page of candidates. Bounded, because discovery must not be a firehose. */
export const MAX_SEARCH_CANDIDATES = 50;

export function validateCommerceSearchCandidate(value: unknown): string | null {
  if (!isRecord(value)) return 'candidate: must be an object';
  for (const field of [
    'supplier_did',
    'service_uri',
    'service_rkey',
    'catalog_snapshot_ref',
  ] as const) {
    if (typeof value[field] !== 'string' || value[field].length === 0) {
      return `candidate.${field}: must be a non-empty string`;
    }
  }
  const product = validateProductRef(value.product);
  if (product !== null) return `candidate.product: ${product}`;

  if (!Array.isArray(value.matched_fields) || value.matched_fields.length === 0) {
    // A candidate with no matched field is a result nobody can explain, and an
    // unexplainable result is indistinguishable from a paid placement — which
    // is the thing this whole index exists not to be.
    return 'candidate.matched_fields: at least one field must be named';
  }
  if (!Array.isArray(value.fulfilment_regions)) {
    return 'candidate.fulfilment_regions: must be an array';
  }
  for (const region of value.fulfilment_regions) {
    const err = validateRegionRef(region);
    if (err) return `candidate.fulfilment_regions[]: ${err}`;
  }
  if (value.indicative_price !== undefined) {
    const err = validateMoney(value.indicative_price);
    if (err) return `candidate.indicative_price: ${err}`;
  }
  const generated = validateIsoUtc(value.generated_at, 'candidate.generated_at');
  if (generated !== null) return generated;
  if (value.valid_until !== undefined) {
    const err = validateIsoUtc(value.valid_until, 'candidate.valid_until');
    if (err) return err;
  }
  if (
    typeof value.retrieval_score_bp !== 'number' ||
    !Number.isInteger(value.retrieval_score_bp) ||
    value.retrieval_score_bp < 0 ||
    value.retrieval_score_bp > 10000
  ) {
    return 'candidate.retrieval_score_bp: must be an integer in [0, 10000]';
  }
  return null;
}
