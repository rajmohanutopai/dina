/**
 * The commerce wire rules, as AppView applies them.
 *
 * THIS WAS A SECOND IMPLEMENTATION AND IS NOW AN ADAPTER. The copy existed
 * because of a rule that turned out not to hold: appview was said to be unable
 * to depend on `@dina/commerce-protocol` since the package uses extensionless
 * relative imports while AppView runs Node ESM. True of the package's SOURCE,
 * false of its BUILD — which is CommonJS and imports cleanly. The package now
 * exposes a `compiled` export condition carrying both types and runtime from
 * `dist/`, and appview asks for it in production and in tests alike.
 *
 * WHAT THE DUPLICATE COST, recorded because the cost is the whole argument.
 * Two review rounds found the two implementations disagreeing in 145 places: a
 * relationship vocabulary sharing two of seven entries with §10.3, five
 * catalog-item branches where AppView accepted records the protocol refuses,
 * and 140 more across pointers and snapshots. Every one was invisible to a
 * green suite, because hand-written parity vectors can only test the cases
 * their author thought of. A duplicate does not stay in step by being watched;
 * it stays in step by not existing.
 *
 * WHAT REMAINS HERE, and why it is not duplication: an APPVIEW-ONLY STORAGE
 * BOUND. `snapshot_sequence` lands in a drizzle `integer` column (pg int4). The
 * protocol permits any safe integer, so a perfectly conformant record can still
 * be one this DATABASE cannot hold — 3_000_000_000 raised "out of range" from
 * the INSERT rather than being refused. That is a fact about AppView's storage,
 * not about the wire, and it belongs on this side of the boundary.
 *
 * REFUSE, NEVER THROW. A throw out of an ingest handler leaves the record
 * neither indexed NOR counted as refused, so a hostile-but-digest-valid record
 * vanishes from the one metric an operator would notice it in.
 */

import {
  validateCatalogItemForIngest,
  validateCatalogPointer,
  validateCatalogSnapshot,
  validateProductRef as protocolValidateProductRef,
  validateProductRelationshipClaim,
  validateRegionRef as protocolValidateRegionRef,
} from '@dina/commerce-protocol'

export function isRecordShape(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * A sequence as THIS DATABASE can hold it.
 *
 * `Number.isSafeInteger` was the wrong bound twice over: the column is pg int4,
 * so 3_000_000_000 passed the gate and made the INSERT raise "out of range" —
 * an unhandled throw in the very lane the gate had just been added to.
 */
const PG_INT4_MAX = 2_147_483_647

function withinInt4(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= PG_INT4_MAX
  )
}

export function checkProductRef(value: unknown, path: string): string | null {
  const error = protocolValidateProductRef(value)
  return error === null ? null : `${path}: ${error}`
}

export function checkRegionRef(value: unknown, path: string): string | null {
  const error = protocolValidateRegionRef(value)
  return error === null ? null : `${path}: ${error}`
}

/**
 * THE READER'S RULE, not the publisher's.
 *
 * `validateCatalogItem` refuses any key outside the declared set, which is
 * right for the node about to SIGN an item and wrong here. §9.13 makes a
 * same-major higher minor additive, projection is all-or-nothing, and
 * `decideCatalogPointer` turns a failed projection into a refusal — so under
 * the publisher's rule one 1.1-added field would make a 1.1 supplier's entire
 * catalog vanish from the index, blamed on the supplier.
 */
export function checkCatalogItem(value: unknown): string | null {
  return validateCatalogItemForIngest(value)
}

export function checkRelationshipClaim(value: unknown): string | null {
  return validateProductRelationshipClaim(value)
}

/**
 * A §10.2 snapshot: the protocol's rules first, then AppView's storage bound.
 *
 * ORDER MATTERS. The protocol answers "may this record exist on the wire?" and
 * the int4 check answers "can this index hold it?". A record can be perfectly
 * conformant and still exceed a column, and an operator needs to hear the wire
 * fault first when there is one.
 */
export function checkCatalogSnapshot(value: unknown): string | null {
  const error = validateCatalogSnapshot(value)
  if (error !== null) return error
  return withinInt4((value as Record<string, unknown>).snapshot_sequence)
    ? null
    : 'snapshot: snapshot_sequence exceeds what this index can store'
}

export function checkCatalogPointer(value: unknown): string | null {
  const error = validateCatalogPointer(value)
  if (error !== null) return error
  return withinInt4((value as Record<string, unknown>).snapshot_sequence)
    ? null
    : 'pointer: snapshot_sequence exceeds what this index can store'
}
