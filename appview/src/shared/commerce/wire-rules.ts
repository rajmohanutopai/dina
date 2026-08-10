/**
 * Commerce wire rules, as AppView enforces them.
 *
 * WHY A COPY AND NOT AN IMPORT. `appview/` declares no `@dina/*` dependency
 * and imports none — it is a REPLACEABLE public projection, deployable and
 * reimplementable without the Dina workspace. The project already answers this
 * question the same way for the capability registry (`shared/capability-
 * registry.ts`), which is copied verbatim rather than imported. So the copy is
 * the established pattern; what the copy has been MISSING is the gate.
 *
 * WHAT WENT WRONG WITHOUT ONE. The previous hand-written gate listed a
 * relationship vocabulary of `successor_of`, `equivalent_to`, `distributed_by`,
 * `branded_as`, `sold_as`. The protocol's §10.3 vocabulary is `marketed_under`,
 * `packaging_variant_of`, `same_formulation_as`, `replaces`, `sold_by`. Only
 * `variant_of` and `manufactured_by` were in both. That gate REFUSED five valid
 * relationships and ADMITTED five that do not exist — written from memory,
 * asserted in a comment to "mirror the Zod enum", and never compared against
 * either. Every commerce test happened to use one of the two overlapping names,
 * so the whole suite stayed green over it.
 *
 * THE GATE THAT WOULD HAVE CAUGHT IT is `commerce_wire_parity.test.ts`, which
 * replays `conformance/vectors/wire_rules_parity.json` through THIS module,
 * while a test inside `@dina/commerce-protocol` replays the same frozen file
 * through the protocol validators. Both sides must agree on every case. Byte-
 * identity is the wrong gate here — the two implementations legitimately differ
 * in structure (Zod schema plus gate vs. protocol validators) — so the gate is
 * on BEHAVIOUR, which is the thing that actually has to match.
 *
 * REFUSE, NEVER THROW: a throw out of an ingest handler leaves the record
 * neither indexed NOR counted as refused, so a hostile-but-digest-valid record
 * vanishes from the one metric an operator would notice it in.
 *
 * FIELD NAMES, NEVER VALUES, in every message: a refusal that quoted the
 * payload would copy a hostile publisher's bytes into an operator's log.
 */

// ---------------------------------------------------------------------------
// Primitives (§9.0)
// ---------------------------------------------------------------------------

export const MAX_ID_LENGTH = 128
export const MAX_DID_LENGTH = 256
export const MAX_PRODUCT_VALUE_LENGTH = 128
export const MAX_REGION_VALUE_LENGTH = 100

const ID_SHAPE = /^[A-Za-z0-9._:-]+$/
const DID_SHAPE = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/
const HEX64 = /^[0-9a-f]{64}$/
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/
const VERSION_SHAPE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Bounded opaque identifier. Record keys (rkeys) are validated as ids. */
export function validateId(value: unknown, field: string): string | null {
  if (typeof value !== 'string' || value.length === 0) return field
  if (value.length > MAX_ID_LENGTH) return field
  if (!ID_SHAPE.test(value)) return field
  return null
}

export function validateDid(value: unknown, field: string): string | null {
  if (typeof value !== 'string' || value.length === 0) return field
  if (value.length > MAX_DID_LENGTH) return field
  if (!DID_SHAPE.test(value)) return field
  return null
}

export function validateHex64(value: unknown, field: string): string | null {
  return typeof value === 'string' && HEX64.test(value) ? null : field
}

/**
 * Canonical ISO 8601 UTC instant.
 *
 * The calendar round-trip is not decoration: `Date.parse` accepts impossible
 * dates by ROLLING THEM OVER, so `2026-02-30T00:00:00Z` parses as 2 March. A
 * timestamp that silently means a different day than it reads is digest-covered
 * here, so two implementations that disagree about normalising produce
 * different bytes for the same input.
 */
export function validateIsoUtc(value: unknown, field: string): string | null {
  if (typeof value !== 'string' || !ISO_UTC.test(value)) return field
  const millis = Date.parse(value)
  if (Number.isNaN(millis)) return field
  if (new Date(millis).toISOString().slice(0, 10) !== value.slice(0, 10)) return field
  return null
}

