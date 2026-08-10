/**
 * §25.1 — the conformance runner, driven by OUR implementation (WS-10.5).
 *
 * TWO CLAIMS, and they need each other. That this implementation conforms to
 * the frozen vectors, and that the RUNNER a third party would use actually
 * detects a divergence. A runner nobody has watched fail is a runner that
 * certifies.
 *
 * The adapter below is what a third-party pack author writes: a small shim
 * from their own functions onto the kit's interface. Ours is thin because the
 * vectors were generated from these functions; a port from another language
 * would have a thicker shim and the same shape.
 */

import { createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { sha256 } from '@noble/hashes/sha2.js';

import {
  REQUIRED_CASE_FAMILIES,
  REQUIRED_VECTOR_FAMILIES,
  UNWIRED_FAMILIES,
  formatReport,
  runConformance,
  type ConformanceImplementation,
} from '../conformance/runner';
import { computeLineSubtotal, computeTotal } from '../src/arithmetic';
import { canonicalJson } from '../src/canonical';
import { validateProductRelationshipClaim } from '../src/catalog';
import {
  catalogPageDigest,
  catalogPayloadRoot,
  catalogSnapshotDigest,
  verifyCatalogPointerAdvance,
  type CatalogPointer,
  type CatalogSnapshot,
  type CatalogSnapshotPage,
} from '../src/catalog_publication';
import { checkProtocolVersion, validateProtocolVersionShape } from '../src/common';
import { commerceRecordDigest } from '../src/digests';
import { validateMoney } from '../src/money';
import { productRefsEqual, validateProductRef } from '../src/product';
import { compareQuantities, validateQuantity } from '../src/quantity';
import { validateSignedQuote } from '../src/quote';
import { validateOrderReconcileRequest } from '../src/reconcile';
import { validateCommerceSearchCandidate } from '../src/search';
import { validateCommerceOrderStatus } from '../src/status';
import { unitDef } from '../src/units';

import type { CommerceDigestDomain } from '../src/digests';

const hash = (data: Uint8Array): Uint8Array => sha256(data);

function vector(name: string): unknown {
  return JSON.parse(
    readFileSync(path.join(__dirname, '..', 'conformance', 'vectors', `${name}.json`), 'utf8'),
  );
}

const VECTORS = {
  arithmetic: vector('arithmetic'),
  digests: vector('digests'),
  units: vector('units'),
  quantity: vector('quantity'),
  product: vector('product'),
  relationship: vector('relationship'),
  search_candidate: vector('search_candidate'),
  schema_evolution: vector('schema_evolution'),
  catalog: vector('catalog'),
  malformed: vector('malformed'),
  held_signed: vector('held_signed'),
  nested_unknown: vector('nested_unknown'),
};

/**
 * The unit lookup, in the kit's shape.
 *
 * Named rather than inlined because a test below builds an implementation
 * claiming ONLY this family, and reaching back into `ours` for it needed a
 * non-null assertion — an assertion in a test is a place the type system was
 * argued with rather than satisfied.
 */
function unitDefOrNull(
  code: string,
): { dimension: string; scale: number; baseFactor: string } | null {
  const def = unitDef(code);
  return def === undefined
    ? null
    : {
        dimension: def.dimension,
        scale: def.scale,
        // `baseFactor` is a bigint here and a decimal STRING in the vector.
        // The shim converts; the kit does not care which a port uses
        // internally, only what it reports.
        baseFactor: def.baseFactor === null ? '' : String(def.baseFactor),
      };
}

/** The shim a pack author writes. Nothing here reaches into the runner. */
const ours: ConformanceImplementation = {
  lineSubtotalMinorUnits: ({ unitPrice, quantity, priceBasis }) => {
    const out = computeLineSubtotal(
      { currency: unitPrice.currency, minor_units: unitPrice.minorUnits },
      { value: quantity.value, unit_code: quantity.unitCode },
      { value: priceBasis.value, unit_code: priceBasis.unitCode },
    );
    if (out.value === null) throw new Error(out.error ?? 'refused');
    return out.value.minor_units;
  },

  orderTotalMinorUnits: ({ currency, lineSubtotals, charges }) => {
    const out = computeTotal(
      currency,
      lineSubtotals.map((minor_units) => ({ currency, minor_units })),
      charges.map((c) => ({
        kind: 'delivery' as const,
        label: 'x',
        amount: { currency: c.amount.currency, minor_units: c.amount.minorUnits },
        operation: c.operation as 'add' | 'subtract',
      })),
    );
    if (out.value === null) throw new Error(out.error ?? 'refused');
    return out.value.minor_units;
  },

  recordDigest: (domain, record) =>
    commerceRecordDigest(
      domain as CommerceDigestDomain,
      record as Record<string, unknown>,
      hash,
    ),

  unitDef: (code) => unitDefOrNull(code),

  // §9.3/§9.4 — the identity half of the kit. `validateProductRef` returns the
  // frozen refusal string, which is the part a second port has to match; a
  // boolean would let two ports refuse the same record for reasons an operator
  // reads as two different incidents.
  validateProduct: (productRef) => validateProductRef(productRef),
  productsEqual: (a, b) => productRefsEqual(a as never, b as never),

  // §10.3/§10.5 — the two graph-and-index families. Both return this
  // implementation's frozen refusal strings for the same reason the product
  // family does: an operator reading two ports' logs must see one incident.
  validateRelationshipClaim: (claim) => validateProductRelationshipClaim(claim),
  validateSearchCandidate: (candidate) => validateCommerceSearchCandidate(candidate),

  // §9.13 — admission is a TYPED refusal, and the shim is where snake_case on
  // the wire meets the kit's camelCase. A port whose own error names differ
  // maps them here; what the kit judges is the answer, not the spelling.
  admitVersion: (version) => {
    const out = checkProtocolVersion(version);
    return out === null
      ? null
      : {
          code: out.code,
          requestedVersion: out.requested_version,
          supportedVersions: out.supported_versions,
        };
  },
  validateVersionShape: (value) => validateProtocolVersionShape(value, 'protocol_version'),
  canonicalJson: (value) => canonicalJson(value),

  /**
   * PARSE, THEN CANONICALIZE — the two steps production really performs.
   *
   * This package has no schema layer, so parsing is the identity here and the
   * hook reduces to `canonicalJson`. It is still not redundant: the CONTRACT is
   * that a port composes its own parser, and the negative test below proves the
   * family fails for a port whose parser strips unknown keys while its
   * canonicalizer is perfectly correct.
   */
  parseThenCanonicalJson: (_kind, value) => canonicalJson(value),

  // §10.2 — the catalog publication. The two digest levels are separate
  // functions here for the same reason the kit asks for them separately: a
  // page digest covers items, a snapshot digest covers page digests, and a
  // port that collapsed them would compute a value no other node reproduces.
  catalogPageDigest: (page) => catalogPageDigest(page as CatalogSnapshotPage, hash),
  catalogPayloadRoot: (pageDigests) => catalogPayloadRoot(pageDigests, hash),
  catalogSnapshotDigest: (snapshot) => catalogSnapshotDigest(snapshot as CatalogSnapshot, hash),
  verifyCatalogAdvance: (previous, next) =>
    verifyCatalogPointerAdvance(previous as CatalogPointer | null, next as CatalogPointer),

  // The phase-0 REFUSAL battery. These are the validators a port must have
  // said no with, and the shim is trivial precisely because the interesting
  // part is on the other side: whether each one fires on the right document.
  validateMoney: (money) => validateMoney(money),
  validateQuantity: (quantity) => validateQuantity(quantity),
  validateSignedQuote: (quote) => validateSignedQuote(quote, hash),
  validateOrderStatus: (status) => validateCommerceOrderStatus(status, hash),
  validateReconcileRequest: (request) => validateOrderReconcileRequest(request, hash),

  /**
   * §12.7/§16.2 — REAL verification, because the structural family cannot.
   *
   * Two checks, and the vectors include a case that defeats each one alone: a
   * signature that verifies over an envelope pointing at a DIFFERENT record
   * passes the crypto and fails the binding, and an altered envelope fails the
   * crypto while still naming the right record.
   */
  verifyHeldEvidence: ({ record, envelope, signature, signerPublicKeyHex }) => {
    if (!/^[0-9a-f]{128}$/.test(signature)) return false;
    const key = createPublicKey({
      key: Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'),
        Buffer.from(signerPublicKeyHex, 'hex'),
      ]),
      format: 'der',
      type: 'spki',
    });
    const signatureIsGood = verify(
      null,
      Buffer.from(canonicalJson(envelope), 'utf8'),
      key,
      Buffer.from(signature, 'hex'),
    );
    if (!signatureIsGood) return false;
    // THE BINDING. A signature alone says the supplier sent SOMETHING; it says
    // nothing about whether this is the record it was sent with.
    const bound = (envelope as { record_digest?: unknown }).record_digest;
    const expected = commerceRecordDigest(
      'acknowledgement',
      record as Record<string, unknown>,
      hash,
    );
    return bound === expected;
  },

  compareQuantities: (a, b) => {
    const out = compareQuantities(
      { value: a.value, unit_code: a.unitCode },
      { value: b.value, unit_code: b.unitCode },
    );
    // A STRING IS THE REFUSAL in our implementation. The kit's interface says
    // nothing about how a refusal is spelled, which is the point: a Go port
    // returning an error and a Rust port returning `Err` both map here.
    if (typeof out === 'string') return { refused: true };
    return out < 0 ? -1 : out > 0 ? 1 : 0;
  },
};

