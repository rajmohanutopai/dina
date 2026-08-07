import {
  effectiveMaxUses,
  validateQuoteRequest,
  validateSignedQuote,
  verifyQuoteRevisionExtends,
  verifySignedQuoteForBuyer,
  type BuyerQuoteContext,
} from '../src/quote';

import {
  BUYER_DID,
  SUPPLIER_DID,
  hash,
  inr,
  makeProjection,
  makeQuoteRequest,
  makeRevision,
  makeSignedQuote,
} from './helpers/fixtures';

describe('validateQuoteRequest', () => {
  it('accepts a canonical request', () => {
    expect(validateQuoteRequest(makeQuoteRequest(), hash)).toBeNull();
  });

  it('rejects duplicate lineIds', () => {
    const request = makeQuoteRequest({
      lines: [
        {
          line_id: 'l1',
          product: { scheme: 'gtin', value: '09506000134352' },
          requested_quantity: { value: '1', unit_code: 'each' },
        },
        {
          line_id: 'l1',
          product: { scheme: 'gtin', value: '09506000134352' },
          requested_quantity: { value: '2', unit_code: 'each' },
        },
      ],
    });
    expect(validateQuoteRequest(request, hash)).toMatch(/duplicate line_id/);
  });

  it('rejects zero quantities and bad substitution values', () => {
    expect(
      validateQuoteRequest(
        makeQuoteRequest({
          lines: [
            {
              line_id: 'l1',
              product: { scheme: 'gtin', value: '09506000134352' },
              requested_quantity: { value: '0', unit_code: 'each' },
            },
          ],
        }),
        hash,
      ),
    ).toMatch(/positive/);
  });

  it('rejects expiry at or before issue', () => {
    const request = makeQuoteRequest({ expires_at: '2026-08-07T10:00:00Z' });
    expect(validateQuoteRequest(request, hash)).toMatch(/after issued_at/);
  });

  it('rejects a tampered request_digest', () => {
    const request = { ...makeQuoteRequest(), idempotency_key: 'idem-other' };
    expect(validateQuoteRequest(request, hash)).toMatch(/does not match/);
  });
});

describe('validateSignedQuote', () => {
  it('accepts a §9.1-consistent quote', () => {
    expect(validateSignedQuote(makeSignedQuote(), hash)).toBeNull();
  });

  it('rejects a tampered line_subtotal (transmitted totals are checked, not trusted)', () => {
    const quote = makeSignedQuote();
    const [firstLine] = quote.lines;
    if (!firstLine) throw new Error('fixture has no lines');
    firstLine.line_subtotal = inr('49999');
    expect(validateSignedQuote(quote, hash)).toMatch(/does not equal the §9.1 recomputation/);
  });

  it('rejects a tampered total', () => {
    const quote = makeSignedQuote();
    quote.total = inr('1');
    expect(validateSignedQuote(quote, hash)).toMatch(/total/);
  });

  it('rejects mixed currencies', () => {
    const quote = makeSignedQuote();
    const [firstLine] = quote.lines;
    if (!firstLine) throw new Error('fixture has no lines');
    firstLine.unit_price = { currency: 'USD', minor_units: '500' };
    expect(validateSignedQuote(quote, hash)).toMatch(/mixed currencies|does not equal/);
  });

  it('enforces the revision-chain field shape', () => {
    const rev1WithPrev = makeSignedQuote({ overrides: { previous_quote_digest: 'a'.repeat(64) } });
    expect(validateSignedQuote(rev1WithPrev, hash)).toMatch(/absent on revision "1"/);

    const rev2WithoutPrev = makeSignedQuote({ overrides: { quote_revision: '2' } });
    expect(validateSignedQuote(rev2WithoutPrev, hash)).toMatch(/previous_quote_digest/);

    const rev2WithReplaces = makeSignedQuote({
      overrides: {
        quote_revision: '2',
        previous_quote_digest: 'a'.repeat(64),
        replaces_quote_digest: 'b'.repeat(64),
      },
    });
    expect(validateSignedQuote(rev2WithReplaces, hash)).toMatch(/only on a revision "1"/);

    const counterRev1 = makeSignedQuote({ overrides: { replaces_quote_digest: 'b'.repeat(64) } });
    expect(validateSignedQuote(counterRev1, hash)).toBeNull();
  });

  it('rejects non-canonical max_uses and epoch', () => {
    expect(validateSignedQuote(makeSignedQuote({ overrides: { max_uses: '0' } }), hash)).toMatch(
      /max_uses/,
    );
    expect(validateSignedQuote(makeSignedQuote({ overrides: { max_uses: '01' } }), hash)).toMatch(
      /max_uses/,
    );
    expect(
      validateSignedQuote(makeSignedQuote({ overrides: { supplier_epoch: '0' } }), hash),
    ).toMatch(/supplier_epoch/);
  });

  it('validates reservations against lines and validity window', () => {
    const unknownLine = makeSignedQuote({
      overrides: {
        reservations: [
          {
            line_id: 'nope',
            quantity_reserved: { value: '1', unit_code: 'each' },
            expires_at: '2026-08-08T08:00:00Z',
          },
        ],
      },
    });
    expect(validateSignedQuote(unknownLine, hash)).toMatch(/not a quote line/);

    const pastValidity = makeSignedQuote({
      overrides: {
        reservations: [
          {
            line_id: 'l1',
            quantity_reserved: { value: '1', unit_code: 'each' },
            expires_at: '2026-08-09T00:00:00Z',
          },
        ],
      },
    });
    expect(validateSignedQuote(pastValidity, hash)).toMatch(/must not exceed valid_until/);
  });

  it('rejects a tampered terms_digest and a tampered quote_digest', () => {
    const badTerms = makeSignedQuote();
    (badTerms as { terms_digest: string }).terms_digest = 'c'.repeat(64);
    expect(validateSignedQuote(badTerms, hash)).toMatch(/terms_digest/);

    const badQuote = makeSignedQuote();
    (badQuote as { valid_until: string }).valid_until = '2026-08-08T09:30:00Z';
    expect(validateSignedQuote(badQuote, hash)).toMatch(/terms_digest|quote_digest/);
  });
});

