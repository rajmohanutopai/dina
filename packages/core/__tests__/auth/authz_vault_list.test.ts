/** /v1/vault/list authorization. */

import { isAuthorized } from '../../src/auth/authz';

describe('vault list (REAL_LIFE_FIXES_2 §9.2)', () => {
  it('Brain and devices may list a persona; agents and connectors may not', () => {
    expect(isAuthorized('brain', 'GET', '/v1/vault/list')).toBe(true);
    expect(isAuthorized('device', 'GET', '/v1/vault/list')).toBe(true);
    expect(isAuthorized('agent', 'GET', '/v1/vault/list')).toBe(false);
  });
});
