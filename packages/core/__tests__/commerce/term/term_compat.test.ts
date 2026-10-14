/**
 * SHELF_SPACE_NEGOTIATION — compatibility across builds.
 *
 *   P-19  A node without a term kind refuses the push as unknown (§5.3
 *         "Compatibility"), at the `commerce.trade` ingress seam: nothing is
 *         read half-understood, nothing waits in the money spool for a
 *         reader that will never exist.
 *   K-05  An app update within a schema major keeps an open offer chain and
 *         an accepted agreement working (§4 "Identity across nodes"); a
 *         document naming another schema major is refused.
 *
 * A node of an older build cannot run in this process, so P-19 sends a term
 * kind this build does not know (`term_amendment`): that is exactly where an
 * older build stands with `term_request`, since both reach the same unknown-
 * kind path in `trade_ingress.ts`.
 */

import { createHash } from 'node:crypto';

import {
  sealTermRecord,
  type Sha256Fn,
  type TermAgreementProposal,
  type TermListing,
  type TermOffer,
  type TermRequest,
} from '@dina/commerce-protocol';

import {
  installCommerceRuntime,
  type CommerceMoneyAccess,
  type CommerceRuntime,
} from '../../../src/commerce/runtime';
import { SLOT_PACK_ID, SLOT_PACK_SCHEMA_MAJOR } from '../../../src/commerce/slot_pack_manifests';
import { termAgreementStatus } from '../../../src/commerce/term/term_agreements';
import { TERM_PROPOSAL_CARD } from '../../../src/commerce/term/term_buyer';
import { TERM_PUSH_KINDS } from '../../../src/commerce/term/term_engine';
import { TERM_DECISION_CARD } from '../../../src/commerce/term/term_seller';
import {
  applyInboundTradeDocument,
  drainTradeSpool,
  readTradePushBody,
} from '../../../src/commerce/trade_ingress';
import { InMemoryTradeSpoolRepository } from '../../../src/commerce/trade_spool';
import { moneyClosed, moneyOpen } from '../helpers';

import { publishListing } from './term_harness';
import { BRAND_DID, DAY, Fleet, HOUR, juicePolicy, STORE_DID, type Node } from './term_harness';

const hash: Sha256Fn = (data) => new Uint8Array(createHash('sha256').update(data).digest());

/** The only pack identity a term document carries (§4): no version, no CID. */
const SLOT_REF = { plugin_id: SLOT_PACK_ID, schema_major: SLOT_PACK_SCHEMA_MAJOR };
const NEXT_MAJOR_REF = { plugin_id: SLOT_PACK_ID, schema_major: SLOT_PACK_SCHEMA_MAJOR + 1 };

const UNKNOWN_KIND = 'term_amendment';
const UNKNOWN_KIND_REFUSAL = 'trade push: kind must name a khata document';

function setUpStore(fleet: Fleet): { store: Node; listing: TermListing; uri: string } {
  const store = fleet.add(STORE_DID);
  const set = store.engine.setPolicy(juicePolicy());
  if (!set.ok) throw new Error(set.refusal);
  const published = publishListing(store, {
    listingId: 'slot-3',
    resourceRef: 'slot-3',
    kind: 'shelf',
    region: { scheme: 'postal_area', value: 'IN-560034' },
    tags: ['beverages.juice', 'snacks'],
  });
  if (!published.ok) throw new Error(published.refusal);
  return { store, listing: published.listing, uri: published.uri };
}

function ask(brand: Node, listing: TermListing, uri: string): string {
  const started = brand.engine.startNegotiation({
    listing,
    listingUri: uri,
    tag: 'beverages.juice',
    attributes: { skus: 4 },
    start: '2027-02-01T00:00:00Z',
    end: '2027-08-01T00:00:00Z',
    policy: {
      currency: 'INR',
      targets: { fee: '170000', share_bps: '600' },
      ceilings: { fee: '300000', share_bps: '1000' },
      max_rounds: 3,
      deadline_seconds: 3 * 24 * 60 * 60,
    },
  });
  if (!started.ok) throw new Error(started.refusal);
  return started.request.request_id;
}

function offers(node: Node, requestId: string): TermOffer[] {
  return node.store
    .listByRequest(requestId, 'term_offer')
    .map((r) => JSON.parse(r.recordJson) as TermOffer)
    .sort((a, b) => a.revision - b.revision);
}