describe('this implementation conforms to the frozen vectors', () => {
  const report = runConformance(ours, VECTORS);

  it('passes every wired case', () => {
    if (!report.ok) {
      // The formatted report is the useful artefact on a failure — a bare
      // count would send an implementer back to the JSON to guess.
      throw new Error(formatReport(report));
    }
    expect(report.failed).toBe(0);
    expect(report.passed).toBeGreaterThan(0);
  });

  it('skips nothing, because this implementation claims every wired family', () => {
    expect(report.skipped).toBe(0);
  });

  it('runs the number of cases the vectors contain, per family', () => {
    // WHY A LITERAL COUNT. `missingVectorFamilies` catches a family that ran
    // ZERO cases; nothing catches a family that ran ONE of nine. A wiring bug
    // that iterated the wrong key — `claims` misspelt, a sub-array missed —
    // would report the family as executed and certify a rule it never
    // checked, which is this codebase's signature defect wearing a green tick.
    //
    // Pinned as numbers rather than recomputed from the JSON, because a test
    // that re-derives the count from the vector re-implements the loop it is
    // checking and agrees with itself.
    const byFamily: Record<string, number> = {};
    for (const c of report.cases) byFamily[c.family] = (byFamily[c.family] ?? 0) + 1;

    expect(byFamily).toEqual({
      'arithmetic.line_subtotals': 7,
      'arithmetic.totals': 4,
      'digests.records': 15,
      'digests.domain_separation': 10,
      'units.defined': 7,
      'units.rejected': 7,
      'quantity.comparisons': 9,
      'quantity.rejected': 5,
      'product.equality': 10,
      'product.rejected': 11,
      'product.scoped': 2,
      'relationship.claims': 9,
      'search_candidate.valid': 1,
      'search_candidate.invalid': 5,
      'schema_evolution.version_admission': 5,
      'schema_evolution.version_shape': 6,
      'schema_evolution.nested_unknown': 6,
      'schema_evolution.parse_round_trip': 4,
      'schema_evolution.unknown_fields': 12,
      'schema_evolution.unknown_field_tolerance': 2,
      'catalog.page_digests': 2,
      'catalog.payload_root': 1,
      'catalog.snapshot_digest': 1,
      'catalog.chain': 5,
      'malformed.money': 5,
      'malformed.quantity': 5,
      'malformed.line_subtotal': 2,
      'malformed.quote': 7,
      'malformed.status': 3,
      'held_signed.evidence': 6,
      'malformed.held_evidence': 6,
    });
  });

  it('keeps REQUIRED_CASE_FAMILIES and the pinned counts in agreement', () => {
    // NEW-B, and it is the FOURTH instance of this hole. Both lists name the
    // same 28 families by hand, in two files, with nothing comparing them. A
    // family wired into the runner and added to the count map — the natural
    // way to make the suite green — but forgotten in REQUIRED_CASE_FAMILIES
    // becomes silently OPTIONAL for every caller, in the one module whose job
    // is to notice exactly that.
    const executed = new Set(report.cases.map((c) => c.family));

    expect([...executed].sort()).toEqual([...REQUIRED_CASE_FAMILIES].sort());
  });

  it('executes every vector family, and says so by having nothing to omit', () => {
    // This assertion INVERTED on 2026-08-10, and the inversion is the point of
    // the row. It used to read `toContain('NOT EXECUTED')` — correct while six
    // families were unwired, and quietly wrong the moment the last one landed.
    // A test asserting the presence of a caveat passes hardest when the caveat
    // is permanent.
    expect(report.unwiredFamilies).toEqual([]);
    expect([...UNWIRED_FAMILIES]).toEqual([]);
    expect(formatReport(report)).not.toContain('NOT EXECUTED');
  });

  it('still NAMES unexecuted families, for the next one added', () => {
    // The mechanism outlives the empty list. `UNWIRED_FAMILIES` is a module
    // constant, so the only way to check the reporting rule without a family
    // to omit is to format a report that has one — and it has to keep working,
    // because the next family added to `vectors/` arrives unwired and a runner
    // that stopped saying so would certify more than it checked.
    const withGap = { ...report, unwiredFamilies: ['a_future_family'] };

    expect(formatReport(withGap)).toContain('NOT EXECUTED by this runner: a_future_family');
  });
});

