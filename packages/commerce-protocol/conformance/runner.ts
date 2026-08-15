/**
 * §25.1 — the conformance runner a THIRD-PARTY pack runs against its own code.
 *
 * WHAT WAS MISSING. `conformance/vectors/` held ten frozen files and
 * `generate.ts` produced them, and there was no way for anyone to EXECUTE
 * them. A vector nobody can run is documentation: our own port into the
 * AppView had to hand-write assertions against `catalog.json`, and a third
 * party writing a pack in Go or Rust had nothing to point at but the JSON.
 *
 * So the vectors get a runner, and the runner takes the implementation as an
 * ARGUMENT. That is the whole design constraint: a conforming implementation
 * cannot import `@dina/commerce-protocol` — it may not even be TypeScript —
 * so the kit must describe the functions it needs and judge whatever it is
 * given. Ours is then just one caller among the eventual several, which is
 * also what stops the kit quietly testing itself.
 *
 * WHY EVERY CASE IS NAMED IN THE REPORT rather than counted. An implementer
 * fixing a port needs to know WHICH case disagreed and what it expected; a
 * suite that answers "3 failures" sends them back to the JSON to guess.
 *
 * HONEST COVERAGE. All ten vector families are wired here as of 2026-08-10 —
 * `arithmetic`, `digests`, `units`, `quantity`, `product`, `relationship`,
 * `search_candidate`, `schema_evolution`, `catalog` and `malformed`. Anything
 * this runner does NOT execute is still named in the report rather than
 * silently skipped, because a runner reporting a clean pass over a subset it
 * never named would certify more than it checked, and the next family added to
 * `vectors/` arrives unwired.
 *
 * WHAT `malformed` COST TO WIRE, recorded because it is the general lesson.
 * Its `quote`, `status` and `held_evidence` cases are MUTATIONS — "set
 * `total.minor_units` to 1 and expect a refusal" — and the vector carried no
 * record to set it on. Our own suite built one with `makeSignedQuote()`, so
 * the family was executable by exactly one implementation: ours. A frozen
 * vector only a single implementation can run is not a contract, it is a
 * fixture, and the half a second port could not reach was the half deciding
 * whether a TAMPERED QUOTE is caught. The fix was to emit the base records
 * into the vector, additively.
 */

/**
 * What a conforming implementation must supply.
 *
 * Every member is OPTIONAL. An implementation that does not claim a family
 * omits its function and the runner reports those cases as `skipped` with the
 * reason — a partial claim stated plainly beats a partial claim disguised as
 * a pass.
 */
export interface ConformanceImplementation {
  /** §9.1 — one line's subtotal, in integer minor units, as a decimal string. */
  lineSubtotalMinorUnits?: (args: {
    unitPrice: { currency: string; minorUnits: string };
    quantity: { value: string; unitCode: string };
    priceBasis: { value: string; unitCode: string };
  }) => string;

  /** §9.1 — line subtotals plus charges, in integer minor units. */
  orderTotalMinorUnits?: (args: {
    currency: string;
    lineSubtotals: string[];
    charges: { amount: { currency: string; minorUnits: string }; operation: string }[];
  }) => string;

  /** §9.12 — a domain-separated record digest, lowercase hex. */
  recordDigest?: (domain: string, record: unknown) => string;

  /**
   * §9.3 — validate a product reference. Null when valid, else the reason.
   *
   * The refusal STRING is part of the contract and not decoration: two
   * implementations that refuse the same record for reasons an operator reads
   * differently have made one incident look like two.
   */
  validateProduct?: (product: unknown) => string | null;

  /**
   * §9.4 — are these the same product?
   *
   * The question a marketplace exists to answer, and the one where a wrong
   * answer merges two suppliers' goods. A variant digest that differs makes
   * two refs NOT equal even when the identifier matches, because a substitute
   * is not the thing that was ordered.
   */
  productsEqual?: (a: unknown, b: unknown) => boolean;

  /** §9.2 — the closed unit vocabulary. Null for a code v1 does not define. */
  unitDef?: (code: string) => { dimension: string; scale: number; baseFactor: string } | null;

  /**
   * §9.2 — compare two quantities.
   *
   * Returns -1/0/1 when comparable, or a REFUSAL when they are not. A boolean
   * would collapse "smaller" and "not comparable", which is the confusion the
   * closed vocabulary exists to prevent.
   */
  compareQuantities?: (
    a: { unitCode: string; value: string },
    b: { unitCode: string; value: string },
  ) => -1 | 0 | 1 | { refused: true };

  /**
   * §10.3 — validate a product relationship claim. Null when valid.
   *
   * The claim is what lets a buyer ask about a brand and reach a
   * manufacturer's goods, so its refusals matter as much as its acceptances:
   * a port that accepted `manufactured_by` pointing at a PRODUCT rather than
   * an operator would build a graph whose edges mean two different things.
   */
  validateRelationshipClaim?: (claim: unknown) => string | null;

  /**
   * §10.5 — validate a search candidate, as an index EMITS it.
   *
   * The first vector written for a consumer rather than a publisher. A buyer's
   * node reads these from indexes it does not run, so the shape is the only
   * thing standing between a stranger's projection and a buyer's screen.
   */
  validateSearchCandidate?: (candidate: unknown) => string | null;

  /**
   * §9.13 — may this implementation parse a document of this version?
   *
   * Null to admit. Otherwise the TYPED refusal, because §9.13 forbids
   * best-effort parsing across a major: a receiver says what it supports
   * rather than guessing at fields it has never seen.
   *
   * camelCase here and snake_case on the wire, the same split `unitDef` already
   * makes — the kit describes what a port must ANSWER, never how it spells its
   * own fields.
   */
  admitVersion?: (version: string) => {
    code: string;
    requestedVersion: string;
    supportedVersions: string[];
  } | null;

  /** §9.13 — is this a well-formed `MAJOR.MINOR`? Null when it is. */
  validateVersionShape?: (value: unknown) => string | null;

  /** §9.1 — validate a Money. Null when valid, else the reason. */
  validateMoney?: (money: unknown) => string | null;

  /** §9.2 — validate a Quantity. Null when valid, else the reason. */
  validateQuantity?: (quantity: unknown) => string | null;

  /**
   * §9.6 — validate a signed quote, INCLUDING its arithmetic and digests.
   *
   * The rule a tampered quote has to meet: a supplier's stated total must
   * equal the §9.1 recomputation over its own lines. A port that checked the
   * signature and trusted the numbers underneath it would have verified that
   * the supplier really sent the document, and nothing at all about whether
   * the document adds up.
   */
  validateSignedQuote?: (quote: unknown) => string | null;

  /** §9.10 — validate an order status record. */
  validateOrderStatus?: (status: unknown) => string | null;

  /** §12.7/§16.2 — validate a reconcile request, incl. its held evidence. */
  validateReconcileRequest?: (request: unknown) => string | null;

  /**
   * §10.2 — a catalog page's digest, lowercase hex.
   *
   * SEPARATE FROM `recordDigest` on purpose: a page digest covers the ITEMS in
   * a page and a snapshot digest covers the page digests, so a port that
   * conflated them would compute a stable-looking value that no other node
   * could reproduce.
   */
  catalogPageDigest?: (page: unknown) => string;

