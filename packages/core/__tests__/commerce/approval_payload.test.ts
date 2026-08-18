/**
 * WS-7.5 — approval and execution bind ONE payload (§15.2, §15.2b, FR-P5).
 *
 * The whole file is one attack, run twelve ways: a card says one thing, the
 * owner taps approve, and something hands the executor a different order.
 * Every downstream check still passes, because each one validates the order it
 * was GIVEN; nothing else compares it to what was on the card.
 *
 * So each case below approves payload A, mutates exactly one bound field, and
 * asserts the executor refuses and NAMES the field. Naming it is safe — both
 * sides are the owner's own data — and an operator told only "binding failed"
 * cannot tell an attack from a bug in the card renderer.
 */

import {
  approvalDigest,
  buildBuyerApprovalPayload,
  buildSupplierApprovalPayload,
  verifyApprovalBinding,
  type ActingInstall,
  type ApprovingPrincipal,
  type BuyerApprovalContext,
  type BuyerApprovalPayload,
} from '../../src/commerce/approval_payload';

import {
  BUYER_DID,
  SUPPLIER_DID,
  hash,
  makeOrder,
  makeQuoteRequest,
  makeSignedQuote,
} from './helpers';

import type { PurchaseOrderProposal } from '@dina/commerce-protocol';

/**
 * Build, insisting it succeeded.
 *
 * The builder REFUSES a card that failed to supply a §15.2 field, and every
 * case here supplies them — so a refusal is a broken fixture, and saying so
 * loudly beats letting a `missing` result flow into a comparison and pass.
 */
function built(proposal: PurchaseOrderProposal, ctx: BuyerApprovalContext): BuyerApprovalPayload {
  const result = buildBuyerApprovalPayload(proposal, ctx);
  if (!result.ok) throw new Error(`fixture is missing ${result.missing.join(', ')}`);
  return result.payload;
}

const INSTALL: ActingInstall = {
  installId: 'install-1',
  capabilityId: 'com.dinakernel.commerce.submit-order',
  manifestCid: 'bafyreichairmaker1',
  installScopeHash: 's'.repeat(64),
  configRevision: '3',
};

const PRINCIPAL: ApprovingPrincipal = {
  principalDid: 'did:plc:sanchoowner',
  authorityDomain: 'procurement',
  policyRevision: null,
};

function order(): PurchaseOrderProposal {
  const request = makeQuoteRequest();
  const quote = makeSignedQuote(request, { quote_id: 'q-approval' });
  return makeOrder(quote, request.delivery.projection);
}

function context(overrides: Partial<BuyerApprovalContext> = {}): BuyerApprovalContext {
  return {
    actingBusinessDid: BUYER_DID,
    principal: PRINCIPAL,
    serviceUri: `at://${SUPPLIER_DID}/com.dinakernel.service.profile/self`,
    displayedLabels: { l1: 'Oak dining chair' },
    productKeys: { l1: 'gtin:05012345678900' },
    linePrices: { l1: { currency: 'INR', minor_units: '500' } },
    charges: [{ code: 'freight', amount: { currency: 'INR', minor_units: '2000' } }],
    quoteRevision: 1,
    quoteExpiresAt: '2026-08-09T09:00:00.000Z',
    install: INSTALL,
    ...overrides,
  };
}