describe('the runner detects a divergence — it is not a rubber stamp', () => {
  it('fails an implementation whose arithmetic is off by one minor unit', () => {
    // The cheapest possible wrong answer. If the kit tolerates this it
    // tolerates anything.
    const offByOne: ConformanceImplementation = {
      ...ours,
      lineSubtotalMinorUnits: (args) => {
        const right = ours.lineSubtotalMinorUnits?.(args) ?? '0';
        return String(BigInt(right) + 1n);
      },
    };
    const report = runConformance(offByOne, VECTORS);
    expect(report.ok).toBe(false);
    expect(report.failed).toBeGreaterThan(0);
    expect(formatReport(report)).toContain('arithmetic.line_subtotals');
  });

  it('fails an implementation that lets a relationship point at the wrong KIND', () => {
    // §10.3. `manufactured_by` relates a product to an OPERATOR and
    // `variant_of` relates two products. A port that admitted either pointing
    // at the other kind would build a graph whose edges silently mean two
    // different things, and every traversal after that is arithmetic over a
    // category error. Modelled as a port that checks the RELATIONSHIP NAME and
    // forgets to check what it points at — the plausible way to get this
    // wrong, not a validator that returns null for everything.
    const kindBlind: ConformanceImplementation = {
      ...ours,
      validateRelationshipClaim: (claim) => {
        const out = validateProductRelationshipClaim(claim);
        return out !== null && out.includes('object must') ? null : out;
      },
    };
    const report = runConformance(kindBlind, VECTORS);

    expect(report.ok).toBe(false);
    expect(report.cases.filter((c) => c.family === 'relationship.claims' && c.status === 'fail'))
      .toHaveLength(2);
  });

  it('fails an index whose candidates name no reason they matched', () => {
    // §10.5. A result nobody can explain is indistinguishable from a paid
    // placement, which is the failure PeerLens exists to survive. An index
    // that dropped the empty-`matched_fields` refusal would be free to return
    // anything it liked and call it a match.
    const unexplained: ConformanceImplementation = {
      ...ours,
      validateSearchCandidate: (candidate) => {
        const out = validateCommerceSearchCandidate(candidate);
        return out !== null && out.includes('matched_fields') ? null : out;
      },
    };
    const report = runConformance(unexplained, VECTORS);

    expect(report.ok).toBe(false);
    expect(
      report.cases.some(
        (c) => c.family === 'search_candidate.invalid' && c.name === 'no_matched_fields' && c.status === 'fail',
      ),
    ).toBe(true);
  });

  it('fails an implementation that best-effort-parses across a MAJOR version', () => {
    // §9.13's central refusal. Admitting a 2.0 document means reading fields
    // whose meaning this version has never been told, and then acting on terms
    // both sides believe they agreed to. The typed refusal is what makes the
    // disagreement visible instead of expensive.
    const optimistic: ConformanceImplementation = { ...ours, admitVersion: () => null };
    const report = runConformance(optimistic, VECTORS);

    expect(report.ok).toBe(false);
    expect(
      report.cases.filter(
        (c) => c.family === 'schema_evolution.version_admission' && c.status === 'fail',
      ),
    ).toHaveLength(2);
  });

  it('fails an implementation that DROPS unknown fields before canonicalising', () => {
    // The forward-compatibility law, and the most consequential of these. A
    // port that stripped what it did not recognise would digest a document
    // nobody sent — and would then verify a signature over something the
    // signer never signed. It looks like tidiness and it is a forgery seam.
    const tidy: ConformanceImplementation = {
      ...ours,
      canonicalJson: (value) => {
        const known = new Set(['a', 'protocol_version']);
        if (value === null || typeof value !== 'object') return canonicalJson(value);
        const kept: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          if (known.has(k)) kept[k] = v;
        }
        return canonicalJson(kept);
      },
    };
    const report = runConformance(tidy, VECTORS);

    expect(report.ok).toBe(false);
    expect(
      report.cases.some(
        (c) =>
          c.family === 'schema_evolution.unknown_fields' &&
          c.name.startsWith('an_unknown_field_CHANGES_the_canonical_bytes') &&
          c.status === 'fail',
      ),
    ).toBe(true);
  });

  it('fails an index that applies a snapshot over a SEQUENCE GAP', () => {
    // §10.2's worst outcome, and the reason a gap is a fault rather than a
    // warning: an index that applied sequence 3 straight after sequence 1
    // serves a catalog no supplier ever published, assembled out of two that
    // they did. Every record in it is genuine, which is what makes it hard to
    // notice — the prices are real and the combination is not.
    const gapTolerant: ConformanceImplementation = {
      ...ours,
      verifyCatalogAdvance: (previous, next) => {
        const out = verifyCatalogPointerAdvance(
          previous as CatalogPointer | null,
          next as CatalogPointer,
        );
        return out !== null && out.includes('sequence gap') ? null : out;
      },
    };
    const report = runConformance(gapTolerant, VECTORS);

    expect(report.ok).toBe(false);
    expect(
      report.cases.some(
        (c) =>
          c.family === 'catalog.chain' &&
          c.name === 'gap_is_a_publication_fault' &&
          c.status === 'fail',
      ),
    ).toBe(true);
  });

  it('fails an implementation that collapses the two DIGEST LEVELS', () => {
    // A page digest covers the items in a page; a snapshot digest covers the
    // page digests through the payload root. A port that hashed the snapshot
    // the way it hashes a page gets a stable-looking value that no other node
    // reproduces, and the supplier finds their catalog unindexable everywhere
    // except at home.
    const collapsed: ConformanceImplementation = {
      ...ours,
      catalogSnapshotDigest: (snapshot) =>
        catalogPageDigest(snapshot as unknown as CatalogSnapshotPage, hash),
    };
    const report = runConformance(collapsed, VECTORS);

    expect(report.ok).toBe(false);
    expect(
      report.cases.some((c) => c.family === 'catalog.snapshot_digest' && c.status === 'fail'),
    ).toBe(true);
  });

  it('fails a port that verifies a quote’s SIGNATURE and trusts its arithmetic', () => {
    // The most expensive way to be wrong in this whole kit. Checking that the
    // supplier really sent the document, and nothing about whether the
    // document adds up, means a tampered total travels under a valid
    // signature — and every downstream party has cryptographic proof of a
    // number nobody computed.
    const signatureOnly: ConformanceImplementation = {
      ...ours,
      // EXACTLY the §9.1 arithmetic check and nothing else. My first version
      // suppressed anything containing 'recomputation', which also swallowed
      // the terms-digest refusal ("does not match the canonical terms
      // recomputation") and made this fail three cases while the comment
      // claimed two. A mutation whose blast radius is wider than its
      // description tests something other than what it says it tests.
      validateSignedQuote: (quote) => {
        const out = validateSignedQuote(quote, hash);
        return out !== null && out.includes('does not equal the §9.1 recomputation') ? null : out;
      },
    };
    const report = runConformance(signatureOnly, VECTORS);

    expect(report.ok).toBe(false);
    expect(
      report.cases
        .filter((c) => c.family === 'malformed.quote' && c.status === 'fail')
        .map((c) => c.name)
        .sort(),
    ).toEqual(['tampered_line_subtotal', 'tampered_total']);
  });

  it('fails a port that accepts held evidence with NO SIGNATURE', () => {
    // §12.7/§16.2. A record plus its content digest proves nothing — the
    // digest is a hash of the record, so anyone holding or inventing the
    // record computes one. A port that accepted bare evidence has a recovery
    // path a forger can drive.
    const credulous: ConformanceImplementation = {
      ...ours,
      validateReconcileRequest: (request) => {
        const out = validateOrderReconcileRequest(request, hash);
        return out !== null && out.includes('signature') ? null : out;
      },
    };
    const report = runConformance(credulous, VECTORS);

    expect(report.ok).toBe(false);
    expect(
      report.cases.filter((c) => c.family === 'malformed.held_evidence' && c.status === 'fail')
        .length,
    ).toBeGreaterThan(0);
  });

  it('fails an implementation that ignores DOMAIN SEPARATION', () => {
    // One payload must digest differently under every domain, or a record
    // from one lane could be presented as a record from another.
    const oneDomain: ConformanceImplementation = {
      ...ours,
      recordDigest: (_domain, record) =>
        commerceRecordDigest('projection', record as Record<string, unknown>, hash),
    };
    const report = runConformance(oneDomain, VECTORS);
    expect(report.ok).toBe(false);
    expect(
      report.cases.some((c) => c.family === 'digests.domain_separation' && c.status === 'fail'),
    ).toBe(true);
  });

  it('fails an implementation that ACCEPTS a code the closed vocabulary rejects', () => {
    // `EACH` and `each ` are in the rejected list because case-folding and
    // trimming are how two implementations come to disagree about a quantity.
    const lenient: ConformanceImplementation = {
      ...ours,
      unitDef: (code) => ours.unitDef?.(code.trim().toLowerCase()) ?? null,
    };
    const report = runConformance(lenient, VECTORS);
    expect(report.ok).toBe(false);
    expect(report.cases.some((c) => c.family === 'units.rejected' && c.status === 'fail')).toBe(
      true,
    );
  });

  it('fails an implementation that ORDERS quantities it cannot compare', () => {
    const reckless: ConformanceImplementation = {
      ...ours,
      compareQuantities: () => 0,
    };
    const report = runConformance(reckless, VECTORS);
    expect(report.ok).toBe(false);
    expect(report.cases.some((c) => c.family === 'quantity.rejected' && c.status === 'fail')).toBe(
      true,
    );
  });
});

