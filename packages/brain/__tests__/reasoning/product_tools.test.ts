/**
 * `search_products` + `recommend_offer` — the consumer research tools (§5.A).
 * `search_products` orchestrates AppView catalog discovery + seller trust
 * through the pure @dina/core engines and emits a MONEY-FREE where-to-buy
 * comparison card; it never completes a purchase and never scores absent trust
 * as a zero. `recommend_offer` commits the loop's preference-weighed pick to
 * that card (§5.A6) — naming only offers the research holds, re-scoring nothing.
 */

import { CommerceCatalogCandidate } from '../../src/appview_client/http';
import {
  createProductResearchTools,
  createResearchCache,
  ProductToolAppViewClient,
  ProductToolCoreClient,
  RecommendOfferResult,
  RESEARCH_CACHE_MAX,
  RESEARCH_TTL_MS,
  SearchProductsResult,
} from '../../src/reasoning/product_tools';

import type { Contact } from '@dina/core';

const FIXED = () => new Date('2026-08-08T10:00:00.000Z');

/** A directory with no contacts — every seller is a stranger. */
const NO_CONTACTS: ProductToolCoreClient = { contactLookup: async () => null };

/** A directory keyed by DID; `contactLookup` matches a DID exactly, as Core does. */
function directory(contacts: Record<string, Partial<Contact>>): ProductToolCoreClient {
  return {
    contactLookup: async (query: string) => {
      const row = contacts[query];
      if (row === undefined) return null;
      return {
        personId: 'p',
        did: query,
        displayName: 'unnamed',
        trustLevel: 'unknown',
        sharingTier: 'summary',
        relationship: 'unknown',
        dataResponsibility: 'external',
        aliases: [],
        notes: '',
        createdAt: 0,
        updatedAt: 0,
        ...row,
      } as Contact;
    },
  };
}

function candidate(
  overrides: Partial<CommerceCatalogCandidate> & { supplierDid: string },
): CommerceCatalogCandidate {
  return {
    serviceUri: `at://${overrides.supplierDid}/svc`,
    serviceRkey: 'self',
    product: { scheme: 'gtin', value: '08901234567890' },
    catalogSnapshotRef: 'snap',
    matchedFields: ['identifier'],
    indicativePrice: { currency: 'INR', minorUnits: '50000' },
    fulfilmentRegions: [{ scheme: 'iso-3166-2', value: 'IN-KA' }],
    generatedAt: '2026-08-08T10:00:00.000Z',
    retrievalScoreBp: 6000,
    ...overrides,
  };
}

function makeClient(
  candidates: CommerceCatalogCandidate[],
  trust: Record<string, number>,
): ProductToolAppViewClient {
  return {
    searchCatalog: async () => candidates,
    getProfile: async (did: string) =>
      did in trust ? { overallTrustScore: trust[did] } : null,
  };
}

/** A tool pair over a fixture AppView + directory; `search` and `recommend` drive them. */
function tools(
  candidates: CommerceCatalogCandidate[],
  trust: Record<string, number>,
  core: ProductToolCoreClient = NO_CONTACTS,
  now: () => Date = FIXED,
) {
  const pair = createProductResearchTools({ appViewClient: makeClient(candidates, trust), core, now });
  return {
    pair,
    search: async (args: Record<string, unknown>) => (await pair.searchProducts.execute(args)) as SearchProductsResult,
    recommend: async (args: Record<string, unknown>) =>
      (await pair.recommendOffer.execute(args)) as RecommendOfferResult,
  };
}

async function run(
  candidates: CommerceCatalogCandidate[],
  trust: Record<string, number>,
  args: Record<string, unknown>,
  core: ProductToolCoreClient = NO_CONTACTS,
): Promise<SearchProductsResult> {
  return tools(candidates, trust, core).search(args);
}

