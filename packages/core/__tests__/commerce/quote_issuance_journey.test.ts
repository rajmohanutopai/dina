/**
 * Sancho asks ChairMaker for a price, and then orders — with NOTHING
 * hand-registered (§9.8, §9.9, §9.12).
 *
 * WHY THIS FILE HAD TO EXIST. Every other journey in this directory calls
 * `admission.registerSignedQuote(quote)` itself before ordering, and the quote
 * it registers is built by a TEST helper. That made all of them pass while the
 * production quote lane did not exist: nothing outside `__tests__` ever
 * constructed a `SignedQuote`, nothing ever wrote the `request`-domain receipt
 * admission demands, and `request_quote` fell through the workflow seam to
 * `passthrough`. The suites proved the engines agree with one another. They
 * could not prove a quote can be ISSUED, because they supplied that step.
 *
 * So the rule here is simple and is the whole point: this file never touches
 * `registerSignedQuote`, never calls `makeSignedQuote`, and never writes a
 * receipt. The only way a quote comes into existence is the seam a real runner
 * answer travels through. If that seam regresses, these cases fail — which is
 * exactly what did not happen last time.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { readQuoteDecline, validateSignedQuote, type SignedQuote } from '@dina/commerce-protocol';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import { transformInboundOrderResult } from '../../src/commerce/order_decision';
import { SUPPLIER_REFERENCE_MANIFEST } from '../../src/commerce/reference_manifests';
import {
  createCommerceRuntime,
  installCommerceRuntime,
  type CommerceRuntime,
} from '../../src/commerce/runtime';
import { ValueModelStore } from '../../src/commitment/model_store';
import { StandingChoiceStore } from '../../src/commitment/standing_choices';
import { StrategyStore } from '../../src/commitment/strategy_store';
import { setOwnerTimeZone } from '../../src/settings/owner_settings';
import { validatePluginResult } from '../../src/plugins/dispatch';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

import {
  BUYER_DID,
  SUPPLIER_DID,
  hash,
  makeOrder,
  makeQuoteRequest,
  withPublishedCatalogue,
} from './helpers';

const NOW = Date.parse('2026-08-10T09:00:00.000Z');

let dir: string;
let adapter: NodeSQLiteAdapter;
let runtime: CommerceRuntime;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-quote-issuance-'));
  adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  runtime = withPublishedCatalogue(
    createCommerceRuntime({
      adapter,
      supplierDid: () => SUPPLIER_DID,
      currentEpoch: () => '1',
      now: () => NOW,
    }),
  );
  installCommerceRuntime(runtime);
});

afterEach(() => {
  installCommerceRuntime(null);
  adapter.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** ChairMaker's runner: terms, never a signed record. */
function runnerTerms(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    can_supply: true,
    lines: [
      {
        line_id: 'l1',
        unit_price: { currency: 'INR', minor_units: '500' },
        quantity: { value: '100', unit_code: 'each' },
      },
    ],
    ...overrides,
  });
}

/** Drive the real workflow seam, as the ingress bridge does on completion. */
function answerQuoteRequest(request: unknown, resultJSON: string, fromDid = BUYER_DID) {
  return transformInboundOrderResult({
    capability: 'request_quote',
    fromDid,
    params: request,
    resultJSON,
  });
}