describe('a partial claim is reported as partial', () => {
  it('SKIPS what an implementation does not supply, and a skip BLOCKS the verdict', () => {
    // DR-6. A pack implementing only digests must not report a clean pass by
    // claiming nothing else. The first version of this test asserted only that
    // skips were RECORDED, and the runner's `ok` ignored them — so an
    // implementation supplying one trivial family passed while every
    // money-arithmetic case sat skipped. "Supplied nothing" was covered;
    // "supplied almost nothing" is the case a pack author would actually hit.
    const digest = ours.recordDigest;
    if (digest === undefined) throw new Error('the shim lost its digest function');
    const digestsOnly: ConformanceImplementation = { recordDigest: digest };
    const report = runConformance(digestsOnly, VECTORS);

    expect(report.skipped).toBeGreaterThan(0);
    expect(report.failed).toBe(0);
    expect(report.ok).toBe(false);
    expect(report.skippedFamilies).toContain('arithmetic.line_subtotals');
    expect(report.cases.some((c) => c.status === 'skipped' && c.detail?.includes('not supplied')))
      .toBe(true);
  });

  it('fails a port whose CANONICALIZER is correct but whose PARSER strips', () => {
    // THE APPVIEW DEFECT, as a conformance case. `canonicalJson` here is
    // byte-perfect — it is this package's own — and the port still fails,
    // because the field is gone before canonicalization runs. That is the
    // whole reason `parseThenCanonicalJson` exists as a separate hook: the
    // family that judged the canonicalizer alone certified this port.
    const strippingParser = (value: unknown): unknown => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
      const known = new Set(['a', 'protocol_version', 'b']);
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).filter(([k]) => known.has(k)),
      );
    };
    const report = runConformance(
      {
        ...ours,
        // Correct canonicalizer …
        canonicalJson: (value) => canonicalJson(value),
        // … fed an already-shortened record.
        parseThenCanonicalJson: (_kind, value) => canonicalJson(strippingParser(value)),
      },
      VECTORS,
    );
    expect(report.ok).toBe(false);
    const parseCases = report.cases.filter(
      (c) => c.family === 'schema_evolution.parse_round_trip',
    );
    expect(parseCases.some((c) => c.status === 'fail')).toBe(true);
    // And the family that only sees the canonicalizer is still perfectly happy,
    // which is precisely why it could not have caught this.
    const canonicalOnly = report.cases.filter(
      (c) => c.family === 'schema_evolution.unknown_fields',
    );
    expect(canonicalOnly.every((c) => c.status === 'pass')).toBe(true);
  });

  it('fails a parser that keeps TOP-LEVEL unknowns but strips nested ones', () => {
    // THE DEFECT APPVIEW SHIPPED, as a conformance case. Its schema was
    // `.passthrough()` at the root and `z.object()` beneath, so an additive
    // field survived at the top and vanished inside a page, an item, or a
    // product reference — and the digest computed over the shortened record no
    // longer matched what the supplier signed.
    //
    // The flat family cannot see this: every one of its cases is a flat object,
    // so a top-level-only passthrough satisfies it completely. That is asserted
    // below rather than assumed, because "the other family would have caught
    // it" is exactly the belief that let this through the first time.
    const stripNested = (value: unknown, depth = 0): unknown => {
      if (Array.isArray(value)) return value.map((v) => stripNested(v, depth + 1));
      if (typeof value !== 'object' || value === null) return value;
      const known = new Set([
        'a', 'b', 'protocol_version', 'supplier_did', 'catalog_id', 'snapshot_sequence',
        'published_at', 'snapshot_rkey', 'snapshot_digest', 'previous_snapshot_digest',
        'page_digests', 'item_count', 'payload_root', 'page_index', 'items', 'page_digest',
        'product', 'scheme', 'value', 'issuer_did', 'variant_digest', 'item_revision',
        'name', 'brand', 'description', 'category_ids', 'identifiers', 'pack', 'sell_unit',
        'unit_code', 'units_per_pack', 'fulfilment_regions', 'indicative_price', 'currency',
        'minor_units', 'minimum_order', 'freshness', 'generated_at', 'valid_until',
        'attributes', 'relationship_claim_refs', 'claim_id', 'subject', 'relationship',
        'object', 'effective_from', 'effective_until', 'evidence_refs', 'withdrawn',
        'service_rkey',
      ]);
      const entries = Object.entries(value as Record<string, unknown>)
        // The ROOT keeps everything — that is the passthrough. Everything
        // deeper is filtered, which is the bug.
        .filter(([k]) => depth === 0 || known.has(k))
        .map(([k, v]) => [k, stripNested(v, depth + 1)] as const);
      return Object.fromEntries(entries);
    };

    const report = runConformance(
      {
        ...ours,
        parseThenCanonicalJson: (_kind, value) => canonicalJson(stripNested(value)),
      },
      VECTORS,
    );
    expect(report.ok).toBe(false);

    const nested = report.cases.filter((c) => c.family === 'schema_evolution.nested_unknown');
    expect(nested.some((c) => c.status === 'fail')).toBe(true);
    // Specifically the DEEP ones, not merely "something failed".
    expect(
      nested.filter((c) => c.status === 'fail').map((c) => c.name).join(' | '),
    ).toContain('inside an item PRODUCT REF, two levels down');

    // And the flat family is perfectly happy, which is why it could not have
    // caught this on its own.
    const flat = report.cases.filter(
      (c) => c.family === 'schema_evolution.parse_round_trip',
    );
    expect(flat.every((c) => c.status === 'pass')).toBe(true);
  });

  it('a lone trivial family does NOT earn a conformance verdict', () => {
    // The exact shape DR-6 named: `unitDef` alone, every money and digest case
    // skipped, previously `ok: true`.
    const unitsOnly: ConformanceImplementation = { unitDef: (code) => unitDefOrNull(code) };
    const report = runConformance(unitsOnly, VECTORS);
    expect(report.passed).toBeGreaterThan(0);
    expect(report.failed).toBe(0);
    expect(report.ok).toBe(false);
  });

  it('states what it EXECUTED beside the verdict', () => {
    // A verdict is only legible beside its coverage.
    const report = runConformance(ours, VECTORS);
    expect(report.executedFamilies).toContain('arithmetic.totals');
    expect(report.executedFamilies).toContain('digests.domain_separation');
    expect(formatReport(report)).toContain('EXECUTED:');
  });

  it('an implementation supplying NOTHING is not ok', () => {
    const empty = runConformance({}, VECTORS);
    expect(empty.passed).toBe(0);
    expect(empty.ok).toBe(false);
  });
});

