/**
 * Supplier names for screens that know suppliers by DID (the Tender
 * screen's offers). Reported: the offers read "did:plc:mfsy…7goi". Pinned:
 * the owner's contact name wins, then the listing name; the listing
 * placeholder "Commerce" is not a name; a failed lookup is retried on the
 * next refresh, a known "no name" is not.
 */

import {
  resetSupplierNameCache,
  resolveSupplierNames,
  type SupplierNameSources,
} from '../../src/services/supplier_names';

const A = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
const C = 'did:plc:cccccccccccccccccccccccc';

beforeEach(() => resetSupplierNameCache());

function sources(over: Partial<SupplierNameSources> = {}): SupplierNameSources & {
  listingName: jest.Mock;
} {
  return {
    contacts: async () => [{ did: A, displayName: 'Alonso (my carpenter)' }],
    listingName: jest.fn(async (did: string) =>
      did === A ? 'ChairMaker Workshop' : did === B ? 'Albert Timber' : 'Commerce',
    ),
    ...over,
  } as never;
}

it('the owner’s contact name wins; else the listing name; the placeholder is no name', async () => {
  const names = await resolveSupplierNames(
    [{ supplierDid: A }, { supplierDid: B, serviceRkey: 'shop' }, { supplierDid: C }],
    sources(),
  );
  expect(names.get(A)).toBe('Alonso (my carpenter)');
  expect(names.get(B)).toBe('Albert Timber');
  expect(names.get(C)).toBeNull();
});

it('asks for the listing the supplier answered under', async () => {
  const s = sources();
  await resolveSupplierNames([{ supplierDid: B, serviceRkey: 'shop' }], s);
  expect(s.listingName).toHaveBeenCalledWith(B, 'shop');
});

it('a resolved name (or a known "no name") is not looked up again; a failed lookup is', async () => {
  const s = sources({
    listingName: jest
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue('Albert Timber'),
  });
  expect((await resolveSupplierNames([{ supplierDid: B }], s)).get(B)).toBeNull();
  expect((await resolveSupplierNames([{ supplierDid: B }], s)).get(B)).toBe('Albert Timber');
  await resolveSupplierNames([{ supplierDid: B }], s);
  expect(s.listingName).toHaveBeenCalledTimes(2);
});

it('with the contacts unavailable, listing names still come through', async () => {
  const names = await resolveSupplierNames(
    [{ supplierDid: A }],
    sources({
      contacts: async () => {
        throw new Error('locked');
      },
    }),
  );
  expect(names.get(A)).toBe('ChairMaker Workshop');
});
