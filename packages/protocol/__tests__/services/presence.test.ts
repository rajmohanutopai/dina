import {
  MAX_PUBLISHED_LISTINGS,
  presenceNonce,
  SERVICE_PRESENCE_COLLECTION,
  validateServicePresenceRecord,
} from '../../src';

const CID = 'bafyreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';
const ok = { $type: SERVICE_PRESENCE_COLLECTION, v: 1, n: '0123456789abcdef', listings: [{ rkey: 'self', cid: CID }], complete: true };

describe('service presence record (REAL_LIFE_FIXES §14)', () => {
  it('accepts a well-formed record', () => {
    expect(validateServicePresenceRecord(ok)).toBeNull();
    expect(validateServicePresenceRecord({ ...ok, listings: [], complete: false })).toBeNull();
  });

  it.each([
    ['wrong version', { ...ok, v: 2 }],
    ['a bad n', { ...ok, n: 'xyz' }],
    ['a missing complete', { ...ok, complete: undefined }],
    ['an incomplete set with entries', { ...ok, complete: false }],
    ['a bad rkey', { ...ok, listings: [{ rkey: '..', cid: CID }] }],
    ['a bad cid', { ...ok, listings: [{ rkey: 'self', cid: 'not-a-cid' }] }],
    ['a repeated rkey', { ...ok, listings: [{ rkey: 'a', cid: CID }, { rkey: 'a', cid: CID }] }],
    ['too many listings', { ...ok, listings: Array.from({ length: MAX_PUBLISHED_LISTINGS + 1 }, (_, i) => ({ rkey: `l${i}`, cid: CID })) }],
    ['a wrong $type', { ...ok, $type: 'com.example.other' }],
  ])('rejects %s', (_label, rec) => {
    expect(validateServicePresenceRecord(rec)).not.toBeNull();
  });

  it('makes a 16-hex nonce', () => {
    expect(presenceNonce(() => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 255]))).toBe('01020304050607ff');
  });
});