/** Millisecond epoch of an ALREADY-VALIDATED canonical ISO UTC string. */
export function isoUtcMillis(value: string): number {
  return Date.parse(value)
}

// ---------------------------------------------------------------------------
// Protocol version (§9.13)
// ---------------------------------------------------------------------------

export const COMMERCE_PROTOCOL_MAJOR = '1'

export function validateProtocolVersionShape(value: unknown, field: string): string | null {
  return typeof value === 'string' && VERSION_SHAPE.test(value) ? null : field
}

export function protocolMajor(version: string): string {
  return version.split('.')[0] as string
}

/**
 * §9.13 admission: same MAJOR is parseable (MINOR is strictly additive), a
 * different MAJOR is refused outright.
 *
 * AppView previously did NEITHER check — `protocol_version` was a non-empty
 * string, so `"banana"` and `"2.0"` were both indexed best-effort. §9.13 says a
 * receiver never best-effort-parses across majors.
 */
export function admitsProtocolVersion(value: unknown, field: string): string | null {
  const shape = validateProtocolVersionShape(value, field)
  if (shape !== null) return shape
  return protocolMajor(value as string) === COMMERCE_PROTOCOL_MAJOR ? null : field
}

// ---------------------------------------------------------------------------
// Product and region references (§9.3, §9.0)
// ---------------------------------------------------------------------------

const GTIN_SHAPE = /^[0-9]{8,14}$/
const SCOPED_SCHEMES: ReadonlySet<string> = new Set(['manufacturer_sku', 'custom'])
const PRODUCT_SCHEMES: ReadonlySet<string> = new Set([
  'gtin',
  'manufacturer_sku',
  'dina_subject',
  'custom',
])
const REGION_SCHEMES: ReadonlySet<string> = new Set([
  'country',
  'admin_area',
  'postal_area',
  'geohash',
  'custom',
])

/**
 * A §9.3 ProductRef.
 *
 * THE ISSUER BINDING IS THE POINT, not a formality: an identifier is a signed
 * assertion by its issuer, so `manufacturer_sku` and `custom` REQUIRE
 * `issuer_did`. Without it, two suppliers' SKU "A-1" collide into one product
 * key, and a buyer quoted for one can be shipped the other.
 */
export function validateProductRef(value: unknown, path: string): string | null {
  if (!isRecord(value)) return path
  if (typeof value.scheme !== 'string' || !PRODUCT_SCHEMES.has(value.scheme)) {
    return `${path}.scheme`
  }
  if (typeof value.value !== 'string' || value.value.length === 0) return `${path}.value`
  if (value.value.length > MAX_PRODUCT_VALUE_LENGTH) return `${path}.value`
  if (value.scheme === 'gtin' && !GTIN_SHAPE.test(value.value)) return `${path}.value`
  if (SCOPED_SCHEMES.has(value.scheme)) {
    if (validateDid(value.issuer_did, `${path}.issuer_did`) !== null) return `${path}.issuer_did`
  } else if (value.issuer_did !== undefined) {
    if (validateDid(value.issuer_did, `${path}.issuer_did`) !== null) return `${path}.issuer_did`
  }
  if (value.variant_digest !== undefined) {
    if (validateHex64(value.variant_digest, `${path}.variant_digest`) !== null) {
      return `${path}.variant_digest`
    }
  }
  return null
}

export function validateRegionRef(value: unknown, path: string): string | null {
  if (!isRecord(value)) return path
  if (typeof value.scheme !== 'string' || !REGION_SCHEMES.has(value.scheme)) {
    return `${path}.scheme`
  }
  if (typeof value.value !== 'string' || value.value.length === 0) return `${path}.value`
  if (value.value.length > MAX_REGION_VALUE_LENGTH) return `${path}.value`
  if (value.scheme === 'custom') {
    if (validateDid(value.issuer_did, `${path}.issuer_did`) !== null) return `${path}.issuer_did`
  } else if (value.issuer_did !== undefined) {
    if (validateDid(value.issuer_did, `${path}.issuer_did`) !== null) return `${path}.issuer_did`
  }
  return null
}

