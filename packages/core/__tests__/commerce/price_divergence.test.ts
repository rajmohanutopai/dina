/**
 * §5.5's divergence check — GOLDEN VECTORS pinning both tiers, exactly as
 * the design demands: the vocabulary tier, the pack-evidence tier
 * (case-vs-each through `units_per_pack`, the 12× false alarm killed by
 * name), the absent-evidence badge, the absent-baseline badge, and the
 * variant non-transfer rule. Each vector is a frozen input/verdict pair;
 * a change in any verdict is a change in what the approval card tells a
 * buyer about money.
 */

import { checkPriceDivergence } from '../../src/commerce/price_divergence';

import type { CatalogItem, Money, ProductRef, Quantity } from '@dina/commerce-protocol';

const SUPPLIER = 'did:plc:chairmaker99';
const PRODUCT: ProductRef = { scheme: 'manufacturer_sku', value: 'CM-CHAIR-1', issuer_did: SUPPLIER };

function item(over: {
  sellUnit?: Quantity;
  unitsPerPack?: string;
  indicativePrice?: Money | 'absent';
  product?: ProductRef;
}): CatalogItem {
  return {
    product: over.product ?? PRODUCT,
    supplier_did: SUPPLIER,
    catalog_id: 'main',
    item_revision: 'rev-1',
    name: 'Oak dining chair',
    category_ids: ['furniture.seating'],
    pack: {
      sell_unit: over.sellUnit ?? { value: '1', unit_code: 'each' },
      ...(over.unitsPerPack !== undefined ? { units_per_pack: over.unitsPerPack } : {}),
    },
    fulfilment_regions: [{ scheme: 'admin_area', value: 'IN-KA' }],
    freshness: { generated_at: '2026-08-15T10:00:00.000Z' },
    ...(over.indicativePrice === 'absent'
      ? {}
      : { indicative_price: over.indicativePrice ?? { currency: 'INR', minor_units: '10000' } }),
  };
}

const money = (minor: string, currency = 'INR'): Money => ({ currency, minor_units: minor });
const qty = (value: string, unit: string): Quantity => ({ value, unit_code: unit });

