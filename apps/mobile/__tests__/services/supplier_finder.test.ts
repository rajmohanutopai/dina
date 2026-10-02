/**
 * ASK_FOR_QUOTES_PLAN §1 — finding suppliers to ask for quotes.
 *
 * Driven against a fake AppView answering the real response shapes: catalog
 * candidates (supplier DID, listing key, item, indicative price) and service
 * listings (name, uri, trust). Pinned: a phrase is searched word by word; the
 * region reaches the catalog; the two sources merge per listing; a supplier
 * the AppView cannot name is kept; blocked suppliers go, preferred ones come
 * first; more words matched ranks higher, then trust.
 */

import {
  findSuppliers,
  REQUEST_QUOTE_CAPABILITY,
  searchWords,
} from '../../src/services/supplier_finder';

import type { CommerceCatalogCandidate, ServiceProfile } from '@dina/brain';

const BAKERY = 'did:plc:bakeryaaaa';
const PATISSERIE = 'did:plc:patisseriebb';
const CATERER = 'did:plc:catererccc';

function item(
  supplierDid: string,
  value: string,
  price?: string,
  rkey = 'shop',
): CommerceCatalogCandidate {
  return {
    supplierDid,
    serviceUri: `at://${supplierDid}/com.dinakernel.service.profile/${rkey}`,
    serviceRkey: rkey,
    product: { scheme: 'custom', value },
    catalogSnapshotRef: 'snap',
    matchedFields: ['text'],
    ...(price !== undefined ? { indicativePrice: { currency: 'INR', minorUnits: price } } : {}),
    fulfilmentRegions: [{ scheme: 'postal_area', value: '560001' }],
    generatedAt: '2026-09-28T00:00:00Z',
    retrievalScoreBp: 5000,
  };
}

function fakeAppView(opts: {
  catalog: Record<string, CommerceCatalogCandidate[]>;
  listings?: (ServiceProfile & { trustScore?: number | null })[];
  names?: Record<string, string>;
  trust?: Record<string, number | null>;
  /** Reviews about each DID, as `attestationSummary.total`. */
  reviews?: Record<string, number>;
  /** Items the AppView's trust floor dropped, per searched word. */
  suppressed?: Record<string, number>;
}) {
  const calls = { catalog: [] as { q?: string; region?: string }[], services: [] as unknown[] };
  return {
    calls,
    client: {
      searchCatalogWithFloor: jest.fn(async (p: { q?: string; region?: string }) => {
        calls.catalog.push({ q: p.q, region: p.region });
        return {
          candidates: opts.catalog[p.q ?? ''] ?? [],
          suppressedBelowTrustFloor: opts.suppressed?.[p.q ?? ''] ?? 0,
        };
      }),
      searchServices: jest.fn(async (p: unknown) => {
        calls.services.push(p);
        return opts.listings ?? [];
      }),
      resolveServiceByUri: jest.fn(async (uri: string) => {
        const did = uri.split('/')[2] ?? '';
        const name = opts.names?.[did];
        return name === undefined
          ? null
          : ({ did, name, capabilities: [], isDiscoverable: true } as ServiceProfile);
      }),
      getProfile: jest.fn(async (did: string) =>
        did in (opts.trust ?? {})
          ? {
              overallTrustScore: opts.trust?.[did] ?? null,
              ...(opts.reviews?.[did] !== undefined ? { reviewCount: opts.reviews[did] } : {}),
            }
          : null,
      ),
    },
  };
}

describe('searchWords', () => {
  it('keeps the words that say what is wanted, singular, at most three', () => {
    expect(searchWords('bakeries near me that do cakes')).toEqual(['bakery', 'cake']);
    expect(searchWords('Floral celebration cake, 20 servings')).toEqual([
      'floral',
      'celebration',
      'cake',
    ]);
    expect(searchWords('a to me')).toEqual([]);
    expect(searchWords('glass')).toEqual(['glass']);
  });
});