// ---------------------------------------------------------------------------
// Relationship vocabulary (§10.3)
// ---------------------------------------------------------------------------

/**
 * §10.3's closed vocabulary, in the protocol's own order.
 *
 * Guarded by the parity vectors, because the previous hand-written copy of this
 * list shared only two of seven entries with the protocol and nothing noticed.
 */
export const RELATIONSHIP_VOCABULARY: readonly string[] = [
  'manufactured_by',
  'marketed_under',
  'variant_of',
  'packaging_variant_of',
  'same_formulation_as',
  'replaces',
  'sold_by',
]

const RELATIONSHIP_SET: ReadonlySet<string> = new Set(RELATIONSHIP_VOCABULARY)

/** Relationships whose object is an operator DID rather than a product. */
const OPERATOR_RELATIONSHIPS: ReadonlySet<string> = new Set([
  'manufactured_by',
  'marketed_under',
  'sold_by',
])

export function isRelationship(value: unknown): boolean {
  return typeof value === 'string' && RELATIONSHIP_SET.has(value)
}

export function relationshipTakesOperator(relationship: string): boolean {
  return OPERATOR_RELATIONSHIPS.has(relationship)
}

// ---------------------------------------------------------------------------
// Relationship claims (§9.4 / §10.7)
// ---------------------------------------------------------------------------

const MAX_EVIDENCE_REFS = 20
const MAX_EVIDENCE_REF_LENGTH = 512

/**
 * A §10.7 relationship claim, checked to the protocol's rules.
 *
 * THE DISCRIMINANT RUNS IN BOTH DIRECTIONS. Checking only "a DID object needs a
 * DID relationship" leaves the inverse open, and `manufactured_by` with a
 * ProductRef object then asserts that a product is manufactured BY ANOTHER
 * PRODUCT — an edge that means nothing, composing manufacturer standing along
 * it. The protocol states both directions; so does this.
 */
