/**
 * `buildComparisonCardSpec` — the ComparisonCard → CardSpec projection
 * (RESEARCHER_KERNEL_ARCHITECTURE.md §5.A4/A5). Money-free: a where-to-buy
 * card, a tappable link only for an https source page, no "buy" action.
 */

import { buildComparisonCardSpec } from '../../src/service/comparison_card_spec';

import type { CardBlock, CardSpec } from '@dina/protocol';

function card(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'commerce_comparison',
    fields: [
      { label: 'Requested', value: 'oak chair — 1 each' },
      { label: 'Valid candidates', value: '2' },
      { label: 'Recommended', value: 'did:plc:cheapseller' },
      { label: 'Indicative price', value: 'INR 50000' },
      { label: 'Delivery estimate', value: '5 days' },
      { label: 'Confidence', value: '8000 of 10000' },
      { label: 'Why', value: 'price: 6000 of 6000' },
    ],
    primaryAction: 'where_to_buy',
    alternatives: [{ supplierDid: 'did:plc:dearseller', total: 'INR 90000', leadTime: '3 days' }],
    incomparable: ['trust: no rating for did:plc:dearseller'],
    handoff: [
      { supplierDid: 'did:plc:cheapseller', serviceUri: 'at://did:plc:cheapseller/svc' },
      { supplierDid: 'did:plc:dearseller', serviceUri: 'at://did:plc:dearseller/svc' },
    ],
    ...overrides,
  };
}

function blocksOf(spec: CardSpec | null): CardBlock[] {
  expect(spec).not.toBeNull();
  return (spec as CardSpec).blocks;
}

function sectionIndex(blocks: CardBlock[], label: string): number {
  return blocks.findIndex((b) => b.kind === 'section' && b.label === label);
}

/** The first `list` block belonging to a section (before the next section). */
function listAfter(blocks: CardBlock[], label: string): Extract<CardBlock, { kind: 'list' }> | null {
  const idx = sectionIndex(blocks, label);
  if (idx < 0) return null;
  for (let i = idx + 1; i < blocks.length; i += 1) {
    if (blocks[i].kind === 'list') return blocks[i] as Extract<CardBlock, { kind: 'list' }>;
    if (blocks[i].kind === 'section') break;
  }
  return null;
}

