/**
 * slugifyRkey — listing rkey generation for the multi-listing provider model.
 */

import { isValidServiceListingRkey } from '@dina/protocol';

import { slugifyRkey, DEFAULT_LISTING_RKEY } from '../../src/services/listing_rkey';

describe('slugifyRkey', () => {
  it('slugifies a display name into a valid rkey', () => {
    const r = slugifyRkey('Corner Market');
    expect(r).toBe('corner-market');
    expect(isValidServiceListingRkey(r)).toBe(true);
  });

  it('strips out-of-charset characters and collapses separators', () => {
    expect(slugifyRkey("Bob's  Bus #42 ETA!")).toBe('bob-s-bus-42-eta');
    expect(isValidServiceListingRkey(slugifyRkey("Bob's  Bus #42 ETA!"))).toBe(true);
  });

  it('falls back to "listing" when the name has no usable characters', () => {
    expect(slugifyRkey('!!! ###')).toBe('listing');
    expect(slugifyRkey('')).toBe('listing');
  });

  it('never collides with the reserved default rkey (self)', () => {
    expect(slugifyRkey('self')).toBe('self-2');
    expect(slugifyRkey('Self')).toBe('self-2');
  });

  it('disambiguates against taken rkeys with a numeric suffix', () => {
    expect(slugifyRkey('Corner Market', ['corner-market'])).toBe('corner-market-2');
    expect(slugifyRkey('Corner Market', ['corner-market', 'corner-market-2'])).toBe(
      'corner-market-3',
    );
  });

  it('treats DEFAULT_LISTING_RKEY as reserved even if not passed in taken', () => {
    expect(DEFAULT_LISTING_RKEY).toBe('self');
    expect(slugifyRkey('self', ['other'])).toBe('self-2');
  });

  it('always returns a protocol-valid rkey', () => {
    for (const name of ['A', 'café münchen', '日本語', '   ', 'x'.repeat(200)]) {
      expect(isValidServiceListingRkey(slugifyRkey(name))).toBe(true);
    }
  });
});