describe('a quote is born on the production seam', () => {
  it('turns the runner’s terms into a signed, registered quote', () => {
    const request = makeQuoteRequest();

    const decision = answerQuoteRequest(request, runnerTerms());

    // The runner's answer is REPLACED, not passed through.
    expect(decision.kind).toBe('replace');
    const quote = JSON.parse((decision as { kind: 'replace'; json: string }).json) as SignedQuote;

    // A real record: Core's own validator accepts it, digests and all.
    expect(validateSignedQuote(quote, hash)).toBeNull();
    expect(quote.supplier_did).toBe(SUPPLIER_DID);
    expect(quote.buyer_did).toBe(BUYER_DID);
    // §9.8 — bound to the question it answers and to the projection the buyer
    // priced against. These are the two bindings a buyer re-derives.
    expect(quote.request_digest).toBe(request.request_digest);
    expect(quote.priced_delivery_projection_digest).toBe(
      request.delivery.projection.projection_digest,
    );
    // The arithmetic is Core's, not the runner's: 100 each at 500 minor units.
    expect(quote.total).toEqual({ currency: 'INR', minor_units: '50000' });

    // THE FAMILY EXISTS. Nothing in this test registered it.
    expect(runtime.families.load(quote.quote_id)).not.toBeNull();
    // AND THE REQUEST WAS RETAINED — the receipt admission measures a later
    // order's projection against, which nothing used to write.
    const retained = runtime.receipts.get(request.request_digest);
    expect(retained?.domain).toBe('request');
  });

  it('admits an order against the quote it just issued', () => {
    // THE CASE THAT WAS IMPOSSIBLE. With no family and no retained request,
    // admission answered `quote_unknown` for every order on a real node — so
    // this is the assertion that the supplier lane works end to end.
    const request = makeQuoteRequest();
    const issued = answerQuoteRequest(request, runnerTerms());
    const quote = JSON.parse((issued as { kind: 'replace'; json: string }).json) as SignedQuote;

    const order = makeOrder(quote, request.delivery.projection);
    const admitted = runtime.admission.admitOrder(order, BUYER_DID);

    expect(admitted.kind).toBe('reserved');
  });

  it('spends the quote’s capacity, so a second order is refused', () => {
    // §9.9 — the use counter exists because issuance created it. Before, there
    // was no counter at all to spend.
    const request = makeQuoteRequest();
    const issued = answerQuoteRequest(request, runnerTerms());
    const quote = JSON.parse((issued as { kind: 'replace'; json: string }).json) as SignedQuote;

    expect(
      runtime.admission.admitOrder(makeOrder(quote, request.delivery.projection), BUYER_DID).kind,
    ).toBe('reserved');
    const second = runtime.admission.admitOrder(
      makeOrder(quote, request.delivery.projection, { purchase_order_id: 'po-second' }),
      BUYER_DID,
    );
    expect(second.kind).not.toBe('reserved');
  });

  it('is idempotent: the same request re-answered does not mint a rival quote', () => {
    // A replayed `request_quote` must not create a second family the buyer
    // could also spend. The quote id derives from the request digest, so the
    // second answer collapses onto the first.
    const request = makeQuoteRequest();
    const first = answerQuoteRequest(request, runnerTerms());
    const second = answerQuoteRequest(request, runnerTerms());

    const a = JSON.parse((first as { kind: 'replace'; json: string }).json) as SignedQuote;
    expect(second.kind).toBe('replace');
    const b = JSON.parse((second as { kind: 'replace'; json: string }).json) as SignedQuote;
    expect(b.quote_id).toBe(a.quote_id);
    expect(b.quote_digest).toBe(a.quote_digest);
  });
});

