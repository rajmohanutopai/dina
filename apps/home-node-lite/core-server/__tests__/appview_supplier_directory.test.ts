/**
 * HOSTED_DINA §6.1 — the AppView-backed supplier directory: one finding per
 * supplier, its listing's name and its PeerLens trust; a name or trust read
 * that fails empties that field and keeps the finding.
 */

import {
  createAppViewSupplierDirectory,
  type SupplierDirectoryAppView,
} from '../src/commerce/appview_supplier_directory';

const ALBERT = 'did:plc:albertbakery';
const KUMAR = 'did:plc:kumarbakes';

function candidate(did: string, sku: string, price?: string) {
  return {
    supplierDid: did,
    serviceUri: `at://${did}/com.dinakernel.service.profile/self`,
    serviceRkey: 'self',
    product: { scheme: 'manufacturer_sku', value: sku },
    ...(price !== undefined ? { indicativePrice: { currency: 'INR', minorUnits: price } } : {}),
  };
}

describe('the AppView supplier directory', () => {
  it('groups catalogue items by supplier and adds each listing’s name and trust', async () => {
    const asked: unknown[] = [];
    const appView: SupplierDirectoryAppView = {
      searchCatalog: async (params) => {
        asked.push(params);
        return [
          candidate(ALBERT, 'CROI-BUT', '4500'),
          candidate(KUMAR, 'K-CROI'),
          candidate(ALBERT, 'CROI-ALM', '6000'),
        ];
      },
      resolveServiceByUri: async (uri) =>
        uri.includes(ALBERT) ? { name: "Albert's Bakery" } : null,
      getProfile: async (did) =>
        did === ALBERT ? { overallTrustScore: 0.82, reviewCount: 3 } : null,
    };
    const found = await createAppViewSupplierDirectory(appView).findSuppliers({
      text: 'butter croissants',
      region: 'postal_area:560001',
    });
    expect(asked).toEqual([{ q: 'butter croissants', region: 'postal_area:560001', limit: 50 }]);
    expect(found).toEqual([
      {
        supplierDid: ALBERT,
        serviceRkey: 'self',
        name: "Albert's Bakery",
        items: [
          {
            product: 'manufacturer_sku:CROI-BUT',
            indicativePrice: { currency: 'INR', minorUnits: '4500' },
          },
          {
            product: 'manufacturer_sku:CROI-ALM',
            indicativePrice: { currency: 'INR', minorUnits: '6000' },
          },
        ],
        trust: { score: 0.82, reviews: 3 },
      },
      {
        supplierDid: KUMAR,
        serviceRkey: 'self',
        name: null,
        items: [{ product: 'manufacturer_sku:K-CROI' }],
        trust: { score: null, reviews: 0 },
      },
    ]);
  });

  it('keeps a finding whose name or trust read fails, and stops at the limit', async () => {
    const appView: SupplierDirectoryAppView = {
      searchCatalog: async () => [candidate(ALBERT, 'A'), candidate(KUMAR, 'B')],
      resolveServiceByUri: async () => {
        throw new Error('appview 500');
      },
      getProfile: async () => {
        throw new Error('appview 500');
      },
    };
    const found = await createAppViewSupplierDirectory(appView).findSuppliers({
      text: 'bread',
      limit: 1,
    });
    expect(found).toEqual([
      {
        supplierDid: ALBERT,
        serviceRkey: 'self',
        name: null,
        items: [{ product: 'manufacturer_sku:A' }],
        trust: { score: null, reviews: 0 },
      },
    ]);
  });

  it('reads a listing’s own name by its AT-URI', async () => {
    const asked: string[] = [];
    const appView: SupplierDirectoryAppView = {
      searchCatalog: async () => [],
      resolveServiceByUri: async (uri) => {
        asked.push(uri);
        return { name: 'Fogline Bakehouse' };
      },
      getProfile: async () => null,
    };
    const directory = createAppViewSupplierDirectory(appView);
    expect(await directory.listingName?.(KUMAR, 'self')).toBe('Fogline Bakehouse');
    expect(asked).toEqual([`at://${KUMAR}/com.dinakernel.service.profile/self`]);
  });
});