/** The frozen vectors. Inputs exact, verdicts exact. */
const VECTORS: {
  name: string;
  quoted: { unitPrice: Money; priceBasis: Quantity };
  item: CatalogItem;
  resolvedProduct?: ProductRef;
  thresholdPct?: number;
  expect: ReturnType<typeof checkPriceDivergence>;
}[] = [
  {
    name: 'VOCABULARY TIER: ₹500/kg vs ₹0.45/g — 111%, within a 25% band',
    quoted: { unitPrice: money('50000'), priceBasis: qty('1', 'kg') },
    item: item({ sellUnit: qty('1', 'g'), indicativePrice: money('45') }),
    expect: { kind: 'comparable', ratioPct: 111, flagged: false, direction: 'within' },
  },
  {
    name: 'VOCABULARY TIER: ₹700/kg vs ₹0.45/g — 156%, flagged above',
    quoted: { unitPrice: money('70000'), priceBasis: qty('1', 'kg') },
    item: item({ sellUnit: qty('1', 'g'), indicativePrice: money('45') }),
    expect: { kind: 'comparable', ratioPct: 156, flagged: true, direction: 'above' },
  },
  {
    name: 'PACK-EVIDENCE TIER: ₹1200/case of 12 vs ₹100/each — the 12× false alarm reads 100%',
    quoted: { unitPrice: money('120000'), priceBasis: qty('1', 'case') },
    item: item({ unitsPerPack: '12', indicativePrice: money('10000') }),
    expect: { kind: 'comparable', ratioPct: 100, flagged: false, direction: 'within' },
  },
  {
    name: 'PACK-EVIDENCE TIER: ₹1800/case of 12 vs ₹100/each — 150%, flagged',
    quoted: { unitPrice: money('180000'), priceBasis: qty('1', 'case') },
    item: item({ unitsPerPack: '12', indicativePrice: money('10000') }),
    expect: { kind: 'comparable', ratioPct: 150, flagged: true, direction: 'above' },
  },
  {
    name: 'ABSENT EVIDENCE: a case with no units_per_pack gets the badge, never a guess',
    quoted: { unitPrice: money('120000'), priceBasis: qty('1', 'case') },
    item: item({ indicativePrice: money('10000') }),
    expect: { kind: 'no_comparable_basis', reason: 'case has no pack evidence on the resolved item' },
  },
  {
    name: 'PALLET: no per-product evidence field exists — badge, stated',
    quoted: { unitPrice: money('9000000'), priceBasis: qty('1', 'pallet') },
    item: item({ indicativePrice: money('10000') }),
    expect: { kind: 'no_comparable_basis', reason: 'pallet has no conversion evidence' },
  },
  {
    name: 'NO BASELINE: an item with no indicative_price — the flagged-new-supplier badge',
    quoted: { unitPrice: money('10000'), priceBasis: qty('1', 'each') },
    item: item({ indicativePrice: 'absent' }),
    expect: { kind: 'no_reference_price' },
  },
  {
    name: 'NON-TRANSFER: pack evidence from a different variant refuses before any arithmetic',
    quoted: { unitPrice: money('120000'), priceBasis: qty('1', 'case') },
    item: item({ unitsPerPack: '12', indicativePrice: money('10000') }),
    resolvedProduct: { scheme: 'manufacturer_sku', value: 'CM-CHAIR-2', issuer_did: SUPPLIER },
    expect: { kind: 'no_comparable_basis', reason: 'pack evidence belongs to a different variant' },
  },
  {
    name: 'CURRENCIES: INR quoted against a USD reference is not a ratio',
    quoted: { unitPrice: money('10000', 'USD'), priceBasis: qty('1', 'each') },
    item: item({ indicativePrice: money('10000') }),
    expect: { kind: 'no_comparable_basis', reason: 'currencies differ (USD vs INR)' },
  },
  {
    name: 'DIMENSIONS: a kg price against an each reference has no shared base',
    quoted: { unitPrice: money('10000'), priceBasis: qty('1', 'kg') },
    item: item({ indicativePrice: money('10000') }),
    expect: { kind: 'no_comparable_basis', reason: 'dimensions differ (mass vs count)' },
  },
  {
    name: 'BELOW: ₹70/each vs ₹100/each — 70%, flagged below (a too-good price is also news)',
    quoted: { unitPrice: money('7000'), priceBasis: qty('1', 'each') },
    item: item({}),
    expect: { kind: 'comparable', ratioPct: 70, flagged: true, direction: 'below' },
  },
  {
    name: 'OWNER THRESHOLD: 111% flags under a tightened 10% band',
    quoted: { unitPrice: money('11100'), priceBasis: qty('1', 'each') },
    item: item({}),
    thresholdPct: 10,
    expect: { kind: 'comparable', ratioPct: 111, flagged: true, direction: 'above' },
  },
  {
    name: 'EXACT BOUNDARY: 125% under a 25% band is NOT flagged — exceeds means exceeds',
    quoted: { unitPrice: money('12500'), priceBasis: qty('1', 'each') },
    item: item({}),
    expect: { kind: 'comparable', ratioPct: 125, flagged: false, direction: 'within' },
  },
];

describe('the §5.5 divergence golden vectors', () => {
  for (const vector of VECTORS) {
    it(vector.name, () => {
      expect(
        checkPriceDivergence({
          quoted: vector.quoted,
          item: vector.item,
          resolvedProduct: vector.resolvedProduct ?? PRODUCT,
          ...(vector.thresholdPct !== undefined ? { thresholdPct: vector.thresholdPct } : {}),
        }),
      ).toEqual(vector.expect);
    });
  }
});