/**
 * NEW-8 — "did not claim" and "was not asked" are different holes.
 *
 * The DR-6 fix closed the first: an implementation supplying no function for a
 * family lands in `skippedFamilies` and blocks `ok`. It did not close the
 * second. Every member of `WiredVectors` is optional and `skipFamily(f, 0, …)`
 * pushes no cases, so a caller arriving with a truncated vectors object
 * produced a clean pass over whatever happened to be present.
 *
 * That caller is the one this module was built for: the vectors are taken as
 * DATA so a CI job can fetch them from a release artefact.
 */
describe('a verdict covers the vectors it was given', () => {
  it('requires exactly these families, and the list is pinned HERE', () => {
    // The one place the required set is stated in a test. Adding a family to
    // the runner without adding it here fails, which is the point — the
    // coverage assertions below derive from this rather than repeating it,
    // because an expectation updated mechanically to make a suite green is an
    // expectation nobody is reading.
    expect([...REQUIRED_VECTOR_FAMILIES]).toEqual([
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
    ]);
  });

  it('is NOT ok when whole vector families were never supplied', () => {
    const report = runConformance(ours, { units: VECTORS.units });

    expect(report.ok).toBe(false);
    expect(report.missingVectorFamilies.sort()).toEqual(
      REQUIRED_CASE_FAMILIES.filter((f) => !f.startsWith('units.')).slice().sort(),
    );
  });

  it('NAMES what it was not given, so the gap is legible beside the verdict', () => {
    const report = runConformance(ours, { units: VECTORS.units });
    expect(formatReport(report)).toContain(
      `NOT SUPPLIED to this runner: ${REQUIRED_CASE_FAMILIES.filter((f) => !f.startsWith('units.')).join(', ')}`,
    );
  });

  it('treats an explicitly null family as absent, not as empty', () => {
    // `{digests: null}` is a fetch that returned nothing, not a family with no
    // cases in it. Reading it as the latter is how a broken artefact passes.
    const report = runConformance(ours, { ...VECTORS, digests: null });

    expect(report.ok).toBe(false);
    expect(report.missingVectorFamilies.sort()).toEqual(
      ['digests.domain_separation', 'digests.records'],
    );
  });

  it('is ok on the complete set, so the guard is not simply refusing everything', () => {
    const report = runConformance(ours, VECTORS);

    expect(report.missingVectorFamilies).toEqual([]);
    expect(report.ok).toBe(true);
  });
});