  /** §10.2 — the payload root over an ordered list of page digests. */
  catalogPayloadRoot?: (pageDigests: string[]) => string;

  /** §10.2 — a snapshot's digest, lowercase hex. */
  catalogSnapshotDigest?: (snapshot: unknown) => string;

  /**
   * §10.2 — may `next` follow `previous` in the pointer chain? Null when it
   * may, else the reason. `previous` is null for a genesis pointer.
   *
   * THE PART A PORT GETS WRONG QUIETLY. A gap and a rollback are publication
   * FAULTS, not warnings: an index that applied sequence 3 after sequence 1
   * would be serving a catalog no supplier ever published, assembled from two
   * that they did.
   */
  verifyCatalogAdvance?: (previous: unknown, next: unknown) => string | null;

  /**
   * §12.7/§16.2 — is this held evidence GENUINE?
   *
   * The one hook in this kit that needs real cryptography, and it exists
   * because the family beside it could be passed without any. Held evidence is
   * what makes a supplier's later `never_received` illegal, so an
   * implementation that cannot tell a real signature from a plausible one has
   * a recovery path drivable by forged evidence — and the structural family
   * certified exactly that, since its own "valid" base carried half an Ed25519
   * signature over an envelope binding no record.
   *
   * TWO things must hold, and checking either alone is not enough:
   *
   *   1. the signature verifies as Ed25519 by `signerPublicKeyHex` over the
   *      canonical bytes of `envelope`; and
   *   2. the envelope BINDS the record — its `record_digest` is the record's
   *      own digest, so evidence cannot be re-pointed at a different record
   *      while keeping a signature that still verifies.
   *
   * Return true only when both hold. Return false, never throw, on anything
   * malformed: a throw is indistinguishable from a crash to the caller.
   */
  /**
   * §9.13 — the canonical bytes of a record AFTER it has been PARSED.
   *
   * `canonicalJson` alone cannot catch the defect this exists for. A port can
   * have a byte-perfect canonicalizer and still lose an unknown field, because
   * the loss happens EARLIER: a schema parser that drops keys it does not name
   * hands the canonicalizer an already-shortened record. AppView shipped
   * exactly that — Zod's `z.object()` stripped additive fields at every depth,
   * so a supplier on a newer minor became permanently unindexable while every
   * canonicalization test passed.
   *
   * So the hook must compose the two steps the implementation really performs:
   * parse the record the way production does, then canonicalize the result. A
   * port that strips fails here while `canonicalJson` still passes.
   *
   * `kind` NAMES THE RECORD, and it is not decoration. Without it a port has to
   * guess which parser to apply and will reach for a generic one — which is
   * exactly how the first version of this family ended up unable to detect the
   * defect it exists for. The kinds are `catalog_pointer`, `catalog_snapshot`,
   * `catalog_page`, `relationship_claim`, `signed_quote`, `purchase_order`,
   * `order_acknowledgement` and `order_status` — every DIGEST-BOUND record,
   * because a parser that strips an additive field before hashing signs a
   * document nobody sent, and that is true of a quote exactly as it is of a
   * catalog page.
   *
   * `generic` appears only in the flat family below, whose inputs are
   * synthetic JSON rather than records: that family checks CANONICALISATION,
   * and the named cases above are what check PARSING.
   */
  parseThenCanonicalJson?: (kind: string, value: unknown) => string;

  verifyHeldEvidence?: (args: {
    record: unknown;
    envelope: unknown;
    signature: string;
    signerPublicKeyHex: string;
  }) => boolean;

  /**
   * §9.12 — the canonical bytes of a record.
   *
   * Wired here for the FORWARD-COMPATIBILITY law rather than for digests: an
   * unknown field must change the bytes. A port that dropped fields it did not
   * recognise before canonicalising would compute a digest over a document
   * nobody sent, and would then verify a signature over something the signer
   * never signed.
   */
  canonicalJson?: (value: unknown) => string;
}

export type CaseStatus = 'pass' | 'fail' | 'skipped';

export interface CaseResult {
  family: string;
  name: string;
  status: CaseStatus;
  /** Present on a failure or a skip. Says what to do about it. */
  detail?: string;
}

export interface ConformanceReport {
  passed: number;
  failed: number;
  skipped: number;
  /** Families that actually ran. Stated beside the verdict, never implied. */
  executedFamilies: string[];
  /** Wired families the implementation did not claim. Any entry blocks `ok`. */
  skippedFamilies: string[];
  /**
   * Vector families the CALLER did not supply. Any entry blocks `ok`.
   *
   * Distinct from `skippedFamilies`: one is an implementation declining to
   * claim a rule, the other is a runner that was never handed the rule to
   * check. Both end in "not verified", and an operator fixes them in
   * completely different places.
   */
  missingVectorFamilies: string[];
  /** Vector families this runner does not yet execute. Named, never implied. */
  unwiredFamilies: string[];
  cases: CaseResult[];
  ok: boolean;
}

/** The vector files this runner knows how to execute. */
export interface WiredVectors {
  arithmetic?: unknown;
  digests?: unknown;
  units?: unknown;
  quantity?: unknown;
  product?: unknown;
  relationship?: unknown;
  search_candidate?: unknown;
  schema_evolution?: unknown;
  catalog?: unknown;
  malformed?: unknown;
  held_signed?: unknown;
  nested_unknown?: unknown;
}

/**
 * Vector families this runner does not execute.
 *
 * EMPTY as of 2026-08-10, and kept rather than deleted: it is the mechanism
 * that makes partial coverage legible, and the next family added to
 * `vectors/` arrives unwired.
 */
export const UNWIRED_FAMILIES: readonly string[] = [];

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Run every wired vector against an implementation.
 *
 * PURE, and takes the vectors as data rather than reading files, so the same
 * runner serves a Node test, a browser page and a CI job that fetched the
 * JSON from a release artefact.
 */
/**
 * Every family this runner executes. A caller must supply all of them.
 *
 * EXPORTED so the one list lives in one place. It was pinned by hand in three
 * separate test expectations, which meant wiring a family meant editing three
 * assertions that had nothing to do with the family — and an assertion updated
 * mechanically to make a suite green is an assertion nobody is reading. The
 * contract is pinned once, in the test that exists to pin it.
 */
/**
 * Every CASE family this runner executes, dotted.
 *
 * The unit of coverage. `REQUIRED_VECTOR_FAMILIES` below stays as the list a
 * CALLER must supply files for; this is what must actually have RUN.
 */