describe('the binding itself', () => {
  it('accepts the order that was approved', () => {
    const proposal = order();
    const approved = built(proposal, context());
    const executing = built(proposal, context());
    expect(verifyApprovalBinding(approved, executing)).toEqual({ ok: true });
  });

  it('is domain-separated from every §9.12 wire digest', () => {
    // An approval payload is LOCAL evidence, not a record that crosses the
    // wire. Sharing a digest domain with an order would let one be presented
    // as the other.
    const proposal = order();
    const payload = built(proposal, context());
    expect(approvalDigest(payload)).not.toBe(proposal.order_digest);
    expect(approvalDigest(payload)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('names a field that appeared only in the payload about to execute', () => {
    // Both builders produce fixed shapes, so this needs a hand-built payload —
    // and that is exactly the case worth covering: a caller assembling a
    // payload by hand is how an extra field gets in. The verdict is a refusal
    // either way (the digest already differs); what the walk adds is being
    // able to NAME it, which is what an operator reads.
    const proposal = order();
    const approved = built(proposal, context());
    const executing = { ...approved, buyerReference: 'PO-9' } as unknown as BuyerApprovalPayload;
    expect(verifyApprovalBinding(approved, executing)).toMatchObject({
      ok: false,
      field: 'buyerReference',
      reason: 'field appeared after approval',
    });
  });

  it('gives buyer and supplier payloads different digests', () => {
    // The two authorize opposite sides of one trade. Coincidentally equal
    // fields must not produce one digest.
    const proposal = order();
    const buyer = built(proposal, context());
    const supplier = buildSupplierApprovalPayload({
      actingBusinessDid: SUPPLIER_DID,
      principal: PRINCIPAL,
      buyerDid: BUYER_DID,
      purchaseOrderId: proposal.purchase_order_id,
      orderDigest: proposal.order_digest,
      quoteDigest: proposal.quote_digest,
      acknowledgementKind: 'accepted',
      install: INSTALL,
    });
    expect(approvalDigest(buyer)).not.toBe(approvalDigest(supplier));
    const verdict = verifyApprovalBinding(buyer, supplier);
    expect(verdict).toMatchObject({ ok: false, field: 'kind' });
  });
});

describe('a card that failed to supply a §15.2 field', () => {
  it.each(['displayedLabels', 'productKeys', 'linePrices'])(
    'refuses to build when %s omits a line',
    (field) => {
      // NOT built with a placeholder. When the card supplies neither side of a
      // comparison the field binds to a CONSTANT and carries no information —
      // the payload looks §15.2-compliant and binds nothing. A test caught
      // exactly that: the first version filled the gaps with empty strings and
      // two bait-and-switch cases passed while proving nothing.
      const ctx = { ...context(), [field]: {} } as BuyerApprovalContext;
      const result = buildBuyerApprovalPayload(order(), ctx);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected a refusal');
      expect(result.missing).toEqual([`${field}[l1]`]);
    },
  );

  it('distinguishes "the card showed no per-line price" from "the card never said"', () => {
    // Null is a claim; absent is a gap. Collapsing them is how a §15.2 field
    // stops being bound without anyone noticing.
    const explicit = buildBuyerApprovalPayload(order(), context({ linePrices: { l1: null } }));
    expect(explicit.ok).toBe(true);
    expect(buildBuyerApprovalPayload(order(), context({ linePrices: {} })).ok).toBe(false);
  });
});

describe('bait and switch — the goods', () => {
  const proposal = order();
  const approved = built(proposal, context());

  it('refuses a changed total', () => {
    const swapped = {
      ...proposal,
      approved_total: { currency: 'INR', minor_units: '5000000' },
    };
    const verdict = verifyApprovalBinding(approved, built(swapped, context()));
    expect(verdict).toMatchObject({ ok: false, field: 'approvedTotal.minor_units' });
  });

  it('refuses a changed currency', () => {
    const swapped = {
      ...proposal,
      approved_total: { currency: 'USD', minor_units: proposal.approved_total.minor_units },
    };
    const verdict = verifyApprovalBinding(approved, built(swapped, context()));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('expected a refusal');
    expect(verdict.field).toContain('currency');
  });

  it('refuses a changed quantity', () => {
    const line = proposal.accepted_lines[0];
    if (line === undefined) throw new Error('fixture has no lines');
    const swapped = {
      ...proposal,
      accepted_lines: [{ ...line, quantity: { ...line.quantity, value: '9999' } }],
    };
    const verdict = verifyApprovalBinding(approved, built(swapped, context()));
    expect(verdict).toMatchObject({ ok: false, field: 'lines[0].quantity.value' });
  });

  it('refuses a changed delivery destination', () => {
    const swapped = {
      ...proposal,
      delivery: { ...proposal.delivery, projection_digest: 'f'.repeat(64) },
    };
    const verdict = verifyApprovalBinding(approved, built(swapped, context()));
    expect(verdict).toMatchObject({ ok: false, field: 'deliveryProjectionDigest' });
  });

  it('refuses a changed supplier', () => {
    const swapped = { ...proposal, supplier_did: 'did:plc:rivalchairs01' };
    const verdict = verifyApprovalBinding(approved, built(swapped, context()));
    expect(verdict).toMatchObject({ ok: false, field: 'supplierDid' });
  });

  it('refuses a changed quote', () => {
    const swapped = { ...proposal, quote_digest: 'e'.repeat(64) };
    const verdict = verifyApprovalBinding(approved, built(swapped, context()));
    expect(verdict).toMatchObject({ ok: false, field: 'quoteDigest' });
  });

  it('refuses changed terms', () => {
    const swapped = { ...proposal, accepted_terms_digest: 'd'.repeat(64) };
    const verdict = verifyApprovalBinding(approved, built(swapped, context()));
    expect(verdict).toMatchObject({ ok: false, field: 'termsDigest' });
  });

  it('refuses a changed idempotency key', () => {
    // A new key on the same goods is a SECOND order, not a retry of the one
    // that was approved.
    const swapped = { ...proposal, idempotency_key: 'idem-second' };
    const verdict = verifyApprovalBinding(approved, built(swapped, context()));
    expect(verdict).toMatchObject({ ok: false, field: 'idempotencyKey' });
  });

  it('refuses a re-labelled line whose identifier is unchanged', () => {
    // §15.2 binds displayed labels precisely because this swap keeps every
    // protocol field intact and changes what the human believed they bought.
    const verdict = verifyApprovalBinding(
      approved,
      built(proposal, context({ displayedLabels: { l1: 'Pine stool' } })),
    );
    expect(verdict).toMatchObject({ ok: false, field: 'lines[0].displayedLabel' });
  });

  it('refuses a changed per-line price even when the total is untouched', () => {
    // Two lines rebalanced against each other leave the total identical, and
    // only a per-line binding catches it.
    const verdict = verifyApprovalBinding(
      approved,
      built(proposal, context({ linePrices: { l1: { currency: 'INR', minor_units: '600' } } })),
    );
    expect(verdict).toMatchObject({ ok: false, field: 'lines[0].linePrice.minor_units' });
  });

  it('refuses a changed charge', () => {
    const verdict = verifyApprovalBinding(
      approved,
      built(
        proposal,
        context({
          charges: [{ code: 'freight', amount: { currency: 'INR', minor_units: '9000' } }],
        }),
      ),
    );
    expect(verdict).toMatchObject({ ok: false, field: 'charges[0].amount.minor_units' });
  });

  it('refuses a dropped charge', () => {
    // Removing a line changes the array LENGTH, which is bound for exactly
    // this reason: a walk that compared only shared indexes would pass.
    const verdict = verifyApprovalBinding(approved, built(proposal, context({ charges: [] })));
    expect(verdict).toMatchObject({ ok: false, field: 'charges.length' });
  });
});

describe('bait and switch — the actor', () => {
  const proposal = order();
  const approved = built(proposal, context());

  it.each([
    ['installId', { ...INSTALL, installId: 'install-2' }],
    ['capabilityId', { ...INSTALL, capabilityId: 'com.dinakernel.commerce.cancel-order' }],
    ['manifestCid', { ...INSTALL, manifestCid: 'bafyreiswapped' }],
    ['installScopeHash', { ...INSTALL, installScopeHash: 'a'.repeat(64) }],
    ['configRevision', { ...INSTALL, configRevision: '4' }],
  ])('refuses a swapped %s', (field, install) => {
    // The goods are identical and a different actor is about to send them.
    // An `order_digest` comparison alone would pass every one of these.
    const verdict = verifyApprovalBinding(approved, built(proposal, context({ install })));
    expect(verdict).toMatchObject({ ok: false, field: `install.${field}` });
  });

  it('refuses a different approving principal', () => {
    const verdict = verifyApprovalBinding(
      approved,
      built(
        proposal,
        context({ principal: { ...PRINCIPAL, principalDid: 'did:plc:someoneelse' } }),
      ),
    );
    expect(verdict).toMatchObject({ ok: false, field: 'principal.principalDid' });
  });

  it('refuses a different authority domain for the same principal', () => {
    const verdict = verifyApprovalBinding(
      approved,
      built(proposal, context({ principal: { ...PRINCIPAL, authorityDomain: 'facilities' } })),
    );
    expect(verdict).toMatchObject({ ok: false, field: 'principal.authorityDomain' });
  });

  it('refuses a human approval presented as policy auto-approval', () => {
    // §15.2b lets policy stand in for a principal, and the two are different
    // accountability stories: "a person decided" and "a rule decided" must
    // never share a digest.
    const verdict = verifyApprovalBinding(
      approved,
      built(
        proposal,
        context({
          principal: { principalDid: null, authorityDomain: 'procurement', policyRevision: '7' },
        }),
      ),
    );
    expect(verdict.ok).toBe(false);
  });

  it('refuses a swapped service listing', () => {
    // Same supplier DID, different listing — a different set of terms and a
    // different runner behind it.
    const verdict = verifyApprovalBinding(
      approved,
      built(
        proposal,
        context({ serviceUri: `at://${SUPPLIER_DID}/com.dinakernel.service.profile/other` }),
      ),
    );
    expect(verdict).toMatchObject({ ok: false, field: 'serviceUri' });
  });
});

describe('the supplier side (§15.2b)', () => {
  const base = {
    actingBusinessDid: SUPPLIER_DID,
    principal: PRINCIPAL,
    buyerDid: BUYER_DID,
    purchaseOrderId: 'po-1',
    orderDigest: 'a'.repeat(64),
    quoteDigest: 'b'.repeat(64),
    acknowledgementKind: 'accepted',
    install: INSTALL,
  };

  it('refuses an acceptance presented as a rejection', () => {
    const verdict = verifyApprovalBinding(
      buildSupplierApprovalPayload(base),
      buildSupplierApprovalPayload({ ...base, acknowledgementKind: 'rejected' }),
    );
    expect(verdict).toMatchObject({ ok: false, field: 'acknowledgementKind' });
  });

  it('refuses a counter that swaps the replacement quote', () => {
    const verdict = verifyApprovalBinding(
      buildSupplierApprovalPayload({ ...base, acknowledgementKind: 'countered' }),
      buildSupplierApprovalPayload({
        ...base,
        acknowledgementKind: 'countered',
        quoteDigest: 'c'.repeat(64),
      }),
    );
    expect(verdict).toMatchObject({ ok: false, field: 'quoteDigest' });
  });

  it('binds a cancellation resolution to the status head it ruled on', () => {
    // A resolution approved against one chain position must not be applied at
    // another: between approval and execution the order may have moved on,
    // and the ruling was about the earlier state.
    const cancellation = {
      cancellationId: 'cx-1',
      cancellationDigest: 'd'.repeat(64),
      resultKind: 'accepted',
      statusDigestAtResolution: 'e'.repeat(64),
      resultDigest: 'f'.repeat(64),
    };
    const approved = buildSupplierApprovalPayload({ ...base, cancellation });
    const moved = buildSupplierApprovalPayload({
      ...base,
      cancellation: { ...cancellation, statusDigestAtResolution: '0'.repeat(64) },
    });
    expect(verifyApprovalBinding(approved, moved)).toMatchObject({
      ok: false,
      field: 'cancellation.statusDigestAtResolution',
    });
  });

  it('refuses a plain acknowledgement presented as a cancellation resolution', () => {
    const cancellation = {
      cancellationId: 'cx-1',
      cancellationDigest: 'd'.repeat(64),
      resultKind: 'accepted',
      statusDigestAtResolution: 'e'.repeat(64),
      resultDigest: 'f'.repeat(64),
    };
    const verdict = verifyApprovalBinding(
      buildSupplierApprovalPayload(base),
      buildSupplierApprovalPayload({ ...base, cancellation }),
    );
    expect(verdict.ok).toBe(false);
  });
});

describe('the order the fixtures actually produce', () => {
  it('is a real proposal, so the bait-and-switch cases mean something', () => {
    // Stated as its own claim: if the fixture stopped being a valid order, every
    // case above would still pass while proving nothing.
    const proposal = order();
    expect(proposal.order_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(proposal.accepted_lines.length).toBeGreaterThan(0);
    expect(hash(new TextEncoder().encode('probe')).length).toBe(32);
  });
});
describe('§6.4 — attribution rides INSIDE the integrity digest', () => {
  it('a v2-attributed payload digests differently from the same payload unattributed', () => {
    const proposal = order();
    const bare = built(proposal, context());
    const attributed = built(
      proposal,
      context({ attribution: { version: 2, vouchedBy: 'did:key:zstaffclerk' } }),
    );
    expect(attributed.attribution).toEqual({ version: 2, vouchedBy: 'did:key:zstaffclerk' });
    expect(approvalDigest(attributed)).not.toBe(approvalDigest(bare));
  });

  it('changing WHO vouched changes what was approved', () => {
    const proposal = order();
    const byStaff = built(
      proposal,
      context({ attribution: { version: 2, vouchedBy: 'did:key:zstaffclerk' } }),
    );
    const byOwner = built(
      proposal,
      context({ attribution: { version: 2, vouchedBy: 'did:plc:sanchoowner' } }),
    );
    expect(approvalDigest(byStaff)).not.toBe(approvalDigest(byOwner));
    // And the binding refuses the swap: an executing payload claiming a
    // different voucher is not the approved one.
    expect(verifyApprovalBinding(byStaff, byOwner).ok).toBe(false);
    expect(verifyApprovalBinding(byStaff, byStaff).ok).toBe(true);
  });
});