describe('what the seam refuses', () => {
  it("§4.5 — the runner's payment terms ride the quote and its terms digest", () => {
    const request = makeQuoteRequest({ protocol_version: '1.1' });
    const decision = answerQuoteRequest(
      request,
      runnerTerms({ payment_terms: { credit_days: 15, due_basis: 'from_delivery' } }),
    );
    expect(decision.kind).toBe('replace');
    const quote = JSON.parse((decision as { kind: 'replace'; json: string }).json) as {
      payment_terms?: { credit_days: number; due_basis: string };
      protocol_version: string;
    };
    expect(quote.protocol_version).toBe('1.1');
    expect(quote.payment_terms).toEqual({ credit_days: 15, due_basis: 'from_delivery' });
  });

  it('§4.5 — due_basis in a 1.0 conversation WITHHOLDS rather than ships an invalid quote', () => {
    const request = makeQuoteRequest({ protocol_version: '1.0' });
    const decision = answerQuoteRequest(
      request,
      runnerTerms({ payment_terms: { credit_days: 15, due_basis: 'from_delivery' } }),
    );
    expect(decision.kind).toBe('withhold');
  });

  it('refuses a request that names a different buyer than the sender', () => {
    // §9.8 audience binding, on the AUTHENTICATED sender. The body's
    // `buyer_did` is a claim; a supplier that priced for whoever asked would
    // hand any peer a quote addressed to someone else.
    const request = makeQuoteRequest();
    const decision = answerQuoteRequest(request, runnerTerms(), 'did:plc:someone-else');

    expect(decision).toEqual({ kind: 'withhold', reason: 'request_not_yours' });
    expect(runtime.receipts.get(request.request_digest)).toBeNull();
  });

  it('refuses terms that do not price every requested line', () => {
    // A partial answer is not a quote for the question asked; accepting it
    // would let a buyer accept terms for goods nobody committed to.
    const request = makeQuoteRequest();
    const decision = answerQuoteRequest(request, JSON.stringify({ can_supply: true, lines: [] }));

    expect(decision).toEqual({ kind: 'withhold', reason: 'terms_unusable' });
  });

  it('refuses an unreadable runner answer rather than quoting', () => {
    const request = makeQuoteRequest();
    expect(answerQuoteRequest(request, '{ not json')).toEqual({
      kind: 'withhold',
      reason: 'terms_unusable',
    });
    // Nothing was written on the way to refusing.
    expect(runtime.receipts.get(request.request_digest)).toBeNull();
  });

  it('seals a DECLINE as a QuoteDecline that REPLACES the runner’s answer, and replays it (§3.4)', () => {
    // "We are not quoting this" is an answer. Withholding it would read to the
    // buyer exactly like a supplier that never replied — and the runner's own
    // unsigned words would arrive unverifiable and be dropped. So Core seals it.
    const request = makeQuoteRequest();
    const decision = answerQuoteRequest(
      request,
      JSON.stringify({ can_supply: false, decline_reason: 'out of stock' }),
    );

    expect(decision.kind).toBe('replace');
    const wire = JSON.parse((decision as { kind: 'replace'; json: string }).json) as {
      decline: unknown;
    };
    const read = readQuoteDecline(wire.decline, hash);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.decline).toMatchObject({
      request_id: request.request_id,
      request_digest: request.request_digest,
      buyer_did: request.buyer_did,
      supplier_did: SUPPLIER_DID,
      reason_code: 'out of stock',
    });
    // Retained on the money-free decline slice, outbound — no quote family.
    const held = runtime.declineDocuments.answersTo(request.request_digest);
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ direction: 'outbound', counterpartyDid: request.buyer_did });
    expect(runtime.families.load(`q:${request.request_digest.slice(0, 32)}`)).toBeNull();

    // A repeated request replays the SAME decline — never a second digest.
    const again = answerQuoteRequest(
      request,
      JSON.stringify({ can_supply: false, decline_reason: 'still out of stock' }),
    );
    const againWire = JSON.parse((again as { kind: 'replace'; json: string }).json) as {
      decline: { decline_digest: string };
    };
    expect(againWire.decline.decline_digest).toBe(read.decline.decline_digest);
    expect(runtime.declineDocuments.answersTo(request.request_digest)).toHaveLength(1);
  });

  it('the PINNED request-quote result schema admits the decline shape Core seals', () => {
    // On the plugin lane the runner's completion meets the pinned schema BEFORE
    // Core sees it. A decline carries no `lines`; requiring them refused every
    // decline at the door and the transformer's tests never noticed.
    const requestQuote = SUPPLIER_REFERENCE_MANIFEST.capabilities.find((c) =>
      c.id.endsWith('request-quote'),
    );
    if (requestQuote === undefined) throw new Error('reference manifest lost request-quote');
    const pinned = requestQuote.result_schema;
    expect(
      validatePluginResult(
        JSON.stringify({ can_supply: false, decline_reason: 'out of stock' }),
        pinned,
      ).ok,
    ).toBe(true);
    expect(validatePluginResult(JSON.stringify({ can_supply: false }), pinned).ok).toBe(true);
    // A supply still needs its lines — the bound moved to Core, not away.
    expect(answerQuoteRequest(makeQuoteRequest(), JSON.stringify({ can_supply: true }))).toEqual({
      kind: 'withhold',
      reason: 'terms_unusable',
    });
  });

  it('a request already DECLINED is never quoted afterwards — the retained decline replays', () => {
    const request = makeQuoteRequest();
    const declined = answerQuoteRequest(
      request,
      JSON.stringify({ can_supply: false, decline_reason: 'capacity' }),
    );
    expect(declined.kind).toBe('replace');
    const first = JSON.parse((declined as { kind: 'replace'; json: string }).json) as {
      decline: { decline_digest: string };
    };

    // The runner changes its mind on a redelivered request.
    const later = answerQuoteRequest(request, runnerTerms());
    expect(later.kind).toBe('replace');
    const wire = JSON.parse((later as { kind: 'replace'; json: string }).json) as {
      decline?: { decline_digest: string };
      quote_id?: string;
    };
    expect(wire.decline?.decline_digest).toBe(first.decline.decline_digest);
    expect(wire.quote_id).toBeUndefined();
    expect(runtime.families.load(`q:${request.request_digest.slice(0, 32)}`)).toBeNull();
  });

  it('a decline with no stated reason, or an over-long one, still seals within the wire bound', () => {
    const bare = answerQuoteRequest(makeQuoteRequest(), JSON.stringify({ can_supply: false }));
    expect(bare.kind).toBe('replace');
    const bareWire = JSON.parse((bare as { kind: 'replace'; json: string }).json) as {
      decline: { reason_code: string };
    };
    expect(bareWire.decline.reason_code).toBe('declined');

    const long = answerQuoteRequest(
      makeQuoteRequest({ request_id: 'req-long' }),
      JSON.stringify({ can_supply: false, decline_reason: 'x'.repeat(500) }),
    );
    expect(long.kind).toBe('replace');
    const longWire = JSON.parse((long as { kind: 'replace'; json: string }).json) as {
      decline: { reason_code: string };
    };
    expect(longWire.decline.reason_code).toHaveLength(64);
  });

  it('refuses to sign before an epoch is published (§16.2)', () => {
    // Fail-closed: a node that stamped a guessed epoch would produce records
    // no restore fence could place.
    installCommerceRuntime(
      createCommerceRuntime({
        adapter,
        supplierDid: () => SUPPLIER_DID,
        currentEpoch: () => {
          throw new Error('commerce: no epoch published');
        },
        now: () => NOW,
      }),
    );

    expect(answerQuoteRequest(makeQuoteRequest(), runnerTerms())).toEqual({
      kind: 'withhold',
      reason: 'commerce_unavailable',
    });
  });
});