export const REQUIRED_CASE_FAMILIES = [
  'arithmetic.line_subtotals',
  'arithmetic.totals',
  'digests.records',
  'digests.domain_separation',
  'units.defined',
  'units.rejected',
  'quantity.comparisons',
  'quantity.rejected',
  'product.equality',
  'product.rejected',
  'product.scoped',
  'relationship.claims',
  'search_candidate.valid',
  'search_candidate.invalid',
  'schema_evolution.version_admission',
  'schema_evolution.version_shape',
  'schema_evolution.unknown_fields',
  'schema_evolution.parse_round_trip',
  'schema_evolution.nested_unknown',
  'schema_evolution.unknown_field_tolerance',
  'catalog.page_digests',
  'catalog.payload_root',
  'catalog.snapshot_digest',
  'catalog.chain',
  'malformed.money',
  'malformed.quantity',
  'malformed.line_subtotal',
  'malformed.quote',
  'malformed.status',
  'malformed.held_evidence',
  'held_signed.evidence',
] as const;

export const REQUIRED_VECTOR_FAMILIES = [
  'arithmetic',
  'digests',
  'units',
  'quantity',
  'product',
  'relationship',
  'search_candidate',
  'schema_evolution',
  'catalog',
  'malformed',
  'held_signed',
  'nested_unknown',
] as const;