describe('verifySignedQuoteForBuyer', () => {
  const retainedRequest = makeQuoteRequest();
  const quote = makeSignedQuote({ request: retainedRequest });
  // Narrowed once: the fixture always builds exactly one line, and asserting
  // that at every use site is noise the lint rule is right to reject.
  const [baseLine] = quote.lines;
  const [baseRequestLine] = retainedRequest.lines;
  if (baseLine === undefined || baseRequestLine === undefined) {
    throw new Error('fixture: expected one quote line and one request line');
  }
  const context: BuyerQuoteContext = {
    buyer_did: BUYER_DID,
    authenticated_supplier_did: SUPPLIER_DID,
    retained_request_digest: quote.request_digest,
    sent_projection_digest: quote.priced_delivery_projection_digest,
    epoch_watermark: '0',
    retained_request: retainedRequest,
    // Inside the quote's validity window (valid_until 2026-08-08T09:00Z).
    at_iso: '2026-08-07T12:00:00Z',
  };

  it('accepts a quote answering the exact retained question', () => {
    expect(verifySignedQuoteForBuyer(quote, context, hash)).toBeNull();
  });

  it('rejects audience and sender mismatches', () => {
    expect(
      verifySignedQuoteForBuyer(quote, { ...context, buyer_did: 'did:plc:other' }, hash),
    ).toMatch(/audience mismatch/);
    expect(
      verifySignedQuoteForBuyer(
        quote,
        { ...context, authenticated_supplier_did: 'did:plc:mitm' },
        hash,
      ),
    ).toMatch(/transport-authenticated sender/);
  });

  it('rejects request and projection binding mismatches', () => {
    expect(
      verifySignedQuoteForBuyer(quote, { ...context, retained_request_digest: 'a'.repeat(64) }, hash),
    ).toMatch(/different question/);
    expect(
      verifySignedQuoteForBuyer(quote, { ...context, sent_projection_digest: 'b'.repeat(64) }, hash),
    ).toMatch(/projection sent at quote stage/);
  });

  it('rejects an EXPIRED quote even when everything else verifies', () => {
    // A cryptographically valid quote whose window has closed is not
    // acceptable terms. Ranking or approving one wastes the owner's decision
    // and lets a later stage refuse what the buyer already agreed to.
    expect(
      verifySignedQuoteForBuyer(quote, { ...context, at_iso: '2026-08-09T00:00:00Z' }, hash),
    ).toMatch(/valid_until has passed/);
    // The exact boundary is still inside the window.
    expect(
      verifySignedQuoteForBuyer(quote, { ...context, at_iso: quote.valid_until }, hash),
    ).toBeNull();
  });

  it('rejects a quote that INVENTS a line the buyer never requested', () => {
    // The request digest proves the supplier saw the request; it proves
    // nothing about whether the lines correspond to it.
    const invented = makeSignedQuote({
      request: retainedRequest,
      overrides: { lines: [{ ...baseLine, line_id: 'l-not-asked' }] },
    });
    expect(verifySignedQuoteForBuyer(invented, context, hash)).toMatch(/invented line/);
  });

  it('rejects a quote that renames the product the buyer asked for', () => {
    const renamed = makeSignedQuote({
      request: retainedRequest,
      overrides: {
        lines: [
          {
            ...baseLine,
            requested_product: { scheme: 'gtin', value: '00000000000000' },
          },
        ],
      },
    });
    expect(verifySignedQuoteForBuyer(renamed, context, hash)).toMatch(/does not match the product/);
  });

  it('rejects a SUBSTITUTE where the buyer allowed none (§20.4 bait-and-switch)', () => {
    // acceptable_substitutions defaults to `none`. A supplier offering
    // something else must not rely on the buyer noticing by eye.
    const substituted = makeSignedQuote({
      request: retainedRequest,
      overrides: {
        lines: [
          {
            ...baseLine,
            offered_product: { scheme: 'gtin', value: '09506000134369' },
          },
        ],
      },
    });
    expect(verifySignedQuoteForBuyer(substituted, context, hash)).toMatch(/allowed none/);
  });

  it('accepts a permitted substitution that carries evidence, and refuses one that does not', () => {
    const permissive = makeQuoteRequest({
      lines: [{ ...baseRequestLine, acceptable_substitutions: 'equivalent' }],
    });
    const base = makeSignedQuote({ request: permissive });
    const [permissiveLine] = base.lines;
    if (permissiveLine === undefined) throw new Error('fixture: expected one line');
    const withoutEvidence = makeSignedQuote({
      request: permissive,
      overrides: {
        lines: [{ ...permissiveLine, offered_product: { scheme: 'gtin', value: '09506000134369' } }],
      },
    });
    const permissiveContext: BuyerQuoteContext = {
      ...context,
      retained_request: permissive,
      retained_request_digest: base.request_digest,
      sent_projection_digest: base.priced_delivery_projection_digest,
    };
    expect(verifySignedQuoteForBuyer(withoutEvidence, permissiveContext, hash)).toMatch(
      /substitution_evidence/,
    );

    const withEvidence = makeSignedQuote({
      request: permissive,
      overrides: {
        lines: [
          {
            ...permissiveLine,
            offered_product: { scheme: 'gtin', value: '09506000134369' },
            substitution_evidence: ['same formulation, different pack'],
          },
        ],
      },
    });
    expect(verifySignedQuoteForBuyer(withEvidence, permissiveContext, hash)).toBeNull();
  });

  it('rejects an epoch below the watermark (§16.2 restore fence)', () => {
    expect(verifySignedQuoteForBuyer(quote, { ...context, epoch_watermark: '2' }, hash)).toMatch(
      /below the watermark/,
    );
  });
});

