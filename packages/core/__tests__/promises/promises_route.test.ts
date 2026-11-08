/**
 * docs/PROMISES_AND_WAITS.md: `GET /v1/promises` serves the joined list to
 * the owner's side and Brain, never to an agent or a plugin.
 */

import { isAuthorized } from '../../src/auth/authz';
import { InProcessTransport } from '../../src/client/in-process-transport';
import { CoreRouter } from '../../src/server/router';
import { PROMISES_PATH, registerPromiseRoutes } from '../../src/server/routes/promises';

import type { PromisesAndWaits } from '../../src/promises/view';

const LIST: PromisesAndWaits = {
  items: [
    {
      id: 'talk:t1',
      direction: 'owed_to_me',
      source: 'talk',
      who: 'Mike',
      whoDid: 'did:plc:mike',
      what: 'Send the deck',
      dueAt: 5,
      late: false,
      ref: 't1',
    },
  ],
  missing: ['tender'],
};

describe('GET /v1/promises', () => {
  it('is open to Brain and the owner side, closed to agents and plugins', () => {
    expect(isAuthorized('brain' as never, 'GET', PROMISES_PATH)).toBe(true);
    expect(isAuthorized('device', 'GET', PROMISES_PATH)).toBe(true);
    expect(isAuthorized('agent', 'GET', PROMISES_PATH)).toBe(false);
    expect(isAuthorized('plugin', 'GET', PROMISES_PATH)).toBe(false);
    expect(isAuthorized('device', 'POST', PROMISES_PATH)).toBe(false);
  });

  it('returns the list through the client, passing the clock through', async () => {
    const router = new CoreRouter();
    const seen: number[] = [];
    registerPromiseRoutes(router, (now) => {
      seen.push(now);
      return LIST;
    });
    const core = new InProcessTransport(router);
    await expect(core.promisesList(1234)).resolves.toEqual(LIST);
    expect(seen).toEqual([1234]);
  });

  it('uses its own clock for a bad `now`', async () => {
    const router = new CoreRouter();
    const seen: number[] = [];
    registerPromiseRoutes(router, (now) => {
      seen.push(now);
      return LIST;
    });
    const before = Date.now();
    await router.handle({
      method: 'GET',
      path: PROMISES_PATH,
      query: { now: 'soon' },
      headers: {},
      body: undefined,
      rawBody: new Uint8Array(),
      params: {},
      trustedInProcess: true,
    } as never);
    expect(seen[0]).toBeGreaterThanOrEqual(before);
  });
});
