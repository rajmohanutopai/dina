/**
 * CORE-P0-012 — Rate-limit direction classifier tests.
 */

import { isRateLimited } from '../../src/rpc/rate_limit_direction';

describe('isRateLimited', () => {
  it('inbound-request is rate-limited', () => {
    expect(isRateLimited('inbound-request')).toBe(true);
  });

  it('inbound-response is exempt (replies to our own queries)', () => {
    expect(isRateLimited('inbound-response')).toBe(false);
  });
});