describe('buildComparisonCardSpec — money-free where-to-buy projection', () => {
  it('projects a where_to_buy card into a titled CardSpec', () => {
    const blocks = blocksOf(buildComparisonCardSpec(card()));
    expect(blocks[0]).toEqual({ kind: 'title', text: 'Where to buy' });
    expect(blocks).toContainEqual({
      kind: 'keyValue',
      label: 'Recommended',
      value: 'did:plc:cheapseller',
    });
    expect(sectionIndex(blocks, 'Where to buy')).toBeGreaterThan(0);
  });

  it('renders an https source page as a tappable link', () => {
    const spec = buildComparisonCardSpec(
      card({
        handoff: [
          {
            supplierDid: 'did:plc:cheapseller',
            serviceUri: 'at://did:plc:cheapseller/svc',
            sourceUrl: 'https://shop.example.com/oak-chair',
          },
        ],
      }),
    );
    const blocks = blocksOf(spec);
    const link = blocks.find((b) => b.kind === 'link');
    expect(link).toEqual({
      kind: 'link',
      label: 'did:plc:cheapseller',
      url: 'https://shop.example.com/oak-chair',
      action: 'open_url',
    });
  });

  it('names a service URI in the bounded list, never a fake link', () => {
    const blocks = blocksOf(buildComparisonCardSpec(card()));
    expect(blocks.some((b) => b.kind === 'link')).toBe(false);
    const list = listAfter(blocks, 'Where to buy');
    expect(list?.rows).toEqual([
      { text: 'did:plc:cheapseller', sub: 'at://did:plc:cheapseller/svc' },
      { text: 'did:plc:dearseller', sub: 'at://did:plc:dearseller/svc' },
    ]);
  });

  it('drops a non-https source page rather than making it tappable', () => {
    const blocks = blocksOf(
      buildComparisonCardSpec(
        card({
          handoff: [
            {
              supplierDid: 'did:plc:cheapseller',
              serviceUri: 'at://did:plc:cheapseller/svc',
              sourceUrl: 'http://shop.example.com/oak-chair',
            },
          ],
        }),
      ),
    );
    expect(blocks.some((b) => b.kind === 'link')).toBe(false);
    // Falls back to the service-URI line — the supplier still appears, and the
    // non-https URL is never shown.
    const list = listAfter(blocks, 'Where to buy');
    expect(list?.rows).toEqual([
      { text: 'did:plc:cheapseller', sub: 'at://did:plc:cheapseller/svc' },
    ]);
  });

  it('lists alternatives in the ranking order', () => {
    const blocks = blocksOf(buildComparisonCardSpec(card()));
    const list = listAfter(blocks, 'Alternatives');
    expect(list?.rows).toEqual([
      { text: 'did:plc:dearseller', sub: '3 days', trailing: 'INR 90000' },
    ]);
  });

  it('labels a seller the owner knows by their own name (alternatives + where-to-buy); "Chosen for" stays in the headline and "Set aside" becomes one bounded list', () => {
    const blocks = blocksOf(
      buildComparisonCardSpec(
        card({
          fields: [
            { label: 'Requested', value: 'oak chair — 1 each' },
            { label: 'Recommended', value: 'Steady Seats (did:plc:dearseller)' },
            { label: 'Chosen for', value: 'your rule: a proven seller over the cheapest' },
            { label: 'Set aside', value: 'ChairMaker (did:plc:sworn): you swore them off' },
            { label: 'Set aside', value: 'did:plc:cheapseller: no track record' },
            { label: 'Indicative price', value: 'INR 900.00' },
            { label: 'Why', value: 'price: 0 of 6000' },
          ],
          alternatives: [
            { supplierDid: 'did:plc:midseller', seller: 'Mid Seating (did:plc:midseller)', total: 'INR 700.00', leadTime: '5 days' },
          ],
          handoff: [
            { supplierDid: 'did:plc:midseller', serviceUri: 'at://did:plc:midseller/svc' },
            {
              supplierDid: 'did:plc:dearseller',
              sellerName: 'Steady Seats',
              serviceUri: 'at://did:plc:dearseller/svc',
              sourceUrl: 'https://steady.example/chair',
            },
          ],
        }),
      ),
    );
    const kinds = blocks.map((b) => b.kind);
    const keyValues = blocks.filter((b): b is Extract<CardBlock, { kind: 'keyValue' }> => b.kind === 'keyValue');
    // The decision reads in the headline, before the first section; the price follows it.
    const labels = keyValues.map((b) => b.label);
    expect(labels).toEqual(['Requested', 'Recommended', 'Chosen for', 'Indicative price', 'Why']);
    expect(keyValues.find((b) => b.label === 'Recommended')?.value).toBe('Steady Seats (did:plc:dearseller)');
    const firstSection = kinds.indexOf('section');
    expect(blocks.findIndex((b) => b.kind === 'keyValue' && b.label === 'Chosen for')).toBeLessThan(firstSection);
    // The set-aside lines are ONE list under their own section, right after the headline.
    expect(blocks[firstSection]).toEqual({ kind: 'section', label: 'Set aside' });
    expect(listAfter(blocks, 'Set aside')?.rows).toEqual([
      { text: 'ChairMaker (did:plc:sworn): you swore them off' },
      { text: 'did:plc:cheapseller: no track record' },
    ]);
    expect(keyValues.some((b) => b.label === 'Set aside')).toBe(false);
    // Names on the link and on the alternatives row (the card's `seller` label, not the DID).
    const link = blocks.find((b): b is Extract<CardBlock, { kind: 'link' }> => b.kind === 'link');
    expect(link?.label).toBe('Steady Seats (did:plc:dearseller)');
    expect(listAfter(blocks, 'Where to buy')?.rows).toEqual([{ text: 'did:plc:midseller', sub: 'at://did:plc:midseller/svc' }]);
    expect(listAfter(blocks, 'Alternatives')?.rows).toEqual([
      { text: 'Mid Seating (did:plc:midseller)', sub: '5 days', trailing: 'INR 700.00' },
    ]);
  });

  it('many set-aside lines never push the price, the where-to-buy list or the incomparable section past the block cap', () => {
    const setAside = Array.from({ length: 19 }, (_, i) => ({ label: 'Set aside', value: `did:plc:s${String(i)}: unknown` }));
    const blocks = blocksOf(
      buildComparisonCardSpec(
        card({
          fields: [
            { label: 'Requested', value: 'oak chair — 1 each' },
            { label: 'Recommended', value: 'did:plc:pick' },
            { label: 'Chosen for', value: 'your rule' },
            ...setAside,
            { label: 'Indicative price', value: 'INR 900.00' },
            { label: 'Delivery estimate', value: 'not stated' },
            { label: 'Confidence', value: '8000 of 10000' },
            { label: 'Evidence', value: 'none recorded for this supplier' },
            { label: 'Why', value: 'price: 0 of 6000' },
          ],
        }),
      ),
    );
    expect(blocks.some((b) => b.kind === 'keyValue' && b.label === 'Indicative price')).toBe(true);
    expect(listAfter(blocks, 'Where to buy')).not.toBeNull();
    expect(listAfter(blocks, "What couldn't be compared")).not.toBeNull();
    expect(listAfter(blocks, 'Set aside')?.rows).toHaveLength(19);
  });

  it('keeps the incomparable section even with many suppliers (block cap)', () => {
    // 20 service-URI hand-offs must NOT bury the §18.4 "what couldn't be
    // compared" notes past the 32-block cap — they collapse into one list.
    const handoff = Array.from({ length: 20 }, (_unused, i) => ({
      supplierDid: `did:plc:seller${String(i)}`,
      serviceUri: `at://did:plc:seller${String(i)}/svc`,
    }));
    const blocks = blocksOf(buildComparisonCardSpec(card({ handoff })));
    expect(blocks.length).toBeLessThanOrEqual(32);
    // The incomparable section and its content survive.
    expect(sectionIndex(blocks, "What couldn't be compared")).toBeGreaterThan(0);
    expect(listAfter(blocks, "What couldn't be compared")?.rows).toEqual([
      { text: 'trust: no rating for did:plc:dearseller' },
    ]);
    // The 20 hand-offs are one bounded list, not 20 blocks.
    expect(listAfter(blocks, 'Where to buy')?.rows).toHaveLength(20);
  });

  it('names what could not be compared', () => {
    const blocks = blocksOf(buildComparisonCardSpec(card()));
    expect(sectionIndex(blocks, "What couldn't be compared")).toBeGreaterThan(0);
    const lists = blocks.filter((b) => b.kind === 'list');
    expect(
      lists.some((b) => b.rows.some((r) => r.text === 'trust: no rating for did:plc:dearseller')),
    ).toBe(true);
  });

  it('orders the reasoning tail after the structured sections', () => {
    const blocks = blocksOf(buildComparisonCardSpec(card()));
    const whereToBuy = sectionIndex(blocks, 'Where to buy');
    const whyThisOne = sectionIndex(blocks, 'Why this one');
    expect(whyThisOne).toBeGreaterThan(whereToBuy);
    const whyLine = blocks.findIndex((b) => b.kind === 'keyValue' && b.label === 'Why');
    expect(whyLine).toBeGreaterThan(whyThisOne);
  });

  it('titles a review_order card "Review order"', () => {
    const blocks = blocksOf(buildComparisonCardSpec(card({ primaryAction: 'review_order' })));
    expect(blocks[0]).toEqual({ kind: 'title', text: 'Review order' });
  });

  it('returns null for anything that is not a comparison card', () => {
    expect(buildComparisonCardSpec(null)).toBeNull();
    expect(buildComparisonCardSpec({ kind: 'other', fields: [] })).toBeNull();
    expect(buildComparisonCardSpec({ kind: 'commerce_comparison' })).toBeNull();
  });
});
