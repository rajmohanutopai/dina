/**
 * Sancho ASKS ChairMaker for a price, and recognises the answer (§9.8, §12.3).
 *
 * WHAT THIS EXISTS TO PROVE, and why nothing else did. A cold audit found the
 * buyer's outbound quote lane missing entirely — nothing composed a
 * `QuoteRequest`, nothing wrote the retained-request store — while the arrival
 * path had just been taught to refuse any quote it could not match to a
 * retained request. The two halves together meant every inbound quote was
 * discarded as `unsolicited_quote` on a real node, and 8,034 tests were green
 * because the only writer was a test fixture.
 *
 * So this file writes nothing by hand. The retained request exists only
 * because `requestQuote` put it there, and the assertion that matters is that
 * an answer to THAT request reaches `applied` rather than `unsolicited_quote`.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import type { SignedQuote } from '@dina/commerce-protocol';

import {
  applyInboundBuyerResponse,
  REQUEST_QUOTE_CAPABILITY,
  REQUEST_QUOTE_WIRE_CAPABILITY,
} from '../../src/commerce/buyer_response';
import { requestQuote } from '../../src/commerce/buyer_quote_request';
import { installCommerceServiceQueryDispatch } from '../../src/commerce/buyer_sender';
import { transformInboundOrderResult } from '../../src/commerce/order_decision';
import {
  createCommerceRuntime,
  installCommerceRuntime,
  type CommerceRuntime,
} from '../../src/commerce/runtime';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

import { BUYER_DID, SUPPLIER_DID, makeProjection } from './helpers';

const NOW = Date.parse('2026-08-10T09:00:00.000Z');

let dir: string;
let adapter: NodeSQLiteAdapter;
let sent: { toDid: string; body: Record<string, unknown> }[];

function openRuntime(nodeDid: string): CommerceRuntime {
  return createCommerceRuntime({
    adapter,
    supplierDid: () => nodeDid,
    currentEpoch: () => '1',
    now: () => NOW,
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-quote-round-trip-'));
  adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  sent = [];
  installCommerceServiceQueryDispatch(async (args) => {
    sent.push({ toDid: args.toDid, body: args.body as unknown as Record<string, unknown> });
    return { sent: true };
  });
});

afterEach(() => {
  installCommerceServiceQueryDispatch(null);
  installCommerceRuntime(null);
  adapter.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const LINES = [
  {
    lineId: 'l1',
    product: { scheme: 'gtin' as const, value: '09506000134352' },
    quantity: { value: '100', unit_code: 'each' },
  },
];

async function sanchoAsks() {
  return requestQuote({
    supplierDid: SUPPLIER_DID,
    serviceRkey: 'chairs',
    requestId: 'req-chairs-1',
    idempotencyKey: 'idem-chairs-1',
    lines: LINES,
    projection: makeProjection(),
    nowMs: NOW,
  });
}

describe('the buyer asks, and can recognise the answer', () => {
  it('composes, RETAINS and sends the request', async () => {
    installCommerceRuntime(openRuntime(BUYER_DID));
    const outcome = await sanchoAsks();

    expect(outcome.kind).toBe('sent');
    // It went to the supplier, on the quote capability, correlated by the
    // request id so two dispatches of one question cannot look like two.
    expect(sent).toHaveLength(1);
    expect(sent[0].toDid).toBe(SUPPLIER_DID);
    // The WIRE spelling is the NSID — the only form a supplier listing can
    // declare. The bare spelling at the settle site below stays deliberate:
    // it proves the canonicalizer still accepts either.
    expect(sent[0].body.capability).toBe(REQUEST_QUOTE_WIRE_CAPABILITY);
    expect(sent[0].body.query_id).toBe('req-chairs-1');

    // AND IT IS RETAINED — the yardstick §9.8 measures the answer against.
    // Nothing in this test wrote that row.
    const runtime = installedRuntime();
    expect(runtime.buyerQuoteRequests.get('req-chairs-1')).not.toBeNull();
  });

  it('recognises a quote answering the request it sent', async () => {
    // THE CASE THAT WAS BROKEN. With no writer, this returned
    // `unsolicited_quote` for every quote a supplier ever sent.
    const buyer = openRuntime(BUYER_DID);
    installCommerceRuntime(buyer);
    const asked = await sanchoAsks();
    expect(asked.kind).toBe('sent');
    const request = (asked as { kind: 'sent'; request: unknown }).request;

    // ChairMaker prices it on its OWN node, through the production issuance
    // seam — no hand-built quote anywhere in this test.
    const supplier = openRuntime(SUPPLIER_DID);
    installCommerceRuntime(supplier);
    const issued = transformInboundOrderResult({
      capability: 'request_quote',
      fromDid: BUYER_DID,
      params: request,
      resultJSON: JSON.stringify({
        can_supply: true,
        lines: [
          {
            line_id: 'l1',
            unit_price: { currency: 'INR', minor_units: '500' },
            quantity: { value: '100', unit_code: 'each' },
          },
        ],
      }),
    });
    expect(issued.kind).toBe('replace');
    const quote = JSON.parse((issued as { kind: 'replace'; json: string }).json) as SignedQuote;

    // Back on Sancho's node, the answer arrives over the response lane.
    installCommerceRuntime(buyer);
    const outcome = applyInboundBuyerResponse({
      supplierDid: SUPPLIER_DID,
      response: {
        capability: REQUEST_QUOTE_CAPABILITY,
        query_id: 'req-chairs-1',
        status: 'success',
        result: { quote },
      },
      nowMs: NOW,
    });

    expect(outcome).toBe('applied');
    expect(buyer.buyerQuotes.chain(SUPPLIER_DID, quote.quote_id)).toHaveLength(1);
  });

  it('still refuses a quote for a request it never sent', async () => {
    // The guard the round trip is built on must keep working: recognising our
    // own question must not mean accepting anybody's answer.
    const buyer = openRuntime(BUYER_DID);
    installCommerceRuntime(buyer);
    await sanchoAsks();

    const supplier = openRuntime(SUPPLIER_DID);
    installCommerceRuntime(supplier);
    // A request Sancho never sent — same shape, different id.
    const strangerRequest = {
      ...(JSON.parse(JSON.stringify(sent[0].body.params)) as Record<string, unknown>),
    };
    installCommerceRuntime(buyer);

    const outcome = applyInboundBuyerResponse({
      supplierDid: SUPPLIER_DID,
      response: {
        capability: REQUEST_QUOTE_CAPABILITY,
        query_id: 'req-never-asked',
        status: 'success',
        result: { quote: { ...strangerRequest, request_id: 'req-never-asked' } },
      },
      nowMs: NOW,
    });

    expect(outcome).not.toBe('applied');
  });

  it('refuses to ask the same question twice', async () => {
    // One question, one retained document. A second compose under the same id
    // would give the answer two yardsticks that could disagree.
    installCommerceRuntime(openRuntime(BUYER_DID));
    expect((await sanchoAsks()).kind).toBe('sent');
    expect(await sanchoAsks()).toEqual({ kind: 'refused', reason: 'duplicate_request' });
    // And nothing went out the second time.
    expect(sent).toHaveLength(1);
  });
});

/** The runtime currently installed, for assertions about what it holds. */
function installedRuntime(): CommerceRuntime {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('../../src/commerce/runtime') as {
    getCommerceRuntime: () => CommerceRuntime | null;
  };
  const runtime = mod.getCommerceRuntime();
  if (runtime === null) throw new Error('no commerce runtime installed');
  return runtime;
}
