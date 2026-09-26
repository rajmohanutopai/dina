/**
 * NEGOTIATION_PLAN §4.1 — the supplier's floors, as Core enforces them.
 * Worked example from the plan: list 240, automatic limit 220, floor 210.
 */

import {
  validateSupplierSettings,
  type SupplierSettings,
} from '../../src/commerce/commerce_settings';
import {
  clampProposal,
  lineBounds,
  negotiationPolicyFindings,
  type SupplierNegotiationPolicy,
} from '../../src/commerce/negotiation_policy';

const CAKE = {
  scheme: 'manufacturer_sku' as const,
  value: 'CAKE-FLORAL',
  issuer_did: 'did:plc:bakery',
};
const OTHER = { scheme: 'gtin' as const, value: '09506000134352' };

const policy: SupplierNegotiationPolicy = {
  enabled: true,
  maxRounds: 3,
  windowSeconds: 600,
  maxCountersPerBuyerPerDay: 20,
  defaultMaxDiscountBps: 1_000,
  items: [{ product: CAKE, floorMinorUnits: '21000', autoFloorMinorUnits: '22000' }],
};

describe('floors per line', () => {
  it('an item with its own floors: auto 220, hard 210, both judged against the first price', () => {
    expect(lineBounds(policy, CAKE, 24_000n)).toEqual({ hardFloor: 21_000n, autoFloor: 22_000n });
  });

  it('an item without its own: the default discount off the first price, rounded up', () => {
    // 10% off 333 is 299.7 — the floor is 300, so the discount never exceeds 10%.
    expect(lineBounds(policy, OTHER, 333n)).toEqual({ hardFloor: 300n, autoFloor: 300n });
  });

  it('no floor is above the first price', () => {
    expect(lineBounds(policy, CAKE, 20_000n)).toEqual({ hardFloor: 20_000n, autoFloor: 20_000n });
  });
});

describe('where a proposal lands', () => {
  const bounds = { hardFloor: 21_000n, autoFloor: 22_000n };

  it('above the automatic limit it stands', () => {
    expect(clampProposal(23_000n, bounds, null)).toEqual({ price: 23_000n, needsOwner: false });
  });

  it('between the floors Core signs 220 and asks the owner about the proposal', () => {
    expect(clampProposal(21_500n, bounds, null)).toEqual({
      price: 22_000n,
      needsOwner: true,
      asked: 21_500n,
    });
  });

  it('below the hard floor the owner is asked about the floor, never below it', () => {
    expect(clampProposal(20_000n, bounds, null)).toEqual({
      price: 22_000n,
      needsOwner: true,
      asked: 21_000n,
    });
  });

  it('once the owner said 210, 210 is signed — and still nothing below it', () => {
    expect(clampProposal(21_000n, bounds, 21_000n)).toEqual({ price: 21_000n, needsOwner: false });
    expect(clampProposal(20_000n, bounds, 21_000n)).toEqual({ price: 21_000n, needsOwner: false });
  });

  it('an authorisation outside the floors is ignored', () => {
    expect(clampProposal(19_000n, bounds, 19_000n)).toEqual({ price: 22_000n, needsOwner: false });
  });

  it('with no room between the floors there is nobody to ask', () => {
    expect(clampProposal(100n, { hardFloor: 300n, autoFloor: 300n }, null)).toEqual({
      price: 300n,
      needsOwner: false,
    });
  });
});

describe('the policy on supplier settings', () => {
  const base: SupplierSettings = {
    actingBusinessDid: 'did:plc:bakery',
    catalogSource: { kind: 'inline', lastHealthyAtIso: null },
    publicRegions: [],
    publishIndicativePrice: true,
    quoteAccess: 'anyone',
    responsePolicy: {},
    customerPricingSource: null,
    orderAcceptance: 'auto',
    listingState: 'live',
    connectors: [],
  };

  it('absent is fine; a valid policy is fine', () => {
    expect(validateSupplierSettings(base)).toEqual({ ok: true });
    expect(validateSupplierSettings({ ...base, negotiation: policy })).toEqual({ ok: true });
  });

  it('refuses out-of-range limits, an auto floor under the floor, a bad product and a product twice', () => {
    const findings = negotiationPolicyFindings({
      enabled: 'yes',
      maxRounds: 0,
      windowSeconds: 10,
      maxCountersPerBuyerPerDay: 1000,
      defaultMaxDiscountBps: 9000,
      items: [
        { product: CAKE, floorMinorUnits: '22000', autoFloorMinorUnits: '21000' },
        { product: CAKE, floorMinorUnits: '1' },
        { product: { scheme: 'custom', value: 'x' }, floorMinorUnits: '1' },
        { product: OTHER, floorMinorUnits: '-5' },
      ],
    }).map((f) => f.field);
    expect(findings).toEqual([
      'negotiation.enabled',
      'negotiation.maxRounds',
      'negotiation.windowSeconds',
      'negotiation.maxCountersPerBuyerPerDay',
      'negotiation.defaultMaxDiscountBps',
      'negotiation.items[0].autoFloorMinorUnits',
      'negotiation.items[1].product',
      'negotiation.items[2].product',
      'negotiation.items[3].floorMinorUnits',
    ]);
    expect(
      validateSupplierSettings({ ...base, negotiation: { ...policy, maxRounds: 99 } }).ok,
    ).toBe(false);
  });
});
