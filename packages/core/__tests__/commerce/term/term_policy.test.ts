/**
 * SHELF_SPACE_NEGOTIATION §5.4 — the seller's term policy.
 *
 *   S-02  no first-offer cap: asking terms below a premium-raised floor are
 *         lifted to the automatic limit, and the first offer never asks the
 *         owner (two real engines through both gates);
 *   S-09  every refusal reason of `validateTermPolicy`, and a valid policy;
 *   S-10  `applyHoldingPremium`, `termBounds`, `clampTerm`, `sellerAtLeast`:
 *         rounding once in the seller's favour, hard vs automatic floors, the
 *         owner-authorised value, identities, and large values.
 */

import {
  TERM_NAMES,
  TERM_TABLE,
  type TermListing,
  type TermName,
  type TermOffer,
} from '@dina/commerce-protocol';

import {
  applyHoldingPremium,
  clampTerm,
  DEFAULT_TERM_POLICY,
  sellerAtLeast,
  termBounds,
  validateTermPolicy,
  type TermPolicy,
  type TermResourcePolicy,
} from '../../../src/commerce/term/term_policy';
import { TERM_FLOOR_CARD } from '../../../src/commerce/term/term_seller';

import { publishListing } from './term_harness';
import { BRAND_DID, Fleet, juicePolicy, STORE_DID, type Node } from './term_harness';

const JUICE = 'beverages.juice';

/** Two juice deals made outside Dina, overlapping every requested term below. */
const TWO_JUICE_HOLDINGS = [
  { holding_id: 'h1', tag: JUICE, start: '2027-01-01T00:00:00Z', end: '2027-12-01T00:00:00Z' },
  { holding_id: 'h2', tag: JUICE, start: '2027-01-01T00:00:00Z', end: '2027-12-01T00:00:00Z' },
];

function juiceShelf(): TermResourcePolicy {
  const shelf = juicePolicy().resources[0];
  if (shelf === undefined) throw new Error('the juice policy has no shelf');
  return shelf;
}

/** The juice policy with slot-3's asking terms replaced. */
function askingPolicy(
  asking: { fee: string; share_bps: string },
  over: Partial<TermPolicy> = {},
): TermPolicy {
  const base = juicePolicy();
  return juicePolicy({
    resources: base.resources.map((r) => (r.resource_ref === 'slot-3' ? { ...r, asking } : r)),
    ...over,
  });
}

function setUpStore(
  fleet: Fleet,
  policy: TermPolicy,
): { store: Node; listing: TermListing; uri: string } {
  const store = fleet.add(STORE_DID);
  const set = store.engine.setPolicy(policy);
  if (!set.ok) throw new Error(set.refusal);
  const published = publishListing(store, {
    listingId: 'slot-3',
    resourceRef: 'slot-3',
    kind: 'shelf',
    region: { scheme: 'postal_area', value: 'IN-560034' },
    tags: [JUICE, 'snacks'],
  });
  if (!published.ok) throw new Error(published.refusal);
  return { store, listing: published.listing, uri: published.uri };
}

