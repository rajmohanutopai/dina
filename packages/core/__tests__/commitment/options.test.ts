/**
 * COMMITMENT_KERNEL §6 "How linked deals bind", §15 step 7 — firm options
 * between a seller and its shipper, on two nodes, each through a restart.
 * In every case both nodes end with the same binding history and the same
 * capacity held, and expired capacity can be reused.
 *
 *   O-01  the grant comes first: no grant (or one not naming the pincode to
 *         shippers), no request; no known shipper, no request;
 *   O-02  the shipper issues a firm option from its own model (the run's
 *         cost, never under its floor; the model version recorded); a resent
 *         request gets the same option; a full day, a day with no run, a
 *         closed persona, a run too soon: declined;
 *   O-03  a day Z inside the hold and grace: the shipper declines, and an
 *         option that does not fit is refused by the seller;
 *   O-04  taken up, sent, admitted: both bound; a tighter shipper model after
 *         issue does not revoke the option (checked against its version);
 *   O-05  a crash between recording and sending, a lost acceptance, a resend
 *         after restart: the tick resends; bound;
 *   O-06  a crash after the shipper admitted, before the receipt arrived: the
 *         resend gets the same stored answer; bound;
 *   O-07  a yes as the hold ends: nothing is taken up;
 *   O-08  the shipper offline past the grace, or neither node reconnecting
 *         until after it: the seller only asks, and the stored answer is
 *         "arrived after the grace" — a lapse with no fault;
 *   O-09  never exercised: the option expires with no message and its crates
 *         are free again; an acceptance first arriving after expiry gets the
 *         stored late answer;
 *   O-10  still unknown at the lead time before the run: one card.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { deliveryDayOf } from '../../src/commerce/deal_kinds';
import { DEPENDENT_TIMINGS } from '../../src/commitment/dependent';
import { assemble } from '../../src/commitment/model_store';
import {
  admitOptionAnswer,
  admitReceipt,
  answerOptionRequest,
  answerOptionTakeUp,
  askShippers,
  optionLinkWork,
  parseOptionMessage,
  SellerOptionStore,
  ShipperOptionStore,
  type OptionBody,
  type OptionMessage,
  type OptionRequestBody,
} from '../../src/commitment/options';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

const H = 60 * 60 * 1000;
const D = 24 * H;
const SELLER = 'did:plc:seller';
const SHIPPER = 'did:plc:shipper';
const t0 = Date.parse('2026-11-02T09:00:00Z'); // a Monday
const TUESDAY_RUN = '2026-11-10T09:00:00Z';
const GRANT = { fields: ['postal_code'], recipientRole: 'shipper' };

const shipperModel = (version = 1, crates = 10n, tuesday = -300n) =>
  assemble(
    'delivery.shipper',
    version,
    { limits: { fee: { hard: 20_000n, auto: 25_000n } }, totals: {}, asking: {}, binding: 'card' },
    [
      {
        id: 'tue',
        kind: 'delivery.shipper',
        covers: ['delivery_day'],
        body: { type: 'choice', part: 'delivery_day', option: 'tue', rupees: tuesday },
      },
      {
        id: 'room',
        kind: 'delivery.shipper',
        covers: ['run'],
        body: { type: 'capacity', part: 'run', dimension: 'crates', amount: crates },
      },
    ],
  );

/** Two nodes, each with its own database file; `restart` reopens both. */
function twoNodes() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-options-'));
  const key = randomBytes(32).toString('hex');
  const open = (name: string) => {
    const db = new NodeSQLiteAdapter({
      path: path.join(dir, name),
      passphraseHex: key,
      journalMode: 'WAL',
      synchronous: 'NORMAL',
    });
    applyMigrations(db, IDENTITY_MIGRATIONS);
    return db;
  };
  let sellerDb = open('seller.sqlite');
  let shipperDb = open('shipper.sqlite');
  const nodes = {
    seller: new SellerOptionStore(sellerDb),
    shipper: new ShipperOptionStore(shipperDb),
    restart() {
      sellerDb.close();
      shipperDb.close();
      sellerDb = open('seller.sqlite');
      shipperDb = open('shipper.sqlite');
      nodes.seller = new SellerOptionStore(sellerDb);
      nodes.shipper = new ShipperOptionStore(shipperDb);
    },
    close() {
      sellerDb.close();
      shipperDb.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return nodes;
}

/** Every body crosses the wire as JSON and is parsed as the receiver would. */
const wire = <T extends OptionMessage>(body: T): T =>
  parseOptionMessage(JSON.parse(JSON.stringify(body))) as T;

let nodes: ReturnType<typeof twoNodes>;
beforeEach(() => {
  nodes = twoNodes();
});
afterEach(() => nodes.close());

function ask(nowMs = t0): OptionRequestBody {
  const asked = askShippers({
    store: nodes.seller,
    dealRef: 'order-1',
    shippers: [SHIPPER],
    grant: GRANT,
    postalCode: '560001',
    serviceAt: TUESDAY_RUN,
    crates: 4,
    nowMs,
  });
  if (!asked.ok) throw new Error(asked.reason);
  return wire(asked.send[0]?.body as OptionRequestBody);
}

/** The shipper's owner asks ₹300 a run (its asking fee, in paise). */
function shipperAnswers(
  request: OptionRequestBody,
  nowMs = t0,
  model = shipperModel(),
  asking: Record<string, string> = { fee: '30000' },
) {
  return wire(
    answerOptionRequest({
      store: nodes.shipper,
      view: { model, closedPersonas: [], asking },
      sellerDid: SELLER,
      request,
      timeZone: 'UTC',
      nowMs,
      deliveryDayOf,
    }),
  );
}

/** The request already made for the deal (asking again sends nothing once it is answered). */
const firstRequest = (): OptionRequestBody =>
  nodes.seller.forDeal('order-1')[0]?.request as OptionRequestBody;

/** Ask, get the option, hold it: the state before the buyer's yes. */
function held(): OptionBody {
  const option = shipperAnswers(ask());
  expect(option.kind).toBe('option');
  expect(
    admitOptionAnswer({ store: nodes.seller, fromDid: SHIPPER, body: option, nowMs: t0 + H }),
  ).toBe('held');
  // The seller's owner clears offering it (§6 step 3).
  nodes.seller.clear(nodes.seller.forDeal('order-1')[0]?.requestId ?? '', t0 + H);
  return option as OptionBody;
}

const ORDER = 'did:plc:buyer po-1';
const requestOf = (option: OptionBody): string =>
  nodes.seller.byOption(SHIPPER, option.option_id)?.requestId ?? '';

/** Deliver whatever the seller's tick sends; return the receipts the shipper gives. */
function deliverTick(nowMs: number, reach = true) {
  const work = optionLinkWork({ store: nodes.seller, nowMs });
  if (!reach) return work;
  for (const m of work.send) {
    const body = wire(m.body);
    if (body.kind === 'request') {
      const answer = shipperAnswers(body, nowMs);
      admitOptionAnswer({ store: nodes.seller, fromDid: SHIPPER, body: answer, nowMs });
      continue;
    }
    const receipt = answerOptionTakeUp({
      store: nodes.shipper,
      sellerDid: SELLER,
      optionId: body.option_id,
      isQuery: body.kind === 'status_query',
      nowMs,
    });
    if (receipt !== null)
      admitReceipt({ store: nodes.seller, fromDid: SHIPPER, body: wire(receipt), nowMs });
  }
  return work;
}

const histories = (option: OptionBody) => ({
  seller: nodes.seller.byOption(SHIPPER, option.option_id)?.state,
  shipper: nodes.shipper.byOption(SELLER, option.option_id)?.answer?.answer ?? null,
});

describe('firm options between known partners', () => {
  it('O-01: no grant, no request; no known shipper, no request', () => {
    const base = {
      store: nodes.seller,
      dealRef: 'order-1',
      postalCode: '560001',
      serviceAt: TUESDAY_RUN,
      crates: 4,
      nowMs: t0,
    };
    expect(askShippers({ ...base, shippers: [SHIPPER], grant: null })).toEqual({
      ok: false,
      reason: 'no_grant',
    });
    expect(
      askShippers({
        ...base,
        shippers: [SHIPPER],
        grant: { fields: ['locality'], recipientRole: 'shipper' },
      }),
    ).toEqual({ ok: false, reason: 'no_grant' });
    expect(
      askShippers({
        ...base,
        shippers: [SHIPPER],
        grant: { fields: ['postal_code'], recipientRole: 'courier' },
      }),
    ).toEqual({ ok: false, reason: 'no_grant' });
    expect(askShippers({ ...base, shippers: [], grant: GRANT })).toEqual({
      ok: false,
      reason: 'no_partner',
    });
    expect(nodes.seller.forDeal('order-1')).toEqual([]);
    // With the grant: one request, the pincode and nothing finer.
    const request = ask();
    expect(Object.keys(request).sort()).toEqual([
      'crates',
      'kind',
      'postal_code',
      'request_id',
      'service_at',
      'v',
    ]);
    nodes.restart();
    expect(ask().request_id).toBe(request.request_id); // the same request, after a restart
  });

  it("O-02: the shipper's firm option, and its declines", () => {
    const request = ask();
    const option = shipperAnswers(request) as OptionBody;
    expect(option).toMatchObject({
      kind: 'option',
      fee_minor: '30000',
      crates: 4,
      model_version: 1,
    });
    expect(Date.parse(option.hold_until)).toBe(t0 + 3 * D);
    nodes.restart();
    expect(shipperAnswers(request)).toEqual(option); // a resent request: the same option
    // The fee is the owner's asking price, never the run's cost: a cheaper
    // Tuesday entry alone does not move it.
    const cheaperRun = shipperAnswers(
      { ...request, request_id: 'req-cheap' },
      t0,
      shipperModel(1, 100n, -100n),
    ) as OptionBody;
    expect(cheaperRun.fee_minor).toBe('30000');
    // Asking under what Core may agree alone (₹250): no price to offer.
    expect(
      shipperAnswers({ ...request, request_id: 'req-low' }, t0, shipperModel(1, 100n), {
        fee: '20000',
      }),
    ).toMatchObject({ reason: 'no_price' });
    expect(
      shipperAnswers({ ...request, request_id: 'req-none' }, t0, shipperModel(1, 100n), {}),
    ).toMatchObject({
      reason: 'no_price',
    });
    // 4 + 4 held of 10; 4 more do not fit.
    expect(shipperAnswers({ ...request, request_id: 'req-full' })).toMatchObject({
      kind: 'decline',
      reason: 'full',
    });
    expect(
      shipperAnswers({ ...request, request_id: 'req-wed', service_at: '2026-11-11T09:00:00Z' }),
    ).toMatchObject({ reason: 'no_run' });
    expect(
      wire(
        answerOptionRequest({
          store: nodes.shipper,
          view: { model: shipperModel(), closedPersonas: ['work'], asking: { fee: '30000' } },
          sellerDid: SELLER,
          request: { ...request, request_id: 'req-closed' },
          timeZone: 'UTC',
          nowMs: t0,
          deliveryDayOf,
        }),
      ),
    ).toMatchObject({ reason: 'closed' });
  });

  it('O-03: a run too soon is declined, and an option that does not fit is refused', () => {
    const request = ask();
    // Tuesday's run, asked on Friday noon: too little hold is left before the grace and lead time.
    expect(shipperAnswers(request, Date.parse('2026-11-06T12:00:00Z'))).toMatchObject({
      kind: 'decline',
      reason: 'too_soon',
    });
    const option = shipperAnswers({ ...request, request_id: 'req-other' }) as OptionBody;
    const unfit = { ...option, request_id: request.request_id, hold_until: '2026-11-09T09:00:00Z' };
    expect(
      admitOptionAnswer({ store: nodes.seller, fromDid: SHIPPER, body: unfit, nowMs: t0 }),
    ).toBe('refused');
    // From anyone but the shipper asked: refused.
    expect(
      admitOptionAnswer({
        store: nodes.seller,
        fromDid: 'did:plc:other',
        body: { ...option, request_id: request.request_id },
        nowMs: t0,
      }),
    ).toBe('refused');
  });

  it('O-04: taken up and admitted; a tighter model later does not revoke it', () => {
    const option = held();
    // The shipper tightens its model (no Tuesday runs) and restarts.
    shipperAnswers({ ...firstRequest(), request_id: 'req-x' }, t0, shipperModel(2, 0n));
    nodes.restart();
    expect(nodes.seller.takeUp(requestOf(option), ORDER, t0 + D)).toBe(true);
    deliverTick(t0 + D);
    expect(histories(option)).toEqual({ seller: 'bound', shipper: 'admitted' });
  });

  it('O-05: a crash before sending, a lost acceptance, a resend after restart: bound', () => {
    const option = held();
    const requestId = nodes.seller.byOption(SHIPPER, option.option_id)?.requestId ?? '';
    expect(nodes.seller.takeUp(requestId, ORDER, t0 + D)).toBe(true);
    nodes.restart(); // crashed before sending
    deliverTick(t0 + D + H, false); // sent, and lost
    expect(histories(option)).toEqual({ seller: 'accepted', shipper: null });
    expect(optionLinkWork({ store: nodes.seller, nowMs: t0 + D + H + 1 }).send).toEqual([]); // not before the next hour
    nodes.restart();
    deliverTick(t0 + D + 2 * H);
    expect(histories(option)).toEqual({ seller: 'bound', shipper: 'admitted' });
  });

  it('O-06: the shipper admitted, the receipt was lost; the resend gets the same answer', () => {
    const option = held();
    nodes.seller.takeUp(requestOf(option), ORDER, t0 + D);
    const first = answerOptionTakeUp({
      store: nodes.shipper,
      sellerDid: SELLER,
      optionId: option.option_id,
      isQuery: false,
      nowMs: t0 + D,
    });
    expect(first?.answer).toBe('admitted');
    nodes.restart(); // the receipt never reached the seller
    // The next resend comes after the grace has ended: the stored answer stands.
    deliverTick(t0 + 6 * D);
    expect(histories(option)).toEqual({ seller: 'bound', shipper: 'admitted' });
  });

  it('O-07: a yes as the hold ends takes nothing up', () => {
    const option = held();
    const requestId = nodes.seller.byOption(SHIPPER, option.option_id)?.requestId ?? '';
    expect(nodes.seller.takeUp(requestId, ORDER, Date.parse(option.hold_until))).toBe(false);
    nodes.restart();
    expect(nodes.seller.get(requestId)?.state).toBe('held');
  });

  it('O-08: the shipper offline past the grace: the seller only asks; a lapse with no fault', () => {
    const option = held();
    nodes.seller.takeUp(requestOf(option), ORDER, t0 + D);
    for (let at = t0 + D; at <= t0 + 5 * D; at += 6 * H) deliverTick(at, false); // every resend lost
    nodes.restart();
    const after = t0 + 5 * D + H;
    const work = deliverTick(after);
    expect(work.send.map((m) => m.body.kind)).toEqual(['status_query']);
    expect(histories(option)).toEqual({
      seller: 'lapsed_no_fault',
      shipper: 'arrived_after_grace',
    });
  });

  it('O-09: never exercised: it expires and its crates are free; a late acceptance gets the late answer', () => {
    const option = held();
    const graceEnd = Date.parse(option.hold_until) + DEPENDENT_TIMINGS.optionGraceMs;
    // Before expiry, 4 of 10 are held: 7 more do not fit; after, they do.
    const request = firstRequest();
    expect(
      shipperAnswers({ ...request, request_id: 'req-seven', crates: 7 }, t0 + D),
    ).toMatchObject({ reason: 'full' });
    nodes.restart();
    // A status query before expiry has no answer yet.
    expect(
      answerOptionTakeUp({
        store: nodes.shipper,
        sellerDid: SELLER,
        optionId: option.option_id,
        isQuery: true,
        nowMs: graceEnd,
      }),
    ).toBeNull();
    const late = answerOptionTakeUp({
      store: nodes.shipper,
      sellerDid: SELLER,
      optionId: option.option_id,
      isQuery: false,
      nowMs: graceEnd + 1,
    });
    expect(late?.answer).toBe('arrived_after_grace');
    expect(
      answerOptionTakeUp({
        store: nodes.shipper,
        sellerDid: SELLER,
        optionId: option.option_id,
        isQuery: true,
        nowMs: graceEnd + D,
      })?.answer,
    ).toBe('arrived_after_grace');
  });

  it('O-09b: expired crates can be taken again', () => {
    const FAR_RUN = '2026-11-24T09:00:00Z'; // a Tuesday far enough for two holds
    const request = (id: string, crates: number): OptionRequestBody => ({
      v: 1,
      kind: 'request',
      request_id: id,
      service_at: FAR_RUN,
      crates,
      postal_code: '560001',
    });
    const first = shipperAnswers(request('req-a', 6), t0) as OptionBody;
    expect(first.kind).toBe('option');
    expect(shipperAnswers(request('req-b', 6), t0 + D)).toMatchObject({ reason: 'full' });
    nodes.restart();
    // Never taken up: at its hold's end plus the grace it expires, unannounced.
    const graceEnd = Date.parse(first.hold_until) + DEPENDENT_TIMINGS.optionGraceMs;
    expect(shipperAnswers(request('req-c', 6), graceEnd + 1).kind).toBe('option');
  });

  it('O-10: unknown at the lead time before the run: one card', () => {
    const option = held();
    nodes.seller.takeUp(requestOf(option), ORDER, t0 + D);
    const leadStart = Date.parse(TUESDAY_RUN) - D;
    expect(deliverTick(leadStart - H, false).cards).toEqual([]);
    const due = deliverTick(leadStart, false).cards;
    expect(due).toHaveLength(1);
    // Until the caller has raised it and marked it, it stays due (a crash
    // between the two raises it again, never never).
    nodes.restart();
    expect(deliverTick(leadStart + H, false).cards).toHaveLength(1);
    nodes.seller.cardRaised(due[0]?.requestId ?? '');
    expect(deliverTick(leadStart + 2 * H, false).cards).toEqual([]);
  });

  it('O-11: one option, one order; and nothing before the owner clears it', () => {
    const option = shipperAnswers(ask());
    admitOptionAnswer({ store: nodes.seller, fromDid: SHIPPER, body: option, nowMs: t0 + H });
    const requestId = nodes.seller.forDeal('order-1')[0]?.requestId ?? '';
    expect(nodes.seller.takeUp(requestId, ORDER, t0 + D)).toBe(false); // not cleared
    nodes.seller.clear(requestId, t0 + H);
    expect(nodes.seller.takeUp(requestId, ORDER, t0 + D)).toBe(true);
    nodes.restart();
    expect(nodes.seller.takeUp(requestId, 'did:plc:other po-9', t0 + D)).toBe(false);
    expect(nodes.seller.takeUp(requestId, ORDER, t0 + D + H)).toBe(true); // the same order again
    expect(nodes.seller.get(requestId)?.acceptedAt).toBe(t0 + D);
  });

  it('O-12: a never-rule on the fee is judged against the fee asked', () => {
    const request = ask();
    const neverUnder350 = assemble(
      'delivery.shipper',
      1,
      {
        limits: { fee: { hard: 20_000n, auto: 25_000n } },
        totals: {},
        asking: {},
        binding: 'card',
      },
      [
        ...shipperModel().never,
        {
          id: 'tue',
          kind: 'delivery.shipper',
          covers: ['delivery_day'],
          body: { type: 'choice', part: 'delivery_day', option: 'tue', rupees: -300n },
        },
        {
          id: 'room',
          kind: 'delivery.shipper',
          covers: ['run'],
          body: { type: 'capacity', part: 'run', dimension: 'crates', amount: 10n },
        },
        {
          id: 'n',
          kind: 'delivery.shipper',
          covers: ['fee'],
          body: {
            type: 'never',
            label: 'never under ₹350',
            all: [{ part: 'fee', below: 35_000n }],
          },
        },
      ] as never,
    );
    expect(shipperAnswers(request, t0, neverUnder350)).toMatchObject({ reason: 'no_run' });
    expect(
      shipperAnswers({ ...request, request_id: 'req-b' }, t0, neverUnder350, { fee: '40000' }).kind,
    ).toBe('option');
  });

  it('O-13: a request lost on the way is sent again, and closed once too late', () => {
    const lost = ask(); // sent, and lost
    nodes.seller.sent(lost.request_id, t0);
    nodes.restart();
    expect(deliverTick(t0 + 30 * 60_000, false).send).toEqual([]); // not before the hour
    deliverTick(t0 + H); // sent again, answered
    expect(nodes.seller.forDeal('order-1')[0]?.state).toBe('held');
    // Another, never answered: past the last useful moment it is closed.
    askShippers({
      store: nodes.seller,
      dealRef: 'order-2',
      shippers: [SHIPPER],
      grant: GRANT,
      postalCode: '560001',
      serviceAt: TUESDAY_RUN,
      crates: 1,
      nowMs: t0,
    });
    const lastUseful =
      Date.parse(TUESDAY_RUN) -
      DEPENDENT_TIMINGS.optionGraceMs -
      D -
      DEPENDENT_TIMINGS.buyerYesGraceMs -
      2 * H;
    deliverTick(lastUseful, false);
    expect(nodes.seller.forDeal('order-2')[0]?.state).toBe('declined');
  });
});