export function runConformance(
  impl: ConformanceImplementation,
  vectors: WiredVectors,
): ConformanceReport {
  const cases: CaseResult[] = [];

  // NEW-8 — "DID NOT CLAIM" AND "WAS NOT ASKED" ARE DIFFERENT HOLES, and the
  // DR-6 fix only closed the first. Every member of `WiredVectors` is
  // optional, and `skipFamily(family, 0, …)` pushes no cases — so a caller
  // arriving with a truncated vectors object produced no skipped cases, no
  // entry in `skippedFamilies`, and `ok: true` over whatever happened to be
  // present. `runConformance(fullImpl, { units })` certified an implementation
  // having checked neither the money arithmetic nor the digest domains.
  //
  // This is the caller the module was designed for: the vectors are taken as
  // DATA precisely so a CI job can fetch the JSON from a release artefact, and
  // that is exactly the caller who can arrive with an incomplete set.
  //
  // THIRD ITERATION OF ONE HOLE (NEW-14), so this now measures COVERAGE rather
  // than a proxy for it. Keying on the family KEY being present let
  // `{arithmetic: full, digests: {}, units: {}, quantity: {}}` through: no
  // missing families, no skipped families, `passed > 0`, `ok: true`, having
  // checked only the arithmetic. A partially generated artefact is exactly
  // that shape, and the artefact-fetching CI job is the caller this module
  // says it is designed for. The check below is therefore made against
  // `executedFamilies` at the end, where "did any case actually run" is a fact
  // rather than an inference.


  const record = (family: string, name: string, expected: unknown, actual: unknown): void => {
    if (expected === actual) {
      cases.push({ family, name, status: 'pass' });
      return;
    }
    cases.push({
      family,
      name,
      status: 'fail',
      detail: `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    });
  };

  const skipFamily = (family: string, count: number, why: string): void => {
    for (let i = 0; i < count; i += 1) {
      cases.push({ family, name: `case ${String(i + 1)}`, status: 'skipped', detail: why });
    }
  };

  // --- §9.1 arithmetic -----------------------------------------------------
  const arithmetic = asRecord(vectors.arithmetic);
  const lineCases = asArray(arithmetic.line_subtotals);
  if (impl.lineSubtotalMinorUnits === undefined) {
    skipFamily('arithmetic.line_subtotals', lineCases.length, 'lineSubtotalMinorUnits not supplied');
  } else {
    for (const raw of lineCases) {
      const c = asRecord(raw);
      const price = asRecord(c.unit_price);
      const qty = asRecord(c.quantity);
      const basis = asRecord(c.price_basis);
      let actual: string;
      try {
        actual = impl.lineSubtotalMinorUnits({
          unitPrice: { currency: str(price.currency), minorUnits: str(price.minor_units) },
          quantity: { value: str(qty.value), unitCode: str(qty.unit_code) },
          priceBasis: { value: str(basis.value), unitCode: str(basis.unit_code) },
        });
      } catch (err) {
        actual = `threw: ${err instanceof Error ? err.message : String(err)}`;
      }
      record('arithmetic.line_subtotals', str(c.name), str(c.expected_minor_units), actual);
    }
  }

  const totalCases = asArray(arithmetic.totals);
  if (impl.orderTotalMinorUnits === undefined) {
    skipFamily('arithmetic.totals', totalCases.length, 'orderTotalMinorUnits not supplied');
  } else {
    for (const raw of totalCases) {
      const c = asRecord(raw);
      // A CASE MAY EXPECT A REFUSAL. The vector encodes both shapes in one
      // array: `expected_minor_units` for an answer, `expected_error_contains`
      // for a total the contract forbids (§9.1 — non-negativity is a property
      // of the RESULT, not of the running value). A runner that only handled
      // the positive shape would report the refusal cases as failures against
      // an implementation that got them right, which is what the first version
      // of this runner did.
      const expectsError = str(c.expected_error_contains);
      let actual: string;
      try {
        actual = impl.orderTotalMinorUnits({
          currency: str(c.currency),
          lineSubtotals: asArray(c.line_subtotals).map(str),
          charges: asArray(c.charges).map((ch) => {
            const charge = asRecord(ch);
            const amount = asRecord(charge.amount);
            return {
              amount: { currency: str(amount.currency), minorUnits: str(amount.minor_units) },
              operation: str(charge.operation),
            };
          }),
        });
      } catch (err) {
        actual = `threw: ${err instanceof Error ? err.message : String(err)}`;
      }
      if (expectsError !== '') {
        const refused = actual.startsWith('threw: ') && actual.includes(expectsError);
        record('arithmetic.totals', str(c.name), `refused containing "${expectsError}"`,
          refused ? `refused containing "${expectsError}"` : actual);
      } else {
        record('arithmetic.totals', str(c.name), str(c.expected_minor_units), actual);
      }
    }
  }

  // --- §9.12 digests -------------------------------------------------------
  const digests = asRecord(vectors.digests);
  const digestRecords = asArray(digests.records);
  const separation = asRecord(digests.domain_separation);
  const byDomain = asRecord(separation.expected_by_domain);
  const separationCount = Object.keys(byDomain).length;

  if (impl.recordDigest === undefined) {
    skipFamily('digests.records', digestRecords.length, 'recordDigest not supplied');
    skipFamily('digests.domain_separation', separationCount, 'recordDigest not supplied');
  } else {
    for (const raw of digestRecords) {
      const c = asRecord(raw);
      const domain = str(c.domain);
      const body = asRecord(c.record);
      const field = str(c.digest_field);
      let actual: string;
      try {
        actual = impl.recordDigest(domain, body);
      } catch (err) {
        actual = `threw: ${err instanceof Error ? err.message : String(err)}`;
      }
      record('digests.records', `${domain}/${field}`, str(body[field]), actual);
    }
    // DOMAIN SEPARATION IS THE POINT of this family: one payload must digest
    // differently under every domain, or a record from one lane could be
    // presented as a record from another.
    for (const [domain, expected] of Object.entries(byDomain)) {
      let actual: string;
      try {
        actual = impl.recordDigest(domain, separation.payload);
      } catch (err) {
        actual = `threw: ${err instanceof Error ? err.message : String(err)}`;
      }
      record('digests.domain_separation', domain, expected, actual);
    }
  }

  // --- §9.2 units ----------------------------------------------------------
  const units = asRecord(vectors.units);
  const unitCases = asArray(units.units);
  const rejected = asArray(units.rejected_codes);
  if (impl.unitDef === undefined) {
    skipFamily('units.defined', unitCases.length, 'unitDef not supplied');
    skipFamily('units.rejected', rejected.length, 'unitDef not supplied');
  } else {
    for (const raw of unitCases) {
      const c = asRecord(raw);
      const code = str(c.code);
      const def = impl.unitDef(code);
      record(
        'units.defined',
        code,
        `${str(c.dimension)}/${String(c.scale)}/${str(c.base_factor)}`,
        def === null ? 'null' : `${def.dimension}/${String(def.scale)}/${def.baseFactor}`,
      );
    }
    for (const raw of rejected) {
      // A CLOSED vocabulary means these are refused, not tolerated. `EACH` and
      // `each ` are here because case-folding and trimming are exactly how two
      // implementations come to disagree about a quantity.
      const code = str(raw);
      record('units.rejected', JSON.stringify(code), 'null', impl.unitDef(code) === null ? 'null' : 'defined');
    }
  }

  // --- §9.2 quantity comparison -------------------------------------------
  const quantity = asRecord(vectors.quantity);
  const comparisons = asArray(quantity.comparisons);
  const refusals = asArray(quantity.rejected);
  if (impl.compareQuantities === undefined) {
    skipFamily('quantity.comparisons', comparisons.length, 'compareQuantities not supplied');
    skipFamily('quantity.rejected', refusals.length, 'compareQuantities not supplied');
  } else {
    for (const raw of comparisons) {
      const c = asRecord(raw);
      const a = asRecord(c.a);
      const b = asRecord(c.b);
      let actual: unknown;
      try {
        actual = impl.compareQuantities(
          { unitCode: str(a.unit_code), value: str(a.value) },
          { unitCode: str(b.unit_code), value: str(b.value) },
        );
      } catch (err) {
        actual = `threw: ${err instanceof Error ? err.message : String(err)}`;
      }
      // Same two shapes here: `compare` for an ordering, `error` for a pair
      // the closed vocabulary cannot compare without pack evidence. A refusal
      // is the RIGHT answer for those, and conflating "not comparable" with
      // "equal" is exactly what the vocabulary exists to prevent.
      if (str(c.error) !== '') {
        // `=== true`, NOT `'refused' in actual`. The declared contract is
        // `{refused: true}`, and membership alone accepted `{refused: false}` —
        // an adapter that answers "these ARE comparable" would have passed the
        // case that exists to prove it refuses. A check that cannot distinguish
        // the two answers is not checking the thing it names.
        const refused =
          (typeof actual === 'object' &&
            actual !== null &&
            (actual as { refused?: unknown }).refused === true) ||
          (typeof actual === 'string' && actual.startsWith('threw: '));
        record('quantity.comparisons', str(c.name), 'refused', refused ? 'refused' : JSON.stringify(actual));
      } else {
        record('quantity.comparisons', str(c.name), c.compare, actual);
      }
    }
    for (const raw of refusals) {
      const c = asRecord(raw);
      const q = asRecord(c.quantity);
      let refusedProperly: boolean;
      try {
        const out = impl.compareQuantities(
          { unitCode: str(q.unit_code), value: str(q.value) },
          { unitCode: 'each', value: '1' },
        );
        refusedProperly = typeof out === 'object' && out.refused;
      } catch {
        // A THROW IS ALSO A REFUSAL. An implementation in another language may
        // not have a refusal value; what the vector pins is that it does not
        // return an ordering for a quantity it cannot read.
        refusedProperly = true;
      }
      record('quantity.rejected', str(c.name), true, refusedProperly);
    }
  }

  // --- §9.3 / §9.4 product identity ---------------------------------------
  //
  // THE FAMILY THAT DECIDES WHETHER TWO SUPPLIERS ARE SELLING THE SAME THING.
  // A port that gets the arithmetic right and this wrong prices the correct
  // total for the wrong product, which is a worse failure than a refusal:
  // nothing downstream notices.
  const product = asRecord(vectors.product);
  const equality = asArray(product.equality);
  const variants = asArray(product.variant);
  const productRejected = [...asArray(product.rejected), ...asArray(product.variant_rejected)];
  const scoped = asArray(product.scoped);

  if (impl.productsEqual === undefined) {
    skipFamily('product.equality', equality.length, 'productsEqual not supplied');
    skipFamily('product.variant', variants.length, 'productsEqual not supplied');
  } else {
    for (const raw of [...equality, ...variants]) {
      const c = asRecord(raw);
      let actual: unknown;
      try {
        actual = impl.productsEqual(c.a, c.b);
      } catch (err) {
        actual = `threw: ${err instanceof Error ? err.message : String(err)}`;
      }
      record('product.equality', str(c.name), c.equal, actual);
    }
  }

  if (impl.validateProduct === undefined) {
    skipFamily('product.rejected', productRejected.length, 'validateProduct not supplied');
    skipFamily('product.scoped', scoped.length, 'validateProduct not supplied');
  } else {
    for (const raw of [...productRejected, ...scoped]) {
      const c = asRecord(raw);
      // BOTH HALVES, like every other family here: a `scoped` case may be a
      // legal scoped reference OR a refusal, and a runner that only checked
      // the refusals would tell a correct port it was broken for accepting
      // what the spec accepts.
      const expectsError = str(c.error);
      let actual: unknown;
      try {
        actual = impl.validateProduct(c.product);
      } catch (err) {
        actual = `threw: ${err instanceof Error ? err.message : String(err)}`;
      }
      if (expectsError === '') {
        record('product.scoped', str(c.name), null, actual);
        continue;
      }
      // The refusal STRING, not merely the fact of refusing: two ports that
      // describe one fault differently make one incident look like two in an
      // operator's log, which is why these are frozen.
      record('product.rejected', str(c.name), expectsError, actual);
    }
  }

  /**
   * Run a validator over cases shaped `{name, <subject>, <errorField>}`.
   *
   * THREE FAMILIES BELOW SHARE ONE SHAPE — a validator, a subject, and an
   * expectation that is either "accept" or a frozen refusal string. Writing
   * the loop three times is how the positive half gets forgotten in one of
   * them, which is the exact fault the first version of this runner shipped:
   * only the refusal shape was handled, so every correct port was told it was
   * broken for accepting what the spec accepts.
   */
  const runValidatorCases = (args: {
    family: string;
    cases: unknown[];
    validator: ((subject: unknown) => string | null) | undefined;
    skipReason: string;
    subjectOf: (c: Record<string, unknown>) => unknown;
    expectedOf: (c: Record<string, unknown>) => string;
  }): void => {
    if (args.validator === undefined) {
      skipFamily(args.family, args.cases.length, args.skipReason);
      return;
    }
    for (const raw of args.cases) {
      const c = asRecord(raw);
      const expectsError = args.expectedOf(c);
      let actual: unknown;
      try {
        actual = args.validator(args.subjectOf(c));
      } catch (err) {
        actual = `threw: ${err instanceof Error ? err.message : String(err)}`;
      }
      record(args.family, str(c.name), expectsError === '' ? null : expectsError, actual);
    }
  };

  // --- §10.3 product relationship claims -----------------------------------
  //
  // THE EDGES OF THE PRODUCT GRAPH. A buyer who names a brand reaches a
  // manufacturer's goods across these, so an implementation that admitted a
  // claim whose object is the wrong KIND of thing — `manufactured_by` pointing
  // at a product, `variant_of` pointing at an operator — would build a graph
  // whose edges silently mean two different things, and every traversal after
  // that is arithmetic over a category error.
  const relationship = asRecord(vectors.relationship);
  runValidatorCases({
    family: 'relationship.claims',
    cases: asArray(relationship.claims),
    validator: impl.validateRelationshipClaim,
    skipReason: 'validateRelationshipClaim not supplied',
    subjectOf: (c) => c.claim,
    expectedOf: (c) => str(c.error),
  });

  // --- §10.5 search candidates ---------------------------------------------
  //
  // THE ONE VECTOR WRITTEN FOR A CONSUMER. A buyer's node reads candidates out
  // of indexes it does not run and cannot audit, so this shape is the whole
  // boundary between a stranger's projection and a buyer's screen. The
  // POSITIVE case is as load-bearing as the refusals: a port whose validator
  // refused the frozen candidate would reject every honest index.
  const searchCandidate = asRecord(vectors.search_candidate);
  runValidatorCases({
    family: 'search_candidate.valid',
    cases:
      searchCandidate.candidate === undefined
        ? []
        : [{ name: 'frozen_candidate', value: searchCandidate.candidate }],
    validator: impl.validateSearchCandidate,
    skipReason: 'validateSearchCandidate not supplied',
    subjectOf: (c) => c.value,
    expectedOf: () => '',
  });
  runValidatorCases({
    family: 'search_candidate.invalid',
    cases: asArray(searchCandidate.invalid),
    validator: impl.validateSearchCandidate,
    skipReason: 'validateSearchCandidate not supplied',
    subjectOf: (c) => c.value,
    expectedOf: (c) => str(c.expect),
  });

  // --- §9.13 schema evolution ----------------------------------------------
  const evolution = asRecord(vectors.schema_evolution);

  // ADMISSION IS ASYMMETRIC BY DESIGN: a higher MINOR is parseable because
  // minor is strictly additive, and ANY other major is refused with a typed
  // error naming what this implementation supports. A port that treated
  // "newer" as parseable and "older" as refused would read a 0.9 document as
  // though its fields meant what 1.0 says they mean.
  const admissionCases = asArray(evolution.version_admission);
  if (impl.admitVersion === undefined) {
    skipFamily('schema_evolution.version_admission', admissionCases.length, 'admitVersion not supplied');
  } else {
    for (const raw of admissionCases) {
      const c = asRecord(raw);
      const wanted = c.error === null || c.error === undefined ? null : asRecord(c.error);
      const expected =
        wanted === null
          ? 'admitted'
          : JSON.stringify({
              code: str(wanted.code),
              requested_version: str(wanted.requested_version),
              supported_versions: asArray(wanted.supported_versions).map(str),
            });
      let actual: string;
      try {
        const out = impl.admitVersion(str(c.version));
        actual =
          out === null
            ? 'admitted'
            : JSON.stringify({
                code: out.code,
                requested_version: out.requestedVersion,
                supported_versions: out.supportedVersions,
              });
      } catch (err) {
        actual = `threw: ${err instanceof Error ? err.message : String(err)}`;
      }
      record('schema_evolution.version_admission', str(c.name), expected, actual);
    }
  }

  runValidatorCases({
    family: 'schema_evolution.version_shape',
    cases: asArray(evolution.version_shape),
    validator: impl.validateVersionShape,
    skipReason: 'validateVersionShape not supplied',
    subjectOf: (c) => c.value,
    expectedOf: (c) => str(c.error),
  });

  // THE FORWARD-COMPATIBILITY LAW, and it is a statement about BYTES rather
  // than about tolerance. An unknown field must survive canonicalisation and
  // change the result, because a port that dropped what it did not recognise
  // would digest a document nobody sent — and would then verify a signature
  // over something the signer never signed. The `same_bytes` case is the other
  // half: key ORDER must not change anything, or two honest implementations
  // disagree about a digest over identical content.
  const unknownFieldCases = asArray(evolution.unknown_fields);
  if (impl.canonicalJson === undefined) {
    skipFamily('schema_evolution.unknown_fields', unknownFieldCases.length * 3, 'canonicalJson not supplied');
  } else {
    for (const raw of unknownFieldCases) {
      const c = asRecord(raw);
      const name = str(c.name);
      const bytes = (value: unknown): string => {
        try {
          return (impl.canonicalJson as (v: unknown) => string)(value);
        } catch (err) {
          return `threw: ${err instanceof Error ? err.message : String(err)}`;
        }
      };
      const known = bytes(c.known);
      const withUnknown = bytes(c.with_unknown);
      record('schema_evolution.unknown_fields', `${name}/known`, str(c.known_canonical), known);
      record(
        'schema_evolution.unknown_fields',
        `${name}/with_unknown`,
        str(c.with_unknown_canonical),
        withUnknown,
      );
      record('schema_evolution.unknown_fields', `${name}/same_bytes`, c.same_bytes, known === withUnknown);
    }
  }

  // TOLERANCE HAS A FLOOR. A record carrying a field from a future minor still
  // validates; the same unknown field must NOT rescue a record that is invalid
  // on a field this version does know about. Both halves are here because a
  // port could satisfy either alone — one by refusing everything unfamiliar,
  // the other by validating nothing at all.
  runValidatorCases({
    family: 'schema_evolution.unknown_field_tolerance',
    cases: asArray(evolution.unknown_field_tolerance),
    validator: impl.validateProduct,
    skipReason: 'validateProduct not supplied',
    subjectOf: (c) => c.product,
    expectedOf: (c) => str(c.error),
  });

  // --- §10.2 catalog publication ------------------------------------------
  //
  // THE TWO-LEVEL DIGEST, which a port conflates at its peril. A PAGE digest
  // covers the items in that page; a SNAPSHOT digest covers the page digests
  // through the payload root. A port that hashed the whole catalog once would
  // produce a stable-looking value no other node could reproduce, and the
  // supplier would find their catalog silently unindexable everywhere but at
  // home.
  const catalog = asRecord(vectors.catalog);
  const catalogPages = asArray(catalog.pages);
  const catalogSnapshot = asRecord(catalog.snapshot);
  const hasSnapshot = Object.keys(catalogSnapshot).length > 0;

  if (impl.catalogPageDigest === undefined) {
    skipFamily('catalog.page_digests', catalogPages.length, 'catalogPageDigest not supplied');
  } else {
    for (const raw of catalogPages) {
      const page = asRecord(raw);
      let actual: string;
      try {
        actual = impl.catalogPageDigest(page);
      } catch (err) {
        actual = `threw: ${err instanceof Error ? err.message : String(err)}`;
      }
      record('catalog.page_digests', `page ${str(String(page.page_index))}`, str(page.page_digest), actual);
    }
  }

  if (impl.catalogPayloadRoot === undefined) {
    skipFamily('catalog.payload_root', hasSnapshot ? 1 : 0, 'catalogPayloadRoot not supplied');
  } else if (hasSnapshot) {
    let actual: string;
    try {
      actual = impl.catalogPayloadRoot(asArray(catalogSnapshot.page_digests).map(str));
    } catch (err) {
      actual = `threw: ${err instanceof Error ? err.message : String(err)}`;
    }
    record('catalog.payload_root', 'payload_root over the page digests', str(catalogSnapshot.payload_root), actual);
  }

  if (impl.catalogSnapshotDigest === undefined) {
    skipFamily('catalog.snapshot_digest', hasSnapshot ? 1 : 0, 'catalogSnapshotDigest not supplied');
  } else if (hasSnapshot) {
    let actual: string;
    try {
      actual = impl.catalogSnapshotDigest(catalogSnapshot);
    } catch (err) {
      actual = `threw: ${err instanceof Error ? err.message : String(err)}`;
    }
    record('catalog.snapshot_digest', 'snapshot_digest', str(catalogSnapshot.snapshot_digest), actual);
  }

  // THE CHAIN, and its refusals are the load-bearing half. §10.2 makes a GAP
  // and a ROLLBACK publication FAULTS rather than warnings, because an index
  // that applied sequence 3 straight after sequence 1 would serve a catalog no
  // supplier ever published — assembled out of two that they did, which is the
  // worst kind of wrong: every individual record in it is genuine.
  const chainCases = asArray(catalog.chain_cases);
  if (impl.verifyCatalogAdvance === undefined) {
    skipFamily('catalog.chain', chainCases.length, 'verifyCatalogAdvance not supplied');
  } else {
    for (const raw of chainCases) {
      const c = asRecord(raw);
      const expected = c.expect === null || c.expect === undefined ? null : str(c.expect);
      let actual: unknown;
      try {
        actual = impl.verifyCatalogAdvance(c.previous ?? null, c.next);
      } catch (err) {
        actual = `threw: ${err instanceof Error ? err.message : String(err)}`;
      }
      record('catalog.chain', str(c.name), expected, actual);
    }
  }

  // --- Phase-0 exit: the malformed battery --------------------------------
  //
  // "Independent implementations must REJECT these." Every other family asks
  // whether a port computes the same answer; this one asks whether it refuses
  // the same nonsense, which is the half that decides what a tampered document
  // can do. The expectation here is a SUBSTRING rather than the whole string,
  // because the vector pins WHICH rule fired and leaves a port its own wording
  // for the surrounding detail.
  const malformed = asRecord(vectors.malformed);
  const malformedBase = asRecord(malformed.base);

  const recordRefusal = (family: string, name: string, needle: string, actual: unknown): void => {
    // THE RULE, stated exactly: the refusal REASON must carry the pinned
    // substring, whether the implementation returned it or raised it. A raised
    // message arrives here as `threw: …`, so one `includes` covers both and no
    // separate throw branch is needed.
    //
    // This is DELIBERATELY stricter than `quantity.rejected`, which accepts any
    // throw at all. There the vector pins only that an implementation must not
    // return an ORDERING for something it cannot compare — any refusal answers
    // that. Here the vector pins WHICH rule fired, and a port that refuses a
    // tampered total for the wrong reason has not implemented §9.1's check.
    //
    // An earlier version carried a second `threw` expression that was strictly
    // implied by this one — dead code whose comment claimed the looser quantity
    // allowance applied here. It does not, and saying so mattered more than the
    // branch did.
    const refused = typeof actual === 'string' && actual.includes(needle);
    record(
      family,
      name,
      `refused, mentioning "${needle}"`,
      refused ? `refused, mentioning "${needle}"` : JSON.stringify(actual),
    );
  };

  const refusalCases = (args: {
    family: string;
    cases: unknown[];
    validator: ((subject: unknown) => string | null) | undefined;
    skipReason: string;
    subjectOf: (c: Record<string, unknown>) => unknown;
  }): void => {
    if (args.validator === undefined) {
      skipFamily(args.family, args.cases.length, args.skipReason);
      return;
    }
    for (const raw of args.cases) {
      const c = asRecord(raw);
      let actual: unknown;
      try {
        actual = args.validator(args.subjectOf(c));
      } catch (err) {
        actual = `threw: ${err instanceof Error ? err.message : String(err)}`;
      }
      recordRefusal(args.family, str(c.name), str(c.error_includes), actual);
    }
  };

  refusalCases({
    family: 'malformed.money',
    cases: asArray(malformed.money),
    validator: impl.validateMoney,
    skipReason: 'validateMoney not supplied',
    subjectOf: (c) => c.input,
  });

  refusalCases({
    family: 'malformed.quantity',
    cases: asArray(malformed.quantity),
    validator: impl.validateQuantity,
    skipReason: 'validateQuantity not supplied',
    subjectOf: (c) => c.input,
  });

  // A REFUSAL IS THE RIGHT ANSWER HERE. Both cases price a quantity against a
  // basis in another dimension — 24 `each` against a `case`, a kilogram
  // against a litre — and §9.2 has no conversion without declared pack
  // evidence. A port that guessed a factor would produce a plausible total
  // for a quantity nobody agreed on.
  const subtotalRefusals = asArray(malformed.line_subtotal);
  if (impl.lineSubtotalMinorUnits === undefined) {
    skipFamily('malformed.line_subtotal', subtotalRefusals.length, 'lineSubtotalMinorUnits not supplied');
  } else {
    for (const raw of subtotalRefusals) {
      const c = asRecord(raw);
      const price = asRecord(c.unit_price);
      const qty = asRecord(c.quantity);
      const basis = asRecord(c.price_basis);
      let actual: unknown;
      try {
        actual = impl.lineSubtotalMinorUnits({
          unitPrice: { currency: str(price.currency), minorUnits: str(price.minor_units) },
          quantity: { value: str(qty.value), unitCode: str(qty.unit_code) },
          priceBasis: { value: str(basis.value), unitCode: str(basis.unit_code) },
        });
      } catch (err) {
        actual = `threw: ${err instanceof Error ? err.message : String(err)}`;
      }
      recordRefusal('malformed.line_subtotal', str(c.name), str(c.error_includes), actual);
    }
  }

  /**
   * Apply a `{path, value}` mutation to a copy of a base record.
   *
   * OWNED BY THE KIT rather than left to each port, because a dotted path is
   * exactly the sort of thing two implementations would read differently, and
   * then disagree about a case neither of them got wrong.
   */
  const mutated = (base: unknown, path: string, value: unknown): unknown => {
    const clone = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
    const parts = path.split('.');
    let cursor: Record<string, unknown> = clone;
    for (const part of parts.slice(0, -1)) {
      cursor = cursor[part] as Record<string, unknown>;
    }
    cursor[parts[parts.length - 1] as string] = value;
    return clone;
  };

  const mutationCases = (args: {
    family: string;
    cases: unknown[];
    base: unknown;
    validator: ((subject: unknown) => string | null) | undefined;
    skipReason: string;
  }): void => {
    // NO BASE MEANS NO CASES, and it must not mean a silent pass. A vector
    // file without `base` is one a port cannot execute, and the family then
    // shows up in `missingVectorFamilies` because no case under it RAN — which
    // is the check above, not this skip. An earlier comment here claimed the
    // skip itself produced that entry; it does not, it produces
    // `skippedFamilies`, the bucket meaning "the implementation did not claim
    // this". Naming the wrong bucket sends an operator to fix the wrong side.
    if (args.base === undefined || args.validator === undefined) {
      skipFamily(
        args.family,
        args.cases.length,
        args.base === undefined ? 'no base record in the vector' : args.skipReason,
      );
      return;
    }
    for (const raw of args.cases) {
      const c = asRecord(raw);
      const mutation = asRecord(c.mutate);
      let actual: unknown;
      try {
        actual = args.validator(mutated(args.base, str(mutation.path), mutation.value));
      } catch (err) {
        actual = `threw: ${err instanceof Error ? err.message : String(err)}`;
      }
      recordRefusal(args.family, str(c.name), str(c.error_includes), actual);
    }
  };

  /**
   * THE BASE MUST BE ACCEPTED, or the mutation proves nothing.
   *
   * Every `malformed.*` mutation case says "change this one field and expect a
   * refusal". That only tests the rule if the record is VALID before the
   * change: a port whose validator refuses the base outright would refuse every
   * mutated copy too and pass the whole family for the wrong reason —
   * certifying "refuses something" rather than "refuses THIS and accepts the
   * base". The generator asserts this property in a comment; nothing checked
   * it until a reviewer asked what did.
   */
  const acceptsBase = (family: string, base: unknown, validator?: (v: unknown) => string | null): void => {
    if (validator === undefined || base === undefined) {
      skipFamily(family, base === undefined ? 0 : 1, 'validator not supplied');
      return;
    }
    let actual: unknown;
    try {
      actual = validator(base);
    } catch (err) {
      actual = `threw: ${err instanceof Error ? err.message : String(err)}`;
    }
    record(family, 'unmutated base is VALID', null, actual);
  };

  acceptsBase('malformed.quote', malformedBase.quote, impl.validateSignedQuote);
  acceptsBase('malformed.status', malformedBase.status, impl.validateOrderStatus);
  // THE FAMILY WHERE THIS MATTERS MOST. All five held-evidence refusals pin
  // either "signature" or "lowercase hex", so a port that refuses EVERY piece
  // of held evidence — including a well-formed one — passes all five. That is
  // §12.7/§16.2, the family whose failure makes a recovery path drivable by
  // forged evidence, certified by an implementation that accepts nothing.
  acceptsBase(
    'malformed.held_evidence',
    malformedBase.held_record === undefined || malformedBase.held_signature === undefined
      ? undefined
      : {
          ...asRecord(malformedBase.reconcile_request),
          held_acknowledgement: {
            record: malformedBase.held_record,
            signature: malformedBase.held_signature,
            envelope: malformedBase.held_envelope,
          },
        },
    impl.validateReconcileRequest,
  );

  mutationCases({
    family: 'malformed.quote',
    cases: asArray(malformed.quote),
    base: malformedBase.quote,
    validator: impl.validateSignedQuote,
    skipReason: 'validateSignedQuote not supplied',
  });

  mutationCases({
    family: 'malformed.status',
    cases: asArray(malformed.status),
    base: malformedBase.status,
    validator: impl.validateOrderStatus,
    skipReason: 'validateOrderStatus not supplied',
  });

  // §12.7/§16.2 — HELD EVIDENCE NEEDS A SIGNATURE, and this is the family with
  // the sharpest consequence. A record plus its content digest proves nothing:
  // the digest is a hash of the record, so anyone holding or inventing the
  // record can compute one. An implementation that accepted bare records
  // cannot implement fail-closed re-adoption at all — its recovery path would
  // be drivable by forged evidence.
  const evidenceCases = asArray(malformed.held_evidence);
  const evidenceBase = asRecord(malformedBase.reconcile_request);
  const heldRecord = malformedBase.held_record;
  if (impl.validateReconcileRequest === undefined || heldRecord === undefined) {
    skipFamily(
      'malformed.held_evidence',
      evidenceCases.length,
      heldRecord === undefined
        ? 'no held_record in the vector'
        : 'validateReconcileRequest not supplied',
    );
  } else {
    for (const raw of evidenceCases) {
      const c = asRecord(raw);
      // BUILT ON THE VALID BASE, so the signature is the ONLY defect —
      // the same standard `mutationCases` holds the quote and status to.
      //
      // Without the envelope every refusal case carried TWO defects at once,
      // and `validateHeldEvidenceShape` checks the signature before the
      // envelope, whose own message contains the word "signature". So
      // `bare_record_without_signature` and `empty_signature` both passed
      // against a port that validates only the envelope and never looks at the
      // signature — in the family whose failure makes re-adoption forgeable.
      const evidence =
        c.evidence_omits_signature === true
          ? { record: heldRecord, envelope: malformedBase.held_envelope }
          : {
              record: heldRecord,
              envelope: malformedBase.held_envelope,
              signature: c.signature,
            };
      let actual: unknown;
      try {
        actual = impl.validateReconcileRequest({ ...evidenceBase, held_acknowledgement: evidence });
      } catch (err) {
        actual = `threw: ${err instanceof Error ? err.message : String(err)}`;
      }
      recordRefusal('malformed.held_evidence', str(c.name), str(c.error_includes), actual);
    }
  }

  // -------------------------------------------------------------------------
  // held_signed.evidence — §12.7/§16.2 with REAL signatures
  // -------------------------------------------------------------------------
  //
  // The family beside this one (`malformed.held_evidence`) tests structure, and
  // that is all it can do: its cases are mutations judged by a validator that
  // reads shapes. This family judges CRYPTOGRAPHY, so an implementation that
  // never verifies a supplier's signature — or verifies one but never checks
  // that the envelope names the record it arrived with — fails here even though
  // every structural case passes.
  const heldSigned = asRecord(vectors.held_signed);
  const heldCases = asArray(heldSigned.cases);
  const heldSigner = asRecord(heldSigned.signer);
  const signerPublicKeyHex = str(heldSigner.public_key_hex);
  if (vectors.held_signed === undefined) {
    skipFamily('held_signed.evidence', heldCases.length, 'held_signed vectors not supplied');
  } else if (impl.verifyHeldEvidence === undefined) {
    // NOT a silent pass. An implementation may decline this family, and the
    // report says so — but it may not decline it and still be certified for the
    // recovery rule that prevents duplicate orders.
    skipFamily(
      'held_signed.evidence',
      heldCases.length,
      'verifyHeldEvidence not supplied — held evidence is unverified',
    );
  } else if (heldCases.length === 0 || signerPublicKeyHex === '') {
    skipFamily('held_signed.evidence', 0, 'held_signed vectors carry no cases or no signer key');
  } else {
    for (const raw of heldCases) {
      const c = asRecord(raw);
      const evidence = asRecord(c.evidence);
      let actual: unknown;
      try {
        actual = impl.verifyHeldEvidence({
          record: evidence.record,
          envelope: evidence.envelope,
          signature: str(evidence.signature),
          signerPublicKeyHex,
        });
      } catch (err) {
        // A throw is a FAILURE here, not a refusal. The caller cannot tell a
        // deliberate rejection from a crash, and "it threw" is how a port with
        // no crypto at all would look identical to one that refused.
        actual = `threw: ${err instanceof Error ? err.message : String(err)}`;
      }
      record('held_signed.evidence', str(c.name), c.accepted === true, actual);
    }
  }

  // -------------------------------------------------------------------------
  // schema_evolution.parse_round_trip — the PIPELINE, not the canonicalizer
  // -------------------------------------------------------------------------
  //
  // Same vectors, different question. `unknown_fields` asks "does the
  // canonicalizer include a field it does not know?"; this asks "does the field
  // still EXIST by the time the canonicalizer sees it?" — which is where the
  // real defect lived.
  const evolutionForParse = asRecord(vectors.schema_evolution);
  const parseCases = asArray(evolutionForParse.unknown_fields);
  if (vectors.schema_evolution === undefined) {
    skipFamily('schema_evolution.parse_round_trip', parseCases.length, 'schema_evolution vectors not supplied');
  } else if (impl.parseThenCanonicalJson === undefined) {
    skipFamily(
      'schema_evolution.parse_round_trip',
      parseCases.length,
      'parseThenCanonicalJson not supplied — additive fields are unverified through parsing',
    );
  } else {
    for (const raw of parseCases) {
      const c = asRecord(raw);
      let actual: unknown;
      try {
        actual = impl.parseThenCanonicalJson('generic', c.with_unknown);
      } catch (err) {
        actual = `threw: ${err instanceof Error ? err.message : String(err)}`;
      }
      record(
        'schema_evolution.parse_round_trip',
        `${str(c.name)} — survives parsing`,
        str(c.with_unknown_canonical),
        actual,
      );
    }
  }

  // -------------------------------------------------------------------------
  // schema_evolution.nested_unknown — stripping at EVERY depth
  // -------------------------------------------------------------------------
  //
  // The flat family above can only catch a parser that strips at the TOP level.
  // These cases are real records of a named kind carrying an additive field one,
  // two and three levels down — inside a page, inside an item, inside an item's
  // product reference, inside a claim's subject. A schema that is
  // `.passthrough()` at the root and `z.object()` beneath it passes the flat
  // family and fails here, which is precisely the defect AppView shipped.
  const nested = asRecord(vectors.nested_unknown);
  const nestedCases = asArray(nested.cases);
  if (vectors.nested_unknown === undefined) {
    skipFamily('schema_evolution.nested_unknown', nestedCases.length, 'nested_unknown vectors not supplied');
  } else if (impl.parseThenCanonicalJson === undefined) {
    skipFamily(
      'schema_evolution.nested_unknown',
      nestedCases.length,
      'parseThenCanonicalJson not supplied — nested additive fields are unverified',
    );
  } else {
    for (const raw of nestedCases) {
      const c = asRecord(raw);
      let actual: unknown;
      try {
        actual = impl.parseThenCanonicalJson(str(c.kind), c.record);
      } catch (err) {
        actual = `threw: ${err instanceof Error ? err.message : String(err)}`;
      }
      record(
        'schema_evolution.nested_unknown',
        `${str(c.kind)} — ${str(c.name)}`,
        str(c.canonical),
        actual,
      );
    }
  }

  const passed = cases.filter((c) => c.status === 'pass').length;
  const failed = cases.filter((c) => c.status === 'fail').length;
  const skipped = cases.filter((c) => c.status === 'skipped').length;
  const executedFamilies = [
    ...new Set(cases.filter((c) => c.status !== 'skipped').map((c) => c.family)),
  ].sort();
  const skippedFamilies = [
    ...new Set(cases.filter((c) => c.status === 'skipped').map((c) => c.family)),
  ].sort();
  // EVERY SUB-FAMILY, not one per family. NEW-14's hole one level down, and
  // the third place this same mistake has been fixed.
  //
  // Keying on the dotted PREFIX meant one executed sub-family satisfied the
  // whole family: `{malformed: {money: […]}}` ran `malformed.money`, produced
  // zero cases for `quote`, `status` and `held_evidence` (`asArray` → `[]`,
  // absent base → `skipFamily(f, 0, …)` pushes nothing), and reported
  // `ok: true` — a conformance verdict over an UNCHECKED tampered-quote,
  // tampered-status and forged-held-evidence battery. That is precisely the
  // half this runner was extended to reach, and precisely the caller this
  // module says it is designed for: a CI job fetching a partially generated
  // artefact.
  const missingVectorFamilies = REQUIRED_CASE_FAMILIES.filter(
    (family) => !executedFamilies.includes(family),
  ).map((family) => String(family));
  return {
    passed,
    failed,
    skipped,
    executedFamilies,
    skippedFamilies,
    unwiredFamilies: [...UNWIRED_FAMILIES],
    cases,
    // EVERY WIRED FAMILY MUST HAVE RUN. The first version of this only required
    // zero failures and at least one pass, which let an implementation supplying
    // nothing but `unitDef` report `ok: true` while every money-arithmetic and
    // digest case sat skipped — a conformance verdict over rules that were never
    // checked, on exactly the arithmetic §25.1 exists to pin. "Supplied nothing"
    // was caught; "supplied almost nothing" was not, and the second is the one a
    // pack author would actually reach for.
    missingVectorFamilies,
    ok:
      failed === 0 &&
      passed > 0 &&
      skippedFamilies.length === 0 &&
      missingVectorFamilies.length === 0,
  };
}

/** A short human report — what an implementer reads first. */
export function formatReport(report: ConformanceReport): string {
  const lines = [
    `conformance: ${String(report.passed)} passed, ${String(report.failed)} failed, ${String(report.skipped)} skipped`,
  ];
  for (const c of report.cases) {
    if (c.status === 'pass') continue;
    lines.push(`  ${c.status.toUpperCase()} ${c.family} / ${c.name}${c.detail === undefined ? '' : ` — ${c.detail}`}`);
  }
  // The verdict is only legible beside what it covered.
  lines.push(`  EXECUTED: ${report.executedFamilies.join(', ') || '(none)'}`);
  if (report.skippedFamilies.length > 0) {
    lines.push(`  NOT CLAIMED by this implementation: ${report.skippedFamilies.join(', ')}`);
  }
  if (report.missingVectorFamilies.length > 0) {
    lines.push(`  NOT SUPPLIED to this runner: ${report.missingVectorFamilies.join(', ')}`);
  }
  if (report.unwiredFamilies.length > 0) {
    lines.push(`  NOT EXECUTED by this runner: ${report.unwiredFamilies.join(', ')}`);
  }
  return lines.join('\n');
}