describe('search_products — money-free consumer research', () => {
  it('is a money-free tool named search_products', () => {
    const { pair } = tools([], {});
    expect(pair.searchProducts.name).toBe('search_products');
    expect(pair.searchProducts.description.toLowerCase()).toContain('money-free');
    expect(pair.recommendOffer.name).toBe('recommend_offer');
    expect(pair.searchProducts.terminal).toBeUndefined();
    expect(pair.recommendOffer.terminal).toBeUndefined();
  });

  it('compares offers across suppliers and returns a where-to-buy card', async () => {
    const result = await run(
      [
        candidate({
          supplierDid: 'did:plc:dear',
          catalogSnapshotRef: 's1',
          indicativePrice: { currency: 'INR', minorUnits: '90000' },
        }),
        candidate({
          supplierDid: 'did:plc:cheap',
          catalogSnapshotRef: 's2',
          indicativePrice: { currency: 'INR', minorUnits: '50000' },
        }),
      ],
      { 'did:plc:dear': 0.9, 'did:plc:cheap': 0.5 },
      { query: 'oak chair' },
    );
    expect(result.card?.primaryAction).toBe('where_to_buy');
    expect(result.card?.handoff).toHaveLength(2);
    expect(result.ranked.map((r) => r.supplierDid)).toEqual(['did:plc:cheap', 'did:plc:dear']);
    expect(result.ranked.find((r) => r.supplierDid === 'did:plc:dear')?.trustPercent).toBe(90);
    expect(result.failed).toBeUndefined();
  });

  it('hands the loop prices in MAJOR units, never the wire minor units (a hundredfold misread)', async () => {
    const result = await run(
      [
        candidate({ supplierDid: 'did:plc:inr', indicativePrice: { currency: 'INR', minorUnits: '449900' } }),
        candidate({
          supplierDid: 'did:plc:inr2',
          catalogSnapshotRef: 's2',
          indicativePrice: { currency: 'INR', minorUnits: '5' },
        }),
      ],
      {},
      { query: 'x' },
    );
    expect(result.ranked.map((r) => r.price)).toEqual(['INR 0.05', 'INR 4499.00']);
    expect(result.ranked[0]).not.toHaveProperty('total');
    expect(result.ranked[0]).not.toHaveProperty('currency');
    // The card the phone renders says the same thing.
    expect(result.card?.fields.find((f) => f.label === 'Indicative price')?.value).toBe('INR 0.05');
  });

  it('hands the loop seller trust as a percentage — no basis-point field remains, even on an offer that has trust', async () => {
    const result = await run([candidate({ supplierDid: 'did:plc:t' })], { 'did:plc:t': 0.937 }, { query: 'x' });
    expect(result.ranked[0].trustPercent).toBe(94);
    expect(result.ranked[0]).not.toHaveProperty('trustBp');
  });

  it('a stated price that is not Money never ranks and never sinks the research — it is reported with the reason', async () => {
    const result = await run(
      [
        candidate({ supplierDid: 'did:plc:good', catalogSnapshotRef: 's1' }),
        candidate({ supplierDid: 'did:plc:free', catalogSnapshotRef: 's2', indicativePrice: { currency: 'INR', minorUnits: '' } }),
        candidate({ supplierDid: 'did:plc:neg', catalogSnapshotRef: 's3', indicativePrice: { currency: 'INR', minorUnits: '-4050' } }),
        candidate({ supplierDid: 'did:plc:dec', catalogSnapshotRef: 's4', indicativePrice: { currency: 'INR', minorUnits: '12.50' } }),
      ],
      {},
      { query: 'x' },
    );
    expect(result.failed).toBeUndefined();
    expect(result.ranked.map((r) => r.supplierDid)).toEqual(['did:plc:good']);
    expect(result.unpriced.map((u) => u.supplierDid).sort()).toEqual(['did:plc:dec', 'did:plc:free', 'did:plc:neg']);
    expect(result.unpriced.every((u) => typeof u.malformedPrice === 'string' && u.malformedPrice.startsWith('money:'))).toBe(true);
    // The malformed rows are not "free": the card's Recommended is the good seller.
    expect(result.card?.fields.find((f) => f.label === 'Recommended')?.value).toBe('did:plc:good');
  });

  it('keeps ONE listing per supplier — the cheapest valid price — and says how many it folded', async () => {
    const result = await run(
      [
        candidate({ supplierDid: 'did:plc:twice', catalogSnapshotRef: 's1', indicativePrice: { currency: 'INR', minorUnits: '60000' } }),
        candidate({ supplierDid: 'did:plc:twice', catalogSnapshotRef: 's2', indicativePrice: { currency: 'INR', minorUnits: '55000' } }),
        candidate({ supplierDid: 'did:plc:twice', catalogSnapshotRef: 's3', indicativePrice: undefined }),
        candidate({ supplierDid: 'did:plc:once', catalogSnapshotRef: 's4', indicativePrice: { currency: 'INR', minorUnits: '70000' } }),
      ],
      {},
      { query: 'x' },
    );
    expect(result.ranked.map((r) => [r.supplierDid, r.price])).toEqual([
      ['did:plc:twice', 'INR 550.00'],
      ['did:plc:once', 'INR 700.00'],
    ]);
    // The supplier's unpriced duplicate is folded, not reported as a third listing.
    expect(result.unpriced).toEqual([]);
    expect(result.handoff.map((h) => h.supplierDid)).toEqual(['did:plc:twice', 'did:plc:once']);
    // The surviving link is the listing that won.
    expect(result.handoff[0].serviceUri).toBe('at://did:plc:twice/svc');
    expect(result.note).toMatch(/Kept one listing per supplier — 2 duplicate listing\(s\)/);
  });

  it('leaves a supplier with no trust profile unscored (never a zero)', async () => {
    const result = await run([candidate({ supplierDid: 'did:plc:notrust' })], {}, { query: 'x' });
    expect(result.ranked[0].trustPercent).toBeUndefined();
    expect(result.card?.incomparable.some((l) => l.startsWith('trust:'))).toBe(true);
  });

  describe('the seller as the owner knows them (A6)', () => {
    it('names a supplier who is one of the owner’s contacts — name, trust level, preferred_for', async () => {
      const result = await run(
        [
          candidate({ supplierDid: 'did:plc:chairmaker', catalogSnapshotRef: 's1' }),
          candidate({ supplierDid: 'did:plc:stranger', catalogSnapshotRef: 's2' }),
          candidate({ supplierDid: 'did:plc:alonso', catalogSnapshotRef: 's3', indicativePrice: undefined }),
        ],
        {},
        { query: 'chair' },
        directory({
          'did:plc:chairmaker': { displayName: 'ChairMaker', trustLevel: 'verified' },
          'did:plc:alonso': {
            displayName: 'Don Alonso Furniture',
            trustLevel: 'trusted',
            preferredFor: ['office furniture', 'chairs'],
          },
        }),
      );
      const byDid = new Map(result.ranked.map((r) => [r.supplierDid, r]));
      expect(byDid.get('did:plc:chairmaker')?.contact).toEqual({
        name: 'ChairMaker',
        trustLevel: 'verified',
        preferredFor: [],
      });
      // A stranger carries no contact — the model must not be handed an
      // invented name.
      expect(byDid.get('did:plc:stranger')).not.toHaveProperty('contact');
      // The card the phone renders carries the owner's names too — on the
      // recommendation, the alternatives and the where-to-buy links.
      const shown = [
        result.card?.fields.find((f) => f.label === 'Recommended')?.value,
        ...(result.card?.alternatives.map((a) => a.seller) ?? []),
      ].sort();
      expect(shown).toEqual(['ChairMaker (did:plc:chairmaker)', 'did:plc:stranger']);
      expect(result.handoff.find((h) => h.supplierDid === 'did:plc:chairmaker')?.sellerName).toBe('ChairMaker');
      expect(result.handoff.find((h) => h.supplierDid === 'did:plc:stranger')).not.toHaveProperty('sellerName');
      // Unpriced listings are annotated too: "your go-to seller lists it but
      // states no price" is worth knowing.
      expect(result.unpriced).toEqual([
        {
          supplierDid: 'did:plc:alonso',
          serviceUri: 'at://did:plc:alonso/svc',
          contact: { name: 'Don Alonso Furniture', trustLevel: 'trusted', preferredFor: ['office furniture', 'chairs'] },
        },
      ]);
    });

    it('a lookup that answers a DIFFERENT contact (alias or name match) is not attached to this seller', async () => {
      const core: ProductToolCoreClient = {
        contactLookup: async () =>
          ({ did: 'did:plc:someone-else', displayName: 'Someone Else', trustLevel: 'verified' }) as Contact,
      };
      const result = await run([candidate({ supplierDid: 'did:plc:x' })], {}, { query: 'x' }, core);
      expect(result.ranked[0]).not.toHaveProperty('contact');
    });

    it('a directory fault leaves the seller unnamed and the offer in the list (fail-soft, logged by DID)', async () => {
      const events: Record<string, unknown>[] = [];
      const { searchProducts } = createProductResearchTools({
        appViewClient: makeClient([candidate({ supplierDid: 'did:plc:x' })], {}),
        core: {
          contactLookup: async () => {
            throw new Error('directory down');
          },
        },
        logger: (e: Record<string, unknown>) => events.push(e),
        now: FIXED,
      });
      const result = (await searchProducts.execute({ query: 'x' })) as SearchProductsResult;
      expect(result.ranked.map((r) => r.supplierDid)).toEqual(['did:plc:x']);
      expect(result.ranked[0]).not.toHaveProperty('contact');
      expect(events).toContainEqual({
        event: 'search_products.contact_lookup_failed',
        did: 'did:plc:x',
        error: 'directory down',
      });
    });

    it('looks each supplier up once, by DID — a supplier listed twice is one lookup', async () => {
      const seen: string[] = [];
      const core: ProductToolCoreClient = {
        contactLookup: async (q) => {
          seen.push(q);
          return null;
        },
      };
      await run(
        [
          candidate({ supplierDid: 'did:plc:a', catalogSnapshotRef: 's1' }),
          candidate({ supplierDid: 'did:plc:a', catalogSnapshotRef: 's1b', indicativePrice: { currency: 'INR', minorUnits: '40000' } }),
          candidate({ supplierDid: 'did:plc:b', catalogSnapshotRef: 's2' }),
          candidate({ supplierDid: 'did:plc:c', catalogSnapshotRef: 's3', indicativePrice: undefined }),
        ],
        {},
        { query: 'x' },
        core,
      );
      expect([...seen].sort()).toEqual(['did:plc:a', 'did:plc:b', 'did:plc:c']);
    });

    it('looks suppliers up a few at a time, never all twenty at once', async () => {
      let inFlight = 0;
      let peak = 0;
      const core: ProductToolCoreClient = {
        contactLookup: async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 2));
          inFlight -= 1;
          return null;
        },
      };
      const many = Array.from({ length: 20 }, (_, i) =>
        candidate({ supplierDid: `did:plc:s${String(i)}`, catalogSnapshotRef: `s${String(i)}` }),
      );
      const result = await run(many, {}, { query: 'x' }, core);
      expect(result.ranked).toHaveLength(20);
      expect(peak).toBeLessThanOrEqual(4);
      expect(peak).toBeGreaterThan(1);
    });
  });

  it('anchors on the first priced currency and reports off-currency offers, never converts', async () => {
    const result = await run(
      [
        candidate({
          supplierDid: 'did:plc:inr',
          catalogSnapshotRef: 's1',
          indicativePrice: { currency: 'INR', minorUnits: '50000' },
        }),
        candidate({
          supplierDid: 'did:plc:usd',
          catalogSnapshotRef: 's2',
          indicativePrice: { currency: 'USD', minorUnits: '5000' },
        }),
      ],
      {},
      { query: 'x' },
    );
    expect(result.ranked.map((r) => r.supplierDid)).toEqual(['did:plc:inr']);
    expect(
      result.card?.fields.some(
        (f) => f.value.includes('did:plc:usd') && f.value.includes('currency_mismatch'),
      ),
    ).toBe(true);
  });

  it('surfaces suppliers that list the product without a price', async () => {
    const result = await run(
      [
        candidate({ supplierDid: 'did:plc:priced' }),
        candidate({ supplierDid: 'did:plc:bare', catalogSnapshotRef: 's3', indicativePrice: undefined }),
      ],
      {},
      { query: 'x' },
    );
    expect(result.unpriced.map((u) => u.supplierDid)).toEqual(['did:plc:bare']);
    expect(result.ranked.map((r) => r.supplierDid)).toEqual(['did:plc:priced']);
  });

  it('accepts identifiers without a free-text query', async () => {
    const result = await run([candidate({ supplierDid: 'did:plc:x' })], {}, {
      identifiers: ['gtin:08901234567890'],
    });
    expect(result.ranked).toHaveLength(1);
    expect(result.card?.primaryAction).toBe('where_to_buy');
  });

  it('requires query or identifiers', async () => {
    const { pair } = tools([], {});
    await expect(pair.searchProducts.execute({})).rejects.toThrow(/query.*identifiers/);
  });

  it('forwards query / identifiers / region / limit to discovery', async () => {
    let seen: unknown;
    const client: ProductToolAppViewClient = {
      searchCatalog: async (p) => {
        seen = p;
        return [];
      },
      getProfile: async () => null,
    };
    const { searchProducts } = createProductResearchTools({ appViewClient: client, core: NO_CONTACTS, resultLimit: 7, now: FIXED });
    await searchProducts.execute({ query: 'q', identifiers: ['gtin:1'], region: 'iso-3166-2:IN-KA' });
    expect(seen).toEqual({ q: 'q', identifiers: ['gtin:1'], region: 'iso-3166-2:IN-KA', limit: 7 });
  });

  it('reports an outage rather than "no offers" when discovery throws', async () => {
    const client: ProductToolAppViewClient = {
      searchCatalog: async () => {
        throw new Error('appview down');
      },
      getProfile: async () => null,
    };
    const { searchProducts } = createProductResearchTools({ appViewClient: client, core: NO_CONTACTS, now: FIXED });
    const result = (await searchProducts.execute({ query: 'x' })) as SearchProductsResult;
    expect(result.failed).toBe(true);
    expect(result.card).toBeUndefined();
    expect(result.researchId).toBeUndefined();
    expect(result.note).toMatch(/unavailable/i);
  });

  it('says nobody lists it when discovery returns nothing, with NO empty card', async () => {
    const result = await run([], {}, { query: 'x' });
    expect(result.note).toMatch(/No supplier lists/i);
    expect(result.ranked).toEqual([]);
    // An empty result, not an empty "no offer met the requirements" card.
    expect(result.card).toBeUndefined();
    expect(result.researchId).toBeUndefined();
  });

  it('compares only the best-matching product; a cheaper DIFFERENT item cannot win', async () => {
    const result = await run(
      [
        candidate({
          supplierDid: 'did:plc:chairA',
          catalogSnapshotRef: 's1',
          product: { scheme: 'gtin', value: 'CHAIR-0001' },
          retrievalScoreBp: 9000,
          indicativePrice: { currency: 'INR', minorUnits: '80000' },
        }),
        candidate({
          supplierDid: 'did:plc:chairB',
          catalogSnapshotRef: 's2',
          product: { scheme: 'gtin', value: 'CHAIR-0001' },
          retrievalScoreBp: 7000,
          indicativePrice: { currency: 'INR', minorUnits: '90000' },
        }),
        candidate({
          supplierDid: 'did:plc:stool',
          catalogSnapshotRef: 's3',
          product: { scheme: 'gtin', value: 'STOOL-9999' },
          retrievalScoreBp: 3000,
          // A cheaper but DIFFERENT product — must never be recommended for a chair.
          indicativePrice: { currency: 'INR', minorUnits: '20000' },
        }),
      ],
      {},
      { query: 'oak chair' },
    );
    expect([...result.ranked.map((r) => r.supplierDid)].sort()).toEqual([
      'did:plc:chairA',
      'did:plc:chairB',
    ]);
    expect(result.ranked.some((r) => r.supplierDid === 'did:plc:stool')).toBe(false);
    expect(result.card?.handoff?.some((h) => h.supplierDid === 'did:plc:stool')).toBe(false);
    expect(result.note).toMatch(/other products/i);
  });
});

