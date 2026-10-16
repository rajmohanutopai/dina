/**
 * COMMITMENT_KERNEL §9 — legibility on binding cards (step 3 of §15).
 *
 *   L-01  Core's list names every bound part, once (omission);
 *   L-02  a misleading pack label sits beside Core's own rendering, quoted
 *         and marked as the pack's, never in its place;
 *   L-03  what changed since the last version the owner saw, including a
 *         changed promise field;
 *   L-04  the risks name the promises each side keeps and how the deal ends;
 *         worth appears only when given;
 *   L-05  an agent's note may carry no part's value in any spelling.
 */

import {
  agentNoteProblem,
  bindingCard,
  bindsEveryPart,
  type DealPart,
  type DealVersion,
  type ModelVocabulary,
} from '../../src/commitment';

const VOCAB: ModelVocabulary = {
  numbers: [
    { name: 'fee', kind: 'money', payer: 'buyer', payee: 'seller' },
    { name: 'share_bps', kind: 'ratio_bps', payer: 'buyer', payee: 'seller' },
  ],
  choices: {},
  flags: [],
  promises: { stock_run: { day: 'exact', crates: 'higher_better', every_days: 'lower_better' } },
};

const fee: DealPart = {
  kind: 'number',
  name: 'fee',
  value: 160_000n,
  currency: 'INR',
  per: 'month',
};
const share: DealPart = { kind: 'number', name: 'share_bps', value: 1000n };
const run = (day: string): DealPart => ({
  kind: 'promise',
  name: 'stock_run',
  dimensions: { day, crates: 2n, every_days: 7n },
});
const version = (parts: DealPart[]): DealVersion => ({ parts, months: 6 });

describe('binding cards (§9)', () => {
  it('L-01: every bound part appears in Core’s list, once', () => {
    const v = version([fee, share, run('tue')]);
    const card = bindingCard({
      vocabulary: VOCAB,
      labels: {},
      holder: 'buyer',
      other: 'the store',
      version: v,
    });
    expect(bindsEveryPart(card, v)).toBe(true);
    expect(bindsEveryPart({ ...card, binds: card.binds.slice(1) }, v)).toBe(false);
  });

  it('L-02: a misleading pack label stays beside Core’s words, quoted', () => {
    const v = version([fee, share]);
    const card = bindingCard({
      vocabulary: VOCAB,
      labels: { share_bps: 'a small admin fee' },
      holder: 'buyer',
      other: 'the store',
      version: v,
    });
    const line = card.binds.find((b) => b.part === 'share_bps');
    expect(line).toEqual({
      part: 'share_bps',
      core: '10% of sales, paid by you to the store',
      pack: '“a small admin fee” (the pack’s words)',
    });
    expect(card.binds.find((b) => b.part === 'fee')?.core).toBe(
      '₹1600 a month, paid by you to the store',
    );
  });

  it('L-03: what changed, including a promise field', () => {
    const card = bindingCard({
      vocabulary: VOCAB,
      labels: {},
      holder: 'seller',
      other: 'the brand',
      version: version([{ ...fee, value: 140_000n }, share, run('wed')]),
      previous: version([fee, share, run('tue')]),
      promisers: { stock_run: 'buyer' },
    });
    expect(card.changed).toEqual([
      'fee: was ₹1600 a month, paid by the brand to you; now ₹1400 a month, paid by the brand to you',
      'stock_run: was a promise the brand must keep: stock_run (crates: 2, day: tue, every_days: 7); now a promise the brand must keep: stock_run (crates: 2, day: wed, every_days: 7)',
    ]);
  });

  it('L-04: risks name who keeps each promise and how it ends; worth only when given', () => {
    const v = version([fee, run('tue')]);
    const seller = bindingCard({
      vocabulary: VOCAB,
      labels: {},
      holder: 'seller',
      other: 'the brand',
      version: v,
      promisers: { stock_run: 'buyer' },
      ending: 'Either side may end it with 30 days’ notice; it ends on 1 August 2027.',
    });
    expect(seller.risks).toEqual([
      'the brand promises: stock_run (crates: 2, day: tue, every_days: 7); it is theirs to keep.',
      'Either side may end it with 30 days’ notice; it ends on 1 August 2027.',
    ]);
    expect(seller.worth).toBeUndefined();
    const buyer = bindingCard({
      vocabulary: VOCAB,
      labels: {},
      holder: 'buyer',
      other: 'the store',
      version: v,
      promisers: { stock_run: 'buyer' },
      worth: -1400n,
    });
    expect(buyer.risks[0]).toBe('You promise: stock_run (crates: 2, day: tue, every_days: 7).');
    expect(buyer.worth).toBe('worth -₹1400 a month to you');
    expect(buyer.agentNotice).toMatch(/Core checks the list above/);
  });

  it('L-05: an agent’s note carries no part value', () => {
    const v = version([fee, share]);
    expect(agentNoteProblem('A fair rent for a busy corner.', v)).toBeNull();
    expect(agentNoteProblem('Rent of 1600 is fair.', v)).toMatch(/fee/);
    expect(agentNoteProblem('Rent of 1,600 is fair.', v)).toMatch(/fee/);
    expect(agentNoteProblem('Share 1000 bps.', v)).toMatch(/share_bps/);
    expect(agentNoteProblem('About ₹ a month.', v)).toMatch(/amount/);
    expect(agentNoteProblem('A 10% share is usual.', v)).toMatch(/share_bps/);
    expect(agentNoteProblem('A 10 percent share is usual.', v)).toMatch(/share_bps/);
    expect(agentNoteProblem('A 110% effort.', v)).toBeNull();
  });
});