describe('findSuppliers', () => {
  it('searches each word in the buyer’s region and merges one row per listing', async () => {
    const { client, calls } = fakeAppView({
      catalog: {
        floral: [item(BAKERY, 'floral-cake', '150000')],
        cake: [
          item(BAKERY, 'floral-cake', '150000'),
          item(BAKERY, 'plain-cake', '90000'),
          item(PATISSERIE, 'tart', '40000'),
        ],
      },
      names: { [BAKERY]: 'Sweet Crumb Bakery', [PATISSERIE]: 'Le Petit Four' },
      trust: { [BAKERY]: 0.6, [PATISSERIE]: 0.9 },
    });
    const { suppliers, words } = await findSuppliers(client, {
      text: 'floral cakes',
      region: 'postal_area:560001',
    });
    expect(words).toEqual(['floral', 'cake']);
    expect(calls.catalog).toEqual([
      { q: 'floral', region: 'postal_area:560001' },
      { q: 'cake', region: 'postal_area:560001' },
    ]);
    // The bakery matched both words, so it ranks above the higher-trust
    // patisserie that matched one.
    expect(suppliers.map((s) => [s.name, s.wordsMatched, s.itemsMatched])).toEqual([
      ['Sweet Crumb Bakery', 2, 2],
      ['Le Petit Four', 1, 1],
    ]);
    expect(suppliers[0]).toMatchObject({
      supplierDid: BAKERY,
      serviceRkey: 'shop',
      trustScore: 0.6,
      indicativeFrom: { currency: 'INR', minorUnits: '90000' },
    });
  });

  it('adds public listings that match by their own words, with the search’s trust', async () => {
    const { client, calls } = fakeAppView({
      catalog: {},
      listings: [
        {
          did: CATERER,
          name: 'Cake & Co Caterers',
          description: 'custom cakes to order',
          capabilities: [REQUEST_QUOTE_CAPABILITY],
          isDiscoverable: true,
          uri: `at://${CATERER}/com.dinakernel.service.profile/orders`,
          trustScore: 0.7,
        },
      ],
    });
    const { suppliers } = await findSuppliers(client, { text: 'cakes' });
    expect(calls.services).toEqual([
      { capability: REQUEST_QUOTE_CAPABILITY, q: 'cake', limit: 20 },
    ]);
    expect(suppliers).toEqual([
      {
        supplierDid: CATERER,
        serviceRkey: 'orders',
        name: 'Cake & Co Caterers',
        trustScore: 0.7,
        // A good score from the search needs no review count: nothing to set aside.
        reviewCount: null,
        setAside: null,
        wordsMatched: 1,
        itemsMatched: 0,
        preferred: false,
      },
    ]);
    expect(client.getProfile).not.toHaveBeenCalled();
  });

  it('a supplier the AppView cannot name or score is kept, not dropped', async () => {
    const { client } = fakeAppView({ catalog: { cake: [item(BAKERY, 'cake')] } });
    client.getProfile.mockRejectedValue(new Error('AppView down'));
    const { suppliers } = await findSuppliers(client, { text: 'cake' });
    expect(suppliers).toMatchObject([{ supplierDid: BAKERY, name: null, trustScore: null }]);
  });

  it('blocked suppliers are left out; preferred ones come first', async () => {
    const { client } = fakeAppView({
      catalog: { cake: [item(BAKERY, 'a'), item(PATISSERIE, 'b'), item(CATERER, 'c')] },
      trust: { [BAKERY]: 0.9, [PATISSERIE]: 0.1, [CATERER]: 0.5 },
    });
    const { suppliers } = await findSuppliers(client, {
      text: 'cake',
      blockedSuppliers: [BAKERY],
      preferredSuppliers: [PATISSERIE],
    });
    expect(suppliers.map((s) => [s.supplierDid, s.preferred])).toEqual([
      [PATISSERIE, true],
      [CATERER, false],
    ]);
  });

  it('nothing worth searching sends no query', async () => {
    const { client } = fakeAppView({ catalog: {} });
    expect(await findSuppliers(client, { text: 'near me' })).toEqual({
      suppliers: [],
      words: [],
      hiddenForPoorReviews: false,
    });
    expect(client.searchCatalogWithFloor).not.toHaveBeenCalled();
    expect(client.searchServices).not.toHaveBeenCalled();
  });
});