/**
 * NEW-14 — the predicate must measure coverage, not a proxy for it.
 *
 * Third iteration of one hole. DR-6 caught "the implementation did not claim
 * a family". NEW-8 caught "the caller supplied no vectors for it" — but by
 * checking the KEY was present, so a present-but-empty family satisfied it. A
 * partially generated artefact is exactly that shape.
 */
describe('a verdict covers the cases that ran', () => {
  it('is NOT ok when a family was supplied EMPTY rather than absent', () => {
    // Every family present as a KEY, every one but `arithmetic` carrying no
    // cases. This is the shape of a partially generated artefact, and the
    // caller this module says it is designed for is the one who fetches it.
    const truncated: Record<string, unknown> = { arithmetic: VECTORS.arithmetic };
    for (const family of REQUIRED_VECTOR_FAMILIES) {
      if (family !== 'arithmetic') truncated[family] = {};
    }

    const report = runConformance(ours, truncated);

    expect(report.ok).toBe(false);
    expect(report.missingVectorFamilies.sort()).toEqual(
      REQUIRED_CASE_FAMILIES.filter((f) => !f.startsWith('arithmetic.')).slice().sort(),
    );
  });

  it('is NOT ok when ONE SUB-FAMILY stands in for a whole family', () => {
    // The hole this fix closed. `{malformed: {money: […]}}` executed
    // `malformed.money` and produced zero cases for quote, status and
    // held_evidence — the tampered-quote battery this runner was extended to
    // reach — and reported ok:true.
    const report = runConformance(ours, {
      ...VECTORS,
      malformed: { money: (VECTORS.malformed as { money: unknown[] }).money },
    });

    expect(report.ok).toBe(false);
    expect(report.missingVectorFamilies).toEqual(
      expect.arrayContaining(['malformed.quote', 'malformed.status', 'malformed.held_evidence']),
    );
  });

  it('is NOT ok when a family carries the key but no cases under it', () => {
    const report = runConformance(ours, { ...VECTORS, quantity: { comparisons: [] } });

    expect(report.ok).toBe(false);
    expect(report.missingVectorFamilies.sort()).toEqual(
      ['quantity.comparisons', 'quantity.rejected'],
    );
  });

  it('is still ok on the complete set', () => {
    expect(runConformance(ours, VECTORS).ok).toBe(true);
  });
});