describe('a quote with another delivery day (COMMITMENT_KERNEL §6, §15 step 6)', () => {
  const delivery = (minor: string) => ({
    kind: 'delivery',
    label: 'Delivery',
    amount: { currency: 'INR', minor_units: minor },
    operation: 'add',
  });
  const tuesdayTerms = () =>
    runnerTerms({
      charges: [delivery('10000')],
      estimated_delivery_at: '2026-08-14T10:00:00Z',
      // "My van passes your way on Tuesday: ₹40 less if you take it then."
      alternatives: [
        {
          alternative_id: 'tue',
          charges: [delivery('6000')],
          estimated_delivery_at: '2026-08-11T10:00:00Z',
        },
      ],
    });

  it("Core prices the alternative and the buyer's order takes it", () => {
    const request = makeQuoteRequest({ protocol_version: '1.3' });
    const issued = answerQuoteRequest(request, tuesdayTerms());
    const quote = JSON.parse((issued as { kind: 'replace'; json: string }).json) as SignedQuote;
    expect(validateSignedQuote(quote, hash)).toBeNull();
    expect(quote.total.minor_units).toBe('60000');
    expect(quote.alternatives).toEqual([
      expect.objectContaining({
        alternative_id: 'tue',
        total: { currency: 'INR', minor_units: '56000' },
        estimated_delivery_at: '2026-08-11T10:00:00Z',
      }),
    ]);
    const tue = quote.alternatives?.[0];
    const order = makeOrder(quote, request.delivery.projection, {
      protocol_version: '1.3',
      alternative_id: 'tue',
      approved_total: tue?.total,
      accepted_terms_digest: tue?.terms_digest,
    });
    expect(runtime.admission.admitOrder(order, BUYER_DID).kind).toBe('reserved');
  });

  it('a buyer who asked at 1.0 gets no alternatives', () => {
    const request = makeQuoteRequest();
    const issued = answerQuoteRequest(request, tuesdayTerms());
    const quote = JSON.parse((issued as { kind: 'replace'; json: string }).json) as SignedQuote;
    expect(validateSignedQuote(quote, hash)).toBeNull();
    expect(quote.alternatives).toBeUndefined();
  });

  it('a malformed field the runner states withholds the quote, never drops the field', () => {
    for (const bad of [
      { charges: delivery('10000') },
      { estimated_delivery_at: 20260811 },
      { alternatives: { alternative_id: 'tue' } },
      { alternatives: [{ alternative_id: 'tue', charges: [], estimated_delivery_at: '2026-08-11T10:00:00Z', extra: 1 }] },
    ]) {
      const decision = answerQuoteRequest(makeQuoteRequest({ protocol_version: '1.3' }), runnerTerms(bad));
      expect(decision.kind).not.toBe('replace');
    }
  });
});

