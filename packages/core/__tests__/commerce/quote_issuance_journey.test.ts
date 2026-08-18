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

import { validateSignedQuote, type SignedQuote } from '@dina/commerce-protocol';
import { NodeSQLiteAdapter } from '@dina/storage-node';


import { transformInboundOrderResult } from '../../src/commerce/order_decision';
import {
  createCommerceRuntime,
  installCommerceRuntime,
  type CommerceRuntime,
} from '../../src/commerce/runtime';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

import { BUYER_DID, SUPPLIER_DID, hash, makeOrder, makeQuoteRequest } from './helpers';

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
  runtime = createCommerceRuntime({
    adapter,
    supplierDid: () => SUPPLIER_DID,
    currentEpoch: () => '1',
    now: () => NOW,
  });
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
    lines: [{ line_id: 'l1', unit_price: { currency: 'INR', minor_units: '500' }, quantity: { value: '100', unit_code: 'each' } }],
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
    const quote = JSON.parse(
      (decision as { kind: 'replace'; json: string }).json,
    ) as SignedQuote;

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

    expect(runtime.admission.admitOrder(makeOrder(quote, request.delivery.projection), BUYER_DID).kind).toBe(
      'reserved',
    );
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
  it('§4.5 — the runner\'s payment terms ride the quote and its terms digest', () => {
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

  it('passes a DECLINE through as the runner’s own answer', () => {
    // "We are not quoting this" is an answer. Withholding it would read to the
    // buyer exactly like a supplier that never replied.
    const request = makeQuoteRequest();
    const decision = answerQuoteRequest(
      request,
      JSON.stringify({ can_supply: false, decline_reason: 'out of stock' }),
    );

    expect(decision).toEqual({ kind: 'passthrough' });
    expect(runtime.families.load(`q:${request.request_digest.slice(0, 32)}`)).toBeNull();
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