/** A juice brand asks with no rounds to bargain, so only the first offer is ever made. */
function ask(brand: Node, listing: TermListing, uri: string): string {
  const started = brand.engine.startNegotiation({
    listing,
    listingUri: uri,
    tag: JUICE,
    attributes: { skus: 4 },
    start: '2027-02-01T00:00:00Z',
    end: '2027-08-01T00:00:00Z',
    policy: {
      currency: 'INR',
      targets: { fee: '100000', share_bps: '100' },
      ceilings: { fee: '300000', share_bps: '1000' },
      max_rounds: 0,
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

function termsOf(offer: TermOffer | undefined): Record<string, string> {
  if (offer === undefined) throw new Error('no offer');
  return Object.fromEntries(offer.terms.map((t) => [t.name, t.value]));
}

// ---------------------------------------------------------------------------
// S-02
// ---------------------------------------------------------------------------

describe('S-02 the first offer has no cap and never asks the owner', () => {
  let fleet: Fleet;
  beforeEach(() => {
    fleet = new Fleet();
  });
  afterEach(() => fleet.closeAll());

  function firstOffer(policy: TermPolicy): { store: Node; offer: TermOffer | undefined } {
    const { store, listing, uri } = setUpStore(fleet, policy);
    const brand = fleet.add(BRAND_DID);
    const requestId = ask(brand, listing, uri);
    fleet.pump();
    const chain = offers(brand, requestId);
    expect(chain).toHaveLength(1);
    expect(offers(store, requestId)).toHaveLength(1);
    return { store, offer: chain[0] };
  }

  it('asking between the raised hard floor and the raised automatic limit is lifted to that limit', () => {
    // Two juice deals at 15% each raise every floor by 30%: fee hard 150000 → 195000,
    // auto 180000 → 234000; share hard (= auto) 500 → 650.
    const { store, offer } = firstOffer(
      askingPolicy({ fee: '200000', share_bps: '600' }, { manual_holdings: TWO_JUICE_HOLDINGS }),
    );
    expect(termsOf(offer)).toEqual({ fee: '234000', share_bps: '650' });
    expect(store.cards.filter((c) => c.type === TERM_FLOOR_CARD)).toHaveLength(0);
    // access 'anyone': no stranger card either, so the owner is not asked at all.
    expect(store.cards).toHaveLength(0);
  });

  it('asking below even the raised hard floor is lifted to the automatic limit, with no card', () => {
    const { store, offer } = firstOffer(
      askingPolicy({ fee: '160000', share_bps: '400' }, { manual_holdings: TWO_JUICE_HOLDINGS }),
    );
    expect(termsOf(offer)).toEqual({ fee: '234000', share_bps: '650' });
    expect(store.cards).toHaveLength(0);
  });

  it('with nothing held, asking below the plain automatic limit is lifted to it; a term above stands', () => {
    const { store, offer } = firstOffer(askingPolicy({ fee: '160000', share_bps: '1000' }));
    expect(termsOf(offer)).toEqual({ fee: '180000', share_bps: '1000' });
    expect(store.cards).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// S-09
// ---------------------------------------------------------------------------

type Path = (string | number)[];

/** A valid juice policy with one value at `path` replaced (or removed, for `undefined`). */
function policyWith(path: Path, value: unknown): unknown {
  const root = JSON.parse(JSON.stringify(juicePolicy())) as Record<string | number, unknown>;
  let at: Record<string | number, unknown> = root;
  for (const key of path.slice(0, -1)) at = at[key] as Record<string | number, unknown>;
  const last = path[path.length - 1];
  if (last === undefined) throw new Error('empty path');
  if (value === undefined) Reflect.deleteProperty(at, last);
  else at[last] = value;
  return root;
}

const R0 = ['resources', 0];
const R1 = ['resources', 1];
const RULE = ['holding_rules', 0];
const holding = (over: Record<string, unknown> = {}) => ({
  holding_id: 'm1',
  tag: JUICE,
  start: '2027-01-01T00:00:00Z',
  end: '2027-03-01T00:00:00Z',
  ...over,
});

describe('S-09 validateTermPolicy', () => {
  it('accepts the juice policy and the default policy', () => {
    expect(validateTermPolicy(juicePolicy())).toBeNull();
    expect(validateTermPolicy(DEFAULT_TERM_POLICY)).toBeNull();
  });

  it('accepts the edges of every bounded number', () => {
    for (const [path, value] of [
      [['maxRounds'], 1],
      [['maxRounds'], 10],
      [['windowSeconds'], 60],
      [['windowSeconds'], 7 * 24 * 60 * 60],
      [['maxCountersPerBuyerPerDay'], 1],
      [['maxCountersPerBuyerPerDay'], 200],
      [[...RULE, 'premium_bps_per_count'], 0],
      [[...RULE, 'premium_bps_per_count'], 10_000],
      [[...RULE, 'max_count'], 1],
      [[...RULE, 'max_count'], 1000],
      [[...RULE, 'max_count'], undefined],
      [[...R0, 'conditions', 'exit_notice_days'], 0],
      [[...R0, 'conditions', 'exit_notice_days'], 365],
      [[...R0, 'conditions', 'trial', 'days'], 365],
      [[...R0, 'asking', 'share_bps'], '10000'],
      [[...R0, 'floors', 'fee', 'auto'], '150000'], // auto equal to hard
      [[...R0, 'conditions', 'stock_duties'], { min_skus: 1, restock_days: 10_000 }],
    ] as [Path, unknown][]) {
      expect(validateTermPolicy(policyWith(path, value))).toBeNull();
    }
  });

  it('accepts a manual holding with no resource, and one naming its own resource', () => {
    expect(validateTermPolicy(policyWith(['manual_holdings'], [holding()]))).toBeNull();
    expect(
      validateTermPolicy(policyWith(['manual_holdings'], [holding({ resource_ref: 'slot-4' })])),
    ).toBeNull();
  });

  it('accepts 200 resources and 1000 holdings, the most allowed', () => {
    const shelf = juiceShelf();
    const resources = Array.from({ length: 200 }, (_, i) => ({
      ...shelf,
      resource_ref: `slot-${String(i)}`,
    }));
    expect(validateTermPolicy(juicePolicy({ resources }))).toBeNull();
    const holdings = Array.from({ length: 1000 }, (_, i) =>
      holding({ holding_id: `m${String(i)}` }),
    );
    expect(validateTermPolicy(juicePolicy({ manual_holdings: holdings }))).toBeNull();
  });

  // Each row breaks exactly one rule; the refusal names the field that broke it.
  const refusals: [string, unknown, RegExp][] = [
    ['not an object (null)', null, /^term policy: must be an object/],
    ['not an object (a string)', 'policy', /^term policy: must be an object/],
    ['enabled not a boolean', policyWith(['enabled'], 'yes'), /^enabled:/],
    ['access unknown', policyWith(['access'], 'friends'), /^access:/],
    ['maxRounds 0', policyWith(['maxRounds'], 0), /^maxRounds:/],
    ['maxRounds 11', policyWith(['maxRounds'], 11), /^maxRounds:/],
    ['maxRounds not an integer', policyWith(['maxRounds'], 1.5), /^maxRounds:/],
    ['windowSeconds 59', policyWith(['windowSeconds'], 59), /^windowSeconds:/],
    ['windowSeconds past 7 days', policyWith(['windowSeconds'], 604_801), /^windowSeconds:/],
    [
      'maxCountersPerBuyerPerDay 0',
      policyWith(['maxCountersPerBuyerPerDay'], 0),
      /^maxCountersPerBuyerPerDay:/,
    ],
    [
      'maxCountersPerBuyerPerDay 201',
      policyWith(['maxCountersPerBuyerPerDay'], 201),
      /^maxCountersPerBuyerPerDay:/,
    ],
    ['resources not an array', policyWith(['resources'], {}), /^resources:/],
    ['201 resources', policyWith(['resources'], new Array(201).fill(null)), /^resources:/],
    ['a resource not an object', policyWith(R0, 7), /^resources\[0\]: must be an object/],
    [
      'resource_ref not an id',
      policyWith([...R0, 'resource_ref'], 'slot 3'),
      /^resources\[0\]\.resource_ref:/,
    ],
    ['currency lower case', policyWith([...R0, 'currency'], 'inr'), /^resources\[0\]\.currency:/],
    [
      'available missing',
      policyWith([...R0, 'available'], undefined),
      /^resources\[0\]\.available/,
    ],
    [
      'available.from not a real date',
      policyWith([...R0, 'available', 'from'], '2027-02-30T00:00:00Z'),
      /^resources\[0\]\.available\.from:/,
    ],
    [
      'available.to not UTC',
      policyWith([...R0, 'available', 'to'], '2028-12-31T00:00:00+05:30'),
      /^resources\[0\]\.available\.to:/,
    ],
    [
      'available.to equal to from',
      policyWith([...R0, 'available', 'to'], '2027-01-01T00:00:00Z'),
      /^resources\[0\]\.available\.to: must follow from/,
    ],
    [
      'asking missing',
      policyWith([...R0, 'asking'], undefined),
      /^resources\[0\]: needs asking terms and floors/,
    ],
    [
      'floors missing',
      policyWith([...R0, 'floors'], undefined),
      /^resources\[0\]: needs asking terms and floors/,
    ],
    [
      'asking fee a number',
      policyWith([...R0, 'asking', 'fee'], 250000),
      /^resources\[0\]\.asking\.fee:/,
    ],
    [
      'asking fee missing',
      policyWith([...R0, 'asking', 'fee'], undefined),
      /^resources\[0\]\.asking\.fee:/,
    ],
    [
      'asking fee with a leading zero',
      policyWith([...R0, 'asking', 'fee'], '0250000'),
      /^resources\[0\]\.asking\.fee:/,
    ],
    [
      'asking fee negative',
      policyWith([...R0, 'asking', 'fee'], '-1'),
      /^resources\[0\]\.asking\.fee:/,
    ],
    // Money is bounded at 15 digits.
    [
      'asking fee of 16 digits',
      policyWith([...R0, 'asking', 'fee'], '1000000000000000'),
      /^resources\[0\]\.asking\.fee:/,
    ],
    [
      'asking share past 10000',
      policyWith([...R0, 'asking', 'share_bps'], '10001'),
      /^resources\[0\]\.asking\.share_bps:/,
    ],
    [
      'asking share of 6 digits',
      policyWith([...R0, 'asking', 'share_bps'], '100000'),
      /^resources\[0\]\.asking\.share_bps:/,
    ],
    [
      'asking names an unknown term',
      policyWith([...R0, 'asking', 'deposit'], '1'),
      /^resources\[0\]\.asking\.deposit: not a term/,
    ],
    [
      'a floor missing',
      policyWith([...R0, 'floors', 'share_bps'], undefined),
      /^resources\[0\]\.floors\.share_bps: required/,
    ],
    [
      'a hard floor not canonical',
      policyWith([...R0, 'floors', 'fee', 'hard'], '1.5'),
      /^resources\[0\]\.floors\.fee\.hard:/,
    ],
    [
      'a hard share floor past 10000',
      policyWith([...R0, 'floors', 'share_bps', 'hard'], '10001'),
      /^resources\[0\]\.floors\.share_bps\.hard:/,
    ],
    [
      'an automatic limit not canonical',
      policyWith([...R0, 'floors', 'fee', 'auto'], 'x'),
      /^resources\[0\]\.floors\.fee\.auto:/,
    ],
    // fee favours the buyer when lower, so an automatic limit below the hard floor is past it.
    [
      'an automatic limit past the hard floor',
      policyWith([...R0, 'floors', 'fee', 'auto'], '149999'),
      /^resources\[0\]\.floors\.fee:/,
    ],
    [
      'floors names an unknown term',
      policyWith([...R0, 'floors', 'deposit'], { hard: '1' }),
      /^resources\[0\]\.floors\.deposit: not a term/,
    ],
    [
      'conditions missing',
      policyWith([...R0, 'conditions'], undefined),
      /^resources\[0\]\.conditions: required/,
    ],
    [
      'period yearly',
      policyWith([...R0, 'conditions', 'period'], 'yearly'),
      /^resources\[0\]\.conditions\.period:/,
    ],
    [
      'cash handler unknown',
      policyWith([...R0, 'conditions', 'cash_handler'], 'bank'),
      /^resources\[0\]\.conditions\.cash_handler:/,
    ],
    [
      'exit notice negative',
      policyWith([...R0, 'conditions', 'exit_notice_days'], -1),
      /^resources\[0\]\.conditions\.exit_notice_days:/,
    ],
    [
      'exit notice past 365',
      policyWith([...R0, 'conditions', 'exit_notice_days'], 366),
      /^resources\[0\]\.conditions\.exit_notice_days:/,
    ],
    [
      'trial of 0 days',
      policyWith([...R0, 'conditions', 'trial', 'days'], 0),
      /^resources\[0\]\.conditions\.trial\.days:/,
    ],
    [
      'trial past 365 days',
      policyWith([...R0, 'conditions', 'trial', 'days'], 366),
      /^resources\[0\]\.conditions\.trial\.days:/,
    ],
    [
      'trial fee not canonical',
      policyWith([...R0, 'conditions', 'trial', 'fee_minor'], '01'),
      /^resources\[0\]\.conditions\.trial\.fee_minor:/,
    ],
    [
      'min_skus 0',
      policyWith([...R0, 'conditions', 'stock_duties'], { min_skus: 0 }),
      /^resources\[0\]\.conditions\.stock_duties\.min_skus:/,
    ],
    [
      'min_skus past 10000',
      policyWith([...R0, 'conditions', 'stock_duties'], { min_skus: 10_001 }),
      /^resources\[0\]\.conditions\.stock_duties\.min_skus:/,
    ],
    [
      'restock_days 0',
      policyWith([...R0, 'conditions', 'stock_duties'], { restock_days: 0 }),
      /^resources\[0\]\.conditions\.stock_duties\.restock_days:/,
    ],
    // slot-4 is rent-only (asking share 0); a zero rent leaves it asking nothing.
    [
      'rent and share both zero',
      policyWith([...R1, 'asking', 'fee'], '0'),
      /^resources\[1\]\.asking: rent and share cannot both be zero/,
    ],
    // §5.6 — on a rent-only resource the vendor holds the takings.
    [
      'a rent-only resource with the host holding cash',
      policyWith([...R1, 'conditions', 'cash_handler'], 'host'),
      /^resources\[1\]\.conditions\.cash_handler:/,
    ],
    [
      'a resource listed twice',
      policyWith([...R1, 'resource_ref'], 'slot-3'),
      /^resources\[1\]\.resource_ref: listed twice/,
    ],
    ['holding_rules not an array', policyWith(['holding_rules'], null), /^holding_rules:/],
    ['a rule not an object', policyWith(RULE, null), /^holding_rules\[0\]\.tag:/],
    ['a rule tag not an id', policyWith([...RULE, 'tag'], 'juice!'), /^holding_rules\[0\]\.tag:/],
    [
      'a premium below 0',
      policyWith([...RULE, 'premium_bps_per_count'], -1),
      /^holding_rules\[0\]\.premium_bps_per_count:/,
    ],
    [
      'a premium past 10000',
      policyWith([...RULE, 'premium_bps_per_count'], 10_001),
      /^holding_rules\[0\]\.premium_bps_per_count:/,
    ],
    [
      'a premium not an integer',
      policyWith([...RULE, 'premium_bps_per_count'], 15.5),
      /^holding_rules\[0\]\.premium_bps_per_count:/,
    ],
    ['max_count 0', policyWith([...RULE, 'max_count'], 0), /^holding_rules\[0\]\.max_count:/],
    [
      'max_count past 1000',
      policyWith([...RULE, 'max_count'], 1001),
      /^holding_rules\[0\]\.max_count:/,
    ],
    [
      'two rules for one tag',
      policyWith(
        ['holding_rules'],
        [
          { tag: JUICE, premium_bps_per_count: 1500 },
          { tag: JUICE, premium_bps_per_count: 500 },
        ],
      ),
      /^holding_rules\[1\]\.tag: one rule per tag/,
    ],
    ['manual_holdings not an array', policyWith(['manual_holdings'], 'none'), /^manual_holdings:/],
    [
      '1001 manual holdings',
      policyWith(['manual_holdings'], new Array(1001).fill(null)),
      /^manual_holdings:/,
    ],
    [
      'a holding not an object',
      policyWith(['manual_holdings'], [null]),
      /^manual_holdings\[0\]\.holding_id:/,
    ],
    [
      'a holding id not an id',
      policyWith(['manual_holdings'], [holding({ holding_id: '' })]),
      /^manual_holdings\[0\]\.holding_id:/,
    ],
    [
      'a holding tag not an id',
      policyWith(['manual_holdings'], [holding({ tag: 'a b' })]),
      /^manual_holdings\[0\]\.tag:/,
    ],
    [
      'a holding resource not an id',
      policyWith(['manual_holdings'], [holding({ resource_ref: 'slot/3' })]),
      /^manual_holdings\[0\]\.resource_ref:/,
    ],
    [
      'a holding start not a real date',
      policyWith(['manual_holdings'], [holding({ start: '2027-13-01T00:00:00Z' })]),
      /^manual_holdings\[0\]\.start:/,
    ],
    [
      'a holding end not a timestamp',
      policyWith(['manual_holdings'], [holding({ end: 'tomorrow' })]),
      /^manual_holdings\[0\]\.end:/,
    ],
    [
      'a holding that ends as it starts',
      policyWith(['manual_holdings'], [holding({ end: '2027-01-01T00:00:00Z' })]),
      /^manual_holdings\[0\]\.end: must follow start/,
    ],
    // §5.4 — a holding that occupies a resource must name one of this store's own.
    [
      'a holding on a slot the store does not have',
      policyWith(['manual_holdings'], [holding({ resource_ref: 'slot-9' })]),
      /^manual_holdings\[0\]\.resource_ref: not one of this store's resources/,
    ],
    [
      'a holding id listed twice',
      policyWith(['manual_holdings'], [holding(), holding({ tag: 'snacks' })]),
      /^manual_holdings\[1\]\.holding_id: listed twice/,
    ],
  ];

  it.each(refusals)('refuses %s', (_name, policy, reason) => {
    const refusal = validateTermPolicy(policy);
    expect(refusal).not.toBeNull();
    expect(refusal).toMatch(reason);
  });
});

// ---------------------------------------------------------------------------
// S-10
// ---------------------------------------------------------------------------

/*
 * The S-10 cases speak in strings: Jest cannot carry a BigInt in a failure
 * report between workers, so each wrapper converts at the edge.
 */
const premium = (name: TermName, value: string, count: number, bps: number): string =>
  applyHoldingPremium(name, BigInt(value), count, bps).toString();

const atLeast = (name: TermName, a: string, b: string): boolean =>
  sellerAtLeast(name, BigInt(a), BigInt(b));

function bounds(
  resource: TermResourcePolicy,
  name: TermName,
  count: number,
  bps: number,
): { hard: string; auto: string } {
  const b = termBounds(resource, name, count, bps);
  return { hard: b.hard.toString(), auto: b.auto.toString() };
}

function clamp(
  name: TermName,
  proposed: string,
  b: { hard: string; auto: string },
  authorised: string | null,
): { value: string; needsOwner: boolean; asked?: string } {
  const c = clampTerm(
    name,
    BigInt(proposed),
    { hard: BigInt(b.hard), auto: BigInt(b.auto) },
    authorised === null ? null : BigInt(authorised),
  );
  return c.needsOwner
    ? { value: c.value.toString(), needsOwner: true, asked: c.asked.toString() }
    : { value: c.value.toString(), needsOwner: false };
}

describe('S-10 the policy arithmetic', () => {
  it('reads the term table: in v1 both terms favour the buyer when lower', () => {
    // So the seller's favour is HIGHER for both, and a premium rounds both UP.
    expect(TERM_NAMES).toEqual(['fee', 'share_bps']);
    expect(TERM_TABLE.fee.buyerFavours).toBe('lower');
    expect(TERM_TABLE.share_bps.buyerFavours).toBe('lower');
  });

  describe('sellerAtLeast', () => {
    it.each(TERM_NAMES)('%s: higher or equal is at least as good for the seller', (name) => {
      expect(atLeast(name, '2', '1')).toBe(true);
      expect(atLeast(name, '1', '1')).toBe(true);
      expect(atLeast(name, '1', '2')).toBe(false);
    });
  });

  describe('applyHoldingPremium', () => {
    it('the juice example: ₹1,500 rises 30% for two and 45% for three', () => {
      expect(premium('fee', '150000', 2, 1500)).toBe('195000');
      expect(premium('fee', '150000', 3, 1500)).toBe('217500');
      expect(premium('share_bps', '500', 2, 1500)).toBe('650');
    });

    it.each(TERM_NAMES)('%s rounds up, the seller’s way', (name) => {
      // 333 × 1.15 = 382.95
      expect(premium(name, '333', 1, 1500)).toBe('383');
      // 1 × 1.0001 = 1.0001
      expect(premium(name, '1', 1, 1)).toBe('2');
      // 9999 × 1.0001 = 9999.9999
      expect(premium(name, '9999', 1, 1)).toBe('10000');
    });

    it.each(TERM_NAMES)('%s rounds once, on the summed premium', (name) => {
      // 1 × (1 + 2 × 0.0001) = 1.0002 → 2. Rounding after each count would give
      // 1 → 2 → 3. The sum, not a compound, is the juice example's rule.
      expect(premium(name, '1', 2, 1)).toBe('2');
      // 333 × (1 + 3 × 0.15) = 482.85 → 483; per count: 383 → 441 → 508.
      expect(premium(name, '333', 3, 1500)).toBe('483');
    });

    it.each(TERM_NAMES)('%s: count 0 and premium 0 leave the value as it is', (name) => {
      expect(premium(name, '333', 0, 1500)).toBe('333');
      expect(premium(name, '333', 4, 0)).toBe('333');
      expect(premium(name, '0', 4, 1500)).toBe('0');
    });

    it('a share is capped at 10,000 bps; a fee is not', () => {
      // 9000 × 1.3 = 11700
      expect(premium('share_bps', '9000', 2, 1500)).toBe('10000');
      expect(premium('share_bps', '10000', 1000, 10_000)).toBe('10000');
      expect(premium('fee', '9000', 2, 1500)).toBe('11700');
    });

    it('a 15-digit fee at the largest premium stays exact', () => {
      const largest = '999999999999999';
      // 1000 holdings × 100% = × 1001, exactly.
      expect(premium('fee', largest, 1000, 10_000)).toBe('1000999999999998999');
      // × 1.0001 = 1000099999999998.9999 → up to ...999; a float would lose the last digits.
      expect(premium('fee', largest, 1, 1)).toBe('1000099999999999');
    });
  });

  describe('termBounds', () => {
    const shelf = juiceShelf();

    it('raises the hard floor and the automatic limit alike', () => {
      expect(bounds(shelf, 'fee', 2, 1500)).toEqual({ hard: '195000', auto: '234000' });
      // No automatic limit set: it is the hard floor.
      expect(bounds(shelf, 'share_bps', 2, 1500)).toEqual({ hard: '650', auto: '650' });
    });

    it('with nothing held, the floors are the policy’s own', () => {
      expect(bounds(shelf, 'fee', 0, 1500)).toEqual({ hard: '150000', auto: '180000' });
      expect(bounds(shelf, 'share_bps', 0, 1500)).toEqual({ hard: '500', auto: '500' });
      expect(bounds(shelf, 'fee', 3, 0)).toEqual({ hard: '150000', auto: '180000' });
    });

    it('rounds each bound up on its own', () => {
      const odd: TermResourcePolicy = {
        ...shelf,
        floors: { fee: { hard: '333', auto: '9999' }, share_bps: { hard: '1' } },
      };
      // 333 × 1.15 = 382.95; 9999 × 1.15 = 11498.85; 1 × 1.15 = 1.15
      expect(bounds(odd, 'fee', 1, 1500)).toEqual({ hard: '383', auto: '11499' });
      expect(bounds(odd, 'share_bps', 1, 1500)).toEqual({ hard: '2', auto: '2' });
    });
  });

  describe('clampTerm', () => {
    // The juice shelf with two juice deals in force.
    const fee = { hard: '195000', auto: '234000' };
    const share = { hard: '650', auto: '650' };

    it('a proposal at or above the automatic limit is signed as is', () => {
      expect(clamp('fee', '250000', fee, null)).toEqual({ value: '250000', needsOwner: false });
      expect(clamp('fee', '234000', fee, null)).toEqual({ value: '234000', needsOwner: false });
    });

    it('a proposal between the floors is held at the automatic limit and asks the owner', () => {
      expect(clamp('fee', '210000', fee, null)).toEqual({
        value: '234000',
        needsOwner: true,
        asked: '210000',
      });
      expect(clamp('fee', '195000', fee, null)).toEqual({
        value: '234000',
        needsOwner: true,
        asked: '195000',
      });
    });

    it('a proposal past the hard floor asks the owner only for the hard floor', () => {
      expect(clamp('fee', '100000', fee, null)).toEqual({
        value: '234000',
        needsOwner: true,
        asked: '195000',
      });
      expect(clamp('fee', '0', fee, null)).toEqual({
        value: '234000',
        needsOwner: true,
        asked: '195000',
      });
    });

    it('with no room between the floors there is nothing to ask: the floor is signed', () => {
      expect(clamp('share_bps', '600', share, null)).toEqual({ value: '650', needsOwner: false });
      expect(clamp('share_bps', '700', share, null)).toEqual({ value: '700', needsOwner: false });
      expect(clamp('share_bps', '650', share, null)).toEqual({ value: '650', needsOwner: false });
    });

    it('an owner-authorised value between the floors is honoured without a new card', () => {
      expect(clamp('fee', '210000', fee, '210000')).toEqual({
        value: '210000',
        needsOwner: false,
      });
      expect(clamp('fee', '220000', fee, '210000')).toEqual({
        value: '220000',
        needsOwner: false,
      });
      // The owner said yes at the hard floor itself.
      expect(clamp('fee', '195000', fee, '195000')).toEqual({
        value: '195000',
        needsOwner: false,
      });
    });

    it('a proposal under the authorised value is moved up to it, never further down', () => {
      const below = clamp('fee', '200000', fee, '210000');
      expect(below.value).toBe('210000');
      const past = clamp('fee', '100000', fee, '195000');
      expect(past.value).toBe('195000');
    });

    it('an "authorised" value past the hard floor is ignored: nothing is signed past it', () => {
      expect(clamp('fee', '190000', fee, '190000')).toEqual({
        value: '234000',
        needsOwner: true,
        asked: '195000',
      });
    });

    it('an authorised value at or above the automatic limit grants nothing new', () => {
      expect(clamp('fee', '220000', fee, '240000')).toEqual({
        value: '234000',
        needsOwner: true,
        asked: '220000',
      });
      expect(clamp('fee', '236000', fee, '234000')).toEqual({
        value: '236000',
        needsOwner: false,
      });
    });

    it('works on 15-digit fees without loss', () => {
      const big = { hard: '900000000000000', auto: '999999999999999' };
      expect(clamp('fee', '999999999999998', big, null)).toEqual({
        value: '999999999999999',
        needsOwner: true,
        asked: '999999999999998',
      });
      expect(clamp('fee', '1000999999999998999', big, null)).toEqual({
        value: '1000999999999998999',
        needsOwner: false,
      });
    });
  });
});
