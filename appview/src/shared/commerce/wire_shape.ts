/**
 * Shape guards for records that arrive from the firehose.
 *
 * WHY THIS EXISTS RATHER THAN MORE FIELD-BY-FIELD FIXES. Four review rounds
 * found the same defect in four places: a publisher-controlled value reaching a
 * queryable column, or crashing a dereference, because the code trusted a
 * TypeScript annotation about bytes that came off the wire. Each round I fixed
 * the instance the scan pointed at — regions, then category ids, then evidence
 * refs, then claim ids — and each round the next scan found another. Patching
 * instances does not converge on a class.
 *
 * THE PREMISE THIS FILE SHIPPED WITH WAS FALSE, and correcting it matters more
 * than the checks do. It said "nothing upstream validates field types". A
 * stricter layer has been there all along: `ingester/record-validator.ts` holds
 * Zod schemas for all three commerce collections, and `jetstream-consumer.ts`
 * runs them before dispatch. I built a boundary on an assumption I never
 * checked, which is the same error as the leaks it was written to stop.
 *
 * THE REAL RELATIONSHIP, stated so the next reader does not repeat it:
 *
 *   - **Zod is the firehose gate.** Every record arriving from Jetstream is
 *     parsed there, and it is STRICTER than this file on the fields it names —
 *     `hex64` digests, `.datetime()` timestamps, bounded lengths, the
 *     relationship enum.
 *   - **This file is defence in depth for DIRECT callers.** Every commerce test
 *     calls handlers directly, and so would a backfill or a replay. Those paths
 *     never touch Zod, so a gate here is not redundant — it is the only gate
 *     they have.
 *
 * WHERE THE TWO DISAGREE, the stricter rule belongs in Zod and the shape rule
 * belongs here; the checks below deliberately cover what a handler DEREFERENCES
 * or STORES rather than restating format rules that already have a home.
 *
 * REFUSE, NEVER THROW. A throw out of an ingest handler is worse than a
 * refusal: the record is neither indexed NOR counted as refused, so a
 * hostile-but-digest-valid record vanishes from the one metric an operator
 * would use to notice it.
 *
 * FIELD NAMES, NEVER VALUES, in every message. A refusal that quoted the
 * payload would copy a hostile publisher's bytes into an operator's log.
 */

import {
  validateCatalogPointerRecord,
  validateCatalogSnapshotRecord,
  validateId,
  validateProductRef,
  validateRegionRef,
  validateRelationshipClaim,
} from './wire-rules.js'