describe('the seller\'s own costs make the cheaper day (COMMITMENT_KERNEL §3, §15 step 6)', () => {
  beforeEach(async () => {
    await setOwnerTimeZone('UTC');
  });

  /** The seller's day costs, and a Friday quote of ₹650 (₹150 of it delivery). */
  function quoteWithCosts(costs: readonly (readonly [string, bigint])[], requestId = 'req-1'): SignedQuote {
    const model = new ValueModelStore(adapter);
    for (const [day, rupees] of costs)
      model.putEntry(
        { id: day, kind: 'goods.seller', covers: ['delivery_day'], body: { type: 'choice', part: 'delivery_day', option: day, rupees } },
        NOW,
      );
    const issued = answerQuoteRequest(
      makeQuoteRequest({ protocol_version: '1.3', request_id: requestId, idempotency_key: `idem-${requestId}` }),
      runnerTerms({
        charges: [{ kind: 'delivery', label: 'Delivery', amount: { currency: 'INR', minor_units: '15000' }, operation: 'add' }],
        estimated_delivery_at: '2030-08-16T10:00:00Z', // a Friday
      }),
    );
    expect(issued.kind).toBe('replace');
    const quote = JSON.parse((issued as { kind: 'replace'; json: string }).json) as SignedQuote;
    expect(validateSignedQuote(quote, hash)).toBeNull();
    return quote;
  }

  it('a persona holding the seller\'s rules is closed: nothing is quoted until it opens (§15 step 10)', () => {
    // A sealed never-rule may forbid the quote's own day, so Core cannot
    // say the runner's terms are inside the owner's rules: it withholds.
    const real = runtime.goodsSellerModel;
    runtime.goodsSellerModel = () => ({ model: real?.()?.model ?? null, closedPersonas: ['health'] });
    const issued = answerQuoteRequest(
      makeQuoteRequest({ protocol_version: '1.3' }),
      runnerTerms({ estimated_delivery_at: '2030-08-16T10:00:00Z' }),
    );
    expect(issued).toEqual({ kind: 'withhold', reason: 'persona_closed' });
  });

  it('a quote already at the charge limit: the cheaper day is dropped, the quote goes out', () => {
    const model = new ValueModelStore(adapter);
    for (const [day, rupees] of [['fri', -120n], ['tue', -40n]] as const)
      model.putEntry(
        { id: day, kind: 'goods.seller', covers: ['delivery_day'], body: { type: 'choice', part: 'delivery_day', option: day, rupees } },
        NOW,
      );
    const charges = Array.from({ length: 20 }, (_, i) => ({
      kind: 'delivery',
      label: `Leg ${String(i + 1)}`,
      amount: { currency: 'INR', minor_units: '1000' },
      operation: 'add',
    }));
    const issued = answerQuoteRequest(
      makeQuoteRequest({ protocol_version: '1.3' }),
      runnerTerms({ charges, estimated_delivery_at: '2030-08-16T10:00:00Z' }),
    );
    expect(issued.kind).toBe('replace');
    const quote = JSON.parse((issued as { kind: 'replace'; json: string }).json) as SignedQuote;
    expect(validateSignedQuote(quote, hash)).toBeNull();
    expect(quote.alternatives).toBeUndefined();
  });

  it('a saving larger than the order: the quote still goes out, without that day', () => {
    // Half of ₹4,900 is more than the whole order.
    const quote = quoteWithCosts([['fri', -5000n], ['tue', -100n]]);
    expect(quote.alternatives).toBeUndefined();
  });

  it('Friday is quoted; Tuesday, which saves the seller ₹80, is offered ₹40 cheaper', () => {
    const model = new ValueModelStore(adapter);
    for (const [day, rupees] of [['fri', -120n], ['tue', -40n]] as const)
      model.putEntry(
        { id: day, kind: 'goods.seller', covers: ['delivery_day'], body: { type: 'choice', part: 'delivery_day', option: day, rupees } },
        NOW,
      );
    const request = makeQuoteRequest({ protocol_version: '1.3' });
    const issued = answerQuoteRequest(
      request,
      runnerTerms({
        charges: [{ kind: 'delivery', label: 'Delivery', amount: { currency: 'INR', minor_units: '15000' }, operation: 'add' }],
        // Days ahead of the real clock this seam reads.
        estimated_delivery_at: '2030-08-16T10:00:00Z', // a Friday
      }),
    );
    const quote = JSON.parse((issued as { kind: 'replace'; json: string }).json) as SignedQuote;
    expect(validateSignedQuote(quote, hash)).toBeNull();
    expect(quote.total.minor_units).toBe('65000');
    expect(quote.alternatives).toEqual([
      expect.objectContaining({
        alternative_id: 'tue',
        estimated_delivery_at: '2030-08-13T10:00:00Z', // that Tuesday
        total: { currency: 'INR', minor_units: '61000' },
      }),
    ]);
  });

  it('§15 step 11: Brain’s standing share passes on a quarter; back on the fixed style, the owner’s half', () => {
    const strategies = new StrategyStore(adapter);
    strategies.setSettings('goods.seller', { strategy: 'brain', valuesOn: true }, NOW);
    new StandingChoiceStore(adapter).set('goods.seller', 'saving_share_bps', '2500', 'brain', NOW);
    const tuesday = (requestId: string) => {
      const quote = quoteWithCosts(
        [
          ['fri', -120n],
          ['tue', -40n],
        ],
        requestId,
      );
      return quote.alternatives?.[0]?.total.minor_units;
    };
    // ₹80 saved: a quarter is ₹20 off the ₹650 quote.
    expect(tuesday('req-q1')).toBe('63000');
    strategies.setSettings('goods.seller', { strategy: 'fixed', valuesOn: true }, NOW);
    expect(tuesday('req-q2')).toBe('61000');
  });

  it('§15 step 11: the owner’s later choice of share replaces Brain’s; Brain may set its own again', () => {
    const strategies = new StrategyStore(adapter);
    strategies.setSettings('goods.seller', { strategy: 'brain', valuesOn: true }, NOW);
    const choices = new StandingChoiceStore(adapter);
    choices.set('goods.seller', 'saving_share_bps', '7000', 'brain', NOW);
    const tuesday = (requestId: string) =>
      quoteWithCosts(
        [
          ['fri', -120n],
          ['tue', -40n],
        ],
        requestId,
      ).alternatives?.[0]?.total.minor_units;
    // ₹80 saved: 70% is ₹56 off.
    expect(tuesday('req-o1')).toBe('59400');
    // The owner then chooses a third: ₹26 off (whole rupees, rounded down).
    new ValueModelStore(adapter).putEntry(
      {
        id: 'saving_share',
        kind: 'goods.seller',
        covers: ['saving_share'],
        body: { type: 'choice', part: 'saving_share', option: 'third', rupees: 1n },
      },
      NOW + 1,
    );
    expect(tuesday('req-o2')).toBe('62400');
    // Brain's next change is its own again.
    choices.set('goods.seller', 'saving_share_bps', '2500', 'brain', NOW + 2);
    expect(tuesday('req-o3')).toBe('63000');
  });
});

