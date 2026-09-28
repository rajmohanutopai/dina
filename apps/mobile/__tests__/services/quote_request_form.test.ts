/**
 * ASK_FOR_QUOTES_PLAN §2 — the "Ask for quotes" form's rules. A request is
 * built only when every rule Core applies holds; each broken rule is said in
 * words; the negotiation limits are checked by Core's own policy function.
 */

import {
  buildTenderRequest,
  EMPTY_LIMITS,
  toMinorUnits,
  type QuoteRequestDraft,
} from '../../src/services/quote_request_form';

const SUPPLIER = { supplierDid: 'did:plc:bakeryaaaa', serviceRkey: 'shop' };

function draft(over: Partial<QuoteRequestDraft> = {}): QuoteRequestDraft {
  return {
    lines: [{ text: 'Floral celebration cake, 20 servings', quantity: '1', unitCode: 'each' }],
    suppliers: [SUPPLIER],
    region: { scheme: 'postal_area', value: '560001' },
    currency: 'INR',
    limits: EMPTY_LIMITS,
    ...over,
  };
}

it('turns main-unit amounts into minor units', () => {
  expect(toMinorUnits('2500')).toBe('250000');
  expect(toMinorUnits('2500.5')).toBe('250050');
  expect(toMinorUnits(' 0.75 ')).toBe('75');
  expect(toMinorUnits('2,500')).toBeNull();
  expect(toMinorUnits('1.234')).toBeNull();
});

it('a complete form becomes the tender request, empty lines dropped, ids numbered', () => {
  const outcome = buildTenderRequest(
    draft({
      lines: [
        { text: ' Floral celebration cake, 20 servings ', quantity: '1', unitCode: 'each' },
        { text: '', quantity: '1', unitCode: 'each' },
        { text: 'Cupcakes', quantity: '24', unitCode: 'each' },
      ],
      limits: { target: '2500', ceiling: '3000', maxRounds: '2', deadlineSeconds: 3600 },
    }),
  );
  expect(outcome).toEqual({
    ok: true,
    request: {
      suppliers: [SUPPLIER],
      lines: [
        {
          lineId: 'l1',
          text: 'Floral celebration cake, 20 servings',
          quantity: '1',
          unitCode: 'each',
        },
        { lineId: 'l2', text: 'Cupcakes', quantity: '24', unitCode: 'each' },
      ],
      region: { scheme: 'postal_area', value: '560001' },
      currency: 'INR',
      limits: {
        targetMinorUnits: '250000',
        ceilingMinorUnits: '300000',
        maxRounds: 2,
        deadlineSeconds: 3600,
      },
    },
  });
});

it('limits are optional', () => {
  const outcome = buildTenderRequest(draft());
  expect(outcome.ok && outcome.request.limits).toBeUndefined();
});

it.each([
  [
    'no line',
    draft({ lines: [{ text: ' ', quantity: '1', unitCode: 'each' }] }),
    'Describe at least one thing you want.',
  ],
  ['no supplier', draft({ suppliers: [] }), 'Pick at least one supplier to ask.'],
  [
    'too many suppliers',
    draft({
      suppliers: Array.from({ length: 6 }, (_, i) => ({
        supplierDid: `did:plc:s${String(i)}`,
        serviceRkey: 'self',
      })),
    }),
    'Ask at most 5 suppliers at a time.',
  ],
  ['no region', draft({ region: null }), 'Say where to deliver (a postal code).'],
  [
    'a fraction of each',
    draft({ lines: [{ text: 'Cake', quantity: '1.5', unitCode: 'each' }] }),
    'Count each in whole numbers.',
  ],
  [
    'zero',
    draft({ lines: [{ text: 'Flour', quantity: '0', unitCode: 'kg' }] }),
    'The quantity must be more than zero.',
  ],
  [
    'too long',
    draft({ lines: [{ text: 'x'.repeat(201), quantity: '1', unitCode: 'each' }] }),
    'keep the description under 200 characters.',
  ],
  [
    'ceiling below target (Core’s rule)',
    draft({ limits: { ...EMPTY_LIMITS, target: '3000', ceiling: '2500' } }),
    'The ceiling cannot be below the target.',
  ],
  [
    'only a target',
    draft({ limits: { ...EMPTY_LIMITS, target: '3000' } }),
    'To negotiate, give both a target and a ceiling, like 2500 or 2500.50.',
  ],
  [
    'too many rounds (Core’s rule)',
    draft({ limits: { ...EMPTY_LIMITS, target: '1', ceiling: '2', maxRounds: '11' } }),
    'Rounds must be 1 to 10.',
  ],
])('%s is said in words and builds nothing', (_label, form, problem) => {
  const outcome = buildTenderRequest(form);
  expect(outcome.ok).toBe(false);
  expect(outcome.ok ? [] : outcome.problems.join(' ')).toContain(problem);
});

it('a kilogram quantity may carry three decimals', () => {
  expect(
    buildTenderRequest(draft({ lines: [{ text: 'Flour', quantity: '2.125', unitCode: 'kg' }] })).ok,
  ).toBe(true);
});