export function isRecordShape(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A required non-empty string. Returns the field name when it is not one. */
export function requireText(
  holder: Record<string, unknown>,
  field: string,
  path = field,
): string | null {
  const value = holder[field]
  return typeof value === 'string' && value !== '' ? null : path
}

/**
 * A string when present, where ABSENT includes `null`.
 *
 * `null` is how JSON spells "no value", and the catalog projection already
 * states this rule for `indicative_price`. Having the pointer gate be stricter
 * broke something real: a supplier withdrawing with `"snapshot_digest": null` —
 * a tombstone names no snapshot, and null is the natural spelling — would have
 * had the whole record refused, so the withdrawal never applied and their
 * retired catalog stayed searchable. FR-A6 wants withdrawal handled
 * predictably, and a rule that turns a retirement into a no-op is not that.
 *
 * Two rules for one concept inside one subsystem is the defect; this is the
 * side that moves, because the projection's reasoning was right first.
 */
export function optionalText(
  holder: Record<string, unknown>,
  field: string,
  path = field,
): string | null {
  const value = holder[field]
  if (value === undefined || value === null) return null
  return typeof value === 'string' ? null : path
}

/**
 * A `ProductRef`, checked for every field `productKey` dereferences.
 *
 * INCLUDING `issuer_did` AND `variant_digest`, which the third round missed:
 * `encodeParts` computes `part.length`, so a non-string yields `undefined` and
 * the length prefix stops being a length. That breaks the injectivity the
 * encoding exists for, and `decodeProductKey` then returns empty strings for
 * the remaining parts — so a row indexed under a variant digest is served to a
 * buyer with NO variant digest, which under §9.4 is the "unspecified is not a
 * wildcard" case that lets a 12-pack ship against a quote for a 6-pack.
 */
export function checkProductRef(value: unknown, path: string): string | null {
  // DELEGATED to the parity-gated rules. The shape-only version this replaced
  // accepted any non-empty `scheme` and `value`, so `{scheme:"ean"}` and an
  // unscoped `manufacturer_sku` both reached the product key — the second
  // collides two suppliers' SKU "A-1" into one identity, which §9.3 exists to
  // prevent.
  return validateProductRef(value, path)
}

/**
 * A §9.0 `RegionRef`.
 *
 * `issuer_did` IS CHECKED, and its absence was the sharpest leak of four
 * rounds: the region rebuild copies `issuer_did` by reference, so an object
 * there landed in the `fulfilment_regions` jsonb column AND was served to
 * buyers through `toCandidate`. No unnamed-field test could reach it, because
 * `issuer_did` is an ALLOW-LISTED field — the scenarios taint unnamed keys,
 * which are correctly dropped. It is also the exact field the original region
 * fix names as the reason regions are carried structurally at all.
 */
export function checkRegionRef(value: unknown, path: string): string | null {
  return validateRegionRef(value, path)
}

/**
 * A catalog SNAPSHOT, before the row is written.
 *
 * THE FOURTH RECORD TYPE, and the one I asked about and had not gated. The
 * snapshot row is written FIRST, before `decideCatalogSnapshot` verifies
 * anything, and `catalog_id`/`snapshot_digest`/`snapshot_sequence` are
 * extracted lookup columns — the category my own comment in the relationship
 * handler calls "a projection, even on the verbatim table". One record from any
 * DID reached them: an empty `pages` array is within the caps, so the row is
 * written and only then refused for a supplier mismatch, and the row stays.
 */
/**
 * A sequence, as the COLUMN can hold it and the spec defines it.
 *
 * `Number.isSafeInteger` was the wrong bound twice over: the column is drizzle
 * `integer` (pg int4, max 2147483647), so 3000000000 passed the gate and made
 * the INSERT raise "out of range" — an unhandled throw in the lane the gate had
 * just been added to. And `catalog-verify.ts` states the rule the gate did not
 * use: "a sequence is a positive, safe, whole number. Zero is not a sequence."
 */
const PG_INT4_MAX = 2_147_483_647

function checkSequence(value: unknown, path: string): string | null {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= PG_INT4_MAX
    ? null
    : path
}

export function checkCatalogSnapshot(value: unknown): string | null {
  // DELEGATED. The shape-only version accepted `supplier_did: "not-a-did"`, a
  // non-canonical timestamp and page digests that were not hex64 — all refused
  // by every conforming consumer.
  return validateCatalogSnapshotRecord(value)
}

/**
 * A catalog POINTER, before anything reads or stores it.
 *
 * The third table the scan had never visited. `decideCatalogPointer` compares
 * sequences and digests and never checks types, and both the `await_snapshot`
 * and `withdrawn` paths return BEFORE any content verification — so a pointer
 * carrying an object in `protocol_version` or `published_at` went straight into
 * `text NOT NULL` columns, and `catalog_id` reached the primary key as
 * `[object Object]`. One record from any DID was enough.
 */
export function checkCatalogPointer(value: unknown): string | null {
  return validateCatalogPointerRecord(value)
}

/**
 * A pointer is LIVE or a TOMBSTONE, and each shape is complete.
 *
 * The fields were checked one at a time, each optional on its own, so the
 * COMBINATION went unexamined: a live pointer carrying `snapshot_digest` and no
 * `snapshot_rkey` was admitted, and the handler later invented an rkey from the
 * digest — substituting this producer's own convention for what the supplier
 * actually published. The protocol requires both on a live pointer and neither
 * on a withdrawal.
 *
 * Field-by-field validation cannot see a rule that lives BETWEEN fields, which
 * is the same shape of gap as checking each page and never the page set.
 */
function checkPointerCoherence(value: Record<string, unknown>): string | null {
  const hasRkey = value.snapshot_rkey !== undefined && value.snapshot_rkey !== null
  const hasDigest = value.snapshot_digest !== undefined && value.snapshot_digest !== null
  if (value.withdrawn === true) {
    // A tombstone naming a snapshot leaves a reader unsure whether the catalog
    // is live at that record.
    return hasRkey || hasDigest ? 'pointer.withdrawn' : null
  }
  if (!hasRkey) return 'pointer.snapshot_rkey'
  if (!hasDigest) return 'pointer.snapshot_digest'
  return null
}

/**
 * A record key: ABSENT or a valid id — and `null` is neither.
 *
 * TWO DEFECTS IN ONE FIELD, both from treating an rkey as ordinary text.
 *
 *   - `null` reached `decideCatalogPointer`, whose guard is
 *     `service_rkey !== undefined && !isRkey(service_rkey)`. `null` passes the
 *     first half and `isRkey` then reads `null.length` — a throw in the ingest
 *     lane, which is the failure mode this whole file exists to prevent. The
 *     protocol types the field `service_rkey?: string`, so `null` is not a
 *     spelling it has; refusing it is both correct and non-throwing.
 *
 *   - The length bound disagreed with the protocol. `isRkey` allows 512
 *     characters; `validateId` stops at 128 and restricts the charset. A
 *     200-character rkey was therefore INDEXED here and refused by every
 *     conformant reader of the `service_uri` built from it. Taking the
 *     stricter of the two cannot reject anything a conformant publisher sends,
 *     because the protocol already refuses it.
 */
function optionalRkey(
  holder: Record<string, unknown>,
  field: string,
  path: string,
): string | null {
  if (holder[field] === undefined) return null
  return validateId(holder[field], path)
}

/**
 * A §10.7 relationship claim, before it is keyed or stored.
 *
 * `objectKeyOf` does `'did' in object` on an unchecked value and raises on a
 * primitive; `productKey(claim.subject)` raises when `scheme` is absent. The
 * catalog lane got a `malformed_item` refusal two rounds ago and this lane
 * never got its equivalent, which is the same asymmetry that let the pointer
 * go unchecked.
 */
/**
 * DELEGATED, NOT RESTATED — and the reason is the bug this replaced.
 *
 * The previous version of this function carried its OWN relationship
 * vocabulary, written from memory and annotated "mirroring the Zod enum". It
 * listed `successor_of`, `equivalent_to`, `distributed_by`, `branded_as`,
 * `sold_as`. §10.3 defines `marketed_under`, `packaging_variant_of`,
 * `same_formulation_as`, `replaces`, `sold_by`. Two of seven entries
 * overlapped, so this gate refused five valid relationships and admitted five
 * that do not exist — and no test noticed, because every commerce test used one
 * of the two names both lists happened to share.
 *
 * `wire-rules.ts` now states these rules once, checked against the protocol by
 * frozen parity vectors. A second copy here is precisely what went wrong.
 */
export function checkRelationshipClaim(value: unknown): string | null {
  return validateRelationshipClaim(value)
}