describe('recommend_offer — the loop commits its preference-weighed pick to the card (§5.A6)', () => {
  const CATALOG = [
    candidate({ supplierDid: 'did:plc:cheap', catalogSnapshotRef: 's1', indicativePrice: { currency: 'INR', minorUnits: '449900' } }),
    candidate({ supplierDid: 'did:plc:steady', catalogSnapshotRef: 's2', indicativePrice: { currency: 'INR', minorUnits: '589900' } }),
    candidate({ supplierDid: 'did:plc:sworn', catalogSnapshotRef: 's3', indicativePrice: { currency: 'INR', minorUnits: '419900' } }),
    candidate({ supplierDid: 'did:plc:bare', catalogSnapshotRef: 's4', indicativePrice: undefined }),
  ];
  const TRUST = { 'did:plc:cheap': 0.28, 'did:plc:steady': 0.94, 'did:plc:sworn': 0.83 };
  const DIRECTORY = directory({ 'did:plc:sworn': { displayName: 'ChairMaker', trustLevel: 'verified' } });

  it('rebuilds the SAME research’s card with the pick on top, the reason in the owner’s terms, and the set-aside seller gone', async () => {
    const t = tools(CATALOG, TRUST, DIRECTORY);
    const found = await t.search({ query: 'chair' });
    expect(found.researchId).toMatch(/^research_/);
    // The ranking's own #1 is the cheapest — the sworn-off seller.
    expect(found.card?.fields.find((f) => f.label === 'Recommended')?.value).toBe('ChairMaker (did:plc:sworn)');

    const out = await t.recommend({
      research_id: found.researchId,
      supplier_did: 'did:plc:steady',
      reason: 'your rule: a proven seller over the cheapest',
      set_aside: [{ supplier_did: 'did:plc:sworn', reason: 'you swore off ChairMaker after a cracked base' }],
    });
    expect(out.recommended).toBe('did:plc:steady');
    const value = (label: string) => out.card.fields.find((f) => f.label === label)?.value;
    expect(value('Recommended')).toBe('did:plc:steady');
    expect(value('Chosen for')).toBe('your rule: a proven seller over the cheapest');
    expect(value('Set aside')).toBe('ChairMaker (did:plc:sworn): you swore off ChairMaker after a cracked base');
    expect(value('Indicative price')).toBe('INR 5899.00');
    // The passed-over #1 stays visible; the set-aside seller leaves the alternatives and the links.
    expect(out.card.alternatives.map((a) => a.supplierDid)).toEqual(['did:plc:cheap']);
    expect(out.card.handoff?.map((h) => h.supplierDid)).toEqual(['did:plc:cheap', 'did:plc:steady', 'did:plc:bare']);
    expect(out.card.primaryAction).toBe('where_to_buy');
  });

  it('a pick of NOTHING is a card that says so in the owner’s terms', async () => {
    const t = tools(CATALOG, TRUST);
    const found = await t.search({ query: 'chair' });
    const out = await t.recommend({ research_id: found.researchId, reason: 'nothing fits your ₹4,000 cap' });
    expect(out.recommended).toBeNull();
    expect(out.card.fields.find((f) => f.label === 'Recommended')?.value).toBe('none — nothing fits your ₹4,000 cap');
    expect(out.card.alternatives).toHaveLength(3);
  });

  it('names only what the research holds: an unknown supplier, a set-aside stranger, or the pick set aside are refused', async () => {
    const t = tools(CATALOG, TRUST);
    const { researchId } = await t.search({ query: 'chair' });
    await expect(t.recommend({ research_id: researchId, supplier_did: 'did:plc:nobody', reason: 'x' })).rejects.toThrow(
      /not among the ranked offers/,
    );
    // An unpriced listing is held by the research (it may be set aside) but is
    // not a ranked offer (it cannot be the pick).
    await expect(t.recommend({ research_id: researchId, supplier_did: 'did:plc:bare', reason: 'x' })).rejects.toThrow(
      /not among the ranked offers/,
    );
    await expect(
      t.recommend({ research_id: researchId, reason: 'x', set_aside: [{ supplier_did: 'did:plc:nobody', reason: 'y' }] }),
    ).rejects.toThrow(/does not hold/);
    await expect(
      t.recommend({
        research_id: researchId,
        supplier_did: 'did:plc:steady',
        reason: 'x',
        set_aside: [{ supplier_did: 'did:plc:steady', reason: 'y' }],
      }),
    ).rejects.toThrow(/cannot also be set aside/);
    await expect(t.recommend({ research_id: researchId, supplier_did: 'did:plc:steady', reason: '  ' })).rejects.toThrow(
      /reason is required/,
    );
    await expect(t.recommend({ reason: 'x' })).rejects.toThrow(/unknown or expired research_id/);
    await expect(t.recommend({ research_id: researchId, reason: 'x', set_aside: 'did:plc:cheap' })).rejects.toThrow(
      /set_aside must be an array/,
    );
    await expect(t.recommend({ research_id: researchId, reason: 'x', set_aside: [{ supplier_did: 'did:plc:cheap' }] })).rejects.toThrow(
      /needs supplier_did and reason/,
    );
  });

  it('set_aside is bounded: no supplier twice, never more entries than suppliers', async () => {
    const t = tools(CATALOG, TRUST);
    const { researchId } = await t.search({ query: 'chair' });
    await expect(
      t.recommend({
        research_id: researchId,
        reason: 'x',
        set_aside: [
          { supplier_did: 'did:plc:cheap', reason: 'a' },
          { supplier_did: 'did:plc:cheap', reason: 'b' },
        ],
      }),
    ).rejects.toThrow(/names did:plc:cheap twice/);
    const tooMany = Array.from({ length: 5 }, () => ({ supplier_did: 'did:plc:cheap', reason: 'a' }));
    await expect(t.recommend({ research_id: researchId, reason: 'x', set_aside: tooMany })).rejects.toThrow(
      /lists 5 entries for 4 suppliers/,
    );
  });

  it('the note steers the model back to answering, never to describing the card', async () => {
    const t = tools(CATALOG, TRUST);
    const { researchId } = await t.search({ query: 'chair' });
    const picked = await t.recommend({ research_id: researchId, supplier_did: 'did:plc:steady', reason: 'x' });
    expect(picked.note).toMatch(/Now answer the user in full/);
    expect(picked.note).toMatch(/Do not describe this card or this tool/);
    const none = await t.recommend({ research_id: researchId, reason: 'x' });
    expect(none.note).toMatch(/or that nothing fits/);
  });

  it('a forged, foreign or expired research_id is a typed refusal, never a card; a live one resolves up to the TTL', async () => {
    let clock = new Date('2026-08-08T10:00:00.000Z');
    const t = tools(CATALOG, TRUST, NO_CONTACTS, () => clock);
    await expect(t.recommend({ research_id: 'research_forged', reason: 'x' })).rejects.toThrow(/unknown or expired/);
    const { researchId } = await t.search({ query: 'chair' });
    // Another pipeline's cache does not know this id.
    await expect(tools(CATALOG, TRUST).recommend({ research_id: researchId, reason: 'x' })).rejects.toThrow(/unknown or expired/);
    // Still live at the edge of the window…
    clock = new Date(clock.getTime() + RESEARCH_TTL_MS);
    await expect(t.recommend({ research_id: researchId, reason: 'x' })).resolves.toMatchObject({ recommended: null });
    // …gone one millisecond past it.
    clock = new Date(clock.getTime() + 1);
    await expect(t.recommend({ research_id: researchId, reason: 'x' })).rejects.toThrow(/unknown or expired/);
  });

  it('the cache is bounded: the newest 16 stay, the one before them is forgotten', async () => {
    const t = tools(CATALOG, TRUST);
    const first = (await t.search({ query: 'chair 0' })).researchId;
    const second = (await t.search({ query: 'chair 1' })).researchId;
    for (let i = 2; i <= RESEARCH_CACHE_MAX; i++) await t.search({ query: `chair ${String(i)}` });
    // 17 researches: the first is gone, the second (the oldest of the newest 16) still resolves.
    await expect(t.recommend({ research_id: first, reason: 'x' })).rejects.toThrow(/unknown or expired/);
    await expect(t.recommend({ research_id: second, reason: 'x' })).resolves.toMatchObject({ recommended: null });
  });

  it('one cache serves every registry of a pipeline: a research_id minted before a pause resolves after the resume', async () => {
    const cache = createResearchCache(FIXED);
    const before = createProductResearchTools({ appViewClient: makeClient(CATALOG, TRUST), core: NO_CONTACTS, cache, now: FIXED });
    const after = createProductResearchTools({ appViewClient: makeClient(CATALOG, TRUST), core: NO_CONTACTS, cache, now: FIXED });
    const { researchId } = (await before.searchProducts.execute({ query: 'chair' })) as SearchProductsResult;
    const out = (await after.recommendOffer.execute({
      research_id: researchId,
      supplier_did: 'did:plc:steady',
      reason: 'x',
    })) as RecommendOfferResult;
    expect(out.recommended).toBe('did:plc:steady');
  });

  it('the reason is one bounded line — control and bidi characters go, the length is cut at exactly 240, set-aside reasons included', async () => {
    const t = tools(CATALOG, TRUST);
    const { researchId } = await t.search({ query: 'chair' });
    const out = await t.recommend({
      research_id: researchId,
      supplier_did: 'did:plc:steady',
      reason: `line one\nline\u0007two\u202e reversed\u2069 ${'x'.repeat(400)}`,
      set_aside: [{ supplier_did: 'did:plc:cheap', reason: `\u202eunknown\u202c seller\u0085${'y'.repeat(300)}` }],
    });
    const chosenFor = out.card.fields.find((f) => f.label === 'Chosen for')?.value ?? '';
    expect(chosenFor.startsWith('line one line two reversed x')).toBe(true);
    expect(chosenFor.length).toBe(240);
    const forbidden = (text: string) =>
      [...text].some((ch) => {
        const c = ch.charCodeAt(0);
        return c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x200e || c === 0x200f || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
      });
    expect(forbidden(chosenFor)).toBe(false);
    const setAside = out.card.fields.find((f) => f.label === 'Set aside')?.value ?? '';
    expect(setAside.startsWith('did:plc:cheap: unknown seller y')).toBe(true);
    expect(setAside.length).toBeLessThanOrEqual('did:plc:cheap: '.length + 240);
    expect(forbidden(setAside)).toBe(false);
  });
});