describe('suppliers the AppView hid for poor reviews', () => {
  it('says that someone was hidden, without saying whom', async () => {
    const { client } = fakeAppView({ catalog: { cake: [] }, suppressed: { cake: 2 } });
    const found = await findSuppliers(client, { text: 'cake' });
    expect(found.hiddenForPoorReviews).toBe(true);
    expect(found.suppliers).toEqual([]);
  });

  it('says nothing when nothing was hidden', async () => {
    const { client } = fakeAppView({ catalog: { cake: [] } });
    expect((await findSuppliers(client, { text: 'cake' })).hiddenForPoorReviews).toBe(false);
  });
});

describe('PeerLens sets a supplier aside: shown, last, never asked by default', () => {
  const cakes = (did: string): CommerceCatalogCandidate[] => [item(did, 'cake')];
  const catalog = { cake: [...cakes(BAKERY), ...cakes(PATISSERIE), ...cakes(CATERER)] };
  const own = (sentiment: 'positive' | 'neutral' | 'negative', text = 'Stale bread, late') =>
    ({ sentiment, text, createdAt: '2026-09-29T10:00:00Z' }) as const;

  it("the owner's own poor review sets a supplier aside, even as its only review", async () => {
    const { client } = fakeAppView({
      catalog,
      trust: { [BAKERY]: 0.9, [PATISSERIE]: null, [CATERER]: 0.8 },
      reviews: { [BAKERY]: 12, [PATISSERIE]: 1, [CATERER]: 5 },
    });
    const { suppliers } = await findSuppliers(client, {
      text: 'cake',
      ownReviews: new Map([[PATISSERIE, own('negative')]]),
    });
    expect(suppliers.map((s) => s.supplierDid)).toEqual([BAKERY, CATERER, PATISSERIE]);
    expect(suppliers[2]?.setAside).toEqual({
      reason: 'own_poor_review',
      words: 'You rated them poorly on PeerLens',
      note: 'Stale bread, late',
    });
    expect(suppliers[0]?.setAside).toBeNull();
  });

  it('a low score sets a supplier aside only over three or more reviews', async () => {
    const { client } = fakeAppView({
      catalog,
      trust: { [BAKERY]: 0.2, [PATISSERIE]: 0.1, [CATERER]: 0.8 },
      reviews: { [BAKERY]: 4, [PATISSERIE]: 2, [CATERER]: 5 },
    });
    const { suppliers } = await findSuppliers(client, { text: 'cake' });
    const byDid = new Map(suppliers.map((s) => [s.supplierDid, s]));
    expect(byDid.get(BAKERY)?.setAside).toEqual({
      reason: 'low_peerlens_trust',
      words: 'Low PeerLens trust · 4 reviews',
      note: '',
    });
    // Two strangers' reviews are not a verdict.
    expect(byDid.get(PATISSERIE)?.setAside).toBeNull();
    expect(byDid.get(PATISSERIE)?.reviewCount).toBe(2);
    expect(suppliers[suppliers.length - 1]?.supplierDid).toBe(BAKERY);
  });

  it("the owner's own good review answers a low network score", async () => {
    const { client } = fakeAppView({
      catalog,
      trust: { [BAKERY]: 0.1, [PATISSERIE]: 0.9, [CATERER]: 0.8 },
      reviews: { [BAKERY]: 9, [PATISSERIE]: 3, [CATERER]: 3 },
    });
    const { suppliers } = await findSuppliers(client, {
      text: 'cake',
      ownReviews: new Map([[BAKERY, own('positive', 'Always on time')]]),
    });
    expect(suppliers.every((s) => s.setAside === null)).toBe(true);
  });

  it('a supplier with no reviews is not low trust', async () => {
    const { client } = fakeAppView({ catalog, trust: {} });
    const { suppliers } = await findSuppliers(client, { text: 'cake' });
    expect(suppliers.map((s) => [s.trustScore, s.reviewCount, s.setAside])).toEqual([
      [null, null, null],
      [null, null, null],
      [null, null, null],
    ]);
  });
});