describe('verifyQuoteRevisionExtends', () => {
  const held = makeSignedQuote();

  it('accepts head+1 extending the held digest', () => {
    expect(verifyQuoteRevisionExtends(held, makeRevision(held))).toBeNull();
  });

  it('rejects a fork (previous_quote_digest not the held head)', () => {
    const fork = makeRevision(held, { previous_quote_digest: 'd'.repeat(64) });
    expect(verifyQuoteRevisionExtends(held, fork)).toMatch(/supplier fork/);
  });

  it('rejects a skipped or repeated revision number', () => {
    expect(verifyQuoteRevisionExtends(held, makeRevision(held, { quote_revision: '3' }))).toMatch(
      /expected revision 2/,
    );
  });

  it('rejects a changed max_uses — immutable within a quote_id', () => {
    expect(verifyQuoteRevisionExtends(held, makeRevision(held, { max_uses: '5' }))).toMatch(
      /max_uses is immutable/,
    );
  });

  it('rejects changed identity fields and epoch regression', () => {
    expect(
      verifyQuoteRevisionExtends(held, makeRevision(held, { buyer_did: 'did:plc:other' })),
    ).toMatch(/immutable field buyer_did/);
  });

  it('rejects supplier_epoch regression within a chain', () => {
    const heldAtEpoch2 = makeSignedQuote({ overrides: { supplier_epoch: '2' } });
    const regressed = makeRevision(heldAtEpoch2, { supplier_epoch: '1' });
    expect(verifyQuoteRevisionExtends(heldAtEpoch2, regressed)).toMatch(/supplier_epoch regressed/);
  });

  it('defaults max_uses to "1"', () => {
    expect(effectiveMaxUses({})).toBe(1n);
    expect(effectiveMaxUses({ max_uses: '3' })).toBe(3n);
  });
});

describe('quote-stage projection width', () => {
  it('a widened projection at order stage digests differently (stage recompute)', () => {
    const quoteStage = makeProjection();
    const orderStage = makeProjection({ address_lines: ['12 Harbour Rd'] });
    expect(quoteStage.projection_digest).not.toBe(orderStage.projection_digest);
  });
});
