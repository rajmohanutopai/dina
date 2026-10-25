/**
 * HOSTED_DINA §6.4 — the tender as one card: the phone, the owner's Dina page
 * and the owner's dot all draw what `buildTenderCard` returns, so what it
 * says, hides and offers to press is the contract.
 */

import { validateCardSpec, type CardBlock, type CardSpec, type ListBlock } from '@dina/protocol';

import {
  buildTenderCard,
  buildTenderDraftCard,
  orderStepsReached,
  type TenderCardInput,
} from '../../src/client/tender_card';

import type { TenderRankingView } from '../../src/client/tender_views';

const FOG = 'did:plc:fogline';
const MC = 'did:plc:morningcrumb';
const names: Record<string, string> = { [FOG]: 'Fogline Bakehouse', [MC]: 'Morning Crumb Bakery' };

const offer = (
  did: string,
  total: string,
  extra: Partial<TenderRankingView['ranked'][number]> = {},
) => ({
  supplier_did: did,
  quote_id: `q-${did}`,
  service_rkey: 'self',
  total_minor: total,
  currency: 'USD',
  comparison_cost_minor: total,
  credit_days: 0,
  valid_until: '2026-10-26T15:05:00.000Z',
  revision: '1',
  ...extra,
});

const ready: TenderRankingView = {
  tender_id: 'tnd_1',
  state: 'ready',
  target_total: '70000',
  budget_ceiling: '80000',
  currency: 'USD',
  ranked: [
    offer(FOG, '70000'),
    offer(MC, '75000', { revision: '2', credit_days: 15, comparison_cost_minor: '74000' }),
  ],
  excluded: [{ supplier_did: 'did:plc:late', reason: 'no_quote', service_rkey: 'self' }],
  not_asked: [
    {
      supplier_did: 'did:plc:poor',
      service_rkey: 'self',
      reason: 'own_poor_review',
      note: 'stale bread',
    },
  ],
};

function card(over: Partial<TenderCardInput> = {}): CardSpec {
  return buildTenderCard({
    ranking: ready,
    nameOf: (did) => names[did] ?? null,
    audience: 'owner',
    buttons: true,
    ...over,
  });
}
const lists = (spec: CardSpec) => spec.blocks.filter((b): b is ListBlock => b.kind === 'list');
const kinds = (spec: CardSpec) => spec.blocks.map((b: CardBlock) => b.kind);