export function validateRelationshipClaim(value: unknown): string | null {
  if (!isRecord(value)) return 'claim'
  const claimId = validateId(value.claim_id, 'claim.claim_id')
  if (claimId !== null) return claimId
  const subject = validateProductRef(value.subject, 'claim.subject')
  if (subject !== null) return subject
  const issuer = validateDid(value.issuer_did, 'claim.issuer_did')
  if (issuer !== null) return issuer

  if (!isRelationship(value.relationship)) return 'claim.relationship'
  const relationship = value.relationship as string

  if (!isRecord(value.object)) return 'claim.object'
  const objectIsDid = typeof value.object.did === 'string'
  if (objectIsDid) {
    if (!relationshipTakesOperator(relationship)) return 'claim.object'
    const did = validateDid(value.object.did, 'claim.object.did')
    if (did !== null) return did
  } else {
    if (relationshipTakesOperator(relationship)) return 'claim.object'
    const ref = validateProductRef(value.object, 'claim.object')
    if (ref !== null) return ref
  }

  if (value.effective_from !== undefined) {
    const err = validateIsoUtc(value.effective_from, 'claim.effective_from')
    if (err !== null) return err
  }
  if (value.effective_until !== undefined) {
    const err = validateIsoUtc(value.effective_until, 'claim.effective_until')
    if (err !== null) return err
    if (
      value.effective_from !== undefined &&
      isoUtcMillis(value.effective_until as string) <=
        isoUtcMillis(value.effective_from as string)
    ) {
      return 'claim.effective_until'
    }
  }
  if (value.evidence_refs !== undefined) {
    if (!Array.isArray(value.evidence_refs) || value.evidence_refs.length > MAX_EVIDENCE_REFS) {
      return 'claim.evidence_refs'
    }
    for (const [i, ref] of value.evidence_refs.entries()) {
      if (typeof ref !== 'string' || ref.length === 0 || ref.length > MAX_EVIDENCE_REF_LENGTH) {
        return `claim.evidence_refs[${String(i)}]`
      }
    }
  }
  if (value.confidence_bp !== undefined) {
    // Consumed by `claimConfidenceBp` and stored in a pg int4 column. An
    // unchecked number here either skews a standing threshold or raises
    // "out of range" from the INSERT — a throw in the ingest lane.
    if (
      typeof value.confidence_bp !== 'number' ||
      !Number.isInteger(value.confidence_bp) ||
      value.confidence_bp < 0 ||
      value.confidence_bp > 10_000
    ) {
      return 'claim.confidence_bp'
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Catalog items (§9.5)
// ---------------------------------------------------------------------------

const MAX_CATALOG_NAME_LENGTH = 200
const MAX_CATALOG_DESCRIPTION_LENGTH = 2000
const MAX_CATALOG_CATEGORY_IDS = 10
const MAX_CATALOG_REGIONS = 50
const MAX_CATALOG_IDENTIFIERS = 10
const MAX_CATALOG_ATTRIBUTES = 40
const MAX_ATTRIBUTE_KEY_LENGTH = 64
const MAX_ATTRIBUTE_VALUE_LENGTH = 200
const MAX_MONEY_MINOR_UNIT_DIGITS = 15
const CANONICAL_INTEGER = /^(0|[1-9][0-9]*)$/
const CURRENCY_SHAPE = /^[A-Z]{3}$/

/**
 * §9.2 — the CLOSED unit vocabulary, ported after all.
 *
 * An earlier pass declared `pack` internals &ldquo;protocol-only&rdquo; because
 * AppView neither projects nor searches them, and drew a boundary in the parity
 * vectors to match. Codex mutation-tested the two implementations against each
 * other and found five branches where they disagree — and the boundary
 * explained none of them, because `relationship_claim_refs`, `minimum_order`
 * and a null `indicative_price` have nothing to do with packs.
 *
 * THE LESSON IS ABOUT THE GATE, not the units. A parity gate only covers the
 * cases it exercises, and I chose those cases from the same understanding that
 * wrote the divergent copy. Divergence is worse than either rule alone: AppView
 * indexed publications every conforming consumer refuses, which is an
 * interoperability failure that looks like a working index.
 */
const CANONICAL_DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/
const MAX_QUANTITY_INTEGER_DIGITS = 12
const MAX_UNITS_PER_PACK_DIGITS = 6
const MAX_RELATIONSHIP_CLAIM_REFS = 20

/** Unit code to maximum fraction digits. Anything absent is not a v1 unit. */
const UNIT_SCALE: ReadonlyMap<string, number> = new Map([
  ['each', 0],
  ['case', 0],
  ['pallet', 0],
  ['g', 0],
  ['kg', 3],
  ['ml', 0],
  ['l', 3],
])

function validateCanonicalDecimal(value: unknown, maxIntegerDigits: number, maxScale: number): boolean {
  if (typeof value !== 'string' || value.length === 0) return false
  if (!CANONICAL_DECIMAL.test(value)) return false
  const [intPart, fracPart = ''] = value.split('.')
  if ((intPart as string).length > maxIntegerDigits) return false
  if (fracPart.length > maxScale) return false
  return true
}

/** A §9.2 Quantity. `requirePositive` rejects an exact zero. */
export function validateQuantity(
  value: unknown,
  path: string,
  requirePositive = false,
): string | null {
  if (!isRecord(value)) return path
  if (typeof value.unit_code !== 'string') return `${path}.unit_code`
  const scale = UNIT_SCALE.get(value.unit_code)
  if (scale === undefined) return `${path}.unit_code`
  if (!validateCanonicalDecimal(value.value, MAX_QUANTITY_INTEGER_DIGITS, scale)) {
    return `${path}.value`
  }
  if (requirePositive && /^0(\.0*)?$/.test(value.value as string)) return `${path}.value`
  return null
}

/** A canonical POSITIVE integer string, digit-bounded. */
function validateCanonicalPositiveInteger(value: unknown, maxDigits: number): boolean {
  if (typeof value !== 'string' || !CANONICAL_INTEGER.test(value)) return false
  if (value.length > maxDigits) return false
  return value !== '0'
}

export function validateMoney(value: unknown, path: string): string | null {
  if (!isRecord(value)) return path
  if (typeof value.currency !== 'string' || !CURRENCY_SHAPE.test(value.currency)) {
    return `${path}.currency`
  }
  // `minor_units` is a canonical INTEGER STRING, never a JSON number: a number
  // loses exactness past 2^53 and its spelling is not canonical, and this value
  // is digest-covered.
  if (typeof value.minor_units !== 'string') return `${path}.minor_units`
  if (!CANONICAL_INTEGER.test(value.minor_units)) return `${path}.minor_units`
  if (value.minor_units.length > MAX_MONEY_MINOR_UNIT_DIGITS) return `${path}.minor_units`
  return null
}

/**
 * A §9.5 catalog item, to the rules the protocol states.
 *
 * WHAT THIS REPLACES. `items` was `z.array(z.unknown())` and the projection
 * checked a handful of shallow types, so an item with an arbitrary product
 * scheme, an arbitrary region scheme, an object where a category id belongs, an
 * invalid timestamp and no `pack` was indexed — and the object category reached
 * a searchable column as the string "[object Object]".
 */
export function validateCatalogItem(value: unknown): string | null {
  if (!isRecord(value)) return 'item'
  const product = validateProductRef(value.product, 'item.product')
  if (product !== null) return product
  const supplier = validateDid(value.supplier_did, 'item.supplier_did')
  if (supplier !== null) return supplier
  const catalogId = validateId(value.catalog_id, 'item.catalog_id')
  if (catalogId !== null) return catalogId
  const revision = validateId(value.item_revision, 'item.item_revision')
  if (revision !== null) return revision

  if (
    typeof value.name !== 'string' ||
    value.name.length === 0 ||
    value.name.length > MAX_CATALOG_NAME_LENGTH
  ) {
    return 'item.name'
  }
  if (
    value.brand !== undefined &&
    (typeof value.brand !== 'string' ||
      value.brand.length === 0 ||
      value.brand.length > MAX_CATALOG_NAME_LENGTH)
  ) {
    return 'item.brand'
  }
  if (
    value.description !== undefined &&
    (typeof value.description !== 'string' ||
      value.description.length > MAX_CATALOG_DESCRIPTION_LENGTH)
  ) {
    return 'item.description'
  }
  for (const field of ['family_ref', 'formulation_ref'] as const) {
    if (value[field] !== undefined) {
      const err = validateProductRef(value[field], `item.${field}`)
      if (err !== null) return err
    }
  }

  if (
    !Array.isArray(value.category_ids) ||
    value.category_ids.length === 0 ||
    value.category_ids.length > MAX_CATALOG_CATEGORY_IDS
  ) {
    return 'item.category_ids'
  }
  for (const [i, id] of value.category_ids.entries()) {
    const err = validateId(id, `item.category_ids[${String(i)}]`)
    if (err !== null) return err
  }

  if (value.identifiers !== undefined) {
    if (!Array.isArray(value.identifiers) || value.identifiers.length > MAX_CATALOG_IDENTIFIERS) {
      return 'item.identifiers'
    }
    for (const [i, ref] of value.identifiers.entries()) {
      const err = validateProductRef(ref, `item.identifiers[${String(i)}]`)
      if (err !== null) return err
    }
  }

  if (
    !Array.isArray(value.fulfilment_regions) ||
    value.fulfilment_regions.length === 0 ||
    value.fulfilment_regions.length > MAX_CATALOG_REGIONS
  ) {
    return 'item.fulfilment_regions'
  }
  for (const [i, region] of value.fulfilment_regions.entries()) {
    const err = validateRegionRef(region, `item.fulfilment_regions[${String(i)}]`)
    if (err !== null) return err
  }

  if (!isRecord(value.pack)) return 'item.pack'
  const sellUnit = validateQuantity(value.pack.sell_unit, 'item.pack.sell_unit', true)
  if (sellUnit !== null) return sellUnit
  if (value.pack.units_per_pack !== undefined) {
    if (!validateCanonicalPositiveInteger(value.pack.units_per_pack, MAX_UNITS_PER_PACK_DIGITS)) {
      return 'item.pack.units_per_pack'
    }
  }

  if (value.relationship_claim_refs !== undefined) {
    if (
      !Array.isArray(value.relationship_claim_refs) ||
      value.relationship_claim_refs.length > MAX_RELATIONSHIP_CLAIM_REFS
    ) {
      return 'item.relationship_claim_refs'
    }
    for (const [i, ref] of value.relationship_claim_refs.entries()) {
      const err = validateId(ref, `item.relationship_claim_refs[${String(i)}]`)
      if (err !== null) return err
    }
  }

  // `null` IS NOT ABSENT here. An earlier pass treated it as absent, reasoning
  // that null is how JSON spells "no value" — a defensible idea that the
  // protocol does not share: it checks `!== undefined` and then validates, so a
  // null price is refused. Two rules for one field across two implementations
  // is worse than either rule, and the protocol is the authority.
  if (value.indicative_price !== undefined) {
    const err = validateMoney(value.indicative_price, 'item.indicative_price')
    if (err !== null) return err
  }
  if (value.minimum_order !== undefined) {
    const err = validateQuantity(value.minimum_order, 'item.minimum_order', true)
    if (err !== null) return err
  }

  if (!isRecord(value.freshness)) return 'item.freshness'
  const generated = validateIsoUtc(value.freshness.generated_at, 'item.freshness.generated_at')
  if (generated !== null) return generated
  if (value.freshness.valid_until !== undefined) {
    const err = validateIsoUtc(value.freshness.valid_until, 'item.freshness.valid_until')
    if (err !== null) return err
  }

  if (value.attributes !== undefined) {
    if (!isRecord(value.attributes)) return 'item.attributes'
    const entries = Object.entries(value.attributes)
    if (entries.length > MAX_CATALOG_ATTRIBUTES) return 'item.attributes'
    for (const [key, attr] of entries) {
      if (key.length === 0 || key.length > MAX_ATTRIBUTE_KEY_LENGTH) return 'item.attributes'
      if (typeof attr === 'string') {
        if (attr.length > MAX_ATTRIBUTE_VALUE_LENGTH) return 'item.attributes'
      } else if (typeof attr === 'number') {
        if (!Number.isFinite(attr)) return 'item.attributes'
      } else if (typeof attr !== 'boolean') {
        return 'item.attributes'
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Catalog publication records (§10.2)
// ---------------------------------------------------------------------------

const MAX_CATALOG_ID_LENGTH = 128
const MAX_CATALOG_PAGES = 1000
const MAX_CATALOG_PAGE_ITEMS = 500

/**
 * A sequence, as §10.2 defines it AND as the column can hold it.
 *
 * `Number.isSafeInteger` alone was wrong twice: the AppView column is drizzle
 * `integer` (pg int4), so 3000000000 passed and made the INSERT raise "out of
 * range" — an unhandled throw in the lane the gate was added to.
 */
const PG_INT4_MAX = 2_147_483_647
function isSequence(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= PG_INT4_MAX
  )
}

/**
 * A §10.2 catalog SNAPSHOT, to the protocol's rules.
 *
 * The guard this replaces asked only whether fields were non-empty strings, so
 * `supplier_did: "not-a-did"`, a non-canonical `published_at` and a
 * `page_digests` entry that is not hex64 were all admitted — and refused by
 * every conforming consumer. The protocol's own comment names the cost:
 * producer/consumer divergence on a PUBLIC record is the expensive kind,
 * because the supplier believes they published and the buyer sees nothing.
 */
export function validateCatalogSnapshotRecord(value: unknown): string | null {
  if (!isRecord(value)) return 'snapshot'
  const did = validateDid(value.supplier_did, 'snapshot.supplier_did')
  if (did !== null) return did
  const id = validateId(value.catalog_id, 'snapshot.catalog_id')
  if (id !== null) return id
  if ((value.catalog_id as string).length > MAX_CATALOG_ID_LENGTH) return 'snapshot.catalog_id'
  if (!isSequence(value.snapshot_sequence)) return 'snapshot.snapshot_sequence'
  const version = validateProtocolVersionShape(value.protocol_version, 'snapshot.protocol_version')
  if (version !== null) return version
  const published = validateIsoUtc(value.published_at, 'snapshot.published_at')
  if (published !== null) return published
  if (!Array.isArray(value.page_digests)) return 'snapshot.page_digests'
  if (value.page_digests.length > MAX_CATALOG_PAGES) return 'snapshot.page_digests'
  for (const [i, digest] of value.page_digests.entries()) {
    const hex = validateHex64(digest, `snapshot.page_digests[${String(i)}]`)
    if (hex !== null) return hex
  }
  if (
    typeof value.item_count !== 'number' ||
    !Number.isSafeInteger(value.item_count) ||
    value.item_count < 0
  ) {
    return 'snapshot.item_count'
  }
  const root = validateHex64(value.payload_root, 'snapshot.payload_root')
  if (root !== null) return root
  return validateHex64(value.snapshot_digest, 'snapshot.snapshot_digest')
}

/** A §10.2 catalog PAGE, to the protocol's rules. */
export function validateCatalogPageRecord(value: unknown): string | null {
  if (!isRecord(value)) return 'page'
  const id = validateId(value.catalog_id, 'page.catalog_id')
  if (id !== null) return id
  if ((value.catalog_id as string).length > MAX_CATALOG_ID_LENGTH) return 'page.catalog_id'
  if (!isSequence(value.snapshot_sequence)) return 'page.snapshot_sequence'
  if (
    typeof value.page_index !== 'number' ||
    !Number.isSafeInteger(value.page_index) ||
    value.page_index < 0 ||
    value.page_index >= MAX_CATALOG_PAGES
  ) {
    return 'page.page_index'
  }
  if (!Array.isArray(value.items)) return 'page.items'
  if (value.items.length > MAX_CATALOG_PAGE_ITEMS) return 'page.items'
  if (typeof value.page_digest !== 'string' || value.page_digest === '') return 'page.page_digest'
  return null
}

/**
 * A §10.2 catalog POINTER, to the protocol's rules INCLUDING the ones that
 * live between fields.
 *
 * Field-by-field checking cannot see a coherence rule. A live pointer carrying
 * `snapshot_digest` and no `snapshot_rkey` passed every individual check and is
 * refused by the protocol, and the handler then invented an rkey from the
 * digest — substituting this producer's convention for what the supplier
 * published. Genesis coherence is the same shape of rule: sequence 1 has no
 * predecessor to name.
 */
export function validateCatalogPointerRecord(value: unknown): string | null {
  if (!isRecord(value)) return 'pointer'
  const did = validateDid(value.supplier_did, 'pointer.supplier_did')
  if (did !== null) return did
  const id = validateId(value.catalog_id, 'pointer.catalog_id')
  if (id !== null) return id
  if ((value.catalog_id as string).length > MAX_CATALOG_ID_LENGTH) return 'pointer.catalog_id'
  if (!isSequence(value.snapshot_sequence)) return 'pointer.snapshot_sequence'
  const version = validateProtocolVersionShape(value.protocol_version, 'pointer.protocol_version')
  if (version !== null) return version
  const published = validateIsoUtc(value.published_at, 'pointer.published_at')
  if (published !== null) return published
  if (value.withdrawn !== undefined && typeof value.withdrawn !== 'boolean') {
    return 'pointer.withdrawn'
  }
  if (value.snapshot_sequence === 1 && value.previous_snapshot_digest !== undefined) {
    return 'pointer.previous_snapshot_digest'
  }
  if (value.previous_snapshot_digest !== undefined) {
    const prev = validateHex64(value.previous_snapshot_digest, 'pointer.previous_snapshot_digest')
    if (prev !== null) return prev
  }
  if (value.service_rkey !== undefined) {
    const listing = validateId(value.service_rkey, 'pointer.service_rkey')
    if (listing !== null) return listing
  }
  if (value.withdrawn === true) {
    return value.snapshot_rkey !== undefined || value.snapshot_digest !== undefined
      ? 'pointer.withdrawn'
      : null
  }
  const rkey = validateId(value.snapshot_rkey, 'pointer.snapshot_rkey')
  if (rkey !== null) return rkey
  return validateHex64(value.snapshot_digest, 'pointer.snapshot_digest')
}