function card(node: Node, type: string, requestId?: string) {
  const found = node.cards.filter(
    (c) => c.type === type && (requestId === undefined || c.payload.request_id === requestId),
  );
  return found[found.length - 1];
}

function only<T>(items: readonly T[], what: string): T {
  if (items.length !== 1) throw new Error(`expected one ${what}, found ${String(items.length)}`);
  return items[0] as T;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** A document a peer's build produced, reaching `receiver` through its own inbound gate. */
function arrive(receiver: Node, fromDid: string, kind: string, document: unknown) {
  expect(
    receiver.engine.gateAllows({ peerDid: fromDid, kind, document, direction: 'inbound' }),
  ).toBe(true);
  return receiver.engine.ingest({
    senderDid: fromDid,
    kind: kind as (typeof TERM_PUSH_KINDS)[number],
    document,
    evidenceJson: '{}',
  });
}

/** Every term document a node holds for a request: each must name the pack by id and major only. */
function packRefsOf(node: Node, requestId: string): unknown[] {
  return (['term_request', 'term_offer', 'term_agreement_proposal'] as const).flatMap((kind) =>
    node.store
      .listByRequest(requestId, kind)
      .map((r) => (JSON.parse(r.recordJson) as { pack: unknown }).pack),
  );
}

/**
 * The brand asks, the store's first offer reaches the brand, and everything
 * the brand sends after it is lost: the chain is open at revision 1.
 */
function openChain(fleet: Fleet): {
  store: Node;
  brand: Node;
  requestId: string;
  head: TermOffer;
} {
  const { store, listing, uri } = setUpStore(fleet);
  const brand = fleet.add(BRAND_DID);
  const requestId = ask(brand, listing, uri);
  fleet.pump(1); // the request alone reaches the store
  fleet.unreachable.add(STORE_DID);
  fleet.pump();
  return { store, brand, requestId, head: only(offers(brand, requestId), 'offer') };
}

/** An app update: each node relaunches on its own file, and its sweeper runs. */
function update(...nodes: Node[]): void {
  for (const node of nodes) {
    node.restart();
    node.engine.sweep();
  }
}

describe('P-19 — a term kind this node does not know is refused as unknown', () => {
  let fleet: Fleet;
  beforeEach(() => {
    fleet = new Fleet();
  });
  afterEach(() => {
    installCommerceRuntime(null);
    fleet.closeAll();
  });

  /** The real ingress, with this node's term engine and the given money line. */
  function installNode(node: Node, money: () => CommerceMoneyAccess) {
    const spool = new InMemoryTradeSpoolRepository();
    const runtime = {
      terms: node.engine,
      money,
      tradeSpool: spool,
      nodeDid: () => node.did,
      now: () => fleet.nowMs,
    } as unknown as CommerceRuntime;
    installCommerceRuntime(runtime);
    return { runtime, spool };
  }

  /** A well-formed request, pushed under a kind this build has no lane for. */
  function unknownPush(): { body: unknown; digest: string } {
    const { listing, uri } = setUpStore(fleet);
    const brand = fleet.add(BRAND_DID);
    ask(brand, listing, uri);
    const sent = fleet.inFlight.shift();
    if (sent === undefined) throw new Error('no request in flight');
    const request = sent.document as TermRequest;
    return {
      body: { kind: UNKNOWN_KIND, document: request },
      digest: request.request_digest,
    };
  }

  it('the push reader names no lane for it', () => {
    expect(readTradePushBody({ kind: UNKNOWN_KIND, document: {} })).toBe(UNKNOWN_KIND_REFUSAL);
    // Every kind this build does know has a lane (the contrast).
    for (const kind of TERM_PUSH_KINDS) {
      expect(readTradePushBody({ kind, document: {} })).toEqual({ kind, document: {} });
    }
  });

  it('with the money line open: refused as unreadable, and the term engine never sees it', () => {
    const { body, digest } = unknownPush();
    const store = fleet.nodes.get(STORE_DID);
    if (store === undefined) throw new Error('no store');
    const { spool } = installNode(store, moneyOpen());
    const verdict = applyInboundTradeDocument({
      senderDid: BRAND_DID,
      body,
      evidenceJson: '{}',
      nowMs: fleet.nowMs,
    });
    expect(verdict.outcome).toBe('unreadable');
    expect('detail' in verdict ? verdict.detail : undefined).toBe(UNKNOWN_KIND_REFUSAL);
    // Not read as the request it carries: no answer, no receipt, no offer, nothing kept.
    expect(store.store.getAnswer(digest)).toBeNull();
    expect(store.store.getDocument(digest)).toBeNull();
    expect(fleet.inFlight).toHaveLength(0);
    expect(spool.count()).toBe(0);
  });

  it('with the money line closed: refused the same way, never kept in the spool', () => {
    const { body, digest } = unknownPush();
    const store = fleet.nodes.get(STORE_DID);
    if (store === undefined) throw new Error('no store');
    const { spool } = installNode(store, moneyClosed('pack_not_installed'));
    const verdict = applyInboundTradeDocument({
      senderDid: BRAND_DID,
      body,
      evidenceJson: '{}',
      nowMs: fleet.nowMs,
    });
    // §5.3: "a node without these kinds refuses the push". Spooling it would
    // take a document no verifier will ever read, and hold a spool row that a
    // real khata document needs while the line is closed.
    expect(verdict.outcome).toBe('unreadable');
    expect(spool.count()).toBe(0);
    expect(store.store.getAnswer(digest)).toBeNull();
    expect(fleet.inFlight).toHaveLength(0);
  });

  it('a spooled unknown kind is never handed to a reader when the line opens', () => {
    const { body, digest } = unknownPush();
    const store = fleet.nodes.get(STORE_DID);
    if (store === undefined) throw new Error('no store');
    const line = { open: false };
    const { runtime, spool } = installNode(store, () =>
      line.open ? moneyOpen()() : moneyClosed('pack_paused')(),
    );
    // Put straight into the spool, as a build that spooled it on arrival did.
    spool.put({
      senderDid: BRAND_DID,
      bodyJson: JSON.stringify(body),
      evidenceJson: '{}',
      receivedAt: fleet.nowMs,
    });
    line.open = true;
    const money = runtime.money();
    if (!money.available) throw new Error('line should be open');
    expect(drainTradeSpool(runtime, money.stores)).toEqual({
      replayed: 1,
      applied: 0,
      faulted: 0,
    });
    expect(spool.count()).toBe(0);
    expect(store.store.getDocument(digest)).toBeNull();
    expect(fleet.inFlight).toHaveLength(0);
  });

  it('a kind this build knows goes to the term engine, open line or closed (the contrast)', () => {
    const { listing, uri } = setUpStore(fleet);
    const brand = fleet.add(BRAND_DID);
    ask(brand, listing, uri);
    const sent = fleet.inFlight.shift();
    if (sent === undefined) throw new Error('no request in flight');
    const store = fleet.nodes.get(STORE_DID);
    if (store === undefined) throw new Error('no store');
    const { spool } = installNode(store, moneyClosed('pack_not_installed'));
    const verdict = applyInboundTradeDocument({
      senderDid: BRAND_DID,
      body: { kind: 'term_request', document: sent.document },
      evidenceJson: '{}',
      nowMs: fleet.nowMs,
    });
    expect(verdict).toEqual({ outcome: 'applied', kind: 'term_request' });
    expect(spool.count()).toBe(0);
    const digest = (sent.document as TermRequest).request_digest;
    expect(store.store.getAnswer(digest)?.outcome).toBe('stored');
  });
});

describe('K-05 — an app update within a schema major', () => {
  let fleet: Fleet;
  beforeEach(() => {
    fleet = new Fleet();
  });
  afterEach(() => fleet.closeAll());

  it('an open offer chain survives the update on both sides and closes as an agreement', () => {
    const { store, brand, requestId, head } = openChain(fleet);
    expect(head.revision).toBe(1);
    // The brand's counter was written by the old build and lost on the way.
    const counter = only(brand.store.listByRequest(requestId, 'term_counter'), 'counter');
    expect(brand.store.getOutbox(counter.recordDigest)?.receiptOutcome).toBeNull();

    update(store, brand);
    fleet.unreachable.delete(STORE_DID);
    // The first resend falls due 6 hours after the send, inside the
    // counter's 12-hour respond_by.
    fleet.advance(6 * HOUR);
    brand.engine.sweep();
    fleet.pump();
    expect(brand.store.getOutbox(counter.recordDigest)?.receiptOutcome).toBe('stored');
    expect(offers(brand, requestId).length).toBeGreaterThan(1);

    const proposalCard = card(brand, TERM_PROPOSAL_CARD, requestId);
    if (proposalCard === undefined) throw new Error('no proposal card');
    brand.engine.decideCard(proposalCard.cardId, true);
    fleet.pump();
    const proposal = only(
      brand.store.listByRequest(requestId, 'term_agreement_proposal'),
      'proposal',
    );
    const decision = card(store, TERM_DECISION_CARD);
    if (decision === undefined) throw new Error('no decision card');
    store.engine.decideCard(decision.cardId, true);
    fleet.pump();
    expect(brand.store.getNegotiation(requestId)?.state).toBe('agreed');
    expect(termAgreementStatus(store.store, proposal.recordDigest).state).toBe('accepted');

    // Builds differ only below the major: every document names the pack by
    // id and major, so both builds wrote the same pack reference.
    const refs = [...packRefsOf(brand, requestId), ...packRefsOf(store, requestId)];
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(ref).toEqual(SLOT_REF);
  });

  it('an accepted agreement keeps settling across the update', () => {
    const { store, listing, uri } = setUpStore(fleet);
    const brand = fleet.add(BRAND_DID);
    const requestId = ask(brand, listing, uri);
    fleet.pump();
    const proposalCard = card(brand, TERM_PROPOSAL_CARD, requestId);
    if (proposalCard === undefined) throw new Error('no proposal card');
    brand.engine.decideCard(proposalCard.cardId, true);
    fleet.pump();
    const digest = only(
      brand.store.listByRequest(requestId, 'term_agreement_proposal'),
      'proposal',
    ).recordDigest;
    const decision = card(store, TERM_DECISION_CARD);
    if (decision === undefined) throw new Error('no decision card');
    store.engine.decideCard(decision.cardId, true);
    fleet.pump();

    // The vendor (cash handler) settles the 14-day trial on the old build;
    // the note is lost on the way.
    fleet.nowMs = Date.parse('2027-03-20T00:00:00Z');
    fleet.unreachable.add(STORE_DID);
    const trial = brand.engine.issueSettlement({
      proposalDigest: digest,
      periodStart: '2027-02-01T00:00:00.000Z',
      periodEnd: '2027-02-15T00:00:00.000Z',
      grossMinor: '1000000',
    });
    if (!trial.ok) throw new Error(trial.refusal);
    fleet.pump();

    update(store, brand);
    fleet.unreachable.delete(STORE_DID);
    fleet.advance(6 * HOUR);
    brand.engine.sweep();
    fleet.pump();
    // The note the old build wrote lands on the new one, and is acknowledged.
    expect(brand.store.getOutbox(trial.document.settlement_digest)?.receiptOutcome).toBe('stored');
    const ack = store.engine.acknowledgeSettlement({
      settlementDigest: trial.document.settlement_digest,
      kind: 'accepted',
    });
    if (!ack.ok) throw new Error(ack.refusal);
    fleet.pump();
    expect(store.store.getOutbox(ack.document.settlement_ack_digest)?.receiptOutcome).toBe(
      'stored',
    );

    // A note the new build writes for the next period lands too.
    const next = brand.engine.issueSettlement({
      proposalDigest: digest,
      periodStart: '2027-02-15T00:00:00.000Z',
      periodEnd: '2027-03-15T00:00:00.000Z',
      grossMinor: '0',
    });
    if (!next.ok) throw new Error(next.refusal);
    fleet.pump();
    expect(brand.store.getOutbox(next.document.settlement_digest)?.receiptOutcome).toBe('stored');
    expect(termAgreementStatus(store.store, digest).state).toBe('accepted');
    expect(termAgreementStatus(brand.store, digest).state).toBe('accepted');
  });

  it('a request naming another schema major is refused; the same request at this major is answered', () => {
    const { store, listing, uri } = setUpStore(fleet);
    const brand = fleet.add(BRAND_DID);
    ask(brand, listing, uri);
    const sent = fleet.inFlight.shift();
    if (sent === undefined) throw new Error('no request in flight');
    const request = sent.document as TermRequest;
    const { request_digest: _d, ...draft } = request;
    const otherMajor = sealTermRecord(
      'term_request',
      { ...draft, request_id: 'treq-next-major', pack: NEXT_MAJOR_REF },
      hash,
    ) as unknown as TermRequest;

    expect(arrive(store, BRAND_DID, 'term_request', otherMajor)).toEqual({
      outcome: 'refused',
      kind: 'term_request',
      detail: 'this node does not answer that pack',
    });
    expect(store.store.getAnswer(otherMajor.request_digest)?.outcome).toBe('refused');
    expect(store.store.listByRequest('treq-next-major', 'term_offer')).toHaveLength(0);

    expect(arrive(store, BRAND_DID, 'term_request', request).outcome).toBe('applied');
    expect(store.store.listByRequest(request.request_id, 'term_offer')).toHaveLength(1);
  });

  it('mid-negotiation: a revision naming another schema major is refused; at this major it lands', () => {
    const { brand, requestId, head } = openChain(fleet);
    const { offer_digest: _d, previous_offer_digest: _p, ...rest } = head;
    const revision = (pack: typeof SLOT_REF) =>
      sealTermRecord(
        'term_offer',
        {
          ...rest,
          pack,
          issued_at: iso(fleet.nowMs),
          valid_until: iso(fleet.nowMs + 3 * DAY),
          revision: head.revision + 1,
          previous_offer_digest: head.offer_digest,
        },
        hash,
      ) as unknown as TermOffer;

    const otherMajor = revision(NEXT_MAJOR_REF);
    const verdict = arrive(brand, STORE_DID, 'term_offer', otherMajor);
    expect(verdict.outcome).toBe('refused');
    expect(verdict.detail).toContain('fixed within a chain');
    expect(offers(brand, requestId).map((o) => o.revision)).toEqual([1]);

    // A revision from a newer build at the same major binds to the chain.
    expect(arrive(brand, STORE_DID, 'term_offer', revision(SLOT_REF)).outcome).toBe('applied');
    expect(offers(brand, requestId).map((o) => o.revision)).toEqual([1, 2]);
  });

  it('a proposal naming another schema major never becomes an agreement', () => {
    const { store, requestId } = openChain(fleet);
    const offer = only(offers(store, requestId), 'offer');
    const proposal = sealTermRecord(
      'term_agreement_proposal',
      {
        protocol_version: offer.protocol_version,
        proposal_id: 'tagr-next-major',
        host_did: offer.seller_did,
        vendor_did: offer.buyer_did,
        offer_digest: offer.offer_digest,
        pack: NEXT_MAJOR_REF,
        resource_ref: offer.resource_ref,
        general: offer.general,
        terms: offer.terms,
        proposed_at: iso(fleet.nowMs),
      },
      hash,
    ) as unknown as TermAgreementProposal;

    arrive(store, BRAND_DID, 'term_proposal', proposal);
    // §7.1 step 5: refused on arrival with a rejection, never put to the owner.
    expect(termAgreementStatus(store.store, proposal.proposal_digest).state).toBe('rejected');
    expect(
      store.cards.filter(
        (c) =>
          c.type === TERM_DECISION_CARD && c.payload.proposal_digest === proposal.proposal_digest,
      ),
    ).toHaveLength(0);
  });

  it('the control: the same proposal at this build’s own pack reaches the owner', () => {
    // On a fresh chain: a second proposal for an offer already answered is
    // refused for that reason alone, which would prove nothing here.
    const { store, requestId } = openChain(fleet);
    const offer = only(offers(store, requestId), 'offer');
    const same = sealTermRecord(
      'term_agreement_proposal',
      {
        protocol_version: offer.protocol_version,
        proposal_id: 'tagr-this-major',
        host_did: offer.seller_did,
        vendor_did: offer.buyer_did,
        offer_digest: offer.offer_digest,
        pack: offer.pack,
        resource_ref: offer.resource_ref,
        general: offer.general,
        terms: offer.terms,
        proposed_at: iso(fleet.nowMs),
      },
      hash,
    ) as unknown as TermAgreementProposal;
    arrive(store, BRAND_DID, 'term_proposal', same);
    expect(termAgreementStatus(store.store, same.proposal_digest).state).toBe('proposed');
    expect(
      store.cards.filter(
        (c) => c.type === TERM_DECISION_CARD && c.payload.proposal_digest === same.proposal_digest,
      ),
    ).toHaveLength(1);
  });
});