describe('the tender card', () => {
  it('leads with the state and the best offer, then every offer with its Award', () => {
    const spec = card();
    expect(spec.blocks[0]).toEqual({ kind: 'title', text: 'Ready to award', tone: 'positive' });
    expect(spec.blocks).toContainEqual({
      kind: 'stat',
      value: 'USD 700.00',
      caption: 'Best offer · Fogline Bakehouse',
      tone: 'positive',
    });
    const [offers] = lists(spec);
    expect(offers?.rows.map((r) => [r.text, r.trailing])).toEqual([
      ['1. Fogline Bakehouse', 'USD 700.00'],
      ['2. Morning Crumb Bakery', 'USD 750.00'],
    ]);
    expect(offers?.rows[0]?.action).toEqual({
      label: 'Award',
      command: 'tender.award',
      params: { tender_id: 'tnd_1', supplier_did: FOG },
      tone: 'positive',
    });
    expect(offers?.rows[1]?.sub).toContain("15 days' credit");
    expect(offers?.rows[1]?.sub).toContain('revised 1×');
    expect(offers?.rows[1]?.sub).toContain('costs you USD 740.00 after the credit');
  });

  it('says who is out of the running and who was never asked, and why', () => {
    const [, out, notAsked] = lists(card());
    expect(out?.rows[0]?.sub).toBe('No quote yet');
    expect(notAsked?.rows[0]?.sub).toBe('you rated them poorly on PeerLens · “stale bread”');
  });

  it('never reads the ceiling, the owner’s rules or the owner’s notes back to the dot', () => {
    const spec = card({
      audience: 'agent',
      ranking: { ...ready, excluded: [{ supplier_did: MC, reason: 'ruled_out' }] },
    });
    const text = JSON.stringify(spec);
    expect(text).not.toContain('800.00');
    expect(text).not.toContain('rules');
    expect(text).not.toContain('stale bread');
    expect(text).toContain('USD 700.00');
  });

  it('draws no buttons when asked not to, and none once the tender is awarded', () => {
    expect(JSON.stringify(card({ buttons: false }))).not.toContain('tender.award');
    const awarded = card({
      ranking: {
        ...ready,
        state: 'awarded',
        awarded_supplier_did: FOG,
        held_order: 'held',
        approval_id: 'ap_1',
      },
    });
    expect(JSON.stringify(awarded)).not.toContain('tender.award');
    expect(lists(awarded)[0]?.rows[0]?.trailing).toBe('Awarded · USD 700.00');
    expect(awarded.blocks).toContainEqual({
      kind: 'action',
      action: {
        label: 'Send order',
        command: 'tender.send',
        params: { approval_id: 'ap_1' },
        tone: 'positive',
      },
    });
    // The dot's award sends at once; it is never offered a Send.
    expect(
      JSON.stringify(
        card({
          ...{ audience: 'agent' as const },
          ranking: { ...ready, state: 'awarded', held_order: 'held', approval_id: 'ap_1' },
        }),
      ),
    ).not.toContain('tender.send');
  });

  it('follows a sent order on the five steps', () => {
    const spec = card({
      ranking: {
        ...ready,
        state: 'awarded',
        awarded_supplier_did: FOG,
        held_order: 'sent',
        approval_id: 'ap_1',
      },
      order: { headline: 'Fogline Bakehouse accepted your order.', stepsReached: 2 },
    });
    expect(spec.blocks).toContainEqual({
      kind: 'body',
      text: 'Fogline Bakehouse accepted your order.',
    });
    const timeline = spec.blocks.find((b) => b.kind === 'timeline');
    expect(timeline).toEqual({
      kind: 'timeline',
      steps: [
        { label: 'Sent', state: 'done' },
        { label: 'Accepted', state: 'done' },
        { label: 'Paid', state: 'active' },
        { label: 'Being made', state: 'upcoming' },
        { label: 'On the way', state: 'upcoming' },
      ],
    });
  });

  it('is a card every Dina surface accepts as Dina’s own, buttons included', () => {
    const spec = card();
    expect(validateCardSpec(spec, { trusted: true })).toEqual(spec);
    expect(kinds(spec)).not.toContain('media');
  });

  it('waits plainly before any supplier answers', () => {
    const spec = card({
      ranking: {
        ...ready,
        state: 'negotiating',
        ranked: [],
        excluded: [{ supplier_did: FOG, reason: 'no_quote' }],
      },
    });
    expect(spec.blocks[0]).toEqual({ kind: 'title', text: 'Waiting for the suppliers to quote' });
    expect(spec.blocks).toContainEqual({ kind: 'body', text: 'No offer can be awarded yet.' });
  });
});

describe('the draft card and the order track', () => {
  it('lists who Dina would ask, ticked or not, with their trust', () => {
    const spec = buildTenderDraftCard([
      {
        name: 'Fogline Bakehouse',
        source: 'network',
        selected: true,
        trust: { score: 0.24, reviews: 2 },
      },
      { name: null, source: 'known', selected: false },
    ]);
    expect(lists(spec)[0]?.rows).toEqual([
      {
        text: 'Fogline Bakehouse',
        sub: 'Found on the network · Trust 0.24 · 2 reviews',
        trailing: 'Will ask',
        tone: 'positive',
      },
      { text: 'Unnamed supplier', sub: 'Your supplier', trailing: 'Not ticked' },
    ]);
  });

  it('counts an order’s steps from its state and progress', () => {
    const base = { paymentRecorded: false, payment: null, fulfilment: null };
    expect(orderStepsReached({ state: 'submitted_unconfirmed', progress: null })).toBe(1);
    expect(orderStepsReached({ state: 'accepted', progress: base })).toBe(2);
    expect(
      orderStepsReached({ state: 'accepted', progress: { ...base, paymentRecorded: true } }),
    ).toBe(3);
    expect(
      orderStepsReached({
        state: 'accepted',
        progress: { ...base, fulfilment: { state: 'ready' } },
      }),
    ).toBe(4);
    expect(orderStepsReached({ state: 'rejected', progress: null })).toBeNull();
  });
});
