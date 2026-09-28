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
}) {
  const calls = { catalog: [] as { q?: string; region?: string }[], services: [] as unknown[] };
  return {
    calls,
    client: {
      searchCatalog: jest.fn(async (p: { q?: string; region?: string }) => {
        calls.catalog.push({ q: p.q, region: p.region });
        return opts.catalog[p.q ?? ''] ?? [];
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
        did in (opts.trust ?? {}) ? { overallTrustScore: opts.trust?.[did] ?? null } : null,
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
    expect(await findSuppliers(client, { text: 'near me' })).toEqual({ suppliers: [], words: [] });
    expect(client.searchCatalog).not.toHaveBeenCalled();
    expect(client.searchServices).not.toHaveBeenCalled();
  });
});
